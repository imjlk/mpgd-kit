import assert from 'node:assert/strict';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import {
  createAppStoreGameServicesEvidenceVerifier,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';
import {
  createAppStoreSignedTransactionEvidenceFixture,
  createAppStoreTransactionConformanceFixture,
} from './app-store-verifier-conformance.js';
import {
  createPurchaseTransferEvidenceVerificationId,
  EntitlementTransferConflictError,
  findPurchaseGrantByEvidenceVerificationId,
  listActiveEntitlementTransactions,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import {
  createGooglePlayProductPurchaseBoundary,
  googlePlayProductPurchaseEvidenceSchema,
  type GooglePlayProductPurchaseClient,
} from './google-play-purchase.js';
import { createGooglePlayProductPurchaseConformanceFixture } from './google-play-purchase-conformance.js';
import type {
  EvidenceVerificationDecision,
  FinalizePurchaseGrantInput,
  GameServicesEvidenceVerifier,
} from './evidence-verification.js';
import { resolvePurchaseRestoreTransferPolicy } from './purchase-transfer.js';
import {
  createGameServicesBackend,
  createInMemoryGameServicesStore,
  type GameServicesStore,
} from './server.js';
import type { ProductGrantTransaction, VerifyPurchaseRequest } from './types.js';

const catalog = {
  version: 'test',
  products: [
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { android: 'remove_ads_android', ios: 'com.example.game.removeads' },
    },
    {
      id: 'HINT_PACK_5',
      type: 'consumable',
      grant: { type: 'resource', resource: 'hint', amount: 5 },
      platformProductIds: { android: 'hint_pack_5_android' },
    },
  ],
} as const satisfies ProductCatalog;
const placements = { version: 'test', placements: [] } as const satisfies AdPlacements;

const purchaseVerificationId = 'google-play:product:token-digest-1';

/**
 * A verifier standing in for the store: the purchase was bought by
 * `player-a`, so another player's restore is `restorable` (the binding
 * mismatch) and the buyer's own request is `verified`.
 */
function createStoreVerifier(options: {
  readonly buyer?: string;
  readonly verificationId?: string;
} = {}): GameServicesEvidenceVerifier & { readonly calls: VerifyPurchaseRequest[] } {
  const calls: VerifyPurchaseRequest[] = [];
  const buyer = options.buyer ?? 'player-a';
  const verificationId = options.verificationId ?? purchaseVerificationId;
  return {
    calls,
    async verifyPurchase({ request }): Promise<EvidenceVerificationDecision> {
      calls.push(request);
      const verified = {
        verificationId,
        verifiedAt: '2030-01-01T00:00:00.000Z',
        payload: { googlePlayPurchaseTokenDigest: 'token-digest-1' },
        platformEvidenceId: 'GPA.1234',
      };
      return request.playerId === buyer
        ? { status: 'verified', ...verified }
        : { status: 'restorable', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', ...verified };
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'UNUSED' };
    },
  };
}

function createClock(start = '2030-01-01T00:00:00.000Z') {
  let nowMs = Date.parse(start);
  return {
    now: () => new Date(nowMs).toISOString(),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function restoreRequest(
  playerId: string,
  overrides: Partial<VerifyPurchaseRequest> = {},
): VerifyPurchaseRequest {
  return {
    target: 'android',
    playerId,
    productId: 'REMOVE_ADS',
    platformTransactionId: 'GPA.1234',
    idempotencyKey: `play-token-sha256:${playerId}`,
    purchasedAt: '2030-01-01T00:00:00.000Z',
    intent: 'restore',
    ...overrides,
  };
}

const day = 24 * 60 * 60 * 1000;

// Policy validation.
assert.deepEqual(resolvePurchaseRestoreTransferPolicy(undefined), {
  mode: 'refuse',
  maxTransfersPerWindow: 3,
  windowMs: 30 * day,
});
assert.throws(() =>
  resolvePurchaseRestoreTransferPolicy({ mode: 'move', maxTransfersPerWindow: 0 }),
);
assert.throws(() => resolvePurchaseRestoreTransferPolicy({ mode: 'move', windowMs: -1 }));
assert.throws(() => resolvePurchaseRestoreTransferPolicy({ mode: 'other' as 'move' }));

// The default policy keeps refusing a restore across players.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
  });
  assert.equal((await backend.purchases.verifyPurchase(restoreRequest('player-a'))).verified, true);
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-b')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  });
}

// Reinstall: the old guest's non-consumable moves to the new guest.
{
  const store = createInMemoryGameServicesStore();
  const clock = createClock();
  const finalized: FinalizePurchaseGrantInput[] = [];
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    now: clock.now,
    evidenceVerifier: createStoreVerifier(),
    purchaseGrantFinalizer: {
      async finalizePurchaseGrant(input) {
        finalized.push(input);
        return {
          status: 'completed',
          action: 'acknowledge',
          alreadyCompleted: input.alreadyProcessed,
        };
      },
    },
    restoreTransfers: { mode: 'move' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  assert.equal(bought.transferred, undefined);
  const firstLedgerEntryId = bought.ledgerEntryId ?? '';

  clock.advance(1000);
  const restored = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.alreadyProcessed, false);
  assert.equal(restored.transferred, true);
  assert.notEqual(restored.ledgerEntryId, firstLedgerEntryId);
  // The finalizer acknowledges the purchase, not the move.
  assert.equal(finalized.at(-1)?.evidenceVerificationId, purchaseVerificationId);
  assert.equal(finalized.at(-1)?.request.playerId, 'player-b');

  // One holder at a time: the old guest's grant reads as reversed.
  const oldStatus = await readPurchaseLedgerStatuses(store, {
    playerId: 'player-a',
    ledgerEntryIds: [firstLedgerEntryId],
  });
  assert.equal(oldStatus.statuses[0]?.status, 'reversed');
  const newStatus = await readPurchaseLedgerStatuses(store, {
    playerId: 'player-b',
    ledgerEntryIds: [restored.ledgerEntryId ?? ''],
  });
  assert.equal(newStatus.statuses[0]?.status, 'active');
  const active = await listActiveEntitlementTransactions(store);
  assert.deepEqual(
    active.map((grant) => grant.playerId),
    ['player-b'],
  );

  // The move is a ledger entry pair: no personal data beyond the player ids the ledger keys on.
  const [transfer] = await store.findEntitlementRevocations({
    ledgerEntryIds: [firstLedgerEntryId],
  });
  assert.equal(transfer?.reason, 'transfer');
  assert.equal(transfer?.playerId, 'player-a');
  assert.equal(
    transfer?.payload.transferEvidenceVerificationId,
    createPurchaseTransferEvidenceVerificationId(purchaseVerificationId, 1),
  );
  const moved = await store.getEntitlementTransaction(restored.ledgerEntryId ?? '');
  assert.equal(moved?.payload.transferredFromLedgerEntryId, firstLedgerEntryId);
  assert.equal(moved?.payload.transferOfEvidenceVerificationId, purchaseVerificationId);
  assert.equal(moved?.payload.platformTransactionId, undefined);

  // The purchase's verification id now finds the current holder.
  assert.equal(
    (await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId))?.playerId,
    'player-b',
  );
  assert.equal(
    (await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId, {
      followTransfers: false,
    }))?.playerId,
    'player-a',
  );

  // Idempotent retries: the same key answers the same grant; another key of the holder too.
  const replay = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(replay.verified, true);
  assert.equal(replay.alreadyProcessed, true);
  assert.equal(replay.transferred, true);
  assert.equal(replay.ledgerEntryId, restored.ledgerEntryId);
  assert.equal(finalized.at(-1)?.evidenceVerificationId, purchaseVerificationId);
  const otherKey = await backend.purchases.verifyPurchase(
    restoreRequest('player-b', { idempotencyKey: 'another-key' }),
  );
  assert.equal(otherKey.verified, true);
  assert.equal(otherKey.alreadyProcessed, true);
  assert.equal(otherKey.ledgerEntryId, restored.ledgerEntryId);

  // A purchase intent (a checkout this client started) never moves a grant.
  const purchaseIntent = await backend.purchases.verifyPurchase(
    restoreRequest('player-c', { intent: 'purchase' }),
  );
  assert.equal(purchaseIntent.verified, false);
  assert.equal(purchaseIntent.reason, 'GOOGLE_PLAY_ACCOUNT_MISMATCH');
  const { intent: _intent, ...withoutIntent } = restoreRequest('player-c');
  void _intent;
  const noIntent = await backend.purchases.verifyPurchase(withoutIntent);
  assert.equal(noIntent.reason, 'GOOGLE_PLAY_ACCOUNT_MISMATCH');

  // The buyer, whose binding matches, restores it back from the other guest.
  clock.advance(1000);
  const back = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { idempotencyKey: 'player-a-restore' }),
  );
  assert.equal(back.verified, true);
  assert.equal(back.transferred, true);
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.playerId),
    ['player-a'],
  );

  // A refund that names the first grant reverses the grant that holds the purchase now.
  const refund = await revokeEntitlementGrant(store, {
    playerId: 'player-a',
    revokesLedgerEntryId: firstLedgerEntryId,
    idempotencyKey: 'google-play:voided:token',
    reason: 'refund',
    revokedAt: clock.now(),
    payload: { target: 'android' },
  });
  assert.equal(refund.status, 'revoked');
  assert.deepEqual(await listActiveEntitlementTransactions(store), []);
  // A refunded purchase never moves again.
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-d')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'LEDGER_GRANT_REVERSED',
  });
}

// A player whose grant a later restore moved away gets it back with the same key
// (the reconciler derives one key per store purchase), and an admin entry stays
// on the grant it names.
{
  const store = createInMemoryGameServicesStore();
  const clock = createClock();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    now: clock.now,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move' },
  });
  await backend.purchases.verifyPurchase(restoreRequest('player-a', { intent: 'purchase' }));
  const toB = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  clock.advance(1000);
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-c'))).transferred,
    true,
  );
  clock.advance(1000);
  const backToB = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(backToB.verified, true);
  assert.equal(backToB.transferred, true);
  assert.notEqual(backToB.ledgerEntryId, toB.ledgerEntryId);
  const holder = await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId);
  assert.equal(holder?.playerId, 'player-b');
  assert.equal(holder?.idempotencyKey, 'play-token-sha256:player-b#transfer:3');
  // The same key again answers the grant it holds now.
  const again = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(again.alreadyProcessed, true);
  assert.equal(again.ledgerEntryId, backToB.ledgerEntryId);
  // A replay of the same key as a purchase (no restore intent) still answers the reversed grant.
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b', { intent: 'purchase' }))).reason,
    'LEDGER_GRANT_REVERSED',
  );

  // An operator's admin entry on a moved grant does not follow the move.
  const admin = await revokeEntitlementGrant(store, {
    playerId: 'player-b',
    revokesLedgerEntryId: toB.ledgerEntryId ?? '',
    idempotencyKey: 'admin:1',
    reason: 'admin',
    revokedAt: clock.now(),
    payload: {},
  });
  assert.equal(admin.status, 'revoked');
  assert.equal(admin.status === 'revoked' ? admin.alreadyProcessed : false, true);
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.ledgerEntryId),
    [backToB.ledgerEntryId],
  );
}

// Consumables never move, even under the move policy.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move' },
  });
  assert.deepEqual(
    await backend.purchases.verifyPurchase(restoreRequest('player-b', { productId: 'HINT_PACK_5' })),
    {
      verified: false,
      alreadyProcessed: false,
      disposition: 'rejected',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    },
  );
  assert.deepEqual(await store.listEntitlementTransactions(), []);
}

// A purchase no grant holds yet is granted to the restoring player.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move' },
  });
  const restored = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.transferred, true);
  const [grant] = await store.listEntitlementTransactions();
  assert.equal(grant?.playerId, 'player-b');
  assert.equal(grant?.evidenceVerificationId, purchaseVerificationId);
  assert.equal(grant?.payload.restoredAcrossAccounts, true);
  const retried = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(retried.alreadyProcessed, true);
  assert.equal(retried.transferred, true, 'a retry still says the purchase was restored here');
  // The buyer's later verify answers that the purchase is held by another player.
  const buyer = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(buyer.reason, 'EVIDENCE_ALREADY_PROCESSED');
}

// Rate limit: at most N moves per purchase in the window; later restores wait for it.
{
  const store = createInMemoryGameServicesStore();
  const clock = createClock();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    now: clock.now,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move', maxTransfersPerWindow: 2, windowMs: 30 * day },
  });
  await backend.purchases.verifyPurchase(restoreRequest('player-a', { intent: 'purchase' }));
  clock.advance(day);
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b'))).transferred,
    true,
  );
  clock.advance(day);
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-c'))).transferred,
    true,
  );
  clock.advance(day);
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-d')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'pending',
    reason: 'PURCHASE_TRANSFER_RATE_LIMITED',
  });
  // The first move leaves the window after 30 days.
  clock.advance(28 * day);
  const later = await backend.purchases.verifyPurchase(restoreRequest('player-d'));
  assert.equal(later.verified, true);
  assert.equal(later.transferred, true);
  const holder = await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId);
  assert.equal(holder?.playerId, 'player-d');
  assert.equal(holder?.payload.transferSequence, 3);
}

// Concurrent restores from two guests in separate processes: one wins, one waits.
{
  const shared = createInMemoryGameServicesStore();
  // Both isolates have read the ledger before either writes its move.
  let arrived = 0;
  let releaseWriters = (): void => {};
  const writersReady = new Promise<void>((resolve) => {
    releaseWriters = resolve;
  });
  // Two wrappers model two Worker isolates: the in-process locks are per
  // store object, so only the ledger write decides the race.
  const isolate = (): GameServicesStore => {
    const wrapper: GameServicesStore = {
      recordEntitlementGrant: (input) => shared.recordEntitlementGrant(input),
      findEntitlementTransactionByIdempotency: (input) =>
        shared.findEntitlementTransactionByIdempotency(input),
      findEntitlementTransactionByEvidenceVerificationId: (input) =>
        shared.findEntitlementTransactionByEvidenceVerificationId(input),
      findEntitlementTransactionByPlatformEvidence: (input) =>
        shared.findEntitlementTransactionByPlatformEvidence(input),
      getEntitlementTransaction: (id) => shared.getEntitlementTransaction(id),
      getEntitlementTransactions: (ids) => shared.getEntitlementTransactions(ids),
      listEntitlementTransactions: () => shared.listEntitlementTransactions(),
      recordEntitlementRevocation: (input) => shared.recordEntitlementRevocation(input),
      findEntitlementRevocations: (input) => shared.findEntitlementRevocations(input),
      recordEntitlementTransfer: async (input) => {
        arrived += 1;
        if (arrived === 2) {
          releaseWriters();
        }
        await writersReady;
        return shared.recordEntitlementTransfer(input);
      },
      recordLeaderboardScore: (input, options) => shared.recordLeaderboardScore(input, options),
      getLeaderboardTransaction: (id) => shared.getLeaderboardTransaction(id),
      listLeaderboardTransactions: () => shared.listLeaderboardTransactions(),
    };
    return wrapper;
  };
  const backendFor = (store: GameServicesStore) => createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move' },
  });
  await backendFor(shared).purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  const [left, right] = await Promise.all([
    backendFor(isolate()).purchases.verifyPurchase(restoreRequest('player-b')),
    backendFor(isolate()).purchases.verifyPurchase(restoreRequest('player-c')),
  ]);
  const answers = [left, right];
  assert.equal(answers.filter((answer) => answer.verified).length, 1);
  assert.deepEqual(
    answers.find((answer) => !answer.verified),
    {
      verified: false,
      alreadyProcessed: false,
      disposition: 'pending',
      reason: 'PURCHASE_TRANSFER_CONFLICT',
    },
  );
  assert.equal((await listActiveEntitlementTransactions(shared)).length, 1);
}

// The store's transfer write: atomic, replay-safe, and a grant moves once.
{
  const store = createInMemoryGameServicesStore();
  await store.recordEntitlementGrant({
    playerId: 'player-a',
    grantId: 'REMOVE_ADS',
    source: 'purchase',
    idempotencyKey: 'buy',
    grantedAt: '2030-01-01T00:00:00.000Z',
    payload: { target: 'android', platformTransactionId: 'GPA.1' },
    evidenceVerificationId: purchaseVerificationId,
  });
  const [first] = await store.listEntitlementTransactions() as ProductGrantTransaction[];
  const transferTo = (playerId: string, sequence = 1) => {
    const evidence = createPurchaseTransferEvidenceVerificationId(purchaseVerificationId, sequence);
    return {
      revocation: {
        playerId: 'player-a',
        revokesLedgerEntryId: first?.ledgerEntryId ?? '',
        idempotencyKey: `transfer:${evidence}`,
        reason: 'transfer' as const,
        revokedAt: '2030-01-02T00:00:00.000Z',
        payload: { transferEvidenceVerificationId: evidence },
      },
      grant: {
        playerId,
        grantId: 'REMOVE_ADS',
        source: 'purchase' as const,
        idempotencyKey: `restore:${playerId}`,
        grantedAt: '2030-01-02T00:00:00.000Z',
        payload: { target: 'android', transferredFromLedgerEntryId: first?.ledgerEntryId ?? '' },
        evidenceVerificationId: evidence,
      },
    };
  };
  const written = await store.recordEntitlementTransfer(transferTo('player-b'));
  assert.equal(written.alreadyProcessed, false);
  assert.deepEqual(await store.recordEntitlementTransfer(transferTo('player-b')), {
    ...written,
    alreadyProcessed: true,
  });
  await assert.rejects(
    store.recordEntitlementTransfer(transferTo('player-c')),
    EntitlementTransferConflictError,
  );
  await assert.rejects(
    store.recordEntitlementTransfer(transferTo('player-c', 2)),
    EntitlementTransferConflictError,
  );
  assert.equal((await store.listEntitlementTransactions()).length, 2);
  // The transfer reason is the transfer write's alone.
  await assert.rejects(
    store.recordEntitlementRevocation({
      ...transferTo('player-c').revocation,
      idempotencyKey: 'other',
    }),
  );
  // A refund of a moved grant answers the transfer entry instead of a second reversal.
  const refund = await store.recordEntitlementRevocation({
    playerId: 'player-a',
    revokesLedgerEntryId: first?.ledgerEntryId ?? '',
    idempotencyKey: 'refund',
    reason: 'refund',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: {},
  });
  assert.deepEqual(refund, {
    ledgerEntryId: written.revocationLedgerEntryId,
    alreadyProcessed: true,
  });
}

// A deleted player's retained record is never revived for that id; a new guest gets a fresh grant linked to it.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier({ buyer: 'nobody' }),
    restoreTransfers: { mode: 'move' },
  });
  await store.recordEntitlementGrant({
    playerId: 'deleted:deletion-1',
    grantId: 'REMOVE_ADS',
    source: 'purchase',
    idempotencyKey: 'retained_1',
    grantedAt: '2030-01-01T00:00:00.000Z',
    grant: { type: 'entitlement', entitlement: 'remove_ads' },
    payload: { target: 'android', productId: 'REMOVE_ADS', platformTransactionId: 'GPA.1234' },
    evidenceVerificationId: purchaseVerificationId,
  });
  const restored = await backend.purchases.verifyPurchase(restoreRequest('player-new'));
  assert.equal(restored.transferred, true);
  const retained = await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId, {
    followTransfers: false,
  });
  assert.equal(retained?.playerId, 'deleted:deletion-1');
  assert.equal(retained?.payload.platformTransactionId, 'GPA.1234');
  const fresh = await store.getEntitlementTransaction(restored.ledgerEntryId ?? '');
  assert.equal(fresh?.playerId, 'player-new');
  assert.equal(fresh?.payload.transferredFromLedgerEntryId, retained?.ledgerEntryId);
}

// A store without the transfer write keeps refusing.
{
  const inner = createInMemoryGameServicesStore();
  const store: GameServicesStore = {
    recordEntitlementGrant: (input) => inner.recordEntitlementGrant(input),
    getEntitlementTransaction: (id) => inner.getEntitlementTransaction(id),
    listEntitlementTransactions: () => inner.listEntitlementTransactions(),
    recordLeaderboardScore: (input, options) => inner.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => inner.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => inner.listLeaderboardTransactions(),
  };
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreTransfers: { mode: 'move' },
  });
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b'))).reason,
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );
}

// Google Play: an uninstall, Clear storage, or a new device makes a new guest;
// Play returns the purchase with the old guest's obfuscatedAccountId.
{
  const purchases = new Map<string, Record<string, unknown>>();
  const acknowledged: string[] = [];
  const client: GooglePlayProductPurchaseClient = {
    async getProductPurchaseV2({ purchaseToken }) {
      const purchase = purchases.get(purchaseToken);
      if (purchase === undefined) {
        throw new Error('not found');
      }
      return structuredClone(purchase);
    },
    async acknowledgeProductPurchase({ purchaseToken }) {
      acknowledged.push(purchaseToken);
      const purchase = purchases.get(purchaseToken);
      if (purchase !== undefined) {
        purchase.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      }
    },
    async consumeProductPurchase() {
      throw new Error('a non-consumable is never consumed');
    },
  };
  const boundary = createGooglePlayProductPurchaseBoundary({
    client,
    packageName: 'dev.mpgd.transfer',
    now: () => '2030-01-02T03:04:06.000Z',
    resolveObfuscatedAccountId: (playerId) => `account:${playerId}`,
  });
  const setPurchase = (token: string, overrides: Record<string, unknown> = {}) => {
    purchases.set(token, {
      ...createGooglePlayProductPurchaseConformanceFixture({
        productId: 'remove_ads_android',
        orderId: `GPA.${token}`,
        obfuscatedExternalAccountId: 'account:player-a',
      }),
      ...overrides,
    });
  };
  const playRequest = (
    token: string,
    playerId: string,
    overrides: Partial<VerifyPurchaseRequest> = {},
  ): VerifyPurchaseRequest => ({
    target: 'android',
    playerId,
    productId: 'REMOVE_ADS',
    platformTransactionId: `GPA.${token}`,
    idempotencyKey: `play:${token}:${playerId}`,
    purchasedAt: '2030-01-02T03:04:05.000Z',
    evidence: { schema: googlePlayProductPurchaseEvidenceSchema, payload: { purchaseToken: token } },
    intent: 'restore',
    ...overrides,
  });
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: {
      verifyPurchase: (input) => boundary.verifyPurchase(input),
      verifyAdReward: async () => ({ status: 'rejected', reason: 'UNUSED' }),
    },
    purchaseGrantFinalizer: boundary,
    restoreTransfers: { mode: 'move' },
  });

  // The verifier reports the foreign binding only for a restore of a non-consumable.
  setPurchase('token-1');
  const product = catalog.products[0];
  const signal = new AbortController().signal;
  const decision = await boundary.verifyPurchase({
    request: playRequest('token-1', 'player-b'),
    product,
    platformProductId: 'remove_ads_android',
    signal,
    timeoutMs: 1000,
  });
  assert.equal(decision.status, 'restorable');
  assert.equal(
    decision.status === 'restorable' ? decision.reason : '',
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );
  const asPurchase = await boundary.verifyPurchase({
    request: playRequest('token-1', 'player-b', { intent: 'purchase' }),
    product,
    platformProductId: 'remove_ads_android',
    signal,
    timeoutMs: 1000,
  });
  assert.deepEqual(asPurchase, { status: 'rejected', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' });

  // The buyer's grant, then the reinstall's restore moves it.
  const bought = await backend.purchases.verifyPurchase(
    playRequest('token-1', 'player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  assert.equal(bought.finalization?.status, 'completed');
  const restored = await backend.purchases.verifyPurchase(playRequest('token-1', 'player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.transferred, true);
  assert.equal(restored.finalization?.status, 'completed');
  assert.equal(restored.finalization?.alreadyCompleted, true);
  assert.deepEqual(acknowledged, ['token-1']);
  // A checkout of the same token by a third player is still a mismatch.
  assert.equal(
    (await backend.purchases.verifyPurchase(playRequest('token-1', 'player-c', { intent: 'purchase' })))
      .reason,
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );

  // A purchase the old guest never verified: granted to the new guest and acknowledged
  // within Play's three days.
  setPurchase('token-2');
  const unacknowledged = await backend.purchases.verifyPurchase(playRequest('token-2', 'player-b'));
  assert.equal(unacknowledged.verified, true);
  assert.equal(unacknowledged.transferred, true);
  assert.equal(unacknowledged.finalization?.status, 'completed');
  assert.equal(unacknowledged.finalization?.alreadyCompleted, false);
  assert.deepEqual(acknowledged, ['token-1', 'token-2']);

  // A purchase made outside the app (no account id) restores the same way.
  setPurchase('token-3');
  delete purchases.get('token-3')?.obfuscatedExternalAccountId;
  assert.equal(
    (await backend.purchases.verifyPurchase(playRequest('token-3', 'player-b'))).transferred,
    true,
  );

  // Refunded at Play: refused before any binding is looked at.
  setPurchase('token-4', {
    productLineItem: [
      {
        productId: 'remove_ads_android',
        productOfferDetails: { quantity: 1, refundableQuantity: 0 },
      },
    ],
  });
  assert.equal(
    (await backend.purchases.verifyPurchase(playRequest('token-4', 'player-b'))).reason,
    'GOOGLE_PLAY_PURCHASE_REFUNDED',
  );
}

// App Store: a new device (or an erased one, or a logout) makes a new guest;
// StoreKit returns the non-consumable with the old guest's appAccountToken.
{
  const tokens: Record<string, string> = {
    'player-a': 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2',
    'player-b': '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    'player-c': '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e',
  };
  let transaction: AppStoreTransactionPayload = createAppStoreTransactionConformanceFixture({
    transactionId: '2000000000000042',
    originalTransactionId: '2000000000000042',
    productId: 'com.example.game.removeads',
    type: 'Non-Consumable',
    appAccountToken: tokens['player-a'] ?? '',
  });
  const verifier = createAppStoreGameServicesEvidenceVerifier({
    bundleId: 'com.example.game',
    environment: 'Production',
    serverApi: {
      async getTransactionInfo() {
        return { status: 'found', signedTransactionInfo: 'server-jws' };
      },
    },
    signedTransactionVerifier: {
      async verifyAndDecode() {
        return { status: 'verified', payload: transaction };
      },
    },
    resolveAppAccountToken: ({ playerId }) => tokens[playerId] ?? '',
    now: () => '2026-07-16T13:00:00.000Z',
  });
  const iosRequest = (
    playerId: string,
    overrides: Partial<VerifyPurchaseRequest> = {},
  ): VerifyPurchaseRequest => ({
    target: 'ios',
    playerId,
    productId: 'REMOVE_ADS',
    platformTransactionId: '2000000000000042',
    idempotencyKey: `app-store:${playerId}`,
    purchasedAt: '2020-01-02T03:04:05.000Z',
    evidence: createAppStoreSignedTransactionEvidenceFixture({
      transactionId: '2000000000000042',
      originalTransactionId: '2000000000000042',
      bundleId: 'com.example.game',
    }),
    intent: 'restore',
    ...overrides,
  });
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: verifier,
    restoreTransfers: { mode: 'move' },
  });
  const bought = await backend.purchases.verifyPurchase(
    iosRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  const restored = await backend.purchases.verifyPurchase(iosRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.transferred, true);
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.playerId),
    ['player-b'],
  );

  // Without the client's StoreKit-verified JWS a transaction id alone never moves a purchase.
  const { evidence: _evidence, ...withoutEvidence } = iosRequest('player-c');
  void _evidence;
  assert.equal(
    (await backend.purchases.verifyPurchase(withoutEvidence)).reason,
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  );
  assert.equal(
    (await backend.purchases.verifyPurchase(iosRequest('player-c', { intent: 'purchase' }))).reason,
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  );

  // Refunded at Apple: the checks after the binding still apply to a restore.
  transaction = { ...transaction, revocationDate: Date.parse('2021-01-01T00:00:00.000Z') };
  assert.equal(
    (await backend.purchases.verifyPurchase(iosRequest('player-c'))).reason,
    'APP_STORE_TRANSACTION_REVOKED',
  );
}

console.log('purchase transfer tests passed');

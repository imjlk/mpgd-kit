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
  createPurchaseHolderEvidenceVerificationId,
  findPurchaseGrantByEvidenceVerificationId,
  listActiveEntitlementTransactions,
  listPurchaseHolders,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import {
  createGooglePlayProductPurchaseBoundary,
  googlePlayProductPurchaseEvidenceSchema,
  type GooglePlayProductPurchaseClient,
} from './google-play-purchase.js';
import { createGooglePlayProductPurchaseConformanceFixture } from './google-play-purchase-conformance.js';
import { GameServicesPurchaseBoundToAnotherAccountError } from './another-account.js';
import type {
  EvidenceVerificationDecision,
  FinalizePurchaseGrantInput,
  GameServicesEvidenceVerifier,
} from './evidence-verification.js';
import { resolvePurchaseRestoreSharingPolicy } from './purchase-sharing.js';
import {
  createGameServicesBackend,
  createInMemoryGameServicesStore,
  type GameServicesStore,
} from './server.js';
import type { VerifyPurchaseRequest } from './types.js';

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

/**
 * A purchase the store binds to another account and no share covers: the
 * backend answers the retryable PURCHASE_BOUND_TO_ANOTHER_ACCOUNT error, not a
 * `rejected` receipt (RFC "Another account's purchase").
 */
async function assertAnotherAccount(verify: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(verify, (error: unknown) => {
    assert.ok(error instanceof GameServicesPurchaseBoundToAnotherAccountError);
    assert.equal(error.reason, reason);
    return true;
  });
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

// Policy validation.
assert.deepEqual(resolvePurchaseRestoreSharingPolicy(undefined), { mode: 'refuse', maxHolders: 5 });
assert.deepEqual(resolvePurchaseRestoreSharingPolicy({ mode: 'share', maxHolders: 2 }), {
  mode: 'share',
  maxHolders: 2,
});
assert.throws(() => resolvePurchaseRestoreSharingPolicy({ mode: 'share', maxHolders: 0 }));
assert.throws(() => resolvePurchaseRestoreSharingPolicy({ mode: 'share', maxHolders: 101 }));
assert.throws(() => resolvePurchaseRestoreSharingPolicy({ mode: 'other' as 'share' }));

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
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(restoreRequest('player-b')),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );
  // Nothing is recorded for the refused player: only the buyer's grant.
  assert.deepEqual(
    (await store.listEntitlementTransactions()).map((grant) => grant.playerId),
    ['player-a'],
  );
}

// Reinstall or a second device: the new guest gets its own grant; the buyer keeps theirs.
{
  const store = createInMemoryGameServicesStore();
  const finalized: FinalizePurchaseGrantInput[] = [];
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
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
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  assert.equal(bought.restoredAcrossPlayers, undefined);
  const firstLedgerEntryId = bought.ledgerEntryId ?? '';

  const restored = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.alreadyProcessed, false);
  assert.equal(restored.restoredAcrossPlayers, true);
  assert.notEqual(restored.ledgerEntryId, firstLedgerEntryId);
  // The finalizer acknowledges the purchase, not the share.
  assert.equal(finalized.at(-1)?.evidenceVerificationId, purchaseVerificationId);

  // Earlier holders keep theirs: both are active.
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.playerId).sort(),
    ['player-a', 'player-b'],
  );
  for (const [playerId, ledgerEntryId] of [
    ['player-a', firstLedgerEntryId],
    ['player-b', restored.ledgerEntryId ?? ''],
  ] as const) {
    assert.equal(
      (await readPurchaseLedgerStatuses(store, { playerId, ledgerEntryIds: [ledgerEntryId] }))
        .statuses[0]?.status,
      'active',
    );
  }
  const shared = await store.getEntitlementTransaction(restored.ledgerEntryId ?? '');
  assert.equal(
    shared?.evidenceVerificationId,
    createPurchaseHolderEvidenceVerificationId(purchaseVerificationId, 1),
  );
  assert.equal(shared?.idempotencyKey, 'play-token-sha256:player-b');
  assert.equal(shared?.payload.holderOfEvidenceVerificationId, purchaseVerificationId);
  // The share names the purchase, never another holder's ledger id (it embeds that player's id).
  assert.equal(JSON.stringify(shared?.payload).includes('player-a'), false);
  assert.equal(shared?.payload.platformTransactionId, undefined);
  const holders = await listPurchaseHolders(store, purchaseVerificationId);
  assert.equal(holders.first?.ledgerEntryId, firstLedgerEntryId);
  assert.deepEqual(
    holders.shared.map((grant) => grant.playerId),
    ['player-b'],
  );
  assert.equal(holders.nextSlot, 2);

  // Idempotent per purchase and guest: the same key, and another key of the same guest.
  const replay = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(replay.alreadyProcessed, true);
  assert.equal(replay.restoredAcrossPlayers, true);
  assert.equal(replay.ledgerEntryId, restored.ledgerEntryId);
  assert.equal(finalized.at(-1)?.evidenceVerificationId, purchaseVerificationId);
  const otherKey = await backend.purchases.verifyPurchase(
    restoreRequest('player-b', { idempotencyKey: 'another-key' }),
  );
  assert.equal(otherKey.alreadyProcessed, true);
  assert.equal(otherKey.ledgerEntryId, restored.ledgerEntryId);
  // The buyer restoring again (a new journal record) answers its own grant.
  const buyerAgain = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { idempotencyKey: 'player-a-restore' }),
  );
  assert.equal(buyerAgain.ledgerEntryId, firstLedgerEntryId);

  // A checkout this client started (no restore intent) never shares.
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(restoreRequest('player-c', { intent: 'purchase' })),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );
  const { intent: _intent, ...withoutIntent } = restoreRequest('player-c');
  void _intent;
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(withoutIntent),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );

  // A refund that names the first grant revokes every holder.
  const refund = await revokeEntitlementGrant(store, {
    playerId: 'player-a',
    revokesLedgerEntryId: firstLedgerEntryId,
    idempotencyKey: 'google-play:voided:token',
    reason: 'refund',
    revokedAt: '2030-01-02T00:00:00.000Z',
    payload: { target: 'android' },
    evidenceVerificationId: `${purchaseVerificationId}:revoke`,
  });
  assert.equal(refund.status, 'revoked');
  assert.deepEqual(await listActiveEntitlementTransactions(store), []);
  // A replay finds the same entries and writes nothing new.
  assert.equal(
    (await revokeEntitlementGrant(store, {
      playerId: 'player-a',
      revokesLedgerEntryId: firstLedgerEntryId,
      idempotencyKey: 'google-play:voided:token',
      reason: 'refund',
      revokedAt: '2030-01-02T00:00:00.000Z',
      payload: { target: 'android' },
      evidenceVerificationId: `${purchaseVerificationId}:revoke`,
    })).status,
    'revoked',
  );
  // A refunded purchase is never shared again, and the holders' keys answer reversed.
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-d')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'LEDGER_GRANT_REVERSED',
  });
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b'))).reason,
    'LEDGER_GRANT_REVERSED',
  );
}

// A refund naming a shared grant revokes the first grant and the other shares;
// an admin entry stays on the grant it names.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  const toB = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  const toC = await backend.purchases.verifyPurchase(restoreRequest('player-c'));
  const admin = await revokeEntitlementGrant(store, {
    playerId: 'player-c',
    revokesLedgerEntryId: toC.ledgerEntryId ?? '',
    idempotencyKey: 'admin:1',
    reason: 'admin',
    revokedAt: '2030-01-02T00:00:00.000Z',
    payload: {},
  });
  assert.equal(admin.status, 'revoked');
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.playerId).sort(),
    ['player-a', 'player-b'],
  );
  // The revoked holder does not get another share.
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-c', { idempotencyKey: 'new' })))
      .reason,
    'LEDGER_GRANT_REVERSED',
  );
  await revokeEntitlementGrant(store, {
    playerId: 'player-b',
    revokesLedgerEntryId: toB.ledgerEntryId ?? '',
    idempotencyKey: 'app-store:notification:1',
    reason: 'refund',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: {},
  });
  assert.deepEqual(await listActiveEntitlementTransactions(store), []);
  assert.equal(
    (await readPurchaseLedgerStatuses(store, {
      playerId: 'player-a',
      ledgerEntryIds: [bought.ledgerEntryId ?? ''],
    })).statuses[0]?.status,
    'reversed',
  );
}

// An admin entry on the first grant frees the buyer's place; sharing goes on.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  const toB = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  await revokeEntitlementGrant(store, {
    playerId: 'player-a',
    revokesLedgerEntryId: bought.ledgerEntryId ?? '',
    idempotencyKey: 'admin:first',
    reason: 'admin',
    revokedAt: '2030-01-02T00:00:00.000Z',
    payload: {},
  });
  const bAgain = await backend.purchases.verifyPurchase(
    restoreRequest('player-b', { idempotencyKey: 'player-b-again' }),
  );
  assert.equal(bAgain.ledgerEntryId, toB.ledgerEntryId, 'another holder keeps its grant');
  const toC = await backend.purchases.verifyPurchase(restoreRequest('player-c'));
  assert.equal(toC.restoredAcrossPlayers, true, 'sharing goes on');
  // A purchase whose every holder an operator revoked is never shared again
  // (a refund arriving then would find no grant left to mark).
  for (const [playerId, ledgerEntryId] of [
    ['player-b', toB.ledgerEntryId ?? ''],
    ['player-c', toC.ledgerEntryId ?? ''],
  ] as const) {
    await revokeEntitlementGrant(store, {
      playerId,
      revokesLedgerEntryId: ledgerEntryId,
      idempotencyKey: `admin:${playerId}`,
      reason: 'admin',
      revokedAt: '2030-01-02T00:00:00.000Z',
      payload: {},
    });
  }
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-z'))).reason,
    'LEDGER_GRANT_REVERSED',
  );
}

// A refund that lands between a share's read and its write ends the share too.
{
  const inner = createInMemoryGameServicesStore();
  let refundFirst: (() => Promise<void>) | undefined;
  const store: GameServicesStore = {
    recordEntitlementGrant: async (input) => {
      if (input.evidenceVerificationId?.includes('#mpgd-holder:') === true && refundFirst !== undefined) {
        const refund = refundFirst;
        refundFirst = undefined;
        await refund();
      }
      return inner.recordEntitlementGrant(input);
    },
    findEntitlementTransactionByIdempotency: (input) =>
      inner.findEntitlementTransactionByIdempotency(input),
    findEntitlementTransactionByEvidenceVerificationId: (input) =>
      inner.findEntitlementTransactionByEvidenceVerificationId(input),
    getEntitlementTransaction: (id) => inner.getEntitlementTransaction(id),
    listEntitlementTransactions: () => inner.listEntitlementTransactions(),
    recordEntitlementRevocation: (input) => inner.recordEntitlementRevocation(input),
    findEntitlementRevocations: (input) => inner.findEntitlementRevocations(input),
    recordLeaderboardScore: (input, options) => inner.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => inner.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => inner.listLeaderboardTransactions(),
  };
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  refundFirst = async () => {
    await revokeEntitlementGrant(inner, {
      playerId: 'player-a',
      revokesLedgerEntryId: bought.ledgerEntryId ?? '',
      idempotencyKey: 'google-play:voided:race',
      reason: 'voided',
      revokedAt: '2030-01-02T00:00:00.000Z',
      payload: {},
      evidenceVerificationId: `${purchaseVerificationId}:revoke`,
    });
  };
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-b')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'LEDGER_GRANT_REVERSED',
  });
  assert.deepEqual(
    await listActiveEntitlementTransactions(inner),
    [],
    'the late share is revoked too',
  );
}

// An admin revocation and a refund that both land between a share's read and
// its write leave no live holder: the share ends too.
{
  const inner = createInMemoryGameServicesStore();
  let interleave: (() => Promise<void>) | undefined;
  const store: GameServicesStore = {
    recordEntitlementGrant: async (input) => {
      if (input.evidenceVerificationId?.includes('#mpgd-holder:') === true && interleave !== undefined) {
        const run = interleave;
        interleave = undefined;
        await run();
      }
      return inner.recordEntitlementGrant(input);
    },
    findEntitlementTransactionByIdempotency: (input) =>
      inner.findEntitlementTransactionByIdempotency(input),
    findEntitlementTransactionByEvidenceVerificationId: (input) =>
      inner.findEntitlementTransactionByEvidenceVerificationId(input),
    getEntitlementTransaction: (id) => inner.getEntitlementTransaction(id),
    listEntitlementTransactions: () => inner.listEntitlementTransactions(),
    recordEntitlementRevocation: (input) => inner.recordEntitlementRevocation(input),
    findEntitlementRevocations: (input) => inner.findEntitlementRevocations(input),
    recordLeaderboardScore: (input, options) => inner.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => inner.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => inner.listLeaderboardTransactions(),
  };
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  interleave = async () => {
    const revoke = (reason: 'admin' | 'refund', idempotencyKey: string) => revokeEntitlementGrant(inner, {
      playerId: 'player-a',
      revokesLedgerEntryId: bought.ledgerEntryId ?? '',
      idempotencyKey,
      reason,
      revokedAt: '2030-01-02T00:00:00.000Z',
      payload: {},
    });
    await revoke('admin', 'admin:race');
    await revoke('refund', 'app-store:notification:race');
  };
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b'))).reason,
    'LEDGER_GRANT_REVERSED',
  );
  assert.deepEqual(await listActiveEntitlementTransactions(inner), [], 'no holder survives');
}

// Account deletion of the buyer: its record is kept detached and never revived,
// the other holder keeps its share, and a new guest shares the purchase.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share', maxHolders: 2 },
  });
  await backend.purchases.verifyPurchase(restoreRequest('player-a', { intent: 'purchase' }));
  const toB = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  await store.erasePlayerData({ playerId: 'player-a', retainedPlayerId: 'deleted:deletion-a' });
  const holders = await listPurchaseHolders(store, purchaseVerificationId);
  assert.equal(holders.first?.playerId, 'deleted:deletion-a');
  assert.equal(holders.shared[0]?.ledgerEntryId, toB.ledgerEntryId);
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-c'))).restoredAcrossPlayers,
    true,
  );
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-d'))).reason,
    'PURCHASE_HOLDER_LIMIT_REACHED',
    'the retained record does not count; B and C do',
  );
  // A refund still reaches every holder, the retained record included.
  await revokeEntitlementGrant(store, {
    playerId: 'player-b',
    revokesLedgerEntryId: toB.ledgerEntryId ?? '',
    idempotencyKey: 'google-play:voided:after-deletion',
    reason: 'voided',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: {},
    evidenceVerificationId: `${purchaseVerificationId}:revoke`,
  });
  assert.deepEqual(await listActiveEntitlementTransactions(store), []);
}

// A refund naming an admin-revoked grant still reaches a share written while
// its fan-out runs: the fan-out reads the holders again.
{
  const inner = createInMemoryGameServicesStore();
  let duringFanOut: (() => Promise<void>) | undefined;
  const store: GameServicesStore = {
    recordEntitlementGrant: (input) => inner.recordEntitlementGrant(input),
    findEntitlementTransactionByIdempotency: (input) => inner.findEntitlementTransactionByIdempotency(input),
    findEntitlementTransactionByEvidenceVerificationId: (input) =>
      inner.findEntitlementTransactionByEvidenceVerificationId(input),
    findEntitlementTransactionsByEvidencePrefix: (input) =>
      inner.findEntitlementTransactionsByEvidencePrefix(input),
    getEntitlementTransaction: (id) => inner.getEntitlementTransaction(id),
    listEntitlementTransactions: () => inner.listEntitlementTransactions(),
    recordEntitlementRevocation: async (input) => {
      // A restore writes a share between the fan-out's read and its first write.
      if (input.reason === 'refund' && input.playerId === 'player-b' && duringFanOut !== undefined) {
        const run = duringFanOut;
        duringFanOut = undefined;
        await run();
      }
      return inner.recordEntitlementRevocation(input);
    },
    findEntitlementRevocations: (input) => inner.findEntitlementRevocations(input),
    recordLeaderboardScore: (input, options) => inner.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => inner.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => inner.listLeaderboardTransactions(),
  };
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store: inner,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  await revokeEntitlementGrant(inner, {
    playerId: 'player-a',
    revokesLedgerEntryId: bought.ledgerEntryId ?? '',
    idempotencyKey: 'admin:a',
    reason: 'admin',
    revokedAt: '2030-01-02T00:00:00.000Z',
    payload: {},
  });
  duringFanOut = async () => {
    assert.equal(
      (await backend.purchases.verifyPurchase(restoreRequest('player-c'))).restoredAcrossPlayers,
      true,
    );
  };
  // The refund names the buyer's (admin-revoked) grant.
  await revokeEntitlementGrant(store, {
    playerId: 'player-a',
    revokesLedgerEntryId: bought.ledgerEntryId ?? '',
    idempotencyKey: 'app-store:notification:fan-out',
    reason: 'refund',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: {},
  });
  assert.deepEqual(await listActiveEntitlementTransactions(inner), [], 'the late share is revoked');
}

// Holders past a gap: the retention purge deleted a deleted player's share, and
// the indexed read still finds the share after it (for the cap and refunds).
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share', maxHolders: 3 },
  });
  await backend.purchases.verifyPurchase(restoreRequest('player-a', { intent: 'purchase' }));
  await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  const toC = await backend.purchases.verifyPurchase(restoreRequest('player-c'));
  // Slot 1 (player-b's share) is gone, as after the purge of a deleted player's record.
  const slot1 = await store.findEntitlementTransactionByEvidenceVerificationId({
    source: 'purchase',
    evidenceVerificationId: createPurchaseHolderEvidenceVerificationId(purchaseVerificationId, 1),
  });
  assert.ok(slot1);
  (store as unknown as { forgetEntitlementTransaction(grant: unknown): void })
    .forgetEntitlementTransaction(slot1);
  const holders = await listPurchaseHolders(store, purchaseVerificationId);
  assert.deepEqual(
    holders.shared.map((grant) => grant.ledgerEntryId),
    [toC.ledgerEntryId],
  );
  assert.equal(holders.nextSlot, 3);
  const toD = await backend.purchases.verifyPurchase(restoreRequest('player-d'));
  assert.equal(toD.restoredAcrossPlayers, true, 'the purged place is free');
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-e'))).reason,
    'PURCHASE_HOLDER_LIMIT_REACHED',
    'the share past the gap still counts',
  );

  // The first grant purged too: a store event's lookup by the purchase id
  // reaches a surviving share, and the refund's fan-out the rest.
  const first = await store.findEntitlementTransactionByEvidenceVerificationId({
    source: 'purchase',
    evidenceVerificationId: purchaseVerificationId,
  });
  assert.ok(first);
  (store as unknown as { forgetEntitlementTransaction(grant: unknown): void })
    .forgetEntitlementTransaction(first);
  const surviving = await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId);
  assert.equal(surviving?.ledgerEntryId, toC.ledgerEntryId);
  await revokeEntitlementGrant(store, {
    playerId: surviving?.playerId ?? '',
    revokesLedgerEntryId: surviving?.ledgerEntryId ?? '',
    idempotencyKey: 'google-play:voided:after-purge',
    reason: 'voided',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: {},
  });
  assert.deepEqual(
    await listActiveEntitlementTransactions(store),
    [],
    'every surviving holder is revoked',
  );
}

// After the purge of the first grant, the buyer's own checkout takes a holder's
// place under the limit, never a replacement first grant past it.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share', maxHolders: 2 },
  });
  await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  await backend.purchases.verifyPurchase(restoreRequest('player-c'));
  const first = await store.findEntitlementTransactionByEvidenceVerificationId({
    source: 'purchase',
    evidenceVerificationId: purchaseVerificationId,
  });
  (store as unknown as { forgetEntitlementTransaction(grant: unknown): void })
    .forgetEntitlementTransaction(first);
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-d'))).restoredAcrossPlayers,
    true,
  );
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-a', { intent: 'purchase' }))).reason,
    'PURCHASE_HOLDER_LIMIT_REACHED',
  );
  assert.equal((await listActiveEntitlementTransactions(store)).length, 2);
}

// Two deployment targets sharing one ledger never share a grant.
{
  const store = createInMemoryGameServicesStore();
  await store.recordEntitlementGrant({
    playerId: 'player-a',
    grantId: 'REMOVE_ADS',
    source: 'purchase',
    idempotencyKey: 'staging-buy',
    grantedAt: '2030-01-01T00:00:00.000Z',
    grant: { type: 'entitlement', entitlement: 'remove_ads' },
    payload: { target: 'android', productId: 'REMOVE_ADS', deploymentTarget: 'android-staging' },
    evidenceVerificationId: purchaseVerificationId,
  });
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  assert.equal(
    (await backend.purchases.verifyPurchase(restoreRequest('player-b'))).reason,
    'LEDGER_GRANT_IDENTITY_MISMATCH',
  );
}

// Consumables are never shared, even under the share policy.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  // A consumable never moves or is shared: another account's, nothing recorded.
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(restoreRequest('player-b', { productId: 'HINT_PACK_5' })),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );
  assert.deepEqual(await store.listEntitlementTransactions(), []);
}

// A purchase no grant holds yet is granted to the restoring player; the buyer's
// restore then gets its own share.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  const restored = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.restoredAcrossPlayers, true);
  const [grant] = await store.listEntitlementTransactions();
  assert.equal(grant?.playerId, 'player-b');
  assert.equal(grant?.evidenceVerificationId, purchaseVerificationId);
  assert.equal(grant?.payload.restoredAcrossAccounts, true);
  assert.equal(grant?.payload.platformTransactionId, 'GPA.1234');
  const retried = await backend.purchases.verifyPurchase(restoreRequest('player-b'));
  assert.equal(retried.alreadyProcessed, true);
  assert.equal(retried.restoredAcrossPlayers, true);
  // The buyer's own checkout (its binding matches, no restore intent) gets its share
  // too, though another guest's restore wrote the first grant.
  const buyerCheckout = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(buyerCheckout.verified, true);
  assert.equal(buyerCheckout.restoredAcrossPlayers, true);
  const buyerRestore = await backend.purchases.verifyPurchase(
    restoreRequest('player-a', { idempotencyKey: 'player-a-restore' }),
  );
  assert.equal(buyerRestore.ledgerEntryId, buyerCheckout.ledgerEntryId);
  assert.equal((await listActiveEntitlementTransactions(store)).length, 2);
}

// A key another isolate filled with a different purchase after the lookup is a
// conflict, never a restore that grants nothing.
{
  const inner = createInMemoryGameServicesStore();
  await inner.recordEntitlementGrant({
    playerId: 'player-b',
    grantId: 'HINT_PACK_5',
    source: 'purchase',
    idempotencyKey: 'play-token-sha256:player-b',
    grantedAt: '2030-01-01T00:00:00.000Z',
    payload: { target: 'android', productId: 'HINT_PACK_5' },
  });
  const store: GameServicesStore = {
    recordEntitlementGrant: (input) => inner.recordEntitlementGrant(input),
    // The lookups miss the key, as a lookup before the other isolate's write does.
    findEntitlementTransactionByIdempotency: async () => undefined,
    findEntitlementTransactionByEvidenceVerificationId: (input) =>
      inner.findEntitlementTransactionByEvidenceVerificationId(input),
    getEntitlementTransaction: (id) => inner.getEntitlementTransaction(id),
    listEntitlementTransactions: async () => [],
    findEntitlementRevocations: (input) => inner.findEntitlementRevocations(input),
    recordLeaderboardScore: (input, options) => inner.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => inner.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => inner.listLeaderboardTransactions(),
  };
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share' },
  });
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-b')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'IDEMPOTENCY_KEY_CONFLICT',
  });
}

// The cap: at most maxHolders players hold a purchase; past it the restore waits
// (retryable) and nobody is evicted. A deleted player's retained record does not count.
{
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier({ buyer: 'nobody' }),
    restoreSharing: { mode: 'share', maxHolders: 3 },
  });
  // The buyer deleted its account: its retained record keeps the purchase's evidence id.
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
  for (const playerId of ['player-b', 'player-c', 'player-d']) {
    assert.equal(
      (await backend.purchases.verifyPurchase(restoreRequest(playerId))).restoredAcrossPlayers,
      true,
      `${playerId} gets a slot`,
    );
  }
  assert.deepEqual(await backend.purchases.verifyPurchase(restoreRequest('player-e')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'pending',
    reason: 'PURCHASE_HOLDER_LIMIT_REACHED',
  });
  assert.equal((await listActiveEntitlementTransactions(store)).length, 4, 'nobody was evicted');
  // The retained record is never revived for the deleted id, and the new grants link to it.
  const holders = await listPurchaseHolders(store, purchaseVerificationId);
  assert.equal(holders.first?.playerId, 'deleted:deletion-1');
  assert.equal(holders.first?.payload.platformTransactionId, 'GPA.1234');
  assert.equal(holders.shared[0]?.payload.holderOfEvidenceVerificationId, purchaseVerificationId);
  // A holder revoked by an operator frees its place for another player.
  await revokeEntitlementGrant(store, {
    playerId: 'player-c',
    revokesLedgerEntryId: holders.shared[1]?.ledgerEntryId ?? '',
    idempotencyKey: 'admin:free',
    reason: 'admin',
    revokedAt: '2030-01-02T00:00:00.000Z',
    payload: {},
  });
  const later = await backend.purchases.verifyPurchase(restoreRequest('player-e'));
  assert.equal(later.restoredAcrossPlayers, true);
  assert.equal(
    (await store.getEntitlementTransaction(later.ledgerEntryId ?? ''))?.payload.holderSlot,
    4,
  );
}

// Concurrent restores from separate isolates: all succeed while slots are free,
// and the cap holds under the race.
{
  const shared = createInMemoryGameServicesStore();
  // Every isolate has read the holders before any writes its share.
  let arrived = 0;
  const writers = 4;
  let releaseWriters = (): void => {};
  const writersReady = new Promise<void>((resolve) => {
    releaseWriters = resolve;
  });
  // Separate wrappers model separate Worker isolates: the in-process locks are
  // per store object, so only the ledger write decides the race.
  const isolate = (): GameServicesStore => ({
    recordEntitlementGrant: async (input) => {
      if (input.evidenceVerificationId?.includes('#mpgd-holder:') === true && arrived < writers) {
        arrived += 1;
        if (arrived === writers) {
          releaseWriters();
        }
        await writersReady;
      }
      return shared.recordEntitlementGrant(input);
    },
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
    recordLeaderboardScore: (input, options) => shared.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (id) => shared.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => shared.listLeaderboardTransactions(),
  });
  const backendFor = (store: GameServicesStore) => createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'share', maxHolders: 3 },
  });
  await backendFor(shared).purchases.verifyPurchase(
    restoreRequest('player-a', { intent: 'purchase' }),
  );
  const answers = await Promise.all(
    ['player-b', 'player-c', 'player-d', 'player-e'].map((playerId) =>
      backendFor(isolate()).purchases.verifyPurchase(restoreRequest(playerId)),
    ),
  );
  assert.equal(answers.filter((answer) => answer.verified).length, 2, 'two free slots, two shares');
  assert.deepEqual(
    answers.filter((answer) => !answer.verified).map((answer) => answer.reason),
    ['PURCHASE_HOLDER_LIMIT_REACHED', 'PURCHASE_HOLDER_LIMIT_REACHED'],
  );
  assert.equal((await listActiveEntitlementTransactions(shared)).length, 3, 'the cap holds');
}

// Under refuse, a verified restore whose evidence another player's grant holds keeps
// its old answer.
{
  const store = createInMemoryGameServicesStore();
  // Both players verify (an unbound deployment), so the second hits the first's evidence.
  const unbound = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: {
      verifyPurchase: async () => ({
        status: 'verified',
        verificationId: purchaseVerificationId,
        verifiedAt: '2030-01-01T00:00:00.000Z',
      }),
      verifyAdReward: async () => ({ status: 'rejected', reason: 'UNUSED' }),
    },
  });
  assert.equal((await unbound.purchases.verifyPurchase(restoreRequest('player-a'))).verified, true);
  assert.equal(
    (await unbound.purchases.verifyPurchase(restoreRequest('player-b'))).reason,
    'EVIDENCE_ALREADY_PROCESSED',
  );
}

// Without the share policy's store reads the restore is refused as before.
{
  const inner = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store: inner,
    evidenceVerifier: createStoreVerifier(),
    restoreSharing: { mode: 'refuse' },
  });
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(restoreRequest('player-b')),
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
    packageName: 'dev.mpgd.sharing',
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
    restoreSharing: { mode: 'share' },
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
  assert.deepEqual(asPurchase, {
    status: 'rejected',
    reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    anotherAccount: true,
  });

  // The buyer's grant, then a reinstall's restore shares it.
  const bought = await backend.purchases.verifyPurchase(
    playRequest('token-1', 'player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  assert.equal(bought.finalization?.status, 'completed');
  const restored = await backend.purchases.verifyPurchase(playRequest('token-1', 'player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.restoredAcrossPlayers, true);
  assert.equal(restored.finalization?.status, 'completed');
  assert.equal(restored.finalization?.alreadyCompleted, true);
  assert.deepEqual(acknowledged, ['token-1']);
  // A checkout of the same token by a third player is still a mismatch.
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(playRequest('token-1', 'player-c', { intent: 'purchase' })),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
  );

  // A purchase the old guest never verified: granted to the new guest and acknowledged
  // within Play's three days.
  setPurchase('token-2');
  const unacknowledged = await backend.purchases.verifyPurchase(playRequest('token-2', 'player-b'));
  assert.equal(unacknowledged.verified, true);
  assert.equal(unacknowledged.restoredAcrossPlayers, true);
  assert.equal(unacknowledged.finalization?.status, 'completed');
  assert.equal(unacknowledged.finalization?.alreadyCompleted, false);
  assert.deepEqual(acknowledged, ['token-1', 'token-2']);

  // A purchase made outside the app (no account id) restores the same way.
  setPurchase('token-3');
  delete purchases.get('token-3')?.obfuscatedExternalAccountId;
  assert.equal(
    (await backend.purchases.verifyPurchase(playRequest('token-3', 'player-b'))).restoredAcrossPlayers,
    true,
  );
  // Its restorable reason says it is bound to no account: without a share it
  // is refused for good, never answered as another account's purchase.
  const unbound = await boundary.verifyPurchase({
    request: playRequest('token-3', 'player-c'),
    product,
    platformProductId: 'remove_ads_android',
    signal,
    timeoutMs: 1000,
  });
  assert.equal(unbound.status, 'restorable');
  assert.equal(
    unbound.status === 'restorable' ? unbound.reason : '',
    'GOOGLE_PLAY_ACCOUNT_ID_MISSING',
  );
  const refusing = createGameServicesBackend({
    catalog,
    placements,
    store: createInMemoryGameServicesStore(),
    evidenceVerifier: {
      verifyPurchase: (input) => boundary.verifyPurchase(input),
      verifyAdReward: async () => ({ status: 'rejected', reason: 'UNUSED' }),
    },
    purchaseGrantFinalizer: boundary,
    restoreSharing: { mode: 'refuse' },
  });
  assert.deepEqual(await refusing.purchases.verifyPurchase(playRequest('token-3', 'player-c')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING',
  });
  await assertAnotherAccount(
    refusing.purchases.verifyPurchase(playRequest('token-1', 'player-c')),
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
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
    restoreSharing: { mode: 'share' },
  });
  const bought = await backend.purchases.verifyPurchase(
    iosRequest('player-a', { intent: 'purchase' }),
  );
  assert.equal(bought.verified, true);
  const restored = await backend.purchases.verifyPurchase(iosRequest('player-b'));
  assert.equal(restored.verified, true);
  assert.equal(restored.restoredAcrossPlayers, true);
  assert.deepEqual(
    (await listActiveEntitlementTransactions(store)).map((grant) => grant.playerId).sort(),
    ['player-a', 'player-b'],
  );

  // Without the client's StoreKit-verified JWS a transaction id alone never shares a purchase.
  const { evidence: _evidence, ...withoutEvidence } = iosRequest('player-c');
  void _evidence;
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(withoutEvidence),
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  );
  await assertAnotherAccount(
    backend.purchases.verifyPurchase(iosRequest('player-c', { intent: 'purchase' })),
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  );

  // A transaction bound to no token restores under the share policy (L3c);
  // without a share it is refused for good as bound to no account.
  const { appAccountToken: _token, ...tokenless } = transaction;
  void _token;
  transaction = tokenless;
  const tokenlessRestore = await backend.purchases.verifyPurchase(
    iosRequest('player-c', { idempotencyKey: 'app-store:player-c:tokenless' }),
  );
  assert.equal(tokenlessRestore.restoredAcrossPlayers, true);
  const refusingIos = createGameServicesBackend({
    catalog,
    placements,
    store: createInMemoryGameServicesStore(),
    evidenceVerifier: verifier,
    restoreSharing: { mode: 'refuse' },
  });
  assert.deepEqual(await refusingIos.purchases.verifyPurchase(iosRequest('player-c')), {
    verified: false,
    alreadyProcessed: false,
    disposition: 'rejected',
    reason: 'APP_STORE_ACCOUNT_TOKEN_MISSING',
  });

  // Refunded at Apple: the checks after the binding still apply to a restore.
  transaction = { ...transaction, revocationDate: Date.parse('2021-01-01T00:00:00.000Z') };
  assert.equal(
    (await backend.purchases.verifyPurchase(iosRequest('player-c'))).reason,
    'APP_STORE_TRANSACTION_REVOKED',
  );
}

console.log('purchase sharing tests passed');

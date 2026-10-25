import assert from 'node:assert/strict';

import {
  appStoreServerNotificationHttpStatus,
  handleAppStoreServerNotification,
  type AppStoreServerNotification,
  type AppStoreServerNotificationVerifier,
} from './app-store-server-notifications.js';
import {
  AppStoreDependencyUnavailableError,
  createAppStoreVerificationId,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';
import { listActiveEntitlementTransactions } from './commerce-ledger.js';
import { createInMemoryGameServicesStore, type GameServicesStore } from './server.js';

const bundleId = 'com.example.game';
const consumable: AppStoreTransactionPayload = {
  transactionId: '2000000000000002',
  originalTransactionId: '2000000000000002',
  bundleId,
  productId: 'com.example.game.coins100',
  purchaseDate: Date.parse('2026-10-20T00:00:00.000Z'),
  signedDate: Date.parse('2026-10-24T00:00:00.000Z'),
  environment: 'Production',
  type: 'Consumable',
  revocationDate: Date.parse('2026-10-23T00:00:00.000Z'),
};
const nonConsumable: AppStoreTransactionPayload = {
  ...consumable,
  transactionId: '2000000000000005',
  originalTransactionId: '2000000000000004',
  productId: 'com.example.game.remove_ads',
  type: 'Non-Consumable',
};

function notification(
  overrides: Partial<AppStoreServerNotification> = {},
): AppStoreServerNotification {
  return {
    notificationType: 'REFUND',
    notificationUUID: 'uuid-refund-1',
    signedDate: Date.parse('2026-10-24T00:00:00.000Z'),
    environment: 'Production',
    bundleId,
    transaction: consumable,
    ...overrides,
  };
}

function verifierOf(
  result: AppStoreServerNotification | Error | { readonly rejected: string },
): AppStoreServerNotificationVerifier & { calls: number } {
  const verifier = {
    calls: 0,
    async verifyAndDecodeNotification(input: { readonly signedPayload: string }) {
      verifier.calls += 1;
      assert.equal(input.signedPayload, 'signed-payload');
      if (result instanceof Error) {
        throw result;
      }
      if ('rejected' in result) {
        return { status: 'rejected' as const, reason: result.rejected };
      }
      return { status: 'verified' as const, notification: result };
    },
  };
  return verifier;
}

async function grantFor(
  store: GameServicesStore,
  transaction: AppStoreTransactionPayload,
  playerId = 'player-1',
  target = 'ios',
) {
  return store.recordEntitlementGrant({
    source: 'purchase',
    playerId,
    grantId: transaction.type === 'Consumable' ? 'COINS_100' : 'REMOVE_ADS',
    idempotencyKey: `checkout-${transaction.transactionId}`,
    grantedAt: '2026-10-20T00:00:01.000Z',
    evidenceVerificationId: createAppStoreVerificationId({
      environment: transaction.environment,
      bundleId,
      transactionId: transaction.type === 'Non-Consumable'
        ? transaction.originalTransactionId
        : transaction.transactionId,
    }),
    payload: { target, store: 'app-store' },
  });
}

function handle(
  store: GameServicesStore,
  verifier: AppStoreServerNotificationVerifier,
  input: { readonly body: unknown } = { body: { signedPayload: 'signed-payload' } },
) {
  return handleAppStoreServerNotification({
    store,
    verifier,
    body: input.body,
    environment: 'Production',
    bundleId,
    signal: new AbortController().signal,
    now: () => '2026-10-24T12:00:00.000Z',
  });
}

{
  const store = createInMemoryGameServicesStore();
  const grant = await grantFor(store, consumable);
  const verifier = verifierOf(notification());
  const first = await handle(store, verifier);
  assert.deepEqual(first, {
    status: 'revoked',
    notificationUUID: 'uuid-refund-1',
    ledgerEntryId: first.status === 'revoked' ? first.ledgerEntryId : '',
    alreadyProcessed: false,
  });
  assert.equal(appStoreServerNotificationHttpStatus(first), 200);
  const [revocation] = await store.findEntitlementRevocations({
    ledgerEntryIds: [grant.ledgerEntryId],
  });
  assert.equal(revocation?.reason, 'refund');
  assert.equal(revocation?.revokedAt, '2026-10-23T00:00:00.000Z', 'Apple’s revocationDate is kept');
  assert.equal(revocation?.playerId, 'player-1', 'the grant’s player is revoked, not a body value');
  assert.equal(revocation?.payload.appStoreNotificationUUID, 'uuid-refund-1');
  assert.equal(
    (await listActiveEntitlementTransactions(store, { playerId: 'player-1' })).length,
    0,
    'a refunded grant leaves the active entitlements',
  );

  const replay = await handle(store, verifier);
  assert.equal(
    replay.status === 'revoked' && replay.alreadyProcessed,
    true,
    'a redelivery is idempotent',
  );
  const secondNotification = await handle(
    store,
    verifierOf(notification({ notificationUUID: 'uuid-refund-2' })),
  );
  assert.equal(
    secondNotification.status === 'revoked' && secondNotification.alreadyProcessed,
    true,
    'another notification for the same transaction answers the first revocation',
  );
}

{
  const store = createInMemoryGameServicesStore();
  const grant = await grantFor(store, nonConsumable);
  const revoke = await handle(
    store,
    verifierOf(notification({ notificationType: 'REVOKE', transaction: nonConsumable })),
  );
  assert.equal(revoke.status, 'revoked', 'a non-consumable is found by its original transaction');
  const [revocation] = await store.findEntitlementRevocations({
    ledgerEntryIds: [grant.ledgerEntryId],
  });
  assert.equal(revocation?.reason, 'voided', 'REVOKE is recorded as voided');
}

{
  const store = createInMemoryGameServicesStore();
  await grantFor(store, consumable);
  for (const [type, reason] of [
    ['TEST', 'APP_STORE_NOTIFICATION_TYPE_UNHANDLED'],
    // The grant was never revoked here: the reversal changes nothing.
    ['REFUND_REVERSED', 'APP_STORE_NOTIFICATION_GRANT_NOT_REVOKED'],
    ['CONSUMPTION_REQUEST', 'APP_STORE_NOTIFICATION_TYPE_UNHANDLED'],
  ] as const) {
    const outcome = await handle(store, verifierOf(notification({ notificationType: type })));
    assert.deepEqual(
      outcome,
      { status: 'ignored', reason, notificationUUID: 'uuid-refund-1' },
      type,
    );
    assert.equal(appStoreServerNotificationHttpStatus(outcome), 200, `${type} answers 200`);
  }
  const { transaction: _omitted, ...withoutTransaction } = notification();
  assert.equal(
    (await handle(store, verifierOf(withoutTransaction))).status === 'ignored',
    true,
    'a refund without a one-time transaction (a subscription) is ignored',
  );
  assert.equal(
    (await store.findEntitlementRevocations({
      ledgerEntryIds: (await store.listEntitlementTransactions()).map((entry) => entry.ledgerEntryId),
    })).length,
    0,
    'ignored notifications write nothing',
  );
}

{
  const store = createInMemoryGameServicesStore();
  const missing = await handle(store, verifierOf(notification()));
  assert.deepEqual(
    missing,
    {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND',
      notificationUUID: 'uuid-refund-1',
    },
    'a refund for a transaction this ledger never granted is answered 200',
  );
  await grantFor(store, consumable, 'player-1', 'android');
  assert.equal(
    (await handle(store, verifierOf(notification()))).status,
    'ignored',
    'a grant of another target is never revoked by an App Store notification',
  );
}

{
  const store = createInMemoryGameServicesStore();
  await grantFor(store, consumable);
  const rejected = await handle(store, verifierOf({ rejected: 'APP_STORE_SIGNATURE_INVALID' }));
  assert.deepEqual(rejected, { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' });
  assert.equal(appStoreServerNotificationHttpStatus(rejected), 400);

  const unavailable = await handle(
    store,
    verifierOf(new AppStoreDependencyUnavailableError('OCSP is down')),
  );
  assert.deepEqual(unavailable, {
    status: 'retry',
    reason: 'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE',
  });
  assert.equal(
    appStoreServerNotificationHttpStatus(unavailable),
    503,
    'Apple is asked to redeliver',
  );
  await assert.rejects(
    handle(store, verifierOf(new TypeError('verifier defect'))),
    /verifier defect/u,
    'an unexpected verifier fault propagates',
  );

  const sandboxOnProductionUrl = await handle(
    store,
    verifierOf(notification({ environment: 'Sandbox' })),
  );
  assert.deepEqual(sandboxOnProductionUrl, {
    status: 'rejected',
    reason: 'APP_STORE_NOTIFICATION_SCOPE_MISMATCH',
  });
  assert.equal(
    (await handle(store, verifierOf(notification({ bundleId: 'other.game' })))).status,
    'rejected',
    'a notification of another app is rejected',
  );
  assert.equal(
    (await handle(
      store,
      verifierOf(notification({ transaction: { ...consumable, environment: 'Sandbox' } })),
    )).status,
    'rejected',
    'a transaction of another environment is rejected',
  );

  const neverCalled = verifierOf(notification());
  for (const body of [undefined, null, [], {}, { signedPayload: '' }, { signedPayload: 42 }]) {
    assert.deepEqual(
      await handle(store, neverCalled, { body }),
      { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' },
      `malformed body ${JSON.stringify(body)}`,
    );
  }
  assert.equal(neverCalled.calls, 0, 'a malformed body never reaches the verifier');
  assert.equal(
    (await store.findEntitlementRevocations({
      ledgerEntryIds: (await store.listEntitlementTransactions()).map((entry) => entry.ledgerEntryId),
    })).length,
    0,
    'rejected notifications write nothing',
  );
}

{
  // A family member's access ending never reverses the purchaser's grant.
  const store = createInMemoryGameServicesStore();
  const grant = await grantFor(store, nonConsumable);
  const shared = await handle(
    store,
    verifierOf(
      notification({
        notificationType: 'REVOKE',
        transaction: {
          ...nonConsumable,
          transactionId: '2000000000000099',
          inAppOwnershipType: 'FAMILY_SHARED',
        },
      }),
    ),
  );
  assert.deepEqual(shared, {
    status: 'ignored',
    reason: 'APP_STORE_NOTIFICATION_SHARED_ACCESS_IGNORED',
    notificationUUID: 'uuid-refund-1',
  });
  assert.equal(
    (await store.findEntitlementRevocations({ ledgerEntryIds: [grant.ledgerEntryId] })).length,
    0,
    'the purchaser keeps the grant',
  );
  const purchaserRefund = await handle(
    store,
    verifierOf(
      notification({
        notificationUUID: 'uuid-refund-purchaser',
        transaction: { ...nonConsumable, inAppOwnershipType: 'PURCHASED' },
      }),
    ),
  );
  assert.equal(purchaserRefund.status, 'revoked', 'the purchaser’s own refund still revokes');
}

{
  // Apple's revocationDate beyond Date's range falls back to the clock, and a
  // store without the evidence index is scanned.
  const indexed = createInMemoryGameServicesStore();
  const store: GameServicesStore = {
    recordEntitlementGrant: (input) => indexed.recordEntitlementGrant(input),
    getEntitlementTransaction: (id) => indexed.getEntitlementTransaction(id),
    listEntitlementTransactions: () => indexed.listEntitlementTransactions(),
    recordEntitlementRevocation: (input) => indexed.recordEntitlementRevocation(input),
    findEntitlementRevocations: (input) => indexed.findEntitlementRevocations(input),
    recordLeaderboardScore: (input) => indexed.recordLeaderboardScore(input),
    getLeaderboardTransaction: (id) => indexed.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => indexed.listLeaderboardTransactions(),
  };
  const grant = await grantFor(store, consumable);
  const outcome = await handle(
    store,
    verifierOf(
      notification({
        transaction: { ...consumable, revocationDate: 9_000_000_000_000_000 },
      }),
    ),
  );
  assert.equal(outcome.status, 'revoked', 'the grant is found without the index');
  const [revocation] = await indexed.findEntitlementRevocations({
    ledgerEntryIds: [grant.ledgerEntryId],
  });
  assert.equal(
    revocation?.revokedAt,
    '2026-10-24T12:00:00.000Z',
    'an unrepresentable date uses now',
  );

  const conflictGrant = await grantFor(store, { ...consumable, transactionId: '2000000000000003' });
  const conflict = await handle(
    store,
    verifierOf(
      notification({
        transaction: { ...consumable, transactionId: '2000000000000003' },
      }),
    ),
  );
  assert.equal(conflict.status, 'conflict', 'a notification key that reversed another grant');
  assert.equal(appStoreServerNotificationHttpStatus(conflict), 200, 'is not retried by Apple');
  assert.equal(
    (await indexed.findEntitlementRevocations({ ledgerEntryIds: [conflictGrant.ledgerEntryId] }))
      .length,
    0,
  );

  assert.deepEqual(
    await handle(store, verifierOf(notification()), {
      body: { signedPayload: 'x'.repeat(256 * 1024 + 1) },
    }),
    { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' },
    'an oversized signedPayload is refused before verification',
  );
}

{
  // A refund Apple later reversed: recorded as a ledger note, never re-granted.
  const store = createInMemoryGameServicesStore();
  const grant = await grantFor(store, consumable);
  const refund = await handle(store, verifierOf(notification()));
  assert.equal(refund.status, 'revoked');
  const reversal = verifierOf(
    notification({
      notificationType: 'REFUND_REVERSED',
      notificationUUID: 'uuid-reversed-1',
    }),
  );
  const reversed = await handle(store, reversal);
  assert.deepEqual(reversed, {
    status: 'refund_reversed',
    notificationUUID: 'uuid-reversed-1',
    playerId: 'player-1',
    ledgerEntryId: grant.ledgerEntryId,
    revocationLedgerEntryId: refund.status === 'revoked' ? refund.ledgerEntryId : '',
    recorded: true,
    alreadyRecorded: false,
  });
  assert.equal(appStoreServerNotificationHttpStatus(reversed), 200, 'Apple stops retrying');
  const [note] = await store.findEntitlementNotes({ ledgerEntryIds: [grant.ledgerEntryId] });
  assert.equal(note?.noteId, 'app-store:notification:uuid-reversed-1');
  assert.equal(note?.kind, 'refund_reversed');
  assert.equal(note?.payload.appStoreNotificationType, 'REFUND_REVERSED');
  const replay = await handle(store, reversal);
  assert.equal(
    replay.status === 'refund_reversed' && replay.alreadyRecorded,
    true,
    'a redelivery keeps the first note',
  );
  assert.equal(
    (await store.findEntitlementNotes({ ledgerEntryIds: [grant.ledgerEntryId] })).length,
    1,
  );
  assert.equal(
    (await listActiveEntitlementTransactions(store, { playerId: 'player-1' })).length,
    0,
    'nothing is re-granted: the grant stays reversed until the game re-grants it',
  );

  // A store without notes still answers 200; only the host's log keeps it.
  const noteless: GameServicesStore = {
    recordEntitlementGrant: (input) => store.recordEntitlementGrant(input),
    getEntitlementTransaction: (id) => store.getEntitlementTransaction(id),
    listEntitlementTransactions: () => store.listEntitlementTransactions(),
    findEntitlementTransactionByEvidenceVerificationId: (input) =>
      store.findEntitlementTransactionByEvidenceVerificationId(input),
    findEntitlementRevocations: (input) => store.findEntitlementRevocations(input),
    recordLeaderboardScore: (input) => store.recordLeaderboardScore(input),
    getLeaderboardTransaction: (id) => store.getLeaderboardTransaction(id),
    listLeaderboardTransactions: () => store.listLeaderboardTransactions(),
  };
  const unrecorded = await handle(
    noteless,
    verifierOf(
      notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'uuid-reversed-2' }),
    ),
  );
  assert.equal(unrecorded.status === 'refund_reversed' && !unrecorded.recorded, true);
  await assert.rejects(
    store.recordEntitlementNote({
      noteId: 'orphan',
      kind: 'refund_reversed',
      playerId: 'player-1',
      ledgerEntryId: 'missing',
      recordedAt: '2026-10-24T00:00:00.000Z',
      payload: {},
    }),
    /unknown grant/u,
  );
}

console.log('App Store Server Notifications handler tests passed.');

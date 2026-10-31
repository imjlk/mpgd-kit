import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  createAppStoreGameServicesEvidenceVerifier,
  createAppStoreRevocationLookupOverBinding,
  createAppStoreSignedTransactionEvidence,
  type AppStoreRevocationLookupBinding,
  type AppStoreServerNotification,
  type AppStoreTransactionPayload,
  type EvidenceVerificationDecision,
  type VerifyPurchaseEvidenceInput,
} from '@mpgd/game-services';
import { runAppStoreRevocationRegistryConformance } from '@mpgd/game-services/app-store-verifier-conformance';
import { Miniflare } from 'miniflare';

import {
  appStoreNotificationPaths,
  createAppStoreNotificationsFetchHandler,
} from './appStoreNotificationsRoute.js';
import {
  createD1AppStoreRevocationRegistry,
  findWorkerAppStoreRevocation,
  resolveWorkerAppStoreRevocationRegistry,
} from './appStoreRevocations.js';
import { createD1GameServicesStore } from './d1Store.js';
import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'app-store-revocations', BARE: 'app-store-revocations-unmigrated' },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).sort();
  assert.equal(migrations.at(-1), '0011_app_store_revocations.sql', 'WR1 owns migration 0011');
  for (const migration of migrations) {
    await applyMigration(db, migration);
  }
  // --- 0011 applies cleanly after 0001-0010, and again (IF NOT EXISTS) -------
  await applyMigration(db, '0011_app_store_revocations.sql');
  const columns = (await db.prepare('PRAGMA table_info(app_store_revocations)')
    .all<{ name: string; pk: number }>()).results;
  assert.deepEqual(
    columns.filter((column) => column.pk === 1).map((column) => column.name),
    ['verification_id'],
    'one row per grant verification id',
  );
  assert.equal(
    columns.some((column) => column.name === 'player_id'),
    false,
    'no player id is kept (account deletion has nothing to erase here)',
  );

  // --- The same rules as the in-memory registry, across instances ------------
  const conformance = await runAppStoreRevocationRegistryConformance({
    registry: createD1AppStoreRevocationRegistry(db),
    reopen: () => createD1AppStoreRevocationRegistry(db),
  });
  assert.equal(conformance.passed, true);
  assert.equal(conformance.checks.length, 8, 'every rule, durability included');

  // Concurrent deliveries settle on the latest revocation whatever their order.
  {
    const registry = createD1AppStoreRevocationRegistry(db);
    const base = revocationRecord('concurrent', '2025-06-01T00:00:00.000Z');
    const results = await Promise.all(
      ['2025-06-01T00:00:00.000Z', '2025-06-03T00:00:00.000Z', '2025-06-02T00:00:00.000Z']
        .map((revokedAt) =>
          registry.recordRevocation({
            record: { ...base, revokedAt, notificationUUID: revokedAt },
            signal: new AbortController().signal,
          }),
        ),
    );
    assert.equal(
      (await createD1AppStoreRevocationRegistry(db).findRevocation({
        ...base,
        signal: new AbortController().signal,
      }))?.revokedAt,
      '2025-06-03T00:00:00.000Z',
    );
    assert.ok(results.some((result) => !result.alreadyRecorded));
  }

  // --- Route records, a restarted verifier refuses ---------------------------
  const bundleId = 'com.example.game';
  const appAccountToken = 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2';
  const purchaseDate = Date.parse('2025-06-10T00:00:00.000Z');
  const minute = 60_000;
  const refundedAt = purchaseDate + 10 * minute;
  const product = {
    transactionId: '2000000000000901',
    originalTransactionId: '2000000000000900',
    bundleId,
    productId: 'com.example.game.remove_ads',
    purchaseDate,
    environment: 'Production',
    type: 'Non-Consumable',
    quantity: 1,
    inAppOwnershipType: 'PURCHASED',
    appAccountToken,
  } as const satisfies Omit<AppStoreTransactionPayload, 'signedDate'>;
  const jws = new Map<string, AppStoreTransactionPayload>([
    // Signed before the refund: a client can keep it.
    ['pre-refund.jws', { ...product, signedDate: purchaseDate + minute }],
    // Signed after Apple reversed the refund: no revocationDate.
    ['post-reversal.jws', { ...product, signedDate: refundedAt + 10 * minute }],
  ]);

  let answer: AppStoreServerNotification = {
    notificationType: 'REFUND',
    notificationUUID: 'wr1-refund',
    signedDate: refundedAt + 1_000,
    environment: 'Production',
    bundleId,
    transaction: { ...product, signedDate: refundedAt + 1_000, revocationDate: refundedAt },
  };
  const env = {
    MPGD_STORE: 'd1',
    DB: db,
    GAME_SERVICES_APP_STORE_BUNDLE_ID: bundleId,
    GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY: 'true',
    GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER: {
      async verifyAppStoreServerNotification() {
        return { status: 'verified', notification: answer };
      },
    },
  } satisfies GameServicesWorkerEnv;
  const deliver = async (
    notification: AppStoreServerNotification,
    workerEnv: GameServicesWorkerEnv = env,
  ) => {
    answer = notification;
    const response = await createWorkerFetchHandler(workerEnv)(
      new Request(`https://game-services-worker.test${appStoreNotificationPaths.Production}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signedPayload: 'header.payload.signature' }),
      }),
    );
    return {
      status: response.status,
      body: await response.json() as { status: string; reason?: string },
    };
  };

  // The refund reaches the Worker before any grant: nothing to reverse, but recorded.
  const refund = answer;
  assert.deepEqual(
    pick(await deliver(refund)),
    { status: 200, outcome: 'ignored', reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND' },
    'a refund for a grant this ledger never made is acknowledged',
  );
  assert.equal(await revocationRows(db), 1, 'and recorded in D1 first');

  // A new isolate: a fresh env object, a fresh registry, the same database.
  const restarted = { ...env } satisfies GameServicesWorkerEnv;
  const verifier = createOfflineVerifier(createBindingTo(restarted), jws, {
    now: refundedAt + 20 * minute,
  });
  assertDecision(
    await verifier.verifyPurchase(purchaseInput('pre-refund.jws')),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a pre-refund JWS is refused after the restart',
  );

  // Apple reverses the refund: nothing is recorded, a fresh JWS grants again.
  assert.deepEqual(
    pick(
      await deliver({ ...refund, notificationType: 'REFUND_REVERSED', notificationUUID: 'wr1-reversed' }),
    ),
    { status: 200, outcome: 'ignored', reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND' },
  );
  const afterReversal = createOfflineVerifier(createBindingTo({ ...env }), jws, {
    now: refundedAt + 20 * minute,
  });
  assert.equal(
    (await afterReversal.verifyPurchase(purchaseInput('post-reversal.jws'))).status,
    'verified',
    'a JWS signed after the reversal grants',
  );
  assertDecision(
    await afterReversal.verifyPurchase(purchaseInput('pre-refund.jws')),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'the pre-refund JWS stays refused',
  );

  // Redeliveries (dated, and undated at the same signed time) and an older
  // notification arriving late never move the cutoff.
  const kept = await revocationRow(db);
  await deliver(refund);
  await deliver({
    ...refund,
    transaction: { ...product, signedDate: refundedAt + 1_000 },
    signedDate: refundedAt,
  });
  await deliver({
    ...refund,
    notificationType: 'REVOKE',
    notificationUUID: 'wr1-older-revoke',
    transaction: { ...product, signedDate: refundedAt, revocationDate: refundedAt - 5 * minute },
  });
  assert.deepEqual(
    await revocationRow(db),
    kept,
    'duplicates and late older notifications change nothing',
  );
  assert.equal(
    (await afterReversal.verifyPurchase(purchaseInput('post-reversal.jws'))).status,
    'verified',
    'the post-reversal JWS still grants',
  );

  // Revoked again after the reversal: the later revocation wins.
  const revokedAgainAt = refundedAt + 30 * minute;
  await deliver({
    ...refund,
    notificationType: 'REFUND',
    notificationUUID: 'wr1-refund-again',
    signedDate: revokedAgainAt + 1_000,
    transaction: { ...product, signedDate: revokedAgainAt + 1_000, revocationDate: revokedAgainAt },
  });
  assert.equal((await revocationRow(db))?.notification_uuid, 'wr1-refund-again');
  assertDecision(
    await createOfflineVerifier(createBindingTo({ ...env }), jws, {
      now: revokedAgainAt + 5 * minute,
    }).verifyPurchase(purchaseInput('post-reversal.jws')),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a JWS signed between the reversal and the second refund is refused',
  );

  // --- Off by default; refused unless the route records ----------------------
  {
    const other = {
      ...product,
      transactionId: '2000000000000951',
      originalTransactionId: '2000000000000950',
    };
    const { GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY: _flag, ...serverApiEnv } = env;
    const before = await revocationRows(db);
    await deliver(
      {
        ...refund,
        notificationUUID: 'wr1-unrecorded',
        transaction: { ...other, signedDate: refundedAt, revocationDate: refundedAt },
      },
      serverApiEnv,
    );
    assert.equal(await revocationRows(db), before, 'without the flag the route records nothing');
    assert.equal(resolveWorkerAppStoreRevocationRegistry(serverApiEnv), undefined);
    await assert.rejects(
      findWorkerAppStoreRevocation(serverApiEnv, lookupRequest('x')),
      /APP_STORE_REVOCATIONS_NOT_CONFIGURED/u,
    );
    const { GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER: _route, ...withoutRoute } = env;
    await assert.rejects(
      findWorkerAppStoreRevocation(withoutRoute, lookupRequest('x')),
      /APP_STORE_REVOCATIONS_NOT_CONFIGURED/u,
      'a registry nothing fills is not served: it would answer absent for every refund',
    );
    await assert.rejects(
      findWorkerAppStoreRevocation(
        { ...env, GAME_SERVICES_APP_STORE_BUNDLE_ID: ' ' },
        lookupRequest('x'),
      ),
      /APP_STORE_REVOCATIONS_NOT_CONFIGURED/u,
    );
    assertDecision(
      await createOfflineVerifier(createBindingTo(serverApiEnv), jws, {
        now: refundedAt + 20 * minute,
      }).verifyPurchase(purchaseInput('post-reversal.jws')),
      'pending',
      'APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE',
      'a verifier bound to an unconfigured registry never grants',
    );
  }

  // --- Missing migration or outage: Apple redelivers, purchases stay pending --
  {
    const bare = await miniflare.getD1Database('BARE') as unknown as D1Database;
    await applyMigration(bare, '0001_game_services.sql');
    const route = createAppStoreNotificationsFetchHandler({
      store: createD1GameServicesStore(bare),
      binding: env.GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER,
      bundleId,
      revocations: createD1AppStoreRevocationRegistry(bare),
    });
    answer = refund;
    const response = await route(
      new Request(`https://game-services-worker.test${appStoreNotificationPaths.Production}`, {
        method: 'POST',
        body: JSON.stringify({ signedPayload: 'header.payload.signature' }),
      }),
    );
    assert.ok(response !== undefined, 'the route answers its path');
    assert.equal(response.status, 503, 'a refund the registry cannot keep is redelivered by Apple');
    assert.equal(
      (await response.json() as { reason: string }).reason,
      'APP_STORE_REVOCATION_REGISTRY_UNAVAILABLE',
    );
    assertDecision(
      await createOfflineVerifier(createBindingTo({ ...env, DB: bare }), jws, {
        now: refundedAt + 20 * minute,
      }).verifyPurchase(purchaseInput('post-reversal.jws')),
      'pending',
      'APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE',
      'a registry read that fails keeps the purchase pending',
    );
  }

  console.log('app store revocation registry (D1) tests passed');

  function purchaseInput(signedTransaction: string): VerifyPurchaseEvidenceInput {
    return {
      request: {
        target: 'ios',
        playerId: 'ios-player',
        productId: 'REMOVE_ADS',
        platformTransactionId: product.transactionId,
        idempotencyKey: `restore-${signedTransaction}`,
        purchasedAt: new Date(purchaseDate).toISOString(),
        evidence: createAppStoreSignedTransactionEvidence({
          signedTransaction,
          transactionId: product.transactionId,
        }),
      },
      product: {
        id: 'REMOVE_ADS',
        type: 'non_consumable',
        grant: { type: 'currency', currency: 'coin', amount: 1 },
        platformProductIds: { ios: product.productId },
      },
      platformProductId: product.productId,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    };
  }

  function createOfflineVerifier(
    binding: AppStoreRevocationLookupBinding,
    signed: ReadonlyMap<string, AppStoreTransactionPayload>,
    options: { readonly now: number },
  ) {
    return createAppStoreGameServicesEvidenceVerifier({
      bundleId,
      environment: 'Production',
      serverApi: {
        async getTransactionInfo() {
          throw new Error('offline-only never calls the Server API');
        },
      },
      signedTransactionVerifier: {
        async verifyAndDecode({ signedTransaction }) {
          const payload = signed.get(signedTransaction);
          return payload === undefined
            ? { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' }
            : { status: 'verified', payload };
        },
      },
      resolveAppAccountToken: () => appAccountToken,
      now: () => new Date(options.now).toISOString(),
      signedTransactionEvidence: {
        mode: 'offline-only',
        maxSignedAgeMs: 60 * minute,
        revocations: createAppStoreRevocationLookupOverBinding(binding),
      },
    });
  }
} finally {
  await miniflare.dispose();
}

/**
 * The iOS verifier Worker's `GAME_SERVICES_APP_STORE_REVOCATIONS` binding to
 * the `GameServicesAppStoreRevocations` entrypoint: arguments and answers are
 * structured-cloned as a service binding does (an AbortSignal would throw).
 */
function createBindingTo(env: GameServicesWorkerEnv): AppStoreRevocationLookupBinding {
  return {
    async findAppStoreRevocation(input) {
      return structuredClone(await findWorkerAppStoreRevocation(env, structuredClone(input)));
    },
  };
}

function revocationRecord(name: string, revokedAt: string) {
  return {
    verificationId: `wr1-${name}`,
    environment: 'Production',
    bundleId: 'com.example.game',
    transactionId: name,
    originalTransactionId: name,
    productId: 'com.example.game.coins100',
    reason: 'refund',
    revokedAt,
    notificationType: 'REFUND',
    notificationUUID: name,
  } as const;
}

function lookupRequest(verificationId: string) {
  return {
    verificationId,
    environment: 'Production',
    bundleId: 'com.example.game',
    transactionId: verificationId,
    originalTransactionId: verificationId,
  } as const;
}

function pick(result: { readonly status: number; readonly body: { status: string; reason?: string } }) {
  return { status: result.status, outcome: result.body.status, reason: result.body.reason };
}

function assertDecision(
  decision: EvidenceVerificationDecision,
  status: string,
  reason: string,
  message: string,
): void {
  assert.equal(decision.status, status, message);
  assert.equal('reason' in decision ? decision.reason : undefined, reason, message);
}

async function revocationRows(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM app_store_revocations WHERE transaction_id LIKE ?')
    .bind('20000000000009%')
    .first<{ n: number }>())?.n ?? 0;
}

async function revocationRow(db: D1Database) {
  return db.prepare(
    `SELECT verification_id, revoked_at, revoked_at_ms, notification_type, notification_uuid, recorded_at
       FROM app_store_revocations WHERE transaction_id = ? OR original_transaction_id = ?`,
  ).bind('2000000000000900', '2000000000000900').first<Record<string, unknown>>();
}

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const sql = (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  // Statements end at `;`, except inside a trigger body (BEGIN ... END;).
  let pending = '';
  for (const piece of sql.split(';')) {
    pending = pending.length === 0 ? piece : `${pending};${piece}`;
    const statement = pending.trim();
    if (statement.length === 0) {
      pending = '';
      continue;
    }
    if (/\bCREATE\s+TRIGGER\b/iu.test(statement) && !/\bEND$/iu.test(statement)) {
      continue;
    }
    await db.prepare(statement).run();
    pending = '';
  }
}

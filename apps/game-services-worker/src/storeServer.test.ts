import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createAppStoreVerificationId,
  createGameServicesBackend,
  createGooglePlayProductPurchaseBoundary,
  findEntitlementRevocationsChunked,
  googlePlayProductPurchaseEvidenceSchema,
  type AppStoreServerNotification,
  type GooglePlayProductPurchaseClient,
  type GooglePlayVoidedPurchasesClient,
  type PurchaseGrantFinalization,
} from '@mpgd/game-services';
import { createGooglePlayProductPurchaseConformanceFixture } from '@mpgd/game-services/google-play-purchase-conformance';
import { Miniflare } from 'miniflare';

import { appStoreNotificationPaths } from './appStoreNotificationsRoute.js';
import { createD1GameServicesStore } from './d1Store.js';
import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';
import { runScheduledStoreServer, voidedSweepCursor } from './storeServerCron.js';
import {
  createD1GooglePlayFinalizationOutbox,
  createD1StoreServerCursors,
  googlePlayAcknowledgementWindowMs,
  withGooglePlayFinalizationOutbox,
} from './storeServerD1.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'store-server' },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const migration of [
    '0001_game_services.sql',
    '0004_entitlement_evidence.sql',
    '0006_entitlement_revocations.sql',
    '0009_store_server.sql',
  ]) {
    await applyMigration(db, migration);
  }
  const store = createD1GameServicesStore(db);
  const baseUrl = 'https://game-services-worker.test';

  // --- App Store Server Notifications V2 route --------------------------------
  {
    const bundleId = 'com.example.game';
    const transaction = {
      transactionId: '2000000000000777',
      originalTransactionId: '2000000000000777',
      bundleId,
      productId: 'com.mpgd.game.coins100',
      purchaseDate: Date.parse('2026-10-20T00:00:00.000Z'),
      signedDate: Date.parse('2026-10-24T00:00:00.000Z'),
      environment: 'Production' as const,
      type: 'Consumable' as const,
      revocationDate: Date.parse('2026-10-24T00:00:00.000Z'),
    };
    const grant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'ios-player',
      grantId: 'COINS_100',
      idempotencyKey: 'ios-checkout',
      grantedAt: '2026-10-20T00:00:01.000Z',
      evidenceVerificationId: createAppStoreVerificationId({
        environment: 'Production',
        bundleId,
        transactionId: transaction.transactionId,
      }),
      payload: { target: 'ios', store: 'app-store' },
    });
    let answer: AppStoreServerNotification | 'unavailable' | 'rejected' = {
      notificationType: 'REFUND',
      notificationUUID: 'worker-refund-1',
      signedDate: transaction.signedDate,
      environment: 'Production',
      bundleId,
      transaction,
    };
    const seen: { environment: string; timeoutMs: number }[] = [];
    const env = {
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_APP_STORE_BUNDLE_ID: bundleId,
      GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER: {
        async verifyAppStoreServerNotification(input) {
          seen.push({ environment: input.environment, timeoutMs: input.timeoutMs });
          if (answer === 'unavailable') {
            return { status: 'unavailable' };
          }
          if (answer === 'rejected') {
            return { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' };
          }
          return { status: 'verified', notification: answer };
        },
      },
    } satisfies GameServicesWorkerEnv;
    const workerFetch = createWorkerFetchHandler(env);
    const post = (path: string, body: string) => workerFetch(
      new Request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    const payload = JSON.stringify({ signedPayload: 'signed-payload' });

    const refunded = await post(appStoreNotificationPaths.Production, payload);
    assert.equal(refunded.status, 200, 'a verified refund is answered 200');
    assert.equal((await refunded.json() as { status: string }).status, 'revoked');
    assert.deepEqual(seen[0], { environment: 'Production', timeoutMs: 10_000 });
    const [revocation] = await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId]);
    assert.equal(revocation?.reason, 'refund', 'the D1 ledger holds the revoke entry');
    const redelivered = await post(`${appStoreNotificationPaths.Production}/`, payload);
    assert.equal(redelivered.status, 200, 'a trailing slash is the same route');
    assert.deepEqual(
      await redelivered.json(),
      {
        status: 'revoked',
        notificationUUID: 'worker-refund-1',
        ledgerEntryId: revocation?.ledgerEntryId,
        alreadyProcessed: true,
      },
      'a redelivery answers the first entry',
    );

    const sandboxUrl = await post(appStoreNotificationPaths.Sandbox, payload);
    assert.equal(sandboxUrl.status, 400, 'a production notification on the sandbox URL is refused');
    assert.equal(seen.at(-1)?.environment, 'Sandbox', 'the sandbox URL verifies in the sandbox');

    answer = 'unavailable';
    assert.equal(
      (await post(appStoreNotificationPaths.Production, payload)).status,
      503,
      'a verifier outage asks Apple to redeliver',
    );
    answer = 'rejected';
    assert.equal((await post(appStoreNotificationPaths.Production, payload)).status, 400);
    assert.equal((await post(appStoreNotificationPaths.Production, '{not json')).status, 400);
    assert.equal(
      (await workerFetch(new Request(`${baseUrl}${appStoreNotificationPaths.Production}`))).status,
      405,
      'only POST is accepted',
    );
    assert.equal(
      (await post(appStoreNotificationPaths.Production, 'x'.repeat(300 * 1024))).status,
      413,
    );

    assert.throws(
      () =>
        createWorkerFetchHandler({
          ...env,
          GAME_SERVICES_APP_STORE_BUNDLE_ID: ' ',
        }),
      /GAME_SERVICES_APP_STORE_BUNDLE_ID/u,
      'the verifier binding requires the bundle id',
    );
    const withoutBinding = createWorkerFetchHandler({ MPGD_STORE: 'memory' });
    assert.equal(
      (await withoutBinding(new Request(`${baseUrl}${appStoreNotificationPaths.Production}`, {
        method: 'POST',
        body: payload,
      }))).status,
      404,
      'the route is not mounted without its binding',
    );
  }

  // --- Finalization outbox -------------------------------------------------------
  const outbox = createD1GooglePlayFinalizationOutbox(db);
  {
    const ledgerGrant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'outbox-player',
      grantId: 'COINS_100',
      idempotencyKey: 'outbox-checkout',
      grantedAt: '2026-10-24T00:00:00.000Z',
      payload: { target: 'android' },
    });
    let next: PurchaseGrantFinalization | Error = {
      status: 'pending',
      action: 'consume',
      alreadyCompleted: false,
      reason: 'GOOGLE_PLAY_UNAVAILABLE',
    };
    const wrapped = withGooglePlayFinalizationOutbox(
      {
        async finalizePurchaseGrant() {
          if (next instanceof Error) {
            throw next;
          }
          return next;
        },
      },
      outbox,
      () => 1_000_000,
    );
    const input = {
      request: {
        target: 'android' as const,
        playerId: 'outbox-player',
        productId: 'COINS_100',
        platformTransactionId: 'GPA.outbox',
        idempotencyKey: 'outbox-checkout',
        purchasedAt: '2026-10-24T00:00:00.000Z',
        evidence: {
          schema: googlePlayProductPurchaseEvidenceSchema,
          payload: { purchaseToken: 'outbox-token' },
        },
      },
      product: {
        id: 'COINS_100',
        type: 'consumable' as const,
        grant: { type: 'currency' as const, currency: 'coin', amount: 100 },
        platformProductIds: { android: 'coins_100' },
      },
      platformProductId: 'coins_100',
      evidenceVerificationId: 'google-play:product:outbox',
      ledgerEntryId: ledgerGrant.ledgerEntryId,
      alreadyProcessed: false,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    };
    await wrapped.finalizePurchaseGrant(input);
    const [pending] = await outbox.due({ nowMs: 2_000_000, limit: 10 });
    assert.equal(pending?.purchaseToken, 'outbox-token', 'a pending finalization keeps its token');
    assert.equal(pending?.attempts, 1);
    assert.equal(pending?.nextAttemptAtMs, 1_000_000 + 60_000, 'the first retry is a minute later');
    assert.equal(pending?.lastReason, 'GOOGLE_PLAY_UNAVAILABLE');
    assert.equal((await outbox.due({ nowMs: 1_000_000, limit: 10 })).length, 0, 'not due yet');

    next = new Error('provider defect');
    await assert.rejects(wrapped.finalizePurchaseGrant(input), /provider defect/u);
    const [afterError] = await outbox.due({ nowMs: 99_999_999, limit: 10 });
    assert.equal(afterError?.attempts, 2, 'a thrown finalizer is deferred and rethrown');
    assert.equal(afterError?.nextAttemptAtMs, 1_000_000 + 300_000, 'the second retry backs off');

    next = { status: 'completed', action: 'consume', alreadyCompleted: false };
    await wrapped.finalizePurchaseGrant(input);
    assert.equal(
      (await outbox.due({ nowMs: 99_999_999, limit: 10 })).length,
      0,
      'a completed finalization drops the token',
    );
  }

  // --- The store server cron -----------------------------------------------------
  {
    const packageName = 'com.example.game';
    const purchaseToken = 'cron-token';
    const response = createGooglePlayProductPurchaseConformanceFixture({ orderId: 'GPA.cron-1' });
    let consumeFails = true;
    const playClient: GooglePlayProductPurchaseClient = {
      async getProductPurchaseV2() {
        return structuredClone(response);
      },
      async acknowledgeProductPurchase() {
        throw new Error('unexpected acknowledge');
      },
      async consumeProductPurchase() {
        if (consumeFails) {
          throw new Error('Play is unavailable');
        }
        const [lineItem] = response.productLineItem as {
          productOfferDetails: Record<string, unknown>;
        }[];
        if (lineItem !== undefined) {
          lineItem.productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
        }
      },
    };
    const boundary = createGooglePlayProductPurchaseBoundary({
      client: playClient,
      packageName,
      allowUnboundAuthenticatedPlayer: true,
    });
    const backend = createGameServicesBackend({
      catalog: {
        version: 'store-server',
        products: [{
          id: 'COINS_100',
          type: 'consumable',
          grant: { type: 'currency', currency: 'coin', amount: 100 },
          platformProductIds: { android: 'coins_100_android' },
        }],
      },
      placements: { version: 'store-server', placements: [] },
      store,
      evidenceVerifier: {
        verifyPurchase: (input) => boundary.verifyPurchase(input),
        verifyAdReward: async () => ({ status: 'rejected', reason: 'unsupported' }),
      },
      // The Worker composition: the boundary behind the D1 outbox.
      purchaseGrantFinalizer: withGooglePlayFinalizationOutbox(boundary, outbox),
    });
    const verified = await backend.purchases.verifyPurchase({
      target: 'android',
      playerId: 'cron-player',
      productId: 'COINS_100',
      platformTransactionId: 'GPA.cron-1',
      idempotencyKey: 'cron-checkout',
      purchasedAt: '2026-10-24T00:00:00.000Z',
      evidence: { schema: googlePlayProductPurchaseEvidenceSchema, payload: { purchaseToken } },
    });
    assert.equal(verified.finalization?.status, 'pending', 'the client went away before consume');

    const voidedCalls: { startTimeMillis: number; endTimeMillis: number }[] = [];
    let voided: readonly { purchaseToken: string; voidedReason?: number }[] = [];
    const voidedPurchases: GooglePlayVoidedPurchasesClient = {
      async listVoidedPurchases(input) {
        voidedCalls.push({
          startTimeMillis: input.startTimeMillis,
          endTimeMillis: input.endTimeMillis,
        });
        return { voidedPurchases: voided };
      },
    };
    const dependencies = (nowMs: number) => ({
      googlePlay: { finalizer: boundary, voidedPurchases, packageName },
      now: () => nowMs,
    });
    const cronEnv = { MPGD_STORE: 'd1' as const, DB: db };
    const start = Date.now();

    consumeFails = false;
    const first = await runScheduledStoreServer(
      cronEnv,
      { cron: '* * * * *' },
      dependencies(start + 120_000),
    );
    assert.equal(first?.retried, 1, 'the owed consume is retried');
    assert.equal(first?.finalized, 1, 'and completes on the server');
    assert.equal(
      (await outbox.due({ nowMs: Number.MAX_SAFE_INTEGER, limit: 10 })).length,
      0,
      'a finalized purchase leaves the outbox',
    );
    assert.equal(first?.sweep?.complete, true, 'the first sweep reads the whole window');
    assert.equal(voidedCalls.length, 1);
    assert.equal(
      await createD1StoreServerCursors(db).read(voidedSweepCursor),
      start + 120_000,
      'a complete sweep advances its cursor',
    );

    const soon = await runScheduledStoreServer(
      cronEnv,
      { cron: '* * * * *' },
      dependencies(start + 180_000),
    );
    assert.equal(soon?.sweep, undefined, 'the sweep keeps its own interval');

    voided = [{ purchaseToken, voidedReason: 1 }, { purchaseToken: 'never-granted' }];
    const later = await runScheduledStoreServer(
      cronEnv,
      { cron: '* * * * *' },
      dependencies(start + 120_000 + 3_600_000),
    );
    assert.deepEqual(later?.sweep, {
      complete: true,
      revoked: 1,
      alreadyProcessed: 0,
      notFound: 1,
      failed: 0,
    });
    assert.equal(
      voidedCalls.at(-1)?.startTimeMillis,
      start + 120_000 - 15 * 60 * 1000,
      'a later sweep overlaps the last complete window',
    );
    assert.equal(
      (await findEntitlementRevocationsChunked(store, [verified.ledgerEntryId ?? '']))[0]
        ?.reason,
      'voided',
      'the voided purchase is revoked in D1',
    );

    // An owed finalization older than Play's window is dropped, not retried.
    const stale = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'stale-player',
      grantId: 'COINS_100',
      idempotencyKey: 'stale-checkout',
      grantedAt: '2026-10-01T00:00:00.000Z',
      payload: { target: 'android' },
    });
    await outbox.remember({
      ledgerEntryId: stale.ledgerEntryId,
      playerId: 'stale-player',
      purchaseToken: 'stale-token',
      nowMs: start,
    });
    const expired = await runScheduledStoreServer(
      { ...cronEnv, MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES: '0' },
      { cron: '* * * * *' },
      dependencies(start + googlePlayAcknowledgementWindowMs + 1),
    );
    assert.equal(expired?.abandoned, 1, 'the window passed: Google refunds, the sweep revokes');
    assert.equal(expired?.sweep, undefined, 'a zero interval turns the sweep off');

    const starved = await runScheduledStoreServer(
      { ...cronEnv, MPGD_STORE_SERVER_SUBREQUEST_BUDGET: '1' },
      { cron: '* * * * *' },
      dependencies(start + 10 * 3_600_000),
    );
    assert.equal(starved?.operations, 1, 'the run stops at its subrequest budget');
    assert.equal(starved?.sweep, undefined);

    assert.equal(
      await runScheduledStoreServer({ MPGD_STORE: 'memory' }, {}, dependencies(start)),
      undefined,
      'without D1 there is nothing durable to work on',
    );
    assert.equal(await runScheduledStoreServer(cronEnv, {}, {}), undefined, 'nor without Play');
  }
} finally {
  await miniflare.dispose();
}

console.log('Store server Worker tests passed.');

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  await db.exec(toD1ExecScript(migration));
}

function toD1ExecScript(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`)
    .join('\n');
}

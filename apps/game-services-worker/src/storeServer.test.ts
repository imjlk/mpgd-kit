import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createAppStoreVerificationId,
  createGameServicesBackend,
  createGooglePlayProductPurchaseBoundary,
  createGooglePlayProductVerificationId,
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
    const payload = JSON.stringify({ signedPayload: 'header.payload.signature' });

    const callsBefore = seen.length;
    assert.equal(
      (await post(appStoreNotificationPaths.Production, JSON.stringify({ signedPayload: 'not-a-jws' })))
        .status,
      400,
      'a payload that is not a compact JWS is refused',
    );
    assert.equal(seen.length, callsBefore, 'before the verifier binding runs');
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

    // Apple reverses the refund: kept as a D1 ledger note, answered 200, no re-grant.
    const refundAnswer = answer;
    answer = { ...refundAnswer, notificationType: 'REFUND_REVERSED', notificationUUID: 'worker-reversed-1' };
    const reversed = await post(appStoreNotificationPaths.Production, payload);
    assert.equal(reversed.status, 200);
    assert.deepEqual(
      await reversed.json(),
      {
        status: 'refund_reversed',
        notificationUUID: 'worker-reversed-1',
        recorded: true,
        alreadyRecorded: false,
      },
      'the answer to Apple names no player or grant',
    );
    const reversedAgain = await post(appStoreNotificationPaths.Production, payload);
    assert.equal(
      (await reversedAgain.json() as { alreadyRecorded: boolean }).alreadyRecorded,
      true,
      'a redelivered reversal keeps one note',
    );
    const notes = await store.findEntitlementNotes?.({ ledgerEntryIds: [grant.ledgerEntryId] }) ?? [];
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.revocationLedgerEntryId, revocation?.ledgerEntryId);
    assert.equal(
      (await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId])).length,
      1,
      'the grant stays revoked',
    );
    // A reversal for a grant that is not revoked yet asks Apple to redeliver.
    await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'ios-player',
      grantId: 'COINS_100',
      idempotencyKey: 'ios-checkout-2',
      grantedAt: '2026-10-20T00:00:01.000Z',
      evidenceVerificationId: createAppStoreVerificationId({
        environment: 'Production',
        bundleId,
        transactionId: '2000000000000778',
      }),
      payload: { target: 'ios', store: 'app-store' },
    });
    answer = {
      ...refundAnswer,
      notificationType: 'REFUND_REVERSED',
      notificationUUID: 'worker-reversed-early',
      transaction: { ...transaction, transactionId: '2000000000000778', originalTransactionId: '2000000000000778' },
    };
    assert.equal(
      (await post(appStoreNotificationPaths.Production, payload)).status,
      503,
      'a reversal before its refund is redelivered by Apple',
    );
    answer = refundAnswer;

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

    const withoutBundle = createWorkerFetchHandler({
      ...env,
      MPGD_STORE: 'memory',
      GAME_SERVICES_APP_STORE_BUNDLE_ID: ' ',
    });
    assert.equal(
      (await withoutBundle(new Request(`${baseUrl}${appStoreNotificationPaths.Production}`, {
        method: 'POST',
        body: payload,
      }))).status,
      404,
      'without the bundle id only the App Store intake is closed',
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
      'com.example.game',
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
      evidenceVerificationId: await createGooglePlayProductVerificationId(
        'com.example.game',
        'outbox-token',
      ),
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

    const otherGrant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'outbox-player',
      grantId: 'COINS_100',
      idempotencyKey: 'outbox-replay',
      grantedAt: '2026-10-24T00:00:00.000Z',
      payload: { target: 'android' },
    });
    await wrapped.finalizePurchaseGrant({
      ...input,
      ledgerEntryId: otherGrant.ledgerEntryId,
      request: {
        ...input.request,
        evidence: { ...input.request.evidence, payload: { purchaseToken: 'bogus-token' } },
      },
    }).catch(() => undefined);
    assert.equal(
      (await outbox.due({ nowMs: 99_999_999, limit: 10 }))
        .some((row) => row.ledgerEntryId === otherGrant.ledgerEntryId),
      false,
      'a token that is not the grant\u2019s own is never kept',
    );

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
      purchaseGrantFinalizer: withGooglePlayFinalizationOutbox(boundary, outbox, packageName),
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
    assert.equal(first?.sweep?.slices, 5, 'in week-long slices');
    assert.equal(voidedCalls.length, 5);
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
      slices: 1,
      revoked: 1,
      alreadyProcessed: 0,
      notFound: 1,
      failed: 0,
      errored: 0,
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
    assert.equal(
      starved?.operations,
      0,
      'nothing fits in a budget of one: retries get half (0), the sweep needs 5',
    );
    assert.equal(starved?.sweep, undefined);

    // A backlog larger than one run's budget is worked through across runs.
    {
      await db.exec('DELETE FROM store_server_cursors;');
      const backlogNow = start + 40 * 24 * 3_600_000;
      const voids = Array.from({ length: 30 }, (_, index) => ({
        purchaseToken: `backlog-${index}`,
        recordedAt: backlogNow - (index + 1) * 23 * 3_600_000,
      }));
      const seen = new Set<string>();
      const backlogClient: GooglePlayVoidedPurchasesClient = {
        async listVoidedPurchases(input) {
          const page = voids.filter((entry) =>
            entry.recordedAt >= input.startTimeMillis && entry.recordedAt <= input.endTimeMillis);
          for (const entry of page) {
            seen.add(entry.purchaseToken);
          }
          return { voidedPurchases: page.map(({ purchaseToken }) => ({ purchaseToken })) };
        },
      };
      let runs = 0;
      let lastSweep: Awaited<ReturnType<typeof runScheduledStoreServer>>;
      do {
        runs += 1;
        lastSweep = await runScheduledStoreServer(
          { ...cronEnv, MPGD_STORE_SERVER_SUBREQUEST_BUDGET: '30' },
          { cron: '* * * * *' },
          {
            googlePlay: { finalizer: boundary, voidedPurchases: backlogClient, packageName },
            now: () => backlogNow + runs * 60_000,
          },
        );
      } while (lastSweep?.sweep?.complete !== true && runs < 40);
      assert.equal(lastSweep?.sweep?.complete, true, 'the backlog converges');
      assert.equal(seen.size, 30, 'every void in Google\u2019s window is read');
      assert.equal(runs > 1, true, 'over several runs');
      assert.equal(
        await createD1StoreServerCursors(db).read('google-play-voided:slice-ms'),
        7 * 24 * 3_600_000,
        'the slice grows back once caught up',
      );
    }

    // With the smallest slice the cursor still only moves forward, and a run
    // stopped before reading anything does not shrink the slice.
    {
      const cursors = createD1StoreServerCursors(db);
      const behindNow = start + 50 * 24 * 3_600_000;
      await cursors.write(voidedSweepCursor, behindNow - 2 * 3_600_000, new Date(behindNow));
      await cursors.write('google-play-voided:slice-ms', 60_000, new Date(behindNow));
      const emptyClient: GooglePlayVoidedPurchasesClient = {
        async listVoidedPurchases() {
          return { voidedPurchases: [] };
        },
      };
      let previous = await cursors.read(voidedSweepCursor) ?? 0;
      let runs = 0;
      let result: Awaited<ReturnType<typeof runScheduledStoreServer>>;
      do {
        runs += 1;
        result = await runScheduledStoreServer(
          { ...cronEnv, MPGD_STORE_SERVER_SUBREQUEST_BUDGET: '20' },
          { cron: '* * * * *' },
          {
            googlePlay: { finalizer: boundary, voidedPurchases: emptyClient, packageName },
            now: () => behindNow + runs * 60_000,
          },
        );
        const cursor = await cursors.read(voidedSweepCursor) ?? 0;
        assert.equal(cursor >= previous, true, 'the cursor never moves back');
        previous = cursor;
      } while (result?.sweep?.complete !== true && runs < 40);
      assert.equal(result?.sweep?.complete, true, 'one-minute slices still converge');

      await cursors.write(voidedSweepCursor, behindNow - 3 * 3_600_000, new Date(behindNow));
      await cursors.write('google-play-voided:slice-ms', 3_600_000, new Date(behindNow));
      // The retries' due read (1) and the sweep's opening reads (5), not a page (2 more).
      const starvedSweep = await runScheduledStoreServer(
        { ...cronEnv, MPGD_STORE_SERVER_SUBREQUEST_BUDGET: '6' },
        { cron: '* * * * *' },
        {
          googlePlay: { finalizer: boundary, voidedPurchases: emptyClient, packageName },
          now: () => behindNow,
        },
      );
      assert.equal(starvedSweep?.sweep?.complete, false);
      assert.equal(
        await cursors.read('google-play-voided:slice-ms'),
        3_600_000,
        'a run that read nothing keeps its slice',
      );
      await cursors.write('google-play-voided:slice-ms', -5, new Date(behindNow));
      const clampedSlice = await runScheduledStoreServer(
        { ...cronEnv, MPGD_STORE_SERVER_SUBREQUEST_BUDGET: '40' },
        { cron: '* * * * *' },
        {
          googlePlay: { finalizer: boundary, voidedPurchases: emptyClient, packageName },
          now: () => behindNow,
        },
      );
      assert.equal(
        (clampedSlice?.sweep?.slices ?? 0) > 0,
        true,
        'an invalid stored slice is clamped, never a zero-length loop',
      );
    }

    // One void that always fails cannot hold every later one back.
    {
      const cursors = createD1StoreServerCursors(db);
      const stallNow = start + 60 * 24 * 3_600_000;
      await cursors.write(voidedSweepCursor, stallNow - 10 * 60_000, new Date(stallNow));
      await cursors.write('google-play-voided:behind', 0, new Date(stallNow));
      await cursors.write('google-play-voided:stalls', 0, new Date(stallNow));
      await cursors.write('google-play-voided:slice-ms', 7 * 24 * 3_600_000, new Date(stallNow));
      const poisonRecordedAt = stallNow - 5 * 60_000;
      const poisonClient: GooglePlayVoidedPurchasesClient = {
        async listVoidedPurchases(input) {
          return {
            voidedPurchases: input.startTimeMillis <= poisonRecordedAt
                && poisonRecordedAt <= input.endTimeMillis
              ? [{ purchaseToken, orderId: 'GPA.poison' }]
              : [],
          };
        },
      };
      // Every revocation write fails while the table is away: a store error
      // on the same void, run after run.
      await db.exec('ALTER TABLE entitlement_revocations RENAME TO entitlement_revocations_away;');
      let stallRuns = 0;
      let stallResult: Awaited<ReturnType<typeof runScheduledStoreServer>>;
      do {
        stallRuns += 1;
        stallResult = await runScheduledStoreServer(
          { ...cronEnv, MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES: '1' },
          { cron: '* * * * *' },
          {
            googlePlay: { finalizer: boundary, voidedPurchases: poisonClient, packageName },
            now: () => stallNow + stallRuns * 60_000,
          },
        );
      } while (stallResult?.sweep?.complete !== true && stallRuns < 40);
      await db.exec('ALTER TABLE entitlement_revocations_away RENAME TO entitlement_revocations;');
      assert.equal(stallResult?.sweep?.complete, true, 'the sweep moves past the poisoned slice');
      assert.equal(stallRuns, 30, 'after 30 runs held back by the same store error');
    }

    // A void in the overlap whose revocation failed is read again on the
    // next run, which starts before the cursor.
    {
      const cursors = createD1StoreServerCursors(db);
      const overlapNow = start + 65 * 24 * 3_600_000;
      const lastEnd = overlapNow - 61 * 60_000;
      await cursors.write(voidedSweepCursor, lastEnd, new Date(overlapNow));
      await cursors.write('google-play-voided:behind', 0, new Date(overlapNow));
      await cursors.write('google-play-voided:stalls', 0, new Date(overlapNow));
      const lateGrant = await store.recordEntitlementGrant({
        source: 'purchase',
        playerId: 'late-player',
        grantId: 'COINS_100',
        idempotencyKey: 'late-checkout',
        grantedAt: '2026-10-01T00:00:00.000Z',
        evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, 'late-token'),
        payload: { target: 'android' },
      });
      const recordedAt = lastEnd - 5 * 60_000;
      const lateClient: GooglePlayVoidedPurchasesClient = {
        async listVoidedPurchases(input) {
          return {
            voidedPurchases: input.startTimeMillis <= recordedAt && recordedAt <= input.endTimeMillis
              ? [{ purchaseToken: 'late-token', orderId: 'GPA.late' }]
              : [],
          };
        },
      };
      const run = (atMs: number) => runScheduledStoreServer(
        cronEnv,
        { cron: '* * * * *' },
        {
          googlePlay: { finalizer: boundary, voidedPurchases: lateClient, packageName },
          now: () => atMs,
        },
      );
      await db.exec('ALTER TABLE entitlement_revocations RENAME TO entitlement_revocations_away;');
      const failed = await run(overlapNow);
      await db.exec('ALTER TABLE entitlement_revocations_away RENAME TO entitlement_revocations;');
      assert.equal(failed?.sweep?.errored, 1);
      assert.equal(await cursors.read('google-play-voided:behind'), 1);
      const retried = await run(overlapNow + 60_000);
      assert.equal(retried?.sweep?.revoked, 1, 'the next run reads the overlap again');
      assert.equal(
        (await findEntitlementRevocationsChunked(store, [lateGrant.ledgerEntryId])).length,
        1,
      );
    }

    // A dense overlap (more voids than one run can apply) is split across
    // runs: the re-read resumes where it got and the cursor never moves back.
    {
      const cursors = createD1StoreServerCursors(db);
      const denseNow = start + 75 * 24 * 3_600_000;
      const lastEnd = denseNow - 61 * 60_000;
      await cursors.write(voidedSweepCursor, lastEnd, new Date(denseNow));
      await cursors.write('google-play-voided:behind', 0, new Date(denseNow));
      await cursors.write('google-play-voided:slice-ms', 7 * 24 * 3_600_000, new Date(denseNow));
      const dense = Array.from({ length: 60 }, (_, index) => ({
        purchaseToken: `dense-${index}`,
        recordedAt: lastEnd - 14 * 60_000 + index * 14_000,
      }));
      const seen = new Set<string>();
      const denseClient: GooglePlayVoidedPurchasesClient = {
        async listVoidedPurchases(input) {
          const page = dense.filter((entry) =>
            entry.recordedAt >= input.startTimeMillis && entry.recordedAt <= input.endTimeMillis);
          for (const entry of page) {
            seen.add(entry.purchaseToken);
          }
          return { voidedPurchases: page.map(({ purchaseToken }) => ({ purchaseToken })) };
        },
      };
      let runs = 0;
      let previous = lastEnd;
      let result: Awaited<ReturnType<typeof runScheduledStoreServer>>;
      do {
        runs += 1;
        result = await runScheduledStoreServer(
          cronEnv,
          { cron: '* * * * *' },
          {
            googlePlay: { finalizer: boundary, voidedPurchases: denseClient, packageName },
            now: () => denseNow + runs * 60_000,
          },
        );
        const cursor = await cursors.read(voidedSweepCursor) ?? 0;
        assert.equal(cursor >= previous, true, 'the cursor never moves back');
        previous = cursor;
      } while (result?.sweep?.complete !== true && runs < 40);
      assert.equal(result?.sweep?.complete, true, 'a dense overlap no longer blocks the sweep');
      assert.equal(seen.size, 60, 'every void in the overlap is read');
    }

    // A cursor ahead of the clock (a clock step back) completes and stays put.
    {
      const cursors = createD1StoreServerCursors(db);
      const skewNow = start + 80 * 24 * 3_600_000;
      const ahead = skewNow + 30 * 60_000;
      await cursors.write(voidedSweepCursor, ahead, new Date(skewNow));
      await cursors.write('google-play-voided:behind', 2, new Date(skewNow));
      const skewed = await runScheduledStoreServer(
        cronEnv,
        { cron: '* * * * *' },
        {
          googlePlay: {
            finalizer: boundary,
            voidedPurchases: {
              async listVoidedPurchases() {
                return { voidedPurchases: [] };
              },
            },
            packageName,
          },
          now: () => skewNow,
        },
      );
      assert.equal(skewed?.sweep?.complete, true, 'nothing newer than the clock to read');
      assert.equal(await cursors.read(voidedSweepCursor), ahead, 'the cursor never moves back');
      assert.equal(await cursors.read('google-play-voided:behind'), 0);
    }

    // A slow Play finalization leaves the sweep its half of the wall time.
    {
      const cursors = createD1StoreServerCursors(db);
      const slowNow = start + 70 * 24 * 3_600_000;
      await cursors.write(voidedSweepCursor, slowNow - 2 * 3_600_000, new Date(slowNow));
      await cursors.write('google-play-voided:behind', 0, new Date(slowNow));
      const slowGrant = await store.recordEntitlementGrant({
        source: 'purchase',
        playerId: 'slow-player',
        grantId: 'COINS_100',
        idempotencyKey: 'slow-checkout',
        grantedAt: '2026-10-01T00:00:00.000Z',
        grant: { type: 'currency', currency: 'coin', amount: 100 },
        evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, 'slow-token'),
        payload: {
          target: 'android',
          productType: 'consumable',
          platformProductId: 'coins_100_android',
          platformTransactionId: 'GPA.slow',
          purchasedAt: '2026-10-01T00:00:00.000Z',
          googlePlayPackageName: packageName,
        },
      });
      await outbox.remember({
        ledgerEntryId: slowGrant.ledgerEntryId,
        playerId: 'slow-player',
        purchaseToken: 'slow-token',
        nowMs: slowNow - 3_600_000,
      });
      const secondSlowGrant = await store.recordEntitlementGrant({
        source: 'purchase',
        playerId: 'slow-player',
        grantId: 'COINS_100',
        idempotencyKey: 'slow-checkout-2',
        grantedAt: '2026-10-01T00:00:00.000Z',
        grant: { type: 'currency', currency: 'coin', amount: 100 },
        evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, 'slow-token-2'),
        payload: {
          target: 'android',
          productType: 'consumable',
          platformProductId: 'coins_100_android',
          platformTransactionId: 'GPA.slow-2',
          purchasedAt: '2026-10-01T00:00:00.000Z',
          googlePlayPackageName: packageName,
        },
      });
      await outbox.remember({
        ledgerEntryId: secondSlowGrant.ledgerEntryId,
        playerId: 'slow-player',
        purchaseToken: 'slow-token-2',
        nowMs: slowNow - 3_600_000,
      });
      let fakeClock = 0;
      const slowFinalizer = {
        async finalizePurchaseGrant() {
          // Past half of the 15-second wall budget, short of all of it.
          fakeClock += 8_000;
          return { status: 'pending' as const, alreadyCompleted: false, reason: 'SLOW' };
        },
      };
      const slow = await runScheduledStoreServer(
        cronEnv,
        { cron: '* * * * *' },
        {
          googlePlay: {
            finalizer: slowFinalizer,
            voidedPurchases: {
              async listVoidedPurchases() {
                return { voidedPurchases: [] };
              },
            },
            packageName,
          },
          now: () => slowNow,
          clock: () => fakeClock,
        },
      );
      assert.equal(
        slow?.retried,
        1,
        'the second owed row waits: the retries used their half of the wall time',
      );
      assert.equal(slow?.sweep?.complete, true, 'and the sweep still ran');
    }

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

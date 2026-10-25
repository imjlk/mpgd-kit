import assert from 'node:assert/strict';

import {
  accountDeletionEndpoint,
  AccountDeletionError,
  createAccountDeletionClient,
  createAccountDeletionService,
  createInMemoryPendingAccountErasureStore,
  finishPendingAccountErasures,
  isRetainedPlayerId,
  retainedPlayerIdPrefix,
  type AccountDeletionAuditEntry,
  type AccountDeletionFetch,
  type PendingAccountErasureStore,
  type PlayerDataEraser,
} from './account-deletion.js';
import { createInMemoryNotificationStore } from './notifications/store.js';
import { createInMemoryGameServicesStore, EvidenceAlreadyProcessedError } from './server.js';
import { InMemoryVerifiedLeaderboardService } from './verified-leaderboard.js';

// --- The in-memory game-services store -------------------------------------
{
  const store = createInMemoryGameServicesStore();
  const purchase = await store.recordEntitlementGrant({
    source: 'purchase',
    playerId: 'player-1',
    grantId: 'REMOVE_ADS',
    idempotencyKey: 'purchase:ios:player-1:REMOVE_ADS:run-1',
    grantedAt: '2026-10-20T00:00:00.000Z',
    grant: { type: 'entitlement', entitlement: 'remove_ads' },
    evidenceVerificationId: 'app-store:Production:com.example.game:2000000000000001',
    payload: {
      target: 'ios',
      store: 'app-store',
      productId: 'REMOVE_ADS',
      platformTransactionId: '2000000000000001',
      playerId: 'player-1',
    },
  });
  const refunded = await store.recordEntitlementGrant({
    source: 'purchase',
    playerId: 'player-1',
    grantId: 'COINS_100',
    idempotencyKey: 'purchase:ios:player-1:COINS_100:run-2',
    grantedAt: '2026-10-21T00:00:00.000Z',
    evidenceVerificationId: 'app-store:Production:com.example.game:2000000000000002',
    payload: { target: 'ios', store: 'app-store', platformTransactionId: '2000000000000002' },
  });
  const revocation = await store.recordEntitlementRevocation({
    playerId: 'player-1',
    revokesLedgerEntryId: refunded.ledgerEntryId,
    idempotencyKey: 'app-store:notification:refund-1',
    reason: 'refund',
    revokedAt: '2026-10-22T00:00:00.000Z',
    payload: { playerId: 'player-1', notificationType: 'REFUND' },
    evidenceVerificationId: 'app-store:notification:refund-1',
  });
  await store.recordEntitlementNote({
    noteId: 'app-store:notification:reversed-1',
    kind: 'refund_reversed',
    playerId: 'player-1',
    ledgerEntryId: refunded.ledgerEntryId,
    revocationLedgerEntryId: revocation.ledgerEntryId,
    recordedAt: '2026-10-23T00:00:00.000Z',
    payload: { notificationType: 'REFUND_REVERSED' },
  });
  await store.recordEntitlementGrant({
    source: 'ad_reward',
    playerId: 'player-1',
    grantId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'rewarded-ad:android:player-1:CONTINUE_AFTER_FAIL:run-3',
    grantedAt: '2026-10-21T00:00:00.000Z',
    payload: { target: 'android', platformImpressionId: 'impression-1' },
  });
  const adRevocation = await store.recordEntitlementRevocation({
    playerId: 'player-1',
    revokesLedgerEntryId: (await store.findEntitlementTransactionByIdempotency({
      source: 'ad_reward',
      playerId: 'player-1',
      idempotencyKey: 'rewarded-ad:android:player-1:CONTINUE_AFTER_FAIL:run-3',
    }))?.ledgerEntryId ?? '',
    idempotencyKey: 'support:revoke-reward',
    reason: 'admin',
    revokedAt: '2026-10-22T00:00:00.000Z',
    payload: {},
  });
  await store.recordEntitlementGrant({
    source: 'admin',
    playerId: 'player-1',
    grantId: 'COINS_100',
    idempotencyKey: 'support:regrant-1',
    grantedAt: '2026-10-24T00:00:00.000Z',
    payload: { reason: 'support' },
  });
  await store.recordLeaderboardScore({
    target: 'browser',
    leaderboardId: 'daily',
    playerId: 'player-1',
    score: 10,
    runId: 'run-1',
    submittedAt: '2026-10-20T00:00:00.000Z',
  });
  const other = await store.recordEntitlementGrant({
    source: 'purchase',
    playerId: 'player-2',
    grantId: 'COINS_100',
    idempotencyKey: 'purchase:ios:player-2:COINS_100:run-1',
    grantedAt: '2026-10-20T00:00:00.000Z',
    payload: { target: 'ios', store: 'app-store', platformTransactionId: '2000000000000099' },
  });
  await store.recordLeaderboardScore({
    target: 'browser',
    leaderboardId: 'daily',
    playerId: 'player-2',
    score: 20,
    runId: 'run-1',
    submittedAt: '2026-10-20T00:00:00.000Z',
  });

  const result = await store.erasePlayerData({
    playerId: 'player-1',
    retainedPlayerId: 'deleted:deletion-1',
  });
  // The ad reward and its revocation, the admin grant, and the score are
  // deleted; two purchases, the refund's revocation, and the note are kept.
  assert.deepEqual(result, { deleted: 4, retained: 4 });
  // The ad reward's revocation went with it: replaying its key now needs a grant.
  await assert.rejects(
    store.recordEntitlementRevocation({
      playerId: 'player-1',
      revokesLedgerEntryId: adRevocation.ledgerEntryId,
      idempotencyKey: 'support:revoke-reward',
      reason: 'admin',
      revokedAt: '2026-10-22T00:00:00.000Z',
      payload: {},
    }),
    /unknown grant/u,
  );

  const grants = await store.listEntitlementTransactions();
  assert.equal(
    grants.some((grant) => grant.playerId === 'player-1'),
    false,
  );
  assert.equal(JSON.stringify(grants).includes('player-1'), false, 'no id of the player is kept');
  const kept = grants.filter((grant) => isRetainedPlayerId(grant.playerId));
  assert.equal(kept.length, 2);
  for (const grant of kept) {
    assert.equal(grant.playerId, 'deleted:deletion-1');
    assert.match(grant.ledgerEntryId, /^retained_[0-9a-f-]{36}$/u);
    assert.equal(grant.idempotencyKey, grant.ledgerEntryId);
    assert.equal(grant.source, 'purchase');
    assert.equal('playerId' in grant.payload, false);
  }
  const keptRemoveAds = kept.find((grant) => grant.grantId === 'REMOVE_ADS');
  assert.equal(keptRemoveAds?.payload.platformTransactionId, '2000000000000001');
  assert.equal(
    keptRemoveAds?.evidenceVerificationId,
    'app-store:Production:com.example.game:2000000000000001',
  );
  assert.equal(await store.getEntitlementTransaction(purchase.ledgerEntryId), undefined);
  assert.deepEqual(await store.getEntitlementTransaction(other.ledgerEntryId) !== undefined, true);

  // The kept evidence still refuses the same store purchase for anyone.
  await assert.rejects(
    store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'player-3',
      grantId: 'REMOVE_ADS',
      idempotencyKey: 'purchase:ios:player-3:REMOVE_ADS:run-1',
      grantedAt: '2026-10-25T00:00:00.000Z',
      evidenceVerificationId: 'app-store:Production:com.example.game:2000000000000001',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: '2000000000000001' },
    }),
    EvidenceAlreadyProcessedError,
  );

  const keptCoins = kept.find((grant) => grant.grantId === 'COINS_100');
  assert.ok(keptCoins !== undefined);
  const [keptRevocation] = await store.findEntitlementRevocations({
    ledgerEntryIds: [keptCoins.ledgerEntryId],
  });
  assert.equal(keptRevocation?.playerId, 'deleted:deletion-1');
  assert.equal(keptRevocation?.reason, 'refund');
  assert.equal(keptRevocation?.evidenceVerificationId, 'app-store:notification:refund-1');
  assert.equal(keptRevocation === undefined ? true : 'playerId' in keptRevocation.payload, false);
  // A redelivered refund notification still answers the kept entry.
  const replay = await store.recordEntitlementRevocation({
    playerId: 'deleted:deletion-1',
    revokesLedgerEntryId: keptCoins.ledgerEntryId,
    idempotencyKey: 'app-store:notification:refund-1',
    reason: 'refund',
    revokedAt: '2026-10-22T00:00:00.000Z',
    payload: {},
  });
  assert.deepEqual(replay, {
    ledgerEntryId: keptRevocation?.ledgerEntryId,
    alreadyProcessed: true,
  });
  const [keptNote] = await store.findEntitlementNotes({
    ledgerEntryIds: [keptCoins.ledgerEntryId],
  });
  assert.equal(keptNote?.playerId, 'deleted:deletion-1');
  assert.equal(keptNote?.revocationLedgerEntryId, keptRevocation?.ledgerEntryId);

  const scores = await store.listLeaderboardTransactions();
  assert.deepEqual(
    scores.map((score) => score.playerId),
    ['player-2'],
  );

  // Idempotent: nothing of the player is left.
  assert.deepEqual(
    await store.erasePlayerData({ playerId: 'player-1', retainedPlayerId: 'deleted:deletion-2' }),
    { deleted: 0, retained: 0 },
  );
  assert.equal((await store.listEntitlementTransactions()).length, 3);
}

// --- The in-memory notification store ---------------------------------------
{
  const store = createInMemoryNotificationStore();
  for (const player of ['player-1', 'player-2']) {
    await store.appendConsent({
      player,
      record: {
        kind: 'advertising',
        state: 'granted',
        source: 'player',
        evidence: { textVersion: '1', channel: 'in-game' },
      } as never,
      at: '2026-10-20T00:00:00.000Z',
    });
    await store.putPlatformRegistration({
      player,
      provider: 'ait-functional',
      locale: 'ko-KR',
      registeredAt: '2026-10-20T00:00:00.000Z',
    });
    await store.addNoticeGiven({
      player,
      kind: 'consent-result',
      record: { kind: 'advertising', at: '2026-10-20T00:00:00.000Z' },
      dueBy: '2026-11-03',
      channel: 'in-game',
      at: '2026-10-20T00:00:01.000Z',
    } as never);
    await store.addHistory({
      sendKey: `send-${player}`,
      provider: 'fcm',
      player,
      topic: 'daily-ready',
      at: '2026-10-20T00:00:00.000Z',
    });
    await store.putEndpoint({
      provider: 'fcm',
      installationId: `installation-${player}`,
      player,
      address: { kind: 'fcm-token', value: `token-${player}` },
      permission: 'granted',
      sessionId: `session-${player}`,
      registeredAt: '2026-10-20T00:00:00.000Z',
    } as never);
    await store.createSend({
      key: `send-${player}`,
      fingerprint: 'fingerprint',
      request: { idempotencyKey: `send-${player}`, player, topic: 'daily-ready' },
      origin: 'server',
      scheduled: false,
      rows: [],
    } as never);
    await store.createScheduleEntry({
      player,
      id: 'reminder:daily',
      dueAt: '2026-10-21T00:00:00.000Z',
      item: { kind: 'reminder' },
    } as never);
  }
  const before = store.inspect();
  assert.equal(before.consent.length, 2);
  assert.equal(before.endpoints.length, 2);
  assert.equal(before.sends.length, 2);
  assert.equal(before.schedule.length, 2);
  assert.deepEqual(
    await store.erasePlayerData({ playerId: 'player-1', retainedPlayerId: 'deleted:deletion-1' }),
    { deleted: 7, retained: 0 },
  );
  const after = store.inspect();
  assert.deepEqual(
    after.sends.map((send) => send.request.player),
    ['player-2'],
  );
  for (const rows of [
    after.consent,
    after.platformRegistrations,
    after.noticesGiven,
    after.history,
    after.endpoints,
    after.schedule,
  ]) {
    assert.deepEqual(
      rows.map((row) => row.player),
      ['player-2'],
    );
  }
  assert.deepEqual(
    await store.erasePlayerData({ playerId: 'player-1', retainedPlayerId: 'deleted:deletion-2' }),
    { deleted: 0, retained: 0 },
  );
  await assert.rejects(
    store.erasePlayerData({ playerId: 'deleted:deletion-1', retainedPlayerId: 'deleted:x' }),
  );
}

// --- The in-memory verified leaderboard -------------------------------------
{
  const leaderboard = new InMemoryVerifiedLeaderboardService(() => '2026-10-20T00:00:00.000Z');
  const definition = {
    leaderboardId: 'speedrun',
    scoreOrder: 'ascending',
    attemptSelection: 'best',
  } as const;
  for (const [attemptId, participantId, score] of [
    ['attempt-1', 'player-1', 30],
    ['attempt-2', 'player-1', 20],
    ['attempt-3', 'player-2', 25],
  ] as const) {
    await leaderboard.recordVerifiedAttempt({
      definition,
      attempt: {
        attemptId,
        participantId,
        score,
        completedAt: '2026-10-20T00:00:00.000Z',
        verification: {
          authorityId: 'game-server',
          evidenceId: `evidence-${attemptId}`,
          verifiedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    });
  }
  // Two attempts and the board entry of player-1.
  const erasure = { playerId: 'player-1', retainedPlayerId: 'deleted:deletion-1' };
  assert.deepEqual(await leaderboard.erasePlayerData(erasure), { deleted: 3, retained: 0 });
  const snapshot = await leaderboard.getSnapshot({ leaderboardId: 'speedrun' });
  assert.deepEqual(
    snapshot?.entries.map((entry) => entry.participantId),
    ['player-2'],
  );
  assert.deepEqual(await leaderboard.erasePlayerData(erasure), { deleted: 0, retained: 0 });
}

// --- The deletion service ----------------------------------------------------
{
  const calls: string[] = [];
  const eraser = (name: string): PlayerDataEraser => ({
    async erasePlayerData(input) {
      calls.push(`${name}:${input.playerId}:${input.retainedPlayerId}`);
      return { deleted: 2, retained: 1 };
    },
  });
  const audits: AccountDeletionAuditEntry[] = [];
  const times = ['2026-10-25T00:00:00.000Z', '2026-10-25T00:00:01.000Z'];
  const pending = createInMemoryPendingAccountErasureStore();
  const service = createAccountDeletionService({
    erasers: [eraser('games'), eraser('notifications')],
    identity: {
      async deletePlayer({ playerId }) {
        calls.push(`identity:${playerId}`);
        // The erasure is pending (with the player id) while the identity goes.
        assert.equal((await pending.list({ limit: 10 }))[0]?.playerId, 'player-1');
      },
    },
    pending,
    audit: async (entry) => {
      audits.push(entry);
    },
    now: () => times.shift() ?? 'unexpected',
    createDeletionId: () => 'deletion-1',
  });
  const receipt = await service.deletePlayerAccount({ playerId: 'player-1' });
  assert.deepEqual(receipt, {
    status: 'deleted',
    deletionId: 'deletion-1',
    completedAt: '2026-10-25T00:00:01.000Z',
    retainedPurchaseRecords: 4,
  });
  // Erase, delete the identity, then erase what an in-flight request wrote.
  assert.deepEqual(calls, [
    'games:player-1:deleted:deletion-1',
    'notifications:player-1:deleted:deletion-1',
    'identity:player-1',
    'games:player-1:deleted:deletion-1',
    'notifications:player-1:deleted:deletion-1',
  ]);
  assert.deepEqual(
    await pending.list({ limit: 10 }),
    [],
    'a completed deletion keeps nothing pending',
  );
  assert.deepEqual(audits, [
    {
      deletionId: 'deletion-1',
      requestedAt: '2026-10-25T00:00:00.000Z',
      completedAt: '2026-10-25T00:00:01.000Z',
      identity: 'deleted',
      complete: true,
      deleted: 8,
      retained: 4,
    },
  ]);
  assert.equal(
    JSON.stringify(audits).includes('player-1'),
    false,
    'the audit entry has no player id',
  );

  // A failing first pass is retryable and nothing after it runs.
  const failingPending = createInMemoryPendingAccountErasureStore();
  const failing = createAccountDeletionService({
    erasers: [{ erasePlayerData: () => Promise.reject(new Error('D1_ERROR')) }],
    identity: {
      deletePlayer: () => {
        throw new Error('identity must not run after a failed erasure');
      },
    },
    pending: failingPending,
  });
  await assert.rejects(failing.deletePlayerAccount({ playerId: 'player-1' }), (error: unknown) => {
    assert.ok(error instanceof AccountDeletionError);
    assert.equal(error.code, 'ACCOUNT_DELETION_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual(await failingPending.list({ limit: 10 }), []);
  // A failed identity deletion is retryable too. Its pending erasure stays
  // `erasing`: the player most likely still exists, so the sweep never
  // erases it, only discards it once stale.
  const identityPending = createInMemoryPendingAccountErasureStore();
  let identityErasures = 0;
  const countingEraser: PlayerDataEraser = {
    async erasePlayerData() {
      identityErasures += 1;
      return { deleted: 0, retained: 0 };
    },
  };
  const identityFailing = createAccountDeletionService({
    erasers: [countingEraser],
    identity: { deletePlayer: () => Promise.reject(new Error('identity unavailable')) },
    pending: identityPending,
    now: () => '2026-10-25T00:00:00.000Z',
  });
  await assert.rejects(
    identityFailing.deletePlayerAccount({ playerId: 'player-1' }),
    (error: unknown) => error instanceof AccountDeletionError && error.retryable,
  );
  assert.deepEqual(
    (await identityPending.list({ limit: 10 })).map((entry) => entry.phase),
    ['erasing'],
  );
  assert.equal(identityErasures, 1);
  assert.deepEqual(
    await finishPendingAccountErasures({
      erasers: [countingEraser],
      pending: identityPending,
      now: () => '2026-10-25T00:59:59.000Z',
    }),
    { finished: 0, failed: 0, discarded: 0 },
  );
  assert.deepEqual(
    await finishPendingAccountErasures({
      erasers: [countingEraser],
      pending: identityPending,
      now: () => '2026-10-25T01:00:00.000Z',
    }),
    { finished: 0, failed: 0, discarded: 1 },
  );
  assert.equal(identityErasures, 1, 'a sweep never erases an erasing entry');
  assert.deepEqual(await identityPending.list({ limit: 10 }), []);
  for (const playerId of ['', 'deleted:deletion-1']) {
    // A `deleted:` id names kept records of another deletion, never a player.
    await assert.rejects(
      createAccountDeletionService({
        erasers: [],
        identity: null,
        pending: createInMemoryPendingAccountErasureStore(),
      }).deletePlayerAccount({ playerId }),
      (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED',
    );
  }

  // Without an identity service (local development) the audit says so; an
  // audit failure never fails a completed deletion.
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const localAudits: AccountDeletionAuditEntry[] = [];
  try {
    const local = createAccountDeletionService({
      erasers: [],
      identity: null,
      pending: createInMemoryPendingAccountErasureStore(),
      audit: (entry) => {
        localAudits.push(entry);
        return Promise.reject(new Error('audit table missing'));
      },
      createDeletionId: () => 'deletion-2',
    });
    assert.equal(
      (await local.deletePlayerAccount({ playerId: 'player-1' })).deletionId,
      'deletion-2',
    );
  } finally {
    console.error = consoleError;
  }
  assert.equal(localAudits[0]?.identity, 'not-configured');
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors).includes('player-1'), false);

  // Once the identity is deleted the player cannot retry: each store's
  // second pass is tried three times with a backoff; a store that recovers
  // counts, one that does not leaves the erasure pending for the sweep.
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  let recoveringPasses = 0;
  let brokenPasses = 0;
  let brokenRecovered = false;
  const recovering: PlayerDataEraser = {
    async erasePlayerData() {
      recoveringPasses += 1;
      if (recoveringPasses === 2) {
        throw new Error('D1_ERROR: transient');
      }
      return { deleted: 1, retained: 1 };
    },
  };
  const broken: PlayerDataEraser = {
    async erasePlayerData() {
      brokenPasses += 1;
      if (brokenPasses > 1 && !brokenRecovered) {
        throw new Error('D1_ERROR: unavailable');
      }
      return { deleted: 1, retained: 0 };
    },
  };
  const sweepPending = createInMemoryPendingAccountErasureStore();
  const secondPassAudits: AccountDeletionAuditEntry[] = [];
  const flaky = createAccountDeletionService({
    erasers: [recovering, broken],
    identity: { deletePlayer: async () => undefined },
    pending: sweepPending,
    audit: async (entry) => {
      secondPassAudits.push(entry);
    },
    sleep,
    createDeletionId: () => 'deletion-3',
  });
  const secondPassErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    secondPassErrors.push(args);
  };
  try {
    assert.equal((await flaky.deletePlayerAccount({ playerId: 'player-1' })).status, 'deleted');
  } finally {
    console.error = consoleError;
  }
  // recovering: first pass, a failed attempt, a good one; broken: first pass, three failed.
  assert.equal(recoveringPasses, 3);
  assert.equal(brokenPasses, 4);
  assert.deepEqual(waits, [100, 100, 400]);
  assert.equal(secondPassErrors.length, 4);
  assert.equal(JSON.stringify(secondPassErrors).includes('player-1'), false);
  assert.deepEqual(
    { complete: secondPassAudits[0]?.complete, deleted: secondPassAudits[0]?.deleted },
    { complete: false, deleted: 3 },
  );
  const [left] = await sweepPending.list({ limit: 10 });
  assert.deepEqual(
    {
      deletionId: left?.deletionId,
      playerId: left?.playerId,
      retained: left?.retainedPlayerId,
      phase: left?.phase,
    },
    {
      deletionId: 'deletion-3',
      playerId: 'player-1',
      retained: 'deleted:deletion-3',
      phase: 'identity-deleted',
    },
  );

  // The sweep keeps it while a store fails (tried again least recently tried
  // first), and clears it once all succeed, recording the completion.
  const sweepErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    sweepErrors.push(args);
  };
  try {
    assert.deepEqual(
      await finishPendingAccountErasures({
        erasers: [recovering, broken],
        pending: sweepPending,
        now: () => '2026-10-25T02:00:00.000Z',
      }),
      { finished: 0, failed: 1, discarded: 0 },
    );
  } finally {
    console.error = consoleError;
  }
  assert.equal(JSON.stringify(sweepErrors).includes('player-1'), false);
  const [retried] = await sweepPending.list({ limit: 10 });
  assert.deepEqual(
    { attempts: retried?.attempts, attemptedAt: retried?.attemptedAt },
    { attempts: 1, attemptedAt: '2026-10-25T02:00:00.000Z' },
  );
  brokenRecovered = true;
  const sweepAudits: AccountDeletionAuditEntry[] = [];
  assert.deepEqual(
    await finishPendingAccountErasures({
      erasers: [recovering, broken],
      pending: sweepPending,
      audit: async (entry) => {
        sweepAudits.push(entry);
      },
      now: () => '2026-10-25T02:01:00.000Z',
    }),
    { finished: 1, failed: 0, discarded: 0 },
  );
  assert.deepEqual(await sweepPending.list({ limit: 10 }), []);
  assert.deepEqual(
    { deletionId: sweepAudits[0]?.deletionId, complete: sweepAudits[0]?.complete },
    { deletionId: 'deletion-3', complete: true },
  );

  // A store error that names the player is scrubbed before it is logged.
  const scrubbed: unknown[][] = [];
  let scrubPasses = 0;
  console.error = (...args: unknown[]) => {
    scrubbed.push(args);
  };
  try {
    await createAccountDeletionService({
      erasers: [
        {
          async erasePlayerData() {
            scrubPasses += 1;
            if (scrubPasses > 1) {
              throw new Error('D1_ERROR: row player-1 locked');
            }
            return { deleted: 0, retained: 0 };
          },
        },
      ],
      identity: null,
      pending: createInMemoryPendingAccountErasureStore(),
      sleep,
    }).deletePlayerAccount({ playerId: 'player-1' });
  } finally {
    console.error = consoleError;
  }
  assert.equal(scrubbed.length, 3);
  assert.equal(JSON.stringify(scrubbed).includes('player-1'), false);
  assert.match(String(scrubbed[0]?.[2]), /row \[player\] locked/u);
}

// --- Pending erasures: marks, sweep order, and failures ---------------------
{
  const consoleError = console.error;
  const quiet = async <Value>(run: () => Promise<Value>): Promise<[Value, unknown[][]]> => {
    const lines: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      return [await run(), lines];
    } finally {
      console.error = consoleError;
    }
  };
  const noWait = async (): Promise<void> => undefined;
  const ok: PlayerDataEraser = { erasePlayerData: async () => ({ deleted: 1, retained: 0 }) };
  let failSecond = 0;
  const failsAfterFirst: PlayerDataEraser = {
    async erasePlayerData() {
      failSecond += 1;
      if (failSecond > 1) {
        throw new Error('D1_ERROR');
      }
      return { deleted: 1, retained: 0 };
    },
  };

  // The mark fails three times and a store fails too: nothing finishes it,
  // which is logged under the deletion id.
  const inner = createInMemoryPendingAccountErasureStore();
  const unmarkable: PendingAccountErasureStore = {
    put: (erasure) =>
      erasure.phase === 'identity-deleted'
        ? Promise.reject(new Error('D1_ERROR'))
        : inner.put(erasure),
    clear: (input) => inner.clear(input),
    list: (input) => inner.list(input),
  };
  const [, unmarkedLines] = await quiet(() =>
    createAccountDeletionService({
      erasers: [failsAfterFirst],
      identity: { deletePlayer: async () => undefined },
      pending: unmarkable,
      sleep: noWait,
      createDeletionId: () => 'deletion-unmarked',
    }).deletePlayerAccount({ playerId: 'player-1' }),
  );
  assert.ok(
    unmarkedLines.some((line) =>
      String(line[0]).includes('incomplete and not pending') && line[1] === 'deletion-unmarked',
    ),
  );
  assert.deepEqual(
    (await inner.list({ limit: 10 })).map((entry) => entry.phase),
    ['erasing'],
  );

  // Without an identity service the entry stays `erasing`: no sweep erases
  // a player who still exists.
  failSecond = 0;
  const localPending = createInMemoryPendingAccountErasureStore();
  await quiet(() =>
    createAccountDeletionService({
      erasers: [failsAfterFirst],
      identity: null,
      pending: localPending,
      sleep: noWait,
    }).deletePlayerAccount({ playerId: 'player-1' }),
  );
  assert.deepEqual(
    (await localPending.list({ limit: 10 })).map((entry) => entry.phase),
    ['erasing'],
  );

  // `identity-deleted` entries are listed first, then least recently tried.
  const ordered = createInMemoryPendingAccountErasureStore();
  const entry = (
    deletionId: string,
    phase: 'erasing' | 'identity-deleted',
    recordedAt: string,
    attemptedAt?: string,
  ) => ({
    playerId: `player-${deletionId}`,
    retainedPlayerId: `deleted:${deletionId}`,
    deletionId,
    phase,
    recordedAt,
    attempts: attemptedAt === undefined ? 0 : 1,
    ...(attemptedAt === undefined ? {} : { attemptedAt }),
  });
  await ordered.put(entry('a', 'erasing', '2026-10-25T00:00:00.000Z'));
  await ordered.put(entry('b', 'identity-deleted', '2026-10-25T00:00:02.000Z'));
  await ordered.put(
    entry('c', 'identity-deleted', '2026-10-25T00:00:01.000Z', '2026-10-25T00:00:03.000Z'),
  );
  assert.deepEqual(
    (await ordered.list({ limit: 10 })).map((pending) => pending.deletionId),
    ['b', 'c', 'a'],
  );

  // A sweep runs every store even when an earlier one fails, and a failing
  // discard does not stop the sweep.
  const sweepCalls: string[] = [];
  const failing: PlayerDataEraser = {
    async erasePlayerData(input) {
      sweepCalls.push(`failing:${input.playerId}`);
      throw new Error('D1_ERROR');
    },
  };
  const recording: PlayerDataEraser = {
    async erasePlayerData(input) {
      sweepCalls.push(`recording:${input.playerId}`);
      return { deleted: 0, retained: 0 };
    },
  };
  const brokenClear: PendingAccountErasureStore = {
    put: (erasure) => ordered.put(erasure),
    clear: () => Promise.reject(new Error('D1_ERROR')),
    list: (input) => ordered.list(input),
  };
  const [sweep] = await quiet(() =>
    finishPendingAccountErasures({
      erasers: [failing, recording],
      pending: brokenClear,
      now: () => '2026-10-25T02:00:00.000Z',
    }),
  );
  assert.deepEqual(sweep, { finished: 0, failed: 3, discarded: 0 });
  assert.deepEqual(sweepCalls, [
    'failing:player-b',
    'recording:player-b',
    'failing:player-c',
    'recording:player-c',
  ]);
  assert.deepEqual(
    (await ordered.list({ limit: 10 })).map((pending) => [pending.deletionId, pending.attempts]),
    [
      ['b', 1],
      ['c', 2],
      ['a', 0],
    ],
  );
  void ok;
}

// --- The client --------------------------------------------------------------
{
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const answer = (status: number, body: unknown): AccountDeletionFetch => async (url, init) => {
    requests.push({ url, headers: init.headers, body: init.body });
    return { status, text: async () => JSON.stringify(body) };
  };
  const receipt = {
    status: 'deleted',
    deletionId: 'deletion-1',
    completedAt: '2026-10-25T00:00:01.000Z',
    retainedPurchaseRecords: 2,
  };
  const client = createAccountDeletionClient({
    baseUrl: 'https://game.example/',
    getHeaders: () => ({ Authorization: 'Bearer token' }),
    fetch: answer(200, receipt),
  });
  assert.deepEqual(await client.deleteAccount(), receipt);
  assert.equal(requests[0]?.url, `https://game.example${accountDeletionEndpoint}`);
  assert.equal(requests[0]?.headers.authorization, 'Bearer token');
  assert.equal(requests[0]?.headers['content-type'], 'application/json');
  assert.equal(requests[0]?.body, '{}');

  const failure = async (
    status: number,
    body: unknown,
    code: AccountDeletionError['code'],
  ): Promise<void> => {
    await assert.rejects(
      createAccountDeletionClient({
        baseUrl: 'https://game.example',
        headers: { authorization: 'Bearer token' },
        fetch: answer(status, body),
      }).deleteAccount(),
      (error: unknown) => error instanceof AccountDeletionError && error.code === code,
    );
  };
  await failure(401, { error: 'UNAUTHORIZED' }, 'UNAUTHORIZED');
  await failure(403, { error: 'PLAYER_ID_MISMATCH' }, 'PLAYER_ID_MISMATCH');
  await failure(
    503,
    { error: 'ACCOUNT_DELETION_NOT_CONFIGURED' },
    'ACCOUNT_DELETION_NOT_CONFIGURED',
  );
  await failure(404, { error: 'UNKNOWN_ENDPOINT' }, 'ACCOUNT_DELETION_NOT_CONFIGURED');
  await failure(500, { error: 'ACCOUNT_DELETION_FAILED' }, 'ACCOUNT_DELETION_FAILED');
  await failure(429, { error: 'RATE_LIMITED' }, 'ACCOUNT_DELETION_FAILED');
  await failure(408, { error: 'TIMEOUT' }, 'ACCOUNT_DELETION_FAILED');
  await failure(400, { error: 'BAD_REQUEST' }, 'ACCOUNT_DELETION_REJECTED');
  assert.equal(new AccountDeletionError('ACCOUNT_DELETION_REJECTED').retryable, false);
  await failure(200, { status: 'pending' }, 'ACCOUNT_DELETION_UNREACHABLE');

  const before = requests.length;
  await assert.rejects(
    createAccountDeletionClient({
      baseUrl: 'https://game.example',
      fetch: answer(200, receipt),
    }).deleteAccount(),
    (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED',
  );
  await assert.rejects(
    createAccountDeletionClient({
      baseUrl: 'https://game.example',
      getHeaders: () => {
        throw new Error('refresh could not reach the identity service');
      },
      fetch: answer(200, receipt),
    }).deleteAccount(),
    // Nothing was sent, and another try may resolve the session.
    (error: unknown) =>
      error instanceof AccountDeletionError
      && error.code === 'ACCOUNT_DELETION_UNREACHABLE'
      && error.retryable,
  );
  assert.equal(requests.length, before, 'no request without a session');

  const unreachable = createAccountDeletionClient({
    baseUrl: 'https://game.example',
    headers: { authorization: 'Bearer token' },
    fetch: () => Promise.reject(new TypeError('network')),
  });
  await assert.rejects(unreachable.deleteAccount(), (error: unknown) => {
    assert.ok(error instanceof AccountDeletionError);
    assert.equal(error.code, 'ACCOUNT_DELETION_UNREACHABLE');
    assert.equal(error.retryable, true);
    return true;
  });

  // A stalled request ends at the deadline and is aborted.
  let signal: AbortSignal | undefined;
  const stalled = createAccountDeletionClient({
    baseUrl: 'https://game.example',
    headers: { authorization: 'Bearer token' },
    timeoutMs: 5,
    fetch: (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    },
  });
  await assert.rejects(
    stalled.deleteAccount(),
    (error: unknown) =>
      error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_UNREACHABLE',
  );
  assert.equal(signal?.aborted, true);
  const stalledSession = createAccountDeletionClient({
    baseUrl: 'https://game.example',
    getHeaders: () => new Promise(() => undefined),
    timeoutMs: 5,
    fetch: answer(200, receipt),
  });
  await assert.rejects(
    stalledSession.deleteAccount(),
    (error: unknown) =>
      error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_UNREACHABLE',
  );
  // A timeout that is not a positive delay falls back to the default.
  assert.deepEqual(
    await createAccountDeletionClient({
      baseUrl: 'https://game.example',
      headers: { authorization: 'Bearer token' },
      timeoutMs: 0,
      fetch: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        return { status: 200, text: async () => JSON.stringify(receipt) };
      },
    }).deleteAccount(),
    receipt,
  );
  // `verified-leaderboard.ts` stays import-free and repeats the prefix literal.
  assert.equal(retainedPlayerIdPrefix, 'deleted:');
}

console.info('Account deletion tests passed.');

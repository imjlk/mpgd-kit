import assert from 'node:assert/strict';

import {
  accountDeletionEndpoint,
  AccountDeletionError,
  createAccountDeletionClient,
  createAccountDeletionService,
  isRetainedPlayerId,
  type AccountDeletionAuditEntry,
  type AccountDeletionFetch,
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
  // Ad reward, admin grant, and the score are deleted; two purchases, the
  // revocation, and the note are kept.
  assert.deepEqual(result, { deleted: 3, retained: 4 });

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
  }
  const before = store.inspect();
  assert.equal(before.consent.length, 2);
  assert.equal(store.erasePlayer('player-1'), 4);
  const after = store.inspect();
  for (const rows of [
    after.consent,
    after.platformRegistrations,
    after.noticesGiven,
    after.history,
  ]) {
    assert.deepEqual(
      rows.map((row) => row.player),
      ['player-2'],
    );
  }
  assert.equal(store.erasePlayer('player-1'), 0);
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
  assert.equal(leaderboard.eraseParticipant('player-1'), 3);
  const snapshot = await leaderboard.getSnapshot({ leaderboardId: 'speedrun' });
  assert.deepEqual(
    snapshot?.entries.map((entry) => entry.participantId),
    ['player-2'],
  );
  assert.equal(leaderboard.eraseParticipant('player-1'), 0);
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
  const service = createAccountDeletionService({
    erasers: [eraser('games'), eraser('notifications')],
    identity: {
      async deletePlayer({ playerId }) {
        calls.push(`identity:${playerId}`);
      },
    },
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
  assert.deepEqual(audits, [
    {
      deletionId: 'deletion-1',
      requestedAt: '2026-10-25T00:00:00.000Z',
      completedAt: '2026-10-25T00:00:01.000Z',
      identity: 'deleted',
      deleted: 8,
      retained: 4,
    },
  ]);
  assert.equal(
    JSON.stringify(audits).includes('player-1'),
    false,
    'the audit entry has no player id',
  );

  // A failing step is retryable and nothing after it runs.
  const failing = createAccountDeletionService({
    erasers: [{ erasePlayerData: () => Promise.reject(new Error('D1_ERROR')) }],
    identity: {
      deletePlayer: () => {
        throw new Error('identity must not run after a failed erasure');
      },
    },
  });
  await assert.rejects(failing.deletePlayerAccount({ playerId: 'player-1' }), (error: unknown) => {
    assert.ok(error instanceof AccountDeletionError);
    assert.equal(error.code, 'ACCOUNT_DELETION_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
  const identityFailing = createAccountDeletionService({
    erasers: [],
    identity: { deletePlayer: () => Promise.reject(new Error('identity unavailable')) },
  });
  await assert.rejects(
    identityFailing.deletePlayerAccount({ playerId: 'player-1' }),
    AccountDeletionError,
  );
  await assert.rejects(
    createAccountDeletionService({ erasers: [] }).deletePlayerAccount({ playerId: '' }),
    AccountDeletionError,
  );

  // Without an identity service (local development) the audit says so; an
  // audit failure never fails a completed deletion.
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const local = createAccountDeletionService({
      erasers: [],
      audit: () => Promise.reject(new Error('audit table missing')),
      createDeletionId: () => 'deletion-2',
    });
    assert.equal(
      (await local.deletePlayerAccount({ playerId: 'player-1' })).deletionId,
      'deletion-2',
    );
  } finally {
    console.error = consoleError;
  }
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors).includes('player-1'), false);
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
        throw new Error('signed out');
      },
      fetch: answer(200, receipt),
    }).deleteAccount(),
    (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED',
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
}

console.info('Account deletion tests passed.');

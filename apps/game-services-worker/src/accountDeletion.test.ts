import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  accountDeletionConfirmationMaxLength,
  accountDeletionEndpoint,
  createAccountDeletionService,
  createGooglePlayProductVerificationId,
  finishPendingAccountErasures,
  retryGooglePlayPurchaseFinalization,
  type AccountDeletionReceipt,
  type FinalizePurchaseGrantInput,
} from '@mpgd/game-services';
import { Miniflare } from 'miniflare';

import {
  createD1AccountDeletionAudit,
  createD1PendingAccountErasureStore,
  createD1PlayerDataEraser,
  d1PlayerTables,
  purgeExpiredRetainedPurchaseRecords,
  runScheduledAccountDeletion,
} from './accountDeletion.js';
import {
  AccountDeletedWriteError,
  accountDeletionTombstoneKeyOf,
  createAccountDeletionTombstoneEraser,
  resolveAccountDeletionTombstones,
} from './deletionTombstones.js';
import { createD1GameServicesStore } from './d1Store.js';
import {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
} from './handler.js';
import { createD1NotificationStore } from './notificationsD1.js';
import { refuseDeletedNotificationWrites } from './notificationsHandler.js';
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'account-deletion' },
});

const packageName = 'com.example.game';

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const migration of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
    await applyMigration(db, migration);
  }
  const store = createD1GameServicesStore(db);

  // --- Every player table, erased in one batch -------------------------------
  for (const player of ['player-1', 'player-2']) {
    await seedPlayer(db, player);
  }
  const playerTables = await listPlayerTables(db);
  assert.deepEqual(
    [...playerTables.keys()].sort(),
    Object.keys(d1PlayerTables).sort(),
    'every migration table that keys a player is covered by the erasure',
  );
  for (const [table, column] of playerTables) {
    if (table === 'account_deletion_pending') {
      continue;
    }
    assert.ok(await countRows(db, table, column, 'player-1') > 0, `seeded ${table}`);
  }

  const eraser = createD1PlayerDataEraser(db);
  const result = await eraser.erasePlayerData({
    playerId: 'player-1',
    retainedPlayerId: 'deleted:deletion-1',
  });
  // Kept: the purchase grant, its revocation, its note, the Play purchase grant.
  assert.equal(result.retained, 4);
  // One row in each of the 11 tables deleted by player, and the ad reward grant.
  assert.equal(result.deleted, 12);
  for (const [table, column] of playerTables) {
    assert.equal(
      await countRows(db, table, column, 'player-1'),
      0,
      `${table} keeps no player-1 row`,
    );
    if (table !== 'account_deletion_pending') {
      assert.ok(await countRows(db, table, column, 'player-2') > 0, `${table} keeps player-2`);
    }
  }
  // Nothing anywhere names the player any more (ledger ids embedded it).
  for (const table of [
    'entitlement_transactions',
    'entitlement_revocations',
    'entitlement_notes',
    'google_play_pending_finalizations',
  ]) {
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    assert.equal(
      JSON.stringify(rows).includes('player-1'),
      false,
      `${table} has no trace of player-1`,
    );
  }
  const kept = (await db
    .prepare('SELECT * FROM entitlement_transactions WHERE player_id = ? ORDER BY grant_id')
    .bind('deleted:deletion-1')
    .all<{ ledger_entry_id: string; idempotency_key: string; payload_json: string; source: string }>())
    .results;
  assert.equal(kept.length, 2);
  for (const row of kept) {
    assert.match(row.ledger_entry_id, /^retained_/u);
    assert.equal(row.idempotency_key, row.ledger_entry_id);
    assert.equal(row.source, 'purchase');
    assert.equal('playerId' in JSON.parse(row.payload_json), false);
  }
  // The kept evidence refuses the same store purchase for another player.
  await assert.rejects(
    store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'player-3',
      grantId: 'REMOVE_ADS',
      idempotencyKey: 'player-3-replay',
      grantedAt: '2026-10-25T00:00:00.000Z',
      evidenceVerificationId: 'app-store:Production:com.example.game:tx-1',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: 'tx-1' },
    }),
    /already been processed/u,
  );
  // Idempotent.
  assert.deepEqual(
    await eraser.erasePlayerData({ playerId: 'player-1', retainedPlayerId: 'deleted:deletion-2' }),
    { deleted: 0, retained: 0 },
  );

  // --- A pending Play purchase: finalized after the deletion -----------------
  const [outbox] = (await db
    .prepare('SELECT * FROM google_play_pending_finalizations WHERE player_id = ?')
    .bind('deleted:deletion-1')
    .all<{ ledger_entry_id: string; purchase_token: string }>()).results;
  assert.ok(outbox !== undefined, 'the owed acknowledge survives the deletion');
  assert.match(outbox.ledger_entry_id, /^retained_/u);
  let finalized: Omit<FinalizePurchaseGrantInput, 'signal'> | undefined;
  const finalization = await retryGooglePlayPurchaseFinalization({
    finalizer: {
      async finalizePurchaseGrant(input) {
        finalized = input;
        return { status: 'completed', action: 'consume', alreadyCompleted: false };
      },
    },
    store,
    ledgerEntryId: outbox.ledger_entry_id,
    purchaseToken: outbox.purchase_token,
    signal: AbortSignal.timeout(5_000),
    timeoutMs: 5_000,
  });
  assert.equal(finalization.status, 'completed');
  assert.equal(finalized?.request.playerId, 'deleted:deletion-1');
  assert.equal(finalized?.evidencePayload?.googlePlayObfuscatedExternalAccountId, 'obfuscated-1');

  // --- The service over D1: a request that lands during the deletion -------
  await seedPlayer(db, 'player-4');
  const pending = createD1PendingAccountErasureStore(db);
  const audit = createD1AccountDeletionAudit(db);
  const service = createAccountDeletionService({
    erasers: [eraser],
    identity: {
      async deletePlayer() {
        // A score write that was already running commits now.
        await store.recordLeaderboardScore({
          target: 'browser',
          leaderboardId: 'daily',
          playerId: 'player-4',
          score: 99,
          runId: 'in-flight',
          submittedAt: '2026-10-25T00:00:00.000Z',
        });
        const [entry] = await pending.list({ limit: 10 });
        assert.equal(entry?.phase, 'erasing');
      },
    },
    pending,
    audit,
    now: () => '2026-10-25T00:00:00.000Z',
    createDeletionId: () => 'deletion-4',
  });
  const receipt = await service.deletePlayerAccount({ playerId: 'player-4' });
  assert.equal(receipt.retainedPurchaseRecords, 4);
  for (const [table, column] of playerTables) {
    if (table === 'account_deletion_pending') {
      continue;
    }
    assert.equal(
      await countRows(db, table, column, 'player-4'),
      0,
      `${table} keeps no player-4 row`,
    );
  }
  // The erasure waits for its final pass; the cron's sweep runs it later and
  // clears it, and then no row names player-4.
  assert.deepEqual(
    (await pending.list({ limit: 10 })).map((entry) => entry.phase),
    ['identity-deleted'],
  );
  assert.deepEqual(
    await finishPendingAccountErasures({
      erasers: [eraser],
      pending,
      audit,
      now: () => '2026-10-25T00:15:00.000Z',
    }),
    { finished: 1, failed: 0, discarded: 0 },
  );
  assert.deepEqual(await pending.list({ limit: 10 }), []);
  assert.equal(await countRows(db, 'account_deletion_pending', 'player_id', 'player-4'), 0);
  const auditRows = (await db.prepare('SELECT * FROM account_deletion_audit').all()).results;
  assert.equal(auditRows.length, 1);
  assert.equal((auditRows[0] as { complete: number }).complete, 1);
  assert.equal(JSON.stringify(auditRows).includes('player-4'), false);

  // The D1 pending store lists identity-deleted erasures first.
  await pending.put({
    deletionId: 'pending-a',
    playerId: 'player-a',
    retainedPlayerId: 'deleted:pending-a',
    phase: 'erasing',
    recordedAt: '2026-10-25T00:00:00.000Z',
    attempts: 0,
  });
  await pending.put({
    deletionId: 'pending-b',
    playerId: 'player-b',
    retainedPlayerId: 'deleted:pending-b',
    phase: 'erasing',
    recordedAt: '2026-10-25T00:00:01.000Z',
    attempts: 0,
  });
  await pending.put({
    deletionId: 'pending-b',
    playerId: 'player-b',
    retainedPlayerId: 'deleted:pending-b',
    phase: 'identity-deleted',
    recordedAt: '2026-10-25T00:00:01.000Z',
    attempts: 2,
    attemptedAt: '2026-10-25T00:05:00.000Z',
  });
  assert.deepEqual(
    (await pending.list({ limit: 10 })).map((entry) => [
      entry.deletionId,
      entry.phase,
      entry.attempts,
    ]),
    [
      ['pending-b', 'identity-deleted', 2],
      ['pending-a', 'erasing', 0],
    ],
  );
  // An identity-deleted erasure not due for its final pass is left out.
  assert.deepEqual(
    (await pending.list({ limit: 10, identityDeletedBefore: '2026-10-25T00:00:00.500Z' }))
      .map((entry) => entry.deletionId),
    ['pending-a'],
  );
  await pending.clear({ deletionId: 'pending-a' });
  await pending.clear({ deletionId: 'pending-b' });

  // --- Many rewarded ads, a cross-player revocation, and the sweep ---------
  {
    for (let index = 0; index < 250; index += 1) {
      await store.recordEntitlementGrant({
        source: 'ad_reward',
        playerId: 'player-6',
        grantId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: `rewarded-ad:player-6:${index}`,
        grantedAt: '2026-10-21T00:00:00.000Z',
        payload: { target: 'android', platformImpressionId: `bulk-impression-${index}` },
      });
    }
    const adGrant = await store.findEntitlementTransactionByIdempotency?.({
      source: 'ad_reward',
      playerId: 'player-6',
      idempotencyKey: 'rewarded-ad:player-6:0',
    });
    const adRevocation = await required(store.recordEntitlementRevocation).call(store, {
      playerId: 'player-6',
      revokesLedgerEntryId: required(adGrant).ledgerEntryId,
      idempotencyKey: 'support:revoke-ad',
      reason: 'admin',
      revokedAt: '2026-10-22T00:00:00.000Z',
      payload: {},
    });
    // A game-owned writer filed a revocation under player-6 for player-7's
    // grant, and player-7's note points at it.
    const other = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'player-7',
      grantId: 'COINS_100',
      idempotencyKey: 'player-7-purchase',
      grantedAt: '2026-10-20T00:00:00.000Z',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: 'tx-7' },
    });
    const crossRevocation = await required(store.recordEntitlementRevocation).call(store, {
      playerId: 'player-6',
      revokesLedgerEntryId: other.ledgerEntryId,
      idempotencyKey: 'support:cross',
      reason: 'admin',
      revokedAt: '2026-10-22T00:00:00.000Z',
      payload: {},
    });
    await required(store.recordEntitlementNote).call(store, {
      noteId: 'cross-note',
      kind: 'refund_reversed',
      playerId: 'player-7',
      ledgerEntryId: other.ledgerEntryId,
      revocationLedgerEntryId: crossRevocation.ledgerEntryId,
      recordedAt: '2026-10-23T00:00:00.000Z',
      payload: {},
    });
    // A mismatched note on one of player-6's rewarded-ad grants pointing at
    // the cross revocation, and an owed finalization filed under player-6
    // for player-7's grant.
    await required(store.recordEntitlementNote).call(store, {
      noteId: 'mismatched-note',
      kind: 'refund_reversed',
      playerId: 'player-6',
      ledgerEntryId: required(adGrant).ledgerEntryId,
      revocationLedgerEntryId: crossRevocation.ledgerEntryId,
      recordedAt: '2026-10-23T00:00:00.000Z',
      payload: {},
    });
    await db.prepare(`INSERT INTO google_play_pending_finalizations (
        ledger_entry_id, player_id, purchase_token, first_seen_at_ms, next_attempt_at_ms, attempts
      ) VALUES (?, 'player-6', 'token-cross', 0, 0, 0)`)
      .bind(other.ledgerEntryId)
      .run();
    // Player-7's note pointing at the rewarded ad's revocation goes with it.
    await required(store.recordEntitlementNote).call(store, {
      noteId: 'note-on-ad-revocation',
      kind: 'refund_reversed',
      playerId: 'player-7',
      ledgerEntryId: other.ledgerEntryId,
      revocationLedgerEntryId: adRevocation.ledgerEntryId,
      recordedAt: '2026-10-23T00:00:00.000Z',
      payload: {},
    });
    const bulk = await eraser.erasePlayerData({
      playerId: 'player-6',
      retainedPlayerId: 'deleted:deletion-6',
    });
    // 250 rewarded-ad grants, the revocation of one, and the mismatched note,
    // set-based; the cross-player revocation and the note pointing at it are
    // rewritten.
    assert.deepEqual(bulk, { deleted: 253, retained: 2 });
    assert.equal(
      await db.prepare("SELECT note_id FROM entitlement_notes WHERE note_id = 'note-on-ad-revocation'")
        .first(),
      null,
    );
    assert.equal(
      await db.prepare("SELECT note_id FROM entitlement_notes WHERE note_id = 'mismatched-note'").first(),
      null,
    );
    assert.equal(
      (await db.prepare('SELECT player_id FROM google_play_pending_finalizations WHERE ledger_entry_id = ?')
        .bind(other.ledgerEntryId)
        .first<{ player_id: string }>())?.player_id,
      'deleted:deletion-6',
    );
    assert.equal(await countRows(db, 'entitlement_transactions', 'player_id', 'player-6'), 0);
    const [cross] = (await db
      .prepare('SELECT * FROM entitlement_revocations WHERE revokes_ledger_entry_id = ?')
      .bind(other.ledgerEntryId)
      .all<{ ledger_entry_id: string; player_id: string }>()).results;
    assert.equal(cross?.player_id, 'deleted:deletion-6');
    const note = await db.prepare("SELECT * FROM entitlement_notes WHERE note_id = 'cross-note'")
      .first<{ player_id: string; revocation_ledger_entry_id: string }>();
    assert.equal(note?.revocation_ledger_entry_id, cross?.ledger_entry_id);
    assert.equal(note?.player_id, 'deleted:deletion-6');
  }
  {
    // The sweep over the D1 stores finishes an identity-deleted erasure and
    // completes its audit entry, adding the counts.
    await seedPlayer(db, 'player-8');
    await audit({
      deletionId: 'deletion-8',
      requestedAt: '2026-10-25T00:00:00.000Z',
      completedAt: '2026-10-25T00:00:01.000Z',
      identity: 'deleted',
      complete: false,
      deleted: 1,
      retained: 0,
    });
    await pending.put({
      deletionId: 'deletion-8',
      playerId: 'player-8',
      retainedPlayerId: 'deleted:deletion-8',
      phase: 'identity-deleted',
      recordedAt: '2026-10-25T00:00:00.000Z',
      attempts: 0,
    });
    const sweep = await finishPendingAccountErasures({
      erasers: [eraser],
      pending,
      audit,
      now: () => '2026-10-25T00:16:00.000Z',
    });
    assert.deepEqual(sweep, { finished: 1, failed: 0, discarded: 0 });
    assert.equal(await countRows(db, 'notification_endpoints', 'player_id', 'player-8'), 0);
    const row = await db.prepare("SELECT * FROM account_deletion_audit WHERE deletion_id = 'deletion-8'")
      .first<{ complete: number; deleted_rows: number; retained_rows: number; requested_at: string }>();
    assert.deepEqual(
      { ...row },
      {
        ...row,
        complete: 1,
        deleted_rows: 13,
        retained_rows: 4,
        requested_at: '2026-10-25T00:00:00.000Z',
      },
    );
    assert.deepEqual(await pending.list({ limit: 10 }), []);
  }

  // --- An owed Play finalization written while the erasure runs ----------
  {
    await seedPlayer(db, 'player-9');
    const playGrant = await db.prepare(`SELECT ledger_entry_id FROM entitlement_transactions
        WHERE player_id = 'player-9' AND json_extract(payload_json, '$.store') = 'google-play'`)
      .first<{ ledger_entry_id: string }>();
    await db.prepare('DELETE FROM google_play_pending_finalizations WHERE player_id = ?')
      .bind('player-9')
      .run();
    // The purchase path's outbox write lands between the eraser's reads and its batch.
    const racing = {
      withSession(constraint: string) {
        const session = db.withSession(constraint as never);
        return {
          prepare: (query: string) => session.prepare(query),
          async batch(statements: D1PreparedStatement[]) {
            await db.prepare(`INSERT INTO google_play_pending_finalizations (
                ledger_entry_id, player_id, purchase_token, first_seen_at_ms, next_attempt_at_ms, attempts
              ) VALUES (?, 'player-9', 'token-racing', 0, 0, 0)`)
              .bind(required(playGrant ?? undefined).ledger_entry_id)
              .run();
            return session.batch(statements);
          },
        };
      },
    } as unknown as D1Database;
    await createD1PlayerDataEraser(racing).erasePlayerData({
      playerId: 'player-9',
      retainedPlayerId: 'deleted:deletion-9',
    });
    const moved = await db.prepare(`SELECT f.player_id, t.source FROM google_play_pending_finalizations f
        JOIN entitlement_transactions t ON t.ledger_entry_id = f.ledger_entry_id
        WHERE f.purchase_token = 'token-racing'`)
      .first<{ player_id: string; source: string }>();
    assert.deepEqual({ ...moved }, { player_id: 'deleted:deletion-9', source: 'purchase' });
  }

  // --- The retention purge -----------------------------------------------------
  // Kept records younger than five years stay; older ones go with their rows.
  assert.equal(
    await purgeExpiredRetainedPurchaseRecords(db, new Date('2031-10-19T00:00:00.000Z')),
    0,
  );
  const purged = await purgeExpiredRetainedPurchaseRecords(
    db,
    new Date('2031-10-26T00:00:00.000Z'),
  );
  assert.equal(purged, 8, 'two kept grants each of player-1, player-4, player-8, and player-9');
  for (const table of [
    'entitlement_transactions',
    'entitlement_revocations',
    'entitlement_notes',
  ]) {
    assert.equal(
      // (deletion-6 only kept rows about another player's live grant.)
      (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}
          WHERE player_id LIKE 'deleted:%' AND player_id <> 'deleted:deletion-6'`)
        .first<{ n: number }>())?.n,
      0,
      `${table} purged`,
    );
  }
  assert.ok(await countRows(db, 'entitlement_transactions', 'player_id', 'player-2') > 0);
  // A grant older than the period whose revocation is newer stays until the
  // revocation is old enough too.
  {
    const oldGrant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'deleted:old',
      grantId: 'COINS_100',
      idempotencyKey: 'old-grant',
      grantedAt: '2020-01-01T00:00:00.000Z',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: 'tx-old' },
    });
    await required(store.recordEntitlementRevocation).call(store, {
      playerId: 'deleted:old',
      revokesLedgerEntryId: oldGrant.ledgerEntryId,
      idempotencyKey: 'old-refund',
      reason: 'refund',
      revokedAt: '2024-06-01T00:00:00.000Z',
      payload: {},
    });
    assert.equal(
      await purgeExpiredRetainedPurchaseRecords(db, new Date('2029-01-01T00:00:00.000Z')),
      0,
    );
    // A note about a live grant that points at the old grant's revocation
    // goes with that revocation instead of failing the purge.
    const liveGrant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'deleted:old',
      grantId: 'COINS_100',
      idempotencyKey: 'live-grant',
      grantedAt: '2029-01-01T00:00:00.000Z',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: 'tx-live' },
    });
    const [oldRevocation] = await required(store.findEntitlementRevocations).call(store, {
      ledgerEntryIds: [oldGrant.ledgerEntryId],
    });
    await required(store.recordEntitlementNote).call(store, {
      noteId: 'cross-linked-note',
      kind: 'refund_reversed',
      playerId: 'deleted:old',
      ledgerEntryId: liveGrant.ledgerEntryId,
      revocationLedgerEntryId: required(oldRevocation).ledgerEntryId,
      recordedAt: '2029-01-02T00:00:00.000Z',
      payload: {},
    });
    assert.equal(
      await purgeExpiredRetainedPurchaseRecords(db, new Date('2029-06-02T00:00:00.000Z')),
      1,
    );
    assert.equal(
      await db.prepare("SELECT note_id FROM entitlement_notes WHERE note_id = 'cross-linked-note'").first(),
      null,
    );
    assert.equal(
      await countRows(db, 'entitlement_transactions', 'ledger_entry_id', liveGrant.ledgerEntryId),
      1,
    );
  }

  // Every kept record carries its retention expiry, and a refund or note
  // written after the deletion extends its group's; the purge runs by it.
  {
    const lateGrant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: 'deleted:late',
      grantId: 'COINS_100',
      idempotencyKey: 'late-grant',
      grantedAt: '2026-01-01T00:00:00.000Z',
      payload: { target: 'ios', store: 'app-store', platformTransactionId: 'tx-late' },
    });
    const until = async (table: string, column: string, id: string) =>
      (await db.prepare(`SELECT retained_until FROM ${table} WHERE ${column} = ?`).bind(id)
        .first<{ retained_until: string | null }>())?.retained_until;
    assert.equal(
      await until('entitlement_transactions', 'ledger_entry_id', lateGrant.ledgerEntryId),
      '2031-01-01T00:00:00.000Z',
    );
    // The store reports a refund two years after the deletion.
    const lateRefund = await required(store.recordEntitlementRevocation).call(store, {
      playerId: 'deleted:late',
      revokesLedgerEntryId: lateGrant.ledgerEntryId,
      idempotencyKey: 'late-refund',
      reason: 'refund',
      revokedAt: '2028-01-01T00:00:00.000Z',
      payload: {},
    });
    assert.equal(
      await until('entitlement_revocations', 'ledger_entry_id', lateRefund.ledgerEntryId),
      '2033-01-01T00:00:00.000Z',
    );
    assert.equal(
      await until('entitlement_transactions', 'ledger_entry_id', lateGrant.ledgerEntryId),
      '2033-01-01T00:00:00.000Z',
      'the refund extends the grant',
    );
    // A note under the deleted player about a live player's grant: purged at its own expiry.
    const [liveGrant] = (await db.prepare(
      "SELECT ledger_entry_id FROM entitlement_transactions WHERE player_id = 'player-2' AND source = 'purchase'",
    ).all<{ ledger_entry_id: string }>()).results;
    await required(store.recordEntitlementNote).call(store, {
      noteId: 'late-cross-note',
      kind: 'refund_reversed',
      playerId: 'deleted:late',
      ledgerEntryId: required(liveGrant).ledger_entry_id,
      recordedAt: '2026-02-01T00:00:00.000Z',
      payload: {},
    });
    assert.equal(
      await until('entitlement_notes', 'note_id', 'late-cross-note'),
      '2031-02-01T00:00:00.000Z',
    );
    // A live player's own rows carry none.
    assert.equal(
      await until('entitlement_transactions', 'ledger_entry_id', required(liveGrant).ledger_entry_id),
      null,
    );
    assert.equal(
      await purgeExpiredRetainedPurchaseRecords(db, new Date('2031-06-01T00:00:00.000Z')),
      0,
    );
    assert.equal(
      await db.prepare("SELECT note_id FROM entitlement_notes WHERE note_id = 'late-cross-note'").first(),
      null,
      'the cross note went at its own expiry',
    );
    assert.equal(
      await countRows(db, 'entitlement_transactions', 'ledger_entry_id', lateGrant.ledgerEntryId),
      1,
      'the refunded grant stays until the refund is five years old',
    );
    assert.equal(
      await purgeExpiredRetainedPurchaseRecords(db, new Date('2033-01-02T00:00:00.000Z')),
      1,
    );
    assert.equal(
      await countRows(db, 'entitlement_revocations', 'ledger_entry_id', lateRefund.ledgerEntryId),
      0,
    );
    assert.equal(
      await countRows(db, 'entitlement_transactions', 'ledger_entry_id', required(liveGrant).ledger_entry_id),
      1,
    );
  }

  // --- The route ----------------------------------------------------------------
  const deleted: string[] = [];
  const tombstoneKey = 't'.repeat(48);
  const env = (
    overrides: Partial<GameServicesWorkerEnv>,
    omit: readonly (keyof GameServicesWorkerEnv)[] = [],
  ): GameServicesWorkerEnv => withoutKeys(
    {
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: tombstoneKey,
      GAME_SERVICES_INGRESS_AUTH: {
        async authenticateGameServicesRequest({ authorization }) {
          return authorization === 'Bearer player-5-token' ? { playerId: 'player-5' } : undefined;
        },
      },
      GAME_SERVICES_ACCOUNT_DELETION: {
        async deletePlayer({ playerId }) {
          deleted.push(playerId);
        },
        async verifyAccountDeletionConfirmation({ playerId, confirmation }) {
          // Single use, bound to the player; another player's attempt does
          // not use it up.
          const confirmed = confirmations.get(confirmation) === playerId;
          if (confirmed) {
            confirmations.delete(confirmation);
          }
          return { confirmed };
        },
      },
      ...overrides,
    },
    omit,
  );
  const confirmations = new Map<string, string>([
    ['confirm-5a', 'player-5'],
    ['confirm-5b', 'player-5'],
    ['confirm-5c', 'player-5'],
    ['confirm-2', 'player-2'],
  ]);
  const route = createWorkerFetchHandler(env({}));
  const post = (
    handler: (request: Request) => Promise<Response>,
    headers: Record<string, string>,
    body = '{}',
    origin = 'https://game-services.example',
  ) =>
    handler(new Request(`${origin}${accountDeletionEndpoint}`, { method: 'POST', headers, body }));

  await seedPlayer(db, 'player-5');
  assert.equal((await post(route, {})).status, 401, 'no session');
  assert.equal((await post(route, { authorization: 'Bearer other' })).status, 401);
  const mismatch = await post(
    route,
    { authorization: 'Bearer player-5-token' },
    JSON.stringify({ playerId: 'player-2' }),
  );
  assert.equal(mismatch.status, 403, 'another player');
  assert.deepEqual(await mismatch.json(), { error: 'PLAYER_ID_MISMATCH' });
  assert.equal(await countRows(db, 'leaderboard_transactions', 'player_id', 'player-2'), 1);
  assert.equal(
    (await route(new Request(`https://game-services.example${accountDeletionEndpoint}`))).status,
    405,
  );
  const preflight = await route(
    new Request(`https://game-services.example${accountDeletionEndpoint}`, { method: 'OPTIONS' }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(
    (await route(new Request(`https://game-services.example${accountDeletionEndpoint}`)))
      .headers.get('allow'),
    'POST',
  );
  for (const body of ['not json', '[]', JSON.stringify({ pad: 'x'.repeat(5000) })]) {
    assert.equal(
      (await post(route, { authorization: 'Bearer player-5-token' }, body)).status,
      400,
      body.slice(0, 10),
    );
  }
  const throwingAuth = createWorkerFetchHandler(
    env({
      GAME_SERVICES_INGRESS_AUTH: {
        authenticateGameServicesRequest: () => Promise.reject(new Error('identity down')),
      },
    }),
  );
  const authFailed = await post(throwingAuth, { authorization: 'Bearer player-5-token' });
  assert.equal(authFailed.status, 500);
  assert.deepEqual(await authFailed.json(), { error: 'AUTHENTICATION_FAILED' });
  assert.equal(await countRows(db, 'leaderboard_transactions', 'player_id', 'player-5'), 1);
  // A bare access token is not enough: the identity service's confirmation
  // is required, must be this player's, and is used once.
  for (const headers of [
    { authorization: 'Bearer player-5-token' },
    { authorization: 'Bearer player-5-token', 'x-mpgd-account-deletion-confirmation': 'forged' },
    { authorization: 'Bearer player-5-token', 'x-mpgd-account-deletion-confirmation': 'confirm-2' },
  ]) {
    const unconfirmed = await post(route, headers);
    assert.equal(unconfirmed.status, 403);
    assert.deepEqual(await unconfirmed.json(), { error: 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED' });
  }
  for (const confirmation of ['', 'x'.repeat(accountDeletionConfirmationMaxLength + 1)]) {
    assert.equal(
      (await post(route, {
        authorization: 'Bearer player-5-token',
        'x-mpgd-account-deletion-confirmation': confirmation,
      })).status,
      403,
      `confirmation of ${confirmation.length} characters`,
    );
  }
  assert.equal(confirmations.get('confirm-2'), 'player-2', "another player's attempt keeps it");
  // Only `{ confirmed: true }` confirms; a verifier that throws erases nothing.
  for (const answer of [{ confirmed: 'true' }, null, undefined, {}]) {
    const loose = createWorkerFetchHandler(
      env({
        GAME_SERVICES_ACCOUNT_DELETION: {
          deletePlayer: async ({ playerId }) => void deleted.push(playerId),
          verifyAccountDeletionConfirmation: async () => answer as never,
        },
      }),
    );
    assert.equal(
      (await post(loose, {
        authorization: 'Bearer player-5-token',
        'x-mpgd-account-deletion-confirmation': 'confirm-5a',
      })).status,
      403,
      JSON.stringify(answer),
    );
  }
  {
    const throwingVerifier = createWorkerFetchHandler(
      env({
        GAME_SERVICES_ACCOUNT_DELETION: {
          deletePlayer: async ({ playerId }) => void deleted.push(playerId),
          verifyAccountDeletionConfirmation: () => Promise.reject(new Error('identity down')),
        },
      }),
    );
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      const failed = await post(throwingVerifier, {
        authorization: 'Bearer player-5-token',
        'x-mpgd-account-deletion-confirmation': 'confirm-5a',
      });
      assert.equal(failed.status, 500);
      assert.deepEqual(await failed.json(), { error: 'ACCOUNT_DELETION_FAILED', retryable: true });
    } finally {
      console.error = consoleError;
    }
  }
  assert.deepEqual(deleted, [], 'nothing deleted without a confirmation');
  assert.equal(await countRows(db, 'leaderboard_transactions', 'player_id', 'player-5'), 1);
  assert.match(
    preflight.headers.get('Access-Control-Allow-Headers') ?? '',
    /x-mpgd-account-deletion-confirmation/iu,
  );
  const ok = await post(route, {
    authorization: 'Bearer player-5-token',
    'x-mpgd-account-deletion-confirmation': 'confirm-5a',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  const okReceipt = await ok.json() as AccountDeletionReceipt;
  assert.equal(okReceipt.status, 'deleted');
  assert.equal(okReceipt.retainedPurchaseRecords, 4);
  assert.deepEqual(deleted, ['player-5']);
  assert.equal(await countRows(db, 'notification_endpoints', 'player_id', 'player-5'), 0);
  // The confirmation was used up.
  assert.equal(
    (await post(route, {
      authorization: 'Bearer player-5-token',
      'x-mpgd-account-deletion-confirmation': 'confirm-5a',
    })).status,
    403,
  );
  // A retry with a new confirmation after success deletes nothing more.
  const retry = await post(route, {
    authorization: 'Bearer player-5-token',
    'x-mpgd-account-deletion-confirmation': 'confirm-5b',
  });
  assert.equal((await retry.json() as AccountDeletionReceipt).retainedPurchaseRecords, 0);

  // --- Late writes: the tombstone refuses them after the final pass ---------
  {
    // Only the keyed hash of the id is kept, with its expiry.
    const tombstoneRows = (await db.prepare('SELECT * FROM account_deletion_tombstones').all<{
      player_key: string;
    }>()).results;
    assert.deepEqual(
      tombstoneRows.map((row) => row.player_key),
      [await accountDeletionTombstoneKeyOf(tombstoneKey, 'player-5')],
    );
    assert.ok(!JSON.stringify(tombstoneRows).includes('player-5'));
    // The cron's final pass (16 minutes on) clears the pending erasure.
    const lateEnv = env({
      GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: {
        async verifyPurchase(input) {
          return {
            status: 'verified',
            verificationId: `play:${input.request.idempotencyKey}`,
            verifiedAt: new Date().toISOString(),
          };
        },
        async verifyAdReward(input) {
          return {
            status: 'verified',
            verificationId: `admob:ssv:${input.request.idempotencyKey}`,
            verifiedAt: new Date().toISOString(),
          };
        },
      },
      GAME_SERVICES_ANDROID_PURCHASE_FINALIZER: {
        async finalizePurchaseGrant() {
          return { status: 'completed', action: 'consume', alreadyCompleted: false };
        },
      },
    });
    const tombstones = required(resolveAccountDeletionTombstones(lateEnv));
    const consoleInfo = console.info;
    console.info = () => undefined;
    try {
      await runScheduledAccountDeletion({
        db,
        tombstones,
        erasers: [createAccountDeletionTombstoneEraser(tombstones), createD1PlayerDataEraser(db)],
        pending: createD1PendingAccountErasureStore(db),
        audit: createD1AccountDeletionAudit(db),
        now: () => new Date(Date.now() + 16 * 60 * 1000),
      });
    } finally {
      console.info = consoleInfo;
    }
    assert.equal(await countRows(db, 'account_deletion_pending', 'player_id', 'player-5'), 0);
    // A request that authenticated before the deletion (the ingress stub still
    // answers player-5) writes afterwards: a purchase grant (and so its Play
    // finalization), a score, a verified attempt, and notification rows are
    // all refused (AdMob SSV callbacks: deletionTombstones.test.ts).
    const late = createWorkerService(lateEnv);
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const refusedPurchase = await late.verifyPurchase({
        target: 'android',
        playerId: 'player-5',
        productId: 'COINS_100',
        platformTransactionId: 'late-purchase',
        idempotencyKey: 'late-purchase',
        purchasedAt: new Date().toISOString(),
      }).catch((error: unknown) => error);
      assert.notEqual((refusedPurchase as { readonly verified?: unknown }).verified, true);
    } finally {
      console.error = quiet;
    }
    await assert.rejects(
      late.recordLeaderboardScore({
        target: 'browser',
        leaderboardId: 'daily',
        playerId: 'player-5',
        score: 1,
        runId: 'late-run',
        submittedAt: new Date().toISOString(),
      }),
      AccountDeletedWriteError,
    );
    await assert.rejects(
      late.recordVerifiedAttempt({
        definition: { leaderboardId: 'speedrun', scoreOrder: 'ascending', attemptSelection: 'best' },
        attempt: {
          attemptId: 'late-attempt',
          participantId: 'player-5',
          score: 1,
          completedAt: new Date().toISOString(),
          verification: {
            authorityId: 'game-server',
            evidenceId: 'late',
            verifiedAt: new Date().toISOString(),
          },
        },
      }),
      AccountDeletedWriteError,
    );
    const notifications = refuseDeletedNotificationWrites(lateEnv, createD1NotificationStore(db));
    await assert.rejects(
      notifications.appendConsent({
        player: 'player-5',
        record: { kind: 'advertising', state: 'granted', source: 'player', evidence: { textVersion: '1', channel: 'in-game' } } as never,
        at: new Date().toISOString(),
      }),
      AccountDeletedWriteError,
    );
    await assert.rejects(
      notifications.createSend({
        key: 'late-send',
        fingerprint: 'fingerprint',
        request: { idempotencyKey: 'late-send', player: 'player-5', topic: 'daily-ready' },
        origin: 'server',
        scheduled: false,
        rows: [],
        changedAt: new Date().toISOString(),
      } as never),
      AccountDeletedWriteError,
    );
    for (const [table, column] of playerTables) {
      assert.equal(await countRows(db, table, column, 'player-5'), 0, `${table} after late writes`);
    }
    // Another player still writes, through the same paths.
    const before = await countRows(db, 'entitlement_transactions', 'player_id', 'player-2');
    const live = await late.verifyPurchase({
      target: 'android',
      playerId: 'player-2',
      productId: 'COINS_100',
      platformTransactionId: 'live-purchase',
      idempotencyKey: 'live-purchase',
      purchasedAt: new Date().toISOString(),
    });
    assert.equal((live as { readonly verified?: unknown }).verified, true);
    assert.equal(
      await countRows(db, 'entitlement_transactions', 'player_id', 'player-2'),
      before + 1,
    );
    assert.ok(
      (await late.recordLeaderboardScore({
        target: 'browser',
        leaderboardId: 'daily',
        playerId: 'player-2',
        score: 2,
        runId: 'live-run',
        submittedAt: new Date().toISOString(),
      })) !== undefined,
    );
  }

  // Without the identity binding the route refuses instead of leaving sessions alive.
  const withoutIdentity = createWorkerFetchHandler(env({}, ['GAME_SERVICES_ACCOUNT_DELETION']));
  const refused = await post(withoutIdentity, { authorization: 'Bearer player-5-token' });
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: 'ACCOUNT_DELETION_NOT_CONFIGURED' });
  // Without any session binding it never deletes a body-named player.
  const unauthenticated = createWorkerFetchHandler(env({}, ['GAME_SERVICES_INGRESS_AUTH']));
  assert.equal(
    (await post(unauthenticated, {}, JSON.stringify({ playerId: 'player-2' }))).status,
    503,
  );
  // A failing store is a retryable 500.
  const failing = createWorkerFetchHandler(
    env({
      GAME_SERVICES_ACCOUNT_DELETION: {
        deletePlayer: () => Promise.reject(new Error('identity unavailable')),
        verifyAccountDeletionConfirmation: async () => ({ confirmed: true }),
      },
    }),
  );
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    const failed = await post(failing, {
      authorization: 'Bearer player-5-token',
      'x-mpgd-account-deletion-confirmation': 'confirm-5c',
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'ACCOUNT_DELETION_FAILED', retryable: true });
  } finally {
    console.error = consoleError;
  }

  // --- Local development: memory stores and development sessions -----------
  const local: GameServicesWorkerEnv = {
    MPGD_STORE: 'memory',
    MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS: 'true',
  };
  const localService = createWorkerService(local);
  const score = {
    target: 'browser',
    leaderboardId: 'daily',
    playerId: 'p-dev',
    score: 5,
    runId: 'run-1',
    submittedAt: '2026-10-25T00:00:00.000Z',
  } as const;
  await localService.recordLeaderboardScore(score);
  assert.equal(
    (await localService.recordLeaderboardScore(score) as { alreadyProcessed: boolean })
      .alreadyProcessed,
    true,
  );
  const localRoute = createWorkerFetchHandler(local);
  const devSession = { authorization: 'Bearer mpgd-dev.p-dev.s-dev.i-dev' };
  assert.equal(
    (await post(localRoute, devSession, '{}', 'https://game-services.example')).status,
    401,
    'development sessions only on a local host',
  );
  const consoleInfo = console.info;
  console.info = () => undefined;
  try {
    assert.equal((await post(localRoute, devSession, '{}', 'http://localhost:8787')).status, 200);
    // A development session needs no confirmation, even with the binding.
    const boundLocal = createWorkerFetchHandler({
      ...local,
      GAME_SERVICES_ACCOUNT_DELETION: {
        deletePlayer: async () => undefined,
        verifyAccountDeletionConfirmation: () => Promise.reject(new Error('not called')),
      },
    });
    assert.equal((await post(boundLocal, devSession, '{}', 'http://localhost:8787')).status, 200);
  } finally {
    console.info = consoleInfo;
  }
  // The memory deployment keeps its tombstones too: the deleted player writes nothing more.
  await assert.rejects(localService.recordLeaderboardScore(score), AccountDeletedWriteError);
} finally {
  await miniflare.dispose();
}

console.info('Account deletion Worker tests passed.');

function required<Value>(value: Value | undefined): Value {
  assert.ok(value !== undefined);
  return value;
}

function withoutKeys<Value extends object>(value: Value, keys: readonly (keyof Value)[]): Value {
  const copy = { ...value };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

/** Seeds a row for the player in every table that keys a player. */
async function seedPlayer(db: D1Database, player: string): Promise<void> {
  const store = createD1GameServicesStore(db);
  // Store ids never contain the player id; the kept rows keep them.
  const n = player.replace('player-', '');
  const purchase = await store.recordEntitlementGrant({
    source: 'purchase',
    playerId: player,
    grantId: 'COINS_100',
    idempotencyKey: `purchase:ios:${player}:COINS_100:run-1`,
    grantedAt: '2026-10-20T00:00:00.000Z',
    grant: { type: 'currency', currency: 'coin', amount: 100 },
    evidenceVerificationId: `app-store:Production:com.example.game:tx-${n}`,
    payload: {
      target: 'ios',
      store: 'app-store',
      platformTransactionId: `tx-${n}`,
      playerId: player,
    },
  });
  const revocation = await required(store.recordEntitlementRevocation).call(store, {
    playerId: player,
    revokesLedgerEntryId: purchase.ledgerEntryId,
    idempotencyKey: `app-store:notification:refund-${n}`,
    reason: 'refund',
    revokedAt: '2026-10-21T00:00:00.000Z',
    payload: { notificationType: 'REFUND' },
  });
  await required(store.recordEntitlementNote).call(store, {
    noteId: `app-store:notification:reversed-${n}`,
    kind: 'refund_reversed',
    playerId: player,
    ledgerEntryId: purchase.ledgerEntryId,
    revocationLedgerEntryId: revocation.ledgerEntryId,
    recordedAt: '2026-10-22T00:00:00.000Z',
    payload: {},
  });
  const purchaseToken = `token-${n}`;
  const play = await store.recordEntitlementGrant({
    source: 'purchase',
    playerId: player,
    grantId: 'COINS_100',
    idempotencyKey: `purchase:android:${player}:COINS_100:run-2`,
    grantedAt: '2026-10-23T00:00:00.000Z',
    grant: { type: 'currency', currency: 'coin', amount: 100 },
    evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, purchaseToken),
    payload: {
      target: 'android',
      store: 'google-play',
      productId: 'COINS_100',
      productType: 'consumable',
      platformProductId: 'coins_100',
      platformTransactionId: `GPA.${n}`,
      purchasedAt: '2026-10-23T00:00:00.000Z',
      googlePlayPackageName: packageName,
      googlePlayObfuscatedExternalAccountId: `obfuscated-${n}`,
    },
  });
  await db.prepare(`INSERT INTO google_play_pending_finalizations (
      ledger_entry_id, player_id, purchase_token, first_seen_at_ms, next_attempt_at_ms, attempts
    ) VALUES (?, ?, ?, ?, ?, 0)`)
    .bind(play.ledgerEntryId, player, purchaseToken, Date.now(), Date.now())
    .run();
  await store.recordEntitlementGrant({
    source: 'ad_reward',
    playerId: player,
    grantId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: `rewarded-ad:android:${player}:CONTINUE_AFTER_FAIL:run-3`,
    grantedAt: '2026-10-21T00:00:00.000Z',
    payload: { target: 'android', platformImpressionId: `impression-${player}` },
  });
  await store.recordLeaderboardScore({
    target: 'browser',
    leaderboardId: 'daily',
    playerId: player,
    score: 10,
    runId: 'run-1',
    submittedAt: '2026-10-20T00:00:00.000Z',
  });
  await db.prepare(`INSERT INTO admob_ssv_callbacks (
      transaction_id, target, player_id, placement_id, idempotency_key, callback_url,
      accepted_ad_unit, key_id, public_key_spki, received_at
    ) VALUES (?, 'android', ?, 'CONTINUE_AFTER_FAIL', ?, 'https://example/ssv', 'unit', 'k', 'spki', ?)`)
    .bind(`ssv-${player}`, player, `ssv-key-${player}`, '2026-10-21T00:00:00.000Z')
    .run();
  await createD1VerifiedLeaderboardService(db, { now: () => '2026-10-20T00:00:00.000Z' })
    .recordVerifiedAttempt({
      definition: { leaderboardId: 'speedrun', scoreOrder: 'ascending', attemptSelection: 'best' },
      attempt: {
        attemptId: `attempt-${player}`,
        participantId: player,
        participantLabel: player,
        score: 30,
        completedAt: '2026-10-20T00:00:00.000Z',
        verification: {
          authorityId: 'game-server',
          evidenceId: `evidence-${player}`,
          verifiedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    });
  const notifications = createD1NotificationStore(db);
  await notifications.appendConsent({
    player,
    record: {
      kind: 'advertising',
      state: 'granted',
      source: 'player',
      evidence: { textVersion: '1', channel: 'in-game' },
    } as never,
    at: '2026-10-20T00:00:00.000Z',
  });
  await notifications.putEndpoint({
    provider: 'fcm',
    installationId: `installation-${player}`,
    player,
    address: { kind: 'fcm-token', value: `fcm-${player}` },
    permission: 'granted',
    sessionId: `session-${player}`,
    lastRegisteredAt: '2026-10-20T00:00:00.000Z',
  } as never);
  await notifications.putPlatformRegistration({
    player,
    provider: 'ait-functional',
    locale: 'ko-KR',
    registeredAt: '2026-10-20T00:00:00.000Z',
  });
  await notifications.addNoticeGiven({
    player,
    kind: 'consent-result',
    record: { kind: 'advertising', at: '2026-10-20T00:00:00.000Z' },
    dueBy: '2026-11-03',
    channel: 'in-game',
    at: '2026-10-20T00:00:01.000Z',
  } as never);
  await notifications.createSend({
    key: `send-${player}`,
    fingerprint: 'fingerprint',
    request: { idempotencyKey: `send-${player}`, player, topic: 'daily-ready' },
    origin: 'server',
    scheduled: false,
    rows: [],
    changedAt: '2026-10-20T00:00:00.000Z',
  } as never);
  await notifications.addHistory({
    sendKey: `send-${player}`,
    provider: 'fcm',
    player,
    topic: 'daily-ready',
    at: '2026-10-20T00:00:00.000Z',
  });
  await notifications.createScheduleEntry({
    player,
    id: 'reminder:daily',
    dueAt: '2026-10-21T00:00:00.000Z',
    item: { kind: 'reminder' },
  } as never);
}

/** Every table with a player_id or participant_id column, and that column. */
async function listPlayerTables(db: D1Database): Promise<Map<string, string>> {
  const tables = (await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`)
    .all<{ name: string }>()).results;
  const found = new Map<string, string>();
  for (const { name } of tables) {
    const columns = (await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>()).results;
    const column = columns.find((candidate) =>
      candidate.name === 'player_id' || candidate.name === 'participant_id',
    );
    if (column !== undefined) {
      found.set(name, column.name);
    }
  }
  return found;
}

async function countRows(db: D1Database, table: string, column: string, value: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ n: number }>())?.n ?? 0;
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

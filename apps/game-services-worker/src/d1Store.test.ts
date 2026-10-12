import { readFile } from 'node:fs/promises';

import {
  EvidenceAlreadyProcessedError,
  listActiveEntitlementTransactions,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
  type EntitlementLedgerGrant,
  type EntitlementLedgerRevocation,
} from '@mpgd/game-services';
import { Miniflare } from 'miniflare';

import { createD1GameServicesStore } from './d1Store.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: {
    DB: 'game-services-store',
  },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  await applyMigration(db, '0001_game_services.sql');
  await insertHistoricalEntitlement(db, {
    ledgerEntryId: 'ledger-historical-purchase',
    source: 'purchase',
    idempotencyKey: 'historical-purchase',
    payload: {
      target: 'android',
      platformTransactionId: 'historical-platform-transaction',
    },
  });
  await insertHistoricalEntitlement(db, {
    ledgerEntryId: 'ledger-historical-reward',
    source: 'ad_reward',
    idempotencyKey: 'historical-reward',
    payload: {
      target: 'android',
      platformImpressionId: 'historical-platform-impression',
    },
  });
  await insertHistoricalEntitlement(db, {
    ledgerEntryId: 'ledger-payload-evidence',
    source: 'purchase',
    idempotencyKey: 'historical-payload-evidence',
    payload: {
      target: 'android',
      platformTransactionId: 'historical-payload-transaction',
      evidenceVerificationId: 'provider:historical-payload-evidence',
    },
  });
  await applyMigration(db, '0004_entitlement_evidence.sql');

  const store = createD1GameServicesStore(db);
  const backfilled = await store.findEntitlementTransactionByEvidenceVerificationId?.({
    source: 'purchase',
    evidenceVerificationId: 'provider:historical-payload-evidence',
  });
  const historicalPurchase = await store.findEntitlementTransactionByPlatformEvidence?.({
    source: 'purchase',
    target: 'android',
    platformEvidenceId: 'historical-platform-transaction',
  });
  const historicalReward = await store.findEntitlementTransactionByPlatformEvidence?.({
    source: 'ad_reward',
    target: 'android',
    platformEvidenceId: 'historical-platform-impression',
  });

  assertEqual(
    backfilled?.evidenceVerificationId,
    'provider:historical-payload-evidence',
    'migration should backfill payload evidence identities',
  );
  assertEqual(
    historicalPurchase?.ledgerEntryId,
    'ledger-historical-purchase',
    'D1 should find historical purchase platform evidence',
  );
  assertEqual(
    historicalReward?.ledgerEntryId,
    'ledger-historical-reward',
    'D1 should find historical reward platform evidence',
  );

  const historicalCount = (await store.listEntitlementTransactions()).length;
  let historicalReplayRejected = false;
  try {
    await store.recordEntitlementGrant({
      playerId: 'd1-historical-replay',
      grantId: 'COINS_100',
      source: 'purchase',
      idempotencyKey: 'd1-historical-replay',
      grantedAt: '2026-07-14T00:00:00.000Z',
      evidenceVerificationId: 'provider:new-authority-for-historical-purchase',
      payload: {
        target: 'android',
        platformTransactionId: 'historical-platform-transaction',
      },
    });
  } catch (error) {
    historicalReplayRejected = error instanceof EvidenceAlreadyProcessedError;
  }
  assertEqual(
    historicalReplayRejected,
    true,
    'D1 should reject replayed platform evidence from pre-migration grants',
  );
  assertEqual(
    (await store.listEntitlementTransactions()).length,
    historicalCount,
    'historical D1 replay rejection should not create another grant',
  );

  const grant = {
    playerId: 'd1-player',
    grantId: 'COINS_100',
    source: 'purchase',
    idempotencyKey: 'd1-purchase-1',
    grantedAt: '2026-07-14T00:00:00.000Z',
    evidenceVerificationId: 'provider:d1-purchase',
    payload: {
      target: 'android',
      evidenceVerificationId: 'provider:d1-purchase',
    },
  } as const satisfies EntitlementLedgerGrant;

  const recorded = await store.recordEntitlementGrant(grant);
  const duplicate = await store.recordEntitlementGrant({
    ...grant,
    payload: { changedEvidencePayload: true },
  });
  const stored = await store.findEntitlementTransactionByIdempotency?.({
    source: grant.source,
    playerId: grant.playerId,
    idempotencyKey: grant.idempotencyKey,
  });

  assertEqual(recorded.alreadyProcessed, false, 'first D1 grant should be recorded');
  assertEqual(duplicate.alreadyProcessed, true, 'D1 idempotency retry should return the ledger');
  assertEqual(
    stored?.evidenceVerificationId,
    grant.evidenceVerificationId,
    'D1 should retain the authority verification identity',
  );

  let replayRejected = false;
  try {
    await store.recordEntitlementGrant({
      ...grant,
      playerId: 'd1-replay-player',
      idempotencyKey: 'd1-purchase-2',
    });
  } catch (error) {
    replayRejected = error instanceof EvidenceAlreadyProcessedError;
  }

  assertEqual(replayRejected, true, 'D1 should reject reused verification identities');
  assertEqual(
    (await store.listEntitlementTransactions()).length,
    historicalCount + 1,
    'D1 replay rejection should not create another grant',
  );

  // Commerce v2 C2: revoke entries (migration 0006) and the ledger status read.
  await applyMigration(db, '0006_entitlement_revocations.sql');
  const activeBefore = await readPurchaseLedgerStatuses(store, {
    ledgerEntryIds: [recorded.ledgerEntryId, 'ledger-historical-purchase', 'missing'],
    playerId: grant.playerId,
  });
  assertEqual(
    JSON.stringify(activeBefore.statuses.map((status) => status.status)),
    JSON.stringify(['active', 'unknown', 'unknown']),
    "D1 should answer active for the player's grants without a revoke entry",
  );
  const revocation = {
    playerId: grant.playerId,
    revokesLedgerEntryId: recorded.ledgerEntryId,
    idempotencyKey: 'd1-purchase-1:refund',
    reason: 'refund',
    revokedAt: '2026-07-15T00:00:00.000Z',
    payload: { target: 'android', platformTransactionId: 'd1-purchase-1' },
    evidenceVerificationId: 'provider:d1-purchase:refund',
  } as const satisfies EntitlementLedgerRevocation;
  const revoked = await revokeEntitlementGrant(store, revocation);
  assertEqual(revoked.status, 'revoked', 'D1 should append the revoke entry');
  const revokeEntryId = revoked.status === 'revoked' ? revoked.ledgerEntryId : '';
  const replayedRevocation = await revokeEntitlementGrant(store, revocation);
  assertEqual(
    JSON.stringify(replayedRevocation),
    JSON.stringify({ status: 'revoked', ledgerEntryId: revokeEntryId, alreadyProcessed: true }),
    'a replayed notification key should answer the first revoke entry',
  );
  const secondRevocation = await revokeEntitlementGrant(store, {
    ...revocation,
    idempotencyKey: 'd1-purchase-1:chargeback',
    reason: 'chargeback',
    evidenceVerificationId: 'provider:d1-purchase:chargeback',
  });
  assertEqual(
    JSON.stringify(secondRevocation),
    JSON.stringify({ status: 'revoked', ledgerEntryId: revokeEntryId, alreadyProcessed: true }),
    'a grant is reversed once; a second revocation answers the first entry',
  );
  assertEqual(
    JSON.stringify(await revokeEntitlementGrant(store, {
      ...revocation,
      revokesLedgerEntryId: 'missing',
      idempotencyKey: 'missing:refund',
    })),
    JSON.stringify({ status: 'grant_not_found' }),
    'a revoke entry needs an existing grant',
  );
  const otherGrant = await store.recordEntitlementGrant({
    ...grant,
    idempotencyKey: 'd1-purchase-3',
    evidenceVerificationId: 'provider:d1-purchase-3',
    payload: { target: 'android', evidenceVerificationId: 'provider:d1-purchase-3' },
  });
  assertEqual(
    JSON.stringify(await revokeEntitlementGrant(store, {
      ...revocation,
      revokesLedgerEntryId: otherGrant.ledgerEntryId,
      evidenceVerificationId: 'provider:d1-purchase-3:refund',
    })),
    JSON.stringify({ status: 'key_conflict' }),
    'a notification key that reversed one grant cannot reverse another',
  );
  assertEqual(
    JSON.stringify(await revokeEntitlementGrant(store, {
      ...revocation,
      revokesLedgerEntryId: otherGrant.ledgerEntryId,
      idempotencyKey: 'd1-purchase-3:refund',
    })),
    JSON.stringify({ status: 'evidence_already_processed' }),
    'a reused authority identity is a replay, never a second reversal',
  );
  const batched = await store.getEntitlementTransactions?.([
    recorded.ledgerEntryId,
    otherGrant.ledgerEntryId,
    'missing',
    recorded.ledgerEntryId,
  ]);
  assertEqual(batched?.length, 2, 'D1 reads grants in one batched query per chunk');
  const revocations = await store.findEntitlementRevocations?.({
    ledgerEntryIds: [recorded.ledgerEntryId, 'ledger-historical-purchase'],
  });
  assertEqual(revocations?.length, 1, 'D1 should list the revoke entry by its grant');
  assertEqual(revocations?.[0]?.reason, 'refund', 'D1 should keep the first revocation reason');
  assertEqual(
    revocations?.[0]?.evidenceVerificationId,
    'provider:d1-purchase:refund',
    'D1 should retain the notification authority identity',
  );
  const statusAfter = await readPurchaseLedgerStatuses(store, {
    ledgerEntryIds: [recorded.ledgerEntryId, 'ledger-historical-purchase'],
    playerId: grant.playerId,
  });
  assertEqual(
    JSON.stringify(statusAfter.statuses),
    JSON.stringify([
      { ledgerEntryId: recorded.ledgerEntryId, status: 'reversed', reversedBy: revokeEntryId },
      { ledgerEntryId: 'ledger-historical-purchase', status: 'unknown' },
    ]),
    'D1 ledger status should name the reversing entry',
  );
  assertEqual(
    (await store.listEntitlementTransactions()).length,
    historicalCount + 2,
    'the revoke entries must not remove any grant row',
  );
  assertEqual(
    (await listActiveEntitlementTransactions(store)).some(
      (entry) => entry.ledgerEntryId === recorded.ledgerEntryId,
    ),
    false,
    'entitlement reads subtract the reversed grant',
  );
} finally {
  await miniflare.dispose();
}

console.log('D1 entitlement evidence idempotency smoke passed');

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  await db.exec(toD1ExecScript(migration));
}

async function insertHistoricalEntitlement(
  db: D1Database,
  input: {
    readonly ledgerEntryId: string;
    readonly source: EntitlementLedgerGrant['source'];
    readonly idempotencyKey: string;
    readonly payload: EntitlementLedgerGrant['payload'];
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entitlement_transactions (
        ledger_entry_id,
        player_id,
        grant_id,
        source,
        idempotency_key,
        granted_at,
        grant_json,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.ledgerEntryId,
      'historical-player',
      'historical-grant',
      input.source,
      input.idempotencyKey,
      '2026-07-13T00:00:00.000Z',
      null,
      JSON.stringify(input.payload),
    )
    .run();
}

function toD1ExecScript(migration: string): string {
  return migration
    .split(/\n\s*\n/u)
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement.length > 0)
    .join('\n');
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

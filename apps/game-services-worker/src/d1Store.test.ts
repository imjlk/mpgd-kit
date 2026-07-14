import { readFile } from 'node:fs/promises';

import {
  EvidenceAlreadyProcessedError,
  type EntitlementLedgerGrant,
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

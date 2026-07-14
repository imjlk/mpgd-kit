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
  for (const name of ['0001_game_services.sql', '0003_entitlement_evidence.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await db.exec(toD1ExecScript(migration));
  }

  const store = createD1GameServicesStore(db);
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
  const stored = await store.findEntitlementTransactionByIdempotency({
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
    1,
    'D1 replay rejection should not create another grant',
  );
} finally {
  await miniflare.dispose();
}

console.log('D1 entitlement evidence idempotency smoke passed');

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

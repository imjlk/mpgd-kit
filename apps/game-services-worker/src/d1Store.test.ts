import { readFile } from 'node:fs/promises';

import {
  createGameServicesBackend,
  EvidenceAlreadyProcessedError,
  listActiveEntitlementTransactions,
  listPurchaseHolders,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
  type EntitlementLedgerGrant,
  type EntitlementLedgerRevocation,
  type GameServicesEvidenceVerifier,
  type VerifyPurchaseRequest,
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

  await runRestoreSharingScenario(db, store);
} finally {
  await miniflare.dispose();
}

console.log('D1 entitlement evidence idempotency smoke passed');

// A replica SELECT after INSERT OR IGNORE must not miss the row this request
// just wrote. The default binding misses; only the first-primary session sees it.
const replicaLag = createReplicaLagEntitlementDatabase();
const replicaStore = createD1GameServicesStore(replicaLag.db);
const replicaGrant = {
  playerId: 'replica-player',
  grantId: 'COINS_100',
  source: 'purchase',
  idempotencyKey: 'replica-purchase',
  grantedAt: '2026-07-14T00:00:00.000Z',
  payload: { target: 'android' },
} as const satisfies EntitlementLedgerGrant;
const replicaRecorded = await replicaStore.recordEntitlementGrant(replicaGrant);
assertEqual(
  replicaRecorded.alreadyProcessed,
  false,
  'a primary-session read-back must see the entitlement row the insert just wrote',
);
assertEqual(
  replicaLag.sessionConstraint,
  'first-primary',
  'the grant insert and read-back must share a first-primary D1 session',
);
console.log('D1 entitlement primary-session read-back smoke passed');

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

/**
 * Restore sharing on D1: no table of its own (unique evidence ids and keys
 * on the grants), so the holder cap must hold when isolates race, a refund
 * must reach every holder, and retries must be idempotent per guest.
 */
async function runRestoreSharingScenario(
  db: D1Database,
  store: ReturnType<typeof createD1GameServicesStore>,
): Promise<void> {
  const verificationId = 'google-play:product:d1-sharing-digest';
  const verifier: GameServicesEvidenceVerifier = {
    async verifyPurchase({ request }) {
      const verified = {
        verificationId,
        verifiedAt: '2030-01-01T00:00:00.000Z',
        platformEvidenceId: 'GPA.d1-sharing',
      };
      return request.playerId === 'd1-buyer'
        ? { status: 'verified', ...verified }
        : { status: 'restorable', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', ...verified };
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'UNUSED' };
    },
  };
  const backendFor = (ledger: ReturnType<typeof createD1GameServicesStore>) =>
    createGameServicesBackend({
      catalog: {
        version: 'd1-sharing',
        products: [
          {
            id: 'REMOVE_ADS',
            type: 'non_consumable',
            grant: { type: 'entitlement', entitlement: 'remove_ads' },
            platformProductIds: { android: 'remove_ads_android' },
          },
        ],
      },
      placements: { version: 'd1-sharing', placements: [] },
      store: ledger,
      evidenceVerifier: verifier,
      restoreSharing: { mode: 'share', maxHolders: 3 },
    });
  const request = (playerId: string, intent: 'purchase' | 'restore'): VerifyPurchaseRequest => ({
    target: 'android',
    playerId,
    productId: 'REMOVE_ADS',
    platformTransactionId: 'GPA.d1-sharing',
    idempotencyKey: `d1-sharing:${playerId}`,
    purchasedAt: '2030-01-01T00:00:00.000Z',
    intent,
  });
  const backend = backendFor(store);
  const bought = await backend.purchases.verifyPurchase(request('d1-buyer', 'purchase'));
  assertEqual(bought.verified, true, 'D1 grants the buyer');
  const shared = await backend.purchases.verifyPurchase(request('d1-guest-1', 'restore'));
  assertEqual(shared.restoredAcrossPlayers, true, 'D1 shares the restored non-consumable');
  const replay = await backend.purchases.verifyPurchase({
    ...request('d1-guest-1', 'restore'),
    idempotencyKey: 'd1-sharing:another-key',
  });
  assertEqual(
    replay.ledgerEntryId,
    shared.ledgerEntryId,
    'a D1 retry of the guest answers its share',
  );
  assertEqual(
    (await readPurchaseLedgerStatuses(store, {
      playerId: 'd1-buyer',
      ledgerEntryIds: [bought.ledgerEntryId ?? ''],
    })).statuses[0]?.status,
    'active',
    'the buyer keeps its grant on D1',
  );

  // Three isolates race for the last free slot: one share lands, the cap holds.
  const answers = await Promise.all(
    ['d1-guest-2', 'd1-guest-3', 'd1-guest-4'].map((playerId) =>
      backendFor(createD1GameServicesStore(db)).purchases.verifyPurchase(
        request(playerId, 'restore'),
      ),
    ),
  );
  assertEqual(
    answers.filter((answer) => answer.verified).length,
    1,
    'one racing restore takes the last slot',
  );
  assertEqual(
    answers.filter((answer) => answer.reason === 'PURCHASE_HOLDER_LIMIT_REACHED').length,
    2,
    'the others answer the holder limit',
  );
  const holders = await listPurchaseHolders(store, verificationId);
  assertEqual(holders.shared.length, 2, 'D1 keeps two shares next to the first grant');

  // A refund naming the first grant revokes every holder.
  const refund = await revokeEntitlementGrant(store, {
    playerId: 'd1-buyer',
    revokesLedgerEntryId: bought.ledgerEntryId ?? '',
    idempotencyKey: 'google-play:voided:d1-sharing',
    reason: 'refund',
    revokedAt: '2030-01-03T00:00:00.000Z',
    payload: { target: 'android' },
    evidenceVerificationId: `${verificationId}:revoke`,
  });
  assertEqual(refund.status, 'revoked', 'the refund applies on D1');
  assertEqual(
    (await listActiveEntitlementTransactions(store)).some((entry) => entry.grantId === 'REMOVE_ADS'),
    false,
    'a refund on D1 revokes every holder',
  );
  const afterRefund = await backend.purchases.verifyPurchase(request('d1-late', 'restore'));
  assertEqual(afterRefund.reason, 'LEDGER_GRANT_REVERSED', 'a refunded purchase is never shared');
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/**
 * Default binding reads miss a row this request just inserted. The session
 * created with `first-primary` is the only connection that can see it.
 */
function createReplicaLagEntitlementDatabase(): {
  readonly db: D1Database;
  sessionConstraint: string | undefined;
} {
  const inserted = new Map<string, {
    ledger_entry_id: string;
    player_id: string;
    grant_id: string;
    source: EntitlementLedgerGrant['source'];
    idempotency_key: string;
    granted_at: string;
    grant_json: string | null;
    payload_json: string;
    evidence_verification_id: string | null;
  }>();
  const state: { sessionConstraint: string | undefined } = { sessionConstraint: undefined };

  const prepare = (query: string, session: boolean) => {
    let bound: readonly unknown[] = [];
    const statement = {
      bind(...values: readonly unknown[]) {
        bound = values;
        return statement;
      },
      async run() {
        if (session && query.includes('INSERT')) {
          inserted.set(String(bound[4]), {
            ledger_entry_id: String(bound[0]),
            player_id: String(bound[1]),
            grant_id: String(bound[2]),
            source: bound[3] as EntitlementLedgerGrant['source'],
            idempotency_key: String(bound[4]),
            granted_at: String(bound[5]),
            grant_json: bound[6] === null ? null : String(bound[6]),
            payload_json: String(bound[7]),
            evidence_verification_id: bound[8] === null || bound[8] === undefined
              ? null
              : String(bound[8]),
          });
        }
        return { success: true as const, meta: { changes: 1 }, results: [] };
      },
      async first() {
        if (!session || !query.includes('idempotency_key')) {
          return null;
        }
        return inserted.get(String(bound[2])) ?? null;
      },
      async all() {
        return { success: true as const, meta: {}, results: [] };
      },
    };
    return statement;
  };

  return {
    db: {
      prepare: (query: string) => prepare(query, false),
      withSession(constraint?: string) {
        state.sessionConstraint = constraint;
        return { prepare: (query: string) => prepare(query, true) };
      },
    } as unknown as D1Database,
    get sessionConstraint() {
      return state.sessionConstraint;
    },
  };
}

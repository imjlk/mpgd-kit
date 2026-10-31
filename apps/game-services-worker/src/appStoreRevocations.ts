import {
  answerAppStoreRevocationLookup,
  AppStoreDependencyUnavailableError,
  createInMemoryAppStoreRevocationRegistry,
  type AppStoreRevocationLookupAnswer,
  type AppStoreRevocationLookupRequest,
  type AppStoreRevocationReason,
  type AppStoreRevocationRecord,
  type AppStoreRevocationRegistry,
} from '@mpgd/game-services';

/**
 * The App Store revocation registry of the reference Worker (migration
 * 0011_app_store_revocations.sql): every `REFUND` and `REVOKE` the App Store
 * Server Notifications route verified, kept per environment and grant
 * verification id, so an `offline-only` App Store purchase verifier refuses
 * a JWS signed before a refund across isolates and restarts. The route records into it; the
 * `GameServicesAppStoreRevocations` entrypoint serves the lookup to the iOS
 * verifier Worker, which runs apart from this Worker and its D1 binding.
 */
export interface AppStoreRevocationsEnv {
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly DB?: D1Database;
  /**
   * `"true"` records every verified App Store refund and revocation (D1 table
   * `app_store_revocations`, migration 0011) and serves them to the iOS
   * verifier Worker. On the memory store the route records into a
   * process-local registry for local development, and the entrypoint
   * refuses: another isolate would answer `absent`. Required for an
   * `offline-only` purchase verifier; harmless and recommended in
   * `server-api` mode too, so a later switch starts with the history. Apply
   * 0011 first: with this set, a missing table answers every refund 503
   * until it exists.
   */
  readonly GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY?: 'true';
  /**
   * Optional: the cron deletes rows whose `revoked_at_ms` is older than this
   * many milliseconds (a positive integer, as a string). Unset keeps every
   * row: this Worker does not know the verifier's window. Set it to at least
   * the verifier's `maxSignedAgeMs` plus `clockSkewMs`; a row whose
   * `revokedAt` did not parse is never deleted.
   */
  readonly GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS?: string;
  /** The registry is served only while the notifications route that fills it is mounted. */
  readonly GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER?: unknown;
  readonly GAME_SERVICES_APP_STORE_BUNDLE_ID?: string;
}

/**
 * The registry this deployment records into, or `undefined` when
 * `GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY` is not `"true"`.
 */
export function resolveWorkerAppStoreRevocationRegistry(
  env: AppStoreRevocationsEnv,
): AppStoreRevocationRegistry | undefined {
  const flag: unknown = env.GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY;
  if (flag !== 'true') {
    if (flag !== undefined) {
      // A TOML boolean or a typo would silently leave refunds unrecorded.
      reportOnce(
        `registry:${typeof flag}:${String(flag)}`,
        'App Store revocations are not recorded: GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY '
          + 'must be the string "true".',
      );
    }
    return undefined;
  }
  if (env.MPGD_STORE !== 'd1') {
    // Local development: one registry per configuration, as the memory store is.
    return memoryRegistryFor(env);
  }
  if (env.DB === undefined) {
    throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
  }
  return createD1AppStoreRevocationRegistry(env.DB);
}

/**
 * One lookup for the `GameServicesAppStoreRevocations` entrypoint, as data
 * (errors lose their class across a service binding). Throws unless this
 * Worker records revocations durably (the flag, the D1 store, and the
 * notifications route): otherwise the lookup would answer `absent` for
 * refunds it never saw, and the verifier would grant without the check.
 */
export async function findWorkerAppStoreRevocation(
  env: AppStoreRevocationsEnv,
  input: AppStoreRevocationLookupRequest,
): Promise<AppStoreRevocationLookupAnswer> {
  const registry = resolveWorkerAppStoreRevocationRegistry(env);
  if (
    registry === undefined
    // The memory registry is one isolate's: a lookup served by another
    // isolate would miss every refund this one recorded.
    || env.MPGD_STORE !== 'd1'
    || env.GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER === undefined
    || (env.GAME_SERVICES_APP_STORE_BUNDLE_ID?.trim() ?? '') === ''
  ) {
    throw new Error(
      'APP_STORE_REVOCATIONS_NOT_CONFIGURED: set GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY = "true" '
        + 'with MPGD_STORE = "d1" and the App Store notifications route (GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER and '
        + 'GAME_SERVICES_APP_STORE_BUNDLE_ID).',
    );
  }
  return answerAppStoreRevocationLookup(registry, input);
}

/** Rows deleted per statement, and statements per cron run. */
const pruneBatchSize = 500;
const maxPruneBatches = 20;
/** How often one isolate prunes; the cron itself runs every minute. */
const pruneIntervalMs = 60 * 60 * 1000;
let lastPrunedAtMs: number | undefined;

/**
 * The cron's retention run: deletes registry rows whose `revoked_at_ms` is
 * older than `GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS`, at most once
 * an hour per isolate, in bounded batches. Does nothing without the
 * retention, the registry flag, or the D1 store; an invalid retention is
 * logged once and ignored. Rows whose `revokedAt` did not parse
 * (`revoked_at_ms` NULL) refuse every JWS and are never deleted. Returns the
 * number of rows deleted.
 */
export async function pruneWorkerAppStoreRevocations(
  env: AppStoreRevocationsEnv,
  nowMs: number = Date.now(),
): Promise<number> {
  const raw: unknown = env.GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS;
  if (raw === undefined) {
    return 0;
  }
  const retentionMs = typeof raw === 'string' && /^[1-9][0-9]*$/u.test(raw.trim())
    ? Number(raw.trim())
    : Number.NaN;
  if (!Number.isSafeInteger(retentionMs)) {
    reportOnce(
      `retention:${typeof raw}:${String(raw)}`,
      'App Store revocations are not pruned: GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS '
        + 'must be a positive integer number of milliseconds.',
    );
    return 0;
  }
  if (
    env.GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY !== 'true'
    || env.MPGD_STORE !== 'd1'
    || env.DB === undefined
  ) {
    return 0;
  }
  if (
    lastPrunedAtMs !== undefined
    && nowMs >= lastPrunedAtMs
    && nowMs - lastPrunedAtMs < pruneIntervalMs
  ) {
    return 0;
  }
  lastPrunedAtMs = nowMs;
  return deleteRevocationsBefore(env.DB, nowMs - retentionMs);
}

/** Lets a test run the hourly pruning again in the same isolate. */
export function resetAppStoreRevocationPruneClock(): void {
  lastPrunedAtMs = undefined;
}

async function deleteRevocationsBefore(db: D1Database, cutoffMs: number): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxPruneBatches; batch += 1) {
    const result = await db.prepare(
      `DELETE FROM app_store_revocations WHERE rowid IN (
         SELECT rowid FROM app_store_revocations
          WHERE revoked_at_ms IS NOT NULL AND revoked_at_ms < ?
          LIMIT ?
       )`,
    ).bind(cutoffMs, pruneBatchSize).run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < pruneBatchSize) {
      break;
    }
  }
  return deleted;
}

/** Misconfiguration this isolate already logged, so a check run per request logs once. */
const reported = new Set<string>();

function reportOnce(key: string, message: string): void {
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  console.error(message);
}

/**
 * The memory store's registry, one per configuration: per notification
 * verifier binding and bundle id (the route records only with both). A
 * runtime that hands the Worker a new `env` per request keeps its binding
 * objects, so records outlive the request; two configurations, or two test
 * cases with their own bindings, never share records.
 */
const memoryRegistries = new WeakMap<object, Map<string, AppStoreRevocationRegistry>>();

function memoryRegistryFor(env: AppStoreRevocationsEnv): AppStoreRevocationRegistry {
  const binding = env.GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER;
  const owner: object = typeof binding === 'object' && binding !== null ? binding : env;
  let byBundle = memoryRegistries.get(owner);
  if (byBundle === undefined) {
    byBundle = new Map();
    memoryRegistries.set(owner, byBundle);
  }
  const bundleId = env.GAME_SERVICES_APP_STORE_BUNDLE_ID?.trim() ?? '';
  let registry = byBundle.get(bundleId);
  if (registry === undefined) {
    registry = createInMemoryAppStoreRevocationRegistry();
    byBundle.set(bundleId, registry);
  }
  return registry;
}

interface RevocationRow {
  readonly verification_id: string;
  readonly environment: string;
  readonly bundle_id: string;
  readonly transaction_id: string;
  readonly original_transaction_id: string;
  readonly product_id: string;
  readonly reason: string;
  readonly revoked_at: string;
  readonly notification_type: string;
  readonly notification_uuid: string;
}

/**
 * `AppStoreRevocationRegistry` over D1, with the in-memory registry's rules
 * (`runAppStoreRevocationRegistryConformance` checks both): per environment
 * and grant verification id the record with the latest `revokedAt` is kept, compared
 * as instants; an unparseable `revokedAt` counts as the latest and is never
 * replaced; a redelivery or an older notification arriving late answers
 * `alreadyRecorded: true` and changes nothing. One conditional upsert
 * decides, so concurrent deliveries cannot move the cutoff back. A D1 failure
 * is `AppStoreDependencyUnavailableError`: the notification is answered 503
 * so Apple redelivers, and an offline-only purchase stays `pending`.
 */
export function createD1AppStoreRevocationRegistry(db: D1Database): AppStoreRevocationRegistry {
  return {
    async findRevocation(input) {
      input.signal.throwIfAborted();
      const row = await unavailableOnFailure(() =>
        db.prepare(
          `SELECT verification_id, environment, bundle_id, transaction_id,
                  original_transaction_id, product_id, reason, revoked_at,
                  notification_type, notification_uuid
             FROM app_store_revocations
            WHERE environment = ? AND verification_id = ?`,
        ).bind(input.environment, input.verificationId).first<RevocationRow>(),
      );
      return row === null ? undefined : toRecord(row);
    },
    async recordRevocation(input) {
      const record = input.record;
      assertNonEmptyString(record.verificationId, 'record.verificationId');
      input.signal.throwIfAborted();
      const revokedAtMs = Date.parse(record.revokedAt);
      const result = await unavailableOnFailure(() =>
        db.prepare(
          `INSERT INTO app_store_revocations (
             verification_id, environment, bundle_id, transaction_id,
             original_transaction_id, product_id, reason, revoked_at, revoked_at_ms,
             notification_type, notification_uuid, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (environment, verification_id) DO UPDATE SET
             bundle_id = excluded.bundle_id,
             transaction_id = excluded.transaction_id,
             original_transaction_id = excluded.original_transaction_id,
             product_id = excluded.product_id,
             reason = excluded.reason,
             revoked_at = excluded.revoked_at,
             revoked_at_ms = excluded.revoked_at_ms,
             notification_type = excluded.notification_type,
             notification_uuid = excluded.notification_uuid,
             recorded_at = excluded.recorded_at
           WHERE app_store_revocations.revoked_at_ms IS NOT NULL
             AND (excluded.revoked_at_ms IS NULL
               OR excluded.revoked_at_ms > app_store_revocations.revoked_at_ms)`,
        ).bind(
          record.verificationId,
          record.environment,
          record.bundleId,
          record.transactionId,
          record.originalTransactionId,
          record.productId,
          record.reason,
          record.revokedAt,
          Number.isFinite(revokedAtMs) ? revokedAtMs : null,
          record.notificationType,
          record.notificationUUID,
          new Date().toISOString(),
        ).run(),
      );
      return { alreadyRecorded: (result.meta.changes ?? 0) === 0 };
    },
  };
}

function toRecord(row: RevocationRow): AppStoreRevocationRecord {
  return {
    verificationId: row.verification_id,
    environment: row.environment === 'Sandbox' ? 'Sandbox' : 'Production',
    bundleId: row.bundle_id,
    transactionId: row.transaction_id,
    originalTransactionId: row.original_transaction_id,
    productId: row.product_id,
    reason: row.reason as AppStoreRevocationReason,
    revokedAt: row.revoked_at,
    notificationType: row.notification_type,
    notificationUUID: row.notification_uuid,
  };
}

async function unavailableOnFailure<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    console.error(
      'App Store revocation registry query failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
    );
    throw new AppStoreDependencyUnavailableError(
      'The App Store revocation registry is unavailable.',
      error,
    );
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

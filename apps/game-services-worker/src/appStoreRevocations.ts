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
 * Server Notifications route verified, kept per grant verification id, so an
 * `offline-only` App Store purchase verifier refuses a JWS signed before a
 * refund across isolates and restarts. The route records into it; the
 * `GameServicesAppStoreRevocations` entrypoint serves the lookup to the iOS
 * verifier Worker, which runs apart from this Worker and its D1 binding.
 */
export interface AppStoreRevocationsEnv {
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly DB?: D1Database;
  /**
   * `"true"` records every verified App Store refund and revocation (D1 table
   * `app_store_revocations`, migration 0011; a process-local registry on the
   * memory store) and serves them to the iOS verifier Worker. Required for an
   * `offline-only` purchase verifier; harmless and recommended in
   * `server-api` mode too, so a later switch starts with the history. Apply
   * 0011 first: with this set, a missing table answers every refund 503
   * until it exists.
   */
  readonly GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY?: 'true';
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
  if (env.GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY !== 'true') {
    return undefined;
  }
  if (env.MPGD_STORE !== 'd1') {
    // Local development: one registry per isolate, as the memory store is.
    return memoryRegistry;
  }
  if (env.DB === undefined) {
    throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
  }
  return createD1AppStoreRevocationRegistry(env.DB);
}

/**
 * One lookup for the `GameServicesAppStoreRevocations` entrypoint, as data
 * (errors lose their class across a service binding). Throws when this
 * Worker does not record revocations: the registry would then answer
 * `absent` for every refund, and the verifier would grant without the check.
 */
export async function findWorkerAppStoreRevocation(
  env: AppStoreRevocationsEnv,
  input: AppStoreRevocationLookupRequest,
): Promise<AppStoreRevocationLookupAnswer> {
  const registry = resolveWorkerAppStoreRevocationRegistry(env);
  if (
    registry === undefined
    || env.GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER === undefined
    || (env.GAME_SERVICES_APP_STORE_BUNDLE_ID?.trim() ?? '') === ''
  ) {
    throw new Error(
      'APP_STORE_REVOCATIONS_NOT_CONFIGURED: set GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY = "true" '
        + 'with the App Store notifications route (GAME_SERVICES_APP_STORE_NOTIFICATION_VERIFIER and '
        + 'GAME_SERVICES_APP_STORE_BUNDLE_ID).',
    );
  }
  return answerAppStoreRevocationLookup(registry, input);
}

const memoryRegistry = createInMemoryAppStoreRevocationRegistry();

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
 * (`runAppStoreRevocationRegistryConformance` checks both): per grant
 * verification id the record with the latest `revokedAt` is kept, compared
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
            WHERE verification_id = ?`,
        ).bind(input.verificationId).first<RevocationRow>(),
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
           ON CONFLICT (verification_id) DO UPDATE SET
             environment = excluded.environment,
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

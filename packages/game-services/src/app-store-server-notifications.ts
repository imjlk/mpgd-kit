import {
  findEntitlementRevocationsChunked,
  findPurchaseGrantByEvidenceVerificationId,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import {
  AppStoreDependencyUnavailableError,
  createAppStoreVerificationId,
  type AppStoreEnvironment,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';
import type { GameServicesStore } from './server.js';
import type {
  EntitlementLedgerPayload,
  EntitlementRevocationReason,
  ProductGrantTransaction,
} from './types.js';

/**
 * App Store Server Notifications V2 for one-time purchases: the store-side
 * half of a refund. Apple posts `{ "signedPayload": "<JWS>" }` to the URL set
 * in App Store Connect; the payload is verified with the same library and
 * root certificates as purchases (`createAppleServerNotificationVerifier` in
 * `@mpgd/game-services/app-store-server`), and a `REFUND` or `REVOKE` for a
 * transaction this ledger granted appends a `revoke` entry through
 * `revokeEntitlementGrant`. This module has no Apple library dependency, so a
 * Worker can run it behind a verifier service binding.
 *
 * https://developer.apple.com/documentation/appstoreservernotifications/responding-to-app-store-server-notifications
 */

/** The decoded fields of a verified `responseBodyV2DecodedPayload` this handler reads. */
export interface AppStoreServerNotification {
  readonly notificationType: string;
  readonly subtype?: string;
  /** Apple's unique id of the notification; a retried delivery repeats it. */
  readonly notificationUUID: string;
  readonly signedDate: number;
  readonly environment: AppStoreEnvironment;
  readonly bundleId: string;
  /**
   * The verified `data.signedTransactionInfo` of a one-time purchase. Absent
   * when the notification carries no transaction (`TEST`, summaries) or one
   * of another kind (subscriptions), which the handler ignores.
   */
  readonly transaction?: AppStoreTransactionPayload;
}

export type AppStoreServerNotificationVerificationResult =
  | { readonly status: 'verified'; readonly notification: AppStoreServerNotification }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Verifies a `signedPayload` and its signed transaction. Throw
 * `AppStoreDependencyUnavailableError` only for a transient failure (Apple's
 * retryable certificate checks); the handler then asks Apple to redeliver.
 */
export interface AppStoreServerNotificationVerifier {
  verifyAndDecodeNotification(input: {
    readonly signedPayload: string;
    readonly environment: AppStoreEnvironment;
    readonly bundleId: string;
    readonly signal: AbortSignal;
  }): Promise<AppStoreServerNotificationVerificationResult>;
}

export interface HandleAppStoreServerNotificationInput {
  readonly store: GameServicesStore;
  readonly verifier: AppStoreServerNotificationVerifier;
  /** The request body as received: `{ signedPayload }` parsed from JSON. */
  readonly body: unknown;
  /** The environment of the URL the notification arrived on (production or sandbox). */
  readonly environment: AppStoreEnvironment;
  readonly bundleId: string;
  readonly signal: AbortSignal;
  readonly now?: () => string;
  /**
   * How long after Apple revoked the transaction (its `revocationDate`, else
   * the notification's `signedDate`) a refund for a grant this ledger does not
   * hold yet is answered `retry` instead of `ignored`; 1 hour by default. It
   * covers a purchase whose verification read the transaction before the
   * refund and whose grant is still being written: Apple redelivers (the
   * first production retry is an hour later) and the redelivery finds the
   * grant. A refund for a grant that never appears is acknowledged once the
   * window passes, so Apple stops retrying. `0` acknowledges at once.
   */
  readonly unmatchedRefundRetryMs?: number;
}

/** Default of `unmatchedRefundRetryMs`. */
export const defaultUnmatchedRefundRetryMs = 60 * 60 * 1000;
const maxUnmatchedRefundRetryMs = 6 * 60 * 60 * 1000;

export type AppStoreServerNotificationOutcome =
  /** A grant was reversed (or already had been, for a redelivery). */
  | {
      readonly status: 'revoked';
      readonly notificationUUID: string;
      readonly ledgerEntryId: string;
      readonly alreadyProcessed: boolean;
    }
  /**
   * `REFUND_REVERSED` for a grant this ledger revoked: the player paid again
   * but still has no item. Nothing is re-granted; the reversal is kept as a
   * ledger note (`recorded`, once per `notificationUUID`) when the store
   * supports notes, and the host should warn so support can re-grant.
   */
  | {
      readonly status: 'refund_reversed';
      readonly notificationUUID: string;
      readonly playerId: string;
      /** The original grant. */
      readonly ledgerEntryId: string;
      /** The `revoke` entry Apple's reversal undid. */
      readonly revocationLedgerEntryId: string;
      /** False on a store without `recordEntitlementNote`: only the host's log keeps it. */
      readonly recorded: boolean;
      readonly alreadyRecorded: boolean;
    }
  /** Verified, but nothing to do: Apple is answered 200 so it stops retrying. */
  | { readonly status: 'ignored'; readonly reason: string; readonly notificationUUID: string }
  /**
   * The ledger refused the revocation (its key or authority identity already
   * reversed another grant). A redelivery cannot fix it, so Apple is answered
   * 200; the host should log or alert on it.
   */
  | { readonly status: 'conflict'; readonly reason: string; readonly notificationUUID: string }
  /** Malformed or not signed by Apple for this app and environment. */
  | { readonly status: 'rejected'; readonly reason: string }
  /** A transient failure, or an order to wait for: answer non-2xx so Apple redelivers. */
  | { readonly status: 'retry'; readonly reason: string; readonly notificationUUID?: string };

/**
 * The longest `signedPayload` string accepted; Apple's notifications are a
 * few kilobytes. The host bounds the whole request body itself.
 */
export const maxAppStoreServerNotificationBytes = 256 * 1024;

const revocationReasons: Readonly<Record<string, EntitlementRevocationReason>> = {
  // The customer was refunded for the purchase.
  REFUND: 'refund',
  // Access the customer had through an organization ended. A family member's
  // FAMILY_SHARED transaction is ignored before the lookup: it shares the
  // purchaser's original transaction id, and the purchaser keeps the grant.
  REVOKE: 'voided',
};

/**
 * Verifies one App Store Server Notification and applies it to the ledger.
 * `REFUND` and `REVOKE` for a granted one-time purchase append one `revoke`
 * entry, keyed by the notification's `notificationUUID` so a redelivery
 * answers the first entry. Every other type, a transaction this ledger never
 * granted, and a subscription transaction are `ignored` (answer 200 so Apple
 * stops retrying). `REFUND_REVERSED` for a grant an App Store refund
 * revoked is answered `refund_reversed`: the reversal is recorded as a ledger
 * note, nothing is re-granted, and the game re-grants on its own terms (a new
 * grant entry). For a grant not revoked yet it is `retry` (Apple redelivers,
 * so a refund still in flight is applied first); for a grant revoked for
 * another reason it is `ignored`.
 *
 * A refund for a grant this ledger does not hold is `retry` while it is
 * recent (`unmatchedRefundRetryMs`, a purchase may be committing a grant it
 * verified before the refund) and `ignored` after; a purchase request that
 * starts after the refund is refused by the verifier's Server API mode.
 * A thrown error (a store outage, an abort) is not an outcome: the host must
 * answer it with a 5xx so Apple redelivers.
 */
export async function handleAppStoreServerNotification(
  input: HandleAppStoreServerNotificationInput,
): Promise<AppStoreServerNotificationOutcome> {
  const signedPayload = readSignedPayload(input.body);
  if (signedPayload === undefined) {
    return { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' };
  }

  let verification: AppStoreServerNotificationVerificationResult;
  try {
    verification = await input.verifier.verifyAndDecodeNotification({
      signedPayload,
      environment: input.environment,
      bundleId: input.bundleId,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof AppStoreDependencyUnavailableError) {
      return { status: 'retry', reason: 'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE' };
    }
    throw error;
  }
  if (verification.status !== 'verified') {
    return { status: 'rejected', reason: verification.reason };
  }

  const notification = verification.notification;
  if (
    notification.environment !== input.environment
    || notification.bundleId !== input.bundleId
  ) {
    return { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_SCOPE_MISMATCH' };
  }
  const notificationUUID = notification.notificationUUID;
  const isRefundReversal = notification.notificationType === 'REFUND_REVERSED';
  const reason = revocationReasons[notification.notificationType];
  if (reason === undefined && !isRefundReversal) {
    return { status: 'ignored', reason: 'APP_STORE_NOTIFICATION_TYPE_UNHANDLED', notificationUUID };
  }
  const transaction = notification.transaction;
  if (transaction === undefined) {
    return {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_TRANSACTION_UNSUPPORTED',
      notificationUUID,
    };
  }
  if (
    transaction.environment !== input.environment
    || transaction.bundleId !== input.bundleId
  ) {
    return { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_SCOPE_MISMATCH' };
  }
  if (
    transaction.inAppOwnershipType !== undefined
    && transaction.inAppOwnershipType !== 'PURCHASED'
  ) {
    // Shared access is never granted (APP_STORE_FAMILY_SHARED_UNSUPPORTED),
    // so its end must not reverse the purchaser's own grant.
    return {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_SHARED_ACCESS_IGNORED',
      notificationUUID,
    };
  }

  // The grant's identity is the one the purchase verifier recorded:
  // non-consumables by their original transaction, consumables by their own.
  const grantVerificationId = createAppStoreVerificationId({
    environment: transaction.environment,
    bundleId: transaction.bundleId,
    transactionId: transaction.type === 'Non-Consumable'
      ? transaction.originalTransactionId
      : transaction.transactionId,
  });
  const now = input.now ?? (() => new Date().toISOString());
  const unmatchedRefundRetryMs = input.unmatchedRefundRetryMs ?? defaultUnmatchedRefundRetryMs;
  if (
    !Number.isSafeInteger(unmatchedRefundRetryMs)
    || unmatchedRefundRetryMs < 0
    || unmatchedRefundRetryMs > maxUnmatchedRefundRetryMs
  ) {
    throw new RangeError('unmatchedRefundRetryMs must be an integer from 0 to 6 hours.');
  }
  const grant = await findPurchaseGrantByEvidenceVerificationId(input.store, grantVerificationId);
  if (grant === undefined || grant.payload.target !== 'ios') {
    if (
      grant === undefined
      && reason !== undefined
      && Date.parse(now()) - (transaction.revocationDate ?? notification.signedDate)
        < unmatchedRefundRetryMs
    ) {
      // A purchase in flight may have read the transaction before the
      // refund and not written its grant yet: let Apple redeliver.
      return {
        status: 'retry',
        reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND',
        notificationUUID,
      };
    }
    return {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND',
      notificationUUID,
    };
  }

  if (reason === undefined) {
    // Only REFUND_REVERSED gets past the type gate without a revocation reason.
    return recordRefundReversal(input.store, {
      notificationUUID,
      grant,
      now: now(),
      payload: {
        target: 'ios',
        store: 'app-store',
        appStoreNotificationType: notification.notificationType,
        appStoreEnvironment: transaction.environment,
        appStoreOriginalTransactionId: transaction.originalTransactionId,
        platformTransactionId: transaction.transactionId,
        platformProductId: transaction.productId,
      },
    });
  }
  const revokedAt = readTimestamp(transaction.revocationDate) ?? now();
  const result = await revokeEntitlementGrant(input.store, {
    playerId: grant.playerId,
    revokesLedgerEntryId: grant.ledgerEntryId,
    idempotencyKey: `app-store:notification:${notificationUUID}`,
    reason,
    revokedAt,
    evidenceVerificationId: `${grantVerificationId}:revoke`,
    payload: {
      target: 'ios',
      store: 'app-store',
      appStoreNotificationType: notification.notificationType,
      appStoreNotificationUUID: notificationUUID,
      appStoreEnvironment: transaction.environment,
      appStoreBundleId: transaction.bundleId,
      appStoreOriginalTransactionId: transaction.originalTransactionId,
      platformTransactionId: transaction.transactionId,
      platformProductId: transaction.productId,
      ...(notification.subtype === undefined ? {} : { appStoreNotificationSubtype: notification.subtype }),
    },
  });
  if (result.status === 'revoked') {
    return {
      status: 'revoked',
      notificationUUID,
      ledgerEntryId: result.ledgerEntryId,
      alreadyProcessed: result.alreadyProcessed,
    };
  }
  // grant_not_found / grant_mismatch cannot follow the lookup above unless
  // the ledger changed underneath; a key or identity conflict is a ledger
  // invariant a redelivery cannot fix. None of them is worth Apple's retry.
  return {
    status: result.status === 'key_conflict' || result.status === 'evidence_already_processed'
      ? 'conflict'
      : 'ignored',
    reason: `APP_STORE_NOTIFICATION_${result.status.toUpperCase()}`,
    notificationUUID,
  };
}

async function recordRefundReversal(
  store: GameServicesStore,
  input: {
    readonly notificationUUID: string;
    readonly grant: ProductGrantTransaction;
    readonly now: string;
    readonly payload: EntitlementLedgerPayload;
  },
): Promise<AppStoreServerNotificationOutcome> {
  const [revocation] = await findEntitlementRevocationsChunked(store, [input.grant.ledgerEntryId]);
  if (revocation === undefined) {
    // The grant is still active. Either the refund never applied here, or
    // its delivery is still being retried and could revoke the grant after
    // this reversal: ask Apple to redeliver (production retries for 72 hours)
    // so the reversal is seen after the refund.
    return {
      status: 'retry',
      reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_REVOKED',
      notificationUUID: input.notificationUUID,
    };
  }
  if (revocation.reason !== 'refund' || revocation.payload.store !== 'app-store') {
    // A REFUND_REVERSED only undoes an App Store refund; a grant revoked for
    // another reason (REVOKE, a chargeback, an admin) stays revoked silently.
    return {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_REVOCATION_NOT_REFUND',
      notificationUUID: input.notificationUUID,
    };
  }
  let recorded = false;
  let alreadyRecorded = false;
  if (store.recordEntitlementNote !== undefined) {
    const result = await store.recordEntitlementNote({
      noteId: `app-store:notification:${input.notificationUUID}`,
      kind: 'refund_reversed',
      playerId: input.grant.playerId,
      ledgerEntryId: input.grant.ledgerEntryId,
      revocationLedgerEntryId: revocation.ledgerEntryId,
      recordedAt: input.now,
      payload: { ...input.payload, appStoreNotificationUUID: input.notificationUUID },
    });
    recorded = true;
    alreadyRecorded = result.alreadyRecorded;
  }
  return {
    status: 'refund_reversed',
    notificationUUID: input.notificationUUID,
    playerId: input.grant.playerId,
    ledgerEntryId: input.grant.ledgerEntryId,
    revocationLedgerEntryId: revocation.ledgerEntryId,
    recorded,
    alreadyRecorded,
  };
}

/** The HTTP status to answer Apple with: 200 stops its retries, anything else asks for one. */
export function appStoreServerNotificationHttpStatus(
  outcome: AppStoreServerNotificationOutcome,
): 200 | 400 | 503 {
  switch (outcome.status) {
    case 'revoked':
    case 'refund_reversed':
    case 'ignored':
    case 'conflict':
      return 200;
    case 'rejected':
      return 400;
    case 'retry':
      return 503;
  }
}

function readTimestamp(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readSignedPayload(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const signedPayload = (body as Readonly<Record<string, unknown>>).signedPayload;
  return typeof signedPayload === 'string'
    && signedPayload.length > 0
    && signedPayload.length <= maxAppStoreServerNotificationBytes
    ? signedPayload
    : undefined;
}

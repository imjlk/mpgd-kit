import { revokeEntitlementGrant } from './commerce-ledger.js';
import {
  AppStoreDependencyUnavailableError,
  createAppStoreVerificationId,
  type AppStoreEnvironment,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';
import type { GameServicesStore } from './server.js';
import type { EntitlementRevocationReason, ProductGrantTransaction } from './types.js';

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
}

export type AppStoreServerNotificationOutcome =
  /** A grant was reversed (or already had been, for a redelivery). */
  | {
      readonly status: 'revoked';
      readonly notificationUUID: string;
      readonly ledgerEntryId: string;
      readonly alreadyProcessed: boolean;
    }
  /** Verified, but nothing to do: Apple is answered 200 so it stops retrying. */
  | { readonly status: 'ignored'; readonly reason: string; readonly notificationUUID: string }
  /** Malformed or not signed by Apple for this app and environment. */
  | { readonly status: 'rejected'; readonly reason: string }
  /** A transient failure: answer non-2xx so Apple redelivers. */
  | { readonly status: 'retry'; readonly reason: string };

/** The largest body accepted; Apple's notifications are a few kilobytes. */
export const maxAppStoreServerNotificationBytes = 256 * 1024;

const revocationReasons: Readonly<Record<string, EntitlementRevocationReason>> = {
  // The customer was refunded for the purchase.
  REFUND: 'refund',
  // Access through Family Sharing or an organization ended. Shared access is
  // never granted, so this only matches a grant if the ledger holds one.
  REVOKE: 'voided',
};

/**
 * Verifies one App Store Server Notification and applies it to the ledger.
 * `REFUND` and `REVOKE` for a granted one-time purchase append one `revoke`
 * entry, keyed by the notification's `notificationUUID` so a redelivery
 * answers the first entry. Every other type, a transaction this ledger never
 * granted, and a subscription transaction are `ignored` (answer 200 so Apple
 * stops retrying). `REFUND_REVERSED` is ignored too: a reversed grant stays
 * reversed until the game re-grants it on its own terms.
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
  const reason = revocationReasons[notification.notificationType];
  if (reason === undefined) {
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

  // The grant's identity is the one the purchase verifier recorded:
  // non-consumables by their original transaction, consumables by their own.
  const grantVerificationId = createAppStoreVerificationId({
    environment: transaction.environment,
    bundleId: transaction.bundleId,
    transactionId: transaction.type === 'Non-Consumable'
      ? transaction.originalTransactionId
      : transaction.transactionId,
  });
  const grant = await findPurchaseGrant(input.store, grantVerificationId);
  if (grant === undefined || grant.payload.target !== 'ios') {
    return {
      status: 'ignored',
      reason: 'APP_STORE_NOTIFICATION_GRANT_NOT_FOUND',
      notificationUUID,
    };
  }

  const revokedAt = transaction.revocationDate === undefined
    ? (input.now ?? (() => new Date().toISOString()))()
    : new Date(transaction.revocationDate).toISOString();
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
    status: 'ignored',
    reason: `APP_STORE_NOTIFICATION_${result.status.toUpperCase()}`,
    notificationUUID,
  };
}

/** The HTTP status to answer Apple with: 200 stops its retries, anything else asks for one. */
export function appStoreServerNotificationHttpStatus(
  outcome: AppStoreServerNotificationOutcome,
): 200 | 400 | 503 {
  switch (outcome.status) {
    case 'revoked':
    case 'ignored':
      return 200;
    case 'rejected':
      return 400;
    case 'retry':
      return 503;
  }
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

async function findPurchaseGrant(
  store: GameServicesStore,
  evidenceVerificationId: string,
): Promise<ProductGrantTransaction | undefined> {
  const identity = { source: 'purchase', evidenceVerificationId } as const;
  const grant = store.findEntitlementTransactionByEvidenceVerificationId === undefined
    ? (await store.listEntitlementTransactions()).find((transaction) => {
        return (transaction.evidenceVerificationId
          ?? transaction.payload.evidenceVerificationId) === evidenceVerificationId;
      })
    : await store.findEntitlementTransactionByEvidenceVerificationId(identity);
  return grant?.source === 'purchase' ? grant : undefined;
}

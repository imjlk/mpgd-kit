import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';

import {
  maxAppStoreServerNotificationBytes,
  type AppStoreServerNotificationVerifier,
} from './app-store-server-notifications.js';
import {
  AppStoreDependencyUnavailableError,
  type AppStoreEnvironment,
  type AppStoreSignedTransactionVerifier,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';

// Server-side App Store JWS verification over Apple's
// `@apple/app-store-server-library` (an optional peer of this package). This
// subpath is backend-only: keep trust roots and the verifier out of the game
// client. It moved here from `@mpgd/adapter-capacitor/app-store-server` in A4;
// that path stays as a deprecated re-export.

export interface CreateAppleSignedTransactionVerifierOptions {
  /** DER-encoded Apple root certificates, supplied by the server operator. */
  readonly rootCertificates: readonly Uint8Array[];
  readonly environment: AppStoreEnvironment;
  readonly bundleId: string;
  /** Required by Apple's verifier in production. */
  readonly appAppleId?: number;
  readonly enableOnlineChecks?: boolean;
}

/** Verify the App Store JWS before exposing any decoded purchase fields. */
export function createAppleSignedTransactionVerifier(
  options: CreateAppleSignedTransactionVerifierOptions,
): AppStoreSignedTransactionVerifier {
  const verifier = createSignedDataVerifier(options);

  return {
    async verifyAndDecode(input) {
      if (input.environment !== options.environment || input.bundleId !== options.bundleId) {
        return { status: 'rejected', reason: 'APP_STORE_VERIFIER_SCOPE_MISMATCH' };
      }
      if (typeof input.signedTransaction !== 'string'
        || input.signedTransaction.length === 0
        || input.signedTransaction.length > 512 * 1024) {
        return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID' };
      }
      const decoded = await verifyWithApple(
        () => verifier.verifyAndDecodeTransaction(input.signedTransaction),
        input.signal,
      );
      if (decoded.status === 'rejected') {
        return decoded;
      }
      const payload = decodeOneTimeTransaction(decoded.value);
      return payload === undefined
        ? { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID' }
        : { status: 'verified', payload };
    },
  };
}

/**
 * Verify an App Store Server Notifications V2 `signedPayload`, and the
 * `signedTransactionInfo` inside it, with the same trust roots and scope as
 * purchases. Use one verifier per environment: the production and sandbox
 * notification URLs each verify against their own environment.
 */
export function createAppleServerNotificationVerifier(
  options: CreateAppleSignedTransactionVerifierOptions,
): AppStoreServerNotificationVerifier {
  const verifier = createSignedDataVerifier(options);

  return {
    async verifyAndDecodeNotification(input) {
      if (input.environment !== options.environment || input.bundleId !== options.bundleId) {
        return { status: 'rejected', reason: 'APP_STORE_VERIFIER_SCOPE_MISMATCH' };
      }
      if (typeof input.signedPayload !== 'string'
        || input.signedPayload.length === 0
        || input.signedPayload.length > maxAppStoreServerNotificationBytes) {
        return { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' };
      }
      const decoded = await verifyWithApple(
        () => verifier.verifyAndDecodeNotification(input.signedPayload),
        input.signal,
      );
      if (decoded.status === 'rejected') {
        return decoded;
      }
      const notification = decoded.value;
      const data = notification.data;
      // Summary, app-data, and external-purchase notifications carry no
      // `data`; Apple's verifier already matched their bundle and
      // environment to this verifier's, and they carry no transaction.
      const environment = data === undefined
        ? options.environment
        : readEnvironment(data.environment);
      const bundleId = data === undefined ? options.bundleId : data.bundleId;
      if (!nonEmpty(notification.notificationType)
        || !nonEmpty(notification.notificationUUID)
        || !validTimestamp(notification.signedDate)
        || (notification.subtype !== undefined && !nonEmpty(notification.subtype))
        || environment === undefined
        || !nonEmpty(bundleId)) {
        return { status: 'rejected', reason: 'APP_STORE_NOTIFICATION_PAYLOAD_INVALID' };
      }
      let transaction: AppStoreTransactionPayload | undefined;
      if (data?.signedTransactionInfo !== undefined) {
        const signedTransaction = data.signedTransactionInfo;
        const decodedTransaction = await verifyWithApple(
          () => verifier.verifyAndDecodeTransaction(signedTransaction),
          input.signal,
        );
        if (decodedTransaction.status === 'rejected') {
          // Named for the embedded transaction, apart from the payload's own checks.
          return {
            status: 'rejected',
            reason: decodedTransaction.reason.replace(
              /^APP_STORE_/u,
              'APP_STORE_NOTIFICATION_TRANSACTION_',
            ),
          };
        }
        // A subscription transaction decodes to undefined and is ignored.
        transaction = decodeOneTimeTransaction(decodedTransaction.value);
      }
      return {
        status: 'verified',
        notification: {
          notificationType: notification.notificationType,
          ...(notification.subtype === undefined ? {} : { subtype: notification.subtype }),
          notificationUUID: notification.notificationUUID,
          signedDate: notification.signedDate,
          environment,
          bundleId,
          ...(transaction === undefined ? {} : { transaction }),
        },
      };
    },
  };
}

function createSignedDataVerifier(
  options: CreateAppleSignedTransactionVerifierOptions,
): SignedDataVerifier {
  if (!Array.isArray(options.rootCertificates)
    || options.rootCertificates.length === 0
    || options.rootCertificates.some((certificate) => !(certificate instanceof Uint8Array)
      || certificate.length === 0)) {
    throw new TypeError('Apple root certificates are required.');
  }
  if (options.environment !== 'Production' && options.environment !== 'Sandbox') {
    throw new TypeError('App Store environment must be Production or Sandbox.');
  }
  if (options.bundleId.trim() === '') {
    throw new TypeError('App Store bundle ID is required.');
  }
  if (options.environment === 'Production'
    && (!Number.isSafeInteger(options.appAppleId) || (options.appAppleId ?? 0) <= 0)) {
    throw new TypeError('Production App Store verification requires appAppleId.');
  }
  if (options.environment === 'Production' && options.enableOnlineChecks === false) {
    throw new TypeError('Production App Store verification requires online certificate checks.');
  }
  return new SignedDataVerifier(
    options.rootCertificates.map((certificate) => Buffer.from(certificate)),
    options.enableOnlineChecks ?? true,
    options.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX,
    options.bundleId,
    options.appAppleId,
  );
}

/**
 * Runs one Apple verification. A failed check is a rejection, the
 * environment mismatch is named so the purchase verifier can retry the JWS in
 * the sandbox, Apple's retryable status is a transient dependency error, and
 * cancellation and unexpected library faults propagate.
 */
async function verifyWithApple<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<
  | { readonly status: 'verified'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: string }
> {
  signal.throwIfAborted();
  try {
    const value = await waitForVerification(operation(), signal);
    signal.throwIfAborted();
    return { status: 'verified', value };
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (error instanceof VerificationException) {
      if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
        throw new AppStoreDependencyUnavailableError(
          'Apple signature checks are temporarily unavailable.',
          error,
        );
      }
      // The signature checked out but the JWS belongs to the other
      // environment: the evidence verifier may retry it in the sandbox.
      return {
        status: 'rejected',
        reason: error.status === VerificationStatus.INVALID_ENVIRONMENT
          ? 'APP_STORE_ENVIRONMENT_MISMATCH'
          : 'APP_STORE_SIGNATURE_INVALID',
      };
    }
    // Only Apple's explicit retryable status is a transient dependency
    // failure. Unexpected adapter/library faults must reach the caller.
    throw error;
  }
}

async function waitForVerification<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Verification was aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function decodeOneTimeTransaction(
  decoded: JWSTransactionDecodedPayload,
): AppStoreTransactionPayload | undefined {
  if (!nonEmpty(decoded.transactionId)
    || !nonEmpty(decoded.originalTransactionId)
    || !nonEmpty(decoded.bundleId)
    || !nonEmpty(decoded.productId)
    || !validTimestamp(decoded.purchaseDate)
    || !validTimestamp(decoded.signedDate)
    || (decoded.environment !== 'Production' && decoded.environment !== 'Sandbox')
    || (decoded.type !== 'Consumable' && decoded.type !== 'Non-Consumable')
    || (decoded.quantity !== undefined
      && (!Number.isSafeInteger(decoded.quantity) || decoded.quantity <= 0))
    || (decoded.appAccountToken !== undefined && !nonEmpty(decoded.appAccountToken))
    || (decoded.revocationDate !== undefined && !validTimestamp(decoded.revocationDate))
    || (decoded.expiresDate !== undefined && !validTimestamp(decoded.expiresDate))
    || (decoded.isUpgraded !== undefined && typeof decoded.isUpgraded !== 'boolean')
    || (decoded.inAppOwnershipType !== undefined && !nonEmpty(decoded.inAppOwnershipType))) {
    return undefined;
  }
  return {
    transactionId: decoded.transactionId,
    originalTransactionId: decoded.originalTransactionId,
    bundleId: decoded.bundleId,
    productId: decoded.productId,
    purchaseDate: decoded.purchaseDate,
    signedDate: decoded.signedDate,
    environment: decoded.environment,
    type: decoded.type,
    ...(decoded.quantity === undefined ? {} : { quantity: decoded.quantity }),
    ...(decoded.appAccountToken === undefined ? {} : { appAccountToken: decoded.appAccountToken }),
    ...(decoded.revocationDate === undefined ? {} : { revocationDate: decoded.revocationDate }),
    ...(decoded.expiresDate === undefined ? {} : { expiresDate: decoded.expiresDate }),
    ...(decoded.isUpgraded === undefined ? {} : { isUpgraded: decoded.isUpgraded }),
    ...(decoded.inAppOwnershipType === undefined
      ? {}
      : { inAppOwnershipType: decoded.inAppOwnershipType }),
  };
}

function readEnvironment(value: unknown): AppStoreEnvironment | undefined {
  return value === 'Production' || value === 'Sandbox' ? value : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';

import {
  AppStoreDependencyUnavailableError,
  type AppStoreEnvironment,
  type AppStoreSignedTransactionVerifier,
  type AppStoreTransactionPayload,
} from '@mpgd/game-services/app-store-verifier';

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
  const verifier = new SignedDataVerifier(
    options.rootCertificates.map((certificate) => Buffer.from(certificate)),
    options.enableOnlineChecks ?? true,
    options.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX,
    options.bundleId,
    options.appAppleId,
  );

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
      input.signal.throwIfAborted();
      let decoded: JWSTransactionDecodedPayload;
      try {
        decoded = await verifier.verifyAndDecodeTransaction(input.signedTransaction);
        input.signal.throwIfAborted();
      } catch (error) {
        if (input.signal.aborted) {
          throw input.signal.reason;
        }
        if (error instanceof VerificationException) {
          if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
            throw new AppStoreDependencyUnavailableError(
              'Apple signature checks are temporarily unavailable.',
              error,
            );
          }
          return { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' };
        }
        // Only Apple's explicit retryable status is a transient dependency
        // failure. Unexpected adapter/library faults must reach the caller.
        throw error;
      }
      const payload = decodeOneTimeTransaction(decoded);
      return payload === undefined
        ? { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_INVALID' }
        : { status: 'verified', payload };
    },
  };
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
    || (decoded.isUpgraded !== undefined && typeof decoded.isUpgraded !== 'boolean')) {
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
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

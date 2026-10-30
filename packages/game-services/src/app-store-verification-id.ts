/**
 * The App Store grant identity, shared by the purchase verifier (the
 * verification id its grants record) and the server notification handler
 * (the grant it reverses and the revocation it records): both must derive
 * the same key from a transaction. Internal: the public names are
 * re-exported from `app-store-verifier`.
 */

export function createAppStoreVerificationId(input: {
  readonly environment: 'Production' | 'Sandbox';
  readonly bundleId: string;
  readonly transactionId: string;
}): string {
  return [
    'app-store',
    input.environment,
    input.bundleId,
    input.transactionId,
  ].map(encodeVerificationIdSegment).join(':');
}

/**
 * The verification id of the grant a transaction makes: a non-consumable by
 * its original transaction (restores and re-downloads share one grant), any
 * other type by its own transaction.
 */
export function createAppStoreGrantVerificationId(transaction: {
  readonly environment: 'Production' | 'Sandbox';
  readonly bundleId: string;
  readonly type: string;
  readonly transactionId: string;
  readonly originalTransactionId: string;
}): string {
  return createAppStoreVerificationId({
    environment: transaction.environment,
    bundleId: transaction.bundleId,
    transactionId: transaction.type === 'Non-Consumable'
      ? transaction.originalTransactionId
      : transaction.transactionId,
  });
}

export function encodeVerificationIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
}

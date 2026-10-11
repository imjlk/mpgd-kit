import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

import {
  createAppStoreSignedTransactionEvidence,
  type AppStoreEnvironment,
  type AppStoreInAppPurchaseType,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';

/** The placeholder JWS the signed-transaction evidence fixture carries; never a real signature. */
export const appStoreConformanceSignedTransaction = 'conformance.signed-transaction.jws';

export interface CreateAppStoreSignedTransactionEvidenceFixtureInput {
  readonly signedTransaction?: string;
  readonly transactionId?: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
}

/**
 * Builds the `app-store.signed-transaction.v1` evidence envelope a commerce v2
 * StoreKit client submits, with a placeholder JWS by default. Pair it with a
 * fake `AppStoreSignedTransactionVerifier` that answers
 * `createAppStoreTransactionConformanceFixture` for that string and, under the
 * default `server-api` policy, a fake Server API whose `signedTransactionInfo`
 * decodes to the transaction's current status; the fixture is not signed
 * evidence and contains no Apple credentials.
 */
export function createAppStoreSignedTransactionEvidenceFixture(
  input: CreateAppStoreSignedTransactionEvidenceFixtureInput = {},
): PlatformEvidenceEnvelope {
  return createAppStoreSignedTransactionEvidence({
    signedTransaction: input.signedTransaction ?? appStoreConformanceSignedTransaction,
    transactionId: input.transactionId ?? '2000000000000001',
    ...(input.originalTransactionId === undefined
      ? {}
      : { originalTransactionId: input.originalTransactionId }),
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
  });
}

export interface CreateAppStoreTransactionConformanceFixtureInput {
  readonly transactionId?: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
  readonly productId?: string;
  readonly purchaseDate?: number;
  readonly signedDate?: number;
  readonly environment?: AppStoreEnvironment;
  readonly type?: AppStoreInAppPurchaseType;
  readonly includeQuantity?: boolean;
  readonly quantity?: number;
  /** Set to false to omit the default signed account token for fail-closed tests. */
  readonly includeAppAccountToken?: boolean;
  readonly appAccountToken?: string;
  readonly expiresDate?: number;
  readonly revocationDate?: number;
  readonly isUpgraded?: boolean;
}

/**
 * Builds deterministic decoded JWS data for verifier and provider-adapter
 * conformance tests. The fixture is not signed evidence and contains no Apple
 * credentials, authorization tokens, private keys, or live transaction IDs.
 */
export function createAppStoreTransactionConformanceFixture(
  input: CreateAppStoreTransactionConformanceFixtureInput = {},
): AppStoreTransactionPayload {
  return {
    transactionId: input.transactionId ?? '2000000000000001',
    originalTransactionId: input.originalTransactionId ?? '2000000000000000',
    bundleId: input.bundleId ?? 'com.example.game',
    productId: input.productId ?? 'com.example.game.coins100',
    purchaseDate: input.purchaseDate ?? Date.parse('2020-01-02T03:04:05.000Z'),
    signedDate: input.signedDate ?? Date.parse('2020-01-02T03:04:06.000Z'),
    environment: input.environment ?? 'Production',
    type: input.type ?? 'Consumable',
    ...(input.includeQuantity === false ? {} : { quantity: input.quantity ?? 1 }),
    ...(input.includeAppAccountToken === false
      ? {}
      : {
          appAccountToken:
            input.appAccountToken ?? 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2',
        }),
    ...(input.expiresDate === undefined ? {} : { expiresDate: input.expiresDate }),
    ...(input.revocationDate === undefined
      ? {}
      : { revocationDate: input.revocationDate }),
    ...(input.isUpgraded === undefined ? {} : { isUpgraded: input.isUpgraded }),
  };
}

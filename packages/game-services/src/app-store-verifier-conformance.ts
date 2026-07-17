import type {
  AppStoreEnvironment,
  AppStoreInAppPurchaseType,
  AppStoreTransactionPayload,
} from './app-store-verifier';

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

import {
  createCommerceServiceProvider,
  createStoreCommerceProvider,
  type CapacitorCommerceServiceProvider,
  type StoreCommerceProductMapping,
  type StoreCommerceProvider,
  type StorePurchaseGate,
  type StoreSdkErrorCodeMap,
} from '@mpgd/adapter-capacitor';
import type { PlatformEvidenceEnvelope } from '@mpgd/platform';
import { CommerceError, type StorePurchaseAccountBinding } from '@mpgd/platform/commerce';

import {
  appStoreSignedTransactionEvidenceSchema,
  appStoreStoreId,
  storeKitCommerceAuthority,
} from './commerce-profile.js';
import {
  createPurchaseGateUnsupportedError,
  resolvePurchaseGateSupport,
} from './purchase-gate-support.js';
import {
  capacitorStoreKitErrorCodeMap,
  createCapacitorStoreKitStoreSdk,
  readAppAccountToken,
  type CapacitorStoreKitDiagnostic,
  type CapacitorStoreKitStoreSdkPlugin,
} from './store-sdk.js';

// The profile constants live in the SDK-free `commerce-profile.ts` so a tools
// project can read them without loading Capacitor; they stay exported here.
export { appStoreSignedTransactionEvidenceSchema };

/** Payload of an `app-store.signed-transaction.v1` envelope. */
export interface AppStoreSignedTransactionEvidencePayload {
  readonly signedTransaction: string;
  readonly transactionId: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
}

export interface CreateCapacitorStoreKitCommerceProviderInput {
  /** Consumable and durable products only; StoreKit subscriptions are out of scope (RFC D-02). */
  readonly products: readonly StoreCommerceProductMapping[];
  /**
   * Authenticated, stable UUID app account token of the current player. The
   * backend's `resolveAppAccountToken` must resolve the same value. It also
   * filters recovery and finishing to this player, so it must keep answering
   * while sales are paused; pause sales with `purchaseGate` instead.
   */
  readonly getAppAccountToken: () => string | Promise<string>;
  /**
   * Optional sales switch, asked before a new purchase opens the StoreKit
   * sheet and never by recovery, restore, or finishing, which keep using
   * `getAppAccountToken` alone; a refusal is `ITEM_UNAVAILABLE` with
   * `PURCHASES_PAUSED` (see `StorePurchaseGate` in `@mpgd/adapter-capacitor`).
   */
  readonly purchaseGate?: StorePurchaseGate;
  /** Recorded in the evidence payload when known; the backend checks the signed value anyway. */
  readonly bundleId?: string;
  readonly sdk?: CapacitorStoreKitStoreSdkPlugin;
  readonly isIos?: () => boolean;
  /** Extra store codes merged over the StoreKit table. */
  readonly mapError?: StoreSdkErrorCodeMap;
  /**
   * Observes transactions the SDK keeps away from the reconciler: unmapped
   * SKUs, transactions bound to another app account token, and StoreKit
   * types that disagree with the catalog kind. Diagnostics only.
   */
  readonly onDiagnostic?: (diagnostic: CapacitorStoreKitDiagnostic) => void;
}

/**
 * Commerce v2 `CommerceProvider` for the App Store: `createStoreCommerceProvider`
 * over `createCapacitorStoreKitStoreSdk` with the App Store profile,
 * `authority: { evidence: 'client-token', accountBinding: 'required' }`, and
 * `app-store.signed-transaction.v1` evidence whose `signedTransaction` is the
 * same JWS as `StorePurchase.token`. The provider never grants: the game
 * backend verifies the JWS, writes the ledger entry, and only then does the
 * reconciler call `finishTransaction` with that entry id.
 */
export function createCapacitorStoreKitCommerceProvider(
  input: CreateCapacitorStoreKitCommerceProviderInput,
): StoreCommerceProvider {
  if (!Array.isArray(input.products) || input.products.length === 0) {
    throw new TypeError('StoreKit requires at least one product mapping.');
  }
  for (const product of input.products) {
    if (product.kind === 'subscription') {
      throw new TypeError(
        `StoreKit product ${product.logicalId} is a subscription; only one-time products are sold.`,
      );
    }
  }
  if (typeof input.getAppAccountToken !== 'function') {
    throw new TypeError('StoreKit requires getAppAccountToken.');
  }
  if (input.bundleId !== undefined
    && (typeof input.bundleId !== 'string' || input.bundleId.trim() === '')) {
    throw new TypeError('StoreKit bundleId must be a non-empty string when provided.');
  }
  const bundleId = input.bundleId;
  const gate = resolvePurchaseGateSupport(input.purchaseGate);
  const sdk = createCapacitorStoreKitStoreSdk({
    products: input.products.map((product) => ({
      sku: product.storeSku,
      kind: product.kind === 'consumable' ? 'consumable' : 'durable',
    })),
    getAppAccountToken: input.getAppAccountToken,
    ...(input.sdk === undefined ? {} : { sdk: input.sdk }),
    ...(input.isIos === undefined ? {} : { isIos: input.isIos }),
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
  });
  return createStoreCommerceProvider({
    sdk,
    store: appStoreStoreId,
    products: input.products,
    evidenceSchema: appStoreSignedTransactionEvidenceSchema,
    evidencePayload: (purchase): PlatformEvidenceEnvelope['payload'] => {
      const payload: AppStoreSignedTransactionEvidencePayload = {
        signedTransaction: purchase.token,
        transactionId: purchase.transactionId,
        ...(purchase.originalTransactionId === undefined
          ? {}
          : { originalTransactionId: purchase.originalTransactionId }),
        ...(bundleId === undefined ? {} : { bundleId }),
      };
      return { ...payload };
    },
    accountBinding: async (): Promise<StorePurchaseAccountBinding> => {
      if (gate.refuseNewPurchases) {
        throw createPurchaseGateUnsupportedError();
      }
      let value: unknown;
      try {
        value = await input.getAppAccountToken();
      } catch (error) {
        if (error instanceof CommerceError) {
          throw error;
        }
        throw new CommerceError('ACCOUNT_BINDING_REQUIRED', {
          message: 'The StoreKit app account token could not be resolved.',
          storeCode: 'STOREKIT_ACCOUNT_LOOKUP_FAILED',
          cause: error,
        });
      }
      try {
        return {
          kind: 'app-account-token',
          value: readAppAccountToken({
            kind: 'app-account-token',
            ...(typeof value === 'string' ? { value } : {}),
          }),
        };
      } catch (error) {
        throw new CommerceError('CONFIGURATION_REQUIRED', {
          message: 'StoreKit requires a non-nil UUID app account token.',
          storeCode: 'STOREKIT_CONFIGURATION_ERROR',
          cause: error,
        });
      }
    },
    ...(gate.purchaseGate === undefined ? {} : { purchaseGate: gate.purchaseGate }),
    authority: storeKitCommerceAuthority,
    mapError: { ...capacitorStoreKitErrorCodeMap, ...input.mapError },
  });
}

export interface CreateCapacitorStoreKitServiceProviderInput
  extends CreateCapacitorStoreKitCommerceProviderInput {
  /** Registry id. Defaults to `apple-storekit`. */
  readonly id?: string;
}

/**
 * The commerce provider wrapped as a `CapacitorServiceProvider` for
 * `createCapacitorPlatformGateway({ providers })`: the registry serves the six
 * `commerce.v2.*` bridge methods from it, exposes it as `gateway.commerce`, and
 * reports its capability block in `getCapabilities()`.
 */
export function createCapacitorStoreKitServiceProvider(
  input: CreateCapacitorStoreKitServiceProviderInput,
): CapacitorCommerceServiceProvider {
  const { id, ...providerInput } = input;
  return createCommerceServiceProvider({
    id: id ?? 'apple-storekit',
    commerce: createCapacitorStoreKitCommerceProvider(providerInput),
  });
}

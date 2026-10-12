import {
  createCommerceServiceProvider,
  createStoreCommerceProvider,
  type CapacitorCommerceServiceProvider,
  type StoreCommerceProductMapping,
  type StoreCommerceProvider,
  type StoreSdkErrorCodeMap,
  type StoreSdkPurchase,
} from '@mpgd/adapter-capacitor';
import type { PlatformEvidenceEnvelope } from '@mpgd/platform';
import {
  CommerceError,
  type StoreId,
  type StorePurchaseAccountBinding,
} from '@mpgd/platform/commerce';

import {
  googlePlayProductPurchaseEvidenceSchema,
  playBillingCommerceAuthority,
} from './commerce-profile.js';
import type { CapacitorPlayBillingPlugin, PlayPurchase } from './definitions.js';
import {
  createCapacitorPlayBillingStoreSdk,
  googlePlayStoreId,
  playBillingStoreSdkErrorCodeMap,
  type PlayBillingStoreSdkProduct,
} from './store-sdk.js';

// The profile constants live in the SDK-free `commerce-profile.ts` so a tools
// project can read them without loading Capacitor; they stay exported here.
export { googlePlayProductPurchaseEvidenceSchema, playBillingCommerceAuthority };

/** The default registry id of the Play Billing commerce v2 service provider. */
export const playBillingCommerceServiceProviderId = 'google-play-billing' as const;

/**
 * Evidence payload of a Play purchase: exactly `{ purchaseToken }`, which is
 * what `createGooglePlayProductPurchaseBoundary` reads.
 */
export function createPlayBillingEvidencePayload(
  purchase: Pick<StoreSdkPurchase, 'token'>,
): PlatformEvidenceEnvelope['payload'] {
  return { purchaseToken: purchase.token };
}

/** One catalog product sold through Play; `offerId` is the default one-time offer token. */
export interface PlayBillingCommerceProductMapping extends StoreCommerceProductMapping {
  readonly kind: 'consumable' | 'durable';
}

export interface CreateCapacitorPlayBillingCommerceProviderInput {
  readonly products: readonly PlayBillingCommerceProductMapping[];
  /**
   * Resolves the player's obfuscated account id (`{ kind:
   * 'obfuscated-account-id', value }`) before a purchase opens. It must agree
   * with the backend's `resolveObfuscatedAccountId`. A thrown lookup becomes
   * `ACCOUNT_BINDING_REQUIRED` with `PLAY_BILLING_ACCOUNT_LOOKUP_FAILED` kept.
   */
  readonly accountBinding: () =>
    | Promise<StorePurchaseAccountBinding | undefined>
    | StorePurchaseAccountBinding
    | undefined;
  /** Defaults to the registered `CapacitorPlayBilling` plugin. */
  readonly plugin?: CapacitorPlayBillingPlugin;
  /** Defaults to `Capacitor.getPlatform() === 'android'`. */
  readonly isAndroid?: () => boolean;
  /**
   * Store id on purchases and in derived idempotency keys. Defaults to
   * `google-play`, which keeps the `play-token-sha256:<hex>` key existing ledgers
   * hold; a conformance harness sets the vector's fixture store id.
   */
  readonly store?: StoreId;
  /** Extra plugin codes merged over `playBillingStoreSdkErrorCodeMap`. */
  readonly mapError?: StoreSdkErrorCodeMap;
  /** Diagnostics for plugin purchases left out of recovery (retired SKU, multi-line); see the SDK input. */
  readonly onUnmappedPurchase?: (purchase: PlayPurchase) => void;
}

/**
 * Commerce v2 `CommerceProvider` for Google Play: `createStoreCommerceProvider`
 * over `createCapacitorPlayBillingStoreSdk`, with store `google-play`, evidence
 * schema `google-play.product-purchase.v2` carrying `{ purchaseToken }`, and
 * the `client-token` / `required` authority block. Finishing stays on the
 * server (the backend acknowledges or consumes after the ledger grant), so
 * the provider has no `finishTransaction` and no `restorePurchases`. It never
 * grants.
 */
export function createCapacitorPlayBillingCommerceProvider(
  input: CreateCapacitorPlayBillingCommerceProviderInput,
): StoreCommerceProvider {
  const sdkProducts: PlayBillingStoreSdkProduct[] = [];
  for (const mapping of input.products) {
    if (mapping.kind !== 'consumable' && mapping.kind !== 'durable') {
      throw new TypeError(
        `Play Billing sells one-time products only; ${String(mapping.logicalId)} is ${String(mapping.kind)}.`,
      );
    }
    sdkProducts.push({
      sku: mapping.storeSku,
      kind: mapping.kind,
      ...(mapping.offerId === undefined ? {} : { offerToken: mapping.offerId }),
    });
  }
  const sdk = createCapacitorPlayBillingStoreSdk({
    products: sdkProducts,
    ...(input.plugin === undefined ? {} : { plugin: input.plugin }),
    ...(input.isAndroid === undefined ? {} : { isAndroid: input.isAndroid }),
    ...(input.onUnmappedPurchase === undefined
      ? {}
      : { onUnmappedPurchase: input.onUnmappedPurchase }),
  });
  const resolveAccountBinding = input.accountBinding;
  return createStoreCommerceProvider({
    sdk,
    store: input.store ?? googlePlayStoreId,
    products: input.products,
    evidenceSchema: googlePlayProductPurchaseEvidenceSchema,
    evidencePayload: createPlayBillingEvidencePayload,
    accountBinding: async () => {
      try {
        return await resolveAccountBinding();
      } catch (error) {
        throw new CommerceError('ACCOUNT_BINDING_REQUIRED', {
          message: 'Play Billing could not resolve the obfuscated account id.',
          storeCode: 'PLAY_BILLING_ACCOUNT_LOOKUP_FAILED',
          cause: error,
        });
      }
    },
    authority: playBillingCommerceAuthority,
    mapError: { ...playBillingStoreSdkErrorCodeMap, ...input.mapError },
  });
}

export interface CreateCapacitorPlayBillingServiceProviderInput
  extends CreateCapacitorPlayBillingCommerceProviderInput {
  /** Registry id; defaults to `google-play-billing`. */
  readonly id?: string;
}

/**
 * Registry entry for `createCapacitorPlatformGateway({ providers })`: the
 * gateway serves the six `commerce.v2.*` bridge methods, exposes the provider
 * as `gateway.commerce`, and reports its capability block (Play sells no
 * subscriptions in this release).
 */
export function createCapacitorPlayBillingServiceProvider(
  input: CreateCapacitorPlayBillingServiceProviderInput,
): CapacitorCommerceServiceProvider & { readonly commerce: StoreCommerceProvider } {
  const { id, ...providerInput } = input;
  const commerce = createCapacitorPlayBillingCommerceProvider(providerInput);
  return {
    ...createCommerceServiceProvider({
      id: id ?? playBillingCommerceServiceProviderId,
      commerce,
    }),
    commerce,
  };
}

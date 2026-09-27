import { Capacitor } from '@capacitor/core';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { ProductInfo, PurchaseResult } from '@mpgd/platform';

import { CapacitorPlayBilling } from './plugin.js';
import type {
  CapacitorPlayBillingPlugin,
  PlayProduct,
  PlayPurchase,
  PlayPurchaseOutcome,
} from './definitions.js';

const googlePlayProductPurchaseEvidenceSchema = 'google-play.product-purchase.v2';

class PlayPurchaseIntegrityError extends Error {}

function isValidPurchaseToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export interface PlayBillingProductMapping {
  readonly id: string;
  readonly type: 'consumable' | 'non_consumable';
  readonly storeId: string;
  /** Required when Play lists multiple eligible purchase options or offers. */
  readonly offerToken?: string;
}

export interface PlayBillingProviderOptions {
  readonly products: readonly PlayBillingProductMapping[];
  /** Must agree with the server's resolveObfuscatedAccountId mapping. */
  readonly getObfuscatedAccountId: () => Promise<string> | string;
  readonly sdk?: Pick<CapacitorPlayBillingPlugin, 'getProducts' | 'purchase' | 'getPurchases'>;
  readonly isAndroid?: () => boolean;
}

export interface OwnedPlayPurchase {
  readonly productId: string;
  readonly result: PurchaseResult;
  readonly purchasedAt?: string;
}

export type PlayBillingAvailability =
  | 'available'
  | 'configuration-required'
  | 'temporarily-unavailable'
  | 'unsupported';

export interface CapacitorPlayBillingProvider {
  readonly id: 'google-play-billing';
  readonly features: readonly ['nativeIap'];
  readonly methods: readonly [
    'commerce.getProducts',
    'commerce.purchase',
    'commerce.restore',
    'commerce.getEntitlements',
  ];
  readonly bridge: { request(input: BridgeRequest): Promise<BridgeResponse> };
  getAvailability(): Promise<Readonly<{ nativeIap: PlayBillingAvailability }>>;
  /** Requery owned, non-consumed transactions for game-owned backend recovery. */
  getOwnedPurchases(): Promise<readonly OwnedPlayPurchase[]>;
}

export interface RecoveredPlayPurchase {
  readonly productId: string;
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly verification?: PlayPurchaseVerification;
}

export interface PlayPurchaseVerification {
  readonly verified: boolean;
  readonly disposition?: 'pending' | 'rejected';
  readonly alreadyProcessed: boolean;
  readonly ledgerEntryId?: string;
  readonly reason?: string;
}

export interface PlayPurchaseRecoveryBackend {
  verifyPurchase(input: {
    readonly target: 'android';
    readonly deploymentTarget?: string;
    readonly playerId: string;
    readonly productId: string;
    readonly platformTransactionId: string;
    readonly idempotencyKey: string;
    readonly purchasedAt: string;
    readonly evidence: NonNullable<PurchaseResult['evidence']>;
  }): Promise<PlayPurchaseVerification>;
}

/**
 * Resubmit owned purchases after a callback was missed or the app restarted.
 * A native purchase is never credited locally; only the backend response grants it.
 */
export async function recoverOwnedPlayPurchases(input: {
  readonly provider: CapacitorPlayBillingProvider;
  readonly backend: PlayPurchaseRecoveryBackend;
  readonly playerId: string;
  readonly deploymentTarget?: string;
  readonly now?: () => string;
}): Promise<readonly RecoveredPlayPurchase[]> {
  if (input.playerId.trim() === '') {
    throw new TypeError('Recovery requires an authenticated player ID.');
  }
  const owned = await input.provider.getOwnedPurchases();
  return Promise.all(owned.map(async ({ productId, result, purchasedAt }) => {
    if (result.status === 'pending') {
      return { productId, status: 'pending' } as const;
    }
    if (result.status !== 'completed' || result.transactionId === undefined
      || result.evidence === undefined) {
      return { productId, status: 'rejected' } as const;
    }
    const token = result.evidence.payload.purchaseToken;
    if (typeof token !== 'string') {
      return { productId, status: 'rejected' } as const;
    }
    try {
      const verification = await input.backend.verifyPurchase({
        target: 'android',
        ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
        playerId: input.playerId,
        productId,
        platformTransactionId: result.transactionId,
        idempotencyKey: await createGooglePlayTokenTransactionId(token),
        purchasedAt: purchasedAt ?? input.now?.() ?? new Date().toISOString(),
        evidence: result.evidence,
      });
      return {
        productId,
        status: verification.verified ? 'granted' : (verification.disposition ?? 'pending'),
        verification,
      } as const;
    } catch {
      // Network or backend uncertainty must remain retryable, never rejected.
      return { productId, status: 'pending' } as const;
    }
  }));
}

export function createCapacitorPlayBillingProvider(
  options: PlayBillingProviderOptions,
): CapacitorPlayBillingProvider {
  const sdk = options.sdk ?? CapacitorPlayBilling;
  const isAndroid = options.isAndroid ?? (() => Capacitor.getPlatform() === 'android');
  const byLogicalId = new Map<string, PlayBillingProductMapping>();
  const byStoreId = new Map<string, PlayBillingProductMapping>();
  for (const product of options.products) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(product.id)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(product.storeId)
      || byLogicalId.has(product.id)
      || byStoreId.has(product.storeId)
    ) {
      throw new TypeError('Play Billing product mappings must be unique and valid.');
    }
    byLogicalId.set(product.id, product);
    byStoreId.set(product.storeId, product);
  }
  if (byLogicalId.size === 0) {
    throw new TypeError('Play Billing requires at least one one-time product.');
  }
  if (byLogicalId.size > 100) {
    throw new TypeError('Play Billing supports at most 100 products per provider.');
  }

  async function getOwnedPurchases(): Promise<readonly OwnedPlayPurchase[]> {
    if (!isAndroid()) {
      throw new Error('Play Billing is only available on Android.');
    }
    const response = await sdk.getPurchases();
    const owned: OwnedPlayPurchase[] = [];
    for (const purchase of response.purchases) {
      if (purchase.productIds.length !== 1) {
        continue;
      }
      const mapping = byStoreId.get(purchase.productIds[0] ?? '');
      if (mapping !== undefined) {
        const timestamp = purchase.purchaseTimeMillis;
        const purchasedAt = typeof timestamp === 'number'
          && Number.isSafeInteger(timestamp)
          && timestamp > 0
          && timestamp <= 8_640_000_000_000_000
            ? new Date(timestamp).toISOString()
            : undefined;
        owned.push({
          productId: mapping.id,
          result: await convertPurchase(purchase),
          ...(purchasedAt === undefined ? {} : { purchasedAt }),
        });
      }
    }
    return owned;
  }

  function selectOffer(mapping: PlayBillingProductMapping, found: PlayProduct) {
    if (mapping.offerToken === undefined) {
      return found.offers.length === 1 ? found.offers[0] : undefined;
    }
    return found.offers.find((item) => item.offerToken === mapping.offerToken);
  }

  async function request(input: BridgeRequest): Promise<BridgeResponse> {
    try {
      if (!isAndroid()) {
        return failure(input.id, 'PLAY_BILLING_ANDROID_REQUIRED');
      }
      switch (input.method) {
        case 'commerce.getProducts': {
          const response = await sdk.getProducts({
            productIds: [...byStoreId.keys()],
          });
          const products: ProductInfo[] = [];
          for (const found of response.products) {
            const mapping = byStoreId.get(found.productId);
            if (mapping === undefined) {
              continue;
            }
            const offer = selectOffer(mapping, found);
            if (offer === undefined) {
              return failure(input.id, 'PLAY_BILLING_OFFER_REQUIRED');
            }
            products.push({
              id: mapping.id,
              type: mapping.type,
              title: found.title,
              description: found.description,
              price: {
                formatted: offer.formattedPrice,
                currencyCode: offer.currencyCode,
              },
            });
          }
          return success(input.id, products);
        }
        case 'commerce.purchase': {
          const payload = input.payload;
          const productId = isRecord(payload) ? payload.productId : undefined;
          const mapping = typeof productId === 'string' ? byLogicalId.get(productId) : undefined;
          if (mapping === undefined) {
            return failure(input.id, 'PLAY_BILLING_PRODUCT_UNKNOWN');
          }
          let obfuscatedAccountId: string;
          try {
            obfuscatedAccountId = await options.getObfuscatedAccountId();
          } catch {
            return failure(input.id, 'PLAY_BILLING_ACCOUNT_LOOKUP_FAILED');
          }
          if (!/^[A-Za-z0-9._-]{1,64}$/u.test(obfuscatedAccountId)) {
            return failure(input.id, 'PLAY_BILLING_ACCOUNT_REQUIRED');
          }
          const outcome = await sdk.purchase({
            productId: mapping.storeId,
            obfuscatedAccountId,
            ...(mapping.offerToken === undefined ? {} : { offerToken: mapping.offerToken }),
          });
          return success(input.id, await convertOutcome(outcome, mapping.storeId));
        }
        case 'commerce.restore':
          // Native ownership is not an authoritative entitlement. The game
          // must submit getOwnedPurchases() results to its backend separately.
          return success(input.id, { restoredEntitlements: [] });
        case 'commerce.getEntitlements':
          return success(input.id, []);
        default:
          return failure(input.id, 'PLAY_BILLING_METHOD_UNSUPPORTED');
      }
    } catch (error) {
      if (error instanceof PlayPurchaseIntegrityError) {
        return failure(input.id, 'PLAY_BILLING_EVIDENCE_INVALID');
      }
      const code = isRecord(error) ? error.code : undefined;
      if (typeof code === 'string' && /^PLAY_BILLING_[A-Z_]+$/u.test(code)) {
        if (
          input.method === 'commerce.purchase'
          && (
            code === 'PLAY_BILLING_TIMEOUT'
            || code === 'PLAY_BILLING_INTERRUPTED'
            || code === 'PLAY_BILLING_EMPTY_PURCHASE'
            || code === 'PLAY_BILLING_ALREADY_OWNED'
          )
        ) {
          // The purchase may have completed without an observed callback.
          // Requery owned purchases; never launch another flow blindly.
          return success(input.id, { status: 'pending', entitlementIds: [] });
        }
        const retryable = code === 'PLAY_BILLING_DISCONNECTED'
          || code === 'PLAY_BILLING_SERVICE_UNAVAILABLE'
          || code === 'PLAY_BILLING_NETWORK_ERROR'
          || code === 'PLAY_BILLING_TRANSIENT_ERROR';
        return failure(input.id, code, retryable);
      }
      return failure(input.id, 'PLAY_BILLING_UNAVAILABLE', true);
    }
  }

  return {
    id: 'google-play-billing',
    features: ['nativeIap'],
    methods: [
      'commerce.getProducts',
      'commerce.purchase',
      'commerce.restore',
      'commerce.getEntitlements',
    ],
    bridge: { request },
    async getAvailability() {
      if (!isAndroid()) {
        return { nativeIap: 'unsupported' };
      }
      try {
        const response = await sdk.getProducts({ productIds: [...byStoreId.keys()] });
        const hasPurchasableProduct = response.products.some((found) => {
          const mapping = byStoreId.get(found.productId);
          return mapping !== undefined && selectOffer(mapping, found) !== undefined;
        });
        return { nativeIap: hasPurchasableProduct ? 'available' : 'configuration-required' };
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        const configurationError = code === 'PLAY_BILLING_CONFIGURATION_ERROR'
          || code === 'PLAY_BILLING_PRODUCT_UNAVAILABLE'
          || code === 'PLAY_BILLING_OFFER_REQUIRED'
          || code === 'PLAY_BILLING_INVALID_PRODUCTS'
          || code === 'PLAY_BILLING_INVALID_PRODUCT';
        return { nativeIap: configurationError
          ? 'configuration-required'
          : 'temporarily-unavailable' };
      }
    },
    getOwnedPurchases,
  };
}

async function convertOutcome(
  outcome: PlayPurchaseOutcome,
  expectedStoreId: string,
): Promise<PurchaseResult> {
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', entitlementIds: [] };
  }
  const purchase = outcome.purchase;
  if (
    purchase === undefined
    || purchase.productIds.length !== 1
    || purchase.productIds[0] !== expectedStoreId
  ) {
    throw new PlayPurchaseIntegrityError('Play purchase did not match the requested product.');
  }
  if (
    (outcome.status === 'purchased' && purchase.state !== 'purchased')
    || (outcome.status === 'pending' && purchase.state !== 'pending')
  ) {
    throw new PlayPurchaseIntegrityError('Play purchase state is inconsistent.');
  }
  return convertPurchase(purchase);
}

async function convertPurchase(purchase: PlayPurchase): Promise<PurchaseResult> {
  if (purchase.state !== 'pending' && purchase.state !== 'purchased') {
    throw new PlayPurchaseIntegrityError('Play purchase state is invalid.');
  }
  if (!isValidPurchaseToken(purchase.purchaseToken)) {
    throw new PlayPurchaseIntegrityError('Play purchase token is invalid.');
  }
  const evidence = {
    schema: googlePlayProductPurchaseEvidenceSchema,
    payload: { purchaseToken: purchase.purchaseToken },
  };
  if (purchase.state === 'pending') {
    return { status: 'pending', entitlementIds: [], evidence };
  }
  const transactionId = purchase.orderId?.trim()
    || await createGooglePlayTokenTransactionId(purchase.purchaseToken);
  return {
    status: 'completed',
    transactionId,
    entitlementIds: [],
    evidence,
  };
}

/** Must remain byte-for-byte compatible with the server's token transaction ID. */
export async function createGooglePlayTokenTransactionId(purchaseToken: string): Promise<string> {
  if (!isValidPurchaseToken(purchaseToken)) {
    throw new TypeError('Google Play purchase token is invalid.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('Web Crypto is required to hash Google Play purchase tokens.');
  }
  const digest = new Uint8Array(await subtle.digest(
    'SHA-256', new TextEncoder().encode(purchaseToken),
  ));
  return `play-token-sha256:${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function success(id: string, data: unknown): BridgeResponse {
  return { id, ok: true, data };
}

function failure(id: string, code: string, retryable = false): BridgeResponse {
  return { id, ok: false, error: { code, message: code, retryable } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

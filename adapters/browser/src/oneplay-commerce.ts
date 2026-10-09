import {
  PlatformOperationError,
  type CommerceAdapter,
  type Entitlement,
  type PlatformPurchasePresentationEvent,
  type ProductType,
  type PurchaseRestoreResult,
  type PurchaseResult,
} from '@mpgd/platform';
import { onePlayFullscreenOwners } from './oneplay-ads.js';
import type { OnePlaySdk } from './oneplay-sdk.js';

export interface OnePlayCommerceServerPort {
  /** Authenticated server intent issuance; never construct the payload in the game. */
  issueIntent(input: { readonly productId: string; readonly platformProductId: string; readonly idempotencyKey: string }): Promise<{ readonly developerPayload: string }>;
  getEntitlements(): Promise<readonly Entitlement[]>;
  /** Reconcile server records and return ledger-confirmed outcomes. The SDK has no restore API. */
  restore?(): Promise<PurchaseRestoreResult>;
}
export interface OnePlayCommerceProduct {
  readonly id: string;
  readonly platformId: string;
  readonly type: Exclude<ProductType, 'subscription'>;
}
export function createOnePlayCommerceAdapter(input: {
  readonly sdk?: OnePlaySdk;
  readonly products?: readonly OnePlayCommerceProduct[];
  readonly server?: OnePlayCommerceServerPort;
}): CommerceAdapter {
  const { sdk, server } = input;
  const iap = sdk?.iap;
  const restore = server?.restore?.bind(server);
  const listeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
  const products = (input.products ?? []).map((product) => Object.freeze({ ...product }));
  const logicalIds = new Set<string>();
  const physicalIds = new Set<string>();
  for (const product of products) {
    if (!identifier(product.id) || !identifier(product.platformId) || !['consumable', 'non_consumable'].includes(product.type)
      || logicalIds.has(product.id) || physicalIds.has(product.platformId)) {
      throw new TypeError('ONE play commerce product mapping is invalid.');
    }
    logicalIds.add(product.id);
    physicalIds.add(product.platformId);
  }
  const flights = new Map<string, { readonly productId: string; readonly source: string; readonly result: Promise<PurchaseResult> }>();
  return {
    presentation: { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    async getProducts() {
      if (!iap?.isSupported('getProductDetails')) { return []; }
      const result = [];
      for (let start = 0; start < products.length; start += 20) {
        const batch = products.slice(start, start + 20);
        const details = await iap.getProductDetailsAsync(batch.map((product) => product.platformId));
        const seen = new Set<string>();
        for (const detail of details) {
          const product = batch.find((candidate) => candidate.platformId === detail.productId);
          if (product === undefined || seen.has(detail.productId) || detail.type !== 'inapp'
            || typeof detail.price !== 'string' || detail.price.length === 0 || !/^[A-Z]{3}$/u.test(detail.priceCurrencyCode)
            || !Number.isSafeInteger(detail.priceAmountMicros) || detail.priceAmountMicros < 0) { continue; }
          seen.add(detail.productId);
          result.push({ id: product.id, type: product.type, title: detail.title, description: '', price: { formatted: `${detail.price} ${detail.priceCurrencyCode}`, currencyCode: detail.priceCurrencyCode } });
        }
      }
      return result;
    },
    purchase(request) {
      if (!identifier(request.idempotencyKey)) { throw new TypeError('ONE play purchase identity is invalid.'); }
      const previous = flights.get(request.idempotencyKey);
      if (previous !== undefined) {
        if (previous.productId !== request.productId || previous.source !== request.source) { throw new TypeError('ONE play purchase identity changed.'); }
        return previous.result;
      }
      const product = products.find((candidate) => candidate.id === request.productId);
      let sequence = 0;
      const emit = (state: PlatformPurchasePresentationEvent['state']) => {
        const event = Object.freeze({ idempotencyKey: request.idempotencyKey, sequence: ++sequence, state });
        for (const listener of listeners) { try { listener(event); } catch { /* Observers cannot change native ownership. */ } }
      };
      if (sdk === undefined || iap?.isSupported('purchase') !== true || server === undefined || product === undefined) { emit('not-started'); return Promise.resolve({ status: 'failed', entitlementIds: [] }); }
      if (onePlayFullscreenOwners.has(sdk)) { throw new PlatformOperationError({ code: 'ONEPLAY_BUSY', retryable: false }); }
      const owner = {};
      onePlayFullscreenOwners.set(sdk, owner);
      const release = () => { if (onePlayFullscreenOwners.get(sdk) === owner) { onePlayFullscreenOwners.delete(sdk); } };
      const result = Promise.resolve().then(async (): Promise<PurchaseResult> => {
        let developerPayload: string;
        try {
          const intent = await server.issueIntent({ productId: product.id, platformProductId: product.platformId, idempotencyKey: request.idempotencyKey });
          if (!identifier(intent.developerPayload) || new TextEncoder().encode(intent.developerPayload).length > 200) { throw new TypeError('Invalid ONE play checkout intent.'); }
          developerPayload = intent.developerPayload;
        } catch {
          release();
          emit('not-started');
          return { status: 'failed', entitlementIds: [] };
        }
        try {
          // No local timeout: the host may keep payment UI open. Unknown outcomes retain ownership.
          const purchase = await iap.purchase({ productId: product.platformId, developerPayload });
          if (!identifier(purchase.purchaseId) || !identifier(purchase.purchaseToken) || purchase.productId !== product.platformId
            || purchase.developerPayload !== developerPayload) { emit('unknown'); return { status: 'pending', entitlementIds: [] }; }
          release();
          emit('closed');
          return { status: 'completed', transactionId: purchase.purchaseId, entitlementIds: [], evidence: {
            schema: 'oneplay.managed-purchase.v1', payload: { purchaseToken: purchase.purchaseToken, purchaseId: purchase.purchaseId, productId: product.platformId, developerPayload },
          } };
        } catch (error: unknown) {
          const reason = typeof error === 'object' && error !== null && 'reason' in error ? error.reason : undefined;
          if (reason === 'user_cancelled') { release(); emit('closed'); return { status: 'cancelled', entitlementIds: [] }; }
          if (typeof reason === 'string' && ['invalid_request', 'invalid_params', 'platform_not_supported', 'unsupported_action', 'sdk_not_initialized', 'already_processing', 'already_owned', 'need_login', 'need_update', 'security_error', 'payment_failed'].includes(reason)) {
            release();
            emit('closed');
            return { status: 'failed', entitlementIds: [] };
          }
          emit('unknown');
          return { status: 'pending', entitlementIds: [] };
        }
      });
      flights.set(request.idempotencyKey, { productId: request.productId, source: request.source, result });
      return result;
    },
    async getEntitlements() {
      if (server === undefined) { throw new PlatformOperationError({ code: 'ONEPLAY_SERVER_REQUIRED', retryable: false }); }
      return server.getEntitlements();
    },
    ...(restore === undefined ? {} : { restore }),
  };
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

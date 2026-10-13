import {
  type CommerceCapabilities,
  type PlatformProviderAvailability,
  type PlatformPurchasePresentationEvent,
  type ProductType,
} from '@mpgd/platform';
import {
  CommerceError,
  commerceErrorInfoOf,
  isStoreProduct,
  isStorePurchase,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceProvider,
  type FetchProductsInput,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
} from '@mpgd/platform/commerce';
import { onePlayFullscreenOwners } from './oneplay-ads.js';
import type { OnePlayProductDetails, OnePlaySdk } from './oneplay-sdk.js';

/** Store id of the ONE play provider and of the `oneplay.managed-purchase.v1` evidence. */
export const onePlayCommerceStoreId = 'oneplay' as const satisfies StoreId;
/** Evidence schema of a successful SDK checkout; the backend verifies the purchase token itself. */
export const onePlayManagedPurchaseEvidenceSchema = 'oneplay.managed-purchase.v1' as const;

export interface OnePlayCommerceServerPort {
  /** Authenticated server intent issuance; never construct the payload in the game. */
  issueIntent(input: { readonly productId: string; readonly platformProductId: string; readonly idempotencyKey: string }): Promise<{ readonly developerPayload: string }>;
}
export interface OnePlayCommerceProduct {
  readonly id: string;
  readonly platformId: string;
  readonly type: Exclude<ProductType, 'subscription'>;
}

/** The ONE play provider: a commerce v2 provider that always offers trusted presentation facts. */
export interface OnePlayCommerceProvider extends CommerceProvider {
  readonly presentation: NonNullable<CommerceProvider['presentation']>;
}

export interface OnePlayCommerceCapabilityInput {
  readonly availability: PlatformProviderAvailability;
  /** Whether a mapped product is a `consumable`. */
  readonly consumable: boolean;
  /** Whether a mapped product is a `non_consumable`, sold as a `durable` purchase. */
  readonly durable: boolean;
  /** Whether the SDK supports `getProductDetails`, which fills the catalog. */
  readonly catalogProducts: boolean;
}

/**
 * The ONE play capability declaration (RFC "Capabilities" row `oneplay`):
 * one-time products, no purchase list and no events, a pending purchase kept
 * for the server, the backend consume or acknowledge finalizer finishing after
 * the ledger grant, and the purchase token as client-token evidence bound to
 * the host identity through the server-issued checkout intent. Pure: a fresh
 * object on every call, no SDK, no construction.
 */
export function createOnePlayCommerceCapabilities(
  input: OnePlayCommerceCapabilityInput,
): CommerceCapabilities {
  return {
    purchase: {
      consumable: input.consumable,
      durable: input.durable,
      subscription: false,
      quantity: false,
    },
    catalog: {
      products: input.catalogProducts,
      offers: false,
      localizedPrice: input.catalogProducts,
    },
    lifecycle: {
      availablePurchases: false,
      pending: true,
      restore: false,
      events: false,
      finish: 'server',
    },
    authority: { evidence: 'client-token', accountBinding: 'host' },
    availability: input.availability,
  };
}

/**
 * SDK failures that end the attempt: the native surface is closed (or was
 * never opened) and nothing was bought. Any other reason, including a
 * timeout, stays unknown. Values are the RFC "Errors" class of each reason.
 */
interface HardFailure {
  readonly code: CommerceErrorCode;
  readonly retryable?: boolean;
}
const hardFailureCodes: ReadonlyMap<string, HardFailure> = new Map<string, HardFailure>([
  ['invalid_request', { code: 'UNKNOWN' }],
  ['invalid_params', { code: 'UNKNOWN' }],
  // The host cannot sell at all; retrying the same call cannot change that.
  ['platform_not_supported', { code: 'STORE_UNAVAILABLE', retryable: false }],
  ['unsupported_action', { code: 'STORE_UNAVAILABLE', retryable: false }],
  ['sdk_not_initialized', { code: 'NOT_PREPARED' }],
  ['already_processing', { code: 'IN_PROGRESS' }],
  ['already_owned', { code: 'ALREADY_OWNED' }],
  ['need_login', { code: 'ACTION_REQUIRED' }],
  ['need_update', { code: 'ACTION_REQUIRED' }],
  ['security_error', { code: 'UNKNOWN' }],
  ['payment_failed', { code: 'UNKNOWN' }],
]);

/**
 * Commerce v2 provider over the ONE store H5 SDK purchase flow. A purchase
 * opens only after the game's authenticated server issued a checkout intent;
 * the SDK answer is client-token evidence (`oneplay.managed-purchase.v1`) for
 * the backend to verify against the ONE purchase API. The provider never
 * grants, consumes, or acknowledges: the server boundary finishes a purchase
 * after the ledger grant (`lifecycle.finish: 'server'`), so there is no
 * `finishTransaction`. The SDK has no purchase list, restore, or event API, so
 * `getAvailablePurchases` is empty and recovery stays with the server (PNS and
 * the durable reconciliation queue).
 *
 * `requestPurchase` answers `purchased` with the SDK purchase, `cancelled` for
 * a user cancellation, `failed` for the SDK's hard failures, and `launched`
 * for any outcome it cannot classify (timeout, transport, mismatched answer):
 * the native surface may still be open, so ownership is retained and nothing
 * is granted. Trusted closure facts arrive on `presentation`.
 */
export function createOnePlayCommerceProvider(input: {
  readonly sdk?: OnePlaySdk;
  readonly products?: readonly OnePlayCommerceProduct[];
  readonly server?: OnePlayCommerceServerPort;
}): OnePlayCommerceProvider {
  const { sdk, server } = input;
  const iap = sdk?.iap;
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
  const flights = new Map<string, { readonly identity: string; readonly result: Promise<RequestPurchaseResult> }>();
  const store = onePlayCommerceStoreId;
  return {
    store,
    presentation: { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    async getCapabilities() {
      const purchaseSupported = iap?.isSupported('purchase') === true;
      return createOnePlayCommerceCapabilities({
        availability: !purchaseSupported
          ? 'unsupported'
          : server === undefined || products.length === 0 ? 'configuration-required' : 'available',
        consumable: products.some((product) => product.type === 'consumable'),
        durable: products.some((product) => product.type === 'non_consumable'),
        catalogProducts: iap?.isSupported('getProductDetails') === true,
      });
    },
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      if (request.type === 'subscription' || !iap?.isSupported('getProductDetails')) { return []; }
      const requested = request.logicalIds === undefined
        ? products
        : products.filter((product) => request.logicalIds?.includes(product.id) === true);
      const result: StoreProduct[] = [];
      for (let start = 0; start < requested.length; start += 20) {
        const batch = requested.slice(start, start + 20);
        let details: readonly OnePlayProductDetails[];
        try {
          details = await iap.getProductDetailsAsync(batch.map((product) => product.platformId));
        } catch (error) {
          throw new CommerceError('STORE_UNAVAILABLE', {
            message: 'ONE play product details are unavailable.',
            retryable: true,
            cause: error,
          });
        }
        const seen = new Set<string>();
        for (const detail of details) {
          const product = batch.find((candidate) => candidate.platformId === detail.productId);
          if (product === undefined || seen.has(detail.productId) || detail.type !== 'inapp'
            || typeof detail.price !== 'string' || detail.price.length === 0 || !/^[A-Z]{3}$/u.test(detail.priceCurrencyCode)
            || !Number.isSafeInteger(detail.priceAmountMicros) || detail.priceAmountMicros < 0) { continue; }
          seen.add(detail.productId);
          const mapped: StoreProduct = {
            logicalId: product.id,
            store,
            storeSku: product.platformId,
            kind: product.type === 'consumable' ? 'consumable' : 'durable',
            title: detail.title,
            description: '',
            price: {
              formatted: `${detail.price} ${detail.priceCurrencyCode}`,
              currencyCode: detail.priceCurrencyCode,
              amountMicros: detail.priceAmountMicros,
            },
          };
          if (isStoreProduct(mapped)) { result.push(mapped); }
        }
      }
      return result;
    },
    requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      if (!identifier(request.idempotencyKey)) { return Promise.reject(new TypeError('ONE play purchase identity is invalid.')); }
      // Every field that changes what is bought binds the key, so a replay with
      // another quantity or offer is refused instead of answered from the flight.
      const identity = JSON.stringify([request.logicalId, request.source, request.offerId ?? null, request.quantity ?? null]);
      const previous = flights.get(request.idempotencyKey);
      if (previous !== undefined) {
        if (previous.identity !== identity) { return Promise.reject(new TypeError('ONE play purchase identity changed.')); }
        return previous.result;
      }
      const product = products.find((candidate) => candidate.id === request.logicalId);
      let sequence = 0;
      const emit = (state: PlatformPurchasePresentationEvent['state']) => {
        const event = Object.freeze({ idempotencyKey: request.idempotencyKey, sequence: ++sequence, state });
        for (const listener of listeners) { try { listener(event); } catch { /* Observers cannot change native ownership. */ } }
      };
      const notStarted = (error: CommerceError): Promise<RequestPurchaseResult> => {
        emit('not-started');
        return Promise.resolve({ outcome: 'failed', error: error.toCommerceErrorInfo() });
      };
      if (sdk === undefined || iap?.isSupported('purchase') !== true) {
        return notStarted(new CommerceError('STORE_UNAVAILABLE', { message: 'ONE play purchases are unavailable.', retryable: false }));
      }
      if (server === undefined) {
        return notStarted(new CommerceError('CONFIGURATION_REQUIRED', { message: 'ONE play checkout intents need a server integration.' }));
      }
      if (product === undefined || (request.quantity !== undefined && request.quantity > 1) || request.offerId !== undefined) {
        return notStarted(new CommerceError('ITEM_UNAVAILABLE', { message: `ONE play does not sell ${request.logicalId} this way.` }));
      }
      if (onePlayFullscreenOwners.has(sdk)) {
        emit('not-started');
        return Promise.reject(new CommerceError('IN_PROGRESS', { message: 'ONE play native UI is already open.', storeCode: 'ONEPLAY_BUSY', retryable: false }));
      }
      const owner = {};
      onePlayFullscreenOwners.set(sdk, owner);
      const release = () => { if (onePlayFullscreenOwners.get(sdk) === owner) { onePlayFullscreenOwners.delete(sdk); } };
      const result = Promise.resolve().then(async (): Promise<RequestPurchaseResult> => {
        const intentFailed = (error: CommerceErrorInfo): RequestPurchaseResult => {
          release();
          emit('not-started');
          return { outcome: 'failed', error };
        };
        let intent: Awaited<ReturnType<OnePlayCommerceServerPort['issueIntent']>>;
        try {
          intent = await server.issueIntent({ productId: product.id, platformProductId: product.platformId, idempotencyKey: request.idempotencyKey });
        } catch (error) {
          // The game server could not be reached or refused: nothing was bought.
          // `fetch()` rejects with a TypeError when the request never completes
          // (offline, DNS, CORS), which is a retryable network failure; any
          // other error keeps its own class.
          return intentFailed(error instanceof TypeError
            ? new CommerceError('NETWORK', { message: 'ONE play checkout intent could not be issued.', retryable: true, cause: error }).toCommerceErrorInfo()
            : commerceErrorInfoOf(error));
        }
        const developerPayload: unknown = typeof intent === 'object' && intent !== null ? intent.developerPayload : undefined;
        if (!identifier(developerPayload) || new TextEncoder().encode(developerPayload).length > 200) {
          return intentFailed(new CommerceError('INVALID_RESPONSE', { message: 'ONE play checkout intent is invalid.' }).toCommerceErrorInfo());
        }
        try {
          // No local timeout: the host may keep payment UI open. Unknown outcomes retain ownership.
          const purchase = await iap.purchase({ productId: product.platformId, developerPayload });
          const storePurchase: StorePurchase | undefined = identifier(purchase.purchaseId) && identifier(purchase.purchaseToken)
            && purchase.productId === product.platformId && purchase.developerPayload === developerPayload
            ? {
                store,
                transactionId: purchase.purchaseId,
                storeSku: product.platformId,
                logicalId: product.id,
                quantity: 1,
                state: 'purchased',
                token: purchase.purchaseToken,
                evidence: {
                  schema: onePlayManagedPurchaseEvidenceSchema,
                  payload: { purchaseToken: purchase.purchaseToken, purchaseId: purchase.purchaseId, productId: product.platformId, developerPayload },
                },
                accountBinding: { kind: 'host-identity' },
              }
            : undefined;
          if (storePurchase === undefined || !isStorePurchase(storePurchase)) { emit('unknown'); return { outcome: 'launched' }; }
          release();
          emit('closed');
          return { outcome: 'purchased', purchase: storePurchase };
        } catch (error: unknown) {
          const reason = typeof error === 'object' && error !== null && 'reason' in error ? error.reason : undefined;
          if (reason === 'user_cancelled') {
            release();
            emit('closed');
            return { outcome: 'cancelled', error: new CommerceError('USER_CANCELLED', { message: 'The ONE play purchase was cancelled.', storeCode: reason }).toCommerceErrorInfo() };
          }
          const failure = typeof reason === 'string' ? hardFailureCodes.get(reason) : undefined;
          if (typeof reason === 'string' && failure !== undefined) {
            release();
            emit('closed');
            return {
              outcome: 'failed',
              error: new CommerceError(failure.code, {
                message: `ONE play checkout failed: ${reason}.`,
                storeCode: reason,
                ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
              }).toCommerceErrorInfo(),
            };
          }
          emit('unknown');
          return { outcome: 'launched' };
        }
      });
      flights.set(request.idempotencyKey, { identity, result });
      return result;
    },
    async getAvailablePurchases() {
      // The SDK has no purchase list; the server owns unfinished purchases (PNS and reconciliation).
      return [];
    },
    subscribe() {
      // The SDK delivers no purchase events; the purchase result and `presentation` are the only signals.
      return () => {};
    },
  };
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

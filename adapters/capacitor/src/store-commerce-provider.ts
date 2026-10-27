import type { PlatformEvidenceEnvelope, PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertFinishTransactionInput,
  assertFinishTransactionResult,
  assertRequestPurchaseSupported,
  assertStoreProduct,
  assertStorePurchase,
  CommerceError,
  createCommerceEventBuffer,
  type CommerceAuthorityCapabilities,
  type CommerceCapabilities,
  type CommerceCatalogCapabilities,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceLifecycleCapabilities,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseCapabilities,
  type FetchProductsInput,
  type FinishTransactionInput,
  type FinishTransactionResult,
  type GetAvailablePurchasesInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseAccountBinding,
} from '@mpgd/platform/commerce';

import {
  defaultStoreSdkErrorCodeMap,
  normalizeStoreSdkError,
  type StoreSdk,
  type StoreSdkErrorCodeMap,
  type StoreSdkProduct,
  type StoreSdkPurchase,
  type StoreSdkRequestPurchaseResult,
} from './store-sdk.js';

/** One catalog product sold through the store under `storeSku`. */
export interface StoreCommerceProductMapping {
  readonly logicalId: CommerceLogicalProductId;
  readonly storeSku: string;
  readonly kind: PurchaseKind;
  /** Default store offer when the request names none. */
  readonly offerId?: string;
}

/** Deep-partial overrides applied over the capabilities composed from the SDK declaration. */
export interface StoreCommerceCapabilityOverrides {
  readonly purchase?: Partial<CommercePurchaseCapabilities>;
  readonly catalog?: Partial<CommerceCatalogCapabilities>;
  readonly lifecycle?: Partial<CommerceLifecycleCapabilities>;
}

export interface CreateStoreCommerceProviderInput {
  readonly sdk: StoreSdk;
  /** Defaults to `sdk.store`. */
  readonly store?: StoreId;
  readonly products: readonly StoreCommerceProductMapping[];
  /** Evidence schema the backend registry routes on, for example `google-play.product-purchase.v2`. */
  readonly evidenceSchema: string;
  /**
   * Evidence payload for a purchase. Defaults to the token, transaction id,
   * and SKU; a store provider replaces it to match its backend verifier.
   */
  readonly evidencePayload?: (purchase: StoreSdkPurchase) => PlatformEvidenceEnvelope['payload'];
  /** Resolves the player's store account binding before a purchase opens. */
  readonly accountBinding?: () => Promise<StorePurchaseAccountBinding | undefined>;
  readonly capabilities?: StoreCommerceCapabilityOverrides;
  readonly authority: CommerceAuthorityCapabilities;
  /** Per-store error codes merged over `defaultStoreSdkErrorCodeMap`. */
  readonly mapError?: StoreSdkErrorCodeMap;
}

export interface StoreCommerceProvider extends CommerceProvider {
  /** Detaches the SDK listeners; buffered events are dropped. */
  dispose(): void;
}

const availabilityTimeoutMs = 3_000;
const availabilitySet = new Set<PlatformProviderAvailability>([
  'unsupported',
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
  'available',
]);

/**
 * `CommerceProvider` over an in-process `StoreSdk`. The provider maps logical
 * ids to store SKUs both ways, composes `CommerceCapabilities` from the SDK
 * declaration, builds `StorePurchase` evidence, buffers SDK events until the
 * first subscriber, and normalizes every SDK failure into a `CommerceError`.
 * It never grants and never sets `settlement`; the backend ledger decides.
 */
export function createStoreCommerceProvider(
  input: CreateStoreCommerceProviderInput,
): StoreCommerceProvider {
  const { sdk } = input;
  const store = input.store ?? sdk.store;
  if (typeof store !== 'string' || store.length === 0) {
    throw new TypeError('A store commerce provider requires a non-empty store id.');
  }
  if (typeof input.evidenceSchema !== 'string' || input.evidenceSchema.length === 0) {
    throw new TypeError('A store commerce provider requires a non-empty evidence schema.');
  }
  const lifecycle = overrideLifecycle(sdk, input.capabilities);
  const finishOwner = lifecycle.finish;
  if ((finishOwner === 'client' || finishOwner === 'host') && sdk.finishTransaction === undefined) {
    throw new TypeError(
      `Store ${store} declares finish '${finishOwner}' but the SDK has no finishTransaction.`,
    );
  }
  if (lifecycle.restore && sdk.restorePurchases === undefined) {
    // A capability the provider cannot serve is never advertised.
    throw new TypeError(
      `Store ${store} declares lifecycle.restore but the SDK has no restorePurchases.`,
    );
  }
  const bySku = new Map<string, StoreCommerceProductMapping>();
  const byLogicalId = new Map<string, StoreCommerceProductMapping>();
  for (const mapping of input.products) {
    if (
      typeof mapping.logicalId !== 'string' || mapping.logicalId.length === 0
      || typeof mapping.storeSku !== 'string' || mapping.storeSku.length === 0
    ) {
      throw new TypeError('Store product mappings require a logical id and a store SKU.');
    }
    if (bySku.has(mapping.storeSku) || byLogicalId.has(mapping.logicalId)) {
      throw new TypeError(
        `Store product ${mapping.logicalId} (${mapping.storeSku}) is mapped twice.`,
      );
    }
    bySku.set(mapping.storeSku, mapping);
    byLogicalId.set(mapping.logicalId, mapping);
  }
  const mapError: StoreSdkErrorCodeMap = Object.freeze({
    ...defaultStoreSdkErrorCodeMap,
    ...input.mapError,
  });
  const normalize = (error: unknown): CommerceError => normalizeStoreSdkError(error, mapError);
  const evidencePayload = input.evidencePayload ?? defaultEvidencePayload;

  const toStorePurchase = (purchase: StoreSdkPurchase): StorePurchase => {
    if (!isRecord(purchase)) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: `Store ${store} reported an invalid purchase.`,
      });
    }
    const mapping = bySku.get(purchase.sku);
    const candidate = {
      store,
      transactionId: purchase.transactionId,
      ...(purchase.originalTransactionId === undefined
        ? {}
        : { originalTransactionId: purchase.originalTransactionId }),
      storeSku: purchase.sku,
      ...(mapping === undefined ? {} : { logicalId: mapping.logicalId }),
      quantity: purchase.quantity,
      state: purchase.state,
      ...(purchase.purchasedAt === undefined ? {} : { purchasedAt: purchase.purchasedAt }),
      token: purchase.token,
      evidence: { schema: input.evidenceSchema, payload: evidencePayload(purchase) },
      ...(purchase.accountBinding === undefined
        ? {}
        : { accountBinding: { ...purchase.accountBinding } }),
    };
    try {
      return assertStorePurchase(candidate);
    } catch (error) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: `Store ${store} reported an invalid purchase.`,
        cause: error,
      });
    }
  };

  // Events: the SDK listeners attach at creation so a purchase reported before
  // the first `subscribe` is buffered for it; while no listener is attached the
  // buffer collects again.
  const buffer = createCommerceEventBuffer();
  const listeners = new Set<(event: CommerceEvent) => void>();
  const emit = (event: CommerceEvent): void => {
    if (listeners.size === 0) {
      buffer.push(event);
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const detachers = [
    sdk.addListener('purchaseUpdated', (event) => {
      let purchase: StorePurchase;
      try {
        purchase = toStorePurchase(event.purchase);
      } catch (error) {
        const mapping = isRecord(event.purchase) && typeof event.purchase.sku === 'string'
          ? bySku.get(event.purchase.sku)
          : undefined;
        emit({
          type: 'purchaseError',
          ...(mapping === undefined ? {} : { logicalId: mapping.logicalId }),
          error: normalize(error).toCommerceErrorInfo(),
        });
        return;
      }
      emit({ type: 'purchaseUpdated', purchase });
    }),
    sdk.addListener('purchaseError', (event) => {
      const mapping = typeof event.sku === 'string' ? bySku.get(event.sku) : undefined;
      const error = normalize(event.error).toCommerceErrorInfo();
      if (recoverableErrorCodes.has(error.code)) {
        // An uncertain or already-owned attempt is not terminal: the reconciler
        // resolves it from `getAvailablePurchases`, so the open record stays open.
        return;
      }
      emit({
        type: 'purchaseError',
        ...(mapping === undefined ? {} : { logicalId: mapping.logicalId }),
        error,
      });
    }),
  ];

  const getAvailability = sdk.getAvailability;
  const readAvailability = async (): Promise<PlatformProviderAvailability> => {
    if (getAvailability === undefined) {
      return 'available';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reported: unknown = await Promise.race([
        Promise.resolve().then(() => getAvailability.call(sdk)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Store availability timed out.')),
            availabilityTimeoutMs,
          );
        }),
      ]);
      return availabilitySet.has(reported as PlatformProviderAvailability)
        ? reported as PlatformProviderAvailability
        : 'temporarily-unavailable';
    } catch {
      return 'temporarily-unavailable';
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  const getCapabilities = async (): Promise<CommerceCapabilities> => ({
    purchase: { ...sdk.capabilities.purchase, ...input.capabilities?.purchase },
    catalog: {
      products: true,
      offers: sdk.capabilities.offers ?? false,
      localizedPrice: true,
      ...input.capabilities?.catalog,
    },
    lifecycle: overrideLifecycle(sdk, input.capabilities),
    authority: { ...input.authority },
    availability: await readAvailability(),
  });

  const finishTransaction = sdk.finishTransaction;
  const restorePurchases = sdk.restorePurchases;
  const provider: StoreCommerceProvider = {
    store,
    // `retry` is forwarded to the SDK below.
    ...(finishTransaction === undefined ? {} : { acceptsFinishRetry: true }),
    getCapabilities,
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      const type = request.type ?? 'all';
      const mappings = [...byLogicalId.values()].filter((mapping) =>
        (request.logicalIds === undefined || request.logicalIds.includes(mapping.logicalId))
        && (type === 'all'
          || (type === 'subscription') === (mapping.kind === 'subscription')),
      );
      if (mappings.length === 0) {
        return [];
      }
      let reported: readonly StoreSdkProduct[];
      try {
        reported = await sdk.fetchProducts({
          skus: mappings.map((mapping) => mapping.storeSku),
          type,
        });
      } catch (error) {
        throw normalize(error);
      }
      if (!Array.isArray(reported)) {
        throw new CommerceError('INVALID_RESPONSE', {
          message: `Store ${store} returned an invalid product list.`,
        });
      }
      const products: StoreProduct[] = [];
      for (const product of reported) {
        const mapping = isRecord(product) && typeof product.sku === 'string'
          ? bySku.get(product.sku)
          : undefined;
        if (mapping === undefined || !mappings.includes(mapping)) {
          // A SKU the catalog does not sell is not a product the game can buy.
          continue;
        }
        if (product.kind !== mapping.kind) {
          throw new CommerceError('INVALID_RESPONSE', {
            message: `Store ${store} reports ${mapping.storeSku} as ${String(product.kind)}; the catalog declares ${mapping.kind}.`,
          });
        }
        try {
          products.push(assertStoreProduct({
            logicalId: mapping.logicalId,
            store,
            storeSku: mapping.storeSku,
            kind: mapping.kind,
            title: product.title,
            description: product.description,
            price: product.price,
            ...(product.offers === undefined ? {} : { offers: product.offers }),
          }));
        } catch (error) {
          throw new CommerceError('INVALID_RESPONSE', {
            message: `Store ${store} reported an invalid product for ${mapping.storeSku}.`,
            cause: error,
          });
        }
      }
      return products;
    },
    async requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      const mapping = byLogicalId.get(request.logicalId);
      if (mapping === undefined) {
        throw new CommerceError('ITEM_UNAVAILABLE', {
          message: `Store ${store} does not sell ${request.logicalId}.`,
        });
      }
      const capabilities = await getCapabilities();
      assertAvailable(capabilities.availability, store);
      assertRequestPurchaseSupported(capabilities, request, mapping.kind);
      const accountBinding = await input.accountBinding?.();
      if (input.authority.accountBinding === 'required' && accountBinding === undefined) {
        throw new CommerceError('ACCOUNT_BINDING_REQUIRED', {
          message: `Store ${store} requires an account binding before a purchase.`,
        });
      }
      const offerId = request.offerId ?? mapping.offerId;
      let result: StoreSdkRequestPurchaseResult;
      try {
        result = await sdk.requestPurchase({
          sku: mapping.storeSku,
          ...(offerId === undefined ? {} : { offerId }),
          ...(request.quantity === undefined ? {} : { quantity: request.quantity }),
          ...(accountBinding === undefined ? {} : { accountBinding }),
        });
      } catch (error) {
        return failureOutcome(undefined, normalize(error).toCommerceErrorInfo());
      }
      if (!isRecord(result)) {
        throw invalidRequestResult(store);
      }
      switch (result.outcome) {
        case 'launched':
          return { outcome: 'launched' };
        case 'purchased':
          return { outcome: 'purchased', purchase: toStorePurchase(result.purchase) };
        case 'cancelled':
        case 'failed':
          return failureOutcome(result.outcome, normalize(result.error).toCommerceErrorInfo());
        default:
          throw invalidRequestResult(store);
      }
    },
    async getAvailablePurchases(
      request: GetAvailablePurchasesInput = {},
    ): Promise<readonly StorePurchase[]> {
      if (!overrideLifecycle(sdk, input.capabilities).availablePurchases) {
        return [];
      }
      const includePending = request.includePending ?? false;
      let reported: readonly StoreSdkPurchase[];
      try {
        reported = await sdk.getAvailablePurchases({
          includePending,
          ...(request.restore === true ? { restore: true } : {}),
        });
      } catch (error) {
        throw normalize(error);
      }
      if (!Array.isArray(reported)) {
        throw new CommerceError('INVALID_RESPONSE', {
          message: `Store ${store} returned an invalid purchase list.`,
        });
      }
      const purchases: StorePurchase[] = [];
      for (const candidate of reported) {
        const purchase = toStorePurchase(candidate);
        // A revoked purchase is not recoverable, and a pending one is listed
        // only on request; both still reach the reconciler through events.
        if (purchase.state === 'revoked' || (purchase.state === 'pending' && !includePending)) {
          continue;
        }
        purchases.push(purchase);
      }
      return purchases;
    },
    ...(finishTransaction === undefined ? {} : {
      async finishTransaction(request: FinishTransactionInput): Promise<FinishTransactionResult> {
        // Finishing is authorized by a ledger entry only; the id is validated
        // before the store hears about it.
        const finish = assertFinishTransactionInput(request);
        let reported: unknown;
        try {
          reported = await finishTransaction.call(sdk, {
            transactionId: finish.transactionId,
            isConsumable: finish.isConsumable,
            ledgerEntryId: finish.ledgerEntryId,
            ...(finish.retry === true ? { retry: true } : {}),
          });
        } catch (error) {
          throw normalize(error);
        }
        try {
          return { finished: assertFinishTransactionResult(reported).finished };
        } catch (error) {
          throw new CommerceError('INVALID_RESPONSE', {
            message: `Store ${store} returned an invalid finish result.`,
            cause: error,
          });
        }
      },
    }),
    ...(restorePurchases === undefined ? {} : {
      async restorePurchases(): Promise<void> {
        try {
          await restorePurchases.call(sdk);
        } catch (error) {
          throw normalize(error);
        }
      },
    }),
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        buffer.drain(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const detach of detachers.splice(0, detachers.length)) {
        detach();
      }
      listeners.clear();
      buffer.drain(() => undefined);
    },
  };
  return provider;
}

function overrideLifecycle(
  sdk: StoreSdk,
  overrides: StoreCommerceCapabilityOverrides | undefined,
): CommerceLifecycleCapabilities {
  return {
    availablePurchases: true,
    pending: sdk.capabilities.pending,
    restore: sdk.capabilities.restore && sdk.restorePurchases !== undefined,
    events: true,
    finish: sdk.capabilities.finish,
    ...overrides?.lifecycle,
  };
}

function defaultEvidencePayload(purchase: StoreSdkPurchase): PlatformEvidenceEnvelope['payload'] {
  return {
    token: purchase.token,
    transactionId: purchase.transactionId,
    storeSku: purchase.sku,
    ...(purchase.originalTransactionId === undefined
      ? {}
      : { originalTransactionId: purchase.originalTransactionId }),
  };
}

function assertAvailable(availability: PlatformProviderAvailability, store: string): void {
  switch (availability) {
    case 'available':
      return;
    case 'configuration-required':
      throw new CommerceError('CONFIGURATION_REQUIRED', {
        message: `Store ${store} is not configured.`,
      });
    case 'action-required':
      throw new CommerceError('ACTION_REQUIRED', {
        message: `Store ${store} needs the player to act before a purchase.`,
      });
    case 'temporarily-unavailable':
      throw new CommerceError('STORE_UNAVAILABLE', {
        message: `Store ${store} is temporarily unavailable.`,
        retryable: true,
      });
    case 'unsupported':
      throw new CommerceError('STORE_UNAVAILABLE', {
        message: `Store ${store} is unsupported on this device.`,
        retryable: false,
      });
  }
}

/**
 * Codes that mean an unfinished purchase may exist (RFC "Errors": reconcile,
 * never reopen the store UI blindly). The attempt stays `launched` so the
 * reconciler resolves it from `getAvailablePurchases`; a terminal `failed`
 * would exclude it from recovery.
 */
export const recoverableErrorCodes: ReadonlySet<CommerceErrorCode> = new Set<CommerceErrorCode>([
  'OUTCOME_UNKNOWN',
  'ALREADY_OWNED',
]);

function failureOutcome(
  outcome: 'cancelled' | 'failed' | undefined,
  error: CommerceErrorInfo,
): RequestPurchaseResult {
  if (error.code === 'USER_CANCELLED') {
    return { outcome: 'cancelled', error };
  }
  if (recoverableErrorCodes.has(error.code)) {
    return { outcome: 'launched' };
  }
  return { outcome: outcome ?? 'failed', error };
}

function invalidRequestResult(store: string): CommerceError {
  return new CommerceError('INVALID_RESPONSE', {
    message: `Store ${store} returned an invalid purchase result.`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

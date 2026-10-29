import {
  createPurchasePresentationChannel,
  isPurchasePresentationReason,
  type PlatformEvidenceEnvelope,
  type PlatformProviderAvailability,
} from '@mpgd/platform';
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
  type PurchaseSource,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseAccountBinding,
} from '@mpgd/platform/commerce';

import {
  purchasePresentationTimeoutMs,
} from './purchase-presentation.js';
import {
  defaultStoreSdkErrorCodeMap,
  normalizeStoreSdkError,
  type StoreSdk,
  type StoreSdkErrorCodeMap,
  type StoreSdkProduct,
  type StoreSdkPurchase,
  type StoreSdkPurchasePresentationEvent,
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

/** What a purchase gate is asked about: one new purchase, before any store UI opens. */
export interface StorePurchaseGateRequest {
  readonly store: StoreId;
  readonly logicalId: CommerceLogicalProductId;
  readonly storeSku: string;
  readonly kind: PurchaseKind;
  readonly source: PurchaseSource;
}

/**
 * A purchase gate's answer. A refusal becomes a `failed` purchase result with
 * `ITEM_UNAVAILABLE` and `storeCode` (default `PURCHASES_PAUSED`), returned as
 * data so the reason survives the bridge; `retryable` defaults to false.
 */
export type StorePurchaseGateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly storeCode?: string;
      readonly message?: string;
      readonly retryable?: boolean;
    };

/**
 * The game's sales switch: asked before a NEW purchase opens the store UI,
 * after the product, availability, and kind checks and before the account
 * binding. Recovery, restore, finishing, events, and `getAvailablePurchases`
 * never consult it, so purchases already paid for keep reconciling while new
 * sales are refused. A gate that throws refuses the purchase (fail closed).
 */
export type StorePurchaseGate = (
  request: StorePurchaseGateRequest,
) => StorePurchaseGateDecision | Promise<StorePurchaseGateDecision>;

/** `storeCode` of a purchase the gate refused without naming its own. */
export const purchasesPausedStoreCode = 'PURCHASES_PAUSED' as const;
/** `storeCode` of a purchase refused because the gate threw or answered nonsense. */
export const purchaseGateFailedStoreCode = 'PURCHASE_GATE_FAILED' as const;
/** `storeCode` of a purchase refused because the account binding lookup threw. */
export const accountBindingLookupFailedStoreCode = 'ACCOUNT_BINDING_LOOKUP_FAILED' as const;

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
  /**
   * Resolves the player's store account binding before a purchase opens. A
   * failure (thrown, or no binding while `authority.accountBinding` is
   * `required`) is answered as a `failed` purchase result, not thrown, so its
   * `storeCode` survives the bridge.
   */
  readonly accountBinding?: () => Promise<StorePurchaseAccountBinding | undefined>;
  /** Optional sales switch for new purchases; see `StorePurchaseGate`. */
  readonly purchaseGate?: StorePurchaseGate;
  readonly capabilities?: StoreCommerceCapabilityOverrides;
  readonly authority: CommerceAuthorityCapabilities;
  /** Per-store error codes merged over `defaultStoreSdkErrorCodeMap`. */
  readonly mapError?: StoreSdkErrorCodeMap;
}

export interface StoreCommerceProvider extends CommerceProvider {
  /**
   * Detaches the SDK listeners; buffered events are dropped. A store sheet
   * still open gets its `closed` fact (reason `disposed`) first.
   */
  dispose(): void;
}

/** One `requestPurchase` call's presentation, while it has no terminal fact. */
interface PresentationFlight {
  readonly idempotencyKey: string;
  readonly presentationId: string;
  open: boolean;
  /** The SDK reported `unknown`: its terminal fact follows the answer. */
  pending: boolean;
  /** The SDK was asked to open the sheet. */
  launched: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const availabilityTimeoutMs = 3_000;
/**
 * Upper bound on one purchase gate answer. The gate runs while the gateway
 * holds the purchase's external activity, so a gate that never settles would
 * keep the game paused; past this bound the purchase is refused
 * (`PURCHASE_GATE_FAILED`, retryable) and a late answer is ignored.
 */
export const purchaseGateTimeoutMs = 3_000;
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
 *
 * Over an SDK that declares `purchasePresentation`, the provider offers
 * `presentation` and answers every `requestPurchase` call with facts keyed
 * by its idempotency key: `not-started`, delivered before the call settles,
 * for any call that opened no sheet (a purchase gate or account binding
 * refusal, an unavailable store, a throw, or the SDK's own `not-started`);
 * otherwise `open` and exactly one `closed` when the SDK reports the sheet
 * gone, or after `purchasePresentationTimeoutMs` (reason `timeout`), or on
 * `dispose` (reason `disposed`). A result, a pending purchase, or a purchase
 * event never closes a sheet. An SDK without the declaration leaves the
 * provider without `presentation`, as before.
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

  // Presentation: SDK facts by presentation id, published by idempotency key.
  const sdkPresentation = sdk.purchasePresentation;
  const presentation = sdkPresentation === undefined
    ? undefined
    : createPurchasePresentationChannel({
        onListenerError: (error) => {
          // A failing listener must not keep a `closed` fact from the others.
          console.warn('A purchase presentation listener failed.', error);
        },
      });
  const flights = new Map<string, PresentationFlight>();
  let disposed = false;
  const endFlight = (
    flight: PresentationFlight,
    state: 'closed' | 'not-started',
    reason?: StoreSdkPurchasePresentationEvent['reason'],
  ): void => {
    if (flights.get(flight.presentationId) !== flight) {
      return;
    }
    flights.delete(flight.presentationId);
    if (flight.timer !== undefined) {
      clearTimeout(flight.timer);
    }
    // A sheet that opened can only close; `not-started` after `open` would
    // tell a consumer the sheet never showed.
    const fact = flight.open ? 'closed' : state;
    presentation?.publish({
      idempotencyKey: flight.idempotencyKey,
      state: fact,
      ...(reason === undefined || fact !== 'closed' ? {} : { reason }),
    });
  };
  const onPresentationFact = (event: StoreSdkPurchasePresentationEvent): void => {
    if (!isRecord(event) || typeof event.presentationId !== 'string') {
      return;
    }
    const flight = flights.get(event.presentationId);
    if (flight === undefined) {
      // Another call's, an already ended call's, or an earlier session's fact.
      return;
    }
    const armSafetyTimeout = (): void => {
      flight.timer ??= setTimeout(
        () => endFlight(flight, 'closed', 'timeout'),
        purchasePresentationTimeoutMs,
      );
    };
    switch (event.state) {
      case 'open':
        if (!flight.open) {
          flight.open = true;
          presentation?.publish({ idempotencyKey: flight.idempotencyKey, state: 'open' });
          armSafetyTimeout();
        }
        return;
      case 'unknown':
        // The sheet may still open: the call's answer does not end it.
        if (!flight.open && !flight.pending) {
          flight.pending = true;
          presentation?.publish({ idempotencyKey: flight.idempotencyKey, state: 'unknown' });
          armSafetyTimeout();
        }
        return;
      case 'closed':
        endFlight(
          flight,
          'closed',
          isPurchasePresentationReason(event.reason) ? event.reason : undefined,
        );
        return;
      case 'not-started':
        endFlight(flight, 'not-started');
        return;
      default:
        // An unknown fact proves nothing; the safety timeout still bounds the sheet.
        return;
    }
  };
  if (sdkPresentation !== undefined) {
    detachers.push(sdkPresentation.subscribe(onPresentationFact));
  }

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

  const requestStorePurchase = async (
    request: RequestPurchaseInput,
    presentationId: string | undefined,
  ): Promise<RequestPurchaseResult> => {
    const mapping = byLogicalId.get(request.logicalId);
    if (mapping === undefined) {
      throw new CommerceError('ITEM_UNAVAILABLE', {
        message: `Store ${store} does not sell ${request.logicalId}.`,
      });
    }
    const capabilities = await getCapabilities();
    assertAvailable(capabilities.availability, store);
    assertRequestPurchaseSupported(capabilities, request, mapping.kind);
    // Pre-launch refusals below are data, not throws: a `failed` result
    // keeps its `storeCode` across the bridge, a thrown error does not.
    if (input.purchaseGate !== undefined) {
      const refusal = await askPurchaseGate(input.purchaseGate, {
        store,
        logicalId: mapping.logicalId,
        storeSku: mapping.storeSku,
        kind: mapping.kind,
        source: request.source,
      });
      if (refusal !== undefined) {
        return { outcome: 'failed', error: refusal };
      }
    }
    let accountBinding: StorePurchaseAccountBinding | undefined;
    try {
      accountBinding = await input.accountBinding?.();
    } catch (error) {
      return { outcome: 'failed', error: accountBindingFailure(error, store) };
    }
    if (input.authority.accountBinding === 'required' && accountBinding === undefined) {
      return {
        outcome: 'failed',
        error: new CommerceError('ACCOUNT_BINDING_REQUIRED', {
          message: `Store ${store} requires an account binding before a purchase.`,
        }).toCommerceErrorInfo(),
      };
    }
    const offerId = request.offerId ?? mapping.offerId;
    if (disposed) {
      // Its listeners are gone: a sheet opened now could never be reported.
      throw new CommerceError('NOT_PREPARED', {
        message: `Store ${store} was disposed before the purchase opened.`,
      });
    }
    const flight = presentationId === undefined ? undefined : flights.get(presentationId);
    if (flight !== undefined) {
      flight.launched = true;
    }
    let result: StoreSdkRequestPurchaseResult;
    try {
      result = await sdk.requestPurchase({
        sku: mapping.storeSku,
        ...(offerId === undefined ? {} : { offerId }),
        ...(request.quantity === undefined ? {} : { quantity: request.quantity }),
        ...(accountBinding === undefined ? {} : { accountBinding }),
        ...(presentationId === undefined ? {} : { presentationId }),
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
  };

  const finishTransaction = sdk.finishTransaction;
  const restorePurchases = sdk.restorePurchases;
  /** The SDK reads `revoked` and has a finish to take it. */
  const revokedFinish = finishTransaction !== undefined && sdk.acceptsRevokedFinish === true;
  const provider: StoreCommerceProvider = {
    store,
    ...(presentation === undefined ? {} : { presentation: presentation.presentation }),
    // `retry` is forwarded to the SDK below.
    ...(finishTransaction === undefined ? {} : { acceptsFinishRetry: true }),
    // `revoked` is forwarded only to an SDK that reads it.
    ...(revokedFinish ? { acceptsRevokedFinish: true } : {}),
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
      if (presentation === undefined) {
        return requestStorePurchase(request, undefined);
      }
      if ([...flights.values()].some((live) => live.idempotencyKey === request.idempotencyKey)) {
        // Facts are keyed by idempotency key: a second sheet for a key whose
        // sheet is still in flight could not be told apart from the first,
        // and its end would end the first one's pause. Answered as data and
        // without a fact; the first call's facts stay the key's truth.
        return {
          outcome: 'failed',
          error: new CommerceError('IN_PROGRESS', {
            message: `A purchase for ${request.idempotencyKey} is still in flight.`,
          }).toCommerceErrorInfo(),
        };
      }
      const flight: PresentationFlight = {
        idempotencyKey: request.idempotencyKey,
        presentationId: crypto.randomUUID(),
        open: false,
        pending: false,
        launched: false,
      };
      flights.set(flight.presentationId, flight);
      try {
        return await requestStorePurchase(request, flight.presentationId);
      } finally {
        // Settled without an `open` fact: no sheet opened. Published before
        // the caller sees the answer, so a consumer that frees a retryable
        // refusal's key (the reconciler) reads it with the result. A call
        // whose SDK reported `unknown` keeps waiting for the native verdict
        // (bounded by the safety timeout, which reports `closed`).
        if (!flight.open && !flight.pending) {
          endFlight(flight, 'not-started');
        }
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
        // An SDK that finishes revoked transactions keeps its unfinished
        // revoked ones listed: the reconciler finishes them once the backend
        // answered for them, and verifies or grants none of them.
        if (
          (purchase.state === 'revoked' && !revokedFinish)
          || (purchase.state === 'pending' && !includePending)
        ) {
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
        if (finish.revoked === true && !revokedFinish) {
          // Never an ordinary finish in its place: the SDK cannot tell the
          // two apart, and this one would run without a grant.
          return { finished: false };
        }
        let reported: unknown;
        try {
          reported = await finishTransaction.call(sdk, {
            transactionId: finish.transactionId,
            isConsumable: finish.isConsumable,
            ledgerEntryId: finish.ledgerEntryId,
            ...(finish.retry === true ? { retry: true } : {}),
            ...(finish.revoked === true ? { revoked: true } : {}),
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
      // No SDK fact arrives any more, and the listeners go below: every call
      // in flight gets its terminal fact now. A sheet that is (or may be)
      // up is reported closed; a call still before its sheet is not-started,
      // and it will not open one.
      disposed = true;
      for (const flight of [...flights.values()]) {
        endFlight(
          flight,
          flight.open || flight.pending || flight.launched ? 'closed' : 'not-started',
          'disposed',
        );
      }
      presentation?.clear();
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

/**
 * Codes a pre-launch hook (the purchase gate or the account binding) must not
 * report: they claim a store sheet was shown or may hold a purchase, and
 * nothing was launched. A hook that throws one is reported under the hook's
 * own refusal code instead.
 */
function misleadsBeforeLaunch(code: CommerceErrorCode): boolean {
  return recoverableErrorCodes.has(code) || code === 'USER_CANCELLED';
}

/**
 * Asks the gate about one new purchase, bounded by `purchaseGateTimeoutMs`;
 * undefined means allowed. A refusal
 * (`allowed: false`) is the gate's definitive answer: `PURCHASES_PAUSED` or
 * its own code, retryable only when it says so. A gate that could not answer
 * (it threw, timed out, or returned anything malformed) is `PURCHASE_GATE_FAILED`, and
 * always retryable: the sales flag is unknown, not closed, so asking again
 * may succeed. A thrown `CommerceError` keeps its code unless the code
 * claims a launched or cancelled sheet.
 */
async function askPurchaseGate(
  gate: StorePurchaseGate,
  request: StorePurchaseGateRequest,
): Promise<CommerceErrorInfo | undefined> {
  const gateFailed = (message: string, cause?: unknown): CommerceErrorInfo =>
    new CommerceError('ITEM_UNAVAILABLE', {
      message,
      storeCode: purchaseGateFailedStoreCode,
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    }).toCommerceErrorInfo();
  let decision: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    decision = await Promise.race([
      Promise.resolve().then(() => gate(request)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The purchase gate did not answer within ${purchaseGateTimeoutMs} ms.`)),
          purchaseGateTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof CommerceError && !misleadsBeforeLaunch(error.code)) {
      return error.toCommerceErrorInfo();
    }
    return gateFailed(
      `The purchase gate of ${request.store} failed; ${request.logicalId} is not sold now.`,
      error,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  if (isRecord(decision) && decision.allowed === true) {
    return undefined;
  }
  if (!isRecord(decision) || decision.allowed !== false) {
    return gateFailed(`The purchase gate of ${request.store} returned an invalid decision.`);
  }
  const storeCode = typeof decision.storeCode === 'string' && decision.storeCode.length > 0
    ? decision.storeCode
    : purchasesPausedStoreCode;
  return new CommerceError('ITEM_UNAVAILABLE', {
    message: typeof decision.message === 'string' && decision.message.length > 0
      ? decision.message
      : `New purchases of ${request.logicalId} are paused.`,
    storeCode,
    retryable: decision.retryable === true,
  }).toCommerceErrorInfo();
}

/**
 * A failed account binding lookup. A `CommerceError` keeps its code (a store
 * provider names its own lookup failure) unless the code claims a launched or
 * cancelled sheet; anything else is `ACCOUNT_BINDING_REQUIRED` with
 * `ACCOUNT_BINDING_LOOKUP_FAILED`, retryable, so every store reports the
 * same reason.
 */
function accountBindingFailure(error: unknown, store: string): CommerceErrorInfo {
  if (error instanceof CommerceError && !misleadsBeforeLaunch(error.code)) {
    return error.toCommerceErrorInfo();
  }
  return new CommerceError('ACCOUNT_BINDING_REQUIRED', {
    message: `Store ${store} could not resolve the account binding.`,
    storeCode: accountBindingLookupFailedStoreCode,
    retryable: true,
    cause: error,
  }).toCommerceErrorInfo();
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

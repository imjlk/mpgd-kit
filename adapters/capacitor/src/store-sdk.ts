import type {
  PlatformProviderAvailability,
  PlatformPurchasePresentationReason,
} from '@mpgd/platform';
import {
  CommerceError,
  commerceErrorInfoOf,
  isCommerceErrorCode,
  type CommerceErrorCode,
  type CommerceFinishOwner,
  type CommercePurchaseCapabilities,
  type FetchProductsType,
  type PurchaseKind,
  type StoreId,
  type StoreOffer,
  type StorePrice,
  type StorePurchaseAccountBinding,
  type StorePurchaseState,
} from '@mpgd/platform/commerce';

/**
 * In-process surface a store plugin exposes to `createStoreCommerceProvider`.
 * The shape follows the OpenIAP Client Protocol (`fetchProducts`,
 * `requestPurchase` with results delivered by events, `getAvailablePurchases`,
 * `finishTransaction`) so a future Capacitor IAP plugin over the OpenIAP cores
 * is a drop-in, while the kit's Play Billing and StoreKit plugins adapt to it
 * in B2 and B3. The SDK speaks store SKUs only; the provider owns the mapping
 * to logical product ids, evidence, and capability composition. Nothing here
 * grants: a purchase reported by the SDK is evidence for the backend ledger.
 */
export interface StoreSdk {
  readonly store: StoreId;
  /** Static declaration of what the SDK supports; the provider composes `CommerceCapabilities` from it. */
  readonly capabilities: StoreSdkCapabilities;
  fetchProducts(input: StoreSdkFetchProductsInput): Promise<readonly StoreSdkProduct[]>;
  /** Returns `launched` when the store UI opened and the result arrives as a `purchaseUpdated` event. */
  requestPurchase(input: StoreSdkRequestPurchaseInput): Promise<StoreSdkRequestPurchaseResult>;
  /** Purchases the store still reports as unfinished. */
  getAvailablePurchases(
    input: StoreSdkGetAvailablePurchasesInput,
  ): Promise<readonly StoreSdkPurchase[]>;
  /** Present when `capabilities.finish` is 'client' or 'host'. Called only after a ledger grant. */
  finishTransaction?(
    input: StoreSdkFinishTransactionInput,
  ): Promise<StoreSdkFinishTransactionResult>;
  /**
   * `finishTransaction` reads `revoked`: it finishes a transaction it still
   * lists as revoked, and only that. `createStoreCommerceProvider` then
   * declares `CommerceProvider.acceptsRevokedFinish`; an SDK without it never
   * receives the field, so a store that would read the call as an ordinary
   * finish (a consume) is never asked.
   */
  readonly acceptsRevokedFinish?: boolean;
  /** Asks the store to resynchronize, for example `AppStore.sync`. */
  restorePurchases?(): Promise<void>;
  addListener<TEvent extends StoreSdkEventName>(
    eventName: TEvent,
    listener: (event: StoreSdkEventOf<TEvent>) => void,
  ): () => void;
  /** Current readiness; omitted means the SDK is in-process and ready. */
  getAvailability?(): Promise<PlatformProviderAvailability>;
  /**
   * Native facts about the store's purchase sheet. Present only when the SDK
   * (and the native code under it) reports them for every `requestPurchase`
   * that carries a `presentationId`; `createStoreCommerceProvider` then
   * offers `CommerceProvider.presentation`. An SDK without it keeps the
   * provider without presentation, as before.
   */
  readonly purchasePresentation?: StoreSdkPurchasePresentation;
}

/**
 * The purchase sheet facts of one SDK. For a `requestPurchase` call with a
 * `presentationId` the SDK reports, by that id: `open` once the store sheet
 * is up, then exactly one `closed` when it is gone (which may come after the
 * call settled), or `not-started` when no sheet opened. A fact the call
 * settles without (the sheet never opened) means `not-started`, so an SDK
 * reports `open` before it settles whenever a sheet opened, and `unknown`
 * before it settles when it cannot tell yet (a terminal fact then follows). A transaction
 * update, a pending purchase, or a result is not a `closed` fact.
 */
export interface StoreSdkPurchasePresentation {
  subscribe(listener: (event: StoreSdkPurchasePresentationEvent) => void): () => void;
}

export interface StoreSdkPurchasePresentationEvent {
  readonly presentationId: string;
  /**
   * `unknown`: the call is answering while the native flow still runs and
   * nothing was observed yet; the sheet may still open, and a terminal fact
   * (`closed` or `not-started`) follows. The provider keeps the call waiting
   * for it instead of reading the answer as a sheet that never opened.
   */
  readonly state: 'open' | 'closed' | 'not-started' | 'unknown';
  /** On a `closed` fact no native observation proved, why; see `PlatformPurchasePresentationReason`. */
  readonly reason?: PlatformPurchasePresentationReason;
}

export interface StoreSdkCapabilities {
  readonly purchase: CommercePurchaseCapabilities;
  /** The SDK reports store offers on products. Defaults to false. */
  readonly offers?: boolean;
  /** The store can report a purchase in state `pending` (for example deferred payment). */
  readonly pending: boolean;
  /** `restorePurchases` is implemented. */
  readonly restore: boolean;
  /** Who finishes a granted purchase; 'client' and 'host' require `finishTransaction`. */
  readonly finish: CommerceFinishOwner;
}

export interface StoreSdkFetchProductsInput {
  readonly skus: readonly string[];
  readonly type: FetchProductsType;
}

export interface StoreSdkProduct {
  readonly sku: string;
  readonly kind: PurchaseKind;
  readonly title: string;
  readonly description: string;
  readonly price: StorePrice;
  readonly offers?: readonly StoreOffer[];
}

export interface StoreSdkRequestPurchaseInput {
  readonly sku: string;
  readonly offerId?: string;
  readonly quantity?: number;
  readonly accountBinding?: StorePurchaseAccountBinding;
  /**
   * Correlates this call's `purchasePresentation` facts. Sent only to an SDK
   * that declares `purchasePresentation`; unique per call.
   */
  readonly presentationId?: string;
}

export type StoreSdkRequestPurchaseResult =
  | { readonly outcome: 'launched' }
  | { readonly outcome: 'purchased'; readonly purchase: StoreSdkPurchase }
  | { readonly outcome: 'cancelled' | 'failed'; readonly error: StoreSdkError };

export interface StoreSdkGetAvailablePurchasesInput {
  readonly includePending?: boolean;
  /**
   * The player's explicit Restore Purchases read
   * (`GetAvailablePurchasesInput.restore`): also list owned non-consumables
   * the recovery list hides (Play: already acknowledged; StoreKit: bound to
   * another or no app account token). Consumables stay unfinished-only.
   */
  readonly restore?: boolean;
}

export interface StoreSdkPurchase {
  readonly sku: string;
  readonly transactionId: string;
  readonly originalTransactionId?: string;
  readonly state: StorePurchaseState;
  readonly purchasedAt?: string;
  /** Play purchase token, App Store signed transaction (JWS), or host order id. */
  readonly token: string;
  readonly quantity: number;
  readonly accountBinding?: StorePurchaseAccountBinding;
  /** Store-specific detail the provider never reads; kept for diagnostics only. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface StoreSdkFinishTransactionInput {
  readonly transactionId: string;
  readonly isConsumable: boolean;
  /** `FinishTransactionInput.retry`: an earlier finish of this purchase was asked for. */
  readonly retry?: boolean;
  /**
   * `FinishTransactionInput.revoked`: finish a transaction the store revoked
   * while it was unfinished, with no grant standing. Sent only to an SDK that
   * declares `acceptsRevokedFinish`.
   */
  readonly revoked?: boolean;
  /** The ledger entry that authorized the finish; a plugin may record it. */
  readonly ledgerEntryId: string;
}

export interface StoreSdkFinishTransactionResult {
  readonly finished: boolean;
}

/**
 * Failure thrown or returned by an SDK. `code` is the store's own code (for
 * example `PLAY_BILLING_SERVICE_UNAVAILABLE`) or an already normalized
 * `CommerceErrorCode`; `storeCode` keeps the store code when `code` is already
 * normalized. `retryable` overrides the default of the normalized code.
 */
export interface StoreSdkError {
  readonly code: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly storeCode?: string;
}

export type StoreSdkEvent =
  | { readonly type: 'purchaseUpdated'; readonly purchase: StoreSdkPurchase }
  | { readonly type: 'purchaseError'; readonly sku?: string; readonly error: StoreSdkError };

export type StoreSdkEventName = StoreSdkEvent['type'];

export type StoreSdkEventOf<TName extends StoreSdkEventName> = Extract<
  StoreSdkEvent,
  { readonly type: TName }
>;

/** Store code to normalized code; a provider passes a per-store table merged over these defaults. */
export type StoreSdkErrorCodeMap = Readonly<Record<string, CommerceErrorCode>>;

/**
 * Default mapping from the kit's current Play Billing, StoreKit, and native
 * provider codes (RFC "Errors"). B2 and B3 extend it per store.
 */
export const defaultStoreSdkErrorCodeMap: StoreSdkErrorCodeMap = Object.freeze({
  PLAY_BILLING_TIMEOUT: 'OUTCOME_UNKNOWN',
  PLAY_BILLING_INTERRUPTED: 'OUTCOME_UNKNOWN',
  PLAY_BILLING_EMPTY_PURCHASE: 'OUTCOME_UNKNOWN',
  STOREKIT_PURCHASE_UNCERTAIN: 'OUTCOME_UNKNOWN',
  PLAY_BILLING_ALREADY_OWNED: 'ALREADY_OWNED',
  PLAY_BILLING_DISCONNECTED: 'STORE_UNAVAILABLE',
  PLAY_BILLING_SERVICE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  PLAY_BILLING_UNAVAILABLE: 'STORE_UNAVAILABLE',
  PLAY_BILLING_TRANSIENT_ERROR: 'STORE_UNAVAILABLE',
  STOREKIT_UNAVAILABLE: 'STORE_UNAVAILABLE',
  NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE: 'STORE_UNAVAILABLE',
  NATIVE_PROVIDER_UNSUPPORTED: 'STORE_UNAVAILABLE',
  PLAY_BILLING_NETWORK_ERROR: 'NETWORK',
  NATIVE_PURCHASE_NETWORK_ERROR: 'NETWORK',
  PLAY_BILLING_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
  PLAY_BILLING_PRODUCT_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  STOREKIT_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
  STOREKIT_PRODUCT_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  NATIVE_PROVIDER_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
  PLAY_BILLING_ACCOUNT_REQUIRED: 'ACCOUNT_BINDING_REQUIRED',
  PLAY_BILLING_ACCOUNT_LOOKUP_FAILED: 'ACCOUNT_BINDING_REQUIRED',
  PLAY_BILLING_CONFIGURATION_ERROR: 'CONFIGURATION_REQUIRED',
  STOREKIT_CONFIGURATION_ERROR: 'CONFIGURATION_REQUIRED',
  NATIVE_PROVIDER_CONFIGURATION_REQUIRED: 'CONFIGURATION_REQUIRED',
  NATIVE_PROVIDER_ACTION_REQUIRED: 'ACTION_REQUIRED',
  NATIVE_PROVIDER_NOT_READY: 'NOT_PREPARED',
  PLAY_BILLING_EVIDENCE_INVALID: 'INVALID_RESPONSE',
  STOREKIT_EVIDENCE_INVALID: 'INVALID_RESPONSE',
  NATIVE_PROVIDER_INVALID_RESPONSE: 'INVALID_RESPONSE',
} satisfies Record<string, CommerceErrorCode>);

/**
 * Normalizes anything an SDK threw or returned into a `CommerceError`. A store
 * code found in `mapError` becomes the mapped code with the store code kept;
 * a code that is already a v2 code is kept as is; anything else is `UNKNOWN`
 * with the original code as `storeCode`. An explicit `retryable` wins over
 * the default of the normalized code.
 */
export function normalizeStoreSdkError(
  error: unknown,
  mapError: StoreSdkErrorCodeMap = defaultStoreSdkErrorCodeMap,
): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const record = error as Readonly<Record<string, unknown>>;
    if (typeof record.code === 'string' && record.code.length > 0) {
      const message = typeof record.message === 'string' ? record.message : undefined;
      const retryable = typeof record.retryable === 'boolean' ? record.retryable : undefined;
      const storeCode = typeof record.storeCode === 'string' ? record.storeCode : undefined;
      const options = {
        ...(message === undefined ? {} : { message }),
        ...(retryable === undefined ? {} : { retryable }),
        cause: error,
      };
      const mapped = Object.hasOwn(mapError, record.code) ? mapError[record.code] : undefined;
      if (mapped !== undefined) {
        return new CommerceError(mapped, { ...options, storeCode: storeCode ?? record.code });
      }
      if (isCommerceErrorCode(record.code)) {
        return new CommerceError(record.code, {
          ...options,
          ...(storeCode === undefined ? {} : { storeCode }),
        });
      }
      return new CommerceError('UNKNOWN', {
        ...options,
        retryable: retryable ?? false,
        storeCode: storeCode ?? record.code,
      });
    }
  }
  const info = commerceErrorInfoOf(error);
  return new CommerceError(info.code, {
    retryable: info.retryable,
    ...(info.storeCode === undefined ? {} : { storeCode: info.storeCode }),
    ...(info.message === undefined ? {} : { message: info.message }),
    cause: error,
  });
}

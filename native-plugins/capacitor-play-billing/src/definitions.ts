import type { PluginListenerHandle } from '@capacitor/core';

export type PlayPurchaseState = 'purchased' | 'pending';

export interface PlayOneTimeOffer {
  readonly offerToken: string;
  readonly formattedPrice: string;
  readonly currencyCode: string;
  /** `OneTimePurchaseOfferDetails.getPriceAmountMicros()`; absent on older plugin builds. */
  readonly priceAmountMicros?: number;
}

export interface PlayProduct {
  readonly productId: string;
  readonly title: string;
  readonly description: string;
  /** Explicit offer selection is required when Google returns multiple offers. */
  readonly offers: readonly PlayOneTimeOffer[];
}

/**
 * One Play purchase as the plugin encodes `com.android.billingclient.api.Purchase`.
 * `products`, `purchaseState`, `purchaseTime`, `quantity`, `isAcknowledged`, and
 * `obfuscatedAccountId` follow the Billing Library 9.1.0 getters; `productIds`,
 * `state`, and `purchaseTimeMillis` are the 0.1 names and carry the same values
 * until the next major version.
 */
export interface PlayPurchase {
  /** `Purchase.getProducts()`: the product ids this purchase covers (one for a single-line purchase). */
  readonly products: readonly string[];
  /** @deprecated Same value as `products`; removed in the next major version. */
  readonly productIds: readonly string[];
  readonly purchaseToken: string;
  /** `Purchase.getOrderId()`; absent while Play has not assigned one (for example a pending purchase). */
  readonly orderId?: string;
  /** `Purchase.getPurchaseTime()` in milliseconds since the epoch. */
  readonly purchaseTime: number;
  /** @deprecated Same value as `purchaseTime` when it is positive; removed in the next major version. */
  readonly purchaseTimeMillis?: number;
  /** `Purchase.getPurchaseState()`; the plugin never reports `UNSPECIFIED_STATE`. */
  readonly purchaseState: PlayPurchaseState;
  /** @deprecated Same value as `purchaseState`; removed in the next major version. */
  readonly state: PlayPurchaseState;
  /**
   * `Purchase.isAcknowledged()`. The plugin never acknowledges or consumes; the
   * backend finalizer does after the ledger grant, so `false` on a purchased
   * entry means the purchase is still unfinished.
   */
  readonly isAcknowledged: boolean;
  /** `Purchase.getQuantity()`; 1 unless multi-quantity purchases are enabled in Play Console. */
  readonly quantity: number;
  /** `Purchase.getAccountIdentifiers().getObfuscatedAccountId()` when the purchase flow set one. */
  readonly obfuscatedAccountId?: string;
}

/**
 * Result of a `purchase` call (`purchased`, `pending`, or `cancelled`) and
 * payload of every `purchaseUpdated` event. A `purchase` call never resolves
 * `failed`: it rejects with the plugin code instead. On `purchaseUpdated`, a
 * `cancelled` or `failed` outcome without a `purchase` is a terminal result
 * that arrived after the `purchase` call for `productId` already timed out
 * (`PLAY_BILLING_TIMEOUT`), so the attempt the timeout left open can close.
 */
export interface PlayPurchaseOutcome {
  readonly status: 'purchased' | 'pending' | 'cancelled' | 'failed';
  readonly purchase?: PlayPurchase;
  /** The timed-out product a late `cancelled` or `failed` result belongs to. */
  readonly productId?: string;
  /** The `PLAY_BILLING_*` code of a late `failed` result. */
  readonly code?: string;
}

export interface CapacitorPlayBillingPlugin {
  getProducts(input: { readonly productIds: readonly string[] }): Promise<{
    readonly products: readonly PlayProduct[];
  }>;
  purchase(input: {
    readonly productId: string;
    readonly offerToken?: string;
    readonly obfuscatedAccountId: string;
  }): Promise<PlayPurchaseOutcome>;
  /**
   * Requeries every purchased or pending in-app purchase Play still reports
   * for this user and device (`queryPurchasesAsync`): unconsumed consumables,
   * acknowledged and unacknowledged durables, and pending purchases. The
   * `isAcknowledged` flag separates finished durables from unfinished ones.
   */
  getPurchases(): Promise<{ readonly purchases: readonly PlayPurchase[] }>;
  /**
   * Every purchase update Play delivers (`PurchasesUpdatedListener`), including
   * one that completes after the `purchase` call timed out or the app
   * restarted. Updates delivered before a listener attaches are retained
   * until the first listener consumes them.
   */
  addListener(
    eventName: 'purchaseUpdated',
    listener: (event: PlayPurchaseOutcome) => void,
  ): Promise<PluginListenerHandle>;
}

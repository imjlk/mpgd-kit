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
 * `obfuscatedAccountId` follow the Billing Library 9.1.0 getters.
 */
export interface PlayPurchase {
  /** `Purchase.getProducts()`: the product ids this purchase covers (one for a single-line purchase). */
  readonly products: readonly string[];
  readonly purchaseToken: string;
  /** `Purchase.getOrderId()`; absent while Play has not assigned one (for example a pending purchase). */
  readonly orderId?: string;
  /** `Purchase.getPurchaseTime()` in milliseconds since the epoch. */
  readonly purchaseTime: number;
  /** `Purchase.getPurchaseState()`; the plugin never reports `UNSPECIFIED_STATE`. */
  readonly purchaseState: PlayPurchaseState;
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
  /**
   * The Play sheet when a `purchase` call with a `presentationId` answered
   * (also in a rejection's `data`): `open` (still up; `closed` follows as a
   * `purchasePresentation` event), `closed`, `not-started`, or `requested`
   * (no fact yet; facts follow as events).
   */
  readonly presentation?: PlayPurchaseAnswerPresentation;
}

export type PlayPurchasePresentationState = 'open' | 'closed' | 'not-started';
export type PlayPurchaseAnswerPresentation = PlayPurchasePresentationState | 'requested';

/**
 * A Play sheet fact for the `purchase` call that sent `presentationId`,
 * observed from the activity lifecycle and never from a purchase result:
 * `open` once the Billing Library's activity is created, `closed` when the
 * game's activity resumes after it (reason `interrupted` when the plugin was
 * torn down instead), `not-started` when the flow ended without it.
 */
export interface PlayPurchasePresentationEvent {
  readonly presentationId: string;
  readonly state: PlayPurchasePresentationState;
  readonly reason?: 'interrupted';
}

/** What `getPresentationSupport` declares; `purchasePresentation` is the facts protocol version. */
export interface PlayPresentationSupport {
  readonly purchasePresentation: number;
}

export interface CapacitorPlayBillingPlugin {
  getProducts(input: { readonly productIds: readonly string[] }): Promise<{
    readonly products: readonly PlayProduct[];
  }>;
  purchase(input: {
    readonly productId: string;
    readonly offerToken?: string;
    readonly obfuscatedAccountId: string;
    /** Asks for this call's sheet facts (`purchasePresentation`); 1-64 of `[A-Za-z0-9-]`. */
    readonly presentationId?: string;
  }): Promise<PlayPurchaseOutcome>;
  /**
   * Declares the sheet facts the native code reports. A native build from
   * before them answers `UNIMPLEMENTED`; optional so a plugin double without
   * it still type-checks, and then the SDK refuses purchases that need facts.
   */
  getPresentationSupport?(): Promise<PlayPresentationSupport>;
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
  /** Sheet facts of `purchase` calls that sent a `presentationId`; retained until a listener attaches. */
  addListener(
    eventName: 'purchasePresentation',
    listener: (event: PlayPurchasePresentationEvent) => void,
  ): Promise<PluginListenerHandle>;
}

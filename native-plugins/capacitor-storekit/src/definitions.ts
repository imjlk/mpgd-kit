import type { PluginListenerHandle } from '@capacitor/core';

export interface StoreKitProduct {
  readonly productId: string;
  readonly type: 'consumable' | 'non_consumable';
  readonly title: string;
  readonly description: string;
  readonly formattedPrice: string;
  readonly currencyCode: string;
}

export interface StoreKitTransaction {
  readonly transactionId: string;
  readonly originalTransactionId: string;
  readonly productId: string;
  readonly type: 'consumable' | 'non_consumable';
  readonly appAccountToken?: string;
  readonly purchasedAt: string;
  readonly revokedAt?: string;
  /** StoreKit-verified JWS; the game backend independently verifies Apple data. */
  readonly signedTransaction: string;
  /**
   * Present on `getTransactions` results: true for `Transaction.unfinished`
   * entries, false for current non-consumable entitlements that are already
   * finished. The SDK lists `unfinished: false` durables so a finish that
   * raced the ledger grant can still be verified. Omitted by native builds
   * predating the field and by `purchase` and `transactionUpdated` payloads.
   */
  readonly unfinished?: boolean;
}

export type StoreKitPurchaseOutcome = (
  | { readonly status: 'purchased'; readonly transaction: StoreKitTransaction }
  | { readonly status: 'pending' | 'cancelled' }
) & {
  /**
   * The purchase sheet when a `purchase` call with a `presentationId`
   * answered (also in a rejection's `data`): `closed` once
   * `Product.purchase()` returned or threw, `not-started` when the plugin
   * refused before calling it.
   */
  readonly presentation?: StoreKitPurchaseAnswerPresentation;
};

export type StoreKitPurchasePresentationState = 'open' | 'closed' | 'not-started';
export type StoreKitPurchaseAnswerPresentation = StoreKitPurchasePresentationState | 'requested';

/**
 * A sheet fact for the `purchase` call that sent `presentationId`: `open`
 * right before `Product.purchase()`, `closed` when it returns or throws,
 * `not-started` when the plugin refused before it. Apple documents that the
 * call presents the confirmation sheet, not that it returns only once the
 * sheet is gone; see the README.
 */
export interface StoreKitPurchasePresentationEvent {
  readonly presentationId: string;
  readonly state: StoreKitPurchasePresentationState;
  readonly reason?: 'interrupted';
}

/** What `getPresentationSupport` declares; `purchasePresentation` is the facts protocol version. */
export interface StoreKitPresentationSupport {
  readonly purchasePresentation: number;
}

/**
 * What `getFinishSupport` declares: `withoutAppAccountToken` is the protocol
 * version of the explicit no-token finish, absent from a build before it.
 */
export interface StoreKitFinishSupport {
  readonly withoutAppAccountToken?: number;
}

/**
 * One `finishTransaction` call: the session app account token, or explicitly
 * none (`withoutAppAccountToken: true`, no token field at all), which matches
 * only a non-consumable bound to no token. Never both, never neither.
 */
export type StoreKitFinishTransactionInput =
  | {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
    /** Session app account token; must match the verified transaction. */
    readonly appAccountToken: string;
    readonly withoutAppAccountToken?: never;
  }
  | {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
    readonly appAccountToken?: never;
    /**
     * Finish a verified, non-revoked non-consumable bound to no app account
     * token (bought or redeemed outside the app). Only a build whose
     * `getFinishSupport` declares it accepts this; an earlier one rejects
     * the call with `STOREKIT_FINISH_REQUIRES_GRANT`.
     */
    readonly withoutAppAccountToken: true;
  };

export interface CapacitorStoreKitPlugin {
  getProducts(input: { readonly productIds: readonly string[] }): Promise<{
    readonly products: readonly StoreKitProduct[];
  }>;
  purchase(input: {
    readonly productId: string;
    readonly appAccountToken: string;
    /** Asks for this call's sheet facts (`purchasePresentation`); 1-64 of `[A-Za-z0-9-]`. */
    readonly presentationId?: string;
  }): Promise<StoreKitPurchaseOutcome>;
  /**
   * Declares the sheet facts the native code reports. A native build from
   * before them answers `UNIMPLEMENTED`; optional so a plugin double without
   * it still type-checks, and then the SDK refuses purchases that need facts.
   */
  getPresentationSupport?(): Promise<StoreKitPresentationSupport>;
  /**
   * Declares the finish matches beyond the session token. A native build
   * from before it answers `UNIMPLEMENTED`; optional so a plugin double
   * without it still type-checks, and then the SDK never finishes a
   * transaction bound to no token.
   */
  getFinishSupport?(): Promise<StoreKitFinishSupport>;
  /** Includes unfinished consumables and current non-consumable entitlements. */
  getTransactions(): Promise<{ readonly transactions: readonly StoreKitTransaction[] }>;
  /** User-initiated App Store account synchronization before restore. */
  sync(): Promise<{ readonly synced: boolean }>;
  /**
   * Call only after the authenticated backend confirms the ledger grant.
   * Finishing never grants. Native finishes only a verified, non-revoked,
   * one-time transaction whose app account token matches `appAccountToken`,
   * or, with `withoutAppAccountToken: true`, a verified, non-revoked
   * non-consumable bound to no token. The StoreKit SDK injects the session
   * token and applies the same match before this call, including for
   * `commerce.v2.finishTransaction`. Games must not call this plugin method
   * directly. The token match is not a signed server capability: a caller
   * who can read `getTransactions` can still supply that token (or the
   * no-token flag) with a forged ledger entry id.
   */
  finishTransaction(input: StoreKitFinishTransactionInput): Promise<{ readonly finished: boolean }>;
  addListener(
    eventName: 'transactionUpdated',
    listener: (event: StoreKitTransaction) => void,
  ): Promise<PluginListenerHandle>;
  /** Sheet facts of `purchase` calls that sent a `presentationId`. */
  addListener(
    eventName: 'purchasePresentation',
    listener: (event: StoreKitPurchasePresentationEvent) => void,
  ): Promise<PluginListenerHandle>;
}

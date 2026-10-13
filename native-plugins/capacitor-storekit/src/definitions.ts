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
   * finished. Omitted by native builds predating the field and by
   * `purchase` and `transactionUpdated` payloads.
   */
  readonly unfinished?: boolean;
}

export type StoreKitPurchaseOutcome =
  | { readonly status: 'purchased'; readonly transaction: StoreKitTransaction }
  | { readonly status: 'pending' | 'cancelled' };

export interface CapacitorStoreKitPlugin {
  getProducts(input: { readonly productIds: readonly string[] }): Promise<{
    readonly products: readonly StoreKitProduct[];
  }>;
  purchase(input: {
    readonly productId: string;
    readonly appAccountToken: string;
  }): Promise<StoreKitPurchaseOutcome>;
  /** Includes unfinished consumables and current non-consumable entitlements. */
  getTransactions(): Promise<{ readonly transactions: readonly StoreKitTransaction[] }>;
  /** User-initiated App Store account synchronization before restore. */
  sync(): Promise<{ readonly synced: boolean }>;
  /**
   * Call only after the authenticated backend confirms the ledger grant.
   * Native validation is intentionally shallow and finishing never grants
   * anything. The commerce provider's `finishTransaction` is the only caller:
   * the reconciler in `@mpgd/game-services` reaches it through
   * `assertCommerceFinishAllowed` after the ledger grant, so games must not
   * call this plugin method directly. That gate is not a trust boundary
   * against code that controls the backend object given to the reconciler:
   * the authenticated server-side verification is the real control.
   */
  finishTransaction(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  }): Promise<{ readonly finished: boolean }>;
  addListener(
    eventName: 'transactionUpdated',
    listener: (event: StoreKitTransaction) => void,
  ): Promise<PluginListenerHandle>;
}

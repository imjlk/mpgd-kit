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
  /** Call only after the authenticated backend confirms the ledger grant. */
  finishTransaction(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  }): Promise<{ readonly finished: boolean }>;
  addListener(
    eventName: 'transactionUpdated',
    listener: (event: StoreKitTransaction) => void,
  ): Promise<PluginListenerHandle>;
}

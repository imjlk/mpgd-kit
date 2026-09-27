import type { PluginListenerHandle } from '@capacitor/core';

export type PlayPurchaseState = 'purchased' | 'pending';

export interface PlayProduct {
  readonly productId: string;
  readonly title: string;
  readonly description: string;
  /** Explicit offer selection is required when Google returns multiple offers. */
  readonly offers: readonly {
    readonly offerToken: string;
    readonly formattedPrice: string;
    readonly currencyCode: string;
  }[];
}

export interface PlayPurchase {
  readonly productIds: readonly string[];
  readonly purchaseToken: string;
  readonly orderId?: string;
  readonly purchaseTimeMillis?: number;
  readonly state: PlayPurchaseState;
}

export interface PlayPurchaseOutcome {
  readonly status: 'purchased' | 'pending' | 'cancelled';
  readonly purchase?: PlayPurchase;
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
  /** Requeries owned, unconsumed purchases after restart or missed callbacks. */
  getPurchases(): Promise<{ readonly purchases: readonly PlayPurchase[] }>;
  addListener(
    eventName: 'purchaseUpdated',
    listener: (event: PlayPurchaseOutcome) => void,
  ): Promise<PluginListenerHandle>;
}

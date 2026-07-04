export type LogicalProductId = 'COINS_100' | 'COINS_500' | 'REMOVE_ADS';

export type LogicalAdPlacementId = 'CONTINUE_AFTER_FAIL' | 'STAGE_END_INTERSTITIAL';

export type ProductType = 'consumable' | 'non_consumable' | 'subscription';

export interface ProductInfo {
  readonly id: LogicalProductId;
  readonly type: ProductType;
  readonly title: string;
  readonly description: string;
  readonly price: {
    readonly formatted: string;
    readonly currencyCode: string;
  };
}

export interface Entitlement {
  readonly id: string;
  readonly source: 'purchase' | 'promotion' | 'admin';
  readonly grantedAt: string;
  readonly expiresAt?: string;
}

export interface PurchaseResult {
  readonly status: 'completed' | 'cancelled' | 'pending' | 'failed';
  readonly transactionId?: string;
  readonly entitlementIds: readonly string[];
}

export interface PurchaseRestoreResult {
  readonly restoredEntitlements: readonly Entitlement[];
}

export interface RewardedAdResult {
  readonly status: 'completed' | 'skipped' | 'unavailable' | 'failed';
  readonly rewardGranted: boolean;
  readonly ledgerEntryId?: string;
}

export interface InterstitialAdResult {
  readonly status: 'shown' | 'skipped' | 'unavailable';
}

export interface CommerceAdapter {
  getProducts(): Promise<readonly ProductInfo[]>;
  purchase(input: {
    readonly productId: LogicalProductId;
    readonly source: 'shop' | 'stage_fail' | 'result' | 'event';
    readonly idempotencyKey: string;
  }): Promise<PurchaseResult>;
  restore?(): Promise<PurchaseRestoreResult>;
  getEntitlements(): Promise<readonly Entitlement[]>;
}

export interface AdAdapter {
  preload(input: { readonly placementId: LogicalAdPlacementId }): Promise<void>;
  showRewarded(input: {
    readonly placementId: LogicalAdPlacementId;
    readonly idempotencyKey: string;
  }): Promise<RewardedAdResult>;
  showInterstitial?(input: {
    readonly placementId: LogicalAdPlacementId;
  }): Promise<InterstitialAdResult>;
}

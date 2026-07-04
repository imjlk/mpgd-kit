export type PlatformTarget = 'browser' | 'android' | 'ios' | 'ait' | 'reddit' | 'telegram' | 'tauri';

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

export interface LeaderboardScoreInput {
  readonly leaderboardId: string;
  readonly score: number;
  readonly runId: string;
  readonly submittedAt: string;
}

export interface LeaderboardSubmitResult {
  readonly submitted: boolean;
  readonly rank?: number;
}

export interface LeaderboardAdapter {
  submitScore(input: LeaderboardScoreInput): Promise<LeaderboardSubmitResult>;
  open(input?: { readonly leaderboardId?: string }): Promise<void>;
}

export interface PlatformCapabilities {
  readonly nativeIap: boolean;
  readonly nativeAds: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly nativeLeaderboard: boolean;
  readonly achievements: boolean;
  readonly cloudSave: boolean;
  readonly socialShare: boolean;
  readonly haptics: boolean;
  readonly localizedContent: boolean;
}

export interface PlayerIdentity {
  readonly playerId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface IdentityAdapter {
  getPlayer(): Promise<PlayerIdentity | null>;
}

export interface LifecycleAdapter {
  onPause(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
}

export interface StorageLoadResult {
  readonly value: unknown;
}

export interface StorageAdapter {
  load(input: { readonly key: string }): Promise<StorageLoadResult | null>;
  save(input: { readonly key: string; readonly value: unknown }): Promise<void>;
}

export interface PlatformGateway {
  readonly target: PlatformTarget;
  getCapabilities(): Promise<PlatformCapabilities>;
  readonly identity: IdentityAdapter;
  readonly commerce: CommerceAdapter;
  readonly ads: AdAdapter;
  readonly leaderboard: LeaderboardAdapter;
  readonly lifecycle: LifecycleAdapter;
  readonly storage: StorageAdapter;
}

export function createUnsupportedCapabilities(): PlatformCapabilities {
  return {
    nativeIap: false,
    nativeAds: false,
    rewardedAds: false,
    interstitialAds: false,
    nativeLeaderboard: false,
    achievements: false,
    cloudSave: false,
    socialShare: false,
    haptics: false,
    localizedContent: false,
  };
}

export type PlatformTarget =
  | 'browser'
  | 'microsoft-store'
  | 'android'
  | 'ios'
  | 'ait'
  | 'reddit'
  | 'verse8'
  | 'telegram'
  | 'tauri'
  | 'wechat'
  | 'tiktok';

export type StarterLogicalProductId = 'COINS_100' | 'COINS_500' | 'REMOVE_ADS';

export type LogicalProductId = StarterLogicalProductId | (string & Record<never, never>);

export type StarterLogicalAdPlacementId = 'CONTINUE_AFTER_FAIL' | 'STAGE_END_INTERSTITIAL';

export type LogicalAdPlacementId =
  | StarterLogicalAdPlacementId
  | (string & Record<never, never>);

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

export interface PlatformEvidenceEnvelope {
  readonly schema: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

export interface PlatformOperationFailure {
  readonly code: string;
  readonly retryable: boolean;
}

/**
 * Provider-neutral error raised when a platform bridge rejects an operation.
 *
 * Adapters preserve a stable, non-sensitive code and retry hint so game UI can
 * distinguish configuration, environment, and transient failures without
 * importing a provider SDK or parsing localized error messages.
 */
export class PlatformOperationError extends Error implements PlatformOperationFailure {
  override readonly name = 'PlatformOperationError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(input?: Readonly<{
    readonly code?: unknown;
    readonly message?: unknown;
    readonly retryable?: unknown;
  }>) {
    const diagnostics = input ?? {};
    super(
      typeof diagnostics.message === 'string'
        ? diagnostics.message
        : 'The platform operation failed.',
    );
    this.code = normalizePlatformOperationCode(diagnostics.code);
    this.retryable = diagnostics.retryable === true;
  }
}

export function readPlatformOperationFailure(error: unknown): PlatformOperationFailure | null {
  if (error instanceof PlatformOperationError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return null;
  }
  const record = error as Readonly<Record<string, unknown>>;
  return typeof record.code === 'string'
    && isPlatformOperationCode(record.code)
    && typeof record.retryable === 'boolean'
      ? { code: record.code, retryable: record.retryable }
      : null;
}

function normalizePlatformOperationCode(code: unknown): string {
  return isPlatformOperationCode(code) ? code : 'PLATFORM_OPERATION_FAILED';
}

function isPlatformOperationCode(code: unknown): code is string {
  return typeof code === 'string'
    && code.length > 0
    && code.length <= 128
    && /^[A-Z][A-Z0-9_:-]*$/u.test(code);
}

export interface PurchaseResult {
  readonly status: 'completed' | 'cancelled' | 'pending' | 'failed';
  readonly transactionId?: string;
  readonly entitlementIds: readonly string[];
  readonly evidence?: PlatformEvidenceEnvelope;
  /** Present only when the adapter already completed the authoritative server grant. */
  readonly authoritativeGrant?: Readonly<{
    readonly ledgerEntryId: string;
    readonly alreadyProcessed?: boolean;
  }>;
}

export interface PurchaseRestoreResult {
  readonly restoredEntitlements: readonly Entitlement[];
  /** Server-confirmed consumable outcomes; native order visibility alone is not a grant. */
  readonly settledPurchases?: readonly PurchaseSettlement[];
}

export interface PurchaseSettlement {
  readonly transactionId: string;
  readonly productId: LogicalProductId;
  readonly status: 'granted' | 'refunded';
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed?: boolean;
}

/**
 * Resolve a specific purchase from authoritative checkout or restore evidence.
 * A completed native checkout without authoritativeGrant is still unconfirmed.
 * This is UI status evidence, never permission to credit a wallet locally.
 * The caller must pair `purchase` with its requested `productId` because
 * PurchaseResult itself does not carry a product identifier.
 */
export function findAuthoritativePurchaseSettlement(input: {
  readonly productId: LogicalProductId;
  readonly transactionId?: string;
  readonly purchase?: PurchaseResult;
  readonly restore?: PurchaseRestoreResult;
}): PurchaseSettlement | null {
  const effectiveTransactionId = input.transactionId ?? input.purchase?.transactionId;
  const matchingRestored = input.restore?.settledPurchases?.filter((settlement) =>
    settlement.productId === input.productId
    && (effectiveTransactionId === undefined || settlement.transactionId === effectiveTransactionId),
  );
  // Without an order ID, multiple historical outcomes are ambiguous.
  if (matchingRestored !== undefined && matchingRestored.length > 1) {
    return null;
  }
  if (matchingRestored?.[0] !== undefined) {
    return matchingRestored[0];
  }
  const purchase = input.purchase;
  if (
    purchase?.status !== 'completed'
    || purchase.transactionId === undefined
    || purchase.authoritativeGrant === undefined
    || (effectiveTransactionId !== undefined && effectiveTransactionId !== purchase.transactionId)
  ) {
    return null;
  }
  return {
    transactionId: purchase.transactionId,
    productId: input.productId,
    status: 'granted',
    ledgerEntryId: purchase.authoritativeGrant.ledgerEntryId,
    ...(purchase.authoritativeGrant.alreadyProcessed === undefined
      ? {}
      : { alreadyProcessed: purchase.authoritativeGrant.alreadyProcessed }),
  };
}

export interface RewardedAdResult {
  readonly status: 'completed' | 'skipped' | 'unavailable' | 'failed';
  readonly rewardGranted: boolean;
  readonly ledgerEntryId?: string;
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface InterstitialAdResult {
  readonly status: 'shown' | 'skipped' | 'unavailable';
}

/**
 * Result of mounting a platform-rendered inline banner into a game-owned surface.
 * The platform host owns the native/SDK attachment; games only reserve and name
 * a surface, so this contract does not leak DOM or provider types. Adapters must
 * release any partial attachment before resolving `unavailable` or `failed`;
 * games only need to unmount a successfully mounted banner.
 */
export interface BannerAdMountResult {
  readonly status: 'mounted' | 'unavailable' | 'failed';
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
  preload(input: {
    readonly placementId: LogicalAdPlacementId;
    /** Allows a shared provider preload method to enforce format readiness. */
    readonly format?: 'rewarded' | 'interstitial' | 'banner';
  }): Promise<void>;
  showRewarded(input: {
    readonly placementId: LogicalAdPlacementId;
    readonly idempotencyKey: string;
  }): Promise<RewardedAdResult>;
  showInterstitial?(input: {
    readonly placementId: LogicalAdPlacementId;
  }): Promise<InterstitialAdResult>;
  mountBanner?(input: {
    readonly placementId: LogicalAdPlacementId;
    /** Host-resolvable identifier for an empty, game-owned inline ad surface. */
    readonly surfaceId: string;
  }): Promise<BannerAdMountResult>;
  unmountBanner?(input: { readonly surfaceId: string }): Promise<void>;
}

export type PromotionRewardAvailability =
  | 'available'
  | 'configuration-required'
  | 'unsupported';

export type PromotionRewardResult =
  | {
      readonly status: 'granted';
      /** Opaque provider receipt used by the game backend to finalize the authorized claim. */
      readonly receiptKey: string;
    }
  | {
      readonly status: 'pending' | 'unavailable' | 'failed';
    };

/**
 * Optional platform-funded promotion surface.
 *
 * Games address logical campaign ids only. Platform promotion codes and reward
 * amounts belong to the target host configuration, while claim authorization
 * and receipt finalization remain server responsibilities.
 */
export interface PromotionRewardAdapter {
  getAvailability(input: {
    readonly campaignId: string;
  }): Promise<PromotionRewardAvailability>;
  grantReward(input: {
    readonly campaignId: string;
    /** Server-issued, single-use claim id. */
    readonly idempotencyKey: string;
  }): Promise<PromotionRewardResult>;
}

export interface LeaderboardScoreInput {
  readonly leaderboardId: string;
  readonly score: number;
  readonly runId: string;
  readonly submittedAt: string;
  /** Optional target-selected route when native and remote backends coexist. */
  readonly route?: 'native' | 'remote';
}

export interface LeaderboardSubmitResult {
  readonly submitted: boolean;
  readonly rank?: number;
}

export interface LeaderboardAdapter {
  submitScore(input: LeaderboardScoreInput): Promise<LeaderboardSubmitResult>;
  open(input?: { readonly leaderboardId?: string; readonly route?: 'native' | 'remote' }): Promise<void>;
}

/** Readiness of an installed platform provider, independent of target policy. */
export type PlatformProviderAvailability =
  | 'unsupported'
  | 'configuration-required'
  | 'action-required'
  | 'temporarily-unavailable'
  | 'available';

/** Existing capabilities and integrations annotated by optional providers. */
export type PlatformProviderFeature =
  | 'nativeIap'
  | 'subscriptionIap'
  | 'rewardedAds'
  | 'interstitialAds'
  | 'bannerAds'
  | 'nativeLeaderboard'
  | 'identityUpgrade'
  | 'pushNotifications';

export interface PlatformCapabilities {
  readonly nativeIap: boolean;
  /** Optional for adapters published before subscription-specific support. */
  readonly subscriptionIap?: boolean;
  readonly nativeAds: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  /** Optional for compatibility with adapters published before inline ads. */
  readonly bannerAds?: boolean;
  readonly nativeLeaderboard: boolean;
  /** A game-owned server leaderboard is available without a native platform surface. */
  readonly remoteLeaderboard: boolean;
  readonly achievements: boolean;
  readonly cloudSave: boolean;
  readonly socialShare: boolean;
  readonly haptics: boolean;
  readonly localizedContent: boolean;
  /** Explains a false capability without claiming an unavailable SDK works. */
  readonly providerAvailability?: Readonly<Partial<Record<
    PlatformProviderFeature,
    PlatformProviderAvailability
  >>>;
}

export interface PlayerIdentity {
  readonly playerId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export type IdentityLevel = 'guest' | 'platform-anonymous' | 'authenticated';

export type IdentityTrustLevel = 'local' | 'platform-asserted' | 'server-verified';

export interface IdentitySession {
  readonly identityLevel: IdentityLevel;
  readonly playerId?: string;
  readonly trustLevel: IdentityTrustLevel;
}

export type IdentityUpgradeReason = 'save' | 'leaderboard' | 'share' | 'notifications';

export interface IdentityUpgradeResult {
  readonly status: 'completed' | 'cancelled' | 'unavailable';
  readonly reloadExpected: boolean;
}

export interface IdentityAdapter {
  getPlayer(): Promise<PlayerIdentity | null>;
  getSession?(): Promise<IdentitySession>;
  requestUpgrade?(input: {
    readonly reason: IdentityUpgradeReason;
  }): Promise<IdentityUpgradeResult>;
}

export type LaunchEntry =
  | 'home'
  | 'daily'
  | 'practice'
  | 'free-play'
  | 'continue'
  | 'leaderboard'
  | 'friend-challenge';

export interface LaunchIntent {
  readonly entry: LaunchEntry;
  readonly puzzleId?: string;
  readonly referralToken?: string;
}

export type PresentationResult = 'opened' | 'already-fullscreen' | 'unavailable';

export interface PresentationAdapter {
  getLaunchIntent(): Promise<LaunchIntent>;
  requestGameSurface(intent: LaunchIntent): Promise<PresentationResult>;
}

export interface SharePayload {
  readonly puzzleId?: string;
  readonly challengeToken?: string;
}

export interface ShareIntent {
  readonly kind: 'daily-result' | 'friend-challenge' | 'invite';
  readonly title: string;
  readonly text: string;
  readonly deepLink: string;
  readonly payload?: SharePayload;
  readonly previewImageUrl?: string;
}

/**
 * Evidence available after a platform reports a successful share operation.
 * `presented` means the platform share surface opened, not that the user
 * finished sharing. `completed` means the adapter observed completion.
 */
export type ShareCompletion = 'presented' | 'completed';

export interface ShareResult {
  readonly status: 'shared' | 'cancelled' | 'unavailable';
  /**
   * Optional for backward compatibility. A legacy `shared` result without this
   * field normalizes to `completed`; new adapters should set it explicitly when
   * they can only prove that a share surface was presented.
   */
  readonly completion?: ShareCompletion;
}

export function resolveShareCompletion(result: ShareResult): ShareCompletion | undefined {
  if (result.status !== 'shared') {
    return undefined;
  }

  return result.completion ?? 'completed';
}

export function isShareCompleted(result: ShareResult): boolean {
  return resolveShareCompletion(result) === 'completed';
}

export interface InboundShare {
  readonly puzzleId?: string;
  readonly challengeToken?: string;
}

export interface ShareAdapter {
  share?(intent: ShareIntent): Promise<ShareResult>;
  readInboundShare?(): Promise<InboundShare | null>;
}

export type NotificationTopic = 'daily-ready' | 'streak-at-risk' | 'friend-challenge';

export type NotificationSubscriptionStatus =
  | 'subscribed'
  | 'not-subscribed'
  | 'approval-required'
  | 'configuration-required'
  | 'unsupported';

export type NotificationSubscriptionResult = 'subscribed' | 'rejected' | 'unavailable';

export interface NotificationSubscriptionAdapter {
  getStatus(topic: NotificationTopic): Promise<NotificationSubscriptionStatus>;
  requestSubscription(topic: NotificationTopic): Promise<NotificationSubscriptionResult>;
}

/** The source of an app URL, not a claim that the URL is trusted. */
export interface NativeOpenUrlEvent {
  readonly url: string;
  readonly source: 'cold' | 'warm';
}

export interface NativeBackButtonEvent {
  /** Whether the WebView history can navigate back, not the game's own scene stack. */
  readonly canGoBack: boolean;
}

/** Full WebView viewport geometry in CSS pixels, before applying game-owned padding. */
export interface PlatformViewportInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface PlatformViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** An occupied game surface with stable identity, not an extra inset to sum. */
export interface PlatformViewportOccupiedSurface {
  readonly surfaceId: string;
  readonly edge: 'top' | 'right' | 'bottom' | 'left';
  readonly bounds: PlatformViewportBounds;
}

export interface PlatformViewportState {
  readonly width: number;
  readonly height: number;
  readonly safeAreaInsets: PlatformViewportInsets;
  readonly systemBarInsets: PlatformViewportInsets;
  readonly keyboardInsets: PlatformViewportInsets;
  readonly occupiedSurfaces: readonly PlatformViewportOccupiedSurface[];
}

/** Optional native viewport source; consumers use one owner for canvas and DOM layout. */
export interface ViewportAdapter {
  getState(): PlatformViewportState;
  onChange(callback: (state: PlatformViewportState) => void): () => void;
  dispose?(): void;
}

export interface LifecycleAdapter {
  onPause(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
  /**
   * Android handlers run last-registered-first until one returns true. If none
   * consumes the event, Capacitor navigates WebView history when possible or
   * exits the app. The method's presence does not imply support on iOS: check
   * the gateway target. Persist progress at checkpoints; back/exit callbacks
   * are not guaranteed to run before process termination.
   */
  onBackButton?(
    handler: (event: NativeBackButtonEvent) => boolean | Promise<boolean>,
  ): () => void;
  /** Game links and OAuth redirects use separate callbacks. */
  onGameUrlOpen?(callback: (event: NativeOpenUrlEvent) => void): () => void;
  onOAuthRedirect?(callback: (event: NativeOpenUrlEvent) => void): () => void;
  getInitialGameUrl?(): Promise<NativeOpenUrlEvent | null>;
  getInitialOAuthRedirect?(): Promise<NativeOpenUrlEvent | null>;
  /**
   * Keep execution paused while external UI is open. Call the returned
   * idempotent release function when it closes, including failure paths;
   * otherwise execution remains paused.
   */
  beginExternalActivity?(): () => void;
  /** Remove only the native listeners owned by this adapter instance. */
  dispose?(): Promise<void>;
}

export interface StorageLoadResult {
  readonly value: unknown;
}

export interface StorageAdapter {
  load(input: { readonly key: string }): Promise<StorageLoadResult | null>;
  /** Persist a JSON-serializable value or reject without replacing the prior value. */
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
  readonly viewport?: ViewportAdapter;
  readonly storage: StorageAdapter;
  readonly presentation?: PresentationAdapter;
  readonly sharing?: ShareAdapter;
  readonly notifications?: NotificationSubscriptionAdapter;
  readonly promotions?: PromotionRewardAdapter;
}

export function createUnsupportedCapabilities(): PlatformCapabilities {
  return {
    nativeIap: false,
    nativeAds: false,
    rewardedAds: false,
    interstitialAds: false,
    nativeLeaderboard: false,
    remoteLeaderboard: false,
    achievements: false,
    cloudSave: false,
    socialShare: false,
    haptics: false,
    localizedContent: false,
  };
}

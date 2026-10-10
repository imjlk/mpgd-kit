import {
  getTossShareLink,
  getUserKeyForGame,
  grantPromotionRewardForGame as grantPromotionReward,
  IAP,
  isMinVersionSupported,
  loadFullScreenAd,
  openGameCenterLeaderboard,
  requestNotificationAgreement,
  share,
  showFullScreenAd,
  Storage,
  submitGameCenterLeaderBoardScore,
  TossAds,
  type IapProductListItem,
} from '@apps-in-toss/web-framework';

import {
  assertBridgeRequest,
  bridgeStorageLoadProtocol,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import type {
  BannerAdMountResult,
  CommerceDiagnostic,
  Entitlement,
  LaunchEntry,
  LaunchIntent,
  LogicalProductId,
  NotificationTopic,
  PlatformEvidenceEnvelope,
  ProductInfo,
  PromotionRewardResult,
  PurchaseRestoreResult,
  PurchaseResult,
  PurchaseSettlement,
  ShareResult,
} from '@mpgd/platform';

import { assertAdShowInput, toAdAdapter } from '@mpgd/platform/ads';
import { createAitAdProvider } from './ad-provider.js';

import type { AitAdPlacementType } from './ad-config.js';
import {
  aitIapDiagnosticCodes,
  aitIapProductNotGrantedByPartnerCode,
  type AitIapDiagnosticCode,
} from './iap-diagnostics.js';
import type { GamePlatformBridge } from './index.js';
import { dispatchAitLifecycleEvent } from './lifecycle.js';

export {
  aitIapDiagnosticCodes,
  aitIapProductNotGrantedByPartnerCode,
  type AitIapDiagnosticCode,
} from './iap-diagnostics.js';
export { aitBrowserOrigins, isAitBrowserOrigin } from './origins.js';

const defaultAdTimeoutMs = 60_000;
const defaultAdLoadQueueTimeoutMs = 5_000;
const defaultAdDisplayStartTimeoutMs = 60_000;
const defaultAdMaximumDisplayMs = 30 * 60_000;
const defaultBannerRenderTimeoutMs = 15_000;
/** Leaves five seconds of headroom inside the native IAP 30-second grant callback. */
const defaultIapProductGrantTimeoutMs = 25_000;
/** Bounds abandoned checkout UI while still allowing the user to finish an interactive purchase. */
const defaultIapPurchaseSessionTimeoutMs = 30 * 60_000;
/** A provider response is untrusted input; keep restore work bounded per launch. */
const maximumPendingIapOrders = 20;
const invalidBridgeRequestId = 'ait-invalid-request';
const iapEvidenceSchema = 'apps-in-toss.iap.callback.v1';
const minimumPromotionTossAppVersion = '5.232.0';
/**
 * Every adapter-owned durable marker (purchase attempts, promotion grants,
 * recovery cursors) lives under this prefix. Game code shares the same native
 * storage, so `storage.save`/`storage.load` must never touch these keys: a
 * forged `completed` marker would otherwise short-circuit purchase verification.
 */
const reservedStorageKeyPrefix = 'mpgd:ait:';
const promotionGrantStoragePrefix = 'mpgd:ait:promotion-grant:v1:';
/**
 * A client idempotency key must survive a bridge reload. The authoritative
 * backend still owns entitlements; this marker only prevents a second native
 * checkout while the first checkout is known to be terminal or ambiguous.
 */
const iapPurchaseAttemptStoragePrefix = 'mpgd:ait:iap-purchase-attempt:v1:';
const iapCompletedPurchaseAttemptIndexStorageKey = 'mpgd:ait:iap-completed-purchase-index:v1';
const maximumIndexedCompletedIapPurchaseAttempts = 64;
/** A crashed pre-checkout attempt can be retried only after provider recovery finds no order. */
const pendingIapPurchaseAttemptRecoveryAgeMs = defaultIapPurchaseSessionTimeoutMs;
/** Rotates bounded pending-order recovery so an early rejected order cannot starve later work. */
const iapPendingOrderCursorStorageKey = 'mpgd:ait:pending-order-cursor:v1';
/**
 * Links a provider order id to the client purchase attempt that opened it, so
 * recovery paths can pass the game's own purchase key to the verifier and
 * finish that attempt's retry barrier.
 */
const iapOrderAttemptLinkStoragePrefix = 'mpgd:ait:iap-order-attempt:v1:';
const defaultNotificationAgreementTimeoutMs = 120_000;
const notificationTopics = new Set<NotificationTopic>([
  'daily-ready',
  'streak-at-risk',
  'friend-challenge',
]);
const launchEntries = new Set<LaunchEntry>([
  'home',
  'daily',
  'practice',
  'free-play',
  'continue',
  'leaderboard',
  'friend-challenge',
]);

export type AitIdentityProvider = () => Promise<unknown>;

const defaultAitIdentityProvider: AitIdentityProvider = () => getUserKeyForGame();

/**
 * Shares one game identity hash read across a wrapper session.
 * Rejected reads are evicted so a resumed mobile host can retry after login or
 * WebView state has recovered.
 */
export function createAitSessionIdentityProvider(
  provider: AitIdentityProvider = defaultAitIdentityProvider,
): AitIdentityProvider {
  let pending: Promise<unknown> | undefined;
  return () => {
    const current = pending;
    if (current !== undefined) {
      return current;
    }
    const attempt = Promise.resolve().then(provider);
    void (pending = attempt);
    void attempt.catch(() => {
      if (pending === attempt) {
        pending = undefined;
      }
    });
    return attempt;
  };
}

/**
 * The AIT SDK adds support-version metadata to native functions over time.
 * The host only depends on the callable surface and an optional support probe
 * so adapter tests remain compatible with older wrappers and newer SDKs.
 */
type AitOptionalCapabilityMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => ReturnType<T>;

interface AitCapabilityProbe {
  readonly isSupported?: () => boolean;
}

type AitNativeMethod<T extends (...args: never[]) => unknown> =
  AitOptionalCapabilityMethod<T> & AitCapabilityProbe;

interface AitIapDependencies {
  readonly createOneTimePurchaseOrder: AitNativeMethod<typeof IAP.createOneTimePurchaseOrder>;
  readonly getProductItemList: AitNativeMethod<typeof IAP.getProductItemList>;
  readonly getPendingOrders: AitNativeMethod<typeof IAP.getPendingOrders>;
  readonly completeProductGrant: AitNativeMethod<typeof IAP.completeProductGrant>;
}

interface AitBannerDependencies {
  readonly initialize: typeof TossAds.initialize;
  readonly attachBanner: typeof TossAds.attachBanner;
}

export interface AitHostDependencies {
  readonly identityProvider: AitIdentityProvider;
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly getTossShareLink: typeof getTossShareLink;
  readonly share: typeof share;
  readonly grantPromotionReward: AitNativeMethod<typeof grantPromotionReward>;
  readonly requestNotificationAgreement: AitNativeMethod<typeof requestNotificationAgreement>;
  readonly isMinVersionSupported: typeof isMinVersionSupported;
  readonly loadFullScreenAd: AitNativeMethod<typeof loadFullScreenAd>;
  readonly showFullScreenAd: AitNativeMethod<typeof showFullScreenAd>;
  readonly tossAds: AitBannerDependencies;
  readonly openGameCenterLeaderboard: AitNativeMethod<typeof openGameCenterLeaderboard>;
  readonly submitGameCenterLeaderBoardScore: AitNativeMethod<
    typeof submitGameCenterLeaderBoardScore
  >;
  readonly iap: AitIapDependencies;
}

/** Game-owned logical product mapped to a console-issued Apps in Toss SKU. */
export interface AitIapProductConfig {
  readonly productId: LogicalProductId;
  readonly sku: string;
  /** Apps in Toss currently displays KRW prices; override only for a supported future catalog. */
  readonly currencyCode?: string;
}

export interface AitIapPreparationInput {
  readonly intent: 'purchase' | 'restore';
  readonly productId?: LogicalProductId;
  readonly platformSku?: string;
}

/**
 * Game-owned server gate that ensures the anonymous game key is linked to a
 * Toss login user before a purchase or pending-order recovery can proceed.
 */
export type AitIapPreparer = (input: AitIapPreparationInput) => Promise<boolean>;

export interface AitIapProductGrantVerificationInput {
  readonly orderId: string;
  readonly productId: LogicalProductId;
  readonly platformSku: string;
  /** Order-scoped server idempotency key: `apps-in-toss:purchase:<encoded order id>`. */
  readonly idempotencyKey: string;
  /**
   * The game's own `commerce.purchase` idempotency key for the attempt that
   * opened this order. It is present on every path where the bridge can link
   * the order to a client attempt (the grant callback, a direct re-verify, and
   * restore or pre-checkout recovery of an order this device started), and
   * absent when no link survives (for example after native storage loss).
   * Use it to associate the order with a game operation; keep `idempotencyKey`
   * as the grant authority identity.
   */
  readonly clientIdempotencyKey?: string;
  readonly source: 'process-product-grant' | 'pending-order-restore';
  /** Client callback time only; the game authority must use the order status time. */
  readonly purchasedAt: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * A server-backed verifier. Returning false keeps the provider-side grant
 * pending; the bridge never manufactures a client-side entitlement.
 */
export type AitIapProductGrantVerifier = (
  input: AitIapProductGrantVerificationInput,
) => Promise<boolean>;

/**
 * Reads durable purchase entitlements from the game authority. Native product
 * callbacks are intentionally not treated as a source of ownership state.
 */
export type AitIapEntitlementReader = () => Promise<readonly Entitlement[]>;

export interface AitPromotionRewardConfig {
  readonly promotionCode: string;
  readonly amount: number;
}

export interface AitPendingPromotionGrantInput {
  readonly campaignId: string;
  readonly idempotencyKey: string;
  /** Missing for legacy or malformed pending markers; resolvers must fail closed. */
  readonly pendingSince?: string;
}

export type AitPendingPromotionGrantResolution =
  | { readonly status: 'granted'; readonly receiptKey: string }
  | { readonly status: 'retry' | 'pending' };

/**
 * Server-backed reconciliation hook for an ambiguous native promotion call.
 * Returning `retry` must only happen after the game authority decides that a
 * second provider call is safe for this single-use claim id.
 */
export type AitPendingPromotionGrantResolver = (
  input: AitPendingPromotionGrantInput,
) => Promise<AitPendingPromotionGrantResolution>;

export interface AitPromotionGrantAuthorizationInput {
  readonly campaignId: string;
  /** Single-use claim id issued by the game backend. */
  readonly idempotencyKey: string;
}

export type AitPromotionGrantAuthorization =
  | { readonly status: 'authorized' }
  | { readonly status: 'pending' | 'rejected' };

/**
 * Server-backed gate for the first provider call. A configured campaign is not
 * available until this hook confirms that the idempotency key is a genuine,
 * single-use game claim.
 */
export type AitPromotionGrantAuthorizer = (
  input: AitPromotionGrantAuthorizationInput,
) => Promise<AitPromotionGrantAuthorization>;

export interface AitBannerAppearance {
  readonly theme?: 'auto' | 'light' | 'dark';
  readonly tone?: 'blackAndWhite' | 'grey';
  readonly variant?: 'card' | 'expanded';
}

export interface InstallAitHostBridgeOptions {
  readonly appName?: string;
  readonly adGroupIds?: Readonly<Record<string, string>>;
  readonly adPlacementTypes?: Readonly<Record<string, AitAdPlacementType>>;
  /** Logical campaign ids mapped to console-issued Apps in Toss promotion configuration. */
  readonly promotionRewards?: Readonly<Record<string, AitPromotionRewardConfig>>;
  readonly authorizePromotionGrant?: AitPromotionGrantAuthorizer;
  readonly resolvePendingPromotionGrant?: AitPendingPromotionGrantResolver;
  /** Enable IAP only with logical-to-native SKU mappings and both server hooks. */
  readonly iapProducts?: readonly AitIapProductConfig[];
  readonly prepareIap?: AitIapPreparer;
  readonly verifyIapProductGrant?: AitIapProductGrantVerifier;
  /** Required to expose native IAP so ownership survives a wrapper restart. */
  readonly readIapEntitlements?: AitIapEntitlementReader;
  /** May be shortened, but never extended beyond the native callback-safe default. */
  readonly iapProductGrantTimeoutMs?: number;
  /** Logical notification topics mapped to approved Apps in Toss template codes. */
  readonly notificationTemplateCodes?: Partial<Readonly<Record<NotificationTopic, string>>>;
  /** Maximum total wait for the native show request before display is observed. */
  readonly adTimeoutMs?: number;
  /** Maximum wait to acquire the process-wide native full-screen load slot. */
  readonly adLoadQueueTimeoutMs?: number;
  /** Upper bound for the requested-to-display portion of the total show timeout. */
  readonly adDisplayStartTimeoutMs?: number;
  /** Caller wait limit; a missing native terminal callback keeps presentation unknown. */
  readonly adMaximumDisplayMs?: number;
  /** Maximum wait for an inline banner to render or report no-fill/failure. */
  readonly bannerRenderTimeoutMs?: number;
  /** Provider-neutral host preference mapped to the Apps in Toss banner appearance. */
  readonly bannerAppearance?: AitBannerAppearance;
  readonly dependencies?: Partial<AitHostDependencies>;
}

const defaultDependencies: AitHostDependencies = {
  identityProvider: defaultAitIdentityProvider,
  storage: Storage,
  getTossShareLink,
  share,
  grantPromotionReward,
  requestNotificationAgreement,
  isMinVersionSupported,
  loadFullScreenAd,
  showFullScreenAd,
  tossAds: TossAds,
  openGameCenterLeaderboard,
  submitGameCenterLeaderBoardScore,
  iap: IAP,
};

export function installAitHostBridge(options: InstallAitHostBridgeOptions = {}): GamePlatformBridge {
  const bridge = createAitHostBridge(options);
  (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge }).__GAME_PLATFORM_BRIDGE__ = bridge;
  return bridge;
}

export function createAitHostBridge(
  options: InstallAitHostBridgeOptions = {},
): GamePlatformBridge {
  const configuredDependencies = { ...defaultDependencies, ...options.dependencies };
  const dependencies: AitHostDependencies = {
    ...configuredDependencies,
    identityProvider: createAitSessionIdentityProvider(configuredDependencies.identityProvider),
  };
  const appName = normalizeAppName(options.appName ?? 'mpgd-kit');
  const adGroupIds = normalizeAdGroupIds(options.adGroupIds);
  const adPlacementTypes = normalizeAdPlacementTypes(options.adPlacementTypes);
  const promotionRewards = normalizePromotionRewards(options.promotionRewards);
  const authorizePromotionGrant = options.authorizePromotionGrant;
  const resolvePendingPromotionGrant = options.resolvePendingPromotionGrant;
  const notificationTemplateCodes = normalizeNotificationTemplateCodes(
    options.notificationTemplateCodes,
  );
  const iapProducts = normalizeIapProducts(options.iapProducts);
  const iapProductGrantTimeoutMs = normalizeIapProductGrantTimeout(
    options.iapProductGrantTimeoutMs,
  );
  const promotionGrantsInFlight = new Map<string, Promise<PromotionRewardResult>>();
  const iapPurchasesInFlight = new Map<string, Promise<PurchaseResult>>();
  /**
   * One purchase may be between its pending-order check and a terminal
   * checkout result at a time. While it is, neither another purchase nor a
   * restore may reconcile provider orders, because the active checkout's own
   * grant callback may be verifying and acknowledging a just-paid order.
   */
  let iapCheckoutInProgress = false;
  let completedIapAttemptRetention = Promise.resolve();
  const notificationSubscriptions = new Set<NotificationTopic>();
  const loadedAdGroupIds = new Set<string>();
  const loadingAdGroups = new Map<string, Promise<void>>();
  const activeBannerAttachments = new Map<string, { readonly destroy: () => void }>();
  const bannerMountOwners = new Map<string, symbol>();
  const pendingBannerMountSettlements = new Map<
    string,
    { readonly mountOwner: symbol; readonly settleUnavailable: () => void }
  >();
  let bannerInitialization: Promise<boolean> | undefined;
  let warnedUnsupportedAdPreload = false;
  const adTimeoutMs = normalizeTimeout(options.adTimeoutMs);
  const adLoadQueueTimeoutMs = normalizeLoadQueueTimeout(options.adLoadQueueTimeoutMs);
  const adDisplayStartTimeoutMs = normalizeDisplayStartTimeout(options.adDisplayStartTimeoutMs);
  const adMaximumDisplayMs = normalizeMaximumDisplayTimeout(options.adMaximumDisplayMs);
  const bannerRenderTimeoutMs = normalizeBannerRenderTimeout(options.bannerRenderTimeoutMs);
  const bannerAppearance = {
    theme: options.bannerAppearance?.theme ?? 'dark',
    tone: options.bannerAppearance?.tone ?? 'blackAndWhite',
    variant: options.bannerAppearance?.variant ?? 'expanded',
  } as const;
  const adLoadCoordinator = createAdLoadCoordinator(
    dependencies.loadFullScreenAd,
    adLoadQueueTimeoutMs,
  );
  const nativeAds = createAitAdProvider({
    dependencies,
    groups: adGroupIds,
    types: adPlacementTypes,
    isSupported: () => areFullScreenAdsSupported(dependencies),
    prepare: (group) =>
      preloadAdGroup(
        dependencies,
        group,
        loadedAdGroupIds,
        loadingAdGroups,
        adLoadCoordinator,
        adTimeoutMs,
      ),
    consume: (group) => consumeLoadedAd(group, loadedAdGroupIds),
    requestTimeoutMs: adTimeoutMs,
    startTimeoutMs: adDisplayStartTimeoutMs,
    displayTimeoutMs: adMaximumDisplayMs,
    onLegacyPhase: (active) => dispatchAitLifecycleEvent(active ? 'pause' : 'resume'),
  });
  const legacyAds = toAdAdapter({ ...nativeAds, show: nativeAds.showLegacy });

  const enqueueCompletedIapAttemptRetention = (
    storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
    storageKey: string,
  ): Promise<void> => {
    const scheduled = completedIapAttemptRetention.then(async () => {
      await retainCompletedAitIapPurchaseAttempt(storage, storageKey, iapProductGrantTimeoutMs);
    });
    const next = scheduled.then(
      () => undefined,
      () => undefined,
    );
    void next;
    void (completedIapAttemptRetention = next);
    return next;
  };

  let pendingOrderReconciliation: Promise<AitIapPendingOrderReconciliation> | undefined;
  /**
   * Restore and pre-checkout recovery share one in-flight pass so a startup
   * restore and an immediate purchase never verify or acknowledge the same
   * provider order twice. A caller that joins an in-flight pass still keeps
   * its own deadline.
   */
  const reconcilePendingIapOrders = async (
    verifier: AitIapProductGrantVerifier,
    timeoutMs: number,
  ): Promise<AitIapPendingOrderReconciliation> => {
    const current = pendingOrderReconciliation;
    if (current !== undefined) {
      const joined = await callAitIapNative(() => current, timeoutMs);
      return joined.status === 'ok'
        ? joined.value
        : {
            status: 'unavailable',
            diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
          };
    }
    const next = reconcileAitIapPendingOrders({
      dependencies,
      products: iapProducts,
      verifier,
      retainCompletedAttempt: enqueueCompletedIapAttemptRetention,
      timeoutMs,
    });
    pendingOrderReconciliation = next;
    try {
      return await next;
    } finally {
      if (pendingOrderReconciliation === next) {
        pendingOrderReconciliation = undefined;
      }
    }
  };

  return {
    advertising: {
      id: nativeAds.id,
      protocol: nativeAds.protocol,
      protocolVersion: nativeAds.protocolVersion,
      rewardSignal: nativeAds.rewardSignal,
      subscribe: (listener) => nativeAds.subscribe(listener),
    },
    async request(input) {
      try {
        return await handleRequest(parseBridgeRequest(input));
      } catch (error) {
        return createBridgeError(
          readBridgeRequestId(input),
          'AIT_BRIDGE_REQUEST_FAILED',
          errorMessage(error),
          true,
        );
      }
    },
  };

  async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
    switch (request.method) {
      case 'runtime.getCapabilities': {
        const adsSupported = areFullScreenAdsSupported(dependencies);
        const rewardedAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'rewarded');
        const interstitialAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'interstitial');
        const bannerAds = areBannerAdsSupported(dependencies)
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'banner');
        const nativeIap = isAitIapSupported({
          dependencies,
          products: iapProducts,
          prepare: options.prepareIap,
          verifier: options.verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          timeoutMs: iapProductGrantTimeoutMs,
        });

        return ok(request, {
          nativeIap,
          nativeAds: rewardedAds || interstitialAds || bannerAds,
          bannerAds,
          rewardedAds,
          interstitialAds,
          nativeLeaderboard: isGameCenterSupported(dependencies),
          remoteLeaderboard: false,
          achievements: false,
          cloudSave: false,
          socialShare: true,
          haptics: false,
          localizedContent: true,
        });
      }

      case 'identity.getPlayer': {
        const player = await resolveAitIdentity(dependencies.identityProvider);
        return player === null
          ? createBridgeError(
              request.id,
              'AIT_IDENTITY_UNAVAILABLE',
              'AIT user identity is unavailable.',
            )
          : ok(request, player);
      }

      case 'identity.getSession': {
        const player = await resolveAitIdentity(dependencies.identityProvider);
        return ok(
          request,
          player === null
            ? { identityLevel: 'guest', trustLevel: 'local' }
            : {
                identityLevel: 'platform-anonymous',
                playerId: player.playerId,
                trustLevel: 'platform-asserted',
              },
        );
      }

      case 'identity.requestUpgrade':
        return ok(request, { status: 'unavailable', reloadExpected: false });

      case 'presentation.getLaunchIntent':
        return ok(request, getLaunchIntent());

      case 'presentation.requestGameSurface':
        return ok(request, 'already-fullscreen');

      case 'share.share':
        return ok(request, await shareIntent(request.payload, {
          appName,
          getTossShareLink: dependencies.getTossShareLink,
          share: dependencies.share,
        }));

      case 'share.readInboundShare':
        return ok(request, readInboundShare());

      case 'notifications.getStatus':
        return ok(
          request,
          getNotificationStatus(
            readNotificationTopic(request.payload),
            notificationTemplateCodes,
            notificationSubscriptions,
            dependencies,
          ),
        );

      case 'notifications.requestSubscription': {
        const topic = readNotificationTopic(request.payload);
        const templateCode = notificationTemplateCodes.get(topic);
        if (
          templateCode === undefined
          || !isAitNativeMethodSupported(dependencies.requestNotificationAgreement)
        ) {
          return ok(request, 'unavailable');
        }

        const result = await requestAitNotificationAgreement(
          dependencies.requestNotificationAgreement,
          templateCode,
        );
        if (result === 'subscribed') {
          notificationSubscriptions.add(topic);
        }
        return ok(request, result);
      }

      case 'promotions.getAvailability': {
        const campaignId = readCampaignId(request.payload);
        const availability = getPromotionAvailability(
          campaignId,
          promotionRewards,
          authorizePromotionGrant,
          dependencies,
        );
        return ok(request, availability);
      }

      case 'promotions.grantReward': {
        const campaignId = readCampaignId(request.payload);
        const reward = promotionRewards.get(campaignId);
        const idempotencyKey = readRequiredIdempotencyKey(request.payload);
        if (
          reward === undefined
          || !isPromotionSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable' });
        }

        const persisted = await resolvePersistedPromotionGrant({
          campaignId,
          idempotencyKey,
          storage: dependencies.storage,
          ...(resolvePendingPromotionGrant === undefined
            ? {}
            : { resolver: resolvePendingPromotionGrant }),
        });
        if (persisted.result !== undefined) {
          return ok(request, persisted.result);
        }

        const existing = promotionGrantsInFlight.get(idempotencyKey);
        if (existing !== undefined) {
          return ok(request, await existing);
        }

        const pending = authorizeAndGrantAitPromotionReward({
          campaignId,
          idempotencyKey,
          reward,
          dependencies,
          ...(authorizePromotionGrant === undefined
            ? {}
            : { authorizer: authorizePromotionGrant }),
        });
        promotionGrantsInFlight.set(idempotencyKey, pending);
        try {
          return ok(request, await pending);
        } finally {
          if (promotionGrantsInFlight.get(idempotencyKey) === pending) {
            promotionGrantsInFlight.delete(idempotencyKey);
          }
        }
      }

      // IAP is opt-in and server-authoritative. Never return demo grants.
      case 'commerce.getProducts': {
        const catalog = await listAitIapProducts({
          dependencies,
          products: iapProducts,
          prepare: options.prepareIap,
          verifier: options.verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        return catalog.status === 'ok'
          ? ok(request, catalog.products)
          : createAitIapDiagnosticError(
              request.id,
              catalog.diagnostic,
              'Apps in Toss IAP catalog is unavailable',
            );
      }

      case 'commerce.purchase': {
        const purchase = readCommercePurchase(request.payload);
        const product = iapProducts.byProductId.get(purchase.productId);
        const prepareIap = options.prepareIap;
        const verifyIapProductGrant = options.verifyIapProductGrant;
        const iapSupported = isAitIapSupported({
          dependencies,
          products: iapProducts,
          prepare: prepareIap,
          verifier: verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        if (
          !iapSupported
          || prepareIap === undefined
          || verifyIapProductGrant === undefined
        ) {
          return ok(
            request,
            failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false)),
          );
        }
        if (product === undefined) {
          return ok(
            request,
            failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.productNotConfigured, false)),
          );
        }

        const persisted = await resolvePersistedAitIapPurchaseAttempt({
          dependencies,
          storage: dependencies.storage,
          product,
          idempotencyKey: purchase.idempotencyKey,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        if (persisted !== undefined) {
          return ok(request, persisted);
        }

        const productUnavailable = await checkAitOneTimeIapProduct(
          dependencies,
          product,
          iapProductGrantTimeoutMs,
        );
        if (productUnavailable !== undefined) {
          return ok(request, failedPurchase(productUnavailable));
        }

        const purchaseRequestKey = createAitIapPurchaseRequestKey(
          purchase.productId,
          purchase.idempotencyKey,
        );
        const existing = iapPurchasesInFlight.get(purchaseRequestKey);
        if (existing !== undefined) {
          return ok(request, await existing);
        }
        // Check and claim synchronously: another key must not pass the
        // pending-order check while the active checkout can still produce an
        // order that the provider list does not show yet, or that its own
        // grant callback is acknowledging.
        if (iapCheckoutInProgress) {
          return ok(
            request,
            failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true)),
          );
        }
        iapCheckoutInProgress = true;
        const pending = purchaseAitIapProduct({
          dependencies,
          product,
          idempotencyKey: purchase.idempotencyKey,
          prepare: prepareIap,
          verifier: verifyIapProductGrant,
          retainCompletedAttempt: enqueueCompletedIapAttemptRetention,
          reconcilePendingOrders: (timeoutMs) =>
            reconcilePendingIapOrders(verifyIapProductGrant, timeoutMs),
          timeoutMs: iapProductGrantTimeoutMs,
        });
        iapPurchasesInFlight.set(purchaseRequestKey, pending);
        try {
          return ok(request, await pending);
        } finally {
          iapCheckoutInProgress = false;
          if (iapPurchasesInFlight.get(purchaseRequestKey) === pending) {
            iapPurchasesInFlight.delete(purchaseRequestKey);
          }
        }
      }

      case 'commerce.restore': {
        if (iapCheckoutInProgress) {
          return createAitIapDiagnosticError(
            request.id,
            aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true),
            'Apps in Toss purchase restore did not complete',
          );
        }
        const restored = await restoreAitIapProducts({
          dependencies,
          products: iapProducts,
          prepare: options.prepareIap,
          verifier: options.verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          reconcilePendingOrders: reconcilePendingIapOrders,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        return restored.status === 'ok'
          ? ok(request, restored.result)
          : createAitIapDiagnosticError(
              request.id,
              restored.diagnostic,
              'Apps in Toss purchase restore did not complete',
            );
      }

      case 'commerce.getEntitlements':
        return ok(request, await readAitIapEntitlements(
          options.readIapEntitlements,
          iapProductGrantTimeoutMs,
        ));

      case 'ads.preload': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);
        const placementType = adPlacementTypes.get(placementId);

        if (adGroupId === undefined || placementType === undefined) {
          return createBridgeError(
            request.id,
            'AIT_AD_UNAVAILABLE',
            `AIT ad placement is unavailable: ${placementId}`,
          );
        }

        if (placementType === 'banner') {
          return ok(request, {});
        }

        if (!isAitNativeMethodSupported(dependencies.loadFullScreenAd)) {
          if (!warnedUnsupportedAdPreload) {
            warnedUnsupportedAdPreload = true;
            console.warn(
              'AIT full-screen ads are not supported; configured preload is a no-op.',
              placementId,
            );
          }
          return ok(request, {});
        }

        await preloadAdGroupWithDiagnostics(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          adTimeoutMs,
          placementType,
        );
        return ok(request, {});
      }

      case 'ads.getAvailability':
      case 'ads.prepare': {
        const payload = readPayloadRecord(request.payload);
        const query = assertAdShowInput({
          ...payload,
          invocationId: 'host-query',
          idempotencyKey: 'host-query',
        });
        return ok(
          request,
          request.method === 'ads.prepare'
            ? await nativeAds.preload(query)
            : await nativeAds.getAvailability(query),
        );
      }
      case 'ads.show':
        return ok(request, await nativeAds.show(assertAdShowInput(request.payload)));
      case 'ads.showRewarded':
        return ok(
          request,
          await legacyAds.showRewarded({ placementId: readPlacementId(request.payload), idempotencyKey: readRewardedAdCorrelationId(request.payload, request.id) }),
        );
      case 'ads.showInterstitial':
        return ok(
          request,
          await legacyAds.showInterstitial?.({ placementId: readPlacementId(request.payload) }),
        );

      case 'ads.mountBanner': {
        const placementId = readPlacementId(request.payload);
        const surfaceId = readBannerSurfaceId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'banner'
          || !areBannerAdsSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable' });
        }

        const target = globalThis.document?.getElementById(surfaceId);
        if (target === null || target === undefined) {
          return ok(request, { status: 'failed' });
        }

        pendingBannerMountSettlements.get(surfaceId)?.settleUnavailable();
        const mountOwner = Symbol(surfaceId);
        bannerMountOwners.set(surfaceId, mountOwner);
        activeBannerAttachments.get(surfaceId)?.destroy();
        activeBannerAttachments.delete(surfaceId);
        const initializeBanner = bannerInitialization
          ?? initializeAitBannerAds(dependencies, bannerRenderTimeoutMs);
        void (bannerInitialization = initializeBanner);
        if (!await initializeBanner) {
          bannerInitialization = undefined;
          if (bannerMountOwners.get(surfaceId) === mountOwner) {
            bannerMountOwners.delete(surfaceId);
          }
          return ok(request, { status: 'failed' });
        }

        if (bannerMountOwners.get(surfaceId) !== mountOwner) {
          return ok(request, { status: 'unavailable' });
        }
        activeBannerAttachments.get(surfaceId)?.destroy();
        activeBannerAttachments.delete(surfaceId);

        const result = await attachAitBanner({
          dependencies,
          adGroupId,
          surfaceId,
          target,
          timeoutMs: bannerRenderTimeoutMs,
          appearance: bannerAppearance,
          activeAttachments: activeBannerAttachments,
          mountOwner,
          mountOwners: bannerMountOwners,
          pendingSettlements: pendingBannerMountSettlements,
        });
        return ok(request, result);
      }

      case 'ads.unmountBanner': {
        const surfaceId = readBannerSurfaceId(request.payload);
        pendingBannerMountSettlements.get(surfaceId)?.settleUnavailable();
        bannerMountOwners.delete(surfaceId);
        activeBannerAttachments.get(surfaceId)?.destroy();
        activeBannerAttachments.delete(surfaceId);
        return ok(request, {});
      }

      case 'leaderboard.submitScore': {
        if (!isGameCenterSupported(dependencies)) {
          return ok(request, { submitted: false });
        }

        const score = readFiniteScore(request.payload);
        const result = await dependencies.submitGameCenterLeaderBoardScore({
          score: String(score),
        });
        return ok(request, { submitted: result?.statusCode === 'SUCCESS' });
      }

      case 'leaderboard.open': {
        if (!isGameCenterSupported(dependencies)) {
          return ok(request, {});
        }

        dispatchAitLifecycleEvent('pause');
        try {
          await dependencies.openGameCenterLeaderboard();
        } finally {
          dispatchAitLifecycleEvent('resume');
        }
        return ok(request, {});
      }

      case 'storage.load': {
        const key = readStorageKey(request.payload);
        const serialized = await dependencies.storage.getItem(key);
        return ok(request, decodeStoredValue(serialized));
      }

      case 'storage.save': {
        const key = readStorageKey(request.payload);
        const value = readPayloadRecord(request.payload).value;
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          throw new TypeError('Storage values must be JSON-serializable.');
        }

        await dependencies.storage.setItem(key, serialized);
        return ok(request, {});
      }

      default:
        return createBridgeError(
          request.id,
          'UNSUPPORTED_METHOD',
          `Unsupported AIT bridge method: ${request.method}`,
        );
    }
  }
}

interface AitShareDependencies {
  readonly appName: string;
  readonly getTossShareLink: typeof getTossShareLink;
  readonly share: typeof share;
}

type AitNotificationAgreement = AitHostDependencies['requestNotificationAgreement'];

function getNotificationStatus(
  topic: NotificationTopic,
  templateCodes: ReadonlyMap<NotificationTopic, string>,
  subscriptions: ReadonlySet<NotificationTopic>,
  dependencies: AitHostDependencies,
): 'subscribed' | 'not-subscribed' | 'configuration-required' | 'unsupported' {
  if (!templateCodes.has(topic)) {
    return 'configuration-required';
  }
  if (!isAitNativeMethodSupported(dependencies.requestNotificationAgreement)) {
    return 'unsupported';
  }
  return subscriptions.has(topic) ? 'subscribed' : 'not-subscribed';
}

function requestAitNotificationAgreement(
  requestAgreement: AitNotificationAgreement,
  templateCode: string,
): Promise<'subscribed' | 'rejected' | 'unavailable'> {
  return new Promise((resolve) => {
    let settled = false;
    let cleanup = (): void => {};
    const finish = (result: 'subscribed' | 'rejected' | 'unavailable'): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      cleanup();
      resolve(result);
    };
    const timer = globalThis.setTimeout(
      () => finish('unavailable'),
      defaultNotificationAgreementTimeoutMs,
    );

    try {
      const unregister = requestAgreement({
        options: { templateCode },
        onEvent: ({ type }) => {
          finish(type === 'agreementRejected' ? 'rejected' : 'subscribed');
        },
        onError: () => finish('unavailable'),
      });
      cleanup = unregister;
      if (settled) {
        cleanup();
      }
    } catch {
      finish('unavailable');
    }
  });
}

function getPromotionAvailability(
  campaignId: string,
  rewards: ReadonlyMap<string, AitPromotionRewardConfig>,
  authorizer: AitPromotionGrantAuthorizer | undefined,
  dependencies: AitHostDependencies,
): 'available' | 'configuration-required' | 'unsupported' {
  if (!rewards.has(campaignId) || authorizer === undefined) {
    return 'configuration-required';
  }
  return isPromotionSupported(dependencies) ? 'available' : 'unsupported';
}

async function authorizeAndGrantAitPromotionReward(input: {
  readonly campaignId: string;
  readonly idempotencyKey: string;
  readonly reward: AitPromotionRewardConfig;
  readonly dependencies: AitHostDependencies;
  readonly authorizer?: AitPromotionGrantAuthorizer;
}): Promise<PromotionRewardResult> {
  if (input.authorizer === undefined) {
    return { status: 'unavailable' };
  }
  let authorization: AitPromotionGrantAuthorization;
  try {
    authorization = await input.authorizer({
      campaignId: input.campaignId,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    console.warn(
      'AIT promotion grant authorization failed; keeping the claim pending.',
      input.campaignId,
      error,
    );
    return { status: 'pending' };
  }
  if (authorization.status !== 'authorized') {
    return {
      status: authorization.status === 'pending' ? 'pending' : 'unavailable',
    };
  }
  return grantAitPromotionReward(input.dependencies, input.reward, input.idempotencyKey);
}

function isPromotionSupported(dependencies: AitHostDependencies): boolean {
  return isCapabilitySupported(() =>
    dependencies.isMinVersionSupported({
      android: minimumPromotionTossAppVersion,
      ios: minimumPromotionTossAppVersion,
    }),
  );
}

async function grantAitPromotionReward(
  dependencies: AitHostDependencies,
  reward: AitPromotionRewardConfig,
  idempotencyKey: string,
): Promise<PromotionRewardResult> {
  const storageKey = promotionGrantStorageKey(idempotencyKey);
  await dependencies.storage.setItem(
    storageKey,
    JSON.stringify({
      status: 'pending',
      pendingSince: new Date().toISOString(),
    }),
  );

  try {
    const response: unknown = await dependencies.grantPromotionReward({
      params: {
        promotionCode: reward.promotionCode,
        amount: reward.amount,
      },
    });
    if (isExplicitPromotionFailure(response)) {
      return clearFailedPromotionGrant(dependencies.storage, storageKey);
    }
    if (
      !isRecord(response)
      || typeof response.key !== 'string'
      || response.key.trim().length === 0
    ) {
      // An undocumented shape is ambiguous after native dispatch. Preserve the
      // marker so a backend resolver can determine whether a grant happened.
      return { status: 'pending' };
    }

    const result = { status: 'granted', receiptKey: response.key } as const;
    try {
      await dependencies.storage.setItem(storageKey, JSON.stringify(result));
    } catch (error) {
      console.warn(
        'AIT native promotion receipt could not be cached; keeping it terminal.',
        reward.promotionCode,
        error,
      );
    }
    return result;
  } catch {
    // Keep the pending marker. A provider error after dispatch is ambiguous and
    // retrying the same promotion blindly can double-grant Toss points.
    return { status: 'pending' };
  }
}

function isExplicitPromotionFailure(value: unknown): boolean {
  if (value === 'ERROR') {
    return true;
  }
  return isRecord(value)
    && typeof value.errorCode === 'string'
    && value.errorCode.trim().length > 0
    && typeof value.message === 'string';
}

async function clearFailedPromotionGrant(
  storage: Pick<typeof Storage, 'removeItem'>,
  storageKey: string,
): Promise<PromotionRewardResult> {
  try {
    await storage.removeItem(storageKey);
    return { status: 'failed' };
  } catch (error) {
    console.warn(
      'AIT failed promotion marker could not be cleared; keeping the claim pending.',
      storageKey,
      error,
    );
    return { status: 'pending' };
  }
}

interface ResolvePersistedPromotionGrantInput {
  readonly campaignId: string;
  readonly idempotencyKey: string;
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly resolver?: AitPendingPromotionGrantResolver;
}

async function resolvePersistedPromotionGrant(
  input: ResolvePersistedPromotionGrantInput,
): Promise<{ readonly result?: PromotionRewardResult }> {
  const storageKey = promotionGrantStorageKey(input.idempotencyKey);
  const serialized = await input.storage.getItem(storageKey);
  if (serialized === null) {
    return {};
  }

  let state: unknown;
  try {
    state = JSON.parse(serialized);
  } catch (error) {
    console.warn(
      'AIT persisted promotion state is unreadable; keeping the claim pending.',
      input.campaignId,
      error,
    );
    return { result: { status: 'pending' } };
  }
  if (!isRecord(state)) {
    console.warn(
      'AIT persisted promotion state is malformed; keeping the claim pending.',
      input.campaignId,
    );
    return { result: { status: 'pending' } };
  }
  try {
    if (
      state.status === 'granted'
      && typeof state.receiptKey === 'string'
      && state.receiptKey.trim().length > 0
    ) {
      return { result: { status: 'granted', receiptKey: state.receiptKey } };
    }
    if (state.status === 'pending') {
      const pendingSince = normalizePendingSince(state.pendingSince);
      if (pendingSince === undefined) {
        return { result: { status: 'pending' } };
      }
      if (input.resolver === undefined) {
        return { result: { status: 'pending' } };
      }

      let resolution: AitPendingPromotionGrantResolution;
      try {
        resolution = await input.resolver({
          campaignId: input.campaignId,
          idempotencyKey: input.idempotencyKey,
          pendingSince,
        });
      } catch (error) {
        console.warn(
          'AIT pending promotion grant resolver failed; keeping the claim pending.',
          input.campaignId,
          error,
        );
        return { result: { status: 'pending' } };
      }
      if (resolution.status === 'pending') {
        return { result: { status: 'pending' } };
      }
      if (resolution.status === 'granted') {
        if (
          typeof resolution.receiptKey !== 'string'
          || resolution.receiptKey.trim().length === 0
        ) {
          return { result: { status: 'pending' } };
        }
        const result = { status: 'granted', receiptKey: resolution.receiptKey } as const;
        try {
          await input.storage.setItem(storageKey, JSON.stringify(result));
        } catch (error) {
          console.warn(
            'AIT reconciled promotion receipt could not be cached; keeping it terminal.',
            input.campaignId,
            error,
          );
        }
        return { result };
      }

      return removeInvalidPersistedPromotionGrant(input.storage, storageKey);
    }
    console.warn(
      'AIT persisted promotion state has an unknown status; keeping the claim pending.',
      input.campaignId,
    );
    return { result: { status: 'pending' } };
  } catch (error) {
    console.warn(
      'AIT persisted promotion state could not be reconciled; keeping the claim pending.',
      input.campaignId,
      error,
    );
    return { result: { status: 'pending' } };
  }
}

async function removeInvalidPersistedPromotionGrant(
  storage: Pick<typeof Storage, 'removeItem'>,
  storageKey: string,
): Promise<{ readonly result?: PromotionRewardResult }> {
  try {
    await storage.removeItem(storageKey);
    return {};
  } catch {
    return { result: { status: 'pending' } };
  }
}

function promotionGrantStorageKey(idempotencyKey: string): string {
  return `${promotionGrantStoragePrefix}${encodeURIComponent(idempotencyKey)}`;
}

function normalizePendingSince(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export async function shareIntent(
  payload: unknown,
  dependencies: AitShareDependencies,
): Promise<ShareResult> {
  const intent = readPayloadRecord(payload);

  if (typeof intent.text !== 'string' || typeof intent.deepLink !== 'string') {
    return { status: 'unavailable' };
  }

  const deepLink = toAitDeepLink(intent.deepLink, dependencies.appName);

  if (deepLink === undefined) {
    return { status: 'unavailable' };
  }

  try {
    const tossLink = await dependencies.getTossShareLink(
      deepLink,
      typeof intent.previewImageUrl === 'string' && intent.previewImageUrl.startsWith('https://')
        ? intent.previewImageUrl
        : undefined,
    );
    await dependencies.share({ message: `${intent.text}\n${tossLink}` });
    return { status: 'shared', completion: 'presented' };
  } catch (error) {
    return isAbortError(error) ? { status: 'cancelled' } : { status: 'unavailable' };
  }
}

async function resolveAitIdentity(
  provider: AitIdentityProvider,
): Promise<{ readonly playerId: string } | null> {
  let result: unknown;

  try {
    result = await provider();
  } catch {
    return null;
  }

  if (!isRecord(result) || result.type !== 'HASH') {
    return null;
  }

  const hash = typeof result.hash === 'string' ? result.hash.trim() : '';
  return hash.length === 0 ? null : { playerId: hash };
}

async function preloadAdGroup(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  timeoutMs: number,
): Promise<void> {
  if (loaded.has(adGroupId)) {
    return;
  }

  const existing = loading.get(adGroupId);
  if (existing !== undefined) {
    await existing;
    return;
  }

  const startNativeLoad = (): Promise<void> => new Promise<void>((resolve, reject) => {
    let cleanup = (): void => {};
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      cleanup();
      if (error === undefined) {
        loaded.add(adGroupId);
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = globalThis.setTimeout(
      () => finish(new Error(`Timed out loading AIT ad group ${adGroupId}.`)),
      timeoutMs,
    );

    try {
      const unregister = dependencies.loadFullScreenAd({
        options: { adGroupId },
        onEvent: (event) => {
          if (event.type === 'loaded') {
            finish();
          }
        },
        onError: finish,
      });
      cleanup = unregister;
      if (settled) {
        cleanup();
      }
    } catch (error) {
      finish(error);
    }
  });
  const pending = runSerializedAdLoad(coordinator, adGroupId, startNativeLoad);
  loading.set(adGroupId, pending);

  try {
    await pending;
  } finally {
    // Clean up this load attempt. The identity check also protects a future retry
    // implementation from deleting a replacement promise.
    if (loading.get(adGroupId) === pending) {
      loading.delete(adGroupId);
    }
  }
}

const nativeAdLoadScopes = new WeakMap<object, { active: AitAdLoadCoordinator['active'] }>();
function createAdLoadCoordinator(sdk: object, waitTimeoutMs: number): AitAdLoadCoordinator {
  let shared = nativeAdLoadScopes.get(sdk);
  if (shared === undefined) {
    shared = { active: undefined };
    nativeAdLoadScopes.set(sdk, shared);
  }
  const owned = shared;
  return {
    get active() {
      return owned.active;
    },
    set active(value) {
      owned.active = value;
    },
    waitTimeoutMs,
  };
}

interface AitAdLoadCoordinator {
  active: { readonly promise: Promise<void> } | undefined;
  readonly waitTimeoutMs: number;
}

async function runSerializedAdLoad(
  coordinator: AitAdLoadCoordinator,
  adGroupId: string,
  startNativeLoad: () => Promise<void>,
): Promise<void> {
  const waitDeadline = Date.now() + coordinator.waitTimeoutMs;

  while (coordinator.active !== undefined) {
    const remainingWaitMs = waitDeadline - Date.now();
    if (remainingWaitMs <= 0) {
      throw new Error(
        `Timed out waiting for the AIT ad load slot: ${adGroupId} (queue deadline exceeded).`,
      );
    }
    await waitForAdLoadSettlement(coordinator.active.promise, remainingWaitMs, adGroupId);
  }

  // Some deployed Toss runtimes lose callbacks when different groups begin
  // loading together. Acquire the process-wide native boundary synchronously;
  // the actual native load still receives its complete timeout budget.
  const pending = startNativeLoad();
  coordinator.active = { promise: pending };
  try {
    await pending;
  } finally {
    if (coordinator.active?.promise === pending) {
      coordinator.active = undefined;
    }
  }
}

function waitForAdLoadSettlement(
  active: Promise<void>,
  timeoutMs: number,
  adGroupId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = globalThis.setTimeout(
      () => finish(new Error(
        `Timed out waiting for the AIT ad load slot: ${adGroupId} (active load wait expired).`,
      )),
      timeoutMs,
    );
    void active.then(
      () => finish(),
      () => finish(),
    );
  });
}

async function preloadAdGroupWithDiagnostics(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
): Promise<boolean> {
  // The first caller enters preloadAdGroup synchronously and publishes its promise
  // before yielding. Remember that ownership so concurrent waiters do not emit the
  // same diagnostic for one native load failure.
  const ownsLoadAttempt = !loaded.has(adGroupId) && !loading.has(adGroupId);

  try {
    await preloadAdGroup(dependencies, adGroupId, loaded, loading, coordinator, timeoutMs);
    return true;
  } catch (error) {
    // Preloading is opportunistic. A later show request may retry, so keep
    // gameplay available while retaining one diagnostic per native attempt.
    if (ownsLoadAttempt) {
      console.warn(`Failed to preload ${placementType} AIT ad group.`, adGroupId, error);
    }
    return false;
  }
}

/**
 * Launch and inbound-share parameters arrive from untrusted deep links. Bound
 * each forwarded value and the nested `queryParams` JSON so a hostile link
 * cannot push oversized or unbounded data into the game.
 */
const maximumLaunchParamLength = 256;
const maximumNestedQueryParamsJsonLength = 4_096;
const maximumNestedQueryParamCount = 32;

function getLaunchIntent(): LaunchIntent {
  const params = inboundSearchParams();
  const challengeToken = boundedParam(params.get('challengeToken'));
  const puzzleId = boundedParam(params.get('puzzleId'));
  const requestedEntry = boundedParam(params.get('entry'));
  let entry: LaunchEntry;

  if (requestedEntry !== undefined && launchEntries.has(requestedEntry as LaunchEntry)) {
    entry = requestedEntry as LaunchEntry;
  } else if (challengeToken === undefined) {
    entry = 'home';
  } else {
    entry = 'friend-challenge';
  }

  return {
    entry,
    ...(puzzleId === undefined ? {} : { puzzleId }),
    ...(challengeToken === undefined ? {} : { referralToken: challengeToken }),
  };
}

function readInboundShare(): { readonly puzzleId?: string; readonly challengeToken?: string } | null {
  const params = inboundSearchParams();
  const puzzleId = boundedParam(params.get('puzzleId'));
  const challengeToken = boundedParam(params.get('challengeToken'));
  return puzzleId === undefined && challengeToken === undefined
    ? null
    : {
        ...(puzzleId === undefined ? {} : { puzzleId }),
        ...(challengeToken === undefined ? {} : { challengeToken }),
      };
}

function inboundSearchParams(): URLSearchParams {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const nested = params.get('queryParams');

  if (nested !== null && nested.length <= maximumNestedQueryParamsJsonLength) {
    try {
      const parsed = JSON.parse(nested) as unknown;
      if (isRecord(parsed)) {
        let merged = 0;
        for (const [key, value] of Object.entries(parsed)) {
          if (merged >= maximumNestedQueryParamCount) {
            break;
          }
          // Direct search params win; nested values only fill missing keys and
          // must be bounded strings. Keys are counted whether or not they merge
          // so an attacker cannot pad past the cap with ignored entries.
          merged += 1;
          if (
            typeof value === 'string'
            && key.length > 0
            && key.length <= maximumLaunchParamLength
            && value.length <= maximumLaunchParamLength
            && !params.has(key)
          ) {
            params.set(key, value);
          }
        }
      }
    } catch {
      // Deep-link payloads are untrusted; malformed nested query data is ignored.
    }
  }

  return params;
}

function toAitDeepLink(input: string, appName: string): string | undefined {
  if (input.startsWith('//')) {
    return undefined;
  }

  if (input.startsWith('/')) {
    const baseUrl = new URL('https://mpgd.invalid');
    const parsed = new URL(input, baseUrl);
    return parsed.origin === baseUrl.origin
      ? `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'intoss:') {
      return parsed.hostname === appName ? input : undefined;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? `intoss://${appName}${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined;
  } catch {
    return undefined;
  }
}

function isGameCenterSupported(dependencies: AitHostDependencies): boolean {
  return isCapabilitySupported(() =>
    dependencies.isMinVersionSupported({
      android: '5.221.0',
      ios: '5.221.0',
    }),
  );
}

interface NormalizedAitIapProduct {
  readonly productId: LogicalProductId;
  readonly sku: string;
  readonly currencyCode: string;
}

interface NormalizedAitIapProducts {
  readonly byProductId: ReadonlyMap<LogicalProductId, NormalizedAitIapProduct>;
  readonly bySku: ReadonlyMap<string, NormalizedAitIapProduct>;
}

interface AitIapSupportInput {
  readonly dependencies: AitHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly prepare: AitIapPreparer | undefined;
  readonly verifier: AitIapProductGrantVerifier | undefined;
  readonly entitlementReader: AitIapEntitlementReader | undefined;
  readonly timeoutMs: number;
}

interface AitIapPurchaseInput {
  readonly dependencies: AitHostDependencies;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly prepare: AitIapPreparer;
  readonly verifier: AitIapProductGrantVerifier;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  /** Checks provider orders for configured SKUs before a new checkout can charge again. */
  readonly reconcilePendingOrders: (
    timeoutMs: number,
  ) => Promise<AitIapPendingOrderReconciliation>;
  readonly timeoutMs: number;
}

type AitIapCompletedAttemptRetention = (
  storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
  storageKey: string,
) => Promise<void>;

interface AitIapRestoreInput extends AitIapSupportInput {
  readonly reconcilePendingOrders: (
    verifier: AitIapProductGrantVerifier,
    timeoutMs: number,
  ) => Promise<AitIapPendingOrderReconciliation>;
  readonly timeoutMs: number;
}

type AitIapGrantSource = 'process-product-grant' | 'pending-order-restore';

interface AitIapUnresolvedOrder {
  readonly orderId: string;
  readonly sku: string;
}

type AitIapPendingOrderReconciliation =
  | {
      readonly status: 'unavailable';
      readonly diagnostic: CommerceDiagnostic;
    }
  | {
      readonly status: 'reconciled';
      readonly settledPurchases: readonly PurchaseSettlement[];
      readonly restoredEntitlements: readonly Entitlement[];
      /** Eligible configured orders still awaiting a server grant after this pass. */
      readonly unresolvedOrders: readonly AitIapUnresolvedOrder[];
      /** First per-order reason when an order stayed unresolved. */
      readonly diagnostic?: CommerceDiagnostic;
    };

type AitIapRestoreOutcome =
  | { readonly status: 'ok'; readonly result: PurchaseRestoreResult }
  | { readonly status: 'failed'; readonly diagnostic: CommerceDiagnostic };

type AitIapCatalogOutcome<T> =
  | { readonly status: 'ok'; readonly products: T }
  | { readonly status: 'failed'; readonly diagnostic: CommerceDiagnostic };

type AitIapNativeOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'timeout' }
  | { readonly status: 'error'; readonly providerCode?: string };

interface AitIapPurchaseAttemptStorageInput {
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

interface PersistAitIapServerGrantInput extends AitIapPurchaseAttemptStorageInput {
  readonly orderId: string;
}

const aitIapPurchaseAttemptStatus = {
  pending: 'pending',
  serverGranted: 'server-granted',
  completed: 'completed',
} as const;

type AitIapPurchaseAttemptStatus = typeof aitIapPurchaseAttemptStatus[
  keyof typeof aitIapPurchaseAttemptStatus
];

interface PersistAitIapPurchaseAttemptInput extends AitIapPurchaseAttemptStorageInput {
  readonly status: AitIapPurchaseAttemptStatus;
  readonly orderId?: string;
  /** Recorded on a completed marker so a replay reports the path that granted it. */
  readonly source?: AitIapGrantSource;
}

interface ResolvePersistedAitIapPurchaseAttemptInput extends AitIapPurchaseAttemptStorageInput {
  readonly dependencies: Pick<AitHostDependencies, 'iap'>;
}

interface VerifyAndPersistAitIapProductGrantInput extends PersistAitIapServerGrantInput {
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderIdempotencyKey: string;
  readonly source: AitIapGrantSource;
}

function isAitIapSupported(input: AitIapSupportInput): boolean {
  if (
    input.products.byProductId.size === 0
    || input.prepare === undefined
    || input.verifier === undefined
    || input.entitlementReader === undefined
  ) {
    return false;
  }

  return isAitNativeMethodSupported(input.dependencies.iap.createOneTimePurchaseOrder)
    && isAitNativeMethodSupported(input.dependencies.iap.getProductItemList)
    && isAitNativeMethodSupported(input.dependencies.iap.getPendingOrders)
    && isAitNativeMethodSupported(input.dependencies.iap.completeProductGrant);
}

/**
 * Product metadata is not authoritative, so a catalog that cannot be read is
 * never replaced with stale game-owned prices. Unconfigured or unsupported IAP
 * still lists no products; a configured catalog that fails reports a stable
 * diagnostic code instead of an indistinguishable empty list.
 */
async function listAitIapProducts(
  input: AitIapSupportInput,
): Promise<AitIapCatalogOutcome<readonly ProductInfo[]>> {
  if (!isAitIapSupported(input)) {
    return { status: 'ok', products: [] };
  }

  const catalog = await readAitIapCatalog(input.dependencies, input.timeoutMs);
  if (catalog.status !== 'ok') {
    return catalog;
  }
  const products: ProductInfo[] = [];
  for (const nativeProduct of catalog.products) {
    const configured = input.products.bySku.get(nativeProduct.sku);
    if (configured === undefined) {
      continue;
    }
    const product = toAitIapProductInfo(nativeProduct, configured);
    if (product !== undefined) {
      products.push(product);
    }
  }
  if (products.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.configuredSkusNotVisible, false),
    };
  }
  if (products.length < input.products.byProductId.size) {
    console.warn('AIT IAP catalog is missing configured products.', {
      configuredCount: input.products.byProductId.size,
      visibleCount: products.length,
    });
  }
  return { status: 'ok', products };
}

async function readAitIapCatalog(
  dependencies: Pick<AitHostDependencies, 'iap'>,
  timeoutMs: number,
): Promise<AitIapCatalogOutcome<readonly IapProductListItem[]>> {
  const outcome = await callAitIapNative(() => dependencies.iap.getProductItemList(), timeoutMs);
  if (outcome.status === 'timeout') {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.catalogUnavailable, true),
    };
  }
  if (outcome.status === 'error') {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(
        aitIapDiagnosticCodes.catalogUnavailable,
        true,
        outcome.providerCode,
      ),
    };
  }
  // The SDK resolves without a value when the Toss app is too old.
  const result: unknown = outcome.value;
  if (!isRecord(result)) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unsupportedAppVersion, false),
    };
  }
  const products = Array.isArray(result.products)
    ? (result.products as readonly unknown[]).filter(
        (product): product is IapProductListItem =>
          isRecord(product) && typeof product.sku === 'string',
      )
    : [];
  if (products.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.catalogEmpty, true),
    };
  }
  return { status: 'ok', products };
}

async function readAitIapEntitlements(
  reader: AitIapEntitlementReader | undefined,
  timeoutMs: number,
): Promise<readonly Entitlement[]> {
  return await readAitIapEntitlementsIfAvailable(reader, timeoutMs) ?? [];
}

/** Returns undefined when the game authority could not be read in time. */
async function readAitIapEntitlementsIfAvailable(
  reader: AitIapEntitlementReader | undefined,
  timeoutMs: number,
): Promise<readonly Entitlement[] | undefined> {
  if (reader === undefined || timeoutMs <= 0) {
    return undefined;
  }

  try {
    const entitlements = await waitForAitIapNativeCall(reader, timeoutMs);
    return entitlements === undefined ? undefined : [...entitlements];
  } catch (error) {
    // The game authority owns durable purchase state. A read failure must not
    // turn stale local data into a visible entitlement.
    console.warn(
      'AIT IAP entitlement read failed; reporting no entitlements.',
      errorMessage(error),
    );
    return undefined;
  }
}

/**
 * Return a durable result before consulting the provider catalog. This makes a
 * repeated client idempotency key safe after a reload or after the in-memory
 * coalescing map has been cleared.
 */
async function resolvePersistedAitIapPurchaseAttempt(
  input: ResolvePersistedAitIapPurchaseAttemptInput,
): Promise<PurchaseResult | undefined> {
  const storageUnavailable = aitIapDiagnostic(
    aitIapDiagnosticCodes.attemptStorageUnavailable,
    true,
  );
  const attemptPending = aitIapDiagnostic(aitIapDiagnosticCodes.attemptPending, true);
  const storageKey = aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey);
  let serialized: string | null | undefined;
  try {
    serialized = await waitForAitIapNativeCall(
      () => input.storage.getItem(storageKey),
      input.timeoutMs,
    );
  } catch (error) {
    console.warn(
      'AIT IAP purchase attempt storage read failed; treating the attempt as pending.',
      errorMessage(error),
    );
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (serialized === undefined) {
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (serialized === null) {
    return undefined;
  }

  let state: unknown;
  try {
    state = JSON.parse(serialized);
  } catch (error) {
    console.warn(
      'AIT IAP purchase attempt marker is invalid; treating the attempt as pending.',
      errorMessage(error),
    );
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (
    !isRecord(state)
    || state.productId !== input.product.productId
    || state.idempotencyKey !== input.idempotencyKey
  ) {
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (state.status === aitIapPurchaseAttemptStatus.pending) {
    if (typeof state.orderId === 'string' && isAitIapOrderId(state.orderId)) {
      return pendingPurchase(
        state.orderId,
        aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true),
      );
    }
    const pendingSince = normalizePendingSince(state.pendingSince);
    if (
      pendingSince === undefined
      || !isAitIapPendingAttemptPastRecoveryWindow(pendingSince)
    ) {
      return pendingPurchase(undefined, attemptPending);
    }
    const hasPendingProviderOrder = await hasAitIapPendingOrderForSku(
      input.dependencies,
      input.product.sku,
      input.timeoutMs,
    );
    if (hasPendingProviderOrder !== false) {
      return pendingPurchase(undefined, attemptPending);
    }
    const cleared = await clearAitIapPurchaseAttempt(input);
    return cleared ? undefined : pendingPurchase(undefined, storageUnavailable);
  }
  if (
    state.status === aitIapPurchaseAttemptStatus.serverGranted
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return pendingPurchase(
      state.orderId,
      aitIapDiagnostic(aitIapDiagnosticCodes.grantCompletionFailed, true),
    );
  }
  if (
    state.status === aitIapPurchaseAttemptStatus.completed
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return completedAitIapPurchase(
      input.product,
      state.orderId,
      state.source === 'pending-order-restore' ? 'pending-order-restore' : 'process-product-grant',
    );
  }
  return pendingPurchase(undefined, storageUnavailable);
}

async function persistAitIapPurchaseAttempt(
  input: PersistAitIapPurchaseAttemptInput,
): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    JSON.stringify({
      status: input.status,
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
      ...(input.status === aitIapPurchaseAttemptStatus.pending
        ? { pendingSince: new Date().toISOString() }
        : {}),
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      ...(input.status === aitIapPurchaseAttemptStatus.completed
        && input.source === 'pending-order-restore'
        ? { source: input.source }
        : {}),
    }),
    input.timeoutMs,
  );
}

async function clearAitIapPurchaseAttempt(
  input: AitIapPurchaseAttemptStorageInput,
): Promise<boolean> {
  return await removeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    input.timeoutMs,
  );
}

async function verifyAndPersistAitIapProductGrant(
  input: VerifyAndPersistAitIapProductGrantInput,
): Promise<boolean> {
  const startedAt = Date.now();
  // Best effort and deliberately not awaited: the link only lets recovery pass
  // the client key for this order, so a slow write must never consume the
  // grant deadline. The attempt marker below remains the retry barrier.
  void writeAitIapOrderAttemptLink({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    timeoutMs: input.timeoutMs,
  });
  const correlated = await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.pending,
    timeoutMs: input.timeoutMs,
  });
  if (!correlated) {
    // Never let the backend commit a grant unless the provider order is first
    // durably tied to the client attempt. Otherwise a lost response could let
    // the same client idempotency key open a second checkout after restore.
    return false;
  }
  const verificationTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (verificationTimeoutMs === 0) {
    return false;
  }
  const granted = await verifyAitIapProductGrant({
    verifier: input.verifier,
    orderId: input.orderId,
    product: input.product,
    idempotencyKey: input.orderIdempotencyKey,
    clientIdempotencyKey: input.idempotencyKey,
    source: input.source,
    timeoutMs: verificationTimeoutMs,
  });
  if (!granted) {
    return false;
  }
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (remainingTimeoutMs === 0) {
    return false;
  }
  return await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.serverGranted,
    timeoutMs: remainingTimeoutMs,
  });
}

function remainingAitIapOperationTimeout(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - Math.max(0, Date.now() - startedAt));
}

async function writeAitIapStorage(
  storage: Pick<typeof Storage, 'setItem'>,
  key: string,
  value: string,
  timeoutMs: number,
): Promise<boolean> {
  return await waitForAitIapStorageOperation(() => storage.setItem(key, value), timeoutMs);
}

async function removeAitIapStorage(
  storage: Pick<typeof Storage, 'removeItem'>,
  key: string,
  timeoutMs: number,
): Promise<boolean> {
  return await waitForAitIapStorageOperation(() => storage.removeItem(key), timeoutMs);
}

async function waitForAitIapStorageOperation(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(false), timeoutMs);
  });
  const operationResult = Promise.resolve()
    .then(operation)
    .then(() => true, () => false);
  try {
    return await Promise.race([operationResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

function aitIapPurchaseAttemptStorageKey(
  productId: LogicalProductId,
  idempotencyKey: string,
): string {
  return `${iapPurchaseAttemptStoragePrefix}${encodeURIComponent(productId)}:${encodeURIComponent(idempotencyKey)}`;
}

function isAitIapPendingAttemptPastRecoveryWindow(pendingSince: string): boolean {
  const startedAt = Date.parse(pendingSince);
  return Number.isFinite(startedAt)
    && Date.now() - startedAt >= pendingIapPurchaseAttemptRecoveryAgeMs;
}

async function hasAitIapPendingOrderForSku(
  dependencies: Pick<AitHostDependencies, 'iap'>,
  sku: string,
  timeoutMs: number,
): Promise<boolean | undefined> {
  try {
    const result = await waitForAitIapNativeCall(
      () => dependencies.iap.getPendingOrders(),
      timeoutMs,
    );
    if (result === undefined) {
      return undefined;
    }
    return result.orders.some((order) => order.sku === sku && isAitIapOrderId(order.orderId));
  } catch (error) {
    console.warn(
      'AIT IAP pending-order lookup failed; preserving the client retry barrier.',
      errorMessage(error),
    );
    return undefined;
  }
}

/**
 * Keep the completed-attempt index bounded without deleting terminal retry
 * markers. A client idempotency key may be replayed indefinitely, so removing
 * its durable result could open a second native checkout. The index is only
 * bookkeeping for recent entries; all storage failures leave markers intact.
 */
async function retainCompletedAitIapPurchaseAttempt(
  storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const serialized = await waitForAitIapNativeCall(
      () => storage.getItem(iapCompletedPurchaseAttemptIndexStorageKey),
      timeoutMs,
    );
    const knownKeys = parseAitIapCompletedPurchaseAttemptIndex(serialized);
    const keys = [...knownKeys.filter((knownKey) => knownKey !== storageKey), storageKey];
    const retainedKeys = keys.slice(-maximumIndexedCompletedIapPurchaseAttempts);
    const retentionTimeoutMs = remainingAitIapOperationTimeout(startedAt, timeoutMs);
    if (retentionTimeoutMs === 0) {
      return;
    }
    await writeAitIapStorage(
      storage,
      iapCompletedPurchaseAttemptIndexStorageKey,
      JSON.stringify(retainedKeys),
      retentionTimeoutMs,
    );
  } catch {
    // Index maintenance is best effort. The terminal marker remains the
    // durable retry barrier even when its recent-entry index cannot be written.
  }
}

function parseAitIapCompletedPurchaseAttemptIndex(
  serialized: string | null | undefined,
): readonly string[] {
  if (serialized === null || serialized === undefined) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) {
      return [];
    }
    const keys = value.filter((key): key is string => (
      typeof key === 'string'
      && key.startsWith(iapPurchaseAttemptStoragePrefix)
      && key.length <= 4_096
    ));
    return [...new Set(keys)].slice(-maximumIndexedCompletedIapPurchaseAttempts);
  } catch {
    return [];
  }
}

async function readAitIapPendingOrderCursor(
  storage: Pick<typeof Storage, 'getItem'>,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const cursor = await waitForAitIapNativeCall(
      () => storage.getItem(iapPendingOrderCursorStorageKey),
      timeoutMs,
    );
    return typeof cursor === 'string' && isAitIapOrderId(cursor) ? cursor : undefined;
  } catch (error) {
    console.warn(
      'AIT IAP pending-order cursor read failed; starting from the first eligible order.',
      errorMessage(error),
    );
    return undefined;
  }
}

async function writeAitIapPendingOrderCursor(
  storage: Pick<typeof Storage, 'setItem'>,
  orderId: string,
  timeoutMs: number,
): Promise<boolean> {
  return await writeAitIapStorage(storage, iapPendingOrderCursorStorageKey, orderId, timeoutMs);
}

function rotateAitIapPendingOrders<T extends { readonly order: { readonly orderId: string } }>(
  orders: readonly T[],
  cursor: string | undefined,
  limit: number,
): readonly T[] {
  if (orders.length === 0) {
    return [];
  }
  const cursorIndex = cursor === undefined
    ? -1
    : orders.findIndex(({ order }) => order.orderId === cursor);
  const startIndex = cursorIndex < 0 ? 0 : (cursorIndex + 1) % orders.length;
  const selected: T[] = [];
  const count = Math.min(limit, orders.length);
  for (let offset = 0; offset < count; offset += 1) {
    const next = orders[(startIndex + offset) % orders.length];
    if (next !== undefined) {
      selected.push(next);
    }
  }
  return selected;
}

async function purchaseAitIapProduct(input: AitIapPurchaseInput): Promise<PurchaseResult> {
  const prepared = await prepareAitIap(
    input.prepare,
    {
      intent: 'purchase',
      productId: input.product.productId,
      platformSku: input.product.sku,
    },
    input.timeoutMs,
  );
  if (!prepared) {
    return failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.preparationFailed, true));
  }

  // A paid order whose grant failed stays pending at the provider. Resolve it
  // before opening another checkout so the player is never charged twice for
  // a product they already paid for.
  const checkoutBarrier = resolveAitIapCheckoutBarrier(
    await input.reconcilePendingOrders(input.timeoutMs),
    input.product,
  );
  if (checkoutBarrier !== undefined) {
    return failedPurchase(checkoutBarrier);
  }

  const started = await persistAitIapPurchaseAttempt({
    storage: input.dependencies.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    status: aitIapPurchaseAttemptStatus.pending,
    timeoutMs: input.timeoutMs,
  });
  if (!started) {
    // We cannot tell whether a delayed native-storage write eventually
    // succeeded. Do not open a checkout without a durable retry barrier.
    return pendingPurchase(
      undefined,
      aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
    );
  }

  return new Promise<PurchaseResult>((resolve) => {
    const grantAttempts = new Map<string, Promise<boolean>>();
    let settled = false;
    let cleanup: (() => void) | undefined;
    let cleanupRequested = false;
    let sessionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let providerOrderId: string | undefined;
    let grantedOrderId: string | undefined;
    let markerDeletionStarted = false;

    const finish = (result: PurchaseResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (sessionTimeout !== undefined) {
        globalThis.clearTimeout(sessionTimeout);
        sessionTimeout = undefined;
      }
      if (cleanup === undefined) {
        cleanupRequested = true;
      } else {
        safelyCleanupAitIapPurchase(cleanup);
      }
      resolve(result);
    };

    const startMarkerDeletion = (clearedResult: PurchaseResult): void => {
      markerDeletionStarted = true;
      void clearAitIapPurchaseAttempt({
        storage: input.dependencies.storage,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
      }).then((cleared) => {
        finish(cleared
          ? clearedResult
          : pendingPurchase(
              undefined,
              aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
            ));
      });
    };

    const processProductGrant = (orderId: string): Promise<boolean> => {
      if (markerDeletionStarted) {
        // Cancellation won the serialization race. Do not let a later queued
        // grant callback commit after its retry barrier starts disappearing.
        return Promise.resolve(false);
      }
      const existing = grantAttempts.get(orderId);
      if (existing !== undefined) {
        return existing;
      }
      if (
        !isAitIapOrderId(orderId)
        || (providerOrderId !== undefined && providerOrderId !== orderId)
      ) {
        return Promise.resolve(false);
      }
      providerOrderId = orderId;
      const attempt = verifyAndPersistAitIapProductGrant({
        verifier: input.verifier,
        storage: input.dependencies.storage,
        orderId,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        orderIdempotencyKey: createAitIapOrderIdempotencyKey(orderId),
        source: 'process-product-grant',
        timeoutMs: input.timeoutMs,
      }).then((granted) => {
        if (granted) {
          grantedOrderId = orderId;
        }
        return granted;
      });
      grantAttempts.set(orderId, attempt);
      return attempt;
    };

    const completeAttempt = async (
      orderId: string,
      source: AitIapGrantSource,
    ): Promise<PurchaseResult> => {
      const persisted = await persistAitIapPurchaseAttempt({
        storage: input.dependencies.storage,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        orderId,
        status: aitIapPurchaseAttemptStatus.completed,
        source,
        timeoutMs: input.timeoutMs,
      });
      if (!persisted) {
        return pendingPurchase(
          orderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
        );
      }
      void input.retainCompletedAttempt(
        input.dependencies.storage,
        aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
      );
      return completedAitIapPurchase(input.product, orderId, source);
    };

    /**
     * The SDK reports PRODUCT_NOT_GRANTED_BY_PARTNER after a real payment whose
     * grant callback returned false or ran out of time. The pending-order list
     * can lag right after checkout, so verify this exact order once more and
     * acknowledge it directly instead of waiting for a later restore.
     */
    const recoverNotGrantedOrder = async (
      orderId: string,
      providerCode: string,
    ): Promise<PurchaseResult> => {
      const startedAt = Date.now();
      const priorAttempt = grantAttempts.get(orderId);
      let granted = priorAttempt === undefined ? false : await priorAttempt;
      if (!granted) {
        granted = await verifyAndPersistAitIapProductGrant({
          verifier: input.verifier,
          storage: input.dependencies.storage,
          orderId,
          product: input.product,
          idempotencyKey: input.idempotencyKey,
          orderIdempotencyKey: createAitIapOrderIdempotencyKey(orderId),
          source: 'pending-order-restore',
          timeoutMs: input.timeoutMs,
        });
      }
      if (!granted) {
        return pendingPurchase(
          orderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
        );
      }
      grantedOrderId = orderId;
      const completionTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
      const completion = completionTimeoutMs === 0
        ? { status: 'timeout' as const }
        : await callAitIapNative(
            () => input.dependencies.iap.completeProductGrant({ params: { orderId } }),
            completionTimeoutMs,
          );
      if (completion.status !== 'ok' || completion.value !== true) {
        return pendingPurchase(
          orderId,
          aitIapDiagnostic(
            aitIapDiagnosticCodes.grantCompletionFailed,
            true,
            completion.status === 'error' ? completion.providerCode : undefined,
          ),
        );
      }
      return await completeAttempt(orderId, 'pending-order-restore');
    };

    sessionTimeout = globalThis.setTimeout(() => {
      // The native SDK may have dispatched an order even when it fails to
      // deliver a terminal callback. Preserve the marker and let retry or
      // restore reconcile it instead of opening a second checkout.
      finish(pendingPurchase(
        grantedOrderId,
        aitIapDiagnostic(aitIapDiagnosticCodes.checkoutTimeout, true),
      ));
    }, defaultIapPurchaseSessionTimeoutMs);

    try {
      cleanup = input.dependencies.iap.createOneTimePurchaseOrder({
        options: {
          sku: input.product.sku,
          processProductGrant: ({ orderId }) => processProductGrant(orderId),
        },
        onEvent: async ({ data }) => {
          const granted = await (
            grantAttempts.get(data.orderId) ?? processProductGrant(data.orderId)
          );
          if (!granted) {
            finish(pendingPurchase(
              providerOrderId,
              aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true),
            ));
            return;
          }
          finish(await completeAttempt(data.orderId, 'process-product-grant'));
        },
        onError: (error) => {
          const providerCode = readAitIapProviderCode(error);
          const knownOrderId = providerOrderId;
          if (
            providerCode === aitIapProductNotGrantedByPartnerCode
            && knownOrderId !== undefined
            && !markerDeletionStarted
          ) {
            void recoverNotGrantedOrder(knownOrderId, providerCode).then(finish, () => {
              finish(pendingPurchase(
                knownOrderId,
                aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
              ));
            });
            return;
          }
          if (
            grantedOrderId !== undefined
            || providerOrderId !== undefined
            || grantAttempts.size > 0
            || !isAitIapCancellation(error)
          ) {
            // A cancellation racing an authoritative grant is ambiguous. Keep
            // the durable client retry barrier until retry/restore observes
            // the verifier's eventual result.
            const orderObserved = providerOrderId !== undefined || grantAttempts.size > 0;
            finish(pendingPurchase(
              grantedOrderId ?? providerOrderId,
              aitIapDiagnostic(
                orderObserved
                  ? aitIapDiagnosticCodes.grantPending
                  : aitIapDiagnosticCodes.nativePurchaseFailed,
                true,
                providerCode,
              ),
            ));
            return;
          }
          startMarkerDeletion(cancelledPurchase());
        },
      });
      if (cleanupRequested) {
        safelyCleanupAitIapPurchase(cleanup);
      }
    } catch (error) {
      // A malformed SDK can invoke a grant callback and then throw during
      // registration. Preserve that active order; only a throw with no grant
      // startup proves there is no authoritative commit racing deletion.
      const providerCode = readAitIapProviderCode(error);
      if (providerOrderId !== undefined || grantAttempts.size > 0) {
        finish(pendingPurchase(
          providerOrderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
        ));
        return;
      }
      startMarkerDeletion(failedPurchase(
        aitIapDiagnostic(aitIapDiagnosticCodes.checkoutStartFailed, true, providerCode),
      ));
    }
  });
}

/**
 * Decides whether recovery found a reason not to open a new checkout for this
 * product. Orders for other configured products are still reconciled, but only
 * a same-product order can turn this purchase into a duplicate charge.
 */
function resolveAitIapCheckoutBarrier(
  reconciliation: AitIapPendingOrderReconciliation,
  product: NormalizedAitIapProduct,
): CommerceDiagnostic | undefined {
  if (reconciliation.status === 'unavailable') {
    return reconciliation.diagnostic.code === aitIapDiagnosticCodes.unsupportedAppVersion
      ? reconciliation.diagnostic
      : aitIapDiagnostic(
          aitIapDiagnosticCodes.pendingOrderCheckFailed,
          true,
          reconciliation.diagnostic.providerCode,
        );
  }
  if (reconciliation.unresolvedOrders.some((order) => order.sku === product.sku)) {
    return aitIapDiagnostic(
      aitIapDiagnosticCodes.pendingOrderUnresolved,
      true,
      reconciliation.diagnostic?.providerCode,
    );
  }
  if (
    reconciliation.settledPurchases.some((settlement) => settlement.productId === product.productId)
  ) {
    return aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderRecovered, true);
  }
  return undefined;
}

async function restoreAitIapProducts(
  input: AitIapRestoreInput,
): Promise<AitIapRestoreOutcome> {
  const prepare = input.prepare;
  const verifier = input.verifier;
  if (!isAitIapSupported(input) || prepare === undefined || verifier === undefined) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false),
    };
  }
  const restoreStartedAt = Date.now();
  const getRemainingRestoreTimeout = (): number => {
    return remainingAitIapOperationTimeout(restoreStartedAt, input.timeoutMs);
  };
  const prepared = await prepareAitIap(
    prepare,
    { intent: 'restore' },
    getRemainingRestoreTimeout(),
  );
  if (!prepared) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.preparationFailed, true),
    };
  }
  const postPrepareTimeoutMs = getRemainingRestoreTimeout();
  const reservedEntitlementReadTimeoutMs = Math.max(1, Math.ceil(postPrepareTimeoutMs / 3));
  const reconciliationTimeoutMs = Math.max(
    0,
    postPrepareTimeoutMs - reservedEntitlementReadTimeoutMs,
  );
  if (reconciliationTimeoutMs === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.restoreTimeout, true),
    };
  }

  const reconciliation = await input.reconcilePendingOrders(
    verifier,
    Math.min(reconciliationTimeoutMs, getRemainingRestoreTimeout()),
  );
  if (reconciliation.status === 'unavailable') {
    // Restore exists to settle paid orders. If the provider list cannot be
    // read, report that instead of an empty success the game cannot tell
    // apart from "nothing to restore".
    return { status: 'failed', diagnostic: reconciliation.diagnostic };
  }

  const authoritativeEntitlements = await readAitIapEntitlementsIfAvailable(
    input.entitlementReader,
    getRemainingRestoreTimeout(),
  );
  const { settledPurchases } = reconciliation;
  if (authoritativeEntitlements === undefined && settledPurchases.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.entitlementReadFailed, true),
    };
  }
  let diagnostic: CommerceDiagnostic | undefined;
  if (authoritativeEntitlements === undefined) {
    diagnostic = aitIapDiagnostic(aitIapDiagnosticCodes.entitlementReadFailed, true);
  } else if (reconciliation.unresolvedOrders.length > 0) {
    diagnostic = aitIapDiagnostic(
      aitIapDiagnosticCodes.pendingOrderUnresolved,
      true,
      reconciliation.diagnostic?.providerCode,
    );
  }
  return {
    status: 'ok',
    result: {
      restoredEntitlements: mergeAitIapRestoredEntitlements(
        reconciliation.restoredEntitlements,
        authoritativeEntitlements ?? [],
        input.products,
      ),
      ...(settledPurchases.length === 0 ? {} : { settledPurchases }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

interface AitIapPendingOrderReconciliationInput {
  readonly dependencies: AitHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly verifier: AitIapProductGrantVerifier;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  readonly timeoutMs: number;
}

/**
 * Verifies and acknowledges provider orders for configured SKUs that are paid
 * but not yet granted. Work is bounded per call and rotated across calls so a
 * permanently rejected order cannot starve later ones.
 */
async function reconcileAitIapPendingOrders(
  input: AitIapPendingOrderReconciliationInput,
): Promise<AitIapPendingOrderReconciliation> {
  const startedAt = Date.now();
  const getRemainingTimeout = (): number => {
    return remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  };
  const pendingOrderTimeoutMs = getRemainingTimeout();
  if (pendingOrderTimeoutMs === 0) {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
    };
  }
  const pendingOrders = await callAitIapNative(
    () => input.dependencies.iap.getPendingOrders(),
    pendingOrderTimeoutMs,
  );
  if (pendingOrders.status !== 'ok') {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(
        aitIapDiagnosticCodes.pendingOrderCheckFailed,
        true,
        pendingOrders.status === 'error' ? pendingOrders.providerCode : undefined,
      ),
    };
  }
  const pendingOrderResult: unknown = pendingOrders.value;
  if (!isRecord(pendingOrderResult)) {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unsupportedAppVersion, false),
    };
  }
  if (!Array.isArray(pendingOrderResult.orders)) {
    // A malformed list is not proof that no paid order exists.
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
    };
  }
  const nativeOrders = pendingOrderResult.orders as readonly unknown[];

  const eligibleOrders: Array<{
    readonly order: { readonly orderId: string; readonly sku: string; readonly paymentCompletedDate: string };
    readonly product: NormalizedAitIapProduct;
  }> = [];
  const seenOrderIds = new Set<string>();
  const malformedPendingOrders: AitIapPendingOrderReconciliation = {
    status: 'unavailable',
    diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
  };
  for (const order of nativeOrders) {
    // An entry that might be a configured product's paid order is never
    // proof of absence. Only well-formed entries for other SKUs are ignored.
    if (!isRecord(order) || typeof order.sku !== 'string') {
      return malformedPendingOrders;
    }
    const product = input.products.bySku.get(order.sku);
    if (product === undefined) {
      continue;
    }
    if (typeof order.orderId !== 'string' || !isAitIapOrderId(order.orderId)) {
      return malformedPendingOrders;
    }
    if (seenOrderIds.has(order.orderId)) {
      continue;
    }
    seenOrderIds.add(order.orderId);
    eligibleOrders.push({
      order: {
        orderId: order.orderId,
        sku: order.sku,
        paymentCompletedDate: typeof order.paymentCompletedDate === 'string'
          ? order.paymentCompletedDate
          : '',
      },
      product,
    });
  }

  const settledPurchases: PurchaseSettlement[] = [];
  const restoredEntitlements: Entitlement[] = [];
  const unresolvedOrders: AitIapUnresolvedOrder[] = [];
  let diagnostic: CommerceDiagnostic | undefined;
  const cursorTimeoutMs = getRemainingTimeout();
  const cursor = cursorTimeoutMs === 0
    ? undefined
    : await readAitIapPendingOrderCursor(input.dependencies.storage, cursorTimeoutMs);
  const orders = rotateAitIapPendingOrders(eligibleOrders, cursor, maximumPendingIapOrders);
  if (eligibleOrders.length > orders.length) {
    console.warn('AIT IAP pending-order restore reached its per-launch limit.', {
      limit: maximumPendingIapOrders,
      ignoredOrderCount: eligibleOrders.length - orders.length,
    });
    const selectedOrderIds = new Set(orders.map(({ order }) => order.orderId));
    for (const { order } of eligibleOrders) {
      if (!selectedOrderIds.has(order.orderId)) {
        unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      }
    }
  }

  for (const [index, selectedOrder] of orders.entries()) {
    const { order, product } = selectedOrder;
    const deferRemaining = (): void => {
      for (const deferred of orders.slice(index)) {
        unresolvedOrders.push({ orderId: deferred.order.orderId, sku: deferred.order.sku });
      }
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.restoreTimeout, true);
    };
    const cursorWriteTimeoutMs = getRemainingTimeout();
    if (cursorWriteTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const cursorAdvanced = await writeAitIapPendingOrderCursor(
      input.dependencies.storage,
      order.orderId,
      cursorWriteTimeoutMs,
    );
    if (!cursorAdvanced) {
      deferRemaining();
      break;
    }
    const linkTimeoutMs = getRemainingTimeout();
    const clientIdempotencyKey = linkTimeoutMs === 0
      ? undefined
      : await readAitIapOrderAttemptLink({
          storage: input.dependencies.storage,
          product,
          orderId: order.orderId,
          timeoutMs: linkTimeoutMs,
        });
    const verificationTimeoutMs = getRemainingTimeout();
    if (verificationTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const granted = await verifyAitIapProductGrant({
      verifier: input.verifier,
      orderId: order.orderId,
      product,
      idempotencyKey: createAitIapOrderIdempotencyKey(order.orderId),
      ...(clientIdempotencyKey === undefined ? {} : { clientIdempotencyKey }),
      source: 'pending-order-restore',
      timeoutMs: verificationTimeoutMs,
    });
    if (!granted) {
      unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true);
      continue;
    }

    if (clientIdempotencyKey !== undefined) {
      // Secure the client attempt before acknowledging: once acknowledged, the
      // order leaves the pending list and could no longer finish this marker.
      const markerTimeoutMs = getRemainingTimeout();
      const marker = markerTimeoutMs === 0
        ? 'failed'
        : await completeLinkedAitIapPurchaseAttempt({
            storage: input.dependencies.storage,
            product,
            idempotencyKey: clientIdempotencyKey,
            orderId: order.orderId,
            retainCompletedAttempt: input.retainCompletedAttempt,
            timeoutMs: markerTimeoutMs,
          });
      if (marker === 'failed') {
        unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
        diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true);
        continue;
      }
    }

    const completionTimeoutMs = getRemainingTimeout();
    if (completionTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const completion = await callAitIapNative(
      () =>
        input.dependencies.iap.completeProductGrant({
          params: { orderId: order.orderId },
        }),
      completionTimeoutMs,
    );
    if (completion.status !== 'ok' || completion.value !== true) {
      // Keep provider state pending when its completion acknowledgement fails.
      unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      diagnostic ??= aitIapDiagnostic(
        aitIapDiagnosticCodes.grantCompletionFailed,
        true,
        completion.status === 'error' ? completion.providerCode : undefined,
      );
      continue;
    }
    settledPurchases.push({
      transactionId: order.orderId,
      productId: product.productId,
      status: 'granted',
      ...(clientIdempotencyKey === undefined ? {} : { idempotencyKey: clientIdempotencyKey }),
    });
    restoredEntitlements.push({
      id: product.productId,
      source: 'purchase',
      grantedAt: normalizeAitIapGrantTime(order.paymentCompletedDate),
    });
  }

  return {
    status: 'reconciled',
    settledPurchases,
    restoredEntitlements,
    unresolvedOrders,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

/**
 * Finishes the retry barrier of the client attempt that opened a recovered
 * order, so replaying that client key reports the completed purchase instead
 * of staying pending or reopening a checkout. It runs after the server grant
 * and before the provider acknowledgement. `failed` means the marker could not
 * be read or written and the order must stay unacknowledged; `not-applicable`
 * means no marker for this order needs finishing.
 */
async function completeLinkedAitIapPurchaseAttempt(input: {
  readonly storage: AitHostDependencies['storage'];
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  readonly timeoutMs: number;
}): Promise<'completed' | 'not-applicable' | 'failed'> {
  const startedAt = Date.now();
  const storageKey = aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey);
  const read = await callAitIapNative(() => input.storage.getItem(storageKey), input.timeoutMs);
  if (read.status !== 'ok') {
    return 'failed';
  }
  if (typeof read.value !== 'string') {
    return 'not-applicable';
  }
  let state: unknown;
  try {
    state = JSON.parse(read.value);
  } catch {
    return 'not-applicable';
  }
  if (
    !isRecord(state)
    || state.productId !== input.product.productId
    || state.idempotencyKey !== input.idempotencyKey
    || !isLinkedAitIapAttemptMarker(state, input.orderId)
  ) {
    return 'not-applicable';
  }
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (remainingTimeoutMs === 0) {
    return 'failed';
  }
  const persisted = await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.completed,
    source: 'pending-order-restore',
    timeoutMs: remainingTimeoutMs,
  });
  if (!persisted) {
    return 'failed';
  }
  void input.retainCompletedAttempt(input.storage, storageKey);
  return 'completed';
}

/**
 * The caller already validated the order link for this client key and
 * product. A pending marker without an order id is the same attempt whose
 * order-correlation write failed while the link write succeeded.
 */
function isLinkedAitIapAttemptMarker(
  state: Readonly<Record<string, unknown>>,
  orderId: string,
): boolean {
  if (state.status === aitIapPurchaseAttemptStatus.serverGranted) {
    return state.orderId === orderId;
  }
  return state.status === aitIapPurchaseAttemptStatus.pending
    && (state.orderId === orderId || state.orderId === undefined);
}

async function writeAitIapOrderAttemptLink(input: {
  readonly storage: Pick<typeof Storage, 'setItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly timeoutMs: number;
}): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapOrderAttemptLinkStorageKey(input.orderId),
    JSON.stringify({
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
    }),
    input.timeoutMs,
  );
}

async function readAitIapOrderAttemptLink(input: {
  readonly storage: Pick<typeof Storage, 'getItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly orderId: string;
  readonly timeoutMs: number;
}): Promise<string | undefined> {
  const read = await callAitIapNative(
    () => input.storage.getItem(aitIapOrderAttemptLinkStorageKey(input.orderId)),
    input.timeoutMs,
  );
  if (read.status !== 'ok' || typeof read.value !== 'string') {
    return undefined;
  }
  try {
    const link: unknown = JSON.parse(read.value);
    return isRecord(link)
      && link.productId === input.product.productId
      && isAitIapClientIdempotencyKey(link.idempotencyKey)
      ? link.idempotencyKey
      : undefined;
  } catch {
    return undefined;
  }
}

function aitIapOrderAttemptLinkStorageKey(orderId: string): string {
  return `${iapOrderAttemptLinkStoragePrefix}${encodeURIComponent(orderId)}`;
}

function isAitIapClientIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function mergeAitIapRestoredEntitlements(
  restoredEntitlements: readonly Entitlement[],
  authoritativeEntitlements: readonly Entitlement[],
  products: NormalizedAitIapProducts,
): readonly Entitlement[] {
  const entitlementsById = new Map<string, Entitlement>();
  for (const entitlement of restoredEntitlements) {
    entitlementsById.set(entitlement.id, entitlement);
  }
  for (const entitlement of authoritativeEntitlements) {
    if (
      entitlement.source !== 'purchase'
      || !products.byProductId.has(entitlement.id as LogicalProductId)
    ) {
      continue;
    }
    entitlementsById.set(entitlement.id, entitlement);
  }
  return [...entitlementsById.values()];
}

async function prepareAitIap(
  prepare: AitIapPreparer | undefined,
  input: AitIapPreparationInput,
  timeoutMs: number,
): Promise<boolean> {
  if (prepare === undefined) {
    return false;
  }
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(false), timeoutMs);
  });
  const preparationResult = Promise.resolve()
    .then(async () => prepare(input))
    .then((result) => result === true, () => false);
  try {
    return await Promise.race([preparationResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

/**
 * The provider catalog is the authoritative source for the purchase flow. Do
 * not route an unknown or unavailable SKU into a one-time order; return why.
 */
async function checkAitOneTimeIapProduct(
  dependencies: AitHostDependencies,
  configured: NormalizedAitIapProduct,
  timeoutMs: number,
): Promise<CommerceDiagnostic | undefined> {
  const catalog = await readAitIapCatalog(dependencies, timeoutMs);
  if (catalog.status !== 'ok') {
    return catalog.diagnostic;
  }
  const nativeProduct = catalog.products.find(({ sku }) => sku === configured.sku);
  if (nativeProduct === undefined) {
    return aitIapDiagnostic(aitIapDiagnosticCodes.configuredSkusNotVisible, false);
  }
  return nativeProduct.type === 'CONSUMABLE' || nativeProduct.type === 'NON_CONSUMABLE'
    ? undefined
    : aitIapDiagnostic(aitIapDiagnosticCodes.productTypeUnsupported, false);
}

/**
 * Like waitForAitIapNativeCall, but keeps a timeout, a thrown provider error
 * and a resolved `undefined` (an unsupported Toss app) distinguishable.
 */
async function callAitIapNative<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<AitIapNativeOutcome<T>> {
  const timedOut = Symbol('timed-out');
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<typeof timedOut>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    const value = await Promise.race([operation(), timeoutResult]);
    return value === timedOut ? { status: 'timeout' } : { status: 'ok', value: value as T };
  } catch (error) {
    const providerCode = readAitIapProviderCode(error);
    return providerCode === undefined ? { status: 'error' } : { status: 'error', providerCode };
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function waitForAitIapNativeCall<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<undefined>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const operationResult = operation();
    return await Promise.race([operationResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function verifyAitIapProductGrant(input: {
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderId: string;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly clientIdempotencyKey?: string;
  readonly source: AitIapGrantSource;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort();
      resolve(false);
    }, input.timeoutMs);
  });
  const verifierResult = Promise.resolve()
    .then(async () => input.verifier({
      orderId: input.orderId,
      productId: input.product.productId,
      platformSku: input.product.sku,
      idempotencyKey: input.idempotencyKey,
      ...(input.clientIdempotencyKey === undefined
        ? {}
        : { clientIdempotencyKey: input.clientIdempotencyKey }),
      source: input.source,
      purchasedAt: new Date().toISOString(),
      signal: controller.signal,
      timeoutMs: input.timeoutMs,
    }))
    .then((result) => result === true, () => false);
  try {
    return await Promise.race([verifierResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

function completedAitIapPurchase(
  product: NormalizedAitIapProduct,
  orderId: string,
  source: AitIapGrantSource = 'process-product-grant',
): PurchaseResult {
  return {
    status: 'completed',
    transactionId: orderId,
    entitlementIds: [product.productId],
    evidence: createAitIapEvidence(orderId, product.sku, source),
  };
}

function failedPurchase(diagnostic?: CommerceDiagnostic): PurchaseResult {
  return {
    status: 'failed',
    entitlementIds: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function cancelledPurchase(): PurchaseResult {
  return { status: 'cancelled', entitlementIds: [] };
}

function pendingPurchase(
  transactionId?: string,
  diagnostic?: CommerceDiagnostic,
): PurchaseResult {
  return {
    status: 'pending',
    ...(transactionId === undefined ? {} : { transactionId }),
    entitlementIds: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function aitIapDiagnostic(
  code: AitIapDiagnosticCode,
  retryable: boolean,
  providerCode?: string,
): CommerceDiagnostic {
  return {
    code,
    retryable,
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}

function createAitIapDiagnosticError(
  id: string,
  diagnostic: CommerceDiagnostic,
  summary: string,
): BridgeResponse {
  const providerDetail = diagnostic.providerCode === undefined
    ? ''
    : `; provider code ${diagnostic.providerCode}`;
  return createBridgeError(
    id,
    diagnostic.code,
    `${summary} (${diagnostic.code}${providerDetail}).`,
    diagnostic.retryable,
  );
}

/**
 * Native SDK codes that may be recognized in error text when the SDK does not
 * attach a structured code. Nothing else is ever read from a message.
 */
const aitIapKnownMessageProviderCodes: readonly string[] = [aitIapProductNotGrantedByPartnerCode];

/**
 * Reads a native SDK error code from structured `code`/`errorCode` fields.
 * Free-form error text can contain order or account identifiers, so it is
 * only checked for an exact, allowlisted SDK code.
 */
function readAitIapProviderCode(error: unknown): string | undefined {
  if (isRecord(error)) {
    for (const candidate of [error.code, error.errorCode]) {
      if (isAitIapProviderCode(candidate)) {
        return candidate;
      }
    }
  }
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  const tokens = new Set(message.split(/[^A-Z0-9_]+/u));
  return aitIapKnownMessageProviderCodes.find((code) => tokens.has(code));
}

function isAitIapProviderCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(value);
}

function createAitIapEvidence(
  orderId: string,
  sku: string,
  source: AitIapGrantSource,
): PlatformEvidenceEnvelope {
  return {
    schema: iapEvidenceSchema,
    payload: { orderId, sku, source },
  };
}

function createAitIapOrderIdempotencyKey(orderId: string): string {
  return `apps-in-toss:purchase:${encodeURIComponent(orderId)}`;
}

function createAitIapPurchaseRequestKey(
  productId: LogicalProductId,
  idempotencyKey: string,
): string {
  return `${encodeURIComponent(productId)}:${encodeURIComponent(idempotencyKey)}`;
}

function safelyCleanupAitIapPurchase(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // The bridge has already reached a terminal result; cleanup failures must
    // not turn a completed server grant into a client-visible failure.
  }
}

function isAitIapOrderId(value: string): boolean {
  return value.length > 0 && value.length <= 2_048 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isAitIapCancellation(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (!isRecord(error)) {
    return false;
  }
  const code = typeof error.code === 'string' ? error.code : '';
  return /CANCEL|ABORT/u.test(code);
}

function normalizeAitIapGrantTime(value: string): string {
  if (value.length === 0 || value.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function toAitIapProductInfo(
  nativeProduct: IapProductListItem,
  configured: NormalizedAitIapProduct,
): ProductInfo | undefined {
  const title = normalizeAitIapDisplayText(nativeProduct.displayName);
  const description = normalizeAitIapDisplayText(nativeProduct.description);
  const formattedPrice = normalizeAitIapDisplayText(nativeProduct.displayAmount);
  if (title === undefined || description === undefined || formattedPrice === undefined) {
    return undefined;
  }

  if (nativeProduct.type === 'SUBSCRIPTION') {
    // Subscription creation, renewal, and expiry need a different native and
    // server-authority lifecycle. This bridge only owns one-time orders.
    console.warn('AIT subscription IAP is unavailable through the one-time order bridge.', {
      productId: configured.productId,
      sku: nativeProduct.sku,
    });
    return undefined;
  }

  let type: ProductInfo['type'] | undefined;
  if (nativeProduct.type === 'CONSUMABLE') {
    type = 'consumable';
  } else if (nativeProduct.type === 'NON_CONSUMABLE') {
    type = 'non_consumable';
  }
  if (type === undefined) {
    console.warn('AIT native IAP product has an unsupported type; hiding product.', {
      productId: configured.productId,
      sku: nativeProduct.sku,
      nativeType: nativeProduct.type,
    });
    return undefined;
  }
  return {
    id: configured.productId,
    type,
    title,
    description,
    price: {
      formatted: formattedPrice,
      currencyCode: configured.currencyCode,
    },
  };
}

function normalizeAitIapDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 2_048 && !/[\p{Cc}\p{Cf}]/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizeIapProducts(
  input: readonly AitIapProductConfig[] | undefined,
): NormalizedAitIapProducts {
  const byProductId = new Map<LogicalProductId, NormalizedAitIapProduct>();
  const bySku = new Map<string, NormalizedAitIapProduct>();
  for (const rawProduct of input ?? []) {
    const productId = typeof rawProduct.productId === 'string'
      ? normalizeAitIapConfigIdentifier(rawProduct.productId, 'productId', 128)
      : undefined;
    const sku = typeof rawProduct.sku === 'string'
      ? normalizeAitIapConfigIdentifier(rawProduct.sku, 'sku', 2_048)
      : undefined;
    const currencyCode = normalizeAitIapCurrencyCode(rawProduct.currencyCode);
    if (productId === undefined || sku === undefined || currencyCode === undefined) {
      console.warn('AIT IAP product configuration is invalid; disabling one product.', {
        productId: rawProduct.productId,
        sku: rawProduct.sku,
      });
      continue;
    }
    if (byProductId.has(productId) || bySku.has(sku)) {
      console.warn(
        'AIT IAP product configuration has a duplicate product id or SKU; disabling one product.',
        { productId, sku },
      );
      continue;
    }
    const product: NormalizedAitIapProduct = {
      productId: productId as LogicalProductId,
      sku,
      currencyCode,
    };
    byProductId.set(product.productId, product);
    bySku.set(product.sku, product);
  }
  return { byProductId, bySku };
}

function normalizeAitIapConfigIdentifier(
  value: string,
  field: string,
  maximumLength: number,
): string | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maximumLength
    || /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeAitIapCurrencyCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase() ?? 'KRW';
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

function areFullScreenAdsSupported(dependencies: AitHostDependencies): boolean {
  return isAitNativeMethodSupported(dependencies.loadFullScreenAd)
    && isAitNativeMethodSupported(dependencies.showFullScreenAd);
}

function areBannerAdsSupported(dependencies: AitHostDependencies): boolean {
  return isAitNativeMethodSupported(dependencies.tossAds.initialize)
    && isAitNativeMethodSupported(dependencies.tossAds.attachBanner);
}

function initializeAitBannerAds(
  dependencies: AitHostDependencies,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (initialized: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(initialized);
    };
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);

    try {
      dependencies.tossAds.initialize({
        callbacks: {
          onInitialized: () => finish(true),
          onInitializationFailed: () => finish(false),
        },
      });
    } catch (error) {
      console.warn('Failed to initialize AIT banner ads.', error);
      finish(false);
    }
  });
}

async function attachAitBanner(input: {
  readonly dependencies: AitHostDependencies;
  readonly adGroupId: string;
  readonly surfaceId: string;
  readonly target: HTMLElement;
  readonly timeoutMs: number;
  readonly appearance: Required<AitBannerAppearance>;
  readonly activeAttachments: Map<string, { readonly destroy: () => void }>;
  readonly mountOwner: symbol;
  readonly mountOwners: Map<string, symbol>;
  readonly pendingSettlements: Map<
    string,
    { readonly mountOwner: symbol; readonly settleUnavailable: () => void }
  >;
}): Promise<BannerAdMountResult> {
  return new Promise((resolve) => {
    let settled = false;
    let terminalStatus: BannerAdMountResult['status'] | undefined;
    let attachment: { readonly destroy: () => void } | undefined;
    const finish = (requestedStatus: BannerAdMountResult['status']): void => {
      const ownsSurface = input.mountOwners.get(input.surfaceId) === input.mountOwner;
      const status = requestedStatus === 'mounted' && !ownsSurface
        ? 'unavailable'
        : requestedStatus;
      if (settled) {
        if (status !== 'mounted' && input.activeAttachments.get(input.surfaceId) === attachment) {
          attachment?.destroy();
          input.activeAttachments.delete(input.surfaceId);
        }
        if (status !== 'mounted' && ownsSurface) {
          input.mountOwners.delete(input.surfaceId);
        }
        return;
      }
      settled = true;
      terminalStatus = status;
      globalThis.clearTimeout(timer);
      if (input.pendingSettlements.get(input.surfaceId)?.mountOwner === input.mountOwner) {
        input.pendingSettlements.delete(input.surfaceId);
      }
      if (status !== 'mounted') {
        attachment?.destroy();
        if (input.activeAttachments.get(input.surfaceId) === attachment) {
          input.activeAttachments.delete(input.surfaceId);
        }
        if (ownsSurface) {
          input.mountOwners.delete(input.surfaceId);
        }
      }
      resolve({ status });
    };
    const timer = globalThis.setTimeout(() => finish('failed'), input.timeoutMs);
    input.pendingSettlements.set(input.surfaceId, {
      mountOwner: input.mountOwner,
      settleUnavailable: () => finish('unavailable'),
    });

    try {
      const sdkAttachment = input.dependencies.tossAds.attachBanner(
        input.adGroupId,
        input.target,
        {
          theme: input.appearance.theme,
          tone: input.appearance.tone,
          variant: input.appearance.variant,
          callbacks: {
            onAdRendered: () => finish('mounted'),
            onNoFill: () => finish('unavailable'),
            onAdFailedToRender: (payload) => {
              console.warn('Failed to render an AIT banner ad.', input.adGroupId, payload.error);
              finish('failed');
            },
          },
        },
      );
      let attachmentDestroyed = false;
      attachment = {
        destroy() {
          if (!attachmentDestroyed) {
            attachmentDestroyed = true;
            sdkAttachment.destroy();
          }
        },
      };

      if (terminalStatus === 'unavailable' || terminalStatus === 'failed') {
        attachment.destroy();
        return;
      }
      if (input.mountOwners.get(input.surfaceId) !== input.mountOwner) {
        attachment.destroy();
        finish('unavailable');
        return;
      }
      const existingAttachment = input.activeAttachments.get(input.surfaceId);
      if (existingAttachment !== undefined && existingAttachment !== attachment) {
        existingAttachment.destroy();
      }
      input.activeAttachments.set(input.surfaceId, attachment);
    } catch (error) {
      console.warn('Failed to attach an AIT banner ad.', input.adGroupId, error);
      finish('failed');
    }
  });
}

function isAitNativeMethodSupported(method: AitCapabilityProbe): boolean {
  return isCapabilitySupported(() => method.isSupported?.() === true);
}

function isCapabilitySupported(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch (error) {
    // Older hosts and local wrappers may not expose a native support constant yet.
    // Missing capability metadata must disable the feature instead of blocking startup.
    console.debug('AIT capability support check failed; disabling the feature.', error);
    return false;
  }
}

function normalizeAdGroupIds(
  input: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(input ?? {})
      .map(([placementId, adGroupId]) => [placementId.trim(), adGroupId.trim()] as const)
      .filter(([placementId, adGroupId]) => placementId.length > 0 && adGroupId.length > 0),
  );
}

function consumeLoadedAd(adGroupId: string, loaded: Set<string>): boolean {
  if (!loaded.has(adGroupId)) {
    return false;
  }

  loaded.delete(adGroupId);
  return true;
}

function decodeStoredValue(serialized: string | null): BridgeStorageLoadData {
  if (serialized === null) {
    return { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false };
  }

  try {
    return {
      __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
      found: true,
      value: JSON.parse(serialized) as unknown,
    };
  } catch {
    // Malformed native state is treated as absent so the game can recover with
    // its versioned defaults instead of entering a permanent load-error loop.
    return { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false };
  }
}

function hasConfiguredAdType(
  adGroupIds: ReadonlyMap<string, string>,
  adPlacementTypes: ReadonlyMap<string, AitAdPlacementType>,
  type: AitAdPlacementType,
): boolean {
  return [...adGroupIds.keys()].some((placementId) => adPlacementTypes.get(placementId) === type);
}

function normalizeAdPlacementTypes(
  input: Readonly<Record<string, AitAdPlacementType>> | undefined,
): ReadonlyMap<string, AitAdPlacementType> {
  return new Map(
    Object.entries(input ?? {})
      .map(([placementId, type]) => [placementId.trim(), type] as const)
      .filter(([placementId]) => placementId.length > 0),
  );
}

function normalizePromotionRewards(
  input: Readonly<Record<string, AitPromotionRewardConfig>> | undefined,
): ReadonlyMap<string, AitPromotionRewardConfig> {
  const rewards = new Map<string, AitPromotionRewardConfig>();
  for (const [rawCampaignId, rawReward] of Object.entries(input ?? {})) {
    const campaignId = rawCampaignId.trim();
    const promotionCode = rawReward.promotionCode.trim();
    if (campaignId.length === 0 || promotionCode.length === 0) {
      continue;
    }
    if (!Number.isSafeInteger(rawReward.amount) || rawReward.amount <= 0) {
      console.warn(
        `AIT promotion amount must be a positive safe integer; disabling campaign: ${campaignId}`,
      );
      continue;
    }
    rewards.set(campaignId, { promotionCode, amount: rawReward.amount });
  }
  return rewards;
}

function normalizeNotificationTemplateCodes(
  input: Partial<Readonly<Record<NotificationTopic, string>>> | undefined,
): ReadonlyMap<NotificationTopic, string> {
  const templateCodes = new Map<NotificationTopic, string>();
  for (const topic of notificationTopics) {
    const templateCode = input?.[topic]?.trim();
    if (templateCode !== undefined && templateCode.length > 0) {
      templateCodes.set(topic, templateCode);
    }
  }
  return templateCodes;
}

function normalizeAppName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error('AIT appName must contain only letters, numbers, and hyphens.');
  }
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdTimeoutMs,
    'AIT ad timeout must be a positive finite number.',
  );
}

function normalizeLoadQueueTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdLoadQueueTimeoutMs,
    'AIT ad load queue timeout must be a positive finite number.',
  );
}

function normalizeDisplayStartTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdDisplayStartTimeoutMs,
    'AIT ad display start timeout must be a positive finite number.',
  );
}

function normalizeMaximumDisplayTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultAdMaximumDisplayMs,
    'AIT ad maximum display timeout must be a positive finite number.',
  );
}

function normalizeBannerRenderTimeout(value: number | undefined): number {
  return normalizePositiveTimeout(
    value,
    defaultBannerRenderTimeoutMs,
    'AIT banner render timeout must be a positive finite number.',
  );
}

function normalizeIapProductGrantTimeout(value: number | undefined): number {
  const timeout = normalizePositiveTimeout(
    value,
    defaultIapProductGrantTimeoutMs,
    'AIT IAP product-grant timeout must be a positive finite number.',
  );
  if (timeout > defaultIapProductGrantTimeoutMs) {
    throw new Error(
      `AIT IAP product-grant timeout cannot exceed ${defaultIapProductGrantTimeoutMs}ms.`,
    );
  }
  return timeout;
}

function normalizePositiveTimeout(
  value: number | undefined,
  defaultValue: number,
  message: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function readStorageKey(payload: unknown): string {
  const key = readPayloadRecord(payload).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('AIT storage key must be a non-empty string.');
  }
  if (key.startsWith(reservedStorageKeyPrefix)) {
    throw new TypeError(
      `AIT storage keys starting with "${reservedStorageKeyPrefix}" are reserved for adapter-owned markers.`,
    );
  }
  return key;
}

function readPlacementId(payload: unknown): string {
  const placementId = readPayloadRecord(payload).placementId;
  if (typeof placementId !== 'string' || placementId.length === 0) {
    throw new TypeError('AIT ad placementId must be a non-empty string.');
  }
  return placementId;
}

function readBannerSurfaceId(payload: unknown): string {
  const surfaceId = readPayloadRecord(payload).surfaceId;
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    throw new TypeError('AIT banner surfaceId must be a valid non-empty element id.');
  }
  return surfaceId;
}

/**
 * A rewarded-ad idempotencyKey becomes the client-supplied evidence
 * correlationId. It is optional, but when present it must obey the same
 * bounded visible-character rule as purchase keys so a game cannot push
 * arbitrary blobs into reward evidence.
 */
function readRewardedAdCorrelationId(payload: unknown, fallback: string): string {
  const value = readPayloadRecord(payload).idempotencyKey;
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new TypeError('AIT rewarded ad idempotencyKey must contain 1 to 256 visible characters.');
  }
  return value;
}

function readCommercePurchase(payload: unknown): {
  readonly productId: LogicalProductId;
  readonly idempotencyKey: string;
} {
  const value = readPayloadRecord(payload);
  const productId = value.productId;
  const idempotencyKey = value.idempotencyKey;
  if (
    typeof productId !== 'string'
    || productId.length === 0
    || productId.length > 128
    || /[\p{Cc}\p{Cf}]/u.test(productId)
  ) {
    throw new TypeError('AIT IAP productId must contain 1 to 128 visible characters.');
  }
  if (
    typeof idempotencyKey !== 'string'
    || idempotencyKey.length === 0
    || idempotencyKey.length > 256
    || /[\p{Cc}\p{Cf}]/u.test(idempotencyKey)
  ) {
    throw new TypeError('AIT IAP idempotencyKey must contain 1 to 256 visible characters.');
  }
  return { productId: productId as LogicalProductId, idempotencyKey };
}

function readRequiredIdempotencyKey(payload: unknown): string {
  const value = readPayloadRecord(payload).idempotencyKey;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError('AIT promotion idempotencyKey must contain 1 to 256 characters.');
  }
  return value;
}

function readCampaignId(payload: unknown): string {
  const value = readPayloadRecord(payload).campaignId;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError('AIT promotion campaignId must contain 1 to 128 characters.');
  }
  return value;
}

function readNotificationTopic(payload: unknown): NotificationTopic {
  const value = readPayloadRecord(payload).topic;
  if (typeof value !== 'string' || !notificationTopics.has(value as NotificationTopic)) {
    throw new TypeError('AIT notification topic is invalid.');
  }
  return value as NotificationTopic;
}

function readFiniteScore(payload: unknown): number {
  const score = readPayloadRecord(payload).score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new TypeError('AIT leaderboard score must be a finite number.');
  }
  return score;
}

function readPayloadRecord(payload: unknown): Readonly<Record<string, unknown>> {
  return isRecord(payload) ? payload : {};
}

function parseBridgeRequest(input: unknown): BridgeRequest {
  // The production host deliberately accepts only the current bridge protocol.
  // Legacy partial requests are rejected rather than silently inventing metadata.
  return assertBridgeRequest(input);
}

function readBridgeRequestId(input: unknown): string {
  if (!isRecord(input) || typeof input.id !== 'string' || input.id.length === 0) {
    return invalidBridgeRequestId;
  }
  return input.id;
}

function ok(request: BridgeRequest, data: unknown): BridgeResponse {
  return { id: request.id, ok: true, data };
}

function createBridgeError(
  id: string,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return { id, ok: false, error: { code, message, retryable } };
}

function boundedParam(value: string | null): string | undefined {
  return value === null || value.length === 0 || value.length > maximumLaunchParamLength
    ? undefined
    : value;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

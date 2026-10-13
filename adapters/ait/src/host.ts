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
} from '@apps-in-toss/web-framework';

import {
  assertBridgeRequest,
  bridgeStorageLoadProtocol,
  createNotificationsV2UnavailableBridgeError,
  isBridgeNotificationsV2Method,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import type {
  BannerAdMountResult,
  LaunchEntry,
  LaunchIntent,
  LogicalProductId,
  NotificationTopic,
  PromotionRewardResult,
  ShareResult,
} from '@mpgd/platform';

import { assertAdShowInput, toAdAdapter } from '@mpgd/platform/ads';
import { deriveLegacyCommerceCapabilities } from '@mpgd/platform/commerce';
import { createAitAdProvider } from './ad-provider.js';

import type { AitAdPlacementType } from './ad-config.js';
import { createAitCommerceV2BridgeHandler } from './commerce-bridge.js';
import {
  createAitCommerceProviderFromController,
  type CreateAitCommerceProviderInput,
} from './commerce-provider.js';
import { aitIapDiagnosticCodes } from './iap-diagnostics.js';
import {
  aitIapDiagnostic,
  createAitIapController,
  createAitIapDiagnosticError,
  errorMessage,
  isAbortError,
  isAitNativeMethodSupported,
  isCapabilitySupported,
  isRecord,
  normalizePendingSince,
  normalizePositiveTimeout,
  type AitIapDependencies,
  type AitIapEntitlementReader,
  type AitIapPreparer,
  type AitIapProductConfig,
  type AitIapProductGrantVerifier,
  type AitNativeMethod,
} from './iap.js';
import type { GamePlatformBridge } from './index.js';
import { dispatchAitLifecycleEvent } from './lifecycle.js';
import { normalizeAitAppName, readAitShareRequest } from './share-link.js';

export {
  aitIapDiagnosticCodes,
  aitIapProductNotGrantedByPartnerCode,
  type AitIapDiagnosticCode,
} from './iap-diagnostics.js';
export type {
  AitCapabilityProbe,
  AitIapDependencies,
  AitIapEntitlementReader,
  AitIapPreparationInput,
  AitIapPreparer,
  AitIapProductConfig,
  AitIapProductGrantVerificationInput,
  AitIapProductGrantVerifier,
  AitNativeMethod,
  AitOptionalCapabilityMethod,
} from './iap.js';
export { aitBrowserOrigins, isAitBrowserOrigin } from './origins.js';

const defaultAdTimeoutMs = 60_000;
const defaultAdLoadQueueTimeoutMs = 5_000;
const defaultAdDisplayStartTimeoutMs = 60_000;
const defaultAdMaximumDisplayMs = 30 * 60_000;
const defaultBannerRenderTimeoutMs = 15_000;
const invalidBridgeRequestId = 'ait-invalid-request';
const minimumPromotionTossAppVersion = '5.232.0';
/**
 * Every adapter-owned durable marker (purchase attempts, promotion grants,
 * recovery cursors) lives under this prefix. Game code shares the same native
 * storage, so `storage.save`/`storage.load` must never touch these keys: a
 * forged `completed` marker would otherwise short-circuit purchase verification.
 */
const reservedStorageKeyPrefix = 'mpgd:ait:';
const promotionGrantStoragePrefix = 'mpgd:ait:promotion-grant:v1:';
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
  /**
   * Commerce v2: signals that the pending-order list may have changed, so the
   * host-side provider re-reads it and pushes `purchaseUpdated` events to the
   * game. Defaults to the Apps in Toss lifecycle resume signal.
   */
  readonly onPendingOrdersChanged?: CreateAitCommerceProviderInput['onPendingOrdersChanged'];
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
  const appName = normalizeAitAppName(options.appName ?? 'mpgd-kit');
  const adGroupIds = normalizeAdGroupIds(options.adGroupIds);
  const adPlacementTypes = normalizeAdPlacementTypes(options.adPlacementTypes);
  const promotionRewards = normalizePromotionRewards(options.promotionRewards);
  const authorizePromotionGrant = options.authorizePromotionGrant;
  const resolvePendingPromotionGrant = options.resolvePendingPromotionGrant;
  const notificationTemplateCodes = normalizeNotificationTemplateCodes(
    options.notificationTemplateCodes,
  );
  /**
   * One IAP controller serves the v1 `commerce.*` methods and the commerce v2
   * provider, so both share the single IAP lock, the in-flight purchase map,
   * the durable attempt markers and the acknowledgement barriers.
   */
  const iap = createAitIapController({
    dependencies,
    iapProducts: options.iapProducts,
    prepareIap: options.prepareIap,
    verifyIapProductGrant: options.verifyIapProductGrant,
    readIapEntitlements: options.readIapEntitlements,
    iapProductGrantTimeoutMs: options.iapProductGrantTimeoutMs,
  });
  const commerceProvider = createAitCommerceProviderFromController(
    iap,
    options.onPendingOrdersChanged === undefined
      ? {}
      : { onPendingOrdersChanged: options.onPendingOrdersChanged },
  );
  const commerceV2 = createAitCommerceV2BridgeHandler(commerceProvider);
  const promotionGrantsInFlight = new Map<string, Promise<PromotionRewardResult>>();
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

  return {
    advertising: {
      id: nativeAds.id,
      protocol: nativeAds.protocol,
      protocolVersion: nativeAds.protocolVersion,
      rewardSignal: nativeAds.rewardSignal,
      subscribe: (listener) => nativeAds.subscribe(listener),
    },
    commerceV2: {
      subscribe: (listener) => commerceV2.subscribe(listener),
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
    // Notifications v2 arrives with the Apps in Toss provider (P1); until then
    // every v2 method answers the dedicated code, and the v1
    // `notifications.*` methods below keep serving the game.
    if (isBridgeNotificationsV2Method(request.method)) {
      return createNotificationsV2UnavailableBridgeError(request, 'Apps in Toss host bridge');
    }
    switch (request.method) {
      case 'runtime.getCapabilities': {
        const adsSupported = areFullScreenAdsSupported(dependencies);
        const rewardedAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'rewarded');
        const interstitialAds = adsSupported
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'interstitial');
        const bannerAds = areBannerAdsSupported(dependencies)
          && hasConfiguredAdType(adGroupIds, adPlacementTypes, 'banner');
        // The v2 block is the source: `nativeIap` is derived from it, so the
        // boolean flag and the block can never disagree.
        const commerce = await commerceProvider.getCapabilities();
        const legacyCommerce = deriveLegacyCommerceCapabilities(commerce);

        return ok(request, {
          nativeIap: legacyCommerce.nativeIap,
          subscriptionIap: legacyCommerce.subscriptionIap,
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
          commerce,
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
        const catalog = await iap.listProducts();
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
        return ok(request, await iap.purchase(purchase.productId, purchase.idempotencyKey));
      }

      case 'commerce.restore': {
        const restored = await iap.restore();
        return restored.status === 'ok'
          ? ok(request, restored.result)
          : createAitIapDiagnosticError(
              request.id,
              restored.diagnostic,
              'Apps in Toss purchase restore did not complete',
            );
      }

      case 'commerce.getEntitlements': {
        const entitlements = await iap.readEntitlements();
        if (entitlements.status === 'unconfigured') {
          return ok(request, []);
        }
        // A failed or timed-out authority read is not proof of no ownership.
        return entitlements.status === 'failed'
          ? createAitIapDiagnosticError(
              request.id,
              aitIapDiagnostic(aitIapDiagnosticCodes.entitlementReadFailed, true),
              'Apps in Toss purchase entitlements are unavailable',
            )
          : ok(request, entitlements.entitlements);
      }

      // Commerce v2 (B5): served by the Apps in Toss provider over the same
      // IAP controller; payloads and results are validated by the handler.
      case 'commerce.v2.getCapabilities':
      case 'commerce.v2.fetchProducts':
      case 'commerce.v2.requestPurchase':
      case 'commerce.v2.getAvailablePurchases':
      case 'commerce.v2.finishTransaction':
      case 'commerce.v2.restorePurchases':
        return await commerceV2.request(request);

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

export async function shareIntent(
  payload: unknown,
  dependencies: AitShareDependencies,
): Promise<ShareResult> {
  const request = readAitShareRequest(payload, dependencies.appName);

  if (request === undefined) {
    return { status: 'unavailable' };
  }

  try {
    const tossLink = await dependencies.getTossShareLink(request.link, request.previewImageUrl);
    await dependencies.share({ message: `${request.text}\n${tossLink}` });
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

function isGameCenterSupported(dependencies: AitHostDependencies): boolean {
  return isCapabilitySupported(() =>
    dependencies.isMinVersionSupported({
      android: '5.221.0',
      ios: '5.221.0',
    }),
  );
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

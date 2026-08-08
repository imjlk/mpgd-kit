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
  Entitlement,
  LaunchEntry,
  LaunchIntent,
  LogicalProductId,
  NotificationTopic,
  PlatformEvidenceEnvelope,
  ProductInfo,
  PromotionRewardResult,
  PurchaseResult,
  ShareResult,
} from '@mpgd/platform';

import type { GamePlatformBridge } from './index.js';
import { dispatchAitLifecycleEvent } from './lifecycle.js';

const defaultAdTimeoutMs = 60_000;
const defaultAdLoadQueueTimeoutMs = 5_000;
const defaultAdDisplayStartTimeoutMs = 60_000;
const defaultAdMaximumDisplayMs = 30 * 60_000;
/** Leaves five seconds of headroom inside the native IAP 30-second grant callback. */
const defaultIapProductGrantTimeoutMs = 25_000;
/** Never leave a game UI blocked when an SDK purchase session omits terminal callbacks. */
const defaultIapPurchaseSessionTimeoutMs = defaultAdMaximumDisplayMs;
/** A provider response is untrusted input; keep restore work bounded per launch. */
const maximumPendingIapOrders = 20;
const invalidBridgeRequestId = 'ait-invalid-request';
const rewardedAdEvidenceSchema = 'apps-in-toss.rewarded-ad.callback.v1';
const iapEvidenceSchema = 'apps-in-toss.iap.callback.v1';
const minimumPromotionTossAppVersion = '5.232.0';
const promotionGrantStoragePrefix = 'mpgd:ait:promotion-grant:v1:';
/**
 * A client idempotency key must survive a bridge reload. The authoritative
 * backend still owns entitlements; this marker only prevents a second native
 * checkout while the first checkout is known to be terminal or ambiguous.
 */
const iapPurchaseAttemptStoragePrefix = 'mpgd:ait:iap-purchase-attempt:v1:';
/** Rotates bounded pending-order recovery so an early rejected order cannot starve later work. */
const iapPendingOrderCursorStorageKey = 'mpgd:ait:pending-order-cursor:v1';
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
  readonly idempotencyKey: string;
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

export interface InstallAitHostBridgeOptions {
  readonly appName?: string;
  readonly adGroupIds?: Readonly<Record<string, string>>;
  readonly adPlacementTypes?: Readonly<Record<string, 'rewarded' | 'interstitial'>>;
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
  /** Last-resort cleanup when the native SDK omits its terminal display callback. */
  readonly adMaximumDisplayMs?: number;
  readonly dependencies?: Partial<AitHostDependencies>;
}

const defaultDependencies: AitHostDependencies = {
  identityProvider: getUserKeyForGame,
  storage: Storage,
  getTossShareLink,
  share,
  grantPromotionReward,
  requestNotificationAgreement,
  isMinVersionSupported,
  loadFullScreenAd,
  showFullScreenAd,
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
  const dependencies = { ...defaultDependencies, ...options.dependencies };
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
  const notificationSubscriptions = new Set<NotificationTopic>();
  const loadedAdGroupIds = new Set<string>();
  const loadingAdGroups = new Map<string, Promise<void>>();
  const activeAdGroupIds = new Set<string>();
  let warnedUnsupportedAdPreload = false;
  const adTimeoutMs = normalizeTimeout(options.adTimeoutMs);
  const adLoadQueueTimeoutMs = normalizeLoadQueueTimeout(options.adLoadQueueTimeoutMs);
  const adDisplayStartTimeoutMs = normalizeDisplayStartTimeout(options.adDisplayStartTimeoutMs);
  const adMaximumDisplayMs = normalizeMaximumDisplayTimeout(options.adMaximumDisplayMs);
  const adLoadCoordinator: AitAdLoadCoordinator = {
    active: undefined,
    waitTimeoutMs: adLoadQueueTimeoutMs,
  };

  return {
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
          nativeAds: rewardedAds || interstitialAds,
          rewardedAds,
          interstitialAds,
          nativeLeaderboard: isGameCenterSupported(dependencies),
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
      case 'commerce.getProducts':
        return ok(request, await listAitIapProducts({
          dependencies,
          products: iapProducts,
          prepare: options.prepareIap,
          verifier: options.verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          timeoutMs: iapProductGrantTimeoutMs,
        }));

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
          product === undefined
          || !iapSupported
          || prepareIap === undefined
          || verifyIapProductGrant === undefined
        ) {
          return ok(request, failedPurchase());
        }

        const persisted = await resolvePersistedAitIapPurchaseAttempt({
          storage: dependencies.storage,
          product,
          idempotencyKey: purchase.idempotencyKey,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        if (persisted !== undefined) {
          return ok(request, persisted);
        }

        const isOneTimeProduct = await isAitOneTimeIapProduct(
          dependencies,
          product,
          iapProductGrantTimeoutMs,
        );
        if (!isOneTimeProduct) {
          return ok(request, failedPurchase());
        }

        const purchaseRequestKey = createAitIapPurchaseRequestKey(
          purchase.productId,
          purchase.idempotencyKey,
        );
        const existing = iapPurchasesInFlight.get(purchaseRequestKey);
        if (existing !== undefined) {
          return ok(request, await existing);
        }
        const pending = purchaseAitIapProduct({
          dependencies,
          product,
          idempotencyKey: purchase.idempotencyKey,
          prepare: prepareIap,
          verifier: verifyIapProductGrant,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        iapPurchasesInFlight.set(purchaseRequestKey, pending);
        try {
          return ok(request, await pending);
        } finally {
          if (iapPurchasesInFlight.get(purchaseRequestKey) === pending) {
            iapPurchasesInFlight.delete(purchaseRequestKey);
          }
        }
      }

      case 'commerce.restore':
        return ok(request, await restoreAitIapProducts({
          dependencies,
          products: iapProducts,
          prepare: options.prepareIap,
          verifier: options.verifyIapProductGrant,
          entitlementReader: options.readIapEntitlements,
          timeoutMs: iapProductGrantTimeoutMs,
        }));

      case 'commerce.getEntitlements':
        return ok(request, await readAitIapEntitlements(options.readIapEntitlements));

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

      case 'ads.showRewarded': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'rewarded'
          || !areFullScreenAdsSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable', rewardGranted: false });
        }

        const shown = await withLoadedAdSlot(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          activeAdGroupIds,
          adTimeoutMs,
          'rewarded',
          async () => {
            const correlationId = readIdempotencyKey(request.payload, request.id);
            const result = await showRewardedAd(
              dependencies,
              adGroupId,
              adTimeoutMs,
              adDisplayStartTimeoutMs,
              adMaximumDisplayMs,
            );

            return result.rewardGranted
              ? {
                  ...result,
                  // game-services forwards this as platformImpressionId and compares it
                  // with the native callback correlationId during authority verification.
                  ledgerEntryId: correlationId,
                  evidence: {
                    schema: rewardedAdEvidenceSchema,
                    payload: {
                      event: 'user-earned-reward',
                      correlationId,
                      placementId: adGroupId,
                    },
                  },
                }
              : result;
          },
        );
        if (!shown.acquired) {
          return ok(request, { status: 'unavailable', rewardGranted: false });
        }
        return ok(request, shown.value);
      }

      case 'ads.showInterstitial': {
        const placementId = readPlacementId(request.payload);
        const adGroupId = adGroupIds.get(placementId);

        if (
          adGroupId === undefined
          || adPlacementTypes.get(placementId) !== 'interstitial'
          || !areFullScreenAdsSupported(dependencies)
        ) {
          return ok(request, { status: 'unavailable' });
        }

        const showInterstitial = () => showInterstitialAd(
          dependencies,
          adGroupId,
          adTimeoutMs,
          adDisplayStartTimeoutMs,
          adMaximumDisplayMs,
        );
        const shown = await withLoadedAdSlot(
          dependencies,
          adGroupId,
          loadedAdGroupIds,
          loadingAdGroups,
          adLoadCoordinator,
          activeAdGroupIds,
          adTimeoutMs,
          'interstitial',
          showInterstitial,
        );
        return ok(request, shown.acquired ? shown.value : { status: 'unavailable' });
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
  return isCapabilitySupported(
    () => dependencies.isMinVersionSupported({
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

async function acquireLoadedAdSlot(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  active: Set<string>,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
): Promise<boolean> {
  if (active.has(adGroupId)) {
    return false;
  }

  const loadedSuccessfully = await preloadAdGroupWithDiagnostics(
    dependencies,
    adGroupId,
    loaded,
    loading,
    coordinator,
    timeoutMs,
    placementType,
  );
  if (!loadedSuccessfully) {
    return false;
  }

  // Re-check after the asynchronous load so concurrent callers cannot consume
  // or display the same native ad slot twice.
  if (active.has(adGroupId) || !consumeLoadedAd(adGroupId, loaded)) {
    return false;
  }

  active.add(adGroupId);
  return true;
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

type LoadedAdSlotResult<Value> =
  | { readonly acquired: false }
  | { readonly acquired: true; readonly value: Value };

async function withLoadedAdSlot<Value>(
  dependencies: AitHostDependencies,
  adGroupId: string,
  loaded: Set<string>,
  loading: Map<string, Promise<void>>,
  coordinator: AitAdLoadCoordinator,
  active: Set<string>,
  timeoutMs: number,
  placementType: 'rewarded' | 'interstitial',
  display: () => Promise<Value>,
): Promise<LoadedAdSlotResult<Value>> {
  const acquired = await acquireLoadedAdSlot(
    dependencies,
    adGroupId,
    loaded,
    loading,
    coordinator,
    active,
    timeoutMs,
    placementType,
  );
  if (!acquired) {
    return { acquired: false };
  }

  try {
    return { acquired: true, value: await display() };
  } finally {
    active.delete(adGroupId);
  }
}

async function showRewardedAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
): Promise<{ readonly status: 'completed' | 'skipped' | 'failed'; readonly rewardGranted: boolean }> {
  let rewardGranted = false;
  const status = await showAd(
    dependencies,
    adGroupId,
    timeoutMs,
    displayStartTimeoutMs,
    maximumDisplayMs,
    (eventType) => {
      if (eventType === 'userEarnedReward') {
        rewardGranted = true;
      }
    },
  );
  let resultStatus: 'completed' | 'skipped' | 'failed';

  if (status === 'shown' && rewardGranted) {
    resultStatus = 'completed';
  } else if (status === 'failed') {
    resultStatus = 'failed';
  } else {
    resultStatus = 'skipped';
  }

  return {
    status: resultStatus,
    rewardGranted,
  };
}

async function showInterstitialAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
): Promise<{ readonly status: 'shown' | 'skipped' }> {
  const status = await showAd(
    dependencies,
    adGroupId,
    timeoutMs,
    displayStartTimeoutMs,
    maximumDisplayMs,
  );
  return { status: status === 'failed' ? 'skipped' : status };
}

function showAd(
  dependencies: AitHostDependencies,
  adGroupId: string,
  timeoutMs: number,
  displayStartTimeoutMs: number,
  maximumDisplayMs: number,
  observe?: (eventType: string) => void,
): Promise<'shown' | 'failed'> {
  dispatchAitLifecycleEvent('pause');

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let cleanup = (): void => {};
    let settled = false;
    let maximumDisplayTimeoutArmed = false;
    let adTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const clearAdTimer = (): void => {
      if (adTimer !== undefined) {
        globalThis.clearTimeout(adTimer);
        adTimer = undefined;
      }
    };
    const finish = (status: 'shown' | 'failed'): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAdTimer();
      cleanup();
      dispatchAitLifecycleEvent('resume');
      resolve(status);
    };
    const armDisplayStartTimeout = (): void => {
      clearAdTimer();
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = Math.max(0, timeoutMs - elapsedMs);
      adTimer = globalThis.setTimeout(
        () => finish('failed'),
        Math.min(displayStartTimeoutMs, remainingMs),
      );
    };
    const armMaximumDisplayTimeout = (): void => {
      if (maximumDisplayTimeoutArmed) {
        return;
      }
      maximumDisplayTimeoutArmed = true;
      clearAdTimer();
      adTimer = globalThis.setTimeout(() => {
        console.warn(
          'AIT full-screen ad omitted its terminal callback; recovering the game lifecycle.',
          adGroupId,
        );
        finish('shown');
      }, maximumDisplayMs);
    };
    const failShow = (error?: unknown): void => {
      if (settled) {
        return;
      }
      console.warn(
        'Failed to show AIT full-screen ad.',
        adGroupId,
        error ?? 'unknown native error',
      );
      finish('failed');
    };
    adTimer = globalThis.setTimeout(() => finish('failed'), timeoutMs);

    try {
      const unregister = dependencies.showFullScreenAd({
        options: { adGroupId },
        onEvent: (event) => {
          observe?.(event.type);
          switch (event.type) {
            case 'requested':
              armDisplayStartTimeout();
              break;
            case 'show':
            case 'impression':
            case 'clicked':
            case 'userEarnedReward':
              // Native terminal callbacks remain authoritative. A long, one-shot
              // recovery timeout prevents a broken SDK callback from deadlocking
              // the game forever without treating ordinary end-card dwell as failure.
              armMaximumDisplayTimeout();
              break;
            case 'dismissed':
              finish('shown');
              break;
            case 'failedToShow':
              finish('failed');
              break;
          }
        },
        onError: failShow,
      });
      cleanup = unregister;
      if (settled) {
        cleanup();
      }
    } catch (error) {
      failShow(error);
    }
  });
}

function getLaunchIntent(): LaunchIntent {
  const params = inboundSearchParams();
  const challengeToken = nonEmptyParam(params.get('challengeToken'));
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const requestedEntry = nonEmptyParam(params.get('entry'));
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
  const puzzleId = nonEmptyParam(params.get('puzzleId'));
  const challengeToken = nonEmptyParam(params.get('challengeToken'));
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

  if (nested !== null) {
    try {
      const parsed = JSON.parse(nested) as unknown;
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && !params.has(key)) {
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
    }));
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
  readonly timeoutMs: number;
}

interface AitIapRestoreInput extends AitIapSupportInput {
  readonly timeoutMs: number;
}

interface AitIapPurchaseAttemptStorageInput {
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

interface PersistAitIapServerGrantInput extends AitIapPurchaseAttemptStorageInput {
  readonly orderId: string;
}

interface VerifyAndPersistAitIapProductGrantInput extends PersistAitIapServerGrantInput {
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderIdempotencyKey: string;
  readonly source: 'process-product-grant' | 'pending-order-restore';
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

async function listAitIapProducts(
  input: AitIapSupportInput,
): Promise<readonly ProductInfo[]> {
  if (!isAitIapSupported(input)) {
    return [];
  }

  try {
    const result = await waitForAitIapNativeCall(
      () => input.dependencies.iap.getProductItemList(),
      input.timeoutMs,
    );
    if (result === undefined) {
      return [];
    }
    const products: ProductInfo[] = [];
    for (const nativeProduct of result.products) {
      const configured = input.products.bySku.get(nativeProduct.sku);
      if (configured === undefined) {
        continue;
      }
      const product = toAitIapProductInfo(nativeProduct, configured);
      if (product !== undefined) {
        products.push(product);
      }
    }
    return products;
  } catch {
    // Product metadata is not authoritative. If the native catalog cannot be
    // read, hide it instead of rendering stale game-owned prices.
    return [];
  }
}

async function readAitIapEntitlements(
  reader: AitIapEntitlementReader | undefined,
): Promise<readonly Entitlement[]> {
  if (reader === undefined) {
    return [];
  }

  try {
    return [...await reader()];
  } catch {
    // The game authority owns durable purchase state. A read failure must not
    // turn stale local data into a visible entitlement.
    return [];
  }
}

/**
 * Return a durable result before consulting the provider catalog. This makes a
 * repeated client idempotency key safe after a reload or after the in-memory
 * coalescing map has been cleared.
 */
async function resolvePersistedAitIapPurchaseAttempt(
  input: AitIapPurchaseAttemptStorageInput,
): Promise<PurchaseResult | undefined> {
  const storageKey = aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey);
  let serialized: string | null | undefined;
  try {
    serialized = await waitForAitIapNativeCall(
      () => input.storage.getItem(storageKey),
      input.timeoutMs,
    );
  } catch {
    return pendingPurchase();
  }
  if (serialized === undefined) {
    return pendingPurchase();
  }
  if (serialized === null) {
    return undefined;
  }

  let state: unknown;
  try {
    state = JSON.parse(serialized);
  } catch {
    return pendingPurchase();
  }
  if (
    !isRecord(state)
    || state.productId !== input.product.productId
    || state.idempotencyKey !== input.idempotencyKey
  ) {
    return pendingPurchase();
  }
  if (state.status === 'pending') {
    return pendingPurchase();
  }
  if (
    state.status === 'server-granted'
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return pendingPurchase(state.orderId);
  }
  if (
    state.status === 'completed'
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return completedAitIapPurchase(input.product, state.orderId);
  }
  return pendingPurchase();
}

async function persistPendingAitIapPurchaseAttempt(
  input: AitIapPurchaseAttemptStorageInput,
): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    JSON.stringify({
      status: 'pending',
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
    }),
    input.timeoutMs,
  );
}

async function persistServerGrantedAitIapPurchaseAttempt(
  input: PersistAitIapServerGrantInput,
): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    JSON.stringify({
      status: 'server-granted',
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
      orderId: input.orderId,
    }),
    input.timeoutMs,
  );
}

async function persistCompletedAitIapPurchaseAttempt(
  input: PersistAitIapServerGrantInput,
): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    JSON.stringify({
      status: 'completed',
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
      orderId: input.orderId,
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
  const granted = await verifyAitIapProductGrant({
    verifier: input.verifier,
    orderId: input.orderId,
    product: input.product,
    idempotencyKey: input.orderIdempotencyKey,
    source: input.source,
    timeoutMs: input.timeoutMs,
  });
  if (!granted) {
    return false;
  }
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (remainingTimeoutMs === 0) {
    return false;
  }
  return await persistServerGrantedAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
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
  } catch {
    return undefined;
  }
}

async function writeAitIapPendingOrderCursor(
  storage: Pick<typeof Storage, 'setItem'>,
  orderId: string,
  timeoutMs: number,
): Promise<void> {
  await writeAitIapStorage(storage, iapPendingOrderCursorStorageKey, orderId, timeoutMs);
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
    return failedPurchase();
  }

  const started = await persistPendingAitIapPurchaseAttempt({
    storage: input.dependencies.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    timeoutMs: input.timeoutMs,
  });
  if (!started) {
    // We cannot tell whether a delayed native-storage write eventually
    // succeeded. Do not open a checkout without a durable retry barrier.
    return pendingPurchase();
  }

  return new Promise<PurchaseResult>((resolve) => {
    const grantAttempts = new Map<string, Promise<boolean>>();
    let settled = false;
    let cleanup: (() => void) | undefined;
    let cleanupRequested = false;
    let sessionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let providerOrderId: string | undefined;
    let grantedOrderId: string | undefined;

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

    const processProductGrant = (orderId: string): Promise<boolean> => {
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

    sessionTimeout = globalThis.setTimeout(() => {
      // The native SDK may have dispatched an order even when it fails to
      // deliver a terminal callback. Preserve the marker and let retry or
      // restore reconcile it instead of opening a second checkout.
      finish(pendingPurchase(grantedOrderId));
    }, defaultIapPurchaseSessionTimeoutMs);

    try {
      cleanup = input.dependencies.iap.createOneTimePurchaseOrder({
        options: {
          sku: input.product.sku,
          processProductGrant: ({ orderId }) => processProductGrant(orderId),
        },
        onEvent: async ({ data }) => {
          const granted = await (grantAttempts.get(data.orderId) ?? Promise.resolve(false));
          if (!granted) {
            finish(pendingPurchase(providerOrderId));
            return;
          }
          const result = completedAitIapPurchase(input.product, data.orderId);
          const persisted = await persistCompletedAitIapPurchaseAttempt({
            storage: input.dependencies.storage,
            product: input.product,
            idempotencyKey: input.idempotencyKey,
            orderId: data.orderId,
            timeoutMs: input.timeoutMs,
          });
          finish(persisted ? result : pendingPurchase(data.orderId));
        },
        onError: (error) => {
          if (grantedOrderId !== undefined || !isAitIapCancellation(error)) {
            finish(pendingPurchase(grantedOrderId));
            return;
          }
          void clearAitIapPurchaseAttempt({
            storage: input.dependencies.storage,
            product: input.product,
            idempotencyKey: input.idempotencyKey,
            timeoutMs: input.timeoutMs,
          }).then((cleared) => {
            finish(cleared ? cancelledPurchase() : pendingPurchase());
          });
        },
      });
      if (cleanupRequested) {
        safelyCleanupAitIapPurchase(cleanup);
      }
    } catch {
      // A synchronous callback-registration error means the native checkout
      // never opened, so it is safe to clear the marker and surface failure.
      void clearAitIapPurchaseAttempt({
        storage: input.dependencies.storage,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
      }).then((cleared) => {
        finish(cleared ? failedPurchase() : pendingPurchase());
      });
    }
  });
}

async function restoreAitIapProducts(
  input: AitIapRestoreInput,
): Promise<{ readonly restoredEntitlements: readonly { readonly id: string; readonly source: 'purchase'; readonly grantedAt: string }[] }> {
  const prepare = input.prepare;
  const verifier = input.verifier;
  if (!isAitIapSupported(input) || prepare === undefined || verifier === undefined) {
    return { restoredEntitlements: [] };
  }
  const prepared = await prepareAitIap(prepare, { intent: 'restore' }, input.timeoutMs);
  if (!prepared) {
    return { restoredEntitlements: [] };
  }

  let pendingOrders: Awaited<ReturnType<AitHostDependencies['iap']['getPendingOrders']>> | undefined;
  try {
    pendingOrders = await waitForAitIapNativeCall(
      () => input.dependencies.iap.getPendingOrders(),
      input.timeoutMs,
    );
  } catch {
    return { restoredEntitlements: [] };
  }
  if (pendingOrders === undefined) {
    return { restoredEntitlements: [] };
  }

  const eligibleOrders: Array<{
    readonly order: (typeof pendingOrders.orders)[number];
    readonly product: NormalizedAitIapProduct;
  }> = [];
  const seenOrderIds = new Set<string>();
  for (const order of pendingOrders.orders) {
    const product = input.products.bySku.get(order.sku);
    if (
      product === undefined
      || !isAitIapOrderId(order.orderId)
      || seenOrderIds.has(order.orderId)
    ) {
      continue;
    }
    seenOrderIds.add(order.orderId);
    eligibleOrders.push({ order, product });
  }

  const restoredEntitlements: Array<{
    readonly id: string;
    readonly source: 'purchase';
    readonly grantedAt: string;
  }> = [];
  const cursor = await readAitIapPendingOrderCursor(input.dependencies.storage, input.timeoutMs);
  const orders = rotateAitIapPendingOrders(eligibleOrders, cursor, maximumPendingIapOrders);
  if (eligibleOrders.length > orders.length) {
    console.warn('AIT IAP pending-order restore reached its per-launch limit.', {
      limit: maximumPendingIapOrders,
      ignoredOrderCount: eligibleOrders.length - orders.length,
    });
  }

  for (const { order, product } of orders) {
    const granted = await verifyAitIapProductGrant({
      verifier,
      orderId: order.orderId,
      product,
      idempotencyKey: createAitIapOrderIdempotencyKey(order.orderId),
      source: 'pending-order-restore',
      timeoutMs: input.timeoutMs,
    });
    if (!granted) {
      continue;
    }

    try {
      const completed = await waitForAitIapNativeCall(
        () => input.dependencies.iap.completeProductGrant({
          params: { orderId: order.orderId },
        }),
        input.timeoutMs,
      );
      if (completed === true) {
        restoredEntitlements.push({
          id: product.productId,
          source: 'purchase',
          grantedAt: normalizeAitIapGrantTime(order.paymentCompletedDate),
        });
      }
    } catch {
      // Keep provider state pending when its completion acknowledgement fails.
    }
  }

  const lastSelectedOrder = orders[orders.length - 1];
  if (lastSelectedOrder !== undefined) {
    await writeAitIapPendingOrderCursor(
      input.dependencies.storage,
      lastSelectedOrder.order.orderId,
      input.timeoutMs,
    );
  }

  return { restoredEntitlements };
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

async function isAitOneTimeIapProduct(
  dependencies: AitHostDependencies,
  configured: NormalizedAitIapProduct,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const result = await waitForAitIapNativeCall(
      () => dependencies.iap.getProductItemList(),
      timeoutMs,
    );
    if (result === undefined) {
      return false;
    }
    const nativeProduct = result.products.find(({ sku }) => sku === configured.sku);
    if (nativeProduct === undefined) {
      return false;
    }
    return nativeProduct.type === 'CONSUMABLE' || nativeProduct.type === 'NON_CONSUMABLE';
  } catch {
    // The provider catalog is the authoritative source for the purchase flow.
    // Do not route an unknown or unavailable SKU into a one-time order.
    return false;
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
  const operationResult = operation();
  try {
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
  readonly source: 'process-product-grant' | 'pending-order-restore';
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
): PurchaseResult {
  return {
    status: 'completed',
    transactionId: orderId,
    entitlementIds: [product.productId],
    evidence: createAitIapEvidence(orderId, product.sku, 'process-product-grant'),
  };
}

function failedPurchase(): PurchaseResult {
  return { status: 'failed', entitlementIds: [] };
}

function cancelledPurchase(): PurchaseResult {
  return { status: 'cancelled', entitlementIds: [] };
}

function pendingPurchase(transactionId?: string): PurchaseResult {
  return {
    status: 'pending',
    ...(transactionId === undefined ? {} : { transactionId }),
    entitlementIds: [],
  };
}

function createAitIapEvidence(
  orderId: string,
  sku: string,
  source: 'process-product-grant' | 'pending-order-restore',
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

  const type = nativeProduct.type === 'CONSUMABLE'
    ? 'consumable'
    : nativeProduct.type === 'NON_CONSUMABLE'
      ? 'non_consumable'
      : undefined;
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

function normalizeAitIapDisplayText(value: string): string | undefined {
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
  adPlacementTypes: ReadonlyMap<string, 'rewarded' | 'interstitial'>,
  type: 'rewarded' | 'interstitial',
): boolean {
  return [...adGroupIds.keys()].some((placementId) => adPlacementTypes.get(placementId) === type);
}

function normalizeAdPlacementTypes(
  input: Readonly<Record<string, 'rewarded' | 'interstitial'>> | undefined,
): ReadonlyMap<string, 'rewarded' | 'interstitial'> {
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
  return key;
}

function readPlacementId(payload: unknown): string {
  const placementId = readPayloadRecord(payload).placementId;
  if (typeof placementId !== 'string' || placementId.length === 0) {
    throw new TypeError('AIT ad placementId must be a non-empty string.');
  }
  return placementId;
}

function readIdempotencyKey(payload: unknown, fallback: string): string {
  const value = readPayloadRecord(payload).idempotencyKey;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
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

function nonEmptyParam(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
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

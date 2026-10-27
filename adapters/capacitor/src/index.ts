import {
  bridgeCommerceEventProtocol,
  bridgeNotificationsEventProtocol,
  decodeBridgeCredentialLoadData,
  decodeBridgeStorageLoadData,
  type BridgeCommerceEvent,
  type BridgeMethod,
  type BridgeNotificationsEvent,
} from '@mpgd/bridge';
import { CapacitorGameServices } from '@mpgd/capacitor-game-services';
import {
  PlatformOperationError,
  type IdentitySession,
  type IdentityUpgradeResult,
  type InboundShare,
  type LaunchIntent,
  type NotificationSubscriptionResult,
  type NotificationSubscriptionStatus,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlatformTarget,
  type PresentationResult,
  type ShareResult,
  type ViewportAdapter,
} from '@mpgd/platform';
import { withShareIntentCheck } from '@mpgd/platform/routes';
import {
  createCapacitorAppEvents,
  type CapacitorAppEventsApi,
  type CapacitorIncomingUrlKind,
  type CapacitorVisibilitySource,
} from './app-events.js';
import { namesOtherProtocol } from './bridge-events.js';
import { createBridgeCommerceProvider } from './commerce-bridge.js';
import {
  createCapacitorGatewayCrashReporting,
  type CapacitorCrashReportingOptions,
} from './crash-reporting.js';
import {
  assertProviderResponseData,
  createCapacitorProviderRegistry,
  type CapacitorCommerceServiceProvider,
  type CapacitorNotificationServiceProvider,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
import { assertNotificationsV2Served, externalActivityMethods } from './request-policy.js';
import { createCapacitorViewport } from './viewport.js';

export {
  capacitorCrashlyticsPluginName,
  capacitorCrashReportingProvider,
  createCapacitorCrashReporter,
  createLocalCrashCollectionPreferenceStore,
  type CrashCollectionPreferenceStore,
  type CapacitorCrashlyticsPlugin,
  type CapacitorCrashReporterOptions,
  type CapacitorCrashReportingOptions,
} from './crash-reporting.js';
export {
  createCapacitorProviderRegistry,
  createDegradedCommerceCapabilities,
  createDegradedNotificationCapabilities,
  type CapacitorCommerceServiceProvider,
  type CapacitorNotificationServiceProvider,
  type CapacitorNotificationsV2Service,
  type CapacitorProviderCapabilitySnapshot,
  type CapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
export {
  assertCommerceBridgeResult,
  commerceV2InvalidPayloadBridgeErrorCode,
  commerceV2MethodUnsupportedBridgeErrorCode,
  createBridgeCommerceProvider,
  createCommerceProviderBridge,
  createCommerceServiceProvider,
  type CommerceProviderBridge,
  type CreateBridgeCommerceProviderInput,
  type CreateCommerceProviderBridgeInput,
  type CreateCommerceServiceProviderInput,
} from './commerce-bridge.js';
export {
  accountBindingLookupFailedStoreCode,
  createStoreCommerceProvider,
  purchaseGateFailedStoreCode,
  purchasesPausedStoreCode,
  recoverableErrorCodes,
  type CreateStoreCommerceProviderInput,
  type StoreCommerceCapabilityOverrides,
  type StoreCommerceProductMapping,
  type StoreCommerceProvider,
  type StorePurchaseGate,
  type StorePurchaseGateDecision,
  type StorePurchaseGateRequest,
} from './store-commerce-provider.js';
export {
  defaultStoreSdkErrorCodeMap,
  normalizeStoreSdkError,
  type StoreSdk,
  type StoreSdkCapabilities,
  type StoreSdkError,
  type StoreSdkErrorCodeMap,
  type StoreSdkEvent,
  type StoreSdkEventName,
  type StoreSdkEventOf,
  type StoreSdkFetchProductsInput,
  type StoreSdkFinishTransactionInput,
  type StoreSdkFinishTransactionResult,
  type StoreSdkGetAvailablePurchasesInput,
  type StoreSdkProduct,
  type StoreSdkPurchase,
  type StoreSdkRequestPurchaseInput,
  type StoreSdkRequestPurchaseResult,
} from './store-sdk.js';
export {
  createCapacitorAppEvents,
  type CapacitorAppEventsApi,
  type CapacitorIncomingUrlKind,
  type CapacitorVisibilitySource,
} from './app-events.js';
export {
  CapacitorNativeHttpError,
  createCapacitorNativeJsonTransport,
  type CapacitorJsonRequest,
  type CapacitorJsonResponse,
  type CapacitorNativeHttpErrorCode,
  type CapacitorNativeJsonTransport,
  type CreateCapacitorNativeJsonTransportInput,
} from './native-http.js';
export {
  createCapacitorViewport,
  type CapacitorViewportBaseState,
  type CapacitorOccupiedSurfaceInput,
  type CapacitorViewportController,
  type CapacitorViewportHost,
} from './viewport.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upper bound on how long a `launched` commerce v2 purchase keeps the game
 * paused when no purchase event for the product arrives (for example a store
 * sheet dismissed without a callback).
 */
export const launchedPurchaseActivityTimeoutMs = 120_000;

const safeFallbackMethods = new Set<BridgeMethod>([
  'identity.getPlayer',
  'identity.getSession',
  'notifications.getStatus',
]);
const credentialKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const maximumCredentialBytes = 16 * 1024;

function assertCredentialKey(key: string): void {
  if (typeof key !== 'string' || !credentialKeyPattern.test(key)) {
    throw new PlatformOperationError({ code: 'NATIVE_CREDENTIAL_INVALID_KEY' });
  }
}

function assertCredentialValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0
    || new TextEncoder().encode(value).byteLength > maximumCredentialBytes) {
    throw new PlatformOperationError({ code: 'NATIVE_CREDENTIAL_INVALID_VALUE' });
  }
}

function assertCredentialMutationResponse(input: unknown, field: 'saved' | 'removed'): void {
  if (!isRecord(input) || input[field] !== true) {
    throw new PlatformOperationError({ code: 'NATIVE_CREDENTIAL_INVALID_RESPONSE' });
  }
}

export function createCapacitorPlatformGateway(input: {
  readonly target: Extract<PlatformTarget, 'android' | 'ios'>;
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: NativeBridge;
  readonly providers?: readonly CapacitorServiceProvider[];
  readonly app?: CapacitorAppEventsApi;
  readonly visibility?: CapacitorVisibilitySource | null;
  readonly classifyIncomingUrl?: (url: string) => CapacitorIncomingUrlKind | null;
  readonly historyBack?: () => void;
  readonly onAppEventError?: (error: unknown) => void;
  readonly viewport?: ViewportAdapter;
  /**
   * Crash reporting (`gateway.crashReporter`). By default the gateway uses
   * Firebase Crashlytics when the shell has the native plugin (`--providers
   * crash-reporting`) and then reports uncaught WebView errors too; without
   * the plugin the reporter is unavailable and nothing is installed. `false`
   * leaves `crashReporter` out.
   */
  readonly crashReporting?: CapacitorCrashReportingOptions | false;
}): PlatformGateway {
  const bridge = input.bridge ?? CapacitorGameServices;
  const providers = createCapacitorProviderRegistry(input.providers ?? []);
  const adProvider = providers.byMethod.get('ads.showRewarded')?.adProvider
    ?? providers.byMethod.get('ads.showInterstitial')?.adProvider;
  const commerceProvider: CapacitorCommerceServiceProvider | undefined = providers.commerce;
  // The commerce provider is served through the same request path as every
  // other provider method, so the bridge envelope, response validation, and
  // external activity bookkeeping are exercised in process exactly as over a
  // transport.
  const commerce = commerceProvider === undefined
    ? undefined
    : createBridgeCommerceProvider({
        store: commerceProvider.commerce.store,
        request: (method, payload) => request(method, payload),
        // The provider's channel (`NativeBridge`) may carry other protocols.
        // Only an envelope that names another protocol is dropped; anything
        // else, a malformed envelope included, reaches the commerce
        // provider's validator.
        subscribe: (listener) => commerceProvider.bridge.subscribe((envelope) => {
          if (!namesOtherProtocol(envelope, bridgeCommerceEventProtocol)) {
            listener(envelope as BridgeCommerceEvent);
          }
        }),
      });
  const notificationsProvider: CapacitorNotificationServiceProvider | undefined =
    providers.notifications;
  // Served through the same request path as every other provider method, as
  // commerce is, so the game pauses under the permission dialog and the
  // settings screen, and every answer is validated on the way back.
  const notificationSurface = notificationsProvider?.notificationsV2.createGatewaySurface({
    request: (method, payload) => request(method, payload),
    // Only an envelope that names another protocol is dropped; anything else,
    // a malformed envelope included, reaches the client's validator.
    subscribe: (listener) => notificationsProvider.bridge.subscribe((envelope) => {
      if (!namesOtherProtocol(envelope, bridgeNotificationsEventProtocol)) {
        listener(envelope as BridgeNotificationsEvent);
      }
    }),
  });
  const lifecycle = createCapacitorAppEvents({
    target: input.target,
    ...(input.app === undefined ? {} : { app: input.app }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.classifyIncomingUrl === undefined
      ? {}
      : { classifyIncomingUrl: input.classifyIncomingUrl }),
    ...(input.historyBack === undefined ? {} : { historyBack: input.historyBack }),
    ...(input.onAppEventError === undefined ? {} : { onError: input.onAppEventError }),
  });
  const viewport = input.viewport ?? createCapacitorViewport({
    ...(input.onAppEventError === undefined ? {} : { onError: input.onAppEventError }),
  });
  const crashReporting = input.crashReporting === false
    ? undefined
    : createCapacitorGatewayCrashReporting({
        target: input.target,
        appVersion: input.appVersion,
        buildId: input.buildId,
        options: input.crashReporting ?? {},
      });
  const launchedPurchaseHolds = new Set<() => void>();
  const gatewayLifecycle = {
    ...lifecycle,
    async dispose() {
      crashReporting?.dispose();
      try {
        for (const finish of [...launchedPurchaseHolds]) {
          finish();
        }
        await lifecycle.dispose?.();
      } finally {
        if (input.viewport === undefined) {
          viewport.dispose?.();
        }
      }
    },
  };

  async function request<TData>(
    method: BridgeMethod,
    payload: unknown,
    leaderboardRoute?: 'native' | 'remote',
  ): Promise<TData> {
    // Before any pause: an unserved notifications v2 method never reaches the
    // base plugin, which speaks no v2.
    assertNotificationsV2Served(method, providers.byMethod.has(method));
    const releaseExternalActivity = externalActivityMethods.has(method)
      ? lifecycle.beginExternalActivity?.()
      : undefined;
    let holdActivity = false;
    try {
      const provider = leaderboardRoute === 'remote'
        && (method === 'leaderboard.submitScore' || method === 'leaderboard.open')
        ? undefined
        : providers.byMethod.get(method);
      if (provider !== undefined) {
        try {
          await providers.assertMethodReady(method, payload);
          const data = await sendRequest<TData>(method, payload, provider);
          if (releaseExternalActivity !== undefined
            && method === 'commerce.v2.requestPurchase'
            && isRecord(data) && data.outcome === 'launched') {
            // The store UI is still open: stay paused until this product's
            // purchase event arrives or the safety timeout ends.
            holdActivity = true;
            holdLaunchedPurchaseActivity(
              releaseExternalActivity,
              isRecord(payload) ? payload.logicalId : undefined,
            );
          }
          return data;
        } catch (error) {
          // Only non-mutating guest/status queries may degrade. A stale readiness
          // snapshot, SDK rejection, or malformed provider response is no safer
          // than initialization failure for these queries.
          if (!safeFallbackMethods.has(method)) {
            throw error;
          }
        }
      }
      return await sendRequest<TData>(method, payload, undefined);
    } finally {
      if (!holdActivity) {
        releaseExternalActivity?.();
      }
    }
  }

  /**
   * Keeps the external activity of a `launched` purchase open until the
   * provider reports that product (`purchaseUpdated` or `purchaseError`, or an
   * event without a logical id), the safety timeout ends, or the gateway is
   * disposed. Every path releases exactly once.
   */
  function holdLaunchedPurchaseActivity(release: () => void, logicalId: unknown): void {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      launchedPurchaseHolds.delete(finish);
      clearTimeout(timer);
      unsubscribe?.();
      release();
    };
    launchedPurchaseHolds.add(finish);
    const timer = setTimeout(finish, launchedPurchaseActivityTimeoutMs);
    if (commerceProvider === undefined) {
      return;
    }
    const subscription = commerceProvider.bridge.subscribe((envelope) => {
      // Only this purchase's commerce events end the hold; the channel may
      // carry other protocols.
      if (envelope.protocol !== bridgeCommerceEventProtocol) {
        return;
      }
      const { event } = envelope;
      if (event.type === 'subscriptionUpdated') {
        return;
      }
      const eventLogicalId = event.type === 'purchaseUpdated'
        ? event.purchase.logicalId
        : event.logicalId;
      if (eventLogicalId === undefined || typeof logicalId !== 'string'
        || eventLogicalId === logicalId) {
        finish();
      }
    });
    // A buffered event may have finished the hold while subscribing.
    if (done) {
      subscription();
    } else {
      unsubscribe = subscription;
    }
  }

  async function sendRequest<TData>(
    method: BridgeMethod,
    payload: unknown,
    provider: CapacitorServiceProvider | undefined,
  ): Promise<TData> {
    const id = crypto.randomUUID();
    const response: unknown = await (provider?.bridge ?? bridge).request({
      id,
      method,
      payload,
      meta: {
        target: input.target,
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!isRecord(response) || response.id !== id || typeof response.ok !== 'boolean') {
      throw new PlatformOperationError({
        code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
        message: `Native bridge returned an invalid response for ${method}.`,
      });
    }

    if (response.ok) {
      if (!Object.hasOwn(response, 'data')) {
        throw new PlatformOperationError({
          code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
          message: `Native bridge omitted response data for ${method}.`,
        });
      }
      if (provider !== undefined) {
        assertProviderResponseData(method, response.data, provider);
      }
      return response.data as TData;
    }

    if (
      !isRecord(response.error)
      || typeof response.error.code !== 'string'
      || typeof response.error.message !== 'string'
      || typeof response.error.retryable !== 'boolean'
    ) {
      throw new PlatformOperationError({
        code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
        message: `Native bridge returned an invalid error for ${method}.`,
      });
    }

    throw new PlatformOperationError(response.error);
  }

  return {
    target: input.target,
    async getCapabilities() {
      const base = await request<PlatformCapabilities>('runtime.getCapabilities', {});
      // A native shell built before the commerce v2 removals may still send the
      // retired boolean flags; the commerce block is the only commerce source.
      // The notifications block is the registered service's, present exactly
      // when the gateway exposes `notificationsV2`.
      const {
        nativeIap: _retiredNativeIap,
        subscriptionIap: _retiredSubscriptionIap,
        notifications: _nativeNotifications,
        ...native
      } = (isRecord(base) ? base : {}) as PlatformCapabilities & {
        readonly nativeIap?: unknown;
        readonly subscriptionIap?: unknown;
      };
      // One bounded registry read serves the feature states and the commerce
      // block, so a stalled or invalid provider degrades the snapshot instead
      // of rejecting it, and a missing or invalid native `commerce` answer is
      // always replaced by the provider's block or the unsupported block.
      const {
        availability: states,
        commerce: commerceCapabilities,
        notifications: notificationCapabilities,
      } = await providers.getCapabilitySnapshot();
      const rewardedAds = states.rewardedAds === 'available';
      const interstitialAds = states.interstitialAds === 'available';
      const bannerAds = states.bannerAds === 'available';
      return {
        ...native,
        nativeAds: rewardedAds || interstitialAds || bannerAds,
        rewardedAds,
        interstitialAds,
        bannerAds,
        nativeLeaderboard: states.nativeLeaderboard === 'available',
        providerAvailability: states,
        commerce: commerceCapabilities,
        ...(notificationSurface === undefined || notificationCapabilities === undefined
          ? {}
          : { notifications: notificationCapabilities }),
      };
    },
    ...(commerce === undefined ? {} : { commerce }),
    ...(crashReporting === undefined ? {} : { crashReporter: crashReporting.reporter }),
    identity: {
      getPlayer: () => request('identity.getPlayer', {}),
      getSession: () => request<IdentitySession>('identity.getSession', {}),
      requestUpgrade: (payload) =>
        request<IdentityUpgradeResult>('identity.requestUpgrade', payload),
    },
    presentation: {
      getLaunchIntent: () => request<LaunchIntent>('presentation.getLaunchIntent', {}),
      requestGameSurface: (payload) =>
        request<PresentationResult>('presentation.requestGameSurface', payload),
    },
    // The bridge's host may build a share URL from the link, so it only ever
    // sees an intent the ShareIntent contract accepts, with the link normalized.
    sharing: withShareIntentCheck({
      share: (payload) => request<ShareResult>('share.share', payload),
      readInboundShare: () => request<InboundShare | null>('share.readInboundShare', {}),
    }),
    // With a notifications v2 service, v1 is served from it (RFC
    // "Capabilities"), so both report the same readiness.
    notifications: notificationSurface?.notifications ?? {
      getStatus: (topic) =>
        request<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        request<NotificationSubscriptionResult>('notifications.requestSubscription', { topic }),
    },
    ...(notificationSurface === undefined
      ? {}
      : { notificationsV2: notificationSurface.notificationsV2 }),
    ads: {
      ...(adProvider === undefined ? {} : { provider: adProvider }),
      preload: (payload) => request('ads.preload', payload),
      showRewarded: (payload) => request('ads.showRewarded', payload),
      showInterstitial: (payload) => request('ads.showInterstitial', payload),
      mountBanner: (payload) => request('ads.mountBanner', payload),
      unmountBanner: (payload) => request('ads.unmountBanner', payload),
    },
    leaderboard: {
      submitScore: ({ route, ...payload }) => request('leaderboard.submitScore', payload, route),
      open: (input) => {
        const { route, ...payload } = input ?? {};
        return request('leaderboard.open', payload, route);
      },
    },
    lifecycle: gatewayLifecycle,
    viewport,
    storage: {
      async load(payload) {
        return decodeBridgeStorageLoadData(await request<unknown>('storage.load', payload));
      },
      save: (payload) => request('storage.save', payload),
    },
    secureCredentials: {
      async load({ key }) {
        assertCredentialKey(key);
        const data = await request<unknown>('credentials.load', { key });
        try {
          const value = decodeBridgeCredentialLoadData(data);
          if (value !== null) {
            assertCredentialValue(value);
          }
          return value;
        } catch {
          throw new PlatformOperationError({ code: 'NATIVE_CREDENTIAL_INVALID_RESPONSE' });
        }
      },
      async save({ key, value }) {
        assertCredentialKey(key);
        assertCredentialValue(value);
        assertCredentialMutationResponse(
          await request<unknown>('credentials.save', { key, value }),
          'saved',
        );
      },
      async remove({ key }) {
        assertCredentialKey(key);
        assertCredentialMutationResponse(
          await request<unknown>('credentials.remove', { key }),
          'removed',
        );
      },
    },
  };
}

import {
  decodeBridgeCredentialLoadData,
  decodeBridgeStorageLoadData,
  type BridgeMethod,
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
  type ProductInfo,
  type ProductType,
  type ShareResult,
  type ViewportAdapter,
} from '@mpgd/platform';
import {
  createCapacitorAppEvents,
  type CapacitorAppEventsApi,
  type CapacitorIncomingUrlKind,
  type CapacitorVisibilitySource,
} from './app-events.js';
import {
  assertProviderResponseData,
  createCapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
import { createCapacitorViewport } from './viewport.js';

export {
  createCapacitorProviderRegistry,
  type CapacitorServiceProvider,
  type NativeBridge,
} from './providers.js';
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

const externalActivityMethods = new Set<BridgeMethod>([
  'commerce.purchase',
  'ads.showRewarded',
  'ads.showInterstitial',
  'identity.requestUpgrade',
  'notifications.requestSubscription',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
}): PlatformGateway {
  const bridge = input.bridge ?? CapacitorGameServices;
  const providers = createCapacitorProviderRegistry(input.providers ?? []);
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
  const gatewayLifecycle = {
    ...lifecycle,
    async dispose() {
      try {
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
    const releaseExternalActivity = externalActivityMethods.has(method)
      ? lifecycle.beginExternalActivity?.()
      : undefined;
    try {
      const provider = leaderboardRoute === 'remote'
        && (method === 'leaderboard.submitScore' || method === 'leaderboard.open')
        ? undefined
        : providers.byMethod.get(method);
      if (provider !== undefined) {
        let productType: ProductType | undefined;
        if (method === 'commerce.purchase'
          && provider.features.includes('nativeIap')
          && provider.features.includes('subscriptionIap')) {
          // The caller supplies only an ID. Resolve its provider-owned type before
          // selecting a store route; a forged or unknown ID must not bypass it.
          const products = await request<ProductInfo[]>('commerce.getProducts', {});
          const productId = isRecord(payload) ? payload.productId : undefined;
          const matches = products.filter((product) => product.id === productId);
          if (matches.length !== 1) {
            throw new PlatformOperationError({ code: 'NATIVE_PROVIDER_PRODUCT_UNKNOWN' });
          }
          productType = matches[0]?.type;
        }
        try {
          await providers.assertMethodReady(method, payload, productType);
          return await sendRequest<TData>(method, payload, provider);
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
      releaseExternalActivity?.();
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
        assertProviderResponseData(method, response.data);
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
      const states = await providers.getAvailability();
      const rewardedAds = states.rewardedAds === 'available';
      const interstitialAds = states.interstitialAds === 'available';
      const bannerAds = states.bannerAds === 'available';
      return {
        ...base,
        nativeIap: states.nativeIap === 'available',
        subscriptionIap: states.subscriptionIap === 'available',
        nativeAds: rewardedAds || interstitialAds || bannerAds,
        rewardedAds,
        interstitialAds,
        bannerAds,
        nativeLeaderboard: states.nativeLeaderboard === 'available',
        providerAvailability: states,
      };
    },
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
    sharing: {
      share: (payload) => request<ShareResult>('share.share', payload),
      readInboundShare: () => request<InboundShare | null>('share.readInboundShare', {}),
    },
    notifications: {
      getStatus: (topic) =>
        request<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        request<NotificationSubscriptionResult>('notifications.requestSubscription', { topic }),
    },
    commerce: {
      getProducts: () => request('commerce.getProducts', {}),
      purchase: (payload) => request('commerce.purchase', payload),
      restore: () => request('commerce.restore', {}),
      getEntitlements: () => request('commerce.getEntitlements', {}),
    },
    ads: {
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
          return decodeBridgeCredentialLoadData(data);
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

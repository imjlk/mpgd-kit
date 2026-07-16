import {
  bridgeStorageLoadProtocol,
  createBridgeError,
  decodeBridgeStorageLoadData,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';
import {
  createBridgeOrpcClient,
  defaultBridgeRpcEndpoint,
  type BridgeRpcClient,
  type BridgeRpcEndpoint,
} from '@mpgd/bridge/orpc';
import type {
  IdentitySession,
  IdentityUpgradeResult,
  InboundShare,
  LaunchIntent,
  NotificationSubscriptionResult,
  NotificationSubscriptionStatus,
  PlatformCapabilities,
  PlatformGateway,
  PlayerIdentity,
  PresentationResult,
  ShareResult,
} from '@mpgd/platform';

export * from './payments.js';

export const defaultDevvitRpcEndpoint = defaultBridgeRpcEndpoint;

type BridgeErrorResponse = Extract<BridgeResponse, { readonly ok: false }>;
type DevvitStorageSaveResponse = {
  readonly saved?: boolean;
};

export interface DevvitBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export class DevvitBridgeError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(response: BridgeErrorResponse) {
    super(response.error.message);
    this.name = 'DevvitBridgeError';
    this.code = response.error.code;
    this.requestId = response.id;
    this.retryable = response.error.retryable;
  }
}

export interface DevvitPlatformGatewayOptions {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: DevvitBridge;
  readonly fallbackBridge?: DevvitBridge;
  readonly rpcEndpoint?: BridgeRpcEndpoint;
}

export function createDevvitPlatformGateway(
  input: DevvitPlatformGatewayOptions,
): PlatformGateway {
  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const bridge =
      input.bridge ??
      getBridge() ??
      input.fallbackBridge ??
      createDevvitOrpcBridge({ endpoint: input.rpcEndpoint });

    const response = await bridge.request({
      id: generateRequestId(),
      method,
      payload,
      meta: {
        target: 'reddit',
        appVersion: input.appVersion,
        buildId: input.buildId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!response.ok) {
      throw new DevvitBridgeError(response);
    }

    return response.data as TData;
  }

  return {
    target: 'reddit',
    async getCapabilities() {
      return { ...await request<PlatformCapabilities>('runtime.getCapabilities', {}) };
    },
    identity: {
      getPlayer: () => request<PlayerIdentity | null>('identity.getPlayer', {}),
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
    },
    leaderboard: {
      submitScore: (payload) => request('leaderboard.submitScore', payload),
      open: (payload) => request('leaderboard.open', payload ?? {}),
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load(payload) {
        return decodeBridgeStorageLoadData(await request<unknown>('storage.load', payload));
      },
      async save(payload) {
        const result = await request<DevvitStorageSaveResponse>('storage.save', payload);

        if (result.saved !== true) {
          throw new Error('Devvit storage save was not persisted.');
        }
      },
    },
  };
}

export function createDevvitOrpcBridge(input: {
  readonly endpoint?: BridgeRpcEndpoint | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly client?: BridgeRpcClient | undefined;
} = {}): DevvitBridge {
  const client = input.client ?? createBridgeOrpcClient({
    url: input.endpoint ?? defaultDevvitRpcEndpoint,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });

  return {
    async request(bridgeRequest) {
      try {
        return await client.request(bridgeRequest);
      } catch (error) {
        return createBridgeError(
          bridgeRequest.id,
          'DEVVIT_BRIDGE_NETWORK_ERROR',
          `Devvit oRPC bridge request failed: ${errorMessage(error)}`,
          true,
        );
      }
    },
  };
}

function getBridge(): DevvitBridge | undefined {
  const globalBridgeHost = globalThis as {
    __DEVVIT_GAME_PLATFORM_BRIDGE__?: DevvitBridge;
    __GAME_PLATFORM_BRIDGE__?: DevvitBridge;
  };

  return globalBridgeHost.__DEVVIT_GAME_PLATFORM_BRIDGE__ ?? globalBridgeHost.__GAME_PLATFORM_BRIDGE__;
}

function generateRequestId(): string {
  const cryptoImpl = globalThis.crypto;

  if (typeof cryptoImpl?.randomUUID === 'function') {
    return cryptoImpl.randomUUID();
  }

  if (typeof cryptoImpl?.getRandomValues === 'function') {
    const values = new Uint32Array(2);
    cryptoImpl.getRandomValues(values);
    const first = values[0] ?? 0;
    const second = values[1] ?? 0;

    return `${Date.now().toString(36)}-${first.toString(36)}-${second.toString(36)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDevvitSandboxBridge(): DevvitBridge {
  const storage = new Map<string, unknown>();

  return {
    async request(input) {
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
            nativeIap: false,
            nativeAds: false,
            rewardedAds: false,
            interstitialAds: false,
            nativeLeaderboard: false,
            achievements: false,
            cloudSave: true,
            socialShare: false,
            haptics: false,
            localizedContent: true,
          });

        case 'identity.getPlayer':
          return ok(input, {
            playerId: 'reddit-sandbox-player',
            displayName: 'Reddit Sandbox Player',
          });

        case 'identity.getSession':
          return ok(input, {
            identityLevel: 'authenticated',
            playerId: 'reddit-sandbox-player',
            trustLevel: 'server-verified',
          });

        case 'identity.requestUpgrade':
          return ok(input, {
            status: 'completed',
            reloadExpected: false,
          });

        case 'presentation.getLaunchIntent':
          return ok(input, {
            entry: 'home',
          });

        case 'presentation.requestGameSurface':
          return ok(input, 'unavailable');

        case 'share.share':
          return ok(input, {
            status: 'unavailable',
          });

        case 'share.readInboundShare':
          return ok(input, null);

        case 'notifications.getStatus':
          return ok(input, 'approval-required');

        case 'notifications.requestSubscription':
          return ok(input, 'unavailable');

        case 'commerce.getProducts':
        case 'commerce.getEntitlements':
          return ok(input, []);

        case 'commerce.purchase':
          return ok(input, {
            status: 'cancelled',
            entitlementIds: [],
          });

        case 'commerce.restore':
          return ok(input, {
            restoredEntitlements: [],
          });

        case 'ads.preload':
          return ok(input, {});

        case 'leaderboard.open':
          return createBridgeError(
            input.id,
            'DEVVIT_LEADERBOARD_OPEN_UNAVAILABLE',
            'Devvit leaderboard display is not implemented yet.',
          );

        case 'ads.showRewarded':
          return ok(input, {
            status: 'unavailable',
            rewardGranted: false,
          });

        case 'ads.showInterstitial':
          return ok(input, {
            status: 'unavailable',
          });

        case 'leaderboard.submitScore':
          return ok(input, {
            submitted: false,
          });

        case 'storage.load': {
          const payload = optionalObjectPayload(input.payload);
          const key = typeof payload.key === 'string' ? payload.key : undefined;
          const value = key === undefined ? undefined : storage.get(key);

          return ok(
            input,
            value === undefined
              ? ({ __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false } satisfies BridgeStorageLoadData)
              : ({
                  __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
                  found: true,
                  value: cloneJsonValue(value),
                } satisfies BridgeStorageLoadData),
          );
        }

        case 'storage.save': {
          const payload = optionalObjectPayload(input.payload) as {
            readonly key?: unknown;
            readonly value?: unknown;
          };
          const key = typeof payload.key === 'string' ? payload.key : undefined;

          if (key !== undefined) {
            storage.set(key, cloneJsonValue(payload.value));
          }

          return ok(input, {
            saved: key !== undefined,
          });
        }

        default:
          return createBridgeError(
            input.id,
            'UNSUPPORTED_METHOD',
            `Unsupported Devvit sandbox method: ${input.method}`,
          );
      }
    },
  };
}

function cloneJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError('Storage values must be JSON-serializable.');
  }

  return JSON.parse(serialized) as unknown;
}

function optionalObjectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  return payload as Record<string, unknown>;
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}

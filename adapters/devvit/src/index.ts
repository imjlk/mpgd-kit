import {
  assertBridgeResponse,
  createBridgeError,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import type { PlatformGateway } from '@mpgd/platform';

export const defaultDevvitBridgeEndpoint = '/api/mpgd/bridge';

type BridgeErrorResponse = Extract<BridgeResponse, { readonly ok: false }>;
type DevvitStorageSaveResponse = {
  readonly saved?: boolean;
};

const devvitFallbackStoragePrefix = 'mpgd:devvit:fallback:';

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
  readonly endpoint?: string;
}

export function createDevvitPlatformGateway(
  input: DevvitPlatformGatewayOptions,
): PlatformGateway {
  async function request<TData>(method: BridgeMethod, payload: unknown): Promise<TData> {
    const bridge =
      input.bridge ??
      getBridge() ??
      input.fallbackBridge ??
      createDevvitFetchBridge({ endpoint: input.endpoint });

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
    getCapabilities: () => request('runtime.getCapabilities', {}),
    identity: {
      getPlayer: () => request('identity.getPlayer', {}),
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
        const value = await request<unknown | null>('storage.load', payload);

        return value === null ? loadDevvitStorageFallback(payload.key) : { value };
      },
      async save(payload) {
        const result = await request<DevvitStorageSaveResponse>('storage.save', payload);

        if (result.saved !== true) {
          if (saveDevvitStorageFallback(payload)) {
            return;
          }

          throw new Error(
            'Devvit storage save was not persisted and local fallback storage is unavailable.',
          );
        }

        removeDevvitStorageFallback(payload.key);
      },
    },
  };
}

export function createDevvitFetchBridge(input: {
  readonly endpoint?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
} = {}): DevvitBridge {
  const endpoint = input.endpoint ?? defaultDevvitBridgeEndpoint;

  return {
    async request(bridgeRequest) {
      const fetchImpl = input.fetch ?? globalThis.fetch;

      if (typeof fetchImpl !== 'function') {
        return createBridgeError(
          bridgeRequest.id,
          'DEVVIT_FETCH_UNAVAILABLE',
          'Devvit bridge fetch is not available.',
          false,
        );
      }

      let response: Response;

      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(bridgeRequest),
        });
      } catch (error) {
        return createBridgeError(
          bridgeRequest.id,
          'DEVVIT_BRIDGE_NETWORK_ERROR',
          `Devvit bridge network request failed: ${errorMessage(error)}`,
          true,
        );
      }

      if (!response.ok) {
        return createBridgeError(
          bridgeRequest.id,
          'DEVVIT_BRIDGE_HTTP_ERROR',
          `Devvit bridge request failed with HTTP ${response.status}.`,
          response.status >= 500,
        );
      }

      try {
        const body = await response.json();
        return assertBridgeResponse(body);
      } catch (error) {
        return createBridgeError(
          bridgeRequest.id,
          'DEVVIT_BRIDGE_PARSE_ERROR',
          `Devvit bridge response was not valid JSON: ${errorMessage(error)}`,
          false,
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
            nativeLeaderboard: true,
            achievements: false,
            cloudSave: true,
            socialShare: true,
            haptics: false,
            localizedContent: true,
          });

        case 'identity.getPlayer':
          return ok(input, {
            playerId: 'reddit-sandbox-player',
            displayName: 'Reddit Sandbox Player',
          });

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
        case 'leaderboard.open':
          return ok(input, {});

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
            submitted: true,
          });

        case 'storage.load': {
          const payload = optionalObjectPayload(input.payload);
          const key = typeof payload.key === 'string' ? payload.key : undefined;
          return ok(input, key === undefined ? null : (storage.get(key) ?? null));
        }

        case 'storage.save': {
          const payload = optionalObjectPayload(input.payload) as {
            readonly key?: unknown;
            readonly value?: unknown;
          };
          const key = typeof payload.key === 'string' ? payload.key : undefined;

          if (key !== undefined) {
            storage.set(key, payload.value);
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

function loadDevvitStorageFallback(key: string): { readonly value: unknown } | null {
  const storage = browserLocalStorage();

  if (storage === undefined) {
    return null;
  }

  const fallbackKey = devvitStorageFallbackKey(key);
  const stored = storage.getItem(fallbackKey);

  if (stored === null) {
    return null;
  }

  try {
    return {
      value: JSON.parse(stored),
    };
  } catch {
    storage.removeItem(fallbackKey);
    return null;
  }
}

function saveDevvitStorageFallback(input: {
  readonly key: string;
  readonly value: unknown;
}): boolean {
  const storage = browserLocalStorage();

  if (storage === undefined) {
    return false;
  }

  try {
    storage.setItem(devvitStorageFallbackKey(input.key), JSON.stringify(input.value));
    return true;
  } catch {
    return false;
  }
}

function removeDevvitStorageFallback(key: string): void {
  const storage = browserLocalStorage();

  if (storage !== undefined) {
    storage.removeItem(devvitStorageFallbackKey(key));
  }
}

function devvitStorageFallbackKey(key: string): string {
  return `${devvitFallbackStoragePrefix}${encodeURIComponent(key)}`;
}

function browserLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

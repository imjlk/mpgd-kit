import {
  bridgeStorageLoadProtocol,
  commerceV2UnavailableBridgeErrorCode,
  createBridgeError,
  createCommerceV2UnavailableBridgeError,
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
  type PlatformProviderAvailability,
  type PlayerIdentity,
  type PresentationResult,
  type ShareResult,
} from '@mpgd/platform';
import {
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeGetCapabilitiesResult,
  CommerceError,
  commerceProtocol,
  deriveLegacyCommerceCapabilities,
  isCommerceErrorCode,
  type CommerceErrorCode,
  type CommerceProvider,
} from '@mpgd/platform/commerce';

import { assertDevvitOrderEvidence, type DevvitPaidOrder } from './commerce-contract.js';
import {
  createDevvitCommerceProvider,
  type CreateDevvitCommerceProviderInput,
  type DevvitOrderSource,
} from './commerce-provider.js';

export * from './commerce-contract.js';
export * from './commerce-provider.js';
export * from './payments.js';

export const defaultDevvitRpcEndpoint = defaultBridgeRpcEndpoint;
/** Bridge error of `createDevvitOrpcBridge` when the oRPC request itself failed. */
export const devvitBridgeNetworkErrorCode = 'DEVVIT_BRIDGE_NETWORK_ERROR' as const;

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

/**
 * Webview side of commerce v2: the checkout client and the product catalog.
 * The paid-order list and the capability availability come from the server
 * bridge (`commerce.v2.getAvailablePurchases`, `commerce.v2.getCapabilities`),
 * which the server serves through `createDevvitCommerceV2BridgeHandler` from
 * `@mpgd/adapter-devvit/server`.
 */
export type DevvitGatewayCommerceOptions = Omit<CreateDevvitCommerceProviderInput, 'orders'>;

export interface DevvitPlatformGatewayOptions {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: DevvitBridge;
  readonly fallbackBridge?: DevvitBridge;
  readonly rpcEndpoint?: BridgeRpcEndpoint;
  /**
   * Installs the commerce v2 provider (`createDevvitCommerceProvider`) as
   * `commerceV2`, with the `commerce` capability block and `nativeIap` and
   * `subscriptionIap` derived from it. Absent, the gateway offers no
   * `commerceV2`; the v1 `commerce` surface is the bridge's either way.
   *
   * Not yet usable in production before C2: the backend lookup verifier for
   * `devvit.order.v1` does not exist yet, so a verify request for a Devvit
   * purchase is refused today instead of answering `pending`, and no journal
   * record can reach `granted`. Enable it once the backend can answer.
   */
  readonly commerce?: DevvitGatewayCommerceOptions;
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

  const commerceV2: CommerceProvider | undefined = input.commerce === undefined
    ? undefined
    : createDevvitCommerceProvider({
        ...input.commerce,
        orders: createDevvitBridgeOrderSource(request),
      });

  return {
    target: 'reddit',
    async getCapabilities() {
      const capabilities = { ...await request<PlatformCapabilities>('runtime.getCapabilities', {}) };
      if (commerceV2 === undefined) {
        return capabilities;
      }
      // The webview provider owns the block: the server snapshot stays honest
      // about the server, and the flags derive from the block it reports.
      const commerce = await commerceV2.getCapabilities();
      return { ...capabilities, ...deriveLegacyCommerceCapabilities(commerce), commerce };
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
    ...(commerceV2 === undefined ? {} : { commerceV2 }),
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

/**
 * The webview provider's order source over the server bridge: the paid orders
 * the server lists as available purchases, mapped back to orders (the
 * provider rebuilds the purchases under its own store id), and the
 * availability the server reports. `COMMERCE_V2_UNAVAILABLE` from a bridge
 * without the commerce handler is `configuration-required`; another bridge
 * failure that is retryable (or the transport failing) keeps the availability
 * the server last answered for the capability read (`temporarily-unavailable`
 * before any answer; a non-retryable failure or an invalid answer fails
 * closed) and is
 * a `CommerceError` for a list read (`NETWORK` for a transport failure,
 * otherwise `UNKNOWN` with the bridge code as `storeCode`).
 */
export function createDevvitBridgeOrderSource(
  request: <TData>(method: BridgeMethod, payload: unknown) => Promise<TData>,
): DevvitOrderSource {
  /** The availability the server last answered; kept across transient read failures. */
  let lastAvailability: PlatformProviderAvailability | undefined;
  return {
    async listPaidOrders(): Promise<readonly DevvitPaidOrder[]> {
      let data: unknown;
      try {
        data = await request<unknown>('commerce.v2.getAvailablePurchases', {});
      } catch (error) {
        throw toCommerceError(error);
      }
      let purchases;
      try {
        purchases = assertCommerceBridgeGetAvailablePurchasesResult(data).purchases;
      } catch (error) {
        throw new CommerceError('INVALID_RESPONSE', {
          message:
            'Devvit server bridge returned invalid data for commerce.v2.getAvailablePurchases.',
          cause: error,
        });
      }
      const orders: DevvitPaidOrder[] = [];
      for (const purchase of purchases) {
        let environment: DevvitPaidOrder['environment'];
        let delivered: boolean | undefined;
        try {
          const evidence = assertDevvitOrderEvidence(purchase.evidence);
          environment = evidence.environment;
          delivered = evidence.status === undefined ? undefined : evidence.status === 'DELIVERED';
        } catch {
          // The server listed an order under another evidence schema; the
          // order itself is still the server's word.
          environment = undefined;
        }
        orders.push({
          orderId: purchase.transactionId,
          sku: purchase.storeSku,
          ...(purchase.purchasedAt === undefined ? {} : { paidAt: purchase.purchasedAt }),
          ...(environment === undefined ? {} : { environment }),
          ...(delivered === undefined ? {} : { delivered }),
        });
      }
      return orders;
    },
    async getAvailability(): Promise<PlatformProviderAvailability> {
      let data: unknown;
      try {
        data = await request<unknown>('commerce.v2.getCapabilities', { protocol: commerceProtocol });
      } catch (error) {
        if (
          error instanceof DevvitBridgeError
          && error.code === commerceV2UnavailableBridgeErrorCode
        ) {
          // The server does not serve commerce v2: fail closed, whatever it answered before.
          lastAvailability = undefined;
          return 'configuration-required';
        }
        if (isTransientBridgeFailure(error)) {
          // A retryable failure keeps the last answer the server gave, so one
          // timed-out read does not hide the shop; the first read fails closed.
          return lastAvailability ?? 'temporarily-unavailable';
        }
        // Anything else is not transient: fail closed and forget the old answer.
        lastAvailability = undefined;
        return 'temporarily-unavailable';
      }
      try {
        lastAvailability = assertCommerceBridgeGetCapabilitiesResult(data).capabilities.availability;
        return lastAvailability;
      } catch {
        // The server answered something the contract rejects: fail closed.
        lastAvailability = undefined;
        return 'temporarily-unavailable';
      }
    },
  };
}

/**
 * A bridge failure as a commerce error: a closed server
 * (`COMMERCE_V2_UNAVAILABLE`) is `CONFIGURATION_REQUIRED`, a transport failure
 * (`DEVVIT_BRIDGE_NETWORK_ERROR`) is `NETWORK`, a v2 code is kept, and any
 * other bridge code is `UNKNOWN` with the code as `storeCode`.
 */
/** A retryable bridge error, or the oRPC transport failing: the server may answer again shortly. */
function isTransientBridgeFailure(error: unknown): boolean {
  if (error instanceof DevvitBridgeError) {
    return error.retryable || error.code === devvitBridgeNetworkErrorCode;
  }
  return error instanceof PlatformOperationError && error.retryable;
}

function toCommerceError(error: unknown): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  if (error instanceof DevvitBridgeError || error instanceof PlatformOperationError) {
    const code: CommerceErrorCode = error.code === commerceV2UnavailableBridgeErrorCode
      ? 'CONFIGURATION_REQUIRED'
      : error.code === devvitBridgeNetworkErrorCode
        ? 'NETWORK'
        : isCommerceErrorCode(error.code)
          ? error.code
          : 'UNKNOWN';
    return new CommerceError(code, {
      message: error.message,
      retryable: code === 'NETWORK' ? true : error.retryable,
      ...(code === error.code ? {} : { storeCode: error.code }),
      cause: error,
    });
  }
  return new CommerceError('UNKNOWN', {
    message: `Devvit server bridge request failed: ${errorMessage(error)}`,
    cause: error,
  });
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
          devvitBridgeNetworkErrorCode,
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
            remoteLeaderboard: false,
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

        // Commerce v2 providers arrive with the B-phase PRs (B6 for Devvit).
        case 'commerce.v2.getCapabilities':
        case 'commerce.v2.fetchProducts':
        case 'commerce.v2.requestPurchase':
        case 'commerce.v2.getAvailablePurchases':
        case 'commerce.v2.finishTransaction':
        case 'commerce.v2.restorePurchases':
          return createCommerceV2UnavailableBridgeError(input, 'Devvit sandbox bridge');

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

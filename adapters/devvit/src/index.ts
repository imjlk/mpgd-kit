import {
  bridgeStorageLoadProtocol,
  commerceV2UnavailableBridgeErrorCode,
  createBridgeError,
  createCommerceV2UnavailableBridgeError,
  createNotificationsV2UnavailableBridgeError,
  decodeBridgeStorageLoadData,
  isBridgeNotificationsV2Method,
  type BridgeMethod,
  type BridgeNotificationsV2Method,
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
  createUnsupportedCommerceCapabilities,
  PlatformOperationError,
  type IdentitySession,
  type IdentityUpgradeResult,
  type InboundShare,
  type LaunchIntent,
  type NotificationSubscriptionAdapter,
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
  isCommerceErrorCode,
  type CommerceErrorCode,
  type CommerceProvider,
} from '@mpgd/platform/commerce';
import type { NotificationCapabilities, NotificationProvider } from '@mpgd/platform/notifications';
import { withShareIntentCheck } from '@mpgd/platform/routes';

import { assertDevvitOrderEvidence, type DevvitPaidOrder } from './commerce-contract.js';
import {
  createDevvitDegradedNotificationCapabilities,
  devvitNotificationProviderId,
} from './notifications-contract.js';
import {
  createDevvitCommerceProvider,
  type CreateDevvitCommerceProviderInput,
  type DevvitOrderSource,
} from './commerce-provider.js';

export * from './commerce-contract.js';
export * from './commerce-provider.js';
export * from './payments.js';
export * from './catalog-products.js';
export * from './notifications-contract.js';

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

/**
 * What `runtime.getCapabilities` may still carry from a server built before
 * the boolean commerce flags were removed: the gateway drops those keys and
 * owns the `commerce` block itself.
 */
type DevvitServerCapabilities = Omit<PlatformCapabilities, 'commerce'> & {
  readonly nativeIap?: unknown;
  readonly subscriptionIap?: unknown;
  readonly commerce?: unknown;
};

export interface DevvitPlatformGatewayOptions {
  readonly appVersion: string;
  readonly buildId: string;
  readonly bridge?: DevvitBridge;
  readonly fallbackBridge?: DevvitBridge;
  readonly rpcEndpoint?: BridgeRpcEndpoint;
  /**
   * Installs the commerce provider (`createDevvitCommerceProvider`) as the
   * gateway's `commerce`, and its capability block as the snapshot's
   * `commerce`. Absent, the gateway sells nothing: it has no `commerce` and
   * reports `createUnsupportedCommerceCapabilities()`, whatever the server
   * snapshot says.
   *
   * A purchase is granted by the backend ledger only: the fulfillment handler
   * writes the ledger entry, and the backend's `devvit.order.v1` lookup
   * verifier answers the reconciler's verify request from it. Owned
   * entitlements come from that ledger through `@mpgd/game-services`, not
   * from the payments client.
   */
  readonly commerce?: DevvitGatewayCommerceOptions;
  /**
   * Exposes notifications v2 (`notificationsV2`) over the server bridge,
   * which serves the game-rendered opt-in from
   * `createDevvitNotificationsV2BridgeHandler` (`@mpgd/adapter-devvit/server`),
   * and serves the v1 `notifications` adapter from the same provider.
   * Absent, the gateway offers no `notificationsV2` and keeps the server's
   * v1 answers. Notifications are a gated beta: the target config keeps
   * `integrations.notifications` at `approval-required` until Reddit
   * approves the app, which hides both from the game.
   */
  readonly notifications?: DevvitGatewayNotificationsOptions;
  /**
   * The webview's Reddit login prompt (`createDevvitWebLoginPrompt()` from
   * `@mpgd/adapter-devvit/web`). With it, `identity.requestUpgrade` shows the
   * prompt to a logged-out viewer and answers `reloadExpected: true`, since
   * Reddit reloads the post after login; a logged-in viewer gets the
   * server's `completed` answer. Without it, the server answers alone.
   */
  readonly loginPrompt?: DevvitLoginPrompt;
}

export interface DevvitGatewayNotificationsOptions {
  /** The topic ids the catalog maps for the `reddit` target; v1 reads any other as `configuration-required`. */
  readonly topics: readonly string[];
  /** The webview's IANA zone for the registration; `Intl` by default. */
  readonly timeZone?: () => string | undefined;
  /** The webview's locale for the registration; `navigator.language` by default. */
  readonly locale?: () => string | undefined;
  /** Loads the notifications client chunk; the dynamic import by default. Tests inject it. */
  readonly load?: () => Promise<DevvitNotificationClientModule>;
}

/** What the gateway uses from the notifications client chunk. */
export type DevvitNotificationClientModule = Pick<
  typeof import('./notifications-client.js'),
  'createDevvitBridgeNotificationProvider' | 'createDevvitNotificationSubscriptionAdapter'
>;

/** Opens Reddit's login or sign-up flow (`showLoginPrompt` from `@devvit/web/client`). */
export interface DevvitLoginPrompt {
  showLoginPrompt(): void;
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

  const commerce: CommerceProvider | undefined = input.commerce === undefined
    ? undefined
    : createDevvitCommerceProvider({
        ...input.commerce,
        orders: createDevvitBridgeOrderSource(request),
      });

  const notificationSurface = input.notifications === undefined
    ? undefined
    : createLazyDevvitNotificationSurface(input.notifications, (method, payload) =>
        request<unknown>(method, payload),
      );
  const notificationsV2 = notificationSurface?.notificationsV2;

  return {
    target: 'reddit',
    async getCapabilities() {
      const {
        nativeIap: _nativeIap,
        subscriptionIap: _subscriptionIap,
        commerce: _serverCommerce,
        ...capabilities
      } = await request<DevvitServerCapabilities>('runtime.getCapabilities', {});
      const availability = capabilities.providerAvailability;
      if (typeof availability === 'object' && availability !== null && !Array.isArray(availability)) {
        const {
          nativeIap: _retiredNativeIap,
          subscriptionIap: _retiredSubscriptionIap,
          ...current
        } = availability as Readonly<Record<string, unknown>>;
        capabilities.providerAvailability = current as NonNullable<PlatformCapabilities['providerAvailability']>;
      }
      // The webview provider owns the block: the server snapshot stays honest
      // about the server, and a gateway without a provider sells nothing.
      const {
        notifications: _serverNotifications,
        ...withCommerce
      } = {
        ...capabilities,
        commerce: commerce === undefined
          ? createUnsupportedCommerceCapabilities()
          : await commerce.getCapabilities(),
      } as PlatformCapabilities;
      if (notificationsV2 === undefined) {
        return withCommerce;
      }
      // The block is present exactly when the gateway exposes notificationsV2,
      // and the push readiness follows it.
      const notifications = await readNotificationCapabilities(notificationsV2);
      return {
        ...withCommerce,
        providerAvailability: {
          ...withCommerce.providerAvailability,
          pushNotifications: notifications.availability,
        },
        notifications,
      };
    },
    identity: {
      getPlayer: () => request<PlayerIdentity | null>('identity.getPlayer', {}),
      getSession: () => request<IdentitySession>('identity.getSession', {}),
      requestUpgrade: async (payload) => {
        const answer = await request<IdentityUpgradeResult>('identity.requestUpgrade', payload);
        if (input.loginPrompt === undefined || answer.status === 'completed') {
          return answer;
        }
        // A logged-out viewer: Reddit's login flow reloads the post afterwards.
        try {
          input.loginPrompt.showLoginPrompt();
        } catch {
          return { status: 'unavailable', reloadExpected: false };
        }
        return { status: 'completed', reloadExpected: true };
      },
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
    // v1 is served from the v2 provider whenever the gateway exposes v2, so
    // the two report the same readiness.
    notifications: notificationSurface?.notifications ?? {
      getStatus: (topic) =>
        request<NotificationSubscriptionStatus>('notifications.getStatus', { topic }),
      requestSubscription: (topic) =>
        request<NotificationSubscriptionResult>('notifications.requestSubscription', { topic }),
    },
    ...(commerce === undefined ? {} : { commerce }),
    ...(notificationsV2 === undefined ? {} : { notificationsV2 }),
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
 * Notifications v2 and the v1 adapter served from it, with the client chunk
 * (the bridge provider and the `@mpgd/bridge/notifications` validators)
 * loaded on first use, so a game that does not opt in carries none of it. A
 * chunk that fails to load rejects with a retryable
 * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and the next call loads again.
 * Devvit pushes no notifications events, so `subscribe` attaches nothing.
 */
function createLazyDevvitNotificationSurface(
  options: DevvitGatewayNotificationsOptions,
  request: (method: BridgeNotificationsV2Method, payload: unknown) => Promise<unknown>,
): { readonly notificationsV2: NotificationProvider; readonly notifications: NotificationSubscriptionAdapter } {
  const importClient = options.load ?? (() => import('./notifications-client.js'));
  const topics = [...options.topics];
  let loading: Promise<{
    readonly provider: NotificationProvider;
    readonly v1: NotificationSubscriptionAdapter;
  }> | undefined;
  const load = () => {
    loading ??= importClient().then(
      (module) => {
        const provider = module.createDevvitBridgeNotificationProvider({
          request,
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
          ...(options.locale === undefined ? {} : { locale: options.locale }),
        });
        return { provider, v1: module.createDevvitNotificationSubscriptionAdapter(provider, topics) };
      },
      (error: unknown) => {
        loading = undefined;
        throw new PlatformOperationError({
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          message: `The Devvit notifications client did not load: ${errorMessage(error)}`,
          retryable: true,
        });
      },
    );
    return loading;
  };
  const provider = async (): Promise<NotificationProvider> => (await load()).provider;
  return {
    notificationsV2: {
      provider: devvitNotificationProviderId,
      getCapabilities: async () => (await provider()).getCapabilities(),
      getPermission: async (input) => (await provider()).getPermission(input),
      requestPermission: async (input) => (await provider()).requestPermission(input),
      revokePermission: async (input) => {
        const loaded = await provider();
        return (loaded.revokePermission as NonNullable<NotificationProvider['revokePermission']>)
          .call(loaded, input);
      },
      register: async () => (await (await provider()).register?.()) ?? null,
      subscribe: () => () => {},
    },
    notifications: {
      getStatus: async (topic) => (await load()).v1.getStatus(topic),
      requestSubscription: async (topic) => (await load()).v1.requestSubscription(topic),
    },
  };
}

/** Bound on one notifications capability read, as `withTargetAvailability` bounds it. */
const notificationCapabilityReadTimeoutMs = 3_000;

/** Failures the same server answers the same way again; `@mpgd/target-config` reads them as unsupported. */
const unsupportedNotificationReadCodes: ReadonlySet<unknown> = new Set([
  'NOTIFICATIONS_V2_UNAVAILABLE',
  'NOTIFICATIONS_UNSUPPORTED',
  'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
]);

/**
 * One bounded read of the provider's block. The provider validated it, so
 * it is a fresh, exact block; a read that fails or stalls yields a block
 * that offers nothing, with the availability that explains why.
 */
async function readNotificationCapabilities(
  provider: NotificationProvider,
): Promise<NotificationCapabilities> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.getCapabilities(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Notification capabilities read timed out.')),
          notificationCapabilityReadTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const failure = typeof error === 'object' && error !== null
      ? error as { readonly code?: unknown; readonly retryable?: unknown }
      : {};
    let availability: NotificationCapabilities['availability'] = 'temporarily-unavailable';
    if (failure.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED') {
      availability = 'configuration-required';
    } else if (failure.retryable !== true && unsupportedNotificationReadCodes.has(failure.code)) {
      availability = 'unsupported';
    }
    return createDevvitDegradedNotificationCapabilities(availability);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
      // Notifications v2 arrives with the Devvit provider (P3); until then
      // every v2 method answers the dedicated code.
      if (isBridgeNotificationsV2Method(input.method)) {
        return createNotificationsV2UnavailableBridgeError(input, 'Devvit sandbox bridge');
      }
      switch (input.method) {
        case 'runtime.getCapabilities':
          return ok(input, {
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
            commerce: createUnsupportedCommerceCapabilities(),
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

        // The sandbox sells nothing: every commerce method fails closed.
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

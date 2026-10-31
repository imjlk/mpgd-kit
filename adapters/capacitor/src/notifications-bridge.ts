import {
  bridgeNotificationsEventProtocol,
  type BridgeEvent,
  type BridgeNotificationsEvent,
  type BridgeNotificationsV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import {
  assertBridgeNotificationsV2Payload,
  assertBridgeNotificationsV2Result,
  createNotificationsV2BridgeHandler,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
} from '@mpgd/bridge/notifications';
import { PlatformOperationError, type NotificationSubscriptionAdapter } from '@mpgd/platform';
import {
  assertNotificationEventEnvelope,
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocol,
  notificationsProtocolVersion,
  toNotificationSubscriptionAdapter,
  type NotificationCapabilities,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationProviderId,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import { namesOtherProtocol } from './bridge-events.js';
import { isThrownInstance, readThrownField, thrownMessage } from './thrown-values.js';
import type {
  CapacitorNotificationServiceProvider,
  CapacitorNotificationsV2Service,
} from './providers.js';

// The bridge side of notifications v2 on Capacitor (notifications RFC "Bridge
// and versioning"): an in-process `NativeBridge` that serves a
// `NotificationProvider`, the registry entry the gateway reads, and the
// game-facing provider over the gateway's request path. Every payload and
// answer is validated with `@mpgd/bridge/notifications` on both sides.

export interface NotificationProviderBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /** Delivers `{ protocol: 'mpgd.notifications.v2', sequence, event }`, numbered from 0. */
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}

export interface CreateNotificationProviderBridgeInput {
  readonly provider: NotificationProvider;
}

/**
 * In-process `NativeBridge` over a notifications v2 provider:
 * `createNotificationsV2BridgeHandler` from `@mpgd/bridge/notifications`.
 * Each `notifications.v2.*` request validates its payload (a payload the
 * contract rejects answers `NOTIFICATIONS_INVALID_INPUT`) and its answer (one
 * the contract rejects answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`, because
 * the provider broke it). A method the provider does not implement answers
 * `NOTIFICATIONS_UNSUPPORTED`, except `openSettings`, which answers
 * `unavailable`. Events go out through `createBridgeEventSource`, which
 * attaches to the provider only for the first listener, so events the
 * provider buffered reach it. Any other method answers `UNSUPPORTED_METHOD`.
 */
export function createNotificationProviderBridge(
  input: CreateNotificationProviderBridgeInput,
): NotificationProviderBridge {
  return createNotificationsV2BridgeHandler({ provider: input.provider });
}

/** The payload as the contract reads it, or `NOTIFICATIONS_INVALID_INPUT`, before the game side sends it. */
function checkedPayload(method: BridgeNotificationsV2Method, payload: unknown): unknown {
  try {
    return assertBridgeNotificationsV2Payload(method, payload);
  } catch (error) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: `${method} payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}

export interface CreateNotificationServiceProviderInput {
  readonly id: string;
  readonly notifications: NotificationProvider;
  /**
   * The topics resolved for the target, as the provider was created with
   * them: the v1 adapter answers `configuration-required` for a topic outside
   * them, and so for an entry that still carries a catalog's `targets`,
   * which names no single target.
   */
  readonly topics: readonly Pick<NotificationTopicDeclaration, 'id'>[];
}

/**
 * Registry entry for a notifications v2 provider, as
 * `createCommerceServiceProvider` is for commerce: it declares no feature and
 * no method, the nine `notifications.v2.*` methods are implied and served in
 * process by `createNotificationProviderBridge`, and the gateway exposes
 * `notificationsV2` and a v1 `notifications` adapter served from it.
 */
export function createNotificationServiceProvider(
  input: CreateNotificationServiceProviderInput,
): CapacitorNotificationServiceProvider {
  const { notifications } = input;
  // Copied entry by entry, `targets` included: an entry that still carries
  // one names no single target, and the v1 adapter counts it as outside.
  const topics = input.topics.map((topic) => ({ ...topic }));
  const service: CapacitorNotificationsV2Service = {
    async getCapabilities() {
      return copyCapabilities(assertBridgeNotificationsV2Result('notifications.v2.getCapabilities', {
        protocolVersion: notificationsProtocolVersion,
        provider: notifications.provider,
        capabilities: await notifications.getCapabilities(),
      }).capabilities);
    },
    assertResult(method, data) {
      assertBridgeNotificationsV2Result(method, data);
    },
    createGatewaySurface({ request, subscribe }) {
      const client = createBridgeNotificationProvider({
        provider: notifications.provider,
        serves: {
          revokePermission: notifications.revokePermission !== undefined,
          register: notifications.register !== undefined,
          local: notifications.scheduleLocal !== undefined
            && notifications.cancelLocal !== undefined
            && notifications.listLocal !== undefined,
        },
        request,
        subscribe,
      });
      return {
        notificationsV2: client,
        notifications: createNotificationSubscriptionAdapter(client, topics),
      };
    },
  };
  return {
    id: input.id,
    features: [],
    methods: [],
    notificationsV2: service,
    bridge: createNotificationProviderBridge({ provider: notifications }),
    async getAvailability() {
      return {};
    },
  };
}

/**
 * The v1 `NotificationSubscriptionAdapter` served from a v2 provider whose
 * host is readable (RFC "Migration and PR plan" table, through
 * `toNotificationSubscriptionAdapter`): every state comes from the host, a
 * topic outside `topics` reads `configuration-required` and requests
 * `unavailable`.
 */
export function createNotificationSubscriptionAdapter(
  provider: Pick<NotificationProvider, 'getPermission' | 'requestPermission'>,
  topics: readonly Pick<NotificationTopicDeclaration, 'id'>[],
): NotificationSubscriptionAdapter {
  return toNotificationSubscriptionAdapter(
    {
      async getPermission(input) {
        const snapshot = await provider.getPermission(input);
        return {
          ...snapshot,
          sources: Object.fromEntries(Object.keys(snapshot.topics).map((topic) => [topic, 'host'])),
        };
      },
      requestPermission: ({ topics: requested }) =>
        provider.requestPermission({ topics: requested }),
    },
    topics,
  );
}

// Client side.

export interface CreateBridgeNotificationProviderInput {
  readonly provider: NotificationProviderId;
  /** The optional methods the serving provider implements; `openSettings` is always present. */
  readonly serves: {
    readonly revokePermission: boolean;
    readonly register: boolean;
    /** `scheduleLocal`, `cancelLocal`, and `listLocal`. */
    readonly local: boolean;
  };
  /** Sends one bridge request; the gateway's `request` fits. */
  readonly request: <TData>(method: BridgeNotificationsV2Method, payload: unknown) => Promise<TData>;
  readonly subscribe: (listener: (event: BridgeNotificationsEvent) => void) => () => void;
}

/**
 * `NotificationProvider` over a bridge that serves the `notifications.v2.*`
 * methods and the event envelope. Answers are validated again on this side,
 * so a transport that forgets to stays fail-closed. A bridge failure becomes
 * a `NotificationError`: one with a notifications code keeps it, anything
 * else is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with the failure's
 * retryable flag. An answer the contract rejects is
 * `NOTIFICATIONS_CONFIGURATION_REQUIRED`, which is not retryable, because the
 * provider broke the contract. An event envelope that
 * names another protocol is skipped; a malformed one is dropped with a
 * warning, because it carries nothing the game could route.
 *
 * Events reach the listeners subscribed when they arrive. The Capacitor
 * provider keeps events that arrive while no listener is attached for the
 * next subscriber, so a game that subscribes per scene loses no open.
 */
export function createBridgeNotificationProvider(
  input: CreateBridgeNotificationProviderInput,
): NotificationProvider {
  const send = async <TMethod extends BridgeNotificationsV2Method>(
    method: TMethod,
    payload: BridgeNotificationsV2Payload<TMethod>,
  ): Promise<BridgeNotificationsV2Result<TMethod>> => {
    // Checked here too, so a payload the contract rejects never pauses the
    // game for a request that cannot succeed.
    checkedPayload(method, payload);
    let data: unknown;
    try {
      data = await input.request<unknown>(method, payload);
    } catch (error) {
      throw toNotificationError(error);
    }
    try {
      return assertBridgeNotificationsV2Result(method, data);
    } catch (error) {
      // The provider broke the contract; a retry would not change that.
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: `Bridge returned invalid data for ${method}.`,
        cause: error,
      });
    }
  };
  const protocol = { protocol: notificationsProtocol } as const;
  return {
    provider: input.provider,
    async getCapabilities() {
      return (await send('notifications.v2.getCapabilities', protocol)).capabilities;
    },
    // Async, so wrong input from a caller outside TypeScript rejects instead
    // of throwing synchronously.
    getPermission: async (request) => send('notifications.v2.getPermission', topicsPayload(request)),
    requestPermission: async (request) =>
      send('notifications.v2.requestPermission', topicsPayload(request)),
    ...(input.serves.revokePermission
      ? {
          revokePermission: async (request) =>
            send('notifications.v2.revokePermission', topicsPayload(request)),
        }
      : {}),
    ...(input.serves.register
      ? {
          async register() {
            return (await send('notifications.v2.register', protocol)).registration;
          },
        }
      : {}),
    ...(input.serves.local
      ? {
          scheduleLocal: (request) => send('notifications.v2.scheduleLocal', request),
          async cancelLocal(request) {
            // A missing list stays missing, so the payload check rejects it.
            await send('notifications.v2.cancelLocal', {
              keys: request?.keys as readonly string[],
            });
          },
          async listLocal() {
            return (await send('notifications.v2.listLocal', protocol)).pending;
          },
        }
      : {}),
    async openSettings() {
      return (await send('notifications.v2.openSettings', protocol)).status;
    },
    subscribe(listener: (event: NotificationEvent) => void) {
      return input.subscribe((envelope) => {
        if (namesOtherProtocol(envelope, bridgeNotificationsEventProtocol)) {
          return;
        }
        let event: NotificationEvent;
        try {
          event = assertNotificationEventEnvelope(envelope).event;
        } catch (error) {
          console.warn('Dropped an invalid notifications event from the bridge.', error);
          return;
        }
        listener(event);
      });
    },
  } satisfies NotificationProvider;
}

/**
 * Only `topics` crosses, since the payload validator refuses unknown keys. A
 * missing request or list stays missing on purpose: the cast lets `send`'s
 * payload validator reject it as `NOTIFICATIONS_INVALID_INPUT`.
 */
function topicsPayload(request: { readonly topics: readonly string[] } | undefined): {
  readonly topics: readonly string[];
} {
  return { topics: request?.topics as readonly string[] };
}

function toNotificationError(error: unknown): NotificationError {
  if (isThrownInstance(error, NotificationError)) {
    return error;
  }
  // A field whose getter or Proxy trap throws counts as missing.
  const code = readThrownField(error, 'code');
  const retryable = readThrownField(error, 'retryable');
  const options = {
    ...(isThrownInstance(error, Error) ? { message: thrownMessage(error) } : {}),
    // A transport failure keeps its retryability.
    ...(isThrownInstance(error, PlatformOperationError) && typeof retryable === 'boolean' ? { retryable } : {}),
    cause: error,
  };
  return new NotificationError(
    isNotificationErrorCode(code) ? code : 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    options,
  );
}

/** A field-by-field copy, so the gateway never hands out a provider-owned block. */
function copyCapabilities(capabilities: NotificationCapabilities): NotificationCapabilities {
  const { permission, remote, local } = capabilities;
  return {
    availability: capabilities.availability,
    permission: {
      scope: permission.scope,
      prompt: permission.prompt,
      readable: permission.readable,
      serverReadable: permission.serverReadable,
      allowance: permission.allowance,
      userGesture: permission.userGesture,
      ...(permission.promptLimit === undefined ? {} : { promptLimit: permission.promptLimit }),
      ...(permission.maxTopicsPerPrompt === undefined
        ? {}
        : { maxTopicsPerPrompt: permission.maxTopicsPerPrompt }),
      settings: permission.settings,
    },
    remote: {
      supported: remote.supported,
      purposes: [...remote.purposes],
      addressing: remote.addressing,
      content: remote.content,
    },
    local: {
      supported: local.supported,
      ...(local.maxPending === undefined ? {} : { maxPending: local.maxPending }),
    },
    open: capabilities.open,
  };
}

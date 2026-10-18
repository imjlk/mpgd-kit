import {
  bridgeNotificationsEventProtocol,
  createBridgeError,
  createBridgeEventSource,
  isBridgeNotificationsV2Method,
  type BridgeEvent,
  type BridgeNotificationsEvent,
  type BridgeNotificationsV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import {
  assertBridgeNotificationsV2Payload,
  assertBridgeNotificationsV2Result,
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
 * In-process `NativeBridge` over a notifications v2 provider. Each
 * `notifications.v2.*` request validates its payload (a payload the contract
 * rejects answers `NOTIFICATIONS_INVALID_INPUT`) and its answer (one the
 * contract rejects answers `NATIVE_PROVIDER_INVALID_RESPONSE`). A method the
 * provider does not implement answers `NOTIFICATIONS_UNSUPPORTED`, except
 * `openSettings`, which answers `unavailable`. Events go out through
 * `createBridgeEventSource`, which attaches to the provider only for the
 * first listener, so events the provider buffered reach it. Any other method
 * answers `UNSUPPORTED_METHOD`.
 */
export function createNotificationProviderBridge(
  input: CreateNotificationProviderBridgeInput,
): NotificationProviderBridge {
  const { provider } = input;
  const events = createBridgeEventSource(bridgeNotificationsEventProtocol, provider);

  const serve = async (method: BridgeNotificationsV2Method, payload: unknown): Promise<unknown> => {
    let checked: unknown;
    try {
      checked = assertBridgeNotificationsV2Payload(method, payload);
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
        message: `${method} payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    switch (method) {
      case 'notifications.v2.getCapabilities':
        return {
          protocolVersion: notificationsProtocolVersion,
          provider: provider.provider,
          capabilities: await provider.getCapabilities(),
        };
      case 'notifications.v2.getPermission':
        return provider.getPermission(
          checked as BridgeNotificationsV2Payload<'notifications.v2.getPermission'>,
        );
      case 'notifications.v2.requestPermission':
        return provider.requestPermission(
          checked as BridgeNotificationsV2Payload<'notifications.v2.requestPermission'>,
        );
      case 'notifications.v2.revokePermission':
        return implemented(provider.revokePermission, method).call(
          provider,
          checked as BridgeNotificationsV2Payload<'notifications.v2.revokePermission'>,
        );
      case 'notifications.v2.register':
        return { registration: await implemented(provider.register, method).call(provider) };
      case 'notifications.v2.scheduleLocal':
        return implemented(provider.scheduleLocal, method).call(
          provider,
          checked as BridgeNotificationsV2Payload<'notifications.v2.scheduleLocal'>,
        );
      case 'notifications.v2.cancelLocal':
        await implemented(provider.cancelLocal, method).call(
          provider,
          checked as BridgeNotificationsV2Payload<'notifications.v2.cancelLocal'>,
        );
        return { cancelled: true };
      case 'notifications.v2.listLocal':
        return { pending: await implemented(provider.listLocal, method).call(provider) };
      case 'notifications.v2.openSettings':
        return {
          status: provider.openSettings === undefined
            ? 'unavailable'
            : await provider.openSettings(),
        };
    }
  };

  return {
    async request(request) {
      if (!isBridgeNotificationsV2Method(request.method)) {
        return createBridgeError(
          request.id,
          'UNSUPPORTED_METHOD',
          `${request.method} is not a notifications v2 method.`,
        );
      }
      const method = request.method;
      let data: unknown;
      try {
        data = await serve(method, request.payload);
      } catch (error) {
        return toBridgeError(request, error);
      }
      try {
        return { id: request.id, ok: true, data: assertBridgeNotificationsV2Result(method, data) };
      } catch (error) {
        return createBridgeError(
          request.id,
          'NATIVE_PROVIDER_INVALID_RESPONSE',
          `Notifications provider returned invalid data for ${method}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    subscribe: (listener) => events.subscribe(listener),
  };
}

function implemented<TMethod extends (...args: never[]) => unknown>(
  method: TMethod | undefined,
  name: BridgeNotificationsV2Method,
): TMethod {
  if (method === undefined) {
    throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
      message: `The notifications provider does not implement ${name}.`,
    });
  }
  return method;
}

function toBridgeError(request: BridgeRequest, error: unknown): BridgeResponse {
  if (error instanceof PlatformOperationError) {
    // A host code kept with `NOTIFICATIONS_CONFIGURATION_REQUIRED` crosses in
    // the message: the bridge error has no field for it.
    const hostCode = error instanceof NotificationError ? error.hostCode : undefined;
    return createBridgeError(
      request.id,
      error.code,
      hostCode === undefined ? error.message : `${error.message} (host code ${hostCode})`,
      error.retryable,
    );
  }
  return createBridgeError(
    request.id,
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    `${request.method} failed: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

export interface CreateNotificationServiceProviderInput {
  readonly id: string;
  readonly notifications: NotificationProvider;
  /**
   * The topics resolved for the target, as the provider was created with
   * them: the v1 adapter answers `configuration-required` for a topic outside
   * them.
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
  // As given: an entry that still carries a catalog's `targets` names no
  // single target, and the v1 adapter counts it as outside.
  const topics = [...input.topics];
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
 * else is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`. An event envelope that
 * names another protocol is skipped; a malformed one is dropped with a
 * warning, because it carries nothing the game could route.
 *
 * Events reach the listeners subscribed when they arrive. The provider
 * buffers only until its first subscriber, so an event that arrives while no
 * listener is attached is not kept: the consumer, the notifications runtime,
 * subscribes once for its life and buffers for the game itself (RFC
 * "Runtime").
 */
export function createBridgeNotificationProvider(
  input: CreateBridgeNotificationProviderInput,
): NotificationProvider {
  const send = async <TMethod extends BridgeNotificationsV2Method>(
    method: TMethod,
    payload: BridgeNotificationsV2Payload<TMethod>,
  ): Promise<BridgeNotificationsV2Result<TMethod>> => {
    let data: unknown;
    try {
      data = await input.request<unknown>(method, payload);
    } catch (error) {
      throw toNotificationError(error);
    }
    try {
      return assertBridgeNotificationsV2Result(method, data);
    } catch (error) {
      // A contract break does not go away on retry.
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `Bridge returned invalid data for ${method}.`,
        retryable: false,
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
    // Async, so input a caller outside TypeScript gets wrong rejects instead of throwing.
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
          async cancelLocal({ keys }) {
            await send('notifications.v2.cancelLocal', { keys });
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
        const protocolName: unknown = typeof envelope === 'object' && envelope !== null
          ? (envelope as { readonly protocol?: unknown }).protocol
          : undefined;
        if (typeof protocolName === 'string' && protocolName !== bridgeNotificationsEventProtocol) {
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

/** Only `topics` crosses: the payload validator refuses unknown keys, and a missing list stays missing. */
function topicsPayload(request: { readonly topics: readonly string[] } | undefined): {
  readonly topics: readonly string[];
} {
  return { topics: request?.topics as readonly string[] };
}

function toNotificationError(error: unknown): NotificationError {
  if (error instanceof NotificationError) {
    return error;
  }
  const code: unknown = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : undefined;
  if (isNotificationErrorCode(code)) {
    return new NotificationError(code, {
      ...(message === undefined ? {} : { message }),
      ...(error instanceof PlatformOperationError ? { retryable: error.retryable } : {}),
      cause: error,
    });
  }
  // A transport failure keeps its retryability: an invalid provider answer
  // (`NATIVE_PROVIDER_INVALID_RESPONSE`) is not worth retrying.
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
    ...(message === undefined ? {} : { message }),
    ...(error instanceof PlatformOperationError ? { retryable: error.retryable } : {}),
    cause: error,
  });
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

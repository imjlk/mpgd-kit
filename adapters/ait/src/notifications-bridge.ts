import {
  bridgeNotificationsEventProtocol,
  createBridgeError,
  createBridgeEventSource,
  isBridgeNotificationsV2Method,
  type BridgeEventStream,
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
import { PlatformOperationError } from '@mpgd/platform';
import {
  assertNotificationEventEnvelope,
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocol,
  notificationsProtocolVersion,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationProviderId,
} from '@mpgd/platform/notifications';

/**
 * Notifications v2 over the Apps in Toss game bridge (notifications RFC
 * "Bridge and versioning"). The host side serves the nine
 * `notifications.v2.*` methods from a `NotificationProvider` and pushes its
 * events in the `mpgd.notifications.v2` envelope; the game side is a
 * `NotificationProvider` over the installed bridge. Both sides validate every
 * payload and answer with the `@mpgd/bridge/notifications` validators. This
 * module imports no Apps in Toss SDK.
 */

export interface AitNotificationsV2BridgeHandler
  extends BridgeEventStream<BridgeNotificationsEvent> {
  /** Answers one of the nine `notifications.v2.*` methods. */
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

/**
 * Host side. A payload the validator rejects answers
 * `NOTIFICATIONS_INVALID_INPUT`, a method the provider does not implement
 * `NOTIFICATIONS_UNSUPPORTED`, and an answer the contract rejects
 * `NOTIFICATIONS_CONFIGURATION_REQUIRED`, because the provider broke it. A
 * thrown `NotificationError` crosses as `{ code, message, retryable }`, with
 * its `hostCode` named in the message. Events go out through
 * `createBridgeEventSource`, numbered per handler from 0; the provider is
 * attached for the first bridge listener, so its buffered cold open reaches
 * that listener.
 */
export function createAitNotificationsV2BridgeHandler(
  provider: NotificationProvider,
): AitNotificationsV2BridgeHandler {
  const events = createBridgeEventSource(bridgeNotificationsEventProtocol, provider);

  const serve = async (method: BridgeNotificationsV2Method, payload: unknown): Promise<unknown> => {
    switch (method) {
      case 'notifications.v2.getCapabilities':
        validPayload(method, payload);
        return {
          protocolVersion: notificationsProtocolVersion,
          provider: provider.provider,
          capabilities: await provider.getCapabilities(),
        };
      case 'notifications.v2.getPermission':
        return provider.getPermission(validPayload(method, payload));
      case 'notifications.v2.requestPermission':
        return provider.requestPermission(validPayload(method, payload));
      case 'notifications.v2.revokePermission': {
        const request = validPayload(method, payload);
        return implemented(provider.revokePermission, method).call(provider, request);
      }
      case 'notifications.v2.register':
        validPayload(method, payload);
        return { registration: (await provider.register?.()) ?? null };
      case 'notifications.v2.scheduleLocal': {
        const request = validPayload(method, payload);
        return implemented(provider.scheduleLocal, method).call(provider, request);
      }
      case 'notifications.v2.cancelLocal': {
        const request = validPayload(method, payload);
        await implemented(provider.cancelLocal, method).call(provider, request);
        return { cancelled: true };
      }
      case 'notifications.v2.listLocal':
        validPayload(method, payload);
        return { pending: await implemented(provider.listLocal, method).call(provider) };
      case 'notifications.v2.openSettings':
        validPayload(method, payload);
        return { status: (await provider.openSettings?.()) ?? 'unavailable' };
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
      try {
        const data = await serve(method, request.payload);
        return { id: request.id, ok: true, data: validResult(method, data) };
      } catch (error) {
        return toBridgeError(request, error);
      }
    },
    // The source carries this protocol only, so every envelope is a notifications one.
    subscribe: (listener) =>
      events.subscribe((envelope) => listener(envelope as BridgeNotificationsEvent)),
  };
}

class InvalidPayloadError extends Error {
  override readonly name = 'InvalidPayloadError';
}

function validPayload<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  payload: unknown,
): BridgeNotificationsV2Payload<TMethod> {
  try {
    return assertBridgeNotificationsV2Payload(method, payload);
  } catch (error) {
    throw new InvalidPayloadError(
      `${method} payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validResult<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  data: unknown,
): BridgeNotificationsV2Result<TMethod> {
  try {
    return assertBridgeNotificationsV2Result(method, data);
  } catch (error) {
    throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `The notifications provider answered ${method} with invalid data: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }
}

function implemented<TMethod>(method: TMethod | undefined, name: string): TMethod {
  if (method === undefined) {
    throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
      message: `The Apps in Toss notifications provider does not implement ${name}.`,
    });
  }
  return method;
}

function toBridgeError(request: BridgeRequest, error: unknown): BridgeResponse {
  if (error instanceof InvalidPayloadError) {
    return createBridgeError(request.id, 'NOTIFICATIONS_INVALID_INPUT', error.message);
  }
  if (error instanceof NotificationError) {
    return createBridgeError(
      request.id,
      error.code,
      error.hostCode === undefined || !hostCodeValue.test(error.hostCode)
        ? error.message
        : `${error.message} (host code ${error.hostCode})`,
      error.retryable,
    );
  }
  if (error instanceof PlatformOperationError) {
    return isNotificationErrorCode(error.code)
      ? createBridgeError(request.id, error.code, error.message, error.retryable)
      : createBridgeError(
          request.id,
          'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          `${request.method} failed: ${error.message}`,
          error.retryable,
        );
  }
  // A failure the provider did not normalize is a host failure the game may retry.
  return createBridgeError(
    request.id,
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    `${request.method} failed: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

// Game side.

export interface CreateAitBridgeNotificationProviderInput {
  /** The provider id the host serves; `apps-in-toss` for the Apps in Toss host. */
  readonly provider: NotificationProviderId;
  /** Sends one bridge request and returns its data; bridge errors reject as `PlatformOperationError`. */
  readonly request: (method: BridgeNotificationsV2Method, payload: unknown) => Promise<unknown>;
  readonly subscribe: (listener: (event: BridgeNotificationsEvent) => void) => () => void;
}

/**
 * `NotificationProvider` over a bridge that serves the `notifications.v2.*`
 * methods and the event envelope. It offers what the Apps in Toss profile
 * has: reads, requests, the `platform-user` registration, and the settings
 * answer, but no local notifications and no revocation. Answers are validated
 * again here, so a transport that skips validation stays fail-closed. A
 * bridge error with a `NOTIFICATIONS_*` code becomes a `NotificationError`
 * with that code and the host code the message names;
 * `UNSUPPORTED_METHOD` or `INVALID_BRIDGE_REQUEST` from a host that predates
 * the methods becomes `NOTIFICATIONS_V2_UNAVAILABLE`; any other failure
 * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, retryable unless the failure says
 * otherwise. An event envelope of another
 * protocol is ignored, and an invalid one is dropped with a warning.
 */
export function createAitBridgeNotificationProvider(
  input: CreateAitBridgeNotificationProviderInput,
): NotificationProvider {
  const send = async <TMethod extends BridgeNotificationsV2Method>(
    method: TMethod,
    payload: BridgeNotificationsV2Payload<TMethod>,
  ): Promise<BridgeNotificationsV2Result<TMethod>> => {
    let data: unknown;
    try {
      data = await input.request(method, payload);
    } catch (error) {
      throw toNotificationError(error);
    }
    try {
      return assertBridgeNotificationsV2Result(method, data);
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: `The bridge answered ${method} with invalid data.`,
        cause: error,
      });
    }
  };
  return {
    provider: input.provider,
    async getCapabilities() {
      const answer = await send('notifications.v2.getCapabilities', { protocol: notificationsProtocol });
      if (answer.provider !== input.provider) {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: `The bridge serves notifications provider ${answer.provider}, not ${input.provider}.`,
        });
      }
      return answer.capabilities;
    },
    getPermission: (request) => send('notifications.v2.getPermission', request),
    requestPermission: (request) => send('notifications.v2.requestPermission', request),
    async register() {
      return (await send('notifications.v2.register', { protocol: notificationsProtocol }))
        .registration;
    },
    async openSettings() {
      return (await send('notifications.v2.openSettings', { protocol: notificationsProtocol }))
        .status;
    },
    subscribe(listener) {
      return input.subscribe((envelope) => {
        const event = readAitBridgeNotificationEvent(envelope);
        if (event !== undefined) {
          listener(event);
        }
      });
    },
  };
}

/**
 * The event a bridge envelope carries, or `undefined` for an envelope of
 * another protocol (not ours to judge) or an invalid one (dropped with a
 * warning). An envelope without a protocol is malformed and reaches the
 * validator.
 */
export function readAitBridgeNotificationEvent(envelope: unknown): NotificationEvent | undefined {
  const protocol: unknown = typeof envelope === 'object' && envelope !== null
    ? (envelope as { readonly protocol?: unknown }).protocol
    : undefined;
  if (typeof protocol === 'string' && protocol !== bridgeNotificationsEventProtocol) {
    return undefined;
  }
  try {
    return assertNotificationEventEnvelope(envelope).event;
  } catch (error) {
    console.warn('AIT bridge delivered an invalid notifications event.', error);
    return undefined;
  }
}

/** The host codes the bridge carries; the host handler names only these in a message. */
const hostCodeCharacters = '[A-Za-z0-9_.:-]{1,128}';
const hostCodeValue = new RegExp(`^${hostCodeCharacters}$`, 'u');
const hostCodePattern = new RegExp(`\\(host code (${hostCodeCharacters})\\)$`, 'u');

function toNotificationError(error: unknown): NotificationError {
  if (error instanceof NotificationError) {
    return error;
  }
  const failure = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown }
    : {};
  const message = typeof failure.message === 'string' ? failure.message : undefined;
  // Only an explicit flag overrides the code's default: a raw transport
  // failure (a plain Error) stays retryable as NOTIFICATIONS_TEMPORARILY_UNAVAILABLE.
  const explicit = typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {};
  if (isNotificationErrorCode(failure.code)) {
    // The host handler names the host's own code in the message; it is the
    // only place a bridge error can carry it.
    const hostCode = message === undefined ? undefined : hostCodePattern.exec(message)?.[1];
    return new NotificationError(failure.code, {
      ...(message === undefined ? {} : { message }),
      ...explicit,
      ...(hostCode === undefined ? {} : { hostCode }),
      cause: error,
    });
  }
  if (failure.code === 'UNSUPPORTED_METHOD' || failure.code === 'INVALID_BRIDGE_REQUEST') {
    // A host that predates the methods.
    return new NotificationError('NOTIFICATIONS_V2_UNAVAILABLE', {
      ...(message === undefined ? {} : { message }),
      cause: error,
    });
  }
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
    ...(message === undefined ? {} : { message }),
    ...explicit,
    cause: error,
  });
}

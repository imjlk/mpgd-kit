import { PlatformOperationError, readPlatformOperationFailure } from '@mpgd/platform';
import {
  assertNotificationBridgeCancelLocalPayload,
  assertNotificationBridgeCancelLocalResult,
  assertNotificationBridgeGetCapabilitiesPayload,
  assertNotificationBridgeGetCapabilitiesResult,
  assertNotificationBridgeGetPermissionPayload,
  assertNotificationBridgeGetPermissionResult,
  assertNotificationBridgeListLocalPayload,
  assertNotificationBridgeListLocalResult,
  assertNotificationBridgeOpenSettingsPayload,
  assertNotificationBridgeOpenSettingsResult,
  assertNotificationBridgeRegisterPayload,
  assertNotificationBridgeRegisterResult,
  assertNotificationBridgeRequestPermissionPayload,
  assertNotificationBridgeRequestPermissionResult,
  assertNotificationBridgeRevokePermissionPayload,
  assertNotificationBridgeRevokePermissionResult,
  assertNotificationBridgeScheduleLocalPayload,
  assertNotificationBridgeScheduleLocalResult,
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocolVersion,
  type NotificationProvider,
} from '@mpgd/platform/notifications';

import {
  bridgeNotificationsEventProtocol,
  createBridgeError,
  createBridgeEventSource,
  isBridgeNotificationsV2Method,
  type BridgeEventStream,
  type BridgeNotificationsEvent,
  type BridgeNotificationsV2Method,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
  type BridgeRequest,
  type BridgeResponse,
} from './index.js';

// `@mpgd/bridge/notifications`: validation of notifications v2 bridge traffic
// and the host-side handler that serves it from a `NotificationProvider`
// (notifications RFC "Bridge and versioning"). A separate entry because it
// loads the `@mpgd/platform/notifications` validators, which a transport that
// only answers `NOTIFICATIONS_V2_UNAVAILABLE` does not need.

// The shapes these validators return, also exported by the main entry.
export type {
  BridgeNotificationsV2Method,
  BridgeNotificationsV2Payload,
  BridgeNotificationsV2Result,
} from './index.js';

// Each entry is the `@mpgd/platform/notifications` validator of that
// method's shape, and the interfaces check that every entry returns its own
// method's shape (a mapped type would trip the lint rule on type parameters).
interface NotificationsV2PayloadAsserts {
  readonly 'notifications.v2.getCapabilities': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.getCapabilities'>;
  readonly 'notifications.v2.getPermission': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.getPermission'>;
  readonly 'notifications.v2.requestPermission': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.requestPermission'>;
  readonly 'notifications.v2.revokePermission': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.revokePermission'>;
  readonly 'notifications.v2.register': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.register'>;
  readonly 'notifications.v2.scheduleLocal': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.scheduleLocal'>;
  readonly 'notifications.v2.cancelLocal': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.cancelLocal'>;
  readonly 'notifications.v2.listLocal': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.listLocal'>;
  readonly 'notifications.v2.openSettings': (input: unknown) => BridgeNotificationsV2Payload<'notifications.v2.openSettings'>;
}

interface NotificationsV2ResultAsserts {
  readonly 'notifications.v2.getCapabilities': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.getCapabilities'>;
  readonly 'notifications.v2.getPermission': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.getPermission'>;
  readonly 'notifications.v2.requestPermission': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.requestPermission'>;
  readonly 'notifications.v2.revokePermission': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.revokePermission'>;
  readonly 'notifications.v2.register': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.register'>;
  readonly 'notifications.v2.scheduleLocal': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.scheduleLocal'>;
  readonly 'notifications.v2.cancelLocal': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.cancelLocal'>;
  readonly 'notifications.v2.listLocal': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.listLocal'>;
  readonly 'notifications.v2.openSettings': (input: unknown) => BridgeNotificationsV2Result<'notifications.v2.openSettings'>;
}

const notificationsV2PayloadAsserts: NotificationsV2PayloadAsserts = {
  'notifications.v2.getCapabilities': assertNotificationBridgeGetCapabilitiesPayload,
  'notifications.v2.getPermission': assertNotificationBridgeGetPermissionPayload,
  'notifications.v2.requestPermission': assertNotificationBridgeRequestPermissionPayload,
  'notifications.v2.revokePermission': assertNotificationBridgeRevokePermissionPayload,
  'notifications.v2.register': assertNotificationBridgeRegisterPayload,
  'notifications.v2.scheduleLocal': assertNotificationBridgeScheduleLocalPayload,
  'notifications.v2.cancelLocal': assertNotificationBridgeCancelLocalPayload,
  'notifications.v2.listLocal': assertNotificationBridgeListLocalPayload,
  'notifications.v2.openSettings': assertNotificationBridgeOpenSettingsPayload,
};

const notificationsV2ResultAsserts: NotificationsV2ResultAsserts = {
  'notifications.v2.getCapabilities': assertNotificationBridgeGetCapabilitiesResult,
  'notifications.v2.getPermission': assertNotificationBridgeGetPermissionResult,
  'notifications.v2.requestPermission': assertNotificationBridgeRequestPermissionResult,
  'notifications.v2.revokePermission': assertNotificationBridgeRevokePermissionResult,
  'notifications.v2.register': assertNotificationBridgeRegisterResult,
  'notifications.v2.scheduleLocal': assertNotificationBridgeScheduleLocalResult,
  'notifications.v2.cancelLocal': assertNotificationBridgeCancelLocalResult,
  'notifications.v2.listLocal': assertNotificationBridgeListLocalResult,
  'notifications.v2.openSettings': assertNotificationBridgeOpenSettingsResult,
};

/**
 * Validates the payload of a notifications v2 request with the
 * `@mpgd/platform/notifications` validator for its method: unknown keys,
 * timestamps without an offset or on a date that does not exist, and routes
 * that are not root-relative are rejected. Throws what that validator throws,
 * and a `TypeError` for a method that is not a notifications v2 method.
 */
export function assertBridgeNotificationsV2Payload<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  payload: unknown,
): BridgeNotificationsV2Payload<TMethod> {
  assertNotificationsV2Method(method);
  return notificationsV2PayloadAsserts[method](payload) as BridgeNotificationsV2Payload<TMethod>;
}

/**
 * Validates the data a transport answered a notifications v2 request with,
 * as `assertBridgeNotificationsV2Payload` validates the payload.
 */
export function assertBridgeNotificationsV2Result<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  data: unknown,
): BridgeNotificationsV2Result<TMethod> {
  assertNotificationsV2Method(method);
  return notificationsV2ResultAsserts[method](data) as BridgeNotificationsV2Result<TMethod>;
}

function assertNotificationsV2Method(method: string): void {
  // A caller outside TypeScript may pass any string; an inherited key such as
  // `constructor` must not reach a lookup that would call it.
  if (!isBridgeNotificationsV2Method(method)) {
    throw new TypeError(`${method} is not a notifications v2 bridge method.`);
  }
}

/** The host side of the notifications v2 bridge for one session. */
export interface NotificationsV2BridgeHandler extends BridgeEventStream<BridgeNotificationsEvent> {
  /** Answers one of the nine `notifications.v2.*` methods; any other method answers `UNSUPPORTED_METHOD`. */
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export interface CreateNotificationsV2BridgeHandlerInput {
  readonly provider: NotificationProvider;
  /**
   * Names the provider in error messages, as in "The Apps in Toss
   * notifications provider does not implement ...". Omitted, the messages
   * say "The notifications provider".
   */
  readonly label?: string | undefined;
  /**
   * Answers `register` with `{ registration: null }` when the provider has no
   * `register`, for a host whose profile always offers the method. By
   * default such a call answers `NOTIFICATIONS_UNSUPPORTED`, as every other
   * method the provider lacks does.
   */
  readonly registerOptional?: boolean | undefined;
  /**
   * The message a failure the provider did not normalize (neither a
   * `NotificationError` nor a `PlatformOperationError`) crosses with. By
   * default `<method> failed: <its message>`; a host whose provider failures
   * can carry internal text passes a fixed one.
   */
  readonly unexpectedFailureMessage?: ((method: BridgeNotificationsV2Method) => string) | undefined;
  /**
   * Called with every failure of a notifications v2 method the handler
   * answers with an error, before the answer is built, so the provider's own
   * text can stay on the host. The caller's mistakes are not reported: an
   * invalid payload, and a method that is not a notifications v2 method
   * (answered `UNSUPPORTED_METHOD`). Synchronous; a hook that throws or
   * returns a promise or thenable that rejects changes nothing.
   */
  readonly onError?:
    | ((error: unknown, context: { readonly method: BridgeNotificationsV2Method }) => void)
    | undefined;
}

/**
 * Serves the nine `notifications.v2.*` bridge methods from a
 * `NotificationProvider` (notifications RFC "Bridge and versioning"), as the
 * Apps in Toss host, the Capacitor in-process bridge, and the Devvit server
 * do.
 *
 * - **Payloads.** Each payload is checked with
 *   `assertBridgeNotificationsV2Payload` before the provider is reached; one
 *   the contract rejects answers `NOTIFICATIONS_INVALID_INPUT`.
 * - **Answers.** `getCapabilities` answers `notificationsProtocolVersion`,
 *   the provider id, and the provider's capabilities; `cancelLocal` answers
 *   `{ cancelled: true }`; `register`, `listLocal`, and `openSettings` wrap
 *   the provider's answer. Every answer is checked with
 *   `assertBridgeNotificationsV2Result`; one the contract rejects answers
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`, not retryable, because the
 *   provider broke it.
 * - **Missing methods.** A method the provider does not implement answers
 *   `NOTIFICATIONS_UNSUPPORTED`, except `openSettings`, which answers
 *   `unavailable`, and `register` under `registerOptional`.
 * - **Failures.** A thrown `NotificationError` crosses as
 *   `{ code, message, retryable }`, its message naming a host code of
 *   `[A-Za-z0-9_.:-]{1,128}` as `(host code <code>)`, the only place a bridge
 *   error can carry it (`readBridgeNotificationsHostCode` reads it back); a
 *   host code outside that pattern is left out. Any `PlatformOperationError`
 *   with a notifications code crosses the same way. Errors are read by shape
 *   as well as by class, so a provider built against another copy of
 *   `@mpgd/platform` keeps its codes. A `PlatformOperationError` with any
 *   other code is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with its retryable
 *   flag. Anything else is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, retryable
 *   unless it carries a `retryable: false` of its own.
 * - **Events.** `subscribe` delivers the provider's events as
 *   `{ protocol: 'mpgd.notifications.v2', sequence, event }`, numbered per
 *   handler from 0, through `createBridgeEventSource`: the provider is
 *   attached for the first bridge listener only, so the events it buffered
 *   (a cold-start open) reach that listener. Create one handler per bridge
 *   session.
 */
export function createNotificationsV2BridgeHandler(
  input: CreateNotificationsV2BridgeHandlerInput,
): NotificationsV2BridgeHandler {
  const { provider } = input;
  const name = input.label === undefined || input.label.length === 0
    ? 'The notifications provider'
    : `The ${input.label} notifications provider`;
  const events = createBridgeEventSource(bridgeNotificationsEventProtocol, provider);

  const implemented = <TFunction>(method: TFunction | undefined, served: BridgeNotificationsV2Method): TFunction => {
    if (method === undefined) {
      throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
        message: `${name} does not implement ${served}.`,
      });
    }
    return method;
  };

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
      case 'notifications.v2.register': {
        validPayload(method, payload);
        if (provider.register === undefined && input.registerOptional === true) {
          return { registration: null };
        }
        return { registration: await implemented(provider.register, method).call(provider) };
      }
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
        return {
          status: provider.openSettings === undefined
            ? 'unavailable'
            : await provider.openSettings(),
        };
      default: {
        // A method added to the list without a case here fails to compile.
        const unhandled: never = method;
        throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
          message: `The notifications bridge does not serve ${String(unhandled)}.`,
        });
      }
    }
  };

  const report = (error: unknown, method: BridgeNotificationsV2Method): void => {
    if (input.onError === undefined || error instanceof InvalidPayloadError) {
      return;
    }
    try {
      const reported: unknown = input.onError(error, { method });
      if (isThenable(reported)) {
        reported.then(undefined, () => {});
      }
    } catch {
      // A failing hook never changes the answer.
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
        return { id: request.id, ok: true, data: validResult(name, method, data) };
      } catch (error) {
        report(error, method);
        return toBridgeError(request.id, method, error, input.unexpectedFailureMessage);
      }
    },
    // The source carries this protocol only, so every envelope is a notifications one.
    subscribe: (listener) =>
      events.subscribe((envelope) => listener(envelope as BridgeNotificationsEvent)),
  };
}

/** The host codes a bridge error names in its message, as `(host code <code>)`. */
const hostCodeCharacters = '[A-Za-z0-9_.:-]{1,128}';
const hostCodeValue = new RegExp(`^${hostCodeCharacters}$`, 'u');
const hostCodeSuffix = new RegExp(`\\(host code (${hostCodeCharacters})\\)$`, 'u');

/**
 * The host code a notifications v2 bridge error names at the end of its
 * message, as `createNotificationsV2BridgeHandler` writes it
 * (`... (host code <code>)`), or `undefined`. The bridge error has no field
 * for it, so a game-side client reads it back from the message.
 */
export function readBridgeNotificationsHostCode(message: string): string | undefined {
  return hostCodeSuffix.exec(message)?.[1];
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
    throw new InvalidPayloadError(`${method} payload is invalid: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function validResult<TMethod extends BridgeNotificationsV2Method>(
  name: string,
  method: TMethod,
  data: unknown,
): BridgeNotificationsV2Result<TMethod> {
  try {
    return assertBridgeNotificationsV2Result(method, data);
  } catch (error) {
    throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `${name} answered ${method} with invalid data: ${messageOf(error)}`,
      cause: error,
    });
  }
}

function toBridgeError(
  id: string,
  method: BridgeNotificationsV2Method,
  error: unknown,
  unexpectedFailureMessage: ((method: BridgeNotificationsV2Method) => string) | undefined,
): BridgeResponse {
  if (error instanceof InvalidPayloadError) {
    return createBridgeError(id, 'NOTIFICATIONS_INVALID_INPUT', error.message);
  }
  // Read by shape as well as by class: a provider built against another copy
  // of `@mpgd/platform` throws errors that fail `instanceof` here, and a
  // permanent code must not turn into a retryable one.
  const failure = readPlatformOperationFailure(error);
  if (failure !== null && isNotificationErrorCode(failure.code)) {
    const message = stringField(error, 'message') ?? `${method} failed.`;
    const hostCode = stringField(error, 'hostCode');
    return createBridgeError(
      id,
      failure.code,
      hostCode === undefined || !hostCodeValue.test(hostCode)
        ? message
        : `${message} (host code ${hostCode})`,
      failure.retryable,
    );
  }
  if (error instanceof PlatformOperationError) {
    return createBridgeError(
      id,
      'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      `${method} failed: ${error.message}`,
      error.retryable,
    );
  }
  // A failure the provider did not normalize is a host failure the game may
  // retry, unless it carries a retryable flag of its own.
  return createBridgeError(
    id,
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    unexpectedFailureMessage === undefined
      ? `${method} failed: ${messageOf(error)}`
      : unexpectedFailureMessage(method),
    failure?.retryable ?? true,
  );
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const field: unknown = (value as Readonly<Record<string, unknown>>)[key];
  return typeof field === 'string' ? field : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { readonly then?: unknown }).then === 'function';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { PlatformOperationError, readPlatformOperationFailure } from '@mpgd/platform';
import {
  assertNotificationBackendBridgeCancelReminderPayload,
  assertNotificationBackendBridgeCancelReminderResult,
  assertNotificationBackendBridgeGetSessionPayload,
  assertNotificationBackendBridgeGetSessionResult,
  assertNotificationBackendBridgeListConsentPayload,
  assertNotificationBackendBridgeListConsentResult,
  assertNotificationBackendBridgeListNoticesPayload,
  assertNotificationBackendBridgeListNoticesResult,
  assertNotificationBackendBridgeRecordConsentPayload,
  assertNotificationBackendBridgeRecordConsentResult,
  assertNotificationBackendBridgeRecordNoticePayload,
  assertNotificationBackendBridgeRecordNoticeResult,
  assertNotificationBackendBridgeRegisterEndpointPayload,
  assertNotificationBackendBridgeRegisterEndpointResult,
  assertNotificationBackendBridgeSetReminderPayload,
  assertNotificationBackendBridgeSetReminderResult,
  assertNotificationBackendBridgeUnregisterEndpointPayload,
  assertNotificationBackendBridgeUnregisterEndpointResult,
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
  type NotificationBackendReminderSetStatus,
  type NotificationConsentRecord,
  type NotificationEndpointRegistration,
  type NotificationNotice,
  type NotificationNoticeIdentity,
  type NotificationProvider,
  type SetNotificationReminderInput,
} from '@mpgd/platform/notifications';

import {
  bridgeNotificationsEventProtocol,
  createBridgeError,
  createBridgeEventSource,
  isBridgeNotificationsBackendMethod,
  isBridgeNotificationsV2Method,
  isThrownInstance,
  readThrownField,
  thrownMessage,
  type BridgeEventStream,
  type BridgeNotificationsBackendMethod,
  type BridgeNotificationsBackendPayload,
  type BridgeNotificationsBackendResult,
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
  BridgeNotificationsBackendMethod,
  BridgeNotificationsBackendPayload,
  BridgeNotificationsBackendResult,
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
   * `NotificationError` nor a `PlatformOperationError`, by class or by shape)
   * crosses with. By default `<method> failed: <its message>`; a host whose
   * provider failures can carry internal text passes a fixed one. A failure
   * with a notifications code is the provider's own answer and keeps its
   * message. A callback that throws, or answers a value that is not a
   * string, is reported through `onError`, and the failure crosses as
   * `<method> failed.` with its code and retryable flag.
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
 *   unless it carries a `retryable: false` of its own. A thrown value is
 *   read defensively: a field whose getter or `Proxy` trap throws counts as
 *   missing, so a hostile value never rejects the request or keeps a
 *   readable code from crossing.
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
    if (input.onError === undefined || isThrownInstance(error, InvalidPayloadError)) {
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
        try {
          return toBridgeError(request.id, method, error, input.unexpectedFailureMessage, report);
        } catch {
          // Reading a failure never throws; this answers anyway if it did.
          return createBridgeError(
            request.id,
            'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
            `${method} failed.`,
            true,
          );
        }
      }
    },
    // The source carries this protocol only, so every envelope is a notifications one.
    subscribe: (listener) =>
      events.subscribe((envelope) => listener(envelope as BridgeNotificationsEvent)),
  };
}

// Backend methods (notifications RFC "Bridge and versioning", "Backend
// methods"): the runtime's backend calls for a backend a host serves over
// its bridge, validated with the `@mpgd/platform/notifications` validators
// and served by `createNotificationsBackendBridgeHandler`.

interface NotificationsBackendPayloadAsserts {
  readonly 'notifications.backend.getSession': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.getSession'>;
  readonly 'notifications.backend.recordConsent': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.recordConsent'>;
  readonly 'notifications.backend.listConsent': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.listConsent'>;
  readonly 'notifications.backend.registerEndpoint': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.registerEndpoint'>;
  readonly 'notifications.backend.unregisterEndpoint': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.unregisterEndpoint'>;
  readonly 'notifications.backend.setReminder': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.setReminder'>;
  readonly 'notifications.backend.cancelReminder': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.cancelReminder'>;
  readonly 'notifications.backend.listNotices': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.listNotices'>;
  readonly 'notifications.backend.recordNotice': (input: unknown) => BridgeNotificationsBackendPayload<'notifications.backend.recordNotice'>;
}

interface NotificationsBackendResultAsserts {
  readonly 'notifications.backend.getSession': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.getSession'>;
  readonly 'notifications.backend.recordConsent': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.recordConsent'>;
  readonly 'notifications.backend.listConsent': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.listConsent'>;
  readonly 'notifications.backend.registerEndpoint': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.registerEndpoint'>;
  readonly 'notifications.backend.unregisterEndpoint': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.unregisterEndpoint'>;
  readonly 'notifications.backend.setReminder': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.setReminder'>;
  readonly 'notifications.backend.cancelReminder': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.cancelReminder'>;
  readonly 'notifications.backend.listNotices': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.listNotices'>;
  readonly 'notifications.backend.recordNotice': (input: unknown) => BridgeNotificationsBackendResult<'notifications.backend.recordNotice'>;
}

const notificationsBackendPayloadAsserts: NotificationsBackendPayloadAsserts = {
  'notifications.backend.getSession': assertNotificationBackendBridgeGetSessionPayload,
  'notifications.backend.recordConsent': assertNotificationBackendBridgeRecordConsentPayload,
  'notifications.backend.listConsent': assertNotificationBackendBridgeListConsentPayload,
  'notifications.backend.registerEndpoint': assertNotificationBackendBridgeRegisterEndpointPayload,
  'notifications.backend.unregisterEndpoint': assertNotificationBackendBridgeUnregisterEndpointPayload,
  'notifications.backend.setReminder': assertNotificationBackendBridgeSetReminderPayload,
  'notifications.backend.cancelReminder': assertNotificationBackendBridgeCancelReminderPayload,
  'notifications.backend.listNotices': assertNotificationBackendBridgeListNoticesPayload,
  'notifications.backend.recordNotice': assertNotificationBackendBridgeRecordNoticePayload,
};

const notificationsBackendResultAsserts: NotificationsBackendResultAsserts = {
  'notifications.backend.getSession': assertNotificationBackendBridgeGetSessionResult,
  'notifications.backend.recordConsent': assertNotificationBackendBridgeRecordConsentResult,
  'notifications.backend.listConsent': assertNotificationBackendBridgeListConsentResult,
  'notifications.backend.registerEndpoint': assertNotificationBackendBridgeRegisterEndpointResult,
  'notifications.backend.unregisterEndpoint': assertNotificationBackendBridgeUnregisterEndpointResult,
  'notifications.backend.setReminder': assertNotificationBackendBridgeSetReminderResult,
  'notifications.backend.cancelReminder': assertNotificationBackendBridgeCancelReminderResult,
  'notifications.backend.listNotices': assertNotificationBackendBridgeListNoticesResult,
  'notifications.backend.recordNotice': assertNotificationBackendBridgeRecordNoticeResult,
};

/**
 * Validates the payload of a notifications backend request with the
 * `@mpgd/platform/notifications` validator for its method, as
 * `assertBridgeNotificationsV2Payload` does for the provider methods. Throws
 * what that validator throws, and a `TypeError` for a method that is not a
 * notifications backend method.
 */
export function assertBridgeNotificationsBackendPayload<TMethod extends BridgeNotificationsBackendMethod>(
  method: TMethod,
  payload: unknown,
): BridgeNotificationsBackendPayload<TMethod> {
  assertNotificationsBackendMethod(method);
  return notificationsBackendPayloadAsserts[method](
    payload,
  ) as BridgeNotificationsBackendPayload<TMethod>;
}

/** Validates the data a transport answered a notifications backend request with. */
export function assertBridgeNotificationsBackendResult<TMethod extends BridgeNotificationsBackendMethod>(
  method: TMethod,
  data: unknown,
): BridgeNotificationsBackendResult<TMethod> {
  assertNotificationsBackendMethod(method);
  return notificationsBackendResultAsserts[method](
    data,
  ) as BridgeNotificationsBackendResult<TMethod>;
}

function assertNotificationsBackendMethod(method: string): void {
  if (!isBridgeNotificationsBackendMethod(method)) {
    throw new TypeError(`${method} is not a notifications backend bridge method.`);
  }
}

/**
 * Host codes a backend bridge error names (`(host code <code>)`, read back
 * with `readBridgeNotificationsHostCode`). Both come with
 * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, which the runtime reads as "no
 * signed-in player" and retries at its next trigger.
 */
export const notificationsBackendBridgeHostCodes = Object.freeze({
  /** The request has no authenticated player (a logged-out Devvit viewer). */
  signedOut: 'NOTIFICATIONS_SIGNED_OUT',
  /**
   * The request's authenticated player is not the call's `expectedPlayer`:
   * another player signed in since the call began. Nothing was read or
   * changed; the client reads the session again.
   */
  sessionChanged: 'NOTIFICATIONS_SESSION_CHANGED',
} as const);

/** A session a host-served backend answers for: the host's own authenticated player. */
export interface NotificationsBackendBridgeSession {
  /** Stable for the session's life. */
  readonly id: string;
  readonly player: string;
}

/**
 * The backend a host serves, for one request: the session comes from the
 * host's own authentication (Devvit's `context.userId`), and every other
 * method acts for the session `session()` answered for this request.
 */
export interface NotificationsBackendBridgeServer<
  TSession extends NotificationsBackendBridgeSession,
> {
  /** The request's authenticated session; `undefined` while it has no authenticated player. */
  session(): TSession | undefined;
  /** Appends a record; answers it as stored, dated by the backend's clock. */
  recordConsent(session: TSession, record: NotificationConsentRecord): Promise<NotificationConsentRecord>;
  listConsent(session: TSession): Promise<readonly NotificationConsentRecord[]>;
  registerEndpoint(session: TSession, registration: NotificationEndpointRegistration): Promise<void>;
  unregisterEndpoint(session: TSession, input: { readonly provider: string }): Promise<void>;
  setReminder(session: TSession, reminder: SetNotificationReminderInput): Promise<NotificationBackendReminderSetStatus>;
  cancelReminder(session: TSession, input: { readonly key: string }): Promise<boolean>;
  listNotices(session: TSession): Promise<readonly NotificationNotice[]>;
  recordNotice(session: TSession, notice: NotificationNoticeIdentity, input: { readonly channel: 'in-game' }): Promise<void>;
}

/** The host side of the notifications backend bridge methods. */
export interface NotificationsBackendBridgeHandler {
  /** Answers one of the nine `notifications.backend.*` methods; any other method answers `UNSUPPORTED_METHOD`. */
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

export interface CreateNotificationsBackendBridgeHandlerInput<
  TSession extends NotificationsBackendBridgeSession,
> {
  readonly backend: NotificationsBackendBridgeServer<TSession>;
  /** Names the backend in error messages, as in "The Devvit notifications backend answered ...". */
  readonly label?: string | undefined;
  /**
   * The message a failure that is not a notifications failure crosses with
   * (a `PlatformOperationError` with another code included), so a store's
   * or plugin's own text stays on the host. `<method> failed on the host.`
   * by default. A callback that throws, or answers a value that is not a
   * string, is reported through `onError`, and the failure crosses as
   * `<method> failed.`.
   */
  readonly unexpectedFailureMessage?: ((method: BridgeNotificationsBackendMethod) => string) | undefined;
  /**
   * Called with every failure the handler answers with an error, except an
   * invalid payload and a signed-out or changed session (the caller's, and
   * expected): a backend failure, and an answer outside the contract, whose
   * validator text is the cause. Synchronous; a hook that throws or rejects
   * changes nothing.
   */
  readonly onError?:
    | ((error: unknown, context: { readonly method: BridgeNotificationsBackendMethod }) => void)
    | undefined;
}

/**
 * Serves the nine `notifications.backend.*` bridge methods from a backend the
 * host runs (notifications RFC "Bridge and versioning", "Backend methods"),
 * as the Devvit server does over its notifications service.
 *
 * - **Session.** `getSession` answers the request's authenticated session,
 *   or `null`. Every other method needs one: without it the call answers
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with host code
 *   `NOTIFICATIONS_SIGNED_OUT`, and with a player other than the payload's
 *   `expectedPlayer` it answers the same code with host code
 *   `NOTIFICATIONS_SESSION_CHANGED`. Neither reaches the backend. The
 *   payload never chooses whom a call acts for.
 * - **Payloads and answers.** Each is checked with
 *   `assertBridgeNotificationsBackendPayload` and
 *   `assertBridgeNotificationsBackendResult`: a payload the contract rejects
 *   answers `NOTIFICATIONS_INVALID_INPUT`, an answer it rejects
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
 * - **Failures.** As for `createNotificationsV2BridgeHandler`: a
 *   notifications failure crosses with its code, retryable flag, and host
 *   code; anything else is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with
 *   `unexpectedFailureMessage`.
 * - **Retries.** An answer is checked after the backend acted, so a write
 *   whose answer breaks the contract still happened. The runtime retries a
 *   retryable failure, and the backend calls are written to be repeated:
 *   reminders and registrations replace by key, a repeated permission or
 *   preference record is not written twice (an advertising or night record
 *   is), and a notice is recorded once.
 */
export function createNotificationsBackendBridgeHandler<TSession extends NotificationsBackendBridgeSession>(
  input: CreateNotificationsBackendBridgeHandlerInput<TSession>,
): NotificationsBackendBridgeHandler {
  const { backend } = input;
  const name = input.label === undefined || input.label.length === 0
    ? 'The notifications backend'
    : `The ${input.label} notifications backend`;
  // A backend's own failure text (a store's, a plugin's) stays on the host.
  const unexpectedFailureMessage = input.unexpectedFailureMessage
    ?? ((method: BridgeNotificationsBackendMethod) => `${method} failed on the host.`);

  const sessionFor = (expectedPlayer: string): TSession => {
    const session = backend.session();
    if (session === undefined) {
      throw new SessionRefusal('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${name} has no signed-in player for this request.`,
        hostCode: notificationsBackendBridgeHostCodes.signedOut,
      });
    }
    if (session.player !== expectedPlayer) {
      throw new SessionRefusal('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${name} serves another player now; the call was not made.`,
        hostCode: notificationsBackendBridgeHostCodes.sessionChanged,
      });
    }
    return session;
  };

  const serve = async (method: BridgeNotificationsBackendMethod, payload: unknown): Promise<unknown> => {
    switch (method) {
      case 'notifications.backend.getSession': {
        validBackendPayload(method, payload);
        const session = backend.session();
        return {
          session: session === undefined ? null : { id: session.id, player: session.player },
        };
      }
      case 'notifications.backend.recordConsent': {
        const request = validBackendPayload(method, payload);
        return {
          record: await backend.recordConsent(sessionFor(request.expectedPlayer), request.record),
        };
      }
      case 'notifications.backend.listConsent': {
        const request = validBackendPayload(method, payload);
        return { records: await backend.listConsent(sessionFor(request.expectedPlayer)) };
      }
      case 'notifications.backend.registerEndpoint': {
        const request = validBackendPayload(method, payload);
        await backend.registerEndpoint(sessionFor(request.expectedPlayer), request.registration);
        return { registered: true };
      }
      case 'notifications.backend.unregisterEndpoint': {
        const request = validBackendPayload(method, payload);
        await backend.unregisterEndpoint(sessionFor(request.expectedPlayer), {
          provider: request.provider,
        });
        return { unregistered: true };
      }
      case 'notifications.backend.setReminder': {
        const request = validBackendPayload(method, payload);
        return {
          status: await backend.setReminder(sessionFor(request.expectedPlayer), request.reminder),
        };
      }
      case 'notifications.backend.cancelReminder': {
        const request = validBackendPayload(method, payload);
        return {
          cancelled: await backend.cancelReminder(sessionFor(request.expectedPlayer), { key: request.key }),
        };
      }
      case 'notifications.backend.listNotices': {
        const request = validBackendPayload(method, payload);
        return { notices: await backend.listNotices(sessionFor(request.expectedPlayer)) };
      }
      case 'notifications.backend.recordNotice': {
        const request = validBackendPayload(method, payload);
        await backend.recordNotice(sessionFor(request.expectedPlayer), request.notice, {
          channel: request.channel,
        });
        return { recorded: true };
      }
      default: {
        // A method added to the list without a case here fails to compile.
        const unhandled: never = method;
        throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
          message: `The notifications backend bridge does not serve ${String(unhandled)}.`,
        });
      }
    }
  };

  const report = (error: unknown, method: BridgeNotificationsBackendMethod): void => {
    if (input.onError === undefined || isThrownInstance(error, InvalidPayloadError) || isThrownInstance(error, SessionRefusal)) {
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
      if (!isBridgeNotificationsBackendMethod(request.method)) {
        return createBridgeError(
          request.id,
          'UNSUPPORTED_METHOD',
          `${request.method} is not a notifications backend method.`,
        );
      }
      const method = request.method;
      try {
        const data = await serve(method, request.payload);
        return { id: request.id, ok: true, data: validBackendResult(name, method, data) };
      } catch (error) {
        report(error, method);
        try {
          return toBridgeError(request.id, method, error, unexpectedFailureMessage, report, true);
        } catch {
          // Reading a failure never throws; this answers anyway if it did.
          return createBridgeError(
            request.id,
            'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
            `${method} failed.`,
            true,
          );
        }
      }
    },
  };
}

/** A call refused before the backend for its session: expected, so never reported. */
class SessionRefusal extends NotificationError {}

function validBackendPayload<TMethod extends BridgeNotificationsBackendMethod>(
  method: TMethod,
  payload: unknown,
): BridgeNotificationsBackendPayload<TMethod> {
  try {
    return assertBridgeNotificationsBackendPayload(method, payload);
  } catch (error) {
    throw new InvalidPayloadError(`${method} payload is invalid: ${thrownMessage(error)}`, {
      cause: error,
    });
  }
}

function validBackendResult<TMethod extends BridgeNotificationsBackendMethod>(
  name: string,
  method: TMethod,
  data: unknown,
): BridgeNotificationsBackendResult<TMethod> {
  try {
    return assertBridgeNotificationsBackendResult(method, data);
  } catch (error) {
    // The validator's text may quote stored data; it stays in the cause, which `onError` sees.
    throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `${name} answered ${method} outside the contract.`,
      cause: error,
    });
  }
}

/** The host codes a bridge error names in its message, as `(host code <code>)`. */
const hostCodeCharacters = '[A-Za-z0-9_.:-]{1,128}';
const hostCodeValue = new RegExp(`^${hostCodeCharacters}$`, 'u');
const hostCodeSuffix = new RegExp(`\\(host code (${hostCodeCharacters})\\)$`, 'u');

/**
 * The host code a notifications v2 bridge error names at the end of its
 * message, as `createNotificationsV2BridgeHandler` writes it
 * (`... (host code <code>)`), or `undefined`. The bridge error has no field
 * for it, so a game-side client reads it back from the message. Read it only
 * from an error with a `NOTIFICATIONS_*` code: the handler names a host code
 * only there, and other messages may end in provider text.
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
    throw new InvalidPayloadError(`${method} payload is invalid: ${thrownMessage(error)}`, {
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
      message: `${name} answered ${method} with invalid data: ${thrownMessage(error)}`,
      cause: error,
    });
  }
}

/**
 * The bridge error a failure crosses as. A thrown value may be anything,
 * including a hostile one (a getter or `toString` that throws, a `Proxy`
 * whose traps throw): each field is read once and counts as missing when
 * reading it throws, so a readable code and flag still cross, and this never
 * throws.
 */
function toBridgeError<TMethod extends string>(
  id: string,
  method: TMethod,
  error: unknown,
  unexpectedFailureMessage: ((method: TMethod) => string) | undefined,
  /** Reports a failure of `unexpectedFailureMessage` itself; the answer then uses a fixed message. */
  report: (error: unknown, method: TMethod) => void,
  /** Also answers a non-notifications `PlatformOperationError` with `unexpectedFailureMessage`. */
  hidePlatformFailureText = false,
): BridgeResponse {
  if (isThrownInstance(error, InvalidPayloadError)) {
    return createBridgeError(id, 'NOTIFICATIONS_INVALID_INPUT', error.message);
  }
  /** The host's fixed message; one it cannot build is reported, and the answer says only that the method failed. */
  const fixedMessage = (build: (method: TMethod) => string): string => {
    try {
      const message: unknown = build(method);
      if (typeof message === 'string') {
        return message;
      }
      report(
        new TypeError('unexpectedFailureMessage answered a value that is not a string.'),
        method,
      );
    } catch (buildError) {
      report(buildError, method);
    }
    return `${method} failed.`;
  };
  // Read by shape as well as by class: a provider built against another copy
  // of `@mpgd/platform` throws errors that fail `instanceof` here, and a
  // permanent code must not turn into a retryable one. The fields are read
  // once, into a plain object, so a getter cannot answer differently twice.
  const failure = readPlatformOperationFailure({
    code: readThrownField(error, 'code'),
    retryable: readThrownField(error, 'retryable'),
  });
  if (failure !== null && isNotificationErrorCode(failure.code)) {
    const message = stringOrUndefined(readThrownField(error, 'message')) ?? `${method} failed.`;
    const hostCode = stringOrUndefined(readThrownField(error, 'hostCode'));
    return createBridgeError(
      id,
      failure.code,
      hostCode === undefined || !hostCodeValue.test(hostCode)
        ? message
        : `${message} (host code ${hostCode})`,
      failure.retryable,
    );
  }
  if (isThrownInstance(error, PlatformOperationError)) {
    return createBridgeError(
      id,
      'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      hidePlatformFailureText && unexpectedFailureMessage !== undefined
        ? fixedMessage(unexpectedFailureMessage)
        : `${method} failed: ${thrownMessage(error)}`,
      failure?.retryable ?? true,
    );
  }
  // A failure the provider did not normalize is a host failure the game may
  // retry, unless it carries a retryable flag of its own.
  return createBridgeError(
    id,
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    unexpectedFailureMessage === undefined
      ? `${method} failed: ${thrownMessage(error)}`
      : fixedMessage(unexpectedFailureMessage),
    failure?.retryable ?? true,
  );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { readonly then?: unknown }).then === 'function';
}

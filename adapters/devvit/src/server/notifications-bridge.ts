import {
  createBridgeError,
  isBridgeNotificationsV2Method,
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
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocolVersion,
  type NotificationPermissionOutcome,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
} from '@mpgd/platform/notifications';

import {
  createDevvitNotificationCapabilities,
  devvitNotificationProviderId,
  devvitUserIdPattern,
} from '../notifications-contract.js';

/**
 * The game-rendered consent of the Devvit profile (notifications v2 RFC,
 * "Provider profiles", Devvit), served from the Devvit server bridge. Reddit
 * shows no consent screen: the game draws its own on/off control, and the
 * server opts the requesting user in or out with `optInCurrentUser` and
 * `optOutCurrentUser` and reads `isOptedIn` (`notifications` from
 * `@devvit/web/server`; <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/notifications/pn-best-practices>).
 *
 * The user is the Devvit request context's (`context.userId`), never a
 * payload field. A logged-out viewer has none: reads answer
 * `action-required` with `requiredAction: 'login'`, and requests answer the
 * `action-required` outcome without reaching the plugin; the game then calls
 * `identity.requestUpgrade({ reason: 'notifications' })`.
 *
 * Notifications are a gated beta: an app Reddit has not approved is kept
 * `approval-required` by the target config, which hides the provider from
 * the game. No opt-out event exists, so nothing here pushes events; the
 * backend reads `isOptedIn` at send time instead.
 */

/** The server side of the Devvit notifications plugin that opts the current user in and out. */
export interface DevvitNotificationsConsentClient {
  optInCurrentUser(): Promise<{ readonly success: boolean; readonly message?: string | undefined }>;
  optOutCurrentUser(): Promise<{ readonly success: boolean; readonly message?: string | undefined }>;
  isOptedIn(userId: `t2_${string}`): Promise<boolean>;
}

export interface CreateDevvitServerNotificationProviderInput {
  readonly notifications: DevvitNotificationsConsentClient;
  /** The logged-in Reddit user of the current Devvit request (`context.userId`). */
  readonly currentUserId: () => string | undefined;
  /**
   * The topic ids the game's catalog maps for the `reddit` target. A request
   * for a topic outside them answers `unavailable` without opting in.
   */
  readonly topics: readonly string[];
}

/** Host codes of the failures this provider normalizes. */
export const devvitNotificationHostCodes = Object.freeze({
  optInRefused: 'DEVVIT_OPT_IN_REFUSED',
  optOutRefused: 'DEVVIT_OPT_OUT_REFUSED',
  pluginFailed: 'DEVVIT_NOTIFICATIONS_PLUGIN_FAILED',
} as const);

/**
 * The Devvit server's `NotificationProvider`, for one request at a time: the
 * bridge handler calls it inside the request whose user it reads.
 *
 * - **Reads.** Opted in reads `granted`, otherwise `prompt` (the runtime
 *   turns `prompt` into `denied` once a decision is recorded).
 * - **Requests.** Already opted in is `already-granted` without a second
 *   opt-in; otherwise `optInCurrentUser` answers `granted`. A refused opt-in
 *   (`success: false`, such as an app not yet approved) throws
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED` with host code
 *   `DEVVIT_OPT_IN_REFUSED`, which is not retryable: Devvit documents no
 *   transient refusal, and a refusal the game retried would loop. A plugin
 *   call that throws is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
 * - **Revocation.** `optOutCurrentUser`, the `denied` outcome for every
 *   topic, and a fresh read.
 * - **Registration.** A logged-in user registers `{ kind: 'platform-user' }`;
 *   the webview adds its locale and zone. No device address exists.
 */
export function createDevvitServerNotificationProvider(
  input: CreateDevvitServerNotificationProviderInput,
): NotificationProvider {
  const mapped = new Set(input.topics);
  const user = (): `t2_${string}` | undefined => {
    const id = input.currentUserId();
    return typeof id === 'string' && devvitUserIdPattern.test(id)
      ? id as `t2_${string}`
      : undefined;
  };
  const plugin = async <Value>(call: () => Promise<Value>, what: string): Promise<Value> => {
    try {
      return await call();
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `Devvit notifications ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
        hostCode: devvitNotificationHostCodes.pluginFailed,
        cause: error,
      });
    }
  };
  const snapshotOf = (
    topics: readonly string[],
    state: NotificationPermissionState,
  ): NotificationPermissionSnapshot => ({
    app: state,
    topics: Object.fromEntries(topics.map((topic) => [topic, state])),
    ...(state === 'action-required' ? { requiredAction: 'login' as const } : {}),
  });
  const read = async (userId: `t2_${string}`): Promise<NotificationPermissionState> =>
    (await plugin(() => input.notifications.isOptedIn(userId), 'isOptedIn')) ? 'granted' : 'prompt';
  const loginRequired = (topics: readonly string[]): NotificationPermissionResult => ({
    snapshot: snapshotOf(topics, 'action-required'),
    outcomes: Object.fromEntries(topics.map((topic) => [topic, 'action-required' as const])),
    requiredAction: 'login',
  });
  const refused = (
    response: { readonly success?: unknown; readonly message?: unknown } | undefined,
    hostCode: string,
    what: string,
  ): NotificationError | undefined => {
    if (response?.success === true) {
      return undefined;
    }
    const detail = typeof response?.message === 'string' && response.message.length > 0
      ? `: ${response.message}`
      : '';
    return new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `Devvit refused ${what}${detail}`,
      hostCode,
    });
  };

  return {
    provider: devvitNotificationProviderId,
    async getCapabilities() {
      return createDevvitNotificationCapabilities(user() === undefined ? 'action-required' : 'available');
    },
    async getPermission({ topics }) {
      const userId = user();
      return snapshotOf(topics, userId === undefined ? 'action-required' : await read(userId));
    },
    async requestPermission({ topics }) {
      const userId = user();
      if (userId === undefined) {
        return loginRequired(topics);
      }
      const askable = topics.filter((topic) => mapped.has(topic));
      const outcomesWith = (
        granted: NotificationPermissionOutcome,
      ): Record<string, NotificationPermissionOutcome> =>
        Object.fromEntries(topics.map((topic) => [topic, mapped.has(topic) ? granted : 'unavailable']));
      if (askable.length === 0) {
        return { snapshot: snapshotOf(topics, await read(userId)), outcomes: outcomesWith('unavailable') };
      }
      let outcome: NotificationPermissionOutcome = 'already-granted';
      if ((await read(userId)) !== 'granted') {
        const response = await plugin(() => input.notifications.optInCurrentUser(), 'optInCurrentUser');
        const failure = refused(response, devvitNotificationHostCodes.optInRefused, 'the opt-in');
        if (failure !== undefined) {
          throw failure;
        }
        outcome = 'granted';
      }
      return { snapshot: snapshotOf(topics, 'granted'), outcomes: outcomesWith(outcome) };
    },
    async revokePermission({ topics }) {
      const userId = user();
      if (userId === undefined) {
        return loginRequired(topics);
      }
      const response = await plugin(() => input.notifications.optOutCurrentUser(), 'optOutCurrentUser');
      const failure = refused(response, devvitNotificationHostCodes.optOutRefused, 'the opt-out');
      if (failure !== undefined) {
        throw failure;
      }
      return {
        snapshot: snapshotOf(topics, await read(userId)),
        outcomes: Object.fromEntries(topics.map((topic) => [topic, 'denied' as const])),
      };
    },
    async register() {
      return user() === undefined
        ? null
        : { provider: devvitNotificationProviderId, address: { kind: 'platform-user' } };
    },
    subscribe() {
      // No opt-out event exists, and opens arrive as post links.
      return () => {};
    },
  };
}

/** Serves the nine `notifications.v2.*` bridge methods; the Devvit server bridge's `notifications` dependency. */
export interface DevvitNotificationsV2BridgeHandler {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

/**
 * The server bridge side of notifications v2 on Devvit (RFC "Bridge and
 * versioning"): each method's payload and answer are checked with the
 * `@mpgd/bridge/notifications` validators. A payload the validator rejects
 * answers `NOTIFICATIONS_INVALID_INPUT`; a method the profile lacks (the
 * local-notification methods) `NOTIFICATIONS_UNSUPPORTED`; `openSettings`
 * answers `unavailable`, because Devvit has no settings link; an answer the
 * contract rejects `NOTIFICATIONS_CONFIGURATION_REQUIRED`. A thrown
 * `NotificationError` crosses as `{ code, message, retryable }` with its host
 * code named in the message. Devvit has no server-to-webview event channel,
 * so the bridge carries no notifications events.
 */
export function createDevvitNotificationsV2BridgeHandler(
  input: CreateDevvitServerNotificationProviderInput,
): DevvitNotificationsV2BridgeHandler {
  const provider = createDevvitServerNotificationProvider(input);

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
      case 'notifications.v2.revokePermission':
        return (provider.revokePermission as NonNullable<NotificationProvider['revokePermission']>)
          .call(provider, validPayload(method, payload));
      case 'notifications.v2.register':
        validPayload(method, payload);
        return { registration: (await provider.register?.()) ?? null };
      case 'notifications.v2.openSettings':
        validPayload(method, payload);
        return { status: 'unavailable' };
      case 'notifications.v2.scheduleLocal':
      case 'notifications.v2.cancelLocal':
      case 'notifications.v2.listLocal':
        validPayload(method, payload);
        throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
          message: `Devvit has no local notifications (${method}).`,
        });
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
      message: `The Devvit notifications provider answered ${method} with invalid data: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }
}

const hostCodeValue = /^[A-Za-z0-9_.:-]{1,128}$/u;

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
  return createBridgeError(
    request.id,
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    `${request.method} failed: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

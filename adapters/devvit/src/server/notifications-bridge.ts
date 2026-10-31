import { isThrownInstance, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import { createNotificationsV2BridgeHandler } from '@mpgd/bridge/notifications';
import {
  NotificationError,
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
 * `action-required` outcome (`unavailable` for an unmapped topic) without
 * reaching the plugin; the game then calls
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

export interface CreateDevvitNotificationsV2BridgeHandlerInput extends CreateDevvitServerNotificationProviderInput {
  /**
   * Every failure of a notifications method the handler answers with an
   * error, except an invalid payload (the caller's), with its cause (the
   * plugin's own text, which the webview never sees). Synchronous; a hook
   * that throws or rejects changes nothing. By default `console.warn`, which
   * skips the expected `NOTIFICATIONS_UNSUPPORTED` of the local methods.
   */
  readonly onError?: ((error: unknown, context: { readonly method: string }) => void) | undefined;
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
 *   (`success: false`) is re-read with `isOptedIn`. If that read is
 *   `granted`, a concurrent request already opted the user in and the
 *   observed state is returned (`already-granted`), not a permanent
 *   configuration error. If the user is still out, it throws
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED` with host code
 *   `DEVVIT_OPT_IN_REFUSED`, which is not retryable: Devvit documents no
 *   transient refusal, and a refusal the game retried would loop. A plugin
 *   call that throws is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
 * - **Revocation.** `optOutCurrentUser` for a user who is opted in (one who
 *   is already out needs none, which Devvit might refuse), the `denied`
 *   outcome for every mapped topic (`unavailable` for the others, and no
 *   opt-out when none is mapped). A refused opt-out is re-read the same
 *   way: still opted in throws `DEVVIT_OPT_OUT_REFUSED`; already out returns
 *   the observed `prompt` state. A successful opt-out answers the state it
 *   produced (`prompt`), not a second read that could be stale.
 * - **Unmapped topics.** A topic the catalog does not map for `reddit`
 *   reads `unsupported` in every snapshot.
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
      // The plugin's own text stays on the server (as the cause); the
      // webview gets a fixed message.
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `Devvit notifications ${what} failed.`,
        hostCode: devvitNotificationHostCodes.pluginFailed,
        cause: error,
      });
    }
  };
  /** The app's state for each mapped topic; a topic the catalog does not map for `reddit` reads `unsupported`. */
  const snapshotOf = (
    topics: readonly string[],
    state: NotificationPermissionState,
  ): NotificationPermissionSnapshot => ({
    app: state,
    topics: Object.fromEntries(
      topics.map((topic) => [topic, mapped.has(topic) ? state : 'unsupported']),
    ),
    ...(state === 'action-required' ? { requiredAction: 'login' as const } : {}),
  });
  const read = async (userId: `t2_${string}`): Promise<NotificationPermissionState> =>
    (await plugin(() => input.notifications.isOptedIn(userId), 'isOptedIn')) ? 'granted' : 'prompt';
  /** `forMapped` for each mapped topic, `unavailable` for the others. */
  const outcomesWith = (
    topics: readonly string[],
    forMapped: NotificationPermissionOutcome,
  ): Record<string, NotificationPermissionOutcome> =>
    Object.fromEntries(
      topics.map((topic) => [topic, mapped.has(topic) ? forMapped : 'unavailable']),
    );
  const loginRequired = (topics: readonly string[]): NotificationPermissionResult => ({
    snapshot: snapshotOf(topics, 'action-required'),
    outcomes: outcomesWith(topics, 'action-required'),
    // Logging in could not enable a topic the catalog does not map.
    ...(topics.some((topic) => mapped.has(topic)) ? { requiredAction: 'login' as const } : {}),
  });
  const refused = (
    response: { readonly success?: unknown; readonly message?: unknown } | undefined,
    hostCode: string,
    what: string,
  ): NotificationError | undefined => {
    if (response?.success === true) {
      return undefined;
    }
    // Devvit's own message stays on the server (as the cause).
    return new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `Devvit refused ${what}.`,
      hostCode,
      cause: new Error(typeof response?.message === 'string' ? response.message : 'no message'),
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
      if (askable.length === 0) {
        return { snapshot: snapshotOf(topics, await read(userId)), outcomes: outcomesWith(topics, 'unavailable') };
      }
      let outcome: NotificationPermissionOutcome = 'already-granted';
      if ((await read(userId)) !== 'granted') {
        const response = await plugin(() => input.notifications.optInCurrentUser(), 'optInCurrentUser');
        const failure = refused(response, devvitNotificationHostCodes.optInRefused, 'the opt-in');
        if (failure !== undefined) {
          // Both of two concurrent requests can see not-granted and call
          // opt-in. The duplicate answers success:false. That is a permanent
          // configuration error only when a re-read still shows the user out.
          if ((await read(userId)) !== 'granted') {
            throw failure;
          }
          outcome = 'already-granted';
        } else {
          outcome = 'granted';
        }
      }
      return { snapshot: snapshotOf(topics, 'granted'), outcomes: outcomesWith(topics, outcome) };
    },
    async revokePermission({ topics }) {
      const userId = user();
      if (userId === undefined) {
        return loginRequired(topics);
      }
      const outcomes = outcomesWith(topics, 'denied');
      if (!topics.some((topic) => mapped.has(topic))) {
        // Nothing this provider maps: no opt-out, as a request opts nothing in.
        return { snapshot: snapshotOf(topics, await read(userId)), outcomes };
      }
      // A user who is already out needs no opt-out, which Devvit might refuse.
      if ((await read(userId)) === 'granted') {
        const response = await plugin(() => input.notifications.optOutCurrentUser(), 'optOutCurrentUser');
        const failure = refused(response, devvitNotificationHostCodes.optOutRefused, 'the opt-out');
        if (failure !== undefined && (await read(userId)) === 'granted') {
          // Still opted in: the refusal stands. Already out: a concurrent
          // opt-out won, and the observed state is the one returned below.
          throw failure;
        }
      }
      // The opt-out (or the read that found the user out) decided the state:
      // not opted in, which reads `prompt`. A second read could be stale.
      return { snapshot: snapshotOf(topics, 'prompt'), outcomes };
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
 * versioning"): `createNotificationsV2BridgeHandler` from
 * `@mpgd/bridge/notifications` over the Devvit server provider. Each method's
 * payload and answer are checked with the `@mpgd/bridge/notifications`
 * validators. A payload the validator rejects answers
 * `NOTIFICATIONS_INVALID_INPUT`; a method the profile lacks (the
 * local-notification methods) `NOTIFICATIONS_UNSUPPORTED`; `openSettings`
 * answers `unavailable`, because Devvit has no settings link; an answer the
 * contract rejects `NOTIFICATIONS_CONFIGURATION_REQUIRED`. A thrown
 * `NotificationError` crosses as `{ code, message, retryable }` with its host
 * code named in the message, and an unexpected failure's text stays on the
 * server. Devvit has no server-to-webview event channel, so the bridge
 * carries no notifications events.
 */
export function createDevvitNotificationsV2BridgeHandler(
  input: CreateDevvitNotificationsV2BridgeHandlerInput,
): DevvitNotificationsV2BridgeHandler {
  const handler = createNotificationsV2BridgeHandler({
    provider: createDevvitServerNotificationProvider(input),
    label: 'Devvit',
    // An unexpected failure's text stays on the server.
    unexpectedFailureMessage: (method) => `${method} failed on the Devvit server.`,
    onError: input.onError ?? ((error, context) => {
      if (isThrownInstance(error, NotificationError) && error.code === 'NOTIFICATIONS_UNSUPPORTED') {
        return;
      }
      console.warn(`devvit notifications ${context.method} failed`, error);
    }),
  });
  return { request: (request) => handler.request(request) };
}

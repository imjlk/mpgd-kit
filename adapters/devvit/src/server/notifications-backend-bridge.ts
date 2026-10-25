import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { createNotificationsBackendBridgeHandler } from '@mpgd/bridge/notifications';
import { NotificationError } from '@mpgd/platform/notifications';
import {
  NotificationConsentRateLimitError,
  type NotificationService,
  type NotificationSession,
} from '@mpgd/game-services/notifications';

import { devvitUserIdPattern } from '../notifications-contract.js';
import {
  devvitNotificationSessionFromContext,
  type DevvitNotificationSessionContext,
} from './notifications-delivery.js';

/**
 * The notifications runtime's backend on Devvit (notifications v2 RFC,
 * "Bridge and versioning", "Backend methods", and "Provider profiles",
 * Devvit): the Devvit server's notifications service
 * (`createDevvitNotificationService`) served over the server bridge for the
 * request's logged-in user, so the webview's runtime keeps consent records,
 * the platform-user registration, server reminders, and notices there.
 *
 * The player is always the request's `context.userId`, read through
 * `devvitNotificationSessionFromContext`, never a payload field: the payload
 * only names the player its call began for, and a call for another player
 * is refused before the service.
 */

/** The parts of the notifications service the backend bridge serves. */
export type DevvitNotificationsBackendService = Pick<
  NotificationService,
  | 'recordConsent'
  | 'listConsent'
  | 'registerEndpoint'
  | 'unregisterEndpoint'
  | 'setReminder'
  | 'cancelReminder'
  | 'listNotices'
  | 'recordNoticeShown'
>;

export interface CreateDevvitNotificationsBackendBridgeHandlerInput {
  /** `createDevvitNotificationService(...).service`. */
  readonly service: DevvitNotificationsBackendService;
  /** The current Devvit request's context (`context` from `@devvit/web/server`). */
  readonly context: () => DevvitNotificationSessionContext;
  /**
   * Every failure the handler answers with an error, except an invalid
   * payload and a logged-out or changed session, with its cause (the
   * service's or Redis's own text, which the webview never sees).
   * Synchronous; a hook that throws or rejects changes nothing. By default
   * `console.warn`, which skips a player's own consent write cap and an
   * input the service refuses as invalid.
   */
  readonly onError?: ((error: unknown, context: { readonly method: string }) => void) | undefined;
}

/**
 * Serves the nine `notifications.backend.*` methods; the handler a Devvit
 * server bridge routes them to (the `notificationsBackend` dependency of the
 * kit's and the CLI template's `createDevvitBridgeHandler`).
 */
export interface DevvitNotificationsBackendBridgeHandler {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

interface DevvitBackendSession {
  readonly id: string;
  readonly player: string;
  readonly notifications: NotificationSession;
}

/**
 * The server bridge side of the runtime's backend on Devvit:
 * `createNotificationsBackendBridgeHandler` from `@mpgd/bridge/notifications`
 * over the Devvit notifications service.
 *
 * - **Session.** `getSession` answers the request's user as
 *   `{ player: 't2_…', id: 'devvit:t2_…' }`, or `null` for a logged-out
 *   viewer. Every other call needs that user: a logged-out request answers
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` (host code
 *   `NOTIFICATIONS_SIGNED_OUT`), which the runtime reads as "not signed in",
 *   and a call that began for another user answers the same code with
 *   `NOTIFICATIONS_SESSION_CHANGED`.
 * - **Calls.** Each method is the service's, for
 *   `devvitNotificationSessionFromContext(context())`: records (the service
 *   dates them and caps a player's writes per day), the `platform-user`
 *   registration's locale and zone, server reminders (which the `dispatch`
 *   scheduler task fires through `enqueue`), and notices, which stay empty
 *   unless the deployment applies the Korean rules.
 * - **Failures.** A service `NotificationError` crosses with its code (an
 *   invalid record or reminder is `NOTIFICATIONS_INVALID_INPUT`); any other
 *   failure is a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with a
 *   fixed message, and its text stays on the server (`onError`).
 */
export function createDevvitNotificationsBackendBridgeHandler(
  input: CreateDevvitNotificationsBackendBridgeHandlerInput,
): DevvitNotificationsBackendBridgeHandler {
  const { service } = input;
  const handler = createNotificationsBackendBridgeHandler<DevvitBackendSession>({
    label: 'Devvit',
    unexpectedFailureMessage: (method) => `${method} failed on the Devvit server.`,
    onError: (error, context) => {
      (input.onError ?? warnBackendFailure)(error, context);
    },
    backend: {
      session() {
        const context = input.context();
        // A request without a Devvit user id (missing, `null`, or not a t2_
        // id) has no signed-in player, as the provider side reads it. A
        // context that cannot be read at all is the server's failure and
        // reaches onError.
        const userId = context.userId;
        if (typeof userId !== 'string' || !devvitUserIdPattern.test(userId)) {
          return undefined;
        }
        // The id checked above, so the session cannot fail on a second read of the context.
        const notifications: NotificationSession = devvitNotificationSessionFromContext({ userId });
        return { id: notifications.sessionId, player: notifications.player, notifications };
      },
      recordConsent: (session, record) => service.recordConsent(session.notifications, record),
      listConsent: (session) => service.listConsent(session.notifications),
      registerEndpoint: (session, registration) =>
        service.registerEndpoint(session.notifications, { registration }),
      unregisterEndpoint: (session, { provider }) =>
        service.unregisterEndpoint(session.notifications, { provider }),
      setReminder: async (session, reminder) =>
        (await service.setReminder(session.notifications, reminder)).status,
      cancelReminder: async (session, { key }) =>
        (await service.cancelReminder(session.notifications, { key })).cancelled,
      listNotices: (session) => service.listNotices(session.notifications),
      recordNotice: (session, notice, { channel }) =>
        service.recordNoticeShown(session.notifications, notice, { channel }),
    },
  });
  return { request: (request) => handler.request(request) };
}

function warnBackendFailure(error: unknown, context: { readonly method: string }): void {
  // A throttled consent write is the player's own cap, and an input the
  // service refuses is the caller's: neither is a server failure, and a
  // webview could otherwise fill the log with them.
  if (
    error instanceof NotificationConsentRateLimitError
    || (error instanceof NotificationError && error.code === 'NOTIFICATIONS_INVALID_INPUT')
  ) {
    return;
  }
  console.warn(`devvit notifications ${context.method} failed`, error);
}

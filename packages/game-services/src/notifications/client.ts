import {
  assertNotificationConsentRecord,
  assertNotificationDeliveryProviderEntry,
  assertNotificationNotice,
  isNotificationErrorCode,
  NotificationError,
  type NotificationConsentRecord,
  type NotificationDeliveryProviderEntry,
  type NotificationErrorCode,
  type NotificationNotice,
} from '@mpgd/platform/notifications';
import type {
  NotificationRuntimeBackend,
  NotificationRuntimeReminderSetStatus,
  NotificationRuntimeSession,
} from '@mpgd/platform/notifications-runtime';

import {
  GameServicesHeaderResolutionError,
  resolveGameServicesRequestHeaders,
  type GameServicesHeaderResolver,
} from '../request-headers.js';
import { describeError } from './text.js';

/**
 * The game-services notifications client: the notifications runtime's
 * backend (`NotificationRuntimeBackend` from
 * `@mpgd/platform/notifications-runtime`) over the game-services Worker's
 * session routes under `/game-services/notifications` (see
 * docs/CLOUDFLARE_WORKER_DEPLOY.md, "Sessions" and "Client routes").
 *
 * The Worker learns the player, the session, and the installation from the
 * `Authorization` header alone, through its `GAME_SERVICES_NOTIFICATIONS_AUTH`
 * binding (the identity Worker's `authenticateNotificationSession`); no
 * request carries a player or an installation. The client learns which
 * session is current from the game's identity, which also supplies the
 * header through the same resolver the game gives its commerce client.
 *
 * No platform SDK, DOM, or Phaser import: only `fetch`.
 */

/** The Worker's route prefix for notifications. */
export const gameServicesNotificationsRoutePrefix = '/game-services/notifications';

/** The server-backed session the game is signed in with. */
export interface GameServicesNotificationSession {
  readonly playerId: string;
  /**
   * The stable session-family id: the `sessionId` the identity service
   * answers to the Worker's `authenticateNotificationSession` for this
   * session's header, the same across token refreshes. A new sign-in starts
   * a new one. A per-token or rotating id is not it (a
   * `GuestSessionCoordinator` view's `sessionId` may rotate on refresh; its
   * `sessionFamilyId` is the id, and `createGuestServerSession` passes it);
   * with one, each rotation counts as a new session and sends the
   * registration again.
   */
  readonly sessionId: string;
}

/**
 * The game's identity as the notifications client needs it. The game wires
 * it to its own session holder and identity service; the kit does not
 * create sessions.
 */
export interface GameServicesNotificationIdentity {
  /** The current session, or `undefined` while signed out. */
  current(): GameServicesNotificationSession | undefined;
  /**
   * Calls `listener` when a session becomes current after the subscription:
   * a sign-in, a session restored after the runtime started, or an account
   * switch. Returns the unsubscribe. A repeat for the session already
   * announced (a token refresh) is ignored, and so is one for the session
   * current when the runtime subscribed (at its `start()`); the runtime's
   * start registers again on its own when that session is not the one its
   * last registration was acknowledged for.
   */
  onAuthenticated(listener: (session: GameServicesNotificationSession) => void): () => void;
}

/** The part of the Fetch API the client uses; `globalThis.fetch` satisfies it. */
export type GameServicesNotificationsFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    /** Aborted when the request times out. */
    readonly signal?: AbortSignal;
  },
) => Promise<GameServicesNotificationsFetchResponse>;

export interface GameServicesNotificationsFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface CreateGameServicesNotificationsClientInput {
  /**
   * The game-services Worker's origin, as the commerce client takes it
   * (`VITE_MPGD_GAME_SERVICES_URL`). The client sends the session's
   * credentials to it as given: in a production build, check it with
   * `isPublicGameServicesUrl` from `@mpgd/game-services` first.
   */
  readonly baseUrl: string;
  readonly identity: GameServicesNotificationIdentity;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: GameServicesNotificationsFetch;
  /** Static headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Resolves the session's `Authorization` header at request time, as for the commerce client. */
  readonly getHeaders?: GameServicesHeaderResolver;
  /**
   * The catalog target a device registration is for (`android`, `ios`): the
   * Worker applies that target's topic mapping to the device and refuses a
   * registration without it when one provider serves two targets.
   */
  readonly target?: string;
  /**
   * How long one request may take, from resolving its headers to reading
   * its answer, before it is aborted and answers
   * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`; 15 seconds by default, at most
   * 2147483647.
   */
  readonly timeoutMs?: number;
}

/** The default `timeoutMs`: a request still unanswered after this is aborted. */
export const defaultGameServicesNotificationsTimeoutMs = 15_000;

/** The registry the Worker publishes at `GET /providers`. */
export interface GameServicesNotificationProviders {
  readonly protocolVersion: string;
  readonly providers: readonly NotificationDeliveryProviderEntry[];
  /** Each served target and the provider id that delivers to it. */
  readonly targets: Readonly<Record<string, string>>;
}

export interface GameServicesNotificationsClient extends NotificationRuntimeBackend {
  /**
   * The registry the Worker publishes (`GET /providers`, no session needed):
   * pass `providers.find((entry) => entry.provider === provider.provider)` as
   * the runtime's `registryEntry`. A provider entry this client cannot read
   * (malformed, or shaped by a Worker this client does not know) is left out,
   * so the other entries still load; a target whose provider has no entry
   * left finds none, which a caller should report rather than read as a
   * target the Worker does not serve.
   */
  getProviders(): Promise<GameServicesNotificationProviders>;
}

/**
 * A failed notifications request, with the `NotificationError` code the
 * runtime acts on and what the Worker answered.
 *
 * - 401: the session is not authenticated (signed out, token expired, or
 *   the session ended): `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, retryable
 *   once the game has a session again.
 * - 404 on a session route: the Worker serves no notifications for sessions
 *   (no catalog, or no `GAME_SERVICES_NOTIFICATIONS_AUTH` binding), and 405:
 *   the Worker does not serve this client's routes;
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`, not retryable.
 * - 400 and 413: `NOTIFICATIONS_INVALID_INPUT` (or the code the Worker names).
 * - 408, 425, 429, and 503: `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`. The
 *   runtime retries at its next trigger (a read, a start, a sign-in), not
 *   on the Worker's `Retry-After`, which the client does not read.
 * - Another status names the code the Worker answered when it is a
 *   notifications code (a Worker whose notifications configuration is
 *   broken answers 500 with `NOTIFICATIONS_CONFIGURATION_REQUIRED`, not
 *   retryable); otherwise a 5xx is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`
 *   and a 4xx `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
 * - A 2xx whose body is not JSON, or is empty (a captive portal or proxy
 *   answered): `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with that status. A
 *   2xx with JSON outside the route's contract:
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
 * - `status` 0, `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, nothing sent: no
 *   signed-in player with a session id, the header resolver failed or did
 *   not settle within `timeoutMs`, or the player signed out or changed
 *   while the headers were resolved.
 * - `status` 0, `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, no answer read: the
 *   request failed in transit, timed out (`timeoutMs`), or its body could
 *   not be read, so the Worker may have handled it. Retrying may repeat it: reminders and endpoints
 *   replace by key, but an advertising or night consent record is written
 *   again.
 */
export class GameServicesNotificationsRequestError extends NotificationError {
  /** The HTTP status, or 0 when no answer arrived. */
  readonly status: number;
  /** The route, such as `/consent`. */
  readonly route: string;
  /** The `error` the Worker answered, such as `UNAUTHORIZED`. */
  readonly serverCode: string | undefined;

  constructor(input: {
    readonly code: NotificationErrorCode;
    readonly route: string;
    readonly status: number;
    readonly message: string;
    readonly serverCode?: string;
    readonly cause?: unknown;
  }) {
    super(input.code, {
      message: input.message,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
    this.status = input.status;
    this.route = input.route;
    this.serverCode = input.serverCode;
  }
}

/** The player changed while a request's headers were resolved; nothing was sent. */
class NotificationsPlayerChangedError extends GameServicesNotificationsRequestError {}

const reminderSetStatuses: readonly NotificationRuntimeReminderSetStatus[] = [
  'scheduled',
  'replaced',
  'permission-required',
  'request-missing',
  'preference-off',
  'advertising-consent-missing',
  'capacity-exceeded',
  'unavailable',
];

type Route =
  | '/providers'
  | '/consent'
  | '/endpoints'
  | '/endpoints/unregister'
  | '/notices'
  | '/notices/shown'
  | '/reminders'
  | '/reminders/cancel';

/**
 * Creates the client. Every session call needs a current session and sends
 * the headers the resolver gives for it; without a session it throws
 * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` and sends nothing.
 */
export function createGameServicesNotificationsClient(
  input: CreateGameServicesNotificationsClientInput,
): GameServicesNotificationsClient {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/u, '');
  if (baseUrl.length === 0) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The game-services notifications client needs a baseUrl.',
    });
  }
  const { identity } = input;
  const timeoutMs = input.timeoutMs ?? defaultGameServicesNotificationsTimeoutMs;
  // setTimeout takes at most 2^31 - 1 ms; a longer delay would fire at once.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The notifications client timeoutMs must be a positive number of milliseconds, at most 2147483647.',
    });
  }
  if (input.target !== undefined && (typeof input.target !== 'string' || input.target.length === 0)) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The notifications client target must be a non-empty string.',
    });
  }

  const sessionOf = (session: GameServicesNotificationSession | undefined): NotificationRuntimeSession | undefined =>
    session !== undefined
      && typeof session.playerId === 'string'
      && session.playerId.length > 0
      && typeof session.sessionId === 'string'
      && session.sessionId.length > 0
      ? { id: session.sessionId, player: session.playerId }
      : undefined;
  const requireSession = (route: Route): NotificationRuntimeSession => {
    const session = sessionOf(identity.current());
    if (session === undefined) {
      throw new GameServicesNotificationsRequestError({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        route,
        status: 0,
        message: `${route} needs a signed-in player; no request was sent.`,
      });
    }
    return session;
  };

  /**
   * Sends one request. For a session route, `session` is the session the call
   * began for: if another player is signed in once the headers are resolved
   * (an account switch during a token refresh), nothing is sent, so one
   * player's call never goes out with the next player's credentials. The
   * same player under a new session id (an identity whose id rotates on
   * refresh) still sends: the Worker reads the session from the header.
   */
  const request = async (
    route: Route,
    method: 'GET' | 'POST',
    body: unknown,
    session: NotificationRuntimeSession | undefined,
  ): Promise<{ readonly response: GameServicesNotificationsFetchResponse; readonly text: string }> => {
    const fetcher = input.fetch ?? globalFetch();
    // One deadline for the whole request, from resolving its headers to
    // reading its answer: at the deadline the fetch is aborted and the call
    // answers, even when a header resolver or a fetch never settles, so no
    // runtime queue waits on it.
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`no answer within ${timeoutMs} ms`));
        try {
          controller?.abort();
        } catch {
          // The call has answered already.
        }
      }, timeoutMs);
    });
    deadline.catch(() => undefined);
    try {
      let headers: Readonly<Record<string, string>>;
      try {
        headers = await Promise.race([
          resolveGameServicesRequestHeaders({
            headers: input.headers,
            // The public registry read needs no credentials, so it works signed out.
            getHeaders: session === undefined ? undefined : input.getHeaders,
          }),
          deadline,
        ]);
      } catch (error) {
        throw new GameServicesNotificationsRequestError({
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          route,
          status: 0,
          message: timedOut
            ? `${route}: the session's request headers were not resolved within ${timeoutMs} ms; no request was sent.`
            : `${route}: the session's request headers could not be resolved; no request was sent.`,
          cause: error instanceof GameServicesHeaderResolutionError ? error : undefined,
        });
      }
      if (session !== undefined) {
        const now = sessionOf(identity.current());
        if (now === undefined || now.player !== session.player) {
          throw new NotificationsPlayerChangedError({
            code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
            route,
            status: 0,
            message: `${route}: the player signed out or changed while the request headers were resolved; `
              + 'no request was sent.',
          });
        }
      }
      try {
        const response = await Promise.race([
          fetcher(`${baseUrl}${gameServicesNotificationsRoutePrefix}${route}`, {
            method,
            headers: method === 'POST'
              ? { ...headers, 'content-type': 'application/json' }
              : { ...headers },
            ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
            ...(controller === undefined ? {} : { signal: controller.signal }),
          }),
          deadline,
        ]);
        return { response, text: await Promise.race([response.text(), deadline]) };
      } catch (error) {
        throw new GameServicesNotificationsRequestError({
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          route,
          status: 0,
          message: timedOut
            ? `${route}: the game-services Worker did not answer within ${timeoutMs} ms; the client stopped waiting `
              + '(and aborted the fetch, where it takes a signal).'
            : `${route}: the game-services Worker could not be reached.`,
          cause: error,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  };

  /** Sends one request and reads its answer as the route's JSON object. */
  const call = async (
    route: Route,
    method: 'GET' | 'POST',
    body: unknown,
    session: NotificationRuntimeSession | undefined,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const { response, text } = await request(route, method, body, session);
    const parsed = parseJson(text);
    if (response.status >= 200 && response.status < 300) {
      if (parsed === 'not-json') {
        // A success page that is not JSON, or an empty one (a 204), came from
        // something in between (a captive portal, a proxy), not from the
        // Worker, which always answers a JSON object: try again later.
        throw new GameServicesNotificationsRequestError({
          code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
          route,
          status: response.status,
          message: `${route}: the answer was not JSON; something between the game and the Worker answered.`,
        });
      }
      if (parsed === undefined) {
        throw contractBroken(route, response.status, 'the answer is not a JSON object');
      }
      return parsed;
    }
    throw errorOf(route, response, parsed === 'not-json' ? undefined : parsed);
  };

  return {
    session: () => sessionOf(identity.current()),
    onAuthenticated(listener) {
      // The session already current when the runtime subscribes is not a new
      // authentication; a later refresh of it is not either.
      let announced = sessionOf(identity.current());
      return identity.onAuthenticated((session) => {
        const next = sessionOf(session);
        if (next === undefined || (announced?.id === next.id && announced.player === next.player)) {
          return;
        }
        announced = next;
        listener(next);
      });
    },
    async recordConsent(record) {
      const session = requireSession('/consent');
      const answer = await call('/consent', 'POST', { record }, session);
      checked('/consent', () => assertNotificationConsentRecord(answer['record']));
    },
    async listConsent() {
      const session = requireSession('/consent');
      const answer = await call('/consent', 'GET', undefined, session);
      const records = answer['records'];
      if (!Array.isArray(records)) {
        throw contractBroken('/consent', 200, 'records is not a list');
      }
      return records.map((record: unknown): NotificationConsentRecord =>
        checked('/consent', () => assertNotificationConsentRecord(record)));
    },
    async registerEndpoint(registration) {
      const session = requireSession('/endpoints');
      await call(
        '/endpoints',
        'POST',
        { registration, ...(input.target === undefined ? {} : { target: input.target }) },
        session,
      );
    },
    async unregisterEndpoint({ provider, player }) {
      const session = sessionOf(identity.current());
      if (session === undefined || session.player !== player) {
        // The Worker unbinds the session's installation from the session's
        // player. Another player's session must not send it: the leaving
        // player's session already ended, and its end unbound what it registered.
        return;
      }
      try {
        await call('/endpoints/unregister', 'POST', { provider }, session);
      } catch (error) {
        // The player left while the headers were resolved, so nothing was
        // sent: as above, the session's end unbinds what it registered. A
        // request that went out and failed is the caller's to see.
        if (error instanceof NotificationsPlayerChangedError) {
          return;
        }
        throw error;
      }
    },
    async setReminder(reminder) {
      const session = requireSession('/reminders');
      const answer = await call('/reminders', 'POST', { reminder }, session);
      const status = answer['status'];
      if (!reminderSetStatuses.includes(status as NotificationRuntimeReminderSetStatus)) {
        throw contractBroken('/reminders', 200, `status ${JSON.stringify(status)} is not a reminder status`);
      }
      return status as NotificationRuntimeReminderSetStatus;
    },
    async cancelReminder({ key }) {
      const session = requireSession('/reminders/cancel');
      const answer = await call('/reminders/cancel', 'POST', { key }, session);
      if (typeof answer['cancelled'] !== 'boolean') {
        throw contractBroken('/reminders/cancel', 200, 'cancelled is not a boolean');
      }
      return answer['cancelled'];
    },
    async listNotices() {
      const session = requireSession('/notices');
      const answer = await call('/notices', 'GET', undefined, session);
      const notices = answer['notices'];
      if (!Array.isArray(notices)) {
        throw contractBroken('/notices', 200, 'notices is not a list');
      }
      return notices.map((notice: unknown): NotificationNotice =>
        checked('/notices', () => assertNotificationNotice(notice)));
    },
    async recordNotice({ channel, kind, record, dueBy }) {
      const session = requireSession('/notices/shown');
      await call('/notices/shown', 'POST', { notice: { kind, record, dueBy }, channel }, session);
    },
    async getProviders() {
      const answer = await call('/providers', 'GET', undefined, undefined);
      const { protocolVersion, providers, targets } = answer;
      if (
        typeof protocolVersion !== 'string'
        || !Array.isArray(providers)
        || typeof targets !== 'object'
        || targets === null
        || Array.isArray(targets)
        || !Object.values(targets).every((provider) => typeof provider === 'string')
      ) {
        throw contractBroken('/providers', 200, 'the registry is not { protocolVersion, providers, targets }');
      }
      return {
        protocolVersion,
        // One entry the client cannot read does not break the others.
        providers: providers.flatMap((entry: unknown): NotificationDeliveryProviderEntry[] => {
          try {
            return [assertNotificationDeliveryProviderEntry(entry)];
          } catch {
            return [];
          }
        }),
        targets: { ...(targets as Readonly<Record<string, string>>) },
      };
    },
  };
}

function globalFetch(): GameServicesNotificationsFetch {
  const fetcher = (globalThis as { readonly fetch?: GameServicesNotificationsFetch }).fetch;
  if (fetcher === undefined) {
    throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: 'globalThis.fetch is unavailable; give the notifications client a fetch.',
    });
  }
  return fetcher;
}

/** The JSON object an answer holds, `undefined` for other JSON, or `'not-json'`. */
function parseJson(text: string): Readonly<Record<string, unknown>> | undefined | 'not-json' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'not-json';
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Readonly<Record<string, unknown>>
    : undefined;
}

/** An answer that breaks the route's contract: the Worker, not the game, is wrong. */
function contractBroken(route: Route, status: number, issue: string): GameServicesNotificationsRequestError {
  return new GameServicesNotificationsRequestError({
    code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    route,
    status,
    message: `${route}: the game-services Worker answered outside the notifications contract: ${issue}.`,
  });
}

function checked<Value>(route: Route, read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    throw contractBroken(route, 200, describeError(error));
  }
}

function errorOf(
  route: Route,
  response: GameServicesNotificationsFetchResponse,
  body: Readonly<Record<string, unknown>> | undefined,
): GameServicesNotificationsRequestError {
  const { status } = response;
  const serverCode = typeof body?.['error'] === 'string' ? body['error'] : undefined;
  const serverMessage = typeof body?.['message'] === 'string' ? body['message'] : undefined;
  let code: NotificationErrorCode;
  let message: string;
  if (status === 401) {
    code = 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE';
    message = `${route}: the game-services session is not authenticated (signed out, expired, or ended).`;
  } else if (status === 404 || status === 405) {
    code = 'NOTIFICATIONS_CONFIGURATION_REQUIRED';
    message = route === '/providers'
      ? `${route}: the game-services Worker serves no notifications (no MPGD_NOTIFICATIONS_CATALOG).`
      : `${route}: the game-services Worker serves no notifications for sessions `
        + '(no MPGD_NOTIFICATIONS_CATALOG or no GAME_SERVICES_NOTIFICATIONS_AUTH binding).';
  } else if (status === 400 || status === 413) {
    code = serverCode !== undefined && isNotificationErrorCode(serverCode) ? serverCode : 'NOTIFICATIONS_INVALID_INPUT';
    message = `${route}: ${serverMessage ?? 'the game-services Worker refused the request as invalid.'}`;
  } else if (status === 408 || status === 425 || status === 429 || status === 503) {
    code = 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE';
    message = `${route}: ${serverMessage ?? 'the game-services Worker is busy; retry later.'}`;
  } else if (serverCode !== undefined && isNotificationErrorCode(serverCode)) {
    code = serverCode;
    message = `${route}: ${serverMessage ?? `the game-services Worker answered ${serverCode}.`}`;
  } else {
    code = status >= 500 ? 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' : 'NOTIFICATIONS_CONFIGURATION_REQUIRED';
    message = `${route}: the game-services Worker answered ${status}${serverCode === undefined ? '' : ` ${serverCode}`}.`;
  }
  return new GameServicesNotificationsRequestError({
    code,
    route,
    status,
    message,
    ...(serverCode === undefined ? {} : { serverCode }),
  });
}

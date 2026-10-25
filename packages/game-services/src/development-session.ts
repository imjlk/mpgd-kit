import { resolveGameServicesAuthorityMode } from './runtime.js';

/**
 * Local development notification sessions: an unauthenticated stand-in for
 * the game's identity service, so a developer can try the notifications
 * routes of a local game-services Worker before writing one.
 *
 * The Worker accepts `Authorization: Bearer mpgd-dev.<playerId>.<sessionId>.<installationId>`
 * only with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`,
 * without a `GAME_SERVICES_NOTIFICATIONS_AUTH` binding, never with the D1
 * store, and only on a request to a local host (loopback, `*.localhost`, or
 * the Android emulator's `10.0.2.2`). Anyone can write such a header, so it is no authentication:
 * never use it outside local development.
 */

/** The scheme and prefix of a development session's `Authorization` header. */
export const developmentNotificationSessionPrefix = 'Bearer mpgd-dev.';

/** Each id: 1 to 64 letters, digits, `_`, or `-` (so `.` can separate them). */
const idPattern = /^[A-Za-z0-9_-]{1,64}$/u;

/** The ids a development session token names. */
export interface DevelopmentNotificationSession {
  readonly playerId: string;
  readonly sessionId: string;
  readonly installationId: string;
}

/** Whether `value` can be one id of a development session. */
export function isDevelopmentNotificationSessionId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

/**
 * The `Authorization` header value for a development session. Throws when
 * an id is not 1 to 64 letters, digits, `_`, or `-`.
 */
export function formatDevelopmentNotificationSessionAuthorization(
  session: DevelopmentNotificationSession,
): string {
  const { playerId, sessionId, installationId } = session;
  if (
    !isDevelopmentNotificationSessionId(playerId)
    || !isDevelopmentNotificationSessionId(sessionId)
    || !isDevelopmentNotificationSessionId(installationId)
  ) {
    throw new Error(
      'A development notification session needs a playerId, sessionId, and installationId '
        + 'of 1 to 64 letters, digits, _ or -.',
    );
  }
  return `${developmentNotificationSessionPrefix}${playerId}.${sessionId}.${installationId}`;
}

/**
 * The session a development `Authorization` header names, or `undefined`
 * for any other value: exactly `Bearer mpgd-dev.` and three ids separated
 * by `.`, each 1 to 64 letters, digits, `_`, or `-`. It has no `expiresAt`.
 */
export function parseDevelopmentNotificationSessionAuthorization(
  authorization: unknown,
): DevelopmentNotificationSession | undefined {
  if (typeof authorization !== 'string' || !authorization.startsWith(developmentNotificationSessionPrefix)) {
    return undefined;
  }
  const parts = authorization.slice(developmentNotificationSessionPrefix.length).split('.');
  if (parts.length !== 3 || !parts.every(isDevelopmentNotificationSessionId)) {
    return undefined;
  }
  const [playerId, sessionId, installationId] = parts as [string, string, string];
  return { playerId, sessionId, installationId };
}

/** A development session as the game-services clients read a server-backed session. */
export interface DevelopmentServerSession {
  /** The development session; it is signed in from creation and never changes. */
  current(): { readonly playerId: string; readonly sessionId: string };
  /** Never calls `listener`: the session is current from creation. Returns the unsubscribe. */
  onAuthenticated(
    listener: (session: { readonly playerId: string; readonly sessionId: string }) => void,
  ): () => void;
  /** `{ authorization: 'Bearer mpgd-dev.…' }`. */
  getHeaders(): Readonly<Record<'authorization', string>>;
}

/**
 * A server-backed session for local development against a Worker that has
 * `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`. `mode`
 * must be the build's real mode (`import.meta.env.MODE`): `production`
 * throws, so a production build cannot create one. A build in another mode
 * named like production (`prod`, `release`) is not refused here; gate the
 * call on `import.meta.env.DEV` as the starter does. `sessionId` defaults to
 * `dev-<installationId>` (its first 64 characters). Ids are 1 to 64
 * letters, digits, `_`, or `-`.
 */
export function createDevelopmentServerSession(input: {
  readonly mode: string;
  readonly playerId: string;
  readonly installationId: string;
  readonly sessionId?: string;
}): DevelopmentServerSession {
  if (resolveGameServicesAuthorityMode(input.mode) === 'production') {
    throw new Error('Development notification sessions are refused in a production build.');
  }
  const session = {
    playerId: input.playerId,
    // Cut to the id limit, so a 61- to 64-character installation id still has a default.
    sessionId: input.sessionId ?? `dev-${input.installationId}`.slice(0, 64),
    installationId: input.installationId,
  };
  const authorization = formatDevelopmentNotificationSessionAuthorization(session);
  const current = Object.freeze({ playerId: session.playerId, sessionId: session.sessionId });
  return {
    current: () => current,
    onAuthenticated: () => () => undefined,
    getHeaders: () => ({ authorization }),
  };
}

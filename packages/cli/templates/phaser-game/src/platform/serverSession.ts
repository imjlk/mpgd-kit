import type { GameServicesHeaderResolver } from '@mpgd/game-services';

/**
 * The game's server-backed session: who is signed in to the game backend,
 * and the `Authorization` header for that session. The starter has none, so
 * `resolveStarterServerSession` returns `undefined`. Set yours with
 * `setStarterServerSession`, over your own session holder and identity
 * service. The commerce client then sends its header. In a game created with
 * `--providers notifications`, the notifications runtime uses the same
 * session and header for the game-services Worker's notification routes.
 *
 * `sessionId` must be the stable session-family id: the `sessionId` your
 * identity service answers to the Worker's `authenticateNotificationSession`
 * for this session's header, the same across token refreshes. Do not pass a
 * per-token or rotating id: a `GuestSessionCoordinator` view's `sessionId`
 * may rotate on refresh, so it is not that id.
 */
export interface StarterServerSession {
  /**
   * The signed-in player and session, or `undefined` while signed out.
   * `sessionId` is the stable session-family id (see above).
   */
  current(): { readonly playerId: string; readonly sessionId: string } | undefined;
  /** Calls `listener` when a session becomes current (sign-in, restore, account switch); returns the unsubscribe. */
  onAuthenticated(
    listener: (session: { readonly playerId: string; readonly sessionId: string }) => void,
  ): () => void;
  /** The current session's request headers, such as `{ authorization: 'Bearer …' }`. */
  readonly getHeaders: GameServicesHeaderResolver;
}

let serverSession: StarterServerSession | undefined;
/** Whether the commerce client read the session already: it reads it once. */
let readOnce = false;

/**
 * The game's server-backed session; `undefined` until the game sets one with
 * `setStarterServerSession`. `once` marks a reader that keeps what it reads
 * (the commerce client), so a later change warns.
 */
export function resolveStarterServerSession(
  options: { readonly once?: boolean } = {},
): StarterServerSession | undefined {
  if (options.once === true) {
    readOnce = true;
  }
  return serverSession;
}

/**
 * Sets the game's server-backed session. Call it at the top of `main.ts`,
 * before `bootstrap()`: `createStarterGameServices` reads it once, and the
 * notification settings and opens read it until a backend exists. Its
 * `current()` may answer `undefined` until the player signs in. A session
 * set after the commerce client was created does not reach that client,
 * which this warns about.
 */
export function setStarterServerSession(session: StarterServerSession | undefined): void {
  if (readOnce && session !== undefined && session !== serverSession) {
    console.warn(
      '[game-services] setStarterServerSession ran after the commerce client was created; '
        + "it does not send this session's header. Call it before bootstrap().",
    );
  }
  serverSession = session;
}

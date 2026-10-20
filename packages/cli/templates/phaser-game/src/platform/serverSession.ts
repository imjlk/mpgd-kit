import type { GameServicesHeaderResolver } from '@mpgd/game-services';

/**
 * The game's server-backed session: who is signed in to the game backend,
 * and the `Authorization` header for that session. The starter has none, so
 * `resolveStarterServerSession` returns `undefined`. Set yours with
 * `setStarterServerSession` (for example over a `GuestSessionCoordinator`
 * from `@mpgd/game-services` and your identity service): the commerce client
 * then sends its header, and,
 * in a game created with `--providers notifications`, the notifications
 * runtime uses the same session and header for the game-services Worker's
 * notification routes.
 */
export interface StarterServerSession {
  /**
   * The signed-in player and session, or `undefined` while signed out.
   * `sessionId` stays the same across token refreshes: it is the
   * `sessionId` your identity service answers to the Worker's
   * `authenticateNotificationSession`.
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
/** Whether something read the session already, so a later change cannot reach it. */
let read = false;

/** The game's server-backed session; `undefined` until the game sets one with `setStarterServerSession`. */
export function resolveStarterServerSession(): StarterServerSession | undefined {
  read = true;
  return serverSession;
}

/**
 * Sets the game's server-backed session. Call it at the top of `main.ts`,
 * before `bootstrap()`: `createStarterGameServices` reads it once, and the
 * notification settings and opens read it until a backend exists. Its
 * `current()` may answer `undefined` until the player signs in. A session
 * set after the commerce client was created does not reach it, which this
 * warns about.
 */
export function setStarterServerSession(session: StarterServerSession | undefined): void {
  if (read && session !== serverSession) {
    console.warn(
      '[game-services] setStarterServerSession ran after the session was first read; call it before bootstrap().',
    );
  }
  serverSession = session;
}

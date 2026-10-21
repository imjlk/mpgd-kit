import type { GameServicesHeaderResolver } from '@mpgd/game-services';

import {
  createStarterServerSessionSlot,
  resolveStarterDevelopmentServerSession,
} from './developmentServerSession';

/**
 * The game's server-backed session: who is signed in to the game backend,
 * and the `Authorization` header for that session. The starter has none, so
 * `resolveStarterServerSession` returns `undefined`. Set yours with
 * `setStarterServerSession`. The commerce client then sends its header. In
 * a game created with `--providers notifications`, the notifications
 * runtime uses the same session and header for the game-services Worker's
 * notification routes.
 *
 * With a guest-session backend, `createGuestServerSession` from
 * `@mpgd/game-services` reads a `GuestSessionCoordinator` as this session:
 *
 * ```ts
 * const guest = createGuestSessionCoordinator({ backend, credentials, installationId });
 * setStarterServerSession(createGuestServerSession(guest));
 * void guest.start();
 * ```
 *
 * `sessionId` must be the stable session-family id: the same across token
 * refreshes, and the session your identity service answers to the Worker's
 * `authenticateNotificationSession` for this session's header. Do not pass
 * a per-token or rotating id: `createGuestServerSession` answers the
 * coordinator's `sessionFamilyId`, never a view's `sessionId`, which may
 * rotate on refresh. With another session holder, pass its family id.
 *
 * For local development without an identity service, see
 * `developmentServerSession.ts`.
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

/** The game's session, or the development one (see `developmentServerSession.ts`). */
const slot = createStarterServerSessionSlot<StarterServerSession>({
  // `import.meta.env.DEV` is false in a normal `vite build`, which drops this branch.
  development: () =>
    import.meta.env.DEV
      ? resolveStarterDevelopmentServerSession({
          dev: import.meta.env.DEV,
          mode: import.meta.env.MODE,
          value: import.meta.env.VITE_MPGD_DEV_NOTIFICATION_SESSION,
        })
      : undefined,
  warn: (message) => console.warn(message),
});

/**
 * The game's server-backed session; `undefined` until the game sets one with
 * `setStarterServerSession`, unless a development session is on (see
 * `developmentServerSession.ts`). `once` marks a reader that keeps what it
 * reads (the commerce client), so a later change warns.
 */
export function resolveStarterServerSession(
  options: { readonly once?: boolean } = {},
): StarterServerSession | undefined {
  return slot.resolve(options);
}

/**
 * Sets the game's server-backed session. Call it at the top of `main.ts`,
 * before `bootstrap()`: `createStarterGameServices` reads it once, and the
 * notification settings and opens read it until a backend exists. Its
 * `current()` may answer `undefined` until the player signs in. A session
 * set after the commerce client was created does not reach that client,
 * which this warns about. Any call, `undefined` included, turns the
 * development session off; one made after it was handed out warns.
 */
export function setStarterServerSession(session: StarterServerSession | undefined): void {
  slot.set(session);
}

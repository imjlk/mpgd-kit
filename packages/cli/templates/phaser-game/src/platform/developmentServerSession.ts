import { createDevelopmentServerSession, type DevelopmentServerSession } from '@mpgd/game-services';

/**
 * Local development only: an unauthenticated session for a game-services
 * Worker run with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`
 * (see docs/NOTIFICATIONS.md, "Try it locally"). On only when the Vite dev
 * server runs (`dev`, `import.meta.env.DEV`), the mode is `development`, and
 * `VITE_MPGD_DEV_NOTIFICATION_SESSION` is `<playerId>` or
 * `<playerId>.<installationId>` (each 1 to 64 letters, digits, `_`, or `-`;
 * the installation defaults to `dev-installation`). The session id is
 * `dev-<installationId>`. Anyone can write such a header, so the Worker
 * refuses the flag with its D1 store. Otherwise `undefined`; an invalid
 * value logs why.
 */
export function resolveStarterDevelopmentServerSession(env: {
  readonly dev: boolean;
  readonly mode: string;
  readonly value: string | undefined;
}): DevelopmentServerSession | undefined {
  const value = env.value?.trim();
  // Only the development mode: a staging or release build that runs with
  // NODE_ENV=development has `dev` set too.
  if (!env.dev || env.mode !== 'development' || value === undefined || value === '') {
    return undefined;
  }
  const [playerId = '', installationId = 'dev-installation', ...rest] = value.split('.');
  try {
    if (rest.length > 0) {
      throw new Error('Expected <playerId> or <playerId>.<installationId>.');
    }
    const session = createDevelopmentServerSession({ mode: env.mode, playerId, installationId });
    console.warn(
      `[game-services] VITE_MPGD_DEV_NOTIFICATION_SESSION: signed in as ${playerId} with an `
        + 'unauthenticated development session. Local development only.',
    );
    return session;
  } catch (error) {
    console.error('[game-services] VITE_MPGD_DEV_NOTIFICATION_SESSION is ignored.', error);
    return undefined;
  }
}

/**
 * What `serverSession.ts` hands out, kept apart from `import.meta.env` so it
 * can be tested: the game's own session once it called `set` (even with
 * `undefined`), else the development session, read once. `once` marks the
 * reader that keeps what it reads, the commerce client, which only ever
 * gets the game's own session: the development session is for the
 * notifications Worker, and a commerce backend with ingress authentication
 * would refuse its header. A `set` that changes the session after a reader
 * kept the old one warns: after the commerce client read it, or after the
 * development session was handed out (a notifications backend keeps it).
 */
export function createStarterServerSessionSlot<Session extends object>(input: {
  /** The development session; called at most once. */
  readonly development: () => Session | undefined;
  readonly warn: (message: string) => void;
}): {
  resolve(options?: { readonly once?: boolean }): Session | undefined;
  set(session: Session | undefined): void;
} {
  let session: Session | undefined;
  let setByGame = false;
  let readOnce = false;
  let development: Session | null | undefined;
  let developmentHandedOut = false;
  return {
    resolve(options = {}) {
      if (options.once === true) {
        readOnce = true;
      }
      // The commerce client never gets the development session.
      if (setByGame || options.once === true) {
        return session;
      }
      if (development === undefined) {
        development = input.development() ?? null;
      }
      if (development === null) {
        return undefined;
      }
      developmentHandedOut = true;
      return development;
    },
    set(next) {
      if (developmentHandedOut && !setByGame) {
        // Even `undefined`: a notifications backend that kept the development session keeps sending its header.
        input.warn(
          '[game-services] setStarterServerSession ran after the development session '
            + '(VITE_MPGD_DEV_NOTIFICATION_SESSION) was in use; a notifications backend created '
            + 'already keeps it. Unset the variable, or call setStarterServerSession before bootstrap().',
        );
      }
      if (readOnce && next !== undefined && next !== session) {
        input.warn(
          '[game-services] setStarterServerSession ran after the commerce client was created; '
            + "it does not send this session's header. Call it before bootstrap().",
        );
      }
      session = next;
      setByGame = true;
    },
  };
}

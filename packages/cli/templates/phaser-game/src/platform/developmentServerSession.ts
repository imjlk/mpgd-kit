import { createDevelopmentServerSession, type DevelopmentServerSession } from '@mpgd/game-services';

/**
 * Local development only: an unauthenticated session for a game-services
 * Worker run with `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`
 * (see docs/NOTIFICATIONS.md, "Try it locally"). On when the Vite dev server
 * runs (`dev`, `import.meta.env.DEV`), the mode is not production, and
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
  if (!env.dev || value === undefined || value === '') {
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

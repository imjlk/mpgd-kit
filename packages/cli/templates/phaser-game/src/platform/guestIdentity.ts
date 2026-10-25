import {
  createGuestServerSession,
  createGuestSessionCoordinator,
  createGuestSessionHttpBackend,
  GuestSessionCoordinatorError,
  type GuestServerSession,
  type GuestSessionBackend,
  type GuestSessionCoordinator,
} from '@mpgd/game-services';
import type { SecureCredentialStore } from '@mpgd/platform';

import { setStarterCommerceServerPlayer } from './commerceAccountBinding';

/**
 * How long one identity request may hold the boot: 5 seconds. Offline, the
 * game starts after one timeout (three on the rare path that replaces an
 * ended session) and runs without a server session. The limit stays on the
 * coordinator's later requests too (refreshes in play), which are small.
 */
export const starterGuestIdentityTimeoutMs = 5_000;

/** Where the installation id is kept, next to the refresh token in the device's secure store. */
export const starterInstallationIdKey = 'mpgd.guest.installation';

export type StarterGuestIdentity =
  /** No `VITE_MPGD_IDENTITY_URL`: the game runs on the platform's local player and sells nothing on the stores. */
  | { readonly status: 'not-configured' }
  /** The target has no secure credential store (a browser build), so no refresh token can be kept. */
  | { readonly status: 'unavailable' }
  /**
   * Signed in: `playerId` is the server player that purchases, rewards, and
   * notifications use; pass `serverSession` to `setStarterServerSession`.
   */
  | {
      readonly status: 'signed-in';
      readonly playerId: string;
      /** `guest` until a later account linking makes the session `authenticated`. */
      readonly identityLevel: 'guest' | 'authenticated';
      readonly coordinator: GuestSessionCoordinator;
      readonly serverSession: GuestServerSession;
    }
  /** The identity service could not be reached or answered an error; the next launch tries again. */
  | { readonly status: 'failed'; readonly code: string };

/**
 * Signs the player in to the guest identity service at `identityUrl`
 * (`VITE_MPGD_IDENTITY_URL`, the reference Worker in the kit's
 * `apps/game-identity-worker`): a server-issued guest on the first launch,
 * the same guest restored from the device's Keychain or Keystore after that.
 * On success it binds store purchases to the server player
 * (`setStarterCommerceServerPlayer`) and returns the server session for
 * `setStarterServerSession`, whose header the game-services client and the
 * notifications runtime send (`main.ts` does both). Call it once, before the
 * game services are created.
 *
 * A refresh token the service refused for good (revoked, replayed, or idle
 * past the service's window) is logged out and a new guest is issued in its
 * place: that session cannot come back, and without a linked account its
 * player cannot either. Any other failure (offline, an outage) leaves the
 * stored token alone for the next attempt (`createStarterGuestSignIn`
 * retries), and until one succeeds purchases are refused with the reason
 * (`ACCOUNT_BINDING_REQUIRED` on Google Play, a StoreKit error naming the
 * missing session). One attempt: the game calls it through
 * `createStarterGuestSignIn`.
 */
export async function startStarterGuestIdentity(input: {
  readonly identityUrl: string | undefined;
  readonly credentials: SecureCredentialStore | undefined;
  readonly warn?: (message: string) => void;
  /** Tests replace the HTTP backend; a game passes nothing. */
  readonly backend?: GuestSessionBackend;
  readonly createInstallationId?: () => string;
}): Promise<StarterGuestIdentity> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const identityUrl = input.identityUrl?.trim();
  if (identityUrl === undefined || identityUrl === '') {
    return { status: 'not-configured' };
  }
  const credentials = input.credentials;
  if (credentials === undefined) {
    warn(
      '[identity] VITE_MPGD_IDENTITY_URL is set, but this target has no secure credential store; the game runs without a server session.',
    );
    return { status: 'unavailable' };
  }
  try {
    const backend = input.backend
      ?? createGuestSessionHttpBackend({ baseUrl: identityUrl, timeoutMs: starterGuestIdentityTimeoutMs });
    const installationId = await loadInstallationId(credentials, input.createInstallationId);
    const start = async () => {
      const coordinator = createGuestSessionCoordinator({ backend, credentials, installationId });
      return { coordinator, view: await coordinator.start() };
    };
    let started: Awaited<ReturnType<typeof start>>;
    try {
      started = await start();
    } catch (error) {
      if (!(error instanceof GuestSessionCoordinatorError) || error.code !== 'GUEST_SESSION_REJECTED') {
        throw error;
      }
      warn(
        '[identity] The stored guest session was ended by the identity service; starting a new guest.',
      );
      // Logout removes the dead token, so the next coordinator issues a new guest.
      await createGuestSessionCoordinator({ backend, credentials, installationId }).logout();
      started = await start();
    }
    const serverSession = createGuestServerSession(started.coordinator);
    setStarterCommerceServerPlayer(() => serverSession.current()?.playerId);
    return {
      status: 'signed-in',
      playerId: started.view.serverUserId,
      identityLevel: started.view.identityLevel,
      coordinator: started.coordinator,
      serverSession,
    };
  } catch (error) {
    const code = error instanceof GuestSessionCoordinatorError
      ? error.code
      : 'GUEST_IDENTITY_FAILED';
    warn(
      `[identity] Guest sign-in failed (${code}); purchases stay unavailable until a sign-in succeeds.`,
    );
    // Purchases bind to the server player or to nothing: never to the platform's local player.
    setStarterCommerceServerPlayer(() => undefined);
    return { status: 'failed', code };
  }
}

/**
 * The installation id the identity service issues guests for: random, made
 * once, and kept in the secure store so a restored session keeps its
 * installation. It is never authority, only the key of the service's
 * per-installation limit and of the notification endpoints.
 */
async function loadInstallationId(
  credentials: SecureCredentialStore,
  create: (() => string) | undefined,
): Promise<string> {
  const stored = await credentials.load({ key: starterInstallationIdKey });
  if (stored !== null && /^[A-Za-z0-9_-]{8,128}$/u.test(stored)) {
    return stored;
  }
  // randomUUID needs a secure context; getRandomValues does not.
  const installationId = create?.() ?? globalThis.crypto.randomUUID?.()
    ?? [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  await credentials.save({ key: starterInstallationIdKey, value: installationId });
  return installationId;
}

export type StarterSignedIn = Extract<StarterGuestIdentity, { readonly status: 'signed-in' }>;

/** Waits between background sign-in retries after a failure: 5 s, 15 s, 1 min, then every 5 min. */
export const starterGuestSignInRetryDelaysMs: readonly number[] = Object.freeze([
  5_000, 15_000, 60_000, 300_000,
]);

/**
 * The game's guest sign-in for the whole run: the first attempt at boot, and
 * when that fails (offline, an outage), more attempts in the background
 * (`starterGuestSignInRetryDelaysMs`, and at once when the browser reports
 * `online`) until one succeeds. `ensure()` also tries at once, so a purchase
 * or restore started after the network returned signs in first. Listeners
 * hear the first success; the signed-in session never changes after that
 * within the run.
 */
export interface StarterGuestSignIn {
  /** False without `VITE_MPGD_IDENTITY_URL` or a secure credential store: nothing is ever tried. */
  readonly configured: boolean;
  current(): StarterSignedIn | undefined;
  /** The session, signing in now when there is none (joins an attempt in flight). */
  ensure(): Promise<StarterSignedIn | undefined>;
  /** Called once, when the first sign-in succeeds (at once when it already has); returns the unsubscribe. */
  onSignedIn(listener: (signedIn: StarterSignedIn) => void): () => void;
  /** Stops the background retries. */
  dispose(): void;
}

export function createStarterGuestSignIn(input: Parameters<typeof startStarterGuestIdentity>[0] & {
  /** Tests inject the timer; the game passes nothing. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Subscribes to "the network is back"; defaults to the window `online` event. */
  readonly onOnline?: (callback: () => void) => () => void;
}): StarterGuestSignIn {
  const identityUrl = input.identityUrl?.trim();
  const configured = identityUrl !== undefined && identityUrl !== '' && input.credentials !== undefined;
  const schedule = input.schedule ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const listeners = new Set<(signedIn: StarterSignedIn) => void>();
  let signedIn: StarterSignedIn | undefined;
  let attempt: Promise<StarterSignedIn | undefined> | undefined;
  /** Failed background attempts: on-demand ones (a purchase, a restore tap) do not lengthen the backoff. */
  let backgroundFailures = 0;
  let cancelRetry: (() => void) | undefined;
  let disposed = false;
  let stopOnline: (() => void) | undefined;

  const scheduleRetry = () => {
    if (disposed || signedIn !== undefined || cancelRetry !== undefined || !configured) {
      return;
    }
    const delays = starterGuestSignInRetryDelaysMs;
    const delay = delays[Math.min(backgroundFailures, delays.length - 1)] ?? 300_000;
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      void attemptNow(true);
    }, delay);
  };

  function ensure(): Promise<StarterSignedIn | undefined> {
    return attemptNow(false);
  }

  function attemptNow(background: boolean): Promise<StarterSignedIn | undefined> {
    if (signedIn !== undefined) {
      return Promise.resolve(signedIn);
    }
    if (attempt !== undefined) {
      return attempt;
    }
    if (!configured) {
      // One attempt reports why (and warns, for a missing secure store); nothing to retry.
      attempt = startStarterGuestIdentity(input).then(() => undefined);
      return attempt;
    }
    cancelRetry?.();
    cancelRetry = undefined;
    attempt = startStarterGuestIdentity(input).then((result) => {
      attempt = undefined;
      if (result.status !== 'signed-in') {
        if (background) {
          backgroundFailures += 1;
        }
        scheduleRetry();
        return undefined;
      }
      signedIn = result;
      stopOnline?.();
      for (const listener of [...listeners]) {
        try {
          listener(result);
        } catch (error) {
          console.error('[identity] a sign-in listener failed', error);
        }
      }
      listeners.clear();
      return result;
    });
    return attempt;
  }

  if (configured) {
    const subscribeOnline = input.onOnline ?? ((callback: () => void) => {
      if (typeof globalThis.addEventListener !== 'function') {
        return () => undefined;
      }
      globalThis.addEventListener('online', callback);
      return () => globalThis.removeEventListener('online', callback);
    });
    stopOnline = subscribeOnline(() => {
      if (!disposed && signedIn === undefined) {
        void ensure();
      }
    });
  }

  return {
    configured,
    current: () => signedIn,
    ensure,
    onSignedIn(listener) {
      // Already signed in (a retry won the race with the caller): heard at once.
      if (signedIn !== undefined) {
        listener(signedIn);
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      cancelRetry?.();
      cancelRetry = undefined;
      stopOnline?.();
    },
  };
}

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
 * stored token alone for the next launch, and until then purchases are
 * refused with the reason (`ACCOUNT_BINDING_REQUIRED` on Google Play, a
 * StoreKit error naming the missing session).
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
    const backend = input.backend ?? createGuestSessionHttpBackend({ baseUrl: identityUrl });
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
      coordinator: started.coordinator,
      serverSession,
    };
  } catch (error) {
    const code = error instanceof GuestSessionCoordinatorError
      ? error.code
      : 'GUEST_IDENTITY_FAILED';
    warn(
      `[identity] Guest sign-in failed (${code}); purchases stay unavailable until the next launch signs in.`,
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
  const installationId = create?.() ?? crypto.randomUUID();
  await credentials.save({ key: starterInstallationIdKey, value: installationId });
  return installationId;
}

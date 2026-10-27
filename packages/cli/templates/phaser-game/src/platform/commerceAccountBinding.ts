import type { IdentitySession, PlatformGateway } from '@mpgd/platform';
import type { StorePurchaseAccountBinding } from '@mpgd/platform/commerce';

/**
 * Reference account binding of the native store providers. Google Play's
 * obfuscated account id and StoreKit's app account token must be stable,
 * non-identifying, and derived the same way by the game backend
 * (`resolveObfuscatedAccountId` of the Play verifier,
 * `resolveAppAccountToken` of the App Store verifier), which is how the
 * backend ties a store purchase to the player before it grants. This module
 * derives both from a SHA-256 digest of the server player id (the reference
 * identity Worker, apps/game-identity-worker, derives the same); a game with
 * its own account scheme replaces these two functions and the backend
 * resolvers together. Nothing here grants anything.
 */
export const starterAccountBindingDigestPrefix = 'mpgd-commerce-account:';

/** The game's server player source; see `setStarterCommerceServerPlayer`. */
let serverPlayer: (() => string | undefined) | undefined;

/**
 * Binds store purchases to the player of the game's server session (the
 * identity service's player, a server-issued guest included) instead of the
 * platform session. A generated game's `guestIdentity.ts` sets it when
 * `VITE_MPGD_IDENTITY_URL` is configured; `undefined` restores the platform
 * session. While it is set, no server player (not signed in yet, or the
 * sign-in failed) binds nothing: the platform's local player never stands in.
 */
export function setStarterCommerceServerPlayer(source: (() => string | undefined) | undefined): void {
  serverPlayer = source;
}

/** The open pins: one per game services instance, all for the same player. */
const pins = new Set<{ readonly playerId: string }>();

/** Another player's game services are still open; dispose them before creating these. */
export class StarterCommercePinConflictError extends Error {
  constructor() {
    super("Another player's game services are still open; dispose them before creating these.");
    this.name = 'StarterCommercePinConflictError';
  }
}

/**
 * Pins purchases to the player a game services instance was created for
 * (`createStarterGameServices` does, and releases it once those services
 * were disposed): while the session names anyone else, a purchase binds
 * nothing and is refused before any store sheet, so no purchase is
 * journaled under one player and bound to another's store account. Returns
 * the release (idempotent). Throws `StarterCommercePinConflictError` while
 * an earlier instance for another player is still open.
 */
export function pinStarterCommercePlayer(playerId: string): () => void {
  if ([...pins].some((pin) => pin.playerId !== playerId)) {
    throw new StarterCommercePinConflictError();
  }
  const pin = { playerId };
  pins.add(pin);
  return () => {
    pins.delete(pin);
  };
}

/**
 * The player id a purchase is bound to: the server session's player when
 * the game set one (`setStarterCommerceServerPlayer`), else an
 * `authenticated` platform session whose trust is not `local`. A
 * platform-anonymous session (the native shell's `android-local-player` /
 * `ios-local-player`) or a locally asserted id would give every install the
 * same binding, so it binds nothing; the backend binds the purchase to the
 * player its ingress authentication resolved anyway. While game services
 * are pinned to a player (`pinStarterCommercePlayer`), any other player
 * binds nothing too.
 */
export async function resolveStarterCommercePlayerId(
  gateway: Pick<PlatformGateway, 'identity'>,
): Promise<string | undefined> {
  const playerId = await resolveSessionPlayerId(gateway);
  // Another player than the services' (an account switch): bind nothing.
  return [...pins].some((pin) => pin.playerId !== playerId) ? undefined : playerId;
}

async function resolveSessionPlayerId(
  gateway: Pick<PlatformGateway, 'identity'>,
): Promise<string | undefined> {
  if (serverPlayer !== undefined) {
    const playerId = serverPlayer()?.trim();
    return playerId === undefined || playerId.length === 0 ? undefined : playerId;
  }
  let session: IdentitySession | undefined;
  try {
    session = await gateway.identity.getSession?.();
  } catch {
    return undefined;
  }
  if (session?.identityLevel !== 'authenticated' || session.trustLevel === 'local') {
    return undefined;
  }
  const playerId = session.playerId?.trim();
  return playerId === undefined || playerId.length === 0 ? undefined : playerId;
}

/**
 * Google Play `obfuscatedAccountId`: 64 hex characters, within Play's
 * 64-character limit. `undefined` without a player, which the Play
 * provider refuses with `ACCOUNT_BINDING_REQUIRED`.
 */
export async function resolvePlayBillingAccountBinding(
  gateway: Pick<PlatformGateway, 'identity'>,
): Promise<StorePurchaseAccountBinding | undefined> {
  const playerId = await resolveStarterCommercePlayerId(gateway);
  if (playerId === undefined) {
    return undefined;
  }
  return { kind: 'obfuscated-account-id', value: toHex(await digestPlayerId(playerId)) };
}

/** StoreKit `appAccountToken`: a non-nil UUID derived from the same digest. */
export async function resolveStoreKitAppAccountToken(
  gateway: Pick<PlatformGateway, 'identity'>,
): Promise<string> {
  const playerId = await resolveStarterCommercePlayerId(gateway);
  if (playerId === undefined) {
    throw new Error(
      'A StoreKit purchase is bound to the player of a server session, and there is none: '
        + 'sign in to an identity service first (a generated game: VITE_MPGD_IDENTITY_URL and '
        + "src/platform/guestIdentity.ts). The native shell's local player cannot bind a purchase.",
    );
  }
  return toUuid(await digestPlayerId(playerId));
}

/**
 * The store account binding the native providers above give `playerId`'s
 * purchases on `target` (`android`: Google Play's obfuscated account id,
 * `ios`: StoreKit's app account token), derived from the player id alone;
 * `undefined` on other targets. The game services runtime compares store
 * purchases with it (`commerceAccountBinding`) so another player's purchase
 * is never verified for this one.
 */
export async function resolveStarterStoreAccountBindingFor(
  target: string,
  playerId: string,
): Promise<StorePurchaseAccountBinding | undefined> {
  if (target === 'android') {
    return { kind: 'obfuscated-account-id', value: toHex(await digestPlayerId(playerId)) };
  }
  if (target === 'ios') {
    return { kind: 'app-account-token', value: toUuid(await digestPlayerId(playerId)) };
  }
  return undefined;
}

async function digestPlayerId(playerId: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`${starterAccountBindingDigestPrefix}${playerId}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** RFC 4122 layout (version 5 nibble, variant bits) over the first 16 digest bytes. */
function toUuid(bytes: Uint8Array): string {
  const uuid = bytes.slice(0, 16);
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x50;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(uuid);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

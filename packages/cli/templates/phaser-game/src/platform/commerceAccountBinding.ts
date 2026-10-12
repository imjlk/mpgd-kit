import type { IdentitySession, PlatformGateway } from '@mpgd/platform';
import type { StorePurchaseAccountBinding } from '@mpgd/platform/commerce';

/**
 * Reference account binding of the native store providers. Google Play's
 * obfuscated account id and StoreKit's app account token must be stable,
 * non-identifying, and derived the same way by the game backend
 * (`resolveObfuscatedAccountId` of the Play verifier,
 * `resolveAppAccountToken` of the App Store verifier), which is how the
 * backend ties a store purchase to the player before it grants. This module
 * derives both from a SHA-256 digest of the authenticated player id; a game
 * with its own account scheme replaces these two functions and the backend
 * resolvers together. Nothing here grants anything.
 */
export const starterAccountBindingDigestPrefix = 'mpgd-commerce-account:';

/**
 * The authenticated player id a purchase is bound to. Only an
 * `authenticated` session whose trust is not `local` binds: a guest, a
 * platform-anonymous session (the native shell's default
 * `android-local-player` / `ios-local-player`), or a locally asserted id
 * would give every install the same binding, and the backend binds the
 * purchase to its own authenticated player id anyway.
 */
export async function resolveStarterCommercePlayerId(
  gateway: Pick<PlatformGateway, 'identity'>,
): Promise<string | undefined> {
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

/** Google Play `obfuscatedAccountId`: 64 hex characters, within Play's 64-character limit. */
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
    throw new Error('A StoreKit purchase requires an authenticated player session.');
  }
  return toUuid(await digestPlayerId(playerId));
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

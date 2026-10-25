import { hex } from './tokens.js';

/**
 * The store account bindings of a player, derived exactly as the generated
 * game's `src/platform/commerceAccountBinding.ts` derives them on the device
 * (docs/GAME_SERVICES_BACKEND.md, "Generated games bind purchases"): Google
 * Play's `obfuscatedAccountId` is the lowercase hex SHA-256 of
 * `mpgd-commerce-account:<playerId>`, and StoreKit's `appAccountToken` is the
 * first 16 bytes of that digest laid out as a version 5 UUID. Both are stable
 * for the player, carry nothing that identifies them, and fit the stores'
 * limits (64 characters for Play, a non-nil UUID for StoreKit). A game that
 * changes the client derivation changes this module with it.
 */
export const commerceAccountDigestPrefix = 'mpgd-commerce-account:';

async function digestPlayerId(playerId: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`${commerceAccountDigestPrefix}${playerId}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Google Play `obfuscatedAccountId` for `playerId`: 64 lowercase hex characters. */
export async function deriveObfuscatedAccountId(playerId: string): Promise<string> {
  return hex(await digestPlayerId(playerId));
}

/** StoreKit `appAccountToken` for `playerId`: a lowercase version 5 layout UUID. */
export async function deriveAppAccountToken(playerId: string): Promise<string> {
  const uuid = (await digestPlayerId(playerId)).slice(0, 16);
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x50;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;
  const text = hex(uuid);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

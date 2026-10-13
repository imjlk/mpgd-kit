import type { Verse8RecordedPurchase } from '@mpgd/adapter-verse8';

/**
 * The game-owned Agent8 remote client the Verse8 gateway reads commerce state
 * through: one authenticated server method exposed for the sender's own
 * account (see docs/VERSE8_COMMERCE.md, "Iframe client boundary"). The
 * starter installs no Agent8 browser SDK, so `resolveStarterVerse8Agent8Client`
 * answers `undefined` until the game provides one; VXShop then stays off and
 * the gateway offers no `commerce` provider and sells nothing. The client only
 * reads: `$onItemPurchased` on the Agent8 server is the sole grant path.
 * Entitlements are not read from the client: they come from the backend
 * ledger through game-services.
 */
export interface StarterVerse8Agent8Client {
  /** The purchases `$onItemPurchased` recorded (`listPurchases` of the Agent8 commerce service). */
  listPurchases(): Promise<readonly Verse8RecordedPurchase[]>;
}

/** Return the game's authenticated Agent8 client here to enable VXShop and commerce on Verse8. */
export function resolveStarterVerse8Agent8Client(): StarterVerse8Agent8Client | undefined {
  return undefined;
}

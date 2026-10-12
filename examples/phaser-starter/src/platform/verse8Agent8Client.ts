import type { Verse8RecordedPurchase } from '@mpgd/adapter-verse8';
import type { Entitlement } from '@mpgd/platform';

/**
 * The game-owned Agent8 remote client the Verse8 gateway reads commerce state
 * through: two authenticated server methods exposed for the sender's own
 * account (see docs/VERSE8_COMMERCE.md, "Iframe client boundary"). The
 * starter installs no Agent8 browser SDK, so `resolveStarterVerse8Agent8Client`
 * answers `undefined` until the game provides one; VXShop then stays off and
 * the gateway offers no `commerceV2`, exactly as before. The client only
 * reads: `$onItemPurchased` on the Agent8 server is the sole grant path.
 */
export interface StarterVerse8Agent8Client {
  /** Server-owned balances and entitlements (`getSnapshot` of the Agent8 commerce service). */
  getCommerceSnapshot(): Promise<{ readonly entitlements: readonly Entitlement[] }>;
  /** The purchases `$onItemPurchased` recorded (`listPurchases` of the Agent8 commerce service). */
  listPurchases(): Promise<readonly Verse8RecordedPurchase[]>;
}

/** Return the game's authenticated Agent8 client here to enable VXShop and commerce v2 on Verse8. */
export function resolveStarterVerse8Agent8Client(): StarterVerse8Agent8Client | undefined {
  return undefined;
}

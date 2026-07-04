import type { AdPlacements } from '@mpgd/ad-placements';
import adPlacementsJson from '@mpgd/ad-placements/placements.json';
import { claimAdReward } from '@mpgd/backend-ad-reward-ledger';
import { createInMemoryEntitlementLedger } from '@mpgd/backend-entitlement-ledger';
import { createInMemoryLeaderboardLedger } from '@mpgd/backend-leaderboard-ledger';
import { verifyPurchase } from '@mpgd/backend-purchase-verifier';
import { createLiveOpsClient, type LiveOpsClient } from '@mpgd/liveops-client';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';
import productCatalogJson from '@mpgd/product-catalog/catalog.json';

import type { DemoState } from './demoState';

const entitlementLedger = createInMemoryEntitlementLedger();
const leaderboardLedger = createInMemoryLeaderboardLedger();
const productCatalog = productCatalogJson as ProductCatalog;
const adPlacements = adPlacementsJson as AdPlacements;

export function createDemoLiveOpsClient(
  platform: PlatformGateway,
  state: DemoState,
): LiveOpsClient | null {
  if (!isStoreLiveOpsTarget(platform.target)) {
    return null;
  }

  return createLiveOpsClient({
    gateway: platform,
    playerId: state.player.playerId,
    target: platform.target,
    backend: {
      purchases: {
        async verifyPurchase(input) {
          return verifyPurchase(input, {
            catalog: productCatalog,
            ledger: entitlementLedger,
          });
        },
      },
      adRewards: {
        async claimAdReward(input) {
          return claimAdReward(input, {
            placements: adPlacements,
            ledger: entitlementLedger,
          });
        },
      },
      leaderboard: {
        async recordScore(input) {
          return leaderboardLedger.recordScore(input);
        },
      },
    },
  });
}

function isStoreLiveOpsTarget(
  target: PlatformTarget,
): target is 'android' | 'ios' | 'ait' {
  return target === 'android' || target === 'ios' || target === 'ait';
}

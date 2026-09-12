import type {
  GameServicesOperationClient,
  GameServicesPurchaseProgress,
} from '@mpgd/game-services/operations';
const client: GameServicesOperationClient = {
  purchase: async () => ({ status: 'cancelled', purchase: { status: 'cancelled', productId: 'example', entitlementIds: [] } }),
  claimRewardedAd: async () => ({ status: 'skipped', reward: { status: 'skipped', placementId: 'example', rewardGranted: false } }),
};
const progress: GameServicesPurchaseProgress = {
  kind: 'purchase',
  phase: 'platform-requested',
  sequence: 1,
};
void client;
void progress;

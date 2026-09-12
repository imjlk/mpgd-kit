import type {
  GameServicesClient,
  GameServicesOperationOptions,
  GameServicesPurchaseProgress,
  GameServicesRewardedAdProgress,
} from '@mpgd/game-services/client';

declare const client: GameServicesClient;
const purchaseOptions: GameServicesOperationOptions<GameServicesPurchaseProgress> = {
  onProgress: (progress) => {
    const kind: 'purchase' = progress.kind;
    if (progress.phase === 'platform-result') {
      const status: 'completed' | 'cancelled' | 'pending' | 'failed' = progress.status;
      void status;
    }
    // @ts-expect-error Published events are readonly.
    progress.sequence = 10;
    void kind;
  },
};
const rewardOptions: GameServicesOperationOptions<GameServicesRewardedAdProgress> = {
  onProgress: async (progress) => {
    const kind: 'rewarded-ad' = progress.kind;
    if (progress.phase === 'platform-result') {
      const status: 'completed' | 'skipped' | 'unavailable' | 'failed' = progress.status;
      void status;
    }
    void kind;
  },
};
void client.purchase(
  { productId: 'COINS_100', source: 'shop', idempotencyKey: 'one' },
  purchaseOptions,
);
void client.claimRewardedAd(
  { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'two' },
  rewardOptions,
);
void client.purchase({ productId: 'COINS_100', source: 'shop', idempotencyKey: 'three' });

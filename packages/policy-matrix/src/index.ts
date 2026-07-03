import typia from 'typia';

export interface TargetPolicy {
  readonly iap: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly leaderboard: boolean;
}

export interface PolicyMatrix {
  readonly version: string;
  readonly targets: Record<string, TargetPolicy>;
}

export const assertPolicyMatrix = typia.createAssert<PolicyMatrix>();

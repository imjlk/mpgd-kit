import type { PlatformCapabilities, PlatformGateway } from '@mpgd/platform-contract';

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

export type PolicyFeature = keyof TargetPolicy;
export type PolicyAdPlacementType = 'rewarded' | 'interstitial';
type PlatformPolicyTarget = PlatformGateway['target'];

export interface PolicyEnforcementOptions {
  readonly resolveAdPlacementType?: (
    placementId: string,
  ) => PolicyAdPlacementType | undefined;
}

export function policyTargetForPlatform(target: PlatformPolicyTarget): string {
  return target === 'browser' ? 'web-preview' : target;
}

export function getTargetPolicy(
  matrix: PolicyMatrix,
  target: PlatformPolicyTarget | string,
): TargetPolicy {
  const policy = matrix.targets[target];

  if (policy === undefined) {
    throw new Error(`Missing platform policy for target: ${target}`);
  }

  return policy;
}

export function isPolicyFeatureEnabled(
  policy: TargetPolicy,
  feature: PolicyFeature,
): boolean {
  return policy[feature];
}

export function applyPolicyToCapabilities(
  capabilities: PlatformCapabilities,
  policy: TargetPolicy,
): PlatformCapabilities {
  return {
    ...capabilities,
    nativeIap: capabilities.nativeIap && policy.iap,
    nativeAds: capabilities.nativeAds && (policy.rewardedAds || policy.interstitialAds),
    rewardedAds: capabilities.rewardedAds && policy.rewardedAds,
    interstitialAds: capabilities.interstitialAds && policy.interstitialAds,
    nativeLeaderboard: capabilities.nativeLeaderboard && policy.leaderboard,
  };
}

export function withPolicyEnforcement(
  gateway: PlatformGateway,
  policy: TargetPolicy,
  options: PolicyEnforcementOptions = {},
): PlatformGateway {
  const isAdPlacementAllowed = (
    placementId: string,
    expectedType: PolicyAdPlacementType,
  ): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType !== undefined && actualType !== expectedType) {
      return false;
    }

    return expectedType === 'rewarded' ? policy.rewardedAds : policy.interstitialAds;
  };

  const canPreloadAdPlacement = (placementId: string): boolean => {
    const actualType = options.resolveAdPlacementType?.(placementId);

    if (actualType === 'rewarded') {
      return policy.rewardedAds;
    }

    if (actualType === 'interstitial') {
      return policy.interstitialAds;
    }

    return policy.rewardedAds || policy.interstitialAds;
  };

  return {
    ...gateway,
    async getCapabilities() {
      return applyPolicyToCapabilities(await gateway.getCapabilities(), policy);
    },
    commerce: policy.iap
      ? gateway.commerce
      : {
          async getProducts() {
            return [];
          },
          async purchase() {
            return {
              status: 'cancelled',
              entitlementIds: [],
            };
          },
          async restore() {
            return {
              restoredEntitlements: [],
            };
          },
          async getEntitlements() {
            return [];
          },
    },
    ads: {
      async preload(input) {
        if (canPreloadAdPlacement(input.placementId)) {
          await gateway.ads.preload(input);
        }
      },
      async showRewarded(input) {
        if (!isAdPlacementAllowed(input.placementId, 'rewarded')) {
          return {
            status: 'unavailable',
            rewardGranted: false,
          };
        }

        return gateway.ads.showRewarded(input);
      },
      async showInterstitial(input) {
        if (
          !isAdPlacementAllowed(input.placementId, 'interstitial') ||
          gateway.ads.showInterstitial === undefined
        ) {
          return {
            status: 'unavailable',
          };
        }

        return gateway.ads.showInterstitial(input);
      },
    },
    leaderboard: policy.leaderboard
      ? gateway.leaderboard
      : {
          async submitScore() {
            return {
              submitted: false,
            };
          },
          async open() {},
        },
  };
}

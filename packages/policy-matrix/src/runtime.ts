import type { PlatformCapabilities, PlatformGateway } from '@mpgd/platform-contract';

export interface TargetPolicy {
  readonly iap: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly leaderboard: boolean;
  readonly i18n: boolean;
}

export interface PolicyMatrix {
  readonly version: string;
  readonly targets: Record<string, TargetPolicy>;
}

export type PolicyFeature = keyof TargetPolicy;
export type PolicyAdPlacementType = 'rewarded' | 'interstitial';
type PlatformPolicyTarget = PlatformGateway['target'];

export type PolicyFeatureRuntimeReason =
  | 'available'
  | 'policy-disabled'
  | 'capability-unsupported';

export interface PolicyFeatureRuntime {
  readonly feature: PolicyFeature;
  readonly enabled: boolean;
  readonly policyAllowed: boolean;
  readonly capabilitySupported: boolean;
  readonly reason: PolicyFeatureRuntimeReason;
}

export interface PolicyAdPlacementDefinition {
  readonly id: string;
  readonly type: PolicyAdPlacementType;
}

export interface PolicyAdPlacementRuntime {
  readonly id: string;
  readonly type: PolicyAdPlacementType;
  readonly enabled: boolean;
  readonly reason: PolicyFeatureRuntimeReason;
}

export interface PolicyRuntimeSnapshot {
  readonly target: PlatformPolicyTarget;
  readonly policyTarget: string;
  readonly policy: TargetPolicy;
  readonly capabilities: PlatformCapabilities;
  readonly features: Record<PolicyFeature, PolicyFeatureRuntime>;
  readonly adPlacements: readonly PolicyAdPlacementRuntime[];
}

export interface PolicyEnforcementOptions {
  readonly policyTarget?: string;
  readonly adPlacements?: readonly PolicyAdPlacementDefinition[];
  readonly resolveAdPlacementType?: (
    placementId: string,
  ) => PolicyAdPlacementType | undefined;
}

export interface PolicyEnforcedGateway extends PlatformGateway {
  readonly policyTarget: string;
  readonly policy: TargetPolicy;
  getPolicyRuntime(): Promise<PolicyRuntimeSnapshot>;
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
    localizedContent: capabilities.localizedContent && policy.i18n,
  };
}

export function getPolicyFeatureRuntime(
  feature: PolicyFeature,
  policy: TargetPolicy,
  capabilities: PlatformCapabilities,
): PolicyFeatureRuntime {
  const policyAllowed = policy[feature];
  const capabilitySupported = isFeatureCapabilitySupported(feature, capabilities);
  const enabled = policyAllowed && capabilitySupported;

  return {
    feature,
    enabled,
    policyAllowed,
    capabilitySupported,
    reason: enabled
      ? 'available'
      : policyAllowed
        ? 'capability-unsupported'
        : 'policy-disabled',
  };
}

export function createPolicyRuntimeSnapshot(input: {
  readonly target: PlatformPolicyTarget;
  readonly policyTarget?: string;
  readonly policy: TargetPolicy;
  readonly capabilities: PlatformCapabilities;
  readonly adPlacements?: readonly PolicyAdPlacementDefinition[];
}): PolicyRuntimeSnapshot {
  const policyTarget = input.policyTarget ?? policyTargetForPlatform(input.target);
  const features = {
    iap: getPolicyFeatureRuntime('iap', input.policy, input.capabilities),
    rewardedAds: getPolicyFeatureRuntime('rewardedAds', input.policy, input.capabilities),
    interstitialAds: getPolicyFeatureRuntime(
      'interstitialAds',
      input.policy,
      input.capabilities,
    ),
    leaderboard: getPolicyFeatureRuntime('leaderboard', input.policy, input.capabilities),
    i18n: getPolicyFeatureRuntime('i18n', input.policy, input.capabilities),
  } satisfies Record<PolicyFeature, PolicyFeatureRuntime>;

  return {
    target: input.target,
    policyTarget,
    policy: input.policy,
    capabilities: input.capabilities,
    features,
    adPlacements: (input.adPlacements ?? []).map((placement) => {
      const feature = placement.type === 'rewarded' ? 'rewardedAds' : 'interstitialAds';
      const runtime = features[feature];

      return {
        id: placement.id,
        type: placement.type,
        enabled: runtime.enabled,
        reason: runtime.reason,
      };
    }),
  };
}

export function withPolicyEnforcement(
  gateway: PlatformGateway,
  policy: TargetPolicy,
  options: PolicyEnforcementOptions = {},
): PolicyEnforcedGateway {
  const policyTarget = options.policyTarget ?? policyTargetForPlatform(gateway.target);
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
    policyTarget,
    policy,
    async getPolicyRuntime() {
      return createPolicyRuntimeSnapshot({
        target: gateway.target,
        policyTarget,
        policy,
        capabilities: applyPolicyToCapabilities(await gateway.getCapabilities(), policy),
        adPlacements: options.adPlacements ?? [],
      });
    },
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

export function isPolicyEnforcedGateway(
  gateway: PlatformGateway,
): gateway is PolicyEnforcedGateway {
  return typeof (gateway as Partial<PolicyEnforcedGateway>).getPolicyRuntime === 'function';
}

function isFeatureCapabilitySupported(
  feature: PolicyFeature,
  capabilities: PlatformCapabilities,
): boolean {
  switch (feature) {
    case 'iap':
      return capabilities.nativeIap;
    case 'rewardedAds':
      return capabilities.rewardedAds;
    case 'interstitialAds':
      return capabilities.interstitialAds;
    case 'leaderboard':
      return capabilities.nativeLeaderboard;
    case 'i18n':
      return capabilities.localizedContent;
  }
}

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { PlatformCapabilities, PlatformGateway, PlatformTarget } from '@mpgd/platform';
import {
  platformCapabilityKeys,
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from '@mpgd/platform/capability-conformance';
import {
  getTargetConfig,
  withTargetAvailability,
  type TargetConfig,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '@mpgd/target-config';

import { createAitPlatformGateway } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import { createCapacitorPlatformGateway } from '../../adapters/capacitor/src/index';
import { createDevvitPlatformGateway } from '../../adapters/devvit/src/index';
import { createVerse8PlatformGateway } from '../../adapters/verse8/src/index';
import { readJsonFile } from '../io';

type ConfigTarget =
  | 'web-preview'
  | 'microsoft-store'
  | 'verse8'
  | 'android'
  | 'ios'
  | 'ait'
  | 'reddit';

interface TargetSpec {
  readonly configTarget: ConfigTarget;
  readonly expectedTarget: PlatformTarget;
}

interface CreatedGateway {
  readonly gateway: PlatformGateway;
  readonly expectedCapabilities: PlatformCapabilities;
  readonly transition?: {
    readonly update: () => void;
    readonly expectedCapabilities: PlatformCapabilities;
  };
}

interface RuntimeMirrorCheck {
  readonly name: string;
  readonly gateway: TargetConfiguredGateway;
  readonly expectedCapabilities: PlatformCapabilities;
}

const targetSpecs = [
  { configTarget: 'web-preview', expectedTarget: 'browser' },
  { configTarget: 'microsoft-store', expectedTarget: 'browser' },
  { configTarget: 'verse8', expectedTarget: 'verse8' },
  { configTarget: 'android', expectedTarget: 'android' },
  { configTarget: 'ios', expectedTarget: 'ios' },
  { configTarget: 'ait', expectedTarget: 'ait' },
  { configTarget: 'reddit', expectedTarget: 'reddit' },
] as const satisfies readonly TargetSpec[];

const initialBridgeCapabilities = {
  nativeIap: true,
  nativeAds: true,
  rewardedAds: true,
  interstitialAds: true,
  nativeLeaderboard: true,
  achievements: false,
  cloudSave: true,
  socialShare: true,
  haptics: true,
  localizedContent: true,
} as const satisfies PlatformCapabilities;

const updatedBridgeCapabilities = {
  nativeIap: false,
  nativeAds: false,
  rewardedAds: false,
  interstitialAds: false,
  nativeLeaderboard: false,
  achievements: true,
  cloudSave: false,
  socialShare: false,
  haptics: false,
  localizedContent: false,
} as const satisfies PlatformCapabilities;

const targetConfigMatrix = readJsonFile(
  'packages/target-config/targets.json',
) as TargetConfigMatrix;
const fixtures: PlatformGatewayCapabilityConformanceFixture[] = [];
const runtimeMirrorChecks: RuntimeMirrorCheck[] = [];

for (const spec of targetSpecs) {
  fixtures.push(createRawFixture(spec));

  const configured = createConfiguredFixture(spec);
  fixtures.push(configured.fixture);
  runtimeMirrorChecks.push(configured.runtimeMirrorCheck);
}

const report = await runPlatformGatewayCapabilityConformance({ fixtures });

for (const check of runtimeMirrorChecks) {
  const runtime = await check.gateway.getTargetRuntime();
  assertCapabilitiesEqual(
    runtime.capabilities,
    check.expectedCapabilities,
    `${check.name} runtime snapshot`,
  );
}

if (report.passedFixtures.length !== targetSpecs.length * 2) {
  throw new Error('Expected raw and target-configured capability fixtures for every target.');
}

console.log(
  'Platform capability conformance passed: raw and target-configured snapshots for web-preview, microsoft-store, verse8, android, ios, ait, reddit',
);

function createRawFixture(spec: TargetSpec): PlatformGatewayCapabilityConformanceFixture {
  const created = createGateway(spec.configTarget);

  return {
    name: `${spec.configTarget}:raw`,
    gateway: created.gateway,
    expectedTarget: spec.expectedTarget,
    expectedCapabilities: created.expectedCapabilities,
    ...(created.transition === undefined ? {} : { transition: created.transition }),
  };
}

function createConfiguredFixture(spec: TargetSpec): {
  readonly fixture: PlatformGatewayCapabilityConformanceFixture;
  readonly runtimeMirrorCheck: RuntimeMirrorCheck;
} {
  const created = createGateway(spec.configTarget);
  const config = getTargetConfig(targetConfigMatrix, spec.configTarget);
  const gateway = withTargetAvailability(created.gateway, config, {
    configTarget: spec.configTarget,
  });
  const expectedCapabilities = maskCapabilities(created.expectedCapabilities, config);
  const expectedFinalCapabilities = created.transition === undefined
    ? expectedCapabilities
    : maskCapabilities(created.transition.expectedCapabilities, config);

  return {
    fixture: {
      name: `${spec.configTarget}:configured`,
      gateway,
      expectedTarget: spec.expectedTarget,
      expectedCapabilities,
      ...(created.transition === undefined
        ? {}
        : {
            transition: {
              update: created.transition.update,
              expectedCapabilities: expectedFinalCapabilities,
            },
          }),
    },
    runtimeMirrorCheck: {
      name: spec.configTarget,
      gateway,
      expectedCapabilities: expectedFinalCapabilities,
    },
  };
}

function createGateway(configTarget: ConfigTarget): CreatedGateway {
  switch (configTarget) {
    case 'web-preview':
    case 'microsoft-store':
      return createBrowserGateway();
    case 'verse8':
      return createVerse8Gateway();
    case 'android':
    case 'ios':
      return createBridgeGateway(configTarget);
    case 'ait':
    case 'reddit':
      return createBridgeGateway(configTarget);
  }
}

function createBrowserGateway(): CreatedGateway {
  return {
    gateway: createBrowserPlatformGateway({
      async share() {},
    }),
    expectedCapabilities: {
      nativeIap: false,
      nativeAds: false,
      rewardedAds: true,
      interstitialAds: true,
      nativeLeaderboard: false,
      achievements: false,
      cloudSave: true,
      socialShare: true,
      haptics: false,
      localizedContent: true,
    },
  };
}

function createVerse8Gateway(): CreatedGateway {
  return {
    gateway: createVerse8PlatformGateway({
      resolveAdPlacementId(placementId) {
        return `verse8:${placementId}`;
      },
      agent8Storage: {
        async load() {
          return null;
        },
        async save() {},
      },
    }),
    expectedCapabilities: {
      nativeIap: false,
      nativeAds: true,
      rewardedAds: true,
      interstitialAds: true,
      nativeLeaderboard: false,
      achievements: false,
      cloudSave: true,
      socialShare: false,
      haptics: false,
      localizedContent: true,
    },
  };
}

function createBridgeGateway(
  configTarget: Extract<ConfigTarget, 'android' | 'ios' | 'ait' | 'reddit'>,
): CreatedGateway {
  const mutableBridge = createMutableCapabilityBridge(initialBridgeCapabilities);
  const commonInput = {
    appVersion: '1.0.0',
    buildId: `capability-conformance:${configTarget}`,
    bridge: mutableBridge.bridge,
  };
  const gateway = configTarget === 'android' || configTarget === 'ios'
    ? createCapacitorPlatformGateway({ ...commonInput, target: configTarget })
    : configTarget === 'ait'
      ? createAitPlatformGateway(commonInput)
      : createDevvitPlatformGateway(commonInput);

  return {
    gateway,
    expectedCapabilities: initialBridgeCapabilities,
    transition: {
      update() {
        mutableBridge.setCapabilities(updatedBridgeCapabilities);
      },
      expectedCapabilities: updatedBridgeCapabilities,
    },
  };
}

function createMutableCapabilityBridge(initial: PlatformCapabilities): {
  readonly bridge: { request(input: BridgeRequest): Promise<BridgeResponse> };
  readonly setCapabilities: (capabilities: PlatformCapabilities) => void;
} {
  let capabilities = { ...initial };

  return {
    bridge: {
      async request(input) {
        if (input.method !== 'runtime.getCapabilities') {
          throw new Error(`Unexpected capability conformance bridge method: ${input.method}.`);
        }

        return {
          id: input.id,
          ok: true,
          // Return the provider-owned object deliberately. Adapters must expose
          // an isolated snapshot instead of leaking this reference.
          data: capabilities,
        };
      },
    },
    setCapabilities(nextCapabilities) {
      capabilities = { ...nextCapabilities };
    },
  };
}

function maskCapabilities(
  capabilities: PlatformCapabilities,
  config: TargetConfig,
): PlatformCapabilities {
  return {
    ...capabilities,
    nativeIap: capabilities.nativeIap && config.features.iap,
    nativeAds:
      capabilities.nativeAds
      && (config.features.rewardedAds || config.features.interstitialAds),
    rewardedAds: capabilities.rewardedAds && config.features.rewardedAds,
    interstitialAds: capabilities.interstitialAds && config.features.interstitialAds,
    nativeLeaderboard: capabilities.nativeLeaderboard && config.features.leaderboard,
    localizedContent: capabilities.localizedContent && config.features.localization,
  };
}

function assertCapabilitiesEqual(
  actual: PlatformCapabilities,
  expected: PlatformCapabilities,
  label: string,
): void {
  for (const key of platformCapabilityKeys) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label} capability ${key} mismatch. Expected ${String(expected[key])}, received ${String(actual[key])}.`,
      );
    }
  }
}

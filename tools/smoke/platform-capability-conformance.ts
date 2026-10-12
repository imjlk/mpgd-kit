import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import {
  createUnsupportedCommerceCapabilities,
  type CommerceCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlatformProviderAvailability,
  type PlatformProviderFeature,
  type PlatformTarget,
} from '@mpgd/platform';
import {
  platformCapabilityKeys,
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from '@mpgd/platform/capability-conformance';
import {
  applyTargetConfigToCapabilities,
  getTargetConfig,
  withTargetAvailability,
  type TargetConfig,
  type TargetConfigMatrix,
  type TargetConfiguredGateway,
} from '@mpgd/target-config';

import { createAitPlatformGateway } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import {
  createMicrosoftStoreCommerceCapabilities,
  createMicrosoftStoreCommerceProvider,
  withMicrosoftStoreCommerceProvider,
  type MicrosoftStoreCommerceAvailability,
} from '../../adapters/browser/src/microsoft-store';
import {
  createCapacitorPlatformGateway,
  createCommerceServiceProvider,
  createStoreCommerceProvider,
  type StoreSdk,
} from '../../adapters/capacitor/src/index';
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
  { configTarget: 'microsoft-store', expectedTarget: 'microsoft-store' },
  { configTarget: 'verse8', expectedTarget: 'verse8' },
  { configTarget: 'android', expectedTarget: 'android' },
  { configTarget: 'ios', expectedTarget: 'ios' },
  { configTarget: 'ait', expectedTarget: 'ait' },
  { configTarget: 'reddit', expectedTarget: 'reddit' },
] as const satisfies readonly TargetSpec[];

/**
 * A selling block a bridged host may still claim. A gateway without a commerce
 * provider sells nothing whatever the host says, so every bridge fixture below
 * expects the unsupported block; only the provider fixtures expect a real one.
 */
const hostClaimedCommerce = {
  purchase: { consumable: true, durable: true, subscription: false, quantity: false },
  catalog: { products: true, offers: false, localizedPrice: false },
  lifecycle: {
    availablePurchases: true,
    pending: true,
    restore: false,
    events: true,
    finish: 'server',
  },
  authority: { evidence: 'client-token', accountBinding: 'required' },
  availability: 'available',
} as const satisfies CommerceCapabilities;

const initialBridgeCapabilities = {
  nativeAds: true,
  bannerAds: true,
  rewardedAds: true,
  interstitialAds: true,
  nativeLeaderboard: true,
  remoteLeaderboard: false,
  achievements: false,
  cloudSave: true,
  socialShare: true,
  haptics: true,
  localizedContent: true,
  commerce: hostClaimedCommerce,
} as const satisfies PlatformCapabilities;

const updatedBridgeCapabilities = {
  nativeAds: false,
  bannerAds: false,
  rewardedAds: false,
  interstitialAds: false,
  nativeLeaderboard: false,
  remoteLeaderboard: false,
  achievements: true,
  cloudSave: false,
  socialShare: false,
  haptics: false,
  localizedContent: false,
  commerce: createUnsupportedCommerceCapabilities(),
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
// A Capacitor gateway with a commerce provider reports that provider's block
// (the only commerce source) and every read must be fresh.
fixtures.push(createCommerceV2Fixture());
// The Microsoft Store commerce provider wiring reports its block over the
// browser base gateway.
fixtures.push(createMicrosoftStoreCommerceV2Fixture());

const report = await runPlatformGatewayCapabilityConformance({ fixtures });

for (const check of runtimeMirrorChecks) {
  const runtime = await check.gateway.getTargetRuntime();
  assertCapabilitiesEqual(
    runtime.capabilities,
    check.expectedCapabilities,
    `${check.name} runtime snapshot`,
  );
}

if (report.passedFixtures.length !== targetSpecs.length * 2 + 2) {
  throw new Error('Expected raw and target-configured capability fixtures for every target.');
}

console.log(
  'Platform capability conformance passed: raw and target-configured snapshots for web-preview, microsoft-store, verse8, android, ios, ait, reddit, plus the android and microsoft-store commerce v2 blocks',
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
      return createBrowserGateway();
    case 'microsoft-store':
      return createMicrosoftStoreGateway();
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
      storage: {
        getItem() {
          return null;
        },
        setItem() {},
      },
    }),
    expectedCapabilities: {
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      nativeLeaderboard: false,
      remoteLeaderboard: false,
      achievements: false,
      cloudSave: true,
      socialShare: true,
      haptics: false,
      localizedContent: true,
      commerce: createUnsupportedCommerceCapabilities(),
    },
  };
}

function createMicrosoftStoreGateway(): CreatedGateway {
  const browser = createBrowserGateway();
  const base: PlatformGateway = { ...browser.gateway, target: 'microsoft-store' };
  const commerce = createMicrosoftStoreCommerceProvider({
    getRecoveryScope: () => 'configuration-required',
    products: [],
    authority: {
      async getAvailability() {
        return 'configuration-required';
      },
      async claimRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async hasRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async verifyAndGrant() {
        return { status: 'failed' };
      },
    },
  });

  return {
    gateway: withMicrosoftStoreCommerceProvider(base, commerce),
    expectedCapabilities: {
      ...browser.expectedCapabilities,
      commerce: createMicrosoftStoreCommerceCapabilities('configuration-required'),
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
      nativeAds: true,
      rewardedAds: true,
      interstitialAds: true,
      nativeLeaderboard: false,
      remoteLeaderboard: false,
      achievements: false,
      cloudSave: true,
      socialShare: false,
      haptics: false,
      localizedContent: true,
      commerce: createUnsupportedCommerceCapabilities(),
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

  const expectedInitial = configTarget === 'android' || configTarget === 'ios'
    ? withoutCapacitorProviders(initialBridgeCapabilities)
    : withoutCommerceProvider(initialBridgeCapabilities);
  const expectedUpdated = configTarget === 'android' || configTarget === 'ios'
    ? withoutCapacitorProviders(updatedBridgeCapabilities)
    : withoutCommerceProvider(updatedBridgeCapabilities);

  return {
    gateway,
    expectedCapabilities: expectedInitial,
    transition: {
      update() {
        mutableBridge.setCapabilities(updatedBridgeCapabilities);
      },
      expectedCapabilities: expectedUpdated,
    },
  };
}

function createCommerceV2Fixture(): PlatformGatewayCapabilityConformanceFixture {
  let availability: PlatformProviderAvailability = 'available';
  const sdk: StoreSdk = {
    store: 'conformance-store',
    capabilities: {
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      pending: true,
      restore: false,
      finish: 'server',
    },
    async fetchProducts() {
      return [];
    },
    async requestPurchase() {
      return { outcome: 'launched' };
    },
    async getAvailablePurchases() {
      return [];
    },
    addListener() {
      return () => undefined;
    },
    async getAvailability() {
      return availability;
    },
  };
  const commerce = createStoreCommerceProvider({
    sdk,
    products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
    evidenceSchema: 'conformance.store.v1',
    authority: { evidence: 'client-token', accountBinding: 'required' },
  });
  const gateway = createCapacitorPlatformGateway({
    appVersion: '1.0.0',
    buildId: 'capability-conformance:android:commerce-v2',
    target: 'android',
    bridge: createMutableCapabilityBridge(initialBridgeCapabilities).bridge,
    providers: [createCommerceServiceProvider({ id: 'conformance-store', commerce })],
  });
  const expected = (
    state: PlatformProviderAvailability,
  ): PlatformCapabilities => {
    const base = withoutCapacitorProviders(initialBridgeCapabilities);
    return {
      ...base,
      commerce: {
        purchase: { consumable: true, durable: true, subscription: false, quantity: false },
        catalog: { products: true, offers: false, localizedPrice: true },
        lifecycle: {
          availablePurchases: true,
          pending: true,
          restore: false,
          events: true,
          finish: 'server',
        },
        authority: { evidence: 'client-token', accountBinding: 'required' },
        availability: state,
      },
    };
  };

  return {
    name: 'android:commerce-v2',
    gateway,
    expectedTarget: 'android',
    expectedCapabilities: expected('available'),
    transition: {
      update() {
        availability = 'configuration-required';
      },
      expectedCapabilities: expected('configuration-required'),
    },
  };
}

function createMicrosoftStoreCommerceV2Fixture(): PlatformGatewayCapabilityConformanceFixture {
  let availability: MicrosoftStoreCommerceAvailability = 'available';
  const browser = createBrowserGateway();
  const base: PlatformGateway = { ...browser.gateway, target: 'microsoft-store' };
  const provider = createMicrosoftStoreCommerceProvider({
    getRecoveryScope: () => 'capability-conformance',
    products: [],
    authority: {
      async getAvailability() {
        return availability;
      },
      async claimRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async hasRecoveryOwnership() {
        return { status: 'denied' } as const;
      },
      async verifyAndGrant() {
        return { status: 'failed' };
      },
    },
    async getDigitalGoodsService() {
      return {
        async getDetails() {
          return [];
        },
        async listPurchases() {
          return [];
        },
      };
    },
  });
  const expected = (state: MicrosoftStoreCommerceAvailability): PlatformCapabilities => ({
    ...browser.expectedCapabilities,
    commerce: {
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: false,
        restore: true,
        events: true,
        finish: 'server',
      },
      authority: { evidence: 'adapter-settled', accountBinding: 'required' },
      availability: state,
    },
  });

  return {
    name: 'microsoft-store:commerce-v2',
    gateway: withMicrosoftStoreCommerceProvider(base, provider),
    expectedTarget: 'microsoft-store',
    expectedCapabilities: expected('available'),
    transition: {
      update() {
        availability = 'configuration-required';
      },
      expectedCapabilities: expected('configuration-required'),
    },
  };
}

/** What a gateway without a commerce provider reports, whatever its host claims. */
function withoutCommerceProvider(base: PlatformCapabilities): PlatformCapabilities {
  return { ...base, commerce: createUnsupportedCommerceCapabilities() };
}

function withoutCapacitorProviders(base: PlatformCapabilities): PlatformCapabilities {
  return {
    ...base,
    commerce: createUnsupportedCommerceCapabilities(),
    nativeAds: false,
    rewardedAds: false,
    interstitialAds: false,
    bannerAds: false,
    nativeLeaderboard: false,
    providerAvailability: {
      rewardedAds: 'unsupported',
      interstitialAds: 'unsupported',
      bannerAds: 'unsupported',
      nativeLeaderboard: 'unsupported',
      identityUpgrade: 'unsupported',
      pushNotifications: 'unsupported',
    } satisfies Readonly<Record<PlatformProviderFeature, PlatformProviderAvailability>>,
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
  return applyTargetConfigToCapabilities(capabilities, config);
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
  if (JSON.stringify(sortedCommerce(actual.commerce)) !== JSON.stringify(sortedCommerce(expected.commerce))) {
    throw new Error(
      `${label} commerce capabilities mismatch. Expected ${JSON.stringify(expected.commerce)}, received ${JSON.stringify(actual.commerce)}.`,
    );
  }
}

function sortedCommerce(commerce: CommerceCapabilities): unknown {
  return [
    ['purchase', Object.entries(commerce.purchase).sort()],
    ['catalog', Object.entries(commerce.catalog).sort()],
    ['lifecycle', Object.entries(commerce.lifecycle).sort()],
    ['authority', Object.entries(commerce.authority).sort()],
    ['availability', commerce.availability],
  ];
}

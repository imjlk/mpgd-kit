import { createAitPlatformGateway } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import { createCapacitorPlatformGateway } from '../../adapters/capacitor/src/index';
import type { AdPlacements } from '../../packages/ad-placements/src/index';
import type {
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
} from '../../packages/bridge-protocol/src/index';
import type {
  PlatformCapabilities,
  PlatformGateway,
} from '../../packages/platform-contract/src/index';
import {
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
  type EffectiveTargetConfig,
  type EffectiveTargetConfigMatrix,
} from '../../packages/target-config/src/effective';
import {
  getTargetConfig,
  withTargetAvailability,
  type TargetConfigMatrix,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';
import { loadEffectiveTargetConfigMatrix } from '../target/effective-config';

const targetConfigMatrix = readJsonFile(
  'packages/target-config/targets.json',
) as TargetConfigMatrix;
const effectiveConfigMatrix =
  loadEffectiveTargetConfigMatrix() as EffectiveTargetConfigMatrix;
const adPlacements = readJsonFile('packages/ad-placements/placements.json') as AdPlacements;
const targetAdPlacements = adPlacements.placements.map((placement) => ({
  id: placement.id,
  type: placement.type,
}));
const adPlacementTypes = new Map<string, 'rewarded' | 'interstitial'>(
  targetAdPlacements.map((placement) => [placement.id, placement.type]),
);

await verifyBrowserAdapter();
await verifyCapacitorAdapter('android');
await verifyCapacitorAdapter('ios');
await verifyAitAdapter();

console.log('Adapter effective target config smoke passed: browser, android, ios, ait');

async function verifyBrowserAdapter(): Promise<void> {
  const gateway = wrapGateway('web-preview', createBrowserPlatformGateway());
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'web-preview');

  assertEqual(effectiveConfig.target, 'web-preview', 'browser effective target');
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    false,
    'browser product should be disabled',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    false,
    'browser rewarded placement should be disabled',
  );
  assertDeepEqual(
    await gateway.commerce.purchase({
      productId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'browser-parity-purchase',
    }),
    {
      status: 'cancelled',
      entitlementIds: [],
    },
    'browser purchase should be target-disabled',
  );
}

async function verifyCapacitorAdapter(target: 'android' | 'ios'): Promise<void> {
  const bridge = createRecordingBridge(target);
  const gateway = wrapGateway(
    target,
    createCapacitorPlatformGateway({
      target,
      appVersion: '1.0.0',
      buildId: `build-${target}`,
      bridge,
    }),
  );
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, target);

  assertEqual(effectiveConfig.target, target, `${target} effective target`);
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    true,
    `${target} product should be enabled`,
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    true,
    `${target} rewarded placement should be enabled`,
  );

  await gateway.commerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: `${target}-parity-purchase`,
  });
  await gateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: `${target}-parity-reward`,
  });
  await gateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: `${target}-parity-run`,
    submittedAt: new Date().toISOString(),
  });

  assertDeepEqual(
    bridge.methods.slice(1),
    ['commerce.purchase', 'ads.showRewarded', 'leaderboard.submitScore'],
    `${target} adapter should delegate enabled actions`,
  );
}

async function verifyAitAdapter(): Promise<void> {
  const bridge = createRecordingBridge('ait');
  const gateway = wrapGateway(
    'ait',
    createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'build-ait',
      bridge,
    }),
  );
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'ait');

  assertEqual(effectiveConfig.target, 'ait', 'ait effective target');
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    true,
    'ait product should be enabled',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    true,
    'ait rewarded placement should be enabled',
  );

  await gateway.commerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'ait-parity-purchase',
  });
  await gateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'ait-parity-reward',
  });
  await gateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: 'ait-parity-run',
    submittedAt: new Date().toISOString(),
  });

  assertDeepEqual(
    bridge.methods.slice(1),
    ['commerce.purchase', 'ads.showRewarded', 'leaderboard.submitScore'],
    'ait adapter should delegate enabled actions',
  );
}

function requireEffectiveConfig(
  config: EffectiveTargetConfig | undefined,
  target: string,
): EffectiveTargetConfig {
  if (config === undefined) {
    throw new Error(`Missing runtime effective target config for ${target}.`);
  }

  return config;
}

function wrapGateway(configTarget: string, gateway: PlatformGateway) {
  const config = getTargetConfig(targetConfigMatrix, configTarget);
  const effectiveConfig = effectiveConfigMatrix.targets[configTarget];

  if (effectiveConfig === undefined) {
    throw new Error(`Missing effective target config for ${configTarget}.`);
  }

  return withTargetAvailability(gateway, config, {
    configTarget,
    effectiveConfig,
    adPlacements: targetAdPlacements,
    resolveAdPlacementType(placementId) {
      return adPlacementTypes.get(placementId);
    },
  });
}

function createRecordingBridge(target: 'android' | 'ios' | 'ait') {
  const methods: BridgeMethod[] = [];

  return {
    methods,
    async request(input: BridgeRequest): Promise<BridgeResponse> {
      methods.push(input.method);

      return {
        id: input.id,
        ok: true,
        data: responseDataForMethod(target, input.method),
      };
    },
  };
}

function responseDataForMethod(target: 'android' | 'ios' | 'ait', method: BridgeMethod): unknown {
  switch (method) {
    case 'runtime.getCapabilities':
      return enabledCapabilities(target);
    case 'identity.getPlayer':
      return {
        playerId: `${target}-player`,
        displayName: `${target} Player`,
      };
    case 'commerce.getProducts':
      return [];
    case 'commerce.purchase':
      return {
        status: 'completed',
        entitlementIds: ['COINS_100'],
      };
    case 'commerce.restore':
      return {
        restoredEntitlements: [],
      };
    case 'commerce.getEntitlements':
      return [];
    case 'ads.preload':
    case 'leaderboard.open':
    case 'storage.save':
      return undefined;
    case 'ads.showRewarded':
      return {
        status: 'completed',
        rewardGranted: true,
      };
    case 'ads.showInterstitial':
      return {
        status: 'shown',
      };
    case 'leaderboard.submitScore':
      return {
        submitted: true,
      };
    case 'storage.load':
      return null;
  }
}

function enabledCapabilities(target: 'android' | 'ios' | 'ait'): PlatformCapabilities {
  return {
    nativeIap: true,
    nativeAds: true,
    rewardedAds: true,
    interstitialAds: true,
    nativeLeaderboard: true,
    achievements: false,
    cloudSave: false,
    socialShare: target === 'ait',
    haptics: true,
    localizedContent: true,
  };
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${message}. Expected ${expectedJson}, got ${actualJson}.`);
  }
}

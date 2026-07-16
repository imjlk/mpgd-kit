import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { AdPlacements } from '@mpgd/catalog';
import type { PlatformCapabilities, PlatformGateway } from '@mpgd/platform';

import { createAitPlatformGateway } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import { createCapacitorPlatformGateway } from '../../adapters/capacitor/src/index';
import { createDevvitPlatformGateway } from '../../adapters/devvit/src/index';
import { createVerse8PlatformGateway } from '../../adapters/verse8/src/index';
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
const adPlacements = readJsonFile('packages/catalog/placements.json') as AdPlacements;
const targetAdPlacements = adPlacements.placements.map((placement) => ({
  id: placement.id,
  type: placement.type,
}));
const adPlacementTypes = new Map<string, 'rewarded' | 'interstitial'>(
  targetAdPlacements.map((placement) => [placement.id, placement.type]),
);
type AdapterBridgeTarget = 'android' | 'ios' | 'ait' | 'reddit';
type CapacitorBridgeTarget = Extract<AdapterBridgeTarget, 'android' | 'ios'>;
const enabledActionMethods = [
  'runtime.getCapabilities',
  'commerce.purchase',
  'ads.showRewarded',
  'leaderboard.submitScore',
] as const;

await verifyBrowserAdapter();
await verifyMicrosoftStoreAdapter();
await verifyVerse8Adapter();
await verifyCapacitorAdapter('android');
await verifyCapacitorAdapter('ios');
await verifyAitAdapter();
await verifyDevvitAdapter();

console.log(
  'Adapter effective target config smoke passed: browser, microsoft-store, verse8, android, ios, ait, reddit',
);

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

async function verifyMicrosoftStoreAdapter(): Promise<void> {
  const gateway = wrapGateway('microsoft-store', createBrowserPlatformGateway());
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'microsoft-store');

  assertEqual(effectiveConfig.target, 'microsoft-store', 'microsoft-store effective target');
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    false,
    'microsoft-store product should be disabled until Digital Goods API is wired',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    false,
    'microsoft-store rewarded placement should be disabled',
  );
  assertDeepEqual(
    await gateway.commerce.purchase({
      productId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'microsoft-store-parity-purchase',
    }),
    {
      status: 'cancelled',
      entitlementIds: [],
    },
    'microsoft-store purchase should be target-disabled',
  );
}

async function verifyVerse8Adapter(): Promise<void> {
  const gateway = wrapGateway(
    'verse8',
    createVerse8PlatformGateway({
      authClient: {
        getUser() {
          return {
            account: '0x1234567890abcdef',
            verse: 'production',
            exp: 4_000_000_000,
          };
        },
      },
      resolveAdPlacementId(placementId) {
        return placementId === 'CONTINUE_AFTER_FAIL'
          ? 'rewarded_continue'
          : 'stage_end_interstitial';
      },
    }),
  );
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'verse8');

  assertEqual(effectiveConfig.target, 'verse8', 'verse8 effective target');
  assertEqual(runtime.config.runtime, 'verse8-web', 'verse8 runtime kind');
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    true,
    'verse8 products should be enabled in the target catalog',
  );
  assertEqual(
    (await gateway.getCapabilities()).nativeIap,
    false,
    'verse8 IAP capability should remain unavailable until VXShop is configured',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    true,
    'verse8 rewarded placements should be enabled after ads integration',
  );
  assertDeepEqual(
    await gateway.identity.getSession?.(),
    {
      identityLevel: 'authenticated',
      playerId: '0x1234567890abcdef',
      trustLevel: 'server-verified',
    },
    'verse8 should preserve the verified identity session',
  );
}

async function verifyCapacitorAdapter(target: CapacitorBridgeTarget): Promise<void> {
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
    enabledActionMethods,
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
    enabledActionMethods,
    'ait adapter should delegate enabled actions',
  );
}

async function verifyDevvitAdapter(): Promise<void> {
  const bridge = createRecordingBridge('reddit');
  const gateway = wrapGateway(
    'reddit',
    createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'build-reddit',
      bridge,
    }),
  );
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'reddit');

  assertEqual(effectiveConfig.target, 'reddit', 'reddit effective target');
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    false,
    'reddit product should be disabled',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    false,
    'reddit rewarded placement should be disabled',
  );
  assertEqual(
    effectiveConfig.leaderboard.enabled,
    false,
    'reddit platform leaderboard should be disabled',
  );
  assertEqual(
    runtime.capabilities.nativeLeaderboard,
    false,
    'reddit should not advertise a native leaderboard',
  );

  assertDeepEqual(
    await gateway.leaderboard.submitScore({
      leaderboardId: 'default',
      score: 1,
      runId: 'reddit-parity-run',
      submittedAt: new Date().toISOString(),
    }),
    {
      submitted: false,
    },
    'reddit should reject generic platform leaderboard submissions',
  );

  assertDeepEqual(
    bridge.methods.slice(1),
    [],
    'reddit adapter should not delegate disabled leaderboard actions',
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

function createRecordingBridge(target: AdapterBridgeTarget) {
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

function responseDataForMethod(
  target: AdapterBridgeTarget,
  method: BridgeMethod,
): unknown {
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
      return undefined;
    case 'storage.save':
      return target === 'reddit' ? {} : undefined;
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

function enabledCapabilities(target: AdapterBridgeTarget): PlatformCapabilities {
  return {
    nativeIap: target !== 'reddit',
    nativeAds: target !== 'reddit',
    rewardedAds: target !== 'reddit',
    interstitialAds: target !== 'reddit',
    nativeLeaderboard: target !== 'reddit',
    achievements: false,
    cloudSave: target === 'reddit',
    socialShare: target === 'ait' || target === 'reddit',
    haptics: target !== 'reddit',
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

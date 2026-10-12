import type { BridgeMethod, BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import {
  createUnsupportedCommerceCapabilities,
  type CommerceCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
} from '@mpgd/platform';
import type { CommerceProvider } from '@mpgd/platform/commerce';

import { createAitPlatformGateway } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import {
  createMicrosoftStoreCommerceProvider,
  microsoftStoreDigitalGoodsEvidenceSchema,
  withMicrosoftStoreCommerceProvider,
} from '../../adapters/browser/src/microsoft-store';
import {
  createCapacitorPlatformGateway,
  createCommerceServiceProvider,
} from '../../adapters/capacitor/src/index';
import { createDevvitPlatformGateway } from '../../adapters/devvit/src/index';
import { createVerse8PlatformGateway } from '../../adapters/verse8/src/index';
import {
  createEffectiveTargetConfig,
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
  type EffectiveTargetConfig,
  type EffectiveTargetConfigMatrix,
} from '../../packages/target-config/src/effective';
import {
  getTargetConfig,
  withTargetAvailability,
  type AdPlacementType,
  type TargetConfigMatrix,
} from '../../packages/target-config/src/runtime';
import { readJsonFile } from '../io';
import { loadEffectiveTargetConfigMatrix } from '../target/effective-config';

const targetConfigMatrix = readJsonFile(
  'packages/target-config/targets.json',
) as TargetConfigMatrix;
const effectiveConfigMatrix =
  loadEffectiveTargetConfigMatrix() as EffectiveTargetConfigMatrix;
const productCatalog = readJsonFile('packages/catalog/catalog.json') as ProductCatalog;
const adPlacements = readJsonFile('packages/catalog/placements.json') as AdPlacements;
const targetAdPlacements = adPlacements.placements.map((placement) => ({
  id: placement.id,
  type: placement.type,
}));
const adPlacementTypes = new Map<string, AdPlacementType>(
  targetAdPlacements.map((placement) => [placement.id, placement.type]),
);
type AdapterBridgeTarget = 'android' | 'ios' | 'ait' | 'reddit';
type CapacitorBridgeTarget = Extract<AdapterBridgeTarget, 'android' | 'ios'>;
// Capacitor serves the commerce provider in process, so its purchase never
// reaches the native bridge; Apps in Toss sends every commerce.v2 method there.
const capacitorEnabledActionMethods = [
  'runtime.getCapabilities',
  'ads.showRewarded',
  'runtime.getCapabilities',
  'leaderboard.submitScore',
] as const;
const aitEnabledActionMethods = [
  'runtime.getCapabilities',
  'commerce.v2.requestPurchase',
  'ads.showRewarded',
  'runtime.getCapabilities',
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
  assertEqual(
    gateway.commerce,
    undefined,
    'browser sells nothing, so the gateway has no commerce provider to purchase through',
  );
  assertDeepEqual(
    runtime.capabilities.commerce,
    createUnsupportedCommerceCapabilities(),
    'browser should report the unsupported commerce block',
  );
}

async function verifyMicrosoftStoreAdapter(): Promise<void> {
  const browser = createBrowserPlatformGateway();
  const storeBase: PlatformGateway = { ...browser, target: 'microsoft-store' };
  const microsoftStoreConfig = getTargetConfig(targetConfigMatrix, 'microsoft-store');
  const authoritativeEffectiveConfig = createEffectiveTargetConfig({
    target: 'microsoft-store',
    targetConfigVersion: targetConfigMatrix.version,
    config: microsoftStoreConfig,
    catalog: productCatalog,
    adPlacements,
    platformTarget: {
      kind: 'web',
      adapter: 'microsoft-store',
      authoritativeGameServices: true,
    },
  });
  const createCommerce = (authorityResult: 'completed' | 'failed') => {
    return createMicrosoftStoreCommerceProvider({
      getRecoveryScope: () => 'smoke-player',
      products: [
        {
          info: {
            id: 'COINS_100',
            type: 'consumable',
            title: '100 Coins',
            description: 'Adds 100 coins.',
            price: { formatted: '$0.99', currencyCode: 'USD' },
          },
          inAppOfferToken: 'coins_100',
        },
      ],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async claimRecoveryOwnership(input) {
          return {
            status: 'granted',
            idempotencyKey: input.idempotencyKey ?? 'microsoft-store-smoke',
          } as const;
        },
        async hasRecoveryOwnership(input) {
          return {
            status: 'granted',
            idempotencyKey: input.idempotencyKey ?? 'microsoft-store-smoke',
          } as const;
        },
        async verifyAndGrant() {
          return authorityResult === 'failed'
            ? { status: 'failed' as const }
            : {
                status: 'completed' as const,
                transactionId: 'microsoft-store-ledger',
              };
        },
      },
      async getDigitalGoodsService() {
        return {
          async getDetails() {
            return [
              {
                itemId: 'coins_100',
                title: '100 Coins',
                description: 'Adds 100 coins.',
                price: { value: '0.99', currency: 'USD' },
              },
            ];
          },
          async listPurchases() {
            return [{ itemId: 'coins_100', purchaseToken: 'coins_100' }];
          },
        };
      },
      createPaymentRequest() {
        return {
          async show() {
            return { details: { purchaseToken: 'coins_100' } };
          },
        };
      },
    });
  };
  const gateway = wrapGateway(
    'microsoft-store',
    withMicrosoftStoreCommerceProvider(storeBase, createCommerce('completed'), {
      remoteLeaderboard: true,
    }),
    authoritativeEffectiveConfig,
  );
  const runtime = await gateway.getTargetRuntime();
  const effectiveConfig = requireEffectiveConfig(runtime.effectiveConfig, 'microsoft-store');

  assertEqual(effectiveConfig.target, 'microsoft-store', 'microsoft-store effective target');
  assertEqual(
    runtime.capabilities.nativeLeaderboard,
    false,
    'microsoft-store should not advertise a native leaderboard',
  );
  assertEqual(
    runtime.capabilities.remoteLeaderboard,
    true,
    'microsoft-store should advertise its Game Services leaderboard',
  );
  assertEqual(
    runtime.features.leaderboard.reason,
    'available',
    'microsoft-store remote leaderboard should remain discoverable',
  );
  assertEqual(
    getEffectiveProductConfig(effectiveConfig, 'COINS_100')?.enabled,
    true,
    'microsoft-store consumable should be enabled when Digital Goods is wired',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    false,
    'microsoft-store rewarded placement should be disabled',
  );
  await gateway.commerce?.fetchProducts({ type: 'all' });
  const settled = await gateway.commerce?.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'microsoft-store-parity-purchase',
  });
  assertEqual(
    settled?.outcome,
    'purchased',
    'microsoft-store purchase should report the authority-settled checkout',
  );
  if (settled?.outcome === 'purchased') {
    // The provider only points at the authority's ledger entry; the
    // reconciler still verifies it through the backend before any grant.
    assertDeepEqual(
      settled.purchase.evidence,
      {
        schema: microsoftStoreDigitalGoodsEvidenceSchema,
        payload: { itemId: 'coins_100', purchaseToken: 'coins_100' },
      },
      'microsoft-store purchase should carry the Digital Goods evidence',
    );
    assertEqual(
      settled.purchase.settlement?.ledgerEntryId,
      'microsoft-store-ledger',
      'microsoft-store purchase should point at the authority ledger entry',
    );
  }
  const rejectedGateway = wrapGateway(
    'microsoft-store',
    withMicrosoftStoreCommerceProvider(storeBase, createCommerce('failed'), {
      remoteLeaderboard: true,
    }),
    authoritativeEffectiveConfig,
  );
  // Microsoft currently returns the add-on product ID as purchaseToken, so both independent
  // authority scenarios intentionally exercise the same token without treating it as a
  // transaction identity.
  await rejectedGateway.commerce?.fetchProducts({ type: 'all' });
  const rejected = await rejectedGateway.commerce?.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'microsoft-store-rejected-purchase',
  });
  if (rejected?.outcome === 'purchased' && rejected.purchase.settlement !== undefined) {
    throw new Error('microsoft-store purchase must fail closed when authority does not grant.');
  }
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
    gateway.commerce,
    undefined,
    'verse8 has no commerce provider until VXShop is configured',
  );
  assertDeepEqual(
    (await gateway.getCapabilities()).commerce,
    createUnsupportedCommerceCapabilities(),
    'verse8 commerce capability should remain unsupported until VXShop is configured',
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
  const store = createRecordingCommerceProvider(`${target}-store`);
  const gateway = wrapGateway(
    target,
    createCapacitorPlatformGateway({
      target,
      appVersion: '1.0.0',
      buildId: `build-${target}`,
      bridge,
      providers: [
        createCommerceServiceProvider({ id: 'store', commerce: store.provider }),
        {
          id: 'rewarded',
          bridge,
          features: ['rewardedAds'],
          methods: ['ads.preload', 'ads.showRewarded'],
          async getAvailability() {
            return { rewardedAds: 'available' };
          },
        },
        {
          id: 'game-platform',
          bridge,
          features: ['nativeLeaderboard'],
          methods: ['leaderboard.submitScore', 'leaderboard.open'],
          async getAvailability() {
            return { nativeLeaderboard: 'available' };
          },
        },
      ],
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

  await gateway.commerce?.requestPurchase({
    logicalId: 'COINS_100',
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
    capacitorEnabledActionMethods,
    `${target} adapter should delegate enabled actions`,
  );
  assertDeepEqual(
    store.calls,
    ['requestPurchase'],
    `${target} enabled purchase should reach the commerce provider`,
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
    false,
    'ait product should be disabled without authoritative game services',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(effectiveConfig, 'CONTINUE_AFTER_FAIL')?.enabled,
    false,
    'ait rewarded placement should be disabled without authoritative game services',
  );

  assertDeepEqual(
    await gateway.commerce?.requestPurchase({
      logicalId: 'COINS_100',
      source: 'shop',
      idempotencyKey: 'ait-disabled-purchase',
    }),
    {
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', retryable: false },
    },
    'ait purchase should fail closed without authoritative game services',
  );
  assertDeepEqual(
    await gateway.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'ait-disabled-reward',
    }),
    {
      status: 'unavailable',
      rewardGranted: false,
    },
    'ait reward should fail closed without authoritative game services',
  );
  assertDeepEqual(
    await gateway.leaderboard.submitScore({
      leaderboardId: 'default',
      score: 1,
      runId: 'ait-native-leaderboard-run',
      submittedAt: new Date().toISOString(),
    }),
    { submitted: true },
    'ait leaderboard submission should succeed with native delegation',
  );

  assertDeepEqual(
    bridge.methods.slice(1),
    ['runtime.getCapabilities', 'leaderboard.submitScore'],
    'ait adapter should preserve native leaderboard while filtering grants',
  );

  const authoritativeBridge = createRecordingBridge('ait');
  const aitConfig = getTargetConfig(targetConfigMatrix, 'ait');
  const authoritativeEffectiveConfig = createEffectiveTargetConfig({
    target: 'ait',
    targetConfigVersion: targetConfigMatrix.version,
    config: aitConfig,
    catalog: productCatalog,
    adPlacements,
    platformTarget: {
      kind: 'apps-in-toss',
      adapter: 'ait',
      authoritativeGameServices: true,
    },
  });
  const authoritativeGateway = wrapGateway(
    'ait',
    createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'build-ait-authoritative',
      bridge: authoritativeBridge,
    }),
    authoritativeEffectiveConfig,
  );
  const authoritativeRuntime = await authoritativeGateway.getTargetRuntime();
  const authoritativeConfig = requireEffectiveConfig(
    authoritativeRuntime.effectiveConfig,
    'ait-authoritative',
  );

  assertEqual(
    getEffectiveProductConfig(authoritativeConfig, 'COINS_100')?.enabled,
    true,
    'authoritative ait product should be enabled',
  );
  assertEqual(
    getEffectiveAdPlacementConfig(
      authoritativeConfig,
      'CONTINUE_AFTER_FAIL',
    )?.enabled,
    true,
    'authoritative ait rewarded placement should be enabled',
  );

  await authoritativeGateway.commerce?.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'ait-authoritative-purchase',
  });
  await authoritativeGateway.ads.showRewarded({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'ait-authoritative-reward',
  });
  await authoritativeGateway.leaderboard.submitScore({
    leaderboardId: 'default',
    score: 1,
    runId: 'ait-authoritative-run',
    submittedAt: new Date().toISOString(),
  });

  assertDeepEqual(
    authoritativeBridge.methods.slice(1),
    aitEnabledActionMethods,
    'authoritative ait adapter should delegate enabled actions',
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
  assertEqual(
    runtime.capabilities.remoteLeaderboard,
    false,
    'reddit should not advertise a remote leaderboard',
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

function wrapGateway(
  configTarget: string,
  gateway: PlatformGateway,
  effectiveConfigOverride?: EffectiveTargetConfig,
) {
  const config = getTargetConfig(targetConfigMatrix, configTarget);
  const effectiveConfig =
    effectiveConfigOverride ?? effectiveConfigMatrix.targets[configTarget];

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

/** A one-time store that is ready to sell: the block a real provider reports. */
function sellingCommerce(): CommerceCapabilities {
  return {
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
  };
}

/** A provider that records the calls reaching it and never grants. */
function createRecordingCommerceProvider(store: string): {
  readonly provider: CommerceProvider;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      store,
      async getCapabilities() {
        return sellingCommerce();
      },
      async fetchProducts() {
        return [];
      },
      async requestPurchase() {
        calls.push('requestPurchase');
        return { outcome: 'launched' };
      },
      async getAvailablePurchases() {
        return [];
      },
      subscribe() {
        return () => {};
      },
    },
  };
}

function createRecordingBridge(target: AdapterBridgeTarget) {
  const methods: BridgeMethod[] = [];

  return {
    methods,
    // Apps in Toss offers its commerce provider when the host bridge has the
    // commerce event channel; the other targets get theirs from a registered
    // provider (Capacitor) or none (Devvit).
    ...(target === 'ait' ? { commerceV2: { subscribe: () => () => {} } } : {}),
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
    case 'commerce.v2.requestPurchase':
      // The store UI opened; nothing is granted from a provider answer.
      return { outcome: 'launched' };
    case 'ads.preload':
    case 'leaderboard.open':
      return undefined;
    case 'storage.save':
      return target === 'reddit' ? {} : undefined;
    case 'ads.showRewarded':
      return {
        status: 'completed',
        rewardGranted: true,
        ledgerEntryId: 'smoke-reward-ledger',
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
    commerce: target === 'reddit' ? createUnsupportedCommerceCapabilities() : sellingCommerce(),
    nativeAds: target !== 'reddit',
    rewardedAds: target !== 'reddit',
    interstitialAds: target !== 'reddit',
    nativeLeaderboard: target !== 'reddit',
    remoteLeaderboard: false,
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

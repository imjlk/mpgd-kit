import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PlatformPurchasePresentationEvent,
} from '@mpgd/platform';

import { createBrowserPlatformGateway } from '../../../adapters/browser/src/index';
import { createEffectiveTargetConfig } from '../src/effective';
import {
  createCommerceBlock,
  createRecordingCommerceProvider,
  createStoreProduct,
} from './commerce-fixtures';
import {
  applyTargetConfigToCapabilities,
  applyTargetConfigToCommerceCapabilities,
  createTargetRuntimeSnapshot,
  getFeatureAvailability,
  getTargetConfig,
  normalizeTargetIntegrationConfig,
  withTargetAvailability,
  type TargetConfigMatrix,
} from '../src/runtime';

const matrix = JSON.parse(
  readFileSync('packages/target-config/targets.json', 'utf8'),
) as TargetConfigMatrix;
const android = getTargetConfig(matrix, 'android');
const config = {
  ...android,
  features: {
    ...android.features,
    subscriptions: true,
    nativeLeaderboard: true,
    remoteLeaderboard: false,
  },
  integrations: {
    ...normalizeTargetIntegrationConfig(android.integrations),
    identityUpgrade: 'available',
    notifications: 'available',
  },
} as const;
// One-time products wait for configuration; the provider sells no subscriptions.
const capabilities = {
  ...createUnsupportedCapabilities(),
  commerce: createCommerceBlock({ oneTime: true, availability: 'configuration-required' }),
  providerAvailability: {
    nativeLeaderboard: 'action-required',
    identityUpgrade: 'action-required',
    pushNotifications: 'temporarily-unavailable',
  },
} as const;

assert.equal(getFeatureAvailability('iap', config, capabilities).reason, 'configuration-required');
assert.equal(
  getFeatureAvailability('subscriptions', config, capabilities).reason,
  'capability-unsupported',
);
// The commerce block alone decides the reason of `iap` and `subscriptions`.
for (const availability of [
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
] as const) {
  const oneTimeAvailability = getFeatureAvailability('iap', config, {
    ...createUnsupportedCapabilities(),
    commerce: createCommerceBlock({ oneTime: true, availability }),
  });
  assert.equal(oneTimeAvailability.reason, availability);
  assert.equal(oneTimeAvailability.enabled, false);
  assert.equal(oneTimeAvailability.capabilitySupported, true);
  assert.equal(
    getFeatureAvailability('subscriptions', config, {
      ...createUnsupportedCapabilities(),
      commerce: createCommerceBlock({ oneTime: false, subscription: true, availability }),
    }).reason,
    availability,
  );
}
const sellingCapabilities = {
  ...createUnsupportedCapabilities(),
  commerce: createCommerceBlock({ oneTime: true, subscription: true }),
};
assert.equal(getFeatureAvailability('iap', config, sellingCapabilities).reason, 'available');
assert.equal(getFeatureAvailability('iap', config, sellingCapabilities).enabled, true);
assert.equal(
  getFeatureAvailability('subscriptions', config, sellingCapabilities).reason,
  'available',
);
// A block that declares no one-time kind, or no availability at all, is unsupported.
assert.equal(
  getFeatureAvailability('iap', config, {
    ...createUnsupportedCapabilities(),
    commerce: createCommerceBlock({ oneTime: false, subscription: true }),
  }).reason,
  'capability-unsupported',
);
assert.equal(
  getFeatureAvailability('iap', config, createUnsupportedCapabilities()).reason,
  'capability-unsupported',
);
assert.equal(
  getFeatureAvailability('iap', config, {
    ...createUnsupportedCapabilities(),
    commerce: createCommerceBlock({ oneTime: true, availability: 'unsupported' }),
  }).reason,
  'capability-unsupported',
);
// The target configuration still wins over any provider state.
assert.equal(
  getFeatureAvailability('iap', { ...config, features: { ...config.features, iap: false } }, sellingCapabilities).reason,
  'target-disabled',
);
assert.equal(
  getFeatureAvailability('subscriptions', { ...config, features: { ...config.features, subscriptions: false } }, sellingCapabilities).reason,
  'target-disabled',
);
assert.equal(
  getFeatureAvailability('nativeLeaderboard', config, capabilities).reason,
  'action-required',
);
assert.equal(
  getFeatureAvailability('remoteLeaderboard', config, capabilities).reason,
  'target-disabled',
);
assert.equal(getFeatureAvailability('leaderboard', config, capabilities).reason, 'action-required');
const remoteOnlyCapabilities = {
  ...createUnsupportedCapabilities(),
  remoteLeaderboard: true,
  providerAvailability: { nativeLeaderboard: 'unsupported' },
} as const;
assert.equal(
  getFeatureAvailability('remoteLeaderboard', android, remoteOnlyCapabilities).reason,
  'available',
);
assert.equal(
  getFeatureAvailability('leaderboard', android, remoteOnlyCapabilities).reason,
  'available',
);
const selectedRoutes: Array<'native' | 'remote' | undefined> = [];
const remoteGateway: PlatformGateway = {
  ...createBrowserPlatformGateway(),
  target: 'android',
  async getCapabilities() {
    return remoteOnlyCapabilities;
  },
  leaderboard: {
    async submitScore(input) {
      selectedRoutes.push(input.route);
      return { submitted: true };
    },
    async open(input) {
      selectedRoutes.push(input?.route);
    },
  },
};
const remoteConfigured = withTargetAvailability(remoteGateway, android);
const remoteSubmission = await remoteConfigured.leaderboard.submitScore({
  leaderboardId: 'daily',
  score: 10,
  runId: 'run-1',
  submittedAt: '2026-09-24T00:00:00Z',
});
assert.equal(remoteSubmission.submitted, true);
await remoteConfigured.leaderboard.open({ leaderboardId: 'daily' });
assert.deepEqual(selectedRoutes, ['remote', 'remote']);

const preloadFormats: Array<'rewarded' | 'interstitial' | 'banner' | undefined> = [];
const adGateway: PlatformGateway = {
  ...createBrowserPlatformGateway(),
  target: 'android',
  ads: {
    async preload(input) {
      preloadFormats.push(input.format);
    },
    async showRewarded() {
      return { status: 'unavailable', rewardGranted: false };
    },
  },
};
const configuredAds = withTargetAvailability(adGateway, android, {
  resolveAdPlacementType: () => 'interstitial',
});
await configuredAds.ads.preload({ placementId: 'STAGE_END_INTERSTITIAL' });
assert.deepEqual(preloadFormats, ['interstitial']);
await configuredAds.ads.preload({
  placementId: 'STAGE_END_INTERSTITIAL',
  format: 'rewarded',
});
assert.deepEqual(preloadFormats, ['interstitial']);
const rewardOnlyConfig = {
  ...android,
  features: { ...android.features, interstitialAds: false },
};
const explicitAds = withTargetAvailability(adGateway, rewardOnlyConfig);
await explicitAds.ads.preload({
  placementId: 'STAGE_END_INTERSTITIAL',
  format: 'interstitial',
});
await explicitAds.ads.preload({ placementId: 'BANNER_HOME', format: 'banner' });
assert.deepEqual(preloadFormats, ['interstitial']);
await explicitAds.ads.preload({
  placementId: 'CONTINUE_AFTER_FAIL',
  format: 'rewarded',
});
assert.deepEqual(preloadFormats, ['interstitial', 'rewarded']);

const gateway = {
  identity: {
    requestUpgrade: async () => ({ status: 'unavailable', reloadExpected: false }),
  },
  notifications: {
    getStatus: async () => 'configuration-required',
    requestSubscription: async () => 'unavailable',
  },
} as unknown as PlatformGateway;
const snapshot = createTargetRuntimeSnapshot({
  target: 'android',
  config,
  capabilities,
  gateway,
});
assert.equal(snapshot.integrations.identityUpgrade.state, 'action-required');
assert.equal(snapshot.integrations.notifications.state, 'temporarily-unavailable');
const actionableConfig = {
  ...config,
  integrations: {
    ...config.integrations,
    identityUpgrade: 'action-required',
    notifications: 'action-required',
  },
} as const;
const actionableGateway: PlatformGateway = {
  ...createBrowserPlatformGateway(),
  target: 'android',
  getCapabilities: async () => ({
    ...createUnsupportedCapabilities(),
    providerAvailability: {
      identityUpgrade: 'action-required',
      pushNotifications: 'action-required',
    },
  }),
  identity: {
    getPlayer: async () => null,
    requestUpgrade: async () => ({ status: 'completed', reloadExpected: false }),
  },
  notifications: {
    getStatus: async () => 'not-subscribed',
    requestSubscription: async () => 'subscribed',
  },
};
const actionableConfigured = withTargetAvailability(actionableGateway, actionableConfig);
const actionableRuntime = await actionableConfigured.getTargetRuntime();
assert.equal(actionableRuntime.integrations.identityUpgrade.state, 'action-required');
const upgradeResult = await actionableConfigured.identity.requestUpgrade?.({ reason: 'save' });
assert.equal(upgradeResult?.status, 'completed');
const subscriptionResult = await actionableConfigured.notifications?.requestSubscription(
  'daily-ready',
);
assert.equal(subscriptionResult, 'subscribed');
assert.equal(createTargetRuntimeSnapshot({
  target: 'android',
  config: {
    ...config,
    integrations: { ...config.integrations, notifications: 'disabled' },
  },
  capabilities: {
    ...capabilities,
    providerAvailability: { ...capabilities.providerAvailability, pushNotifications: 'unsupported' },
  },
  gateway,
}).integrations.notifications.state, 'disabled');

const sellingCommerce = createCommerceBlock({ oneTime: true, subscription: true });
const masked = applyTargetConfigToCapabilities(
  {
    ...capabilities,
    commerce: sellingCommerce,
    nativeLeaderboard: true,
  },
  {
    ...config,
    features: {
      ...config.features,
      subscriptions: false,
      nativeLeaderboard: false,
    },
  },
);
assert.equal(masked.commerce.purchase.consumable, true);
assert.equal(masked.commerce.purchase.durable, true);
assert.equal(masked.commerce.purchase.subscription, false);
assert.equal(masked.commerce.availability, 'available');
assert.equal(masked.nativeLeaderboard, false);
// The commerce block is the only source: the removed boolean flags never reappear.
assert.equal('nativeIap' in masked, false);
assert.equal('subscriptionIap' in masked, false);
assert.deepEqual(sellingCommerce, createCommerceBlock({ oneTime: true, subscription: true }));

// Masking the block: one-time products follow `iap`, subscriptions follow `iap` and `subscriptions`.
const enabledConfig = {
  ...config,
  features: { ...config.features, iap: true, subscriptions: true },
};
const fullMask = applyTargetConfigToCommerceCapabilities(sellingCommerce, enabledConfig);
assert.deepEqual(fullMask, sellingCommerce);
assert.notEqual(fullMask, sellingCommerce, 'every read is a fresh object');
assert.notEqual(fullMask.purchase, sellingCommerce.purchase);
assert.notEqual(fullMask.lifecycle, sellingCommerce.lifecycle);
assert.notEqual(fullMask.authority, sellingCommerce.authority);
const subscriptionsOff = applyTargetConfigToCommerceCapabilities(sellingCommerce, {
  ...enabledConfig,
  features: { ...enabledConfig.features, subscriptions: false },
});
assert.equal(subscriptionsOff.purchase.consumable, true);
assert.equal(subscriptionsOff.purchase.subscription, false);
assert.equal(subscriptionsOff.availability, 'available');
// A provider that sells only subscriptions, on a target that allows only one-time products, sells
// nothing: no catalog and no availability, matching the empty masked catalog.
const subscriptionOnlyOnOneTimeTarget = applyTargetConfigToCommerceCapabilities(
  createCommerceBlock({ oneTime: false, subscription: true }),
  { ...enabledConfig, features: { ...enabledConfig.features, iap: true, subscriptions: false } },
);
assert.equal(subscriptionOnlyOnOneTimeTarget.purchase.subscription, false);
assert.equal(subscriptionOnlyOnOneTimeTarget.catalog.products, false);
assert.equal(subscriptionOnlyOnOneTimeTarget.availability, 'unsupported');
// A block that declares no kind keeps the provider's own state when the target sells something.
assert.equal(
  applyTargetConfigToCommerceCapabilities(
    createCommerceBlock({ oneTime: false, subscription: false, availability: 'temporarily-unavailable' }),
    enabledConfig,
  ).availability,
  'temporarily-unavailable',
);
const iapOff = applyTargetConfigToCommerceCapabilities(sellingCommerce, {
  ...enabledConfig,
  features: { ...enabledConfig.features, iap: false },
});
assert.equal(iapOff.purchase.consumable, false);
assert.equal(iapOff.purchase.durable, false);
assert.equal(iapOff.purchase.subscription, false, 'subscriptions need one-time products enabled');
assert.equal(iapOff.catalog.products, false);
assert.equal(iapOff.availability, 'unsupported', 'a target that sells nothing reports unsupported');
assert.deepEqual(iapOff.lifecycle, sellingCommerce.lifecycle, 'recovery facts are not masked');
assert.deepEqual(iapOff.authority, sellingCommerce.authority);
const oneTimeOnly = applyTargetConfigToCommerceCapabilities(
  createCommerceBlock({ oneTime: true, subscription: false }),
  enabledConfig,
);
assert.equal(
  oneTimeOnly.purchase.subscription,
  false,
  'the target never adds what the provider lacks',
);
assert.equal(
  applyTargetConfigToCommerceCapabilities(
    createCommerceBlock({ oneTime: true, availability: 'configuration-required' }),
    enabledConfig,
  ).availability,
  'configuration-required',
  'a provider state other than available passes through while the target sells',
);

const catalog = JSON.parse(readFileSync('packages/catalog/catalog.json', 'utf8')) as ProductCatalog;
const product = catalog.products[0];
assert.ok(product);
const adPlacements = JSON.parse(
  readFileSync('packages/catalog/placements.json', 'utf8'),
) as AdPlacements;
const effective = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: matrix.version,
  config: {
    ...config,
    features: { ...config.features, subscriptions: false },
  },
  catalog: {
    ...catalog,
    products: [{ ...product, type: 'subscription' }],
  },
  adPlacements,
});
assert.equal(effective.monetization.subscriptions, false);
assert.equal(effective.monetization.products[0]?.reason, 'target-disabled');
const disabledIapEffective = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: matrix.version,
  config: { ...config, features: { ...config.features, iap: false } },
  catalog: { ...catalog, products: [{ ...product, type: 'subscription' }] },
  adPlacements,
});
assert.equal(disabledIapEffective.monetization.subscriptions, false);
assert.equal(disabledIapEffective.monetization.products[0]?.reason, 'target-disabled');

const subscriptionProduct = createStoreProduct(product.id, 'subscription');
const subscriptionCommerce = createRecordingCommerceProvider({
  capabilities: createCommerceBlock({ oneTime: false, subscription: true }),
  products: [subscriptionProduct],
});
const subscriptionPurchaseCalls = (): number => subscriptionCommerce.calls.filter((name) =>
  name.startsWith('requestPurchase:'),
).length;
const browser = createBrowserPlatformGateway();
const subscriptionGateway: PlatformGateway = {
  ...browser,
  target: 'android',
  getCapabilities: async () => ({
    ...createUnsupportedCapabilities(),
    commerce: createCommerceBlock({ oneTime: false, subscription: true }),
  }),
  commerce: subscriptionCommerce,
};
const enabledEffective = createEffectiveTargetConfig({
  target: 'android',
  targetConfigVersion: matrix.version,
  config,
  catalog: { ...catalog, products: [{ ...product, type: 'subscription' }] },
  adPlacements,
});
const enabledGateway = withTargetAvailability(subscriptionGateway, config, {
  effectiveConfig: enabledEffective,
});
const enabledCommerce = requireCommerce(enabledGateway);
assert.equal((await enabledGateway.getCapabilities()).commerce.purchase.subscription, true);
assert.equal((await enabledCommerce.getCapabilities()).purchase.subscription, true);
assert.deepEqual(await enabledCommerce.fetchProducts({}), [subscriptionProduct]);
assert.equal((await enabledCommerce.requestPurchase({
  logicalId: product.id,
  source: 'shop',
  idempotencyKey: 'subscription-test',
})).outcome, 'launched');
assert.equal(subscriptionPurchaseCalls(), 1);
assert.deepEqual(await enabledCommerce.requestPurchase({
  logicalId: 'UNKNOWN_SUBSCRIPTION',
  source: 'shop',
  idempotencyKey: 'unknown-subscription-test',
}), { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
assert.equal(
  subscriptionPurchaseCalls(),
  1,
  'a product outside the catalog never reaches the store',
);

const withoutEffectiveConfig = withTargetAvailability(subscriptionGateway, config);
const withoutEffectiveCommerce = requireCommerce(withoutEffectiveConfig);
assert.deepEqual(await withoutEffectiveCommerce.fetchProducts({}), [subscriptionProduct]);
assert.equal((await withoutEffectiveCommerce.requestPurchase({
  logicalId: product.id,
  source: 'shop',
  idempotencyKey: 'subscription-without-effective-config',
})).outcome, 'launched');
assert.equal(subscriptionPurchaseCalls(), 2);

const disabledGateway = withTargetAvailability(subscriptionGateway, config, {
  effectiveConfig: effective,
});
const disabledCommerce = requireCommerce(disabledGateway);
assert.equal((await disabledGateway.getCapabilities()).commerce.purchase.subscription, false);
assert.equal((await disabledCommerce.getCapabilities()).purchase.subscription, false);
assert.deepEqual(await disabledCommerce.fetchProducts({}), []);
assert.deepEqual(await disabledCommerce.requestPurchase({
  logicalId: product.id,
  source: 'shop',
  idempotencyKey: 'disabled-subscription-test',
}), { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
assert.equal(subscriptionPurchaseCalls(), 2, 'a disabled purchase never reaches the provider');

let oneTimeProductKind: 'subscription' | 'consumable' = 'subscription';
const oneTimeCommerce = createRecordingCommerceProvider({
  capabilities: createCommerceBlock({ oneTime: true, subscription: true }),
});
const oneTimeProvider = {
  ...oneTimeCommerce,
  async fetchProducts() {
    oneTimeCommerce.calls.push('fetchProducts');
    return [createStoreProduct(product.id, oneTimeProductKind)];
  },
};
const oneTimeGateway: PlatformGateway = {
  ...subscriptionGateway,
  getCapabilities: async () => ({
    ...createUnsupportedCapabilities(),
    commerce: createCommerceBlock({ oneTime: true, subscription: true }),
  }),
  commerce: oneTimeProvider,
};
const oneTimeConfigured = withTargetAvailability(oneTimeGateway, android);
const oneTimeMasked = requireCommerce(oneTimeConfigured);
const oneTimePurchases = (): number => oneTimeCommerce.calls.filter((name) =>
  name.startsWith('requestPurchase:'),
).length;
assert.deepEqual(
  await oneTimeMasked.fetchProducts({}),
  [],
  'the target does not sell subscriptions',
);
assert.deepEqual(await oneTimeMasked.requestPurchase({
  logicalId: product.id, source: 'shop', idempotencyKey: 'subscription-bypass',
}), { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
assert.equal(oneTimePurchases(), 0);
oneTimeProductKind = 'consumable';
assert.equal((await oneTimeMasked.requestPurchase({
  logicalId: product.id, source: 'shop', idempotencyKey: 'one-time-allowed',
})).outcome, 'launched');
assert.equal(oneTimePurchases(), 1);
assert.deepEqual(await oneTimeMasked.requestPurchase({
  logicalId: 'UNKNOWN_PRODUCT', source: 'shop', idempotencyKey: 'unknown-product',
}), { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
assert.equal(oneTimePurchases(), 1);

// The masked provider: catalog reads filter by kind; new purchases and a store resync obey the
// target; recovery reads always pass through; a gateway without a provider stays without one.
const mixedCatalog = [
  createStoreProduct('COINS_100', 'consumable'),
  createStoreProduct('REMOVE_ADS', 'durable'),
  createStoreProduct('VIP_PASS', 'subscription'),
];
const recoverableTransaction = {
  store: 'fixture-store',
  transactionId: 'recoverable-1',
  storeSku: 'coins_100',
  logicalId: 'COINS_100',
  quantity: 1,
  state: 'purchased',
  token: 'recoverable-token',
  evidence: { schema: 'fixture.purchase.v1', payload: { token: 'recoverable-token' } },
} as const;
function createMixedGateway(overrides: {
  readonly commerce?: ReturnType<typeof createRecordingCommerceProvider>;
} = {}) {
  const commerce = overrides.commerce ?? createRecordingCommerceProvider({
    capabilities: createCommerceBlock({ oneTime: true, subscription: true }),
    products: mixedCatalog,
    available: [recoverableTransaction],
    withRestore: true,
    purchaseResult: { outcome: 'launched' },
  });
  const gateway: PlatformGateway = {
    ...createBrowserPlatformGateway(),
    target: 'android',
    getCapabilities: async () => ({
      ...createUnsupportedCapabilities(),
      commerce: await commerce.getCapabilities(),
    }),
    commerce,
  };
  return { commerce, gateway };
}
const sellsAll = { ...android, features: { ...android.features, iap: true, subscriptions: true } };
const sellsOneTimeOnly = {
  ...android,
  features: { ...android.features, iap: true, subscriptions: false },
};
const sellsNothing = {
  ...android,
  features: { ...android.features, iap: false, subscriptions: false },
};
const kindsOf = (products: readonly { readonly kind: string }[]): string[] => products.map(
  (entry) => entry.kind,
);

for (const [readiness, code] of [
  ['temporarily-unavailable', 'STORE_UNAVAILABLE'],
  ['configuration-required', 'CONFIGURATION_REQUIRED'],
  ['action-required', 'ACTION_REQUIRED'],
] as const) {
  const capabilities = createCommerceBlock({ oneTime: true, availability: readiness });
  const provider = createRecordingCommerceProvider({
    capabilities,
    products: [createStoreProduct('single-route', 'consumable')],
  });
  const gateway: PlatformGateway = {
    ...createBrowserPlatformGateway(),
    commerce: provider,
    getCapabilities: async () => ({ ...createUnsupportedCapabilities(), commerce: capabilities }),
  };
  const gated = requireCommerce(withTargetAvailability(gateway, sellsOneTimeOnly));
  const refusal = await gated.requestPurchase({
    logicalId: 'single-route',
    idempotencyKey: `single-${readiness}`,
    source: 'shop',
  });
  assert.equal(refusal.outcome, 'failed');
  if (refusal.outcome === 'failed') {
    assert.equal(refusal.error.code, code);
    assert.equal(refusal.error.retryable, readiness === 'temporarily-unavailable');
  }
  assert.equal(
    provider.calls.some((call) => call.startsWith('requestPurchase:')),
    false,
  );
}

{
  const all = createMixedGateway();
  assert.deepEqual(
    kindsOf(await requireCommerce(withTargetAvailability(all.gateway, sellsAll)).fetchProducts({})),
    ['consumable', 'durable', 'subscription'],
  );
  const oneTime = createMixedGateway();
  assert.deepEqual(
    kindsOf(
      await requireCommerce(withTargetAvailability(oneTime.gateway, sellsOneTimeOnly)).fetchProducts({}),
    ),
    ['consumable', 'durable'],
    'subscriptions are filtered out when the target does not sell them',
  );
  const none = createMixedGateway();
  const nothingSold = requireCommerce(withTargetAvailability(none.gateway, sellsNothing));
  assert.deepEqual(await nothingSold.fetchProducts({}), []);
  assert.equal(
    none.commerce.calls.includes('fetchProducts'),
    false,
    'a target that sells nothing does not read the catalog',
  );
  const maskedBlock = await nothingSold.getCapabilities();
  assert.equal(maskedBlock.availability, 'unsupported');
  assert.equal(maskedBlock.purchase.consumable, false);
  assert.equal(none.commerce.store, nothingSold.store);
}

// A purchase the target disallows answers `failed` / `ITEM_UNAVAILABLE` and never reaches the provider.
{
  const refused = createMixedGateway();
  const commerce = requireCommerce(withTargetAvailability(refused.gateway, sellsNothing));
  const outcome = await commerce.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'refused-purchase',
  });
  assert.deepEqual(outcome, {
    outcome: 'failed',
    error: { code: 'ITEM_UNAVAILABLE', retryable: false },
  });
  assert.equal(
    refused.commerce.calls.some((name) => name.startsWith('requestPurchase:')),
    false,
    'the provider never sees a purchase the target refuses',
  );
  const oneTimeOnlyGateway = createMixedGateway();
  const oneTimeOnlyCommerce = requireCommerce(
    withTargetAvailability(oneTimeOnlyGateway.gateway, sellsOneTimeOnly),
  );
  assert.equal((await oneTimeOnlyCommerce.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'allowed-one-time',
  })).outcome, 'launched');
  assert.deepEqual(await oneTimeOnlyCommerce.requestPurchase({
    logicalId: 'VIP_PASS',
    source: 'shop',
    idempotencyKey: 'refused-subscription',
  }), { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
  assert.deepEqual(
    oneTimeOnlyGateway.commerce.calls.filter((name) => name.startsWith('requestPurchase:')),
    ['requestPurchase:COINS_100'],
    'only the one-time purchase reached the provider',
  );
}

// A purchase the target allows but the provider cannot take yet answers the provider's own class of
// error (so a temporary outage stays retryable); the target config never hides behind readiness.
for (const [availability, expected] of [
  ['configuration-required', { code: 'CONFIGURATION_REQUIRED', retryable: false }],
  ['action-required', { code: 'ACTION_REQUIRED', retryable: false }],
  ['temporarily-unavailable', { code: 'STORE_UNAVAILABLE', retryable: true }],
  ['unsupported', { code: 'ITEM_UNAVAILABLE', retryable: false }],
] as const) {
  const notReady = createMixedGateway({
    commerce: createRecordingCommerceProvider({
      capabilities: createCommerceBlock({ oneTime: true, subscription: true, availability }),
      products: mixedCatalog,
      purchaseResult: { outcome: 'launched' },
    }),
  });
  const commerce = requireCommerce(withTargetAvailability(notReady.gateway, sellsAll));
  assert.deepEqual(
    await commerce.requestPurchase({
      logicalId: 'COINS_100',
      source: 'shop',
      idempotencyKey: `not-ready-${availability}`,
    }),
    { outcome: 'failed', error: expected },
    `a provider that is ${availability} is named in the refusal`,
  );
  assert.equal(
    notReady.commerce.calls.some((name) => name.startsWith('requestPurchase:')),
    false,
    `a ${availability} provider never sees the purchase`,
  );
  // Subscriptions follow the same readiness rule as one-time products.
  assert.deepEqual(
    await commerce.requestPurchase({
      logicalId: 'VIP_PASS',
      source: 'shop',
      idempotencyKey: `not-ready-subscription-${availability}`,
    }),
    { outcome: 'failed', error: expected },
    `a subscription from a provider that is ${availability} is refused like a one-time product`,
  );
  assert.equal(
    notReady.commerce.calls.some((name) => name.startsWith('requestPurchase:')),
    false,
    `a ${availability} provider never sees the subscription purchase`,
  );
  const blocked = requireCommerce(withTargetAvailability(notReady.gateway, sellsNothing));
  assert.deepEqual(
    await blocked.requestPurchase({
      logicalId: 'COINS_100',
      source: 'shop',
      idempotencyKey: `target-refuses-${availability}`,
    }),
    { outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } },
    `a purchase the target does not sell is ITEM_UNAVAILABLE whatever the readiness (${availability})`,
  );
}

// Recovery reads pass through even when the target stops selling.
{
  const recovery = createMixedGateway();
  const commerce = requireCommerce(withTargetAvailability(recovery.gateway, sellsNothing));
  assert.deepEqual(
    await commerce.getAvailablePurchases(),
    [recoverableTransaction],
    'an already paid purchase stays listed for recovery',
  );
  assert.deepEqual(
    await commerce.finishTransaction?.({
      transactionId: 'recoverable-1',
      ledgerEntryId: 'ledger-recoverable-1',
      isConsumable: true,
    }),
    { finished: true },
    'an already granted purchase stays finishable',
  );
  const unsubscribe = commerce.subscribe(() => {});
  assert.equal(typeof unsubscribe, 'function');
  assert.deepEqual(
    recovery.commerce.calls.filter((name) => name !== 'getCapabilities'),
    ['getAvailablePurchases', 'finishTransaction:recoverable-1', 'subscribe'],
    'recovery calls are forwarded unchanged and nothing else was called',
  );
  assert.equal(
    commerce.acceptsFinishRetry,
    undefined,
    'a hint the source does not declare stays off',
  );
  assert.equal(commerce.acceptsRevokedFinish, undefined);

  // The finish hints a source declares survive the mask, so the reconciler
  // still sends `retry` and the revoked finish through it.
  const hinted = createMixedGateway();
  const declaring = { ...hinted.commerce, acceptsFinishRetry: true, acceptsRevokedFinish: true };
  const masked = requireCommerce(
    withTargetAvailability({ ...hinted.gateway, commerce: declaring }, sellsNothing),
  );
  assert.equal(masked.acceptsFinishRetry, true);
  assert.equal(masked.acceptsRevokedFinish, true);
}

// A store resync is gated like a purchase; without a provider restore it is simply absent.
{
  const selling = createMixedGateway();
  await requireCommerce(withTargetAvailability(selling.gateway, sellsAll)).restorePurchases?.();
  assert.equal(
    selling.commerce.calls.filter((name) => name === 'restorePurchases').length,
    1,
    'a selling target forwards the restore',
  );
  const silent = createMixedGateway();
  await requireCommerce(withTargetAvailability(silent.gateway, sellsNothing)).restorePurchases?.();
  assert.equal(
    silent.commerce.calls.includes('restorePurchases'),
    false,
    'a target that sells nothing does not resync the store',
  );
  const noRestore = createMixedGateway({
    commerce: createRecordingCommerceProvider({
      capabilities: createCommerceBlock(),
      products: mixedCatalog,
    }),
  });
  assert.equal(
    requireCommerce(withTargetAvailability(noRestore.gateway, sellsAll)).restorePurchases,
    undefined,
    'a provider without a restore offers none through the mask',
  );
}

// Active subscriptions follow the subscription mask: a target that does not sell them reports none.
{
  const subscription = {
    store: 'fixture-store',
    logicalId: 'VIP_PASS',
    subscriptionId: 'subscription-1',
    periodIndex: 0,
    state: 'active',
    startedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    autoRenew: true,
  } as const;
  const sellingSubscriptions = createMixedGateway({
    commerce: createRecordingCommerceProvider({
      capabilities: createCommerceBlock({ oneTime: true, subscription: true }),
      activeSubscriptions: [subscription],
    }),
  });
  assert.deepEqual(
    await requireCommerce(
      withTargetAvailability(sellingSubscriptions.gateway, sellsAll),
    ).getActiveSubscriptions?.(),
    [subscription],
  );
  const withoutSubscriptions = createMixedGateway({
    commerce: createRecordingCommerceProvider({
      capabilities: createCommerceBlock({ oneTime: true, subscription: true }),
      activeSubscriptions: [subscription],
    }),
  });
  assert.deepEqual(
    await requireCommerce(
      withTargetAvailability(withoutSubscriptions.gateway, sellsOneTimeOnly),
    ).getActiveSubscriptions?.(),
    [],
    'a target that does not sell subscriptions reports none',
  );
  assert.equal(
    withoutSubscriptions.commerce.calls.includes('getActiveSubscriptions'),
    false,
    'the provider is not asked for subscriptions the target does not sell',
  );
}

// A gateway without a provider stays without one: the mask invents no store.
{
  const withoutProvider: PlatformGateway = {
    ...createBrowserPlatformGateway(),
    target: 'android',
    getCapabilities: async () => createUnsupportedCapabilities(),
  };
  delete (withoutProvider as { commerce?: unknown }).commerce;
  const configured = withTargetAvailability(withoutProvider, sellsAll);
  assert.equal(configured.commerce, undefined);
  assert.equal('commerce' in configured, false);
  const snapshot = await configured.getCapabilities();
  assert.equal(snapshot.commerce.availability, 'unsupported');
  assert.deepEqual(snapshot.commerce, createUnsupportedCapabilities().commerce);
  assert.equal((await configured.getTargetRuntime()).features.iap.reason, 'capability-unsupported');
}

function requireCommerce(gateway: PlatformGateway): NonNullable<PlatformGateway['commerce']> {
  const commerce = gateway.commerce;
  if (commerce === undefined) {
    throw new Error('Expected the gateway to keep its commerce provider.');
  }
  return commerce;
}

// A snapshot without the required commerce block fails with that reason; it never reads as
// "nothing sold" by accident.
{
  const withoutBlock = { ...createUnsupportedCapabilities() } as Record<string, unknown>;
  delete withoutBlock.commerce;
  assert.throws(
    () => applyTargetConfigToCapabilities(withoutBlock as never, android),
    /PlatformCapabilities\.commerce is required/u,
  );
  assert.throws(
    () => getFeatureAvailability('iap', android, withoutBlock as never),
    /PlatformCapabilities\.commerce is required/u,
  );
}

// A source with purchase presentation facts: a purchase refused here, which
// never reaches the source, still ends with `not-started` before its answer,
// and the source's facts pass through numbered on this side.
{
  const sourceListeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
  const recording = createRecordingCommerceProvider({
    capabilities: createCommerceBlock({ oneTime: true, subscription: true }),
    products: mixedCatalog,
    purchaseResult: { outcome: 'launched' },
  });
  const presenting = {
    ...recording,
    presentation: {
      subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
        sourceListeners.add(listener);
        return () => {
          sourceListeners.delete(listener);
        };
      },
    },
    async requestPurchase(request: Parameters<typeof recording.requestPurchase>[0]) {
      const answer = await recording.requestPurchase(request);
      for (const listener of [...sourceListeners]) {
        listener({
          idempotencyKey: request.idempotencyKey,
          sequence: 40,
          state: 'open',
          attempt: 2,
        });
      }
      return answer;
    },
  };
  const masked = createMixedGateway({ commerce: presenting });
  const nothingSold = requireCommerce(withTargetAvailability(masked.gateway, sellsNothing));
  assert.notEqual(nothingSold.presentation, undefined, 'the facts stay offered');
  const log: string[] = [];
  const unsubscribe = nothingSold.presentation?.subscribe((event) => {
    log.push(`${event.idempotencyKey}:${String(event.sequence)}:${event.state}`);
  });
  assert.equal(sourceListeners.size, 1, 'one attachment to the source');
  await nothingSold.requestPurchase({
    logicalId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'refused',
  });
  log.push('refused:answered');
  assert.deepEqual(log, ['refused:1:not-started', 'refused:answered']);

  const sold = requireCommerce(
    withTargetAvailability(createMixedGateway({ commerce: presenting }).gateway, sellsAll),
  );
  const facts: PlatformPurchasePresentationEvent[] = [];
  sold.presentation?.subscribe((event) => facts.push(event));
  await sold.requestPurchase({ logicalId: 'COINS_100', source: 'shop', idempotencyKey: 'sold' });
  // The source reported the sheet: no not-started is added; attempt passes through.
  assert.deepEqual(facts, [{ idempotencyKey: 'sold', sequence: 1, state: 'open', attempt: 2 }]);
  // A fact the source already superseded is not numbered again.
  for (const listener of [...sourceListeners]) {
    listener({ idempotencyKey: 'sold', sequence: 40, state: 'not-started', attempt: 2 });
  }
  assert.equal(facts.length, 1, 'a repeated source sequence is dropped');
  unsubscribe?.();
  assert.equal(sourceListeners.size, 1, 'the second wrapper still listens');
}

console.log('Provider readiness and subscription distinction smoke passed.');

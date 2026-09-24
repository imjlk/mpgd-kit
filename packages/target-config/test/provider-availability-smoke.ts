import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';
import { createUnsupportedCapabilities, type PlatformGateway } from '@mpgd/platform';

import { createBrowserPlatformGateway } from '../../../adapters/browser/src/index';
import { createEffectiveTargetConfig } from '../src/effective';
import {
  applyTargetConfigToCapabilities,
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
const capabilities = {
  ...createUnsupportedCapabilities(),
  subscriptionIap: false,
  providerAvailability: {
    nativeIap: 'configuration-required',
    subscriptionIap: 'unsupported',
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

const masked = applyTargetConfigToCapabilities(
  {
    ...capabilities,
    nativeIap: true,
    subscriptionIap: true,
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
assert.equal(masked.nativeIap, true);
assert.equal(masked.subscriptionIap, false);
assert.equal(masked.nativeLeaderboard, false);

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

const subscriptionProduct = {
  id: product.id,
  type: 'subscription',
  title: 'Test subscription',
  description: 'Fixture only',
  price: { formatted: '$1.00', currencyCode: 'USD' },
} as const;
let purchaseCalls = 0;
const browser = createBrowserPlatformGateway();
const subscriptionGateway: PlatformGateway = {
  ...browser,
  target: 'android',
  getCapabilities: async () => ({
    ...createUnsupportedCapabilities(),
    subscriptionIap: true,
  }),
  commerce: {
    getProducts: async () => [subscriptionProduct],
    async purchase() {
      purchaseCalls += 1;
      return { status: 'pending', entitlementIds: [] };
    },
    getEntitlements: async () => [],
  },
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
assert.equal((await enabledGateway.getCapabilities()).subscriptionIap, true);
assert.deepEqual(await enabledGateway.commerce.getProducts(), [subscriptionProduct]);
assert.equal((await enabledGateway.commerce.purchase({
  productId: product.id,
  source: 'shop',
  idempotencyKey: 'subscription-test',
})).status, 'pending');
assert.equal(purchaseCalls, 1);
assert.equal((await enabledGateway.commerce.purchase({
  productId: 'UNKNOWN_SUBSCRIPTION',
  source: 'shop',
  idempotencyKey: 'unknown-subscription-test',
})).status, 'cancelled');
assert.equal(purchaseCalls, 1);

const withoutEffectiveConfig = withTargetAvailability(subscriptionGateway, config);
assert.deepEqual(await withoutEffectiveConfig.commerce.getProducts(), [subscriptionProduct]);
assert.equal((await withoutEffectiveConfig.commerce.purchase({
  productId: product.id,
  source: 'shop',
  idempotencyKey: 'subscription-without-effective-config',
})).status, 'pending');
assert.equal(purchaseCalls, 2);

const disabledGateway = withTargetAvailability(subscriptionGateway, config, {
  effectiveConfig: effective,
});
assert.equal((await disabledGateway.getCapabilities()).subscriptionIap, false);
assert.deepEqual(await disabledGateway.commerce.getProducts(), []);
assert.equal((await disabledGateway.commerce.purchase({
  productId: product.id,
  source: 'shop',
  idempotencyKey: 'disabled-subscription-test',
})).status, 'cancelled');
assert.equal(purchaseCalls, 2);

console.log('Provider readiness and subscription distinction smoke passed.');

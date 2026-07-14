import assert from 'node:assert/strict';

import {
  assertDevvitInternalEndpoint,
  assertDevvitPaymentsReadiness,
} from './verify-target-artifacts';

const enabledConfig = {
  features: { iap: true },
  monetization: {
    iap: true,
    products: [{ enabled: true, platformProductId: 'cosmetic_1' }],
  },
};
const disabledConfig = {
  features: { iap: false },
  monetization: {
    iap: false,
    products: [{ enabled: false, platformProductId: 'cosmetic_1' }],
  },
};

assert.deepEqual(assertDevvitPaymentsReadiness(true, enabledConfig, 'reddit Devvit manifest'), [
  'cosmetic_1',
]);
assert.deepEqual(
  assertDevvitPaymentsReadiness(false, disabledConfig, 'reddit Devvit manifest'),
  [],
);
assert.throws(
  () => assertDevvitPaymentsReadiness(false, enabledConfig, 'reddit Devvit manifest'),
  /features\.iap must be false/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(false, {
    features: { iap: false },
    monetization: {
      iap: false,
      products: [{ enabled: true, platformProductId: 'cosmetic_1' }],
    },
  }, 'reddit Devvit manifest'),
  /must not expose enabled products/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(undefined, enabledConfig, 'reddit Devvit manifest'),
  /features\.iap must be false/u,
);

assert.doesNotThrow(() =>
  assertDevvitInternalEndpoint('/internal/payments/fulfill', 'fulfillOrder'));
assert.throws(
  () => assertDevvitInternalEndpoint('/api/payments/fulfill', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);
assert.throws(
  () => assertDevvitInternalEndpoint('/internal/', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);

console.log('Target artifact readiness tests passed.');

import assert from 'node:assert/strict';

import {
  assertDevvitInternalEndpoint,
  assertDevvitPaymentsReadiness,
  assertMicrosoftStorePwaManifestSourceContract,
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
const capabilityReadyConfig = {
  features: { iap: true },
  monetization: {
    iap: true,
    products: [{ enabled: false, platformProductId: undefined }],
  },
};

assert.deepEqual(assertDevvitPaymentsReadiness(true, enabledConfig, 'reddit Devvit manifest'), [
  'cosmetic_1',
]);
assert.deepEqual(
  assertDevvitPaymentsReadiness(false, disabledConfig, 'reddit Devvit manifest'),
  [],
);
assert.deepEqual(
  assertDevvitPaymentsReadiness(false, capabilityReadyConfig, 'reddit Devvit manifest'),
  [],
);
assert.throws(
  () => assertDevvitPaymentsReadiness(false, enabledConfig, 'reddit Devvit manifest'),
  /must not expose enabled products/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(undefined, enabledConfig, 'reddit Devvit manifest'),
  /must not expose enabled products/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(true, disabledConfig, 'reddit Devvit manifest'),
  /features\.iap must be true/u,
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

const sourcePwaManifest = {
  lang: 'en-US',
  name: 'Fixture',
  short_name: 'Fixture',
  description: 'Fixture game',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'landscape',
  background_color: '#020617',
  theme_color: '#0f172a',
  categories: ['games', 'entertainment'],
  icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml' }],
};

assert.doesNotThrow(() => assertMicrosoftStorePwaManifestSourceContract(
  {
    ...sourcePwaManifest,
    icons: [{
      src: './icons/icon-any-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    }],
  },
  sourcePwaManifest,
));
assert.throws(
  () => assertMicrosoftStorePwaManifestSourceContract(
    { ...sourcePwaManifest, description: 'Stale description' },
    sourcePwaManifest,
  ),
  /manifest description differs from public\/manifest\.webmanifest/u,
);
assert.throws(
  () => assertMicrosoftStorePwaManifestSourceContract(
    { ...sourcePwaManifest, categories: ['games'] },
    sourcePwaManifest,
  ),
  /manifest categories differs from public\/manifest\.webmanifest/u,
);

console.log('Target artifact readiness tests passed.');

import assert from 'node:assert/strict';

import {
  normalizeBuildTarget,
  normalizeConfiguredBuildTargets,
} from '../../packages/cli/src/build-targets';

const configuredTargets = {
  'web-preview': {
    kind: 'web',
  },
  storefront: {
    kind: 'web',
  },
  unsupportedCustomNative: {
    kind: 'custom-native',
  },
} as const;

assert.equal(normalizeBuildTarget('web', configuredTargets), 'web-preview');
assert.equal(normalizeBuildTarget('browser', configuredTargets), 'web-preview');
assert.equal(normalizeBuildTarget('storefront', configuredTargets), 'storefront');
assert.equal(normalizeBuildTarget('web', { web: { kind: 'web' } }), 'web');
const configuredBuildTargets = normalizeConfiguredBuildTargets(configuredTargets);
assert.deepEqual(configuredBuildTargets, ['web-preview', 'storefront']);
assert.throws(
  () => normalizeBuildTarget('unsupportedCustomNative', configuredTargets),
  /Unsupported target: unsupportedCustomNative/u,
);
assert.throws(
  () => normalizeBuildTarget('missing', configuredTargets),
  /Unsupported target: missing/u,
);

console.log('Configured web target CLI smoke passed.');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserPlatformGateway } from '../../../adapters/browser/src/index';
import { createReviewProvider, withReviewProvider } from '../../platform/src/reviews';
import {
  getTargetConfig,
  normalizeTargetIntegrationConfig,
  withTargetAvailability,
  type TargetConfigMatrix,
} from '../src/runtime';

const matrix = JSON.parse(
  readFileSync('packages/target-config/targets.json', 'utf8'),
) as TargetConfigMatrix;
const config = getTargetConfig(matrix, 'android');
let requested = 0;
const provider = createReviewProvider({
  providerId: 'google-play',
  requestNative: async () => {
    requested += 1;
  },
});
const base = withReviewProvider(createBrowserPlatformGateway(), provider);
for (const reviews of [
  'disabled',
  'unsupported',
  'approval-required',
  'configuration-required',
  'temporarily-unavailable',
  'action-required',
] as const) {
  const gateway = withTargetAvailability(base, {
    ...config,
    integrations: { ...normalizeTargetIntegrationConfig(config.integrations), reviews },
  });
  assert.equal(gateway.reviews, undefined);
  assert.equal((await gateway.getCapabilities()).reviews, undefined);
}
const old = withTargetAvailability(base, config);
assert.equal(old.reviews, undefined);
const enabled = withTargetAvailability(base, {
  ...config,
  integrations: { ...normalizeTargetIntegrationConfig(config.integrations), reviews: 'available' },
});
assert.equal(enabled.reviews, provider);
assert.equal((await enabled.getCapabilities()).reviews?.nativePrompt, true);
assert.equal((await enabled.getTargetRuntime()).integrations.reviews.state, 'available');
assert.deepEqual(await enabled.reviews?.requestNative(), { status: 'requested' });
assert.equal(requested, 1);
const missing = withTargetAvailability(createBrowserPlatformGateway(), {
  ...config,
  integrations: { ...normalizeTargetIntegrationConfig(config.integrations), reviews: 'available' },
});
assert.equal((await missing.getTargetRuntime()).integrations.reviews.state, 'unsupported');
assert.equal(missing.reviews, undefined);

import assert from 'node:assert/strict';

import { resolveNativeBuildPlan } from './native-build-mode';

const select = (
  platform: 'android' | 'ios',
  profile: string,
  environment: NodeJS.ProcessEnv = {},
) => resolveNativeBuildPlan({ platform, profile, environment });

assert.deepEqual(select('android', 'staging'), {
  platform: 'android',
  mode: 'unsigned-archive',
  submissionCandidate: false,
});
assert.deepEqual(select('ios', 'staging'), {
  platform: 'ios',
  mode: 'sync',
  submissionCandidate: false,
});
assert.equal(select('ios', 'staging', { MPGD_RUN_IOS_SIMULATOR_BUILD: '1' }).mode, 'simulator');
assert.equal(select('ios', 'staging', { MPGD_RUN_IOS_ARCHIVE: '1' }).mode, 'unsigned-archive');
assert.deepEqual(
  select('android', 'production', {
    MPGD_NATIVE_BUILD_MODE: 'signed-archive',
  }),
  {
    platform: 'android',
    mode: 'signed-archive',
    submissionCandidate: true,
  },
);
assert.deepEqual(
  select('ios', 'production', {
    MPGD_NATIVE_BUILD_MODE: 'store-export',
  }),
  {
    platform: 'ios',
    mode: 'store-export',
    submissionCandidate: true,
  },
);
assert.equal(select('ios', 'production', {
  MPGD_NATIVE_BUILD_MODE: 'signed-archive',
}).submissionCandidate, false);
assert.throws(() => select('ios', 'production'), /explicit MPGD_NATIVE_BUILD_MODE/u);
assert.throws(
  () =>
    select('android', 'production', {
      MPGD_NATIVE_BUILD_MODE: 'sync',
    }),
  /signed archive/u,
);
assert.throws(
  () =>
    select('ios', 'production', {
      MPGD_NATIVE_BUILD_MODE: 'unsigned-archive',
    }),
  /signed archive/u,
);
assert.throws(
  () =>
    select('android', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'simulator',
    }),
  /Unsupported android/u,
);
assert.throws(
  () =>
    select('ios', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'debug',
    }),
  /Unsupported ios/u,
);
assert.throws(
  () =>
    select('ios', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'store-export',
      MPGD_RUN_IOS_ARCHIVE: '1',
    }),
  /cannot be combined/u,
);

console.info('Native build-mode selection passed.');

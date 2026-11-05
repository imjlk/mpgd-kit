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
  rehearsal: false,
});
assert.deepEqual(select('ios', 'staging'), {
  platform: 'ios',
  mode: 'sync',
  submissionCandidate: false,
  rehearsal: false,
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
    rehearsal: false,
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
    rehearsal: false,
  },
);
assert.deepEqual(
  select('android', 'production', {
    MPGD_NATIVE_BUILD_MODE: ' rehearsal-archive ',
  }),
  {
    platform: 'android',
    mode: 'unsigned-archive',
    submissionCandidate: false,
    rehearsal: true,
  },
);
assert.equal(select('ios', 'production', {
  MPGD_NATIVE_BUILD_MODE: 'signed-archive',
}).submissionCandidate, false);
assert.equal(select('android', 'staging', {
  MPGD_NATIVE_BUILD_MODE: 'signed-archive',
}).submissionCandidate, false);
assert.equal(select('ios', 'staging', {
  MPGD_NATIVE_BUILD_MODE: 'store-export',
}).submissionCandidate, false);
assert.throws(() => select('ios', 'production'), /explicit MPGD_NATIVE_BUILD_MODE/u);
assert.throws(
  () =>
    select('android', 'production', {
      MPGD_NATIVE_BUILD_MODE: 'sync',
    }),
  /not portable/u,
);
assert.throws(
  () =>
    select('ios', 'production', {
      MPGD_NATIVE_BUILD_MODE: 'unsigned-archive',
    }),
  /signed archive/u,
);
for (const mode of ['unsigned-archive', 'debug']) {
  assert.throws(
    () =>
      select('android', 'production', {
        MPGD_NATIVE_BUILD_MODE: mode,
      }),
    /select rehearsal-archive/u,
  );
}
assert.throws(
  () =>
    select('ios', 'production', {
      MPGD_NATIVE_BUILD_MODE: 'rehearsal-archive',
    }),
  /Android-only/u,
);
assert.throws(
  () =>
    select('android', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'rehearsal-archive',
    }),
  /only to the production profile/u,
);
assert.throws(
  () =>
    select('ios', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'rehearsal-archive',
      MPGD_RUN_IOS_ARCHIVE: '1',
    }),
  /cannot be combined/u,
);
// The game-owned Gradle opt-out is not a Kit mode selector.
assert.throws(
  () => select('android', 'production', { MPGD_ANDROID_ALLOW_UNSIGNED: '1' }),
  /explicit MPGD_NATIVE_BUILD_MODE/u,
);
assert.throws(
  () =>
    select('android', 'staging', {
      MPGD_NATIVE_BUILD_MODE: 'sync',
    }),
  /not portable/u,
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

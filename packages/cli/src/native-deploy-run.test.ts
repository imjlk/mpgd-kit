import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  dependencyInstallEnvironment,
  persistImmutableFile,
  planNativeDeploymentSteps,
} from './native-deploy-run.js';
import type { NativeDeploymentPlan } from './deploy-planning.js';
import type { NativeReleaseStatus } from './release-state.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-deploy-output-test-'));
try {
  assert.deepEqual(
    dependencyInstallEnvironment({
      PATH: '/bin',
      HOME: '/safe-home',
      MPGD_IOS_SIGNING_P12_PASSWORD: 'private-password',
      MPGD_ASC_API_KEY: 'private-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/account.json',
    }),
    { PATH: '/bin', HOME: '/safe-home' },
    'dependency install hooks cannot read deployment credentials',
  );
  const game = path.join(fixture, 'game');
  const outside = path.join(fixture, 'outside');
  const source = path.join(fixture, 'source.aab');
  const other = path.join(fixture, 'other.aab');
  mkdirSync(game);
  mkdirSync(outside);
  writeFileSync(source, 'signed artifact bytes');
  writeFileSync(other, 'different artifact bytes');
  const location = '.mpgd/releases/beta-001/android.aab';
  const output = persistImmutableFile(game, location, source);
  assert.equal(readFileSync(output, 'utf8'), 'signed artifact bytes');
  assert.equal(persistImmutableFile(game, location, source), output);
  assert.throws(() => persistImmutableFile(game, location, other), /different bytes/u);
  const retryLocation = '.mpgd/releases/beta-001/android-different.aab';
  assert.equal(
    readFileSync(persistImmutableFile(game, retryLocation, other), 'utf8'),
    'different artifact bytes',
  );
  assert.throws(() => persistImmutableFile(game, '../outside/bad.aab', source), /escapes/u);
  const linkedGame = path.join(fixture, 'linked-game');
  mkdirSync(linkedGame);
  symlinkSync(outside, path.join(linkedGame, '.mpgd'), 'dir');
  assert.throws(() => persistImmutableFile(linkedGame, location, source), /symlink/u);
  assert.deepEqual(readdirSync(outside), []);
  const linkedFile = path.join(game, '.mpgd/releases/beta-001/ios.ipa');
  symlinkSync(source, linkedFile);
  assert.throws(
    () => persistImmutableFile(game, '.mpgd/releases/beta-001/ios.ipa', source),
    /regular file/u,
  );
  const plan = {
    targetConfigSha256: 'd'.repeat(64),
    targets: [
      { target: 'android', appId: 'dev.mpgd.test' },
      { target: 'ios', appId: 'dev.mpgd.test' },
    ],
  } as unknown as NativeDeploymentPlan;
  const status = {
    plan: { targetConfigDigest: plan.targetConfigSha256, targets: { android: {}, ios: {} } },
    builds: {
      android: { inspectedAppId: 'dev.mpgd.test' },
    },
    submissions: { android: { status: 'committed' } },
  } as unknown as NativeReleaseStatus;
  assert.deepEqual(planNativeDeploymentSteps(plan, status), {
    buildTargets: ['ios'],
    submitTargets: ['ios'],
  });
  assert.deepEqual(planNativeDeploymentSteps(plan, {
    ...status,
    builds: { ...status.builds, ios: { ...status.builds.android, target: 'ios' } },
    submissions: { ...status.submissions, ios: { ...status.submissions.android, status: 'unknown' } },
  } as NativeReleaseStatus), {
    buildTargets: [], submitTargets: ['ios'],
  });
  assert.throws(() => planNativeDeploymentSteps(plan, {
    ...status,
    builds: { android: { ...status.builds.android, inspectedAppId: 'dev.mpgd.wrong' } },
  } as NativeReleaseStatus), /app ID differs/u);
  console.info('Immutable native release output boundaries passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

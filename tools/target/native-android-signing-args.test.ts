import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { androidSignedReleaseGradleArgs } from './native-build-execution';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-gradle-signing-'));

try {
  const initScript = path.join(fixture, 'signing.init.gradle');
  writeFileSync(initScript, 'gradle.beforeProject {}\n');
  assert.deepEqual(androidSignedReleaseGradleArgs({}), ['bundleRelease', '--no-daemon']);
  assert.deepEqual(
    androidSignedReleaseGradleArgs({ MPGD_ANDROID_SIGNING_INIT_SCRIPT: initScript }),
    ['bundleRelease', '--no-daemon', '--init-script', initScript],
  );
  assert.throws(
    () => androidSignedReleaseGradleArgs({ MPGD_ANDROID_SIGNING_INIT_SCRIPT: './signing.gradle' }),
    /existing absolute file/u,
  );
  const missingScript = path.join(fixture, 'missing.gradle');
  assert.throws(
    () => androidSignedReleaseGradleArgs({ MPGD_ANDROID_SIGNING_INIT_SCRIPT: missingScript }),
    /existing absolute file/u,
  );
  console.info('Android signed release Gradle launch arguments passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertFreshNativeBuildArtifact,
  beginNativeBuildAttempt,
  readNativeBuildAttempt,
} from './native-build-attempt';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-native-attempt-'));

try {
  assert.equal(readNativeBuildAttempt(root, 'android'), undefined);
  const first = beginNativeBuildAttempt(root, 'android');
  assert.equal(readNativeBuildAttempt(root, 'android')?.status, 'building');
  assert.throws(() => beginNativeBuildAttempt(root, 'android'), /live build/u);
  first.complete('release-output/native/android/one.aab');
  assert.equal(readNativeBuildAttempt(root, 'android')?.status, 'success');
  assert.equal(assertFreshNativeBuildArtifact(
    root, 'android', 'release-output/native/android/one.aab',
  )?.status, 'success');

  const second = beginNativeBuildAttempt(root, 'android');
  assert.equal(readNativeBuildAttempt(root, 'android')?.status, 'building');
  assert.throws(
    () => assertFreshNativeBuildArtifact(root, 'android', 'release-output/native/android/one.aab'),
    /no successful current build artifact/u,
  );
  assert.notEqual(second.runId, first.runId);
  second.fail();
  assert.equal(readNativeBuildAttempt(root, 'android')?.status, 'failed');
  assert.throws(
    () => assertFreshNativeBuildArtifact(root, 'android', 'release-output/native/android/one.aab'),
    /no successful current build artifact/u,
  );

  const third = beginNativeBuildAttempt(root, 'android');
  assert.throws(() => third.complete('../escape.aab'), /path is invalid/u);
  assert.throws(() => third.complete('release-output/native/ios/other.aab'), /path is invalid/u);
  third.complete('release-output/native/android/three.aab');
  assert.equal(
    readNativeBuildAttempt(root, 'android')?.artifact,
    'release-output/native/android/three.aab',
  );
  // Crash symbols are recorded with the artifact, inside the target's output root.
  const withMapping = beginNativeBuildAttempt(root, 'android');
  assert.throws(
    () =>
      withMapping.complete('release-output/native/android/four.aab', {
        r8Mapping: 'release-output/native/ios/mapping.txt',
      }),
    /symbols are malformed/u,
  );
  withMapping.complete('release-output/native/android/four.aab', {
    r8Mapping: 'release-output/native/android/symbols/mapping.txt',
  });
  assert.deepEqual(readNativeBuildAttempt(root, 'android')?.symbols, {
    r8Mapping: 'release-output/native/android/symbols/mapping.txt',
  });
  const iosAttempt = beginNativeBuildAttempt(root, 'ios');
  const crashlytics = {
    dsymArchive: 'release-output/native/ios/symbols/dSYMs.zip',
    dsyms: [{ bundle: 'App.app.dSYM', uuids: ['00112233-4455-6677-8899-AABBCCDDEEFF'] }],
    uploadTool: 'release-output/native/ios/symbols/upload-symbols',
    googleServiceInfo: 'release-output/native/ios/symbols/GoogleService-Info.plist',
  };
  iosAttempt.complete('release-output/native/ios/App.ipa', { crashlytics });
  assert.deepEqual(readNativeBuildAttempt(root, 'ios')?.symbols, { crashlytics });
  assert.equal(readNativeBuildAttempt(root, '3d-android'), undefined);
  const numeric = beginNativeBuildAttempt(root, '3d-android');
  numeric.complete('release-output/native/3d-android/one.aab');
  assert.throws(
    () => beginNativeBuildAttempt(root, '../android'),
    /Invalid deployment target name/u,
  );
  console.info('Native build attempt invalidation passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

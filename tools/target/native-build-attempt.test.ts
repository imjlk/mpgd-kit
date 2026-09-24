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
  assert.throws(() => beginNativeBuildAttempt(root, '../android'), /name is invalid/u);
  console.info('Native build attempt invalidation passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

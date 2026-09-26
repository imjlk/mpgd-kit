import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NativeDeploymentPlan } from './deploy-planning.js';
import {
  submitRecordedNativeTargetWithPorts,
  type NativeSubmissionPorts,
} from './native-deploy-submission.js';
import { PlaySubmissionUncertainError } from './play-internal-submission.js';
import { IosSubmissionUncertainError } from './testflight-submission.js';
import type {
  ImmutableNativeBuildRecord,
  NativeReleaseStatus,
  NativeSubmissionCheckpoint,
} from './release-state.js';

const gameRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-deploy-submit-test-'));
try {
  writeFileSync(path.join(gameRoot, 'android.aab'), 'test Android bytes');
  writeFileSync(path.join(gameRoot, 'ios.ipa'), 'test iOS bytes');
  const digest = 'd'.repeat(64);
  const plan: NativeDeploymentPlan = {
    schemaVersion: 1,
    gameRoot,
    profile: 'beta',
    buildProfile: 'production',
    approval: 'manual',
    targetConfigSha256: digest,
    deployConfigSha256: 'e'.repeat(64),
    targets: [
      { target: 'android', destination: 'play-internal', appId: 'dev.mpgd.test' },
      { target: 'ios', destination: 'testflight', appId: 'dev.mpgd.test', testGroup: 'group-1' },
    ],
  };
  const android = {
    releaseKey: 'beta-01',
    target: 'android',
    buildRunId: 'android-run',
    inspectedAppId: 'dev.mpgd.test',
    artifactLocation: 'android.aab',
    artifactSha256: 'a'.repeat(64),
  } as ImmutableNativeBuildRecord;
  const ios = {
    releaseKey: 'beta-01',
    target: 'ios',
    buildRunId: 'ios-run',
    inspectedAppId: 'dev.mpgd.test',
    artifactLocation: 'ios.ipa',
    artifactSha256: 'b'.repeat(64),
  } as ImmutableNativeBuildRecord;
  let checkpoints: NativeReleaseStatus['submissions'] = {};
  let androidCalls = 0;
  let iosCalls = 0;
  let ordinaryAndroidFailure = false;
  let failIosCheckpoint = false;
  const ports: NativeSubmissionPorts = {
    async readStatus() {
      return {
        plan: {
          gameId: 'game',
          targetConfigDigest: digest,
          targets: { android: {}, ios: {} },
        } as unknown as NativeReleaseStatus['plan'],
        builds: { android, ios },
        submissions: checkpoints,
        stateCommit: 'c'.repeat(40),
      };
    },
    async checkpoint({ checkpoint }) {
      if (failIosCheckpoint && checkpoint.target === 'ios'
        && checkpoint.status !== 'started') {
        throw new Error('release-state push response lost');
      }
      checkpoints = { ...checkpoints, [checkpoint.target]: checkpoint };
      return { checkpoint, stateCommit: 'c'.repeat(40) };
    },
    async reclaim() {
      const current = checkpoints.ios ?? checkpoints.android;
      assert.ok(current);
      const reclaimed = {
        ...current,
        attemptId: 'd'.repeat(32),
        leaseExpiresAt: new Date(Date.now() + 24 * 60_000).toISOString(),
      };
      checkpoints = { ...checkpoints, [current.target]: reclaimed };
      return { checkpoint: reclaimed, stateCommit: 'c'.repeat(40) };
    },
    async releaseLease({ target }) {
      const current = checkpoints[target];
      assert.ok(current);
      const released = { ...current, leaseExpiresAt: new Date(0).toISOString() };
      checkpoints = { ...checkpoints, [target]: released };
      return released;
    },
    async submitAndroid(input) {
      androidCalls += 1;
      if (androidCalls === 1) {
        assert.equal(input.resumeEditId, undefined);
        await input.onEditCreated?.('edit-1');
        if (ordinaryAndroidFailure) {
          throw new Error('bundle listing temporarily failed');
        }
        throw new PlaySubmissionUncertainError('validate', 'edit-1');
      }
      assert.equal(input.resumeEditId, 'edit-1');
      return {
        status: 'committed',
        packageName: 'dev.mpgd.test',
        editId: 'edit-1',
        track: 'internal',
        versionCode: 42,
        bundleSha256: android.artifactSha256,
        alreadyCommitted: false,
      };
    },
    async submitIos(input) {
      iosCalls += 1;
      if (iosCalls === 1) {
        assert.equal(input.resumeUploadId, undefined);
        try {
          await input.onUploadCommitted?.('upload-1');
        } catch {
          throw new IosSubmissionUncertainError('upload-1');
        }
      } else {
        assert.equal(input.resumeUploadId, 'upload-1');
        assert.equal(input.resumeArtifactSha256, ios.artifactSha256);
      }
      return {
        status: iosCalls === 1 ? 'processing' : 'testflight-ready',
        appStoreAppId: '123456',
        bundleId: 'dev.mpgd.test',
        marketingVersion: '1.0.0',
        buildNumber: '42',
        internalGroupId: 'group-1',
        uploadId: 'upload-1',
        buildId: 'build-1',
      };
    },
  };
  const androidInput = {
    plan,
    gameId: 'game',
    releaseKey: 'beta-01',
    credential: { target: 'android' as const, serviceAccountFile: '/unused/service-account.json' },
    approved: true,
  };
  await assert.rejects(
    submitRecordedNativeTargetWithPorts({ ...androidInput, approved: false }, ports),
    /explicit approval/u,
  );
  await assert.rejects(
    submitRecordedNativeTargetWithPorts(androidInput, ports),
    (error: unknown) => error instanceof PlaySubmissionUncertainError,
  );
  assert.equal(checkpoints.android?.status, 'unknown');
  assert.equal(checkpoints.android?.remoteEditId, 'edit-1');
  const androidResult = await submitRecordedNativeTargetWithPorts(androidInput, ports);
  assert.equal(androidResult.status, 'committed');
  assert.equal(androidCalls, 2);
  await submitRecordedNativeTargetWithPorts(androidInput, ports);
  assert.equal(androidCalls, 2);
  checkpoints = {};
  androidCalls = 0;
  ordinaryAndroidFailure = true;
  await assert.rejects(
    submitRecordedNativeTargetWithPorts(androidInput, ports),
    /bundle listing temporarily failed/u,
  );
  assert.equal(checkpoints.android?.status, 'unknown');
  assert.equal(checkpoints.android?.remoteEditId, 'edit-1');
  await submitRecordedNativeTargetWithPorts(androidInput, ports);
  assert.equal(androidCalls, 2);

  const iosInput = {
    plan,
    gameId: 'game',
    releaseKey: 'beta-01',
    credential: {
      target: 'ios' as const,
      ascBinary: '/unused/asc',
      appStoreAppId: '123456',
      apiKeyId: 'ABCDEFGHIJ',
      apiIssuerId: 'issuer',
      apiPrivateKeyBase64: 'private-key',
    },
    approved: true,
  };
  const processing = await submitRecordedNativeTargetWithPorts(iosInput, ports);
  assert.equal(processing.status, 'processing');
  const ready = await submitRecordedNativeTargetWithPorts(iosInput, ports);
  assert.equal(ready.status, 'testflight-ready');
  await submitRecordedNativeTargetWithPorts(iosInput, ports);
  assert.equal(iosCalls, 2);
  checkpoints = {};
  iosCalls = 0;
  failIosCheckpoint = true;
  await assert.rejects(
    submitRecordedNativeTargetWithPorts(iosInput, ports),
    (error: unknown) => error instanceof AggregateError
      && error.message.includes('upload upload-1')
      && error.errors[0] instanceof IosSubmissionUncertainError,
  );
  console.info('Resumable recorded native submissions passed.');
} finally {
  rmSync(gameRoot, { recursive: true, force: true });
}

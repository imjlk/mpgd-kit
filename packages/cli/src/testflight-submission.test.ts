import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IosSubmissionUncertainError,
  submitVerifiedIosBuildWithRunner,
  verifyPinnedAscBinary,
  type AscJsonRunner,
  type IosTestFlightSubmissionInput,
} from './testflight-submission.js';
import { ReleaseProcessError } from './deploy-process.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-testflight-test-'));
const ipa = path.join(fixture, 'game.ipa');
const bytes = Buffer.from('verified iOS archive fixture');
writeFileSync(ipa, bytes);
const digest = createHash('sha256').update(bytes).digest('hex');
const bundleId = 'dev.mpgd.testgame';
const appId = '123456789';
const groupId = 'group-123';
const version = '1.2.3';
const buildNumber = '42';
const input: IosTestFlightSubmissionInput = {
  record: {
    releaseKey: 'beta-1',
    target: 'ios',
    buildRunId: 'run-1',
    gameVersion: version,
    sourceGitSha: 'a'.repeat(40),
    kitGitSha: 'b'.repeat(40),
    kitPackageVersion: '0.1.0',
    buildConfigDigest: 'c'.repeat(64),
    targetConfigDigest: 'd'.repeat(64),
    platformVersion: { marketingVersion: version, buildNumber },
    artifactLocation: 'artifacts/game.ipa',
    artifactSha256: digest,
    releaseManifestSha256: 'e'.repeat(64),
    inspectedAppId: bundleId,
    inspectedTeamId: 'A1B2C3D4E5',
  },
  ipaFile: ipa,
  bundleId,
  appStoreAppId: appId,
  internalGroupId: groupId,
  ascBinary: path.join(fixture, 'asc'),
  apiKeyId: 'A1B2C3D4E5',
  apiIssuerId: 'issuer-id',
  apiPrivateKeyBase64: 'ZmFrZSBrZXk=',
};

interface MockState {
  readonly commands: string[];
  processingState?: string;
  existingBuild?: boolean;
  membership?: boolean;
  throwUpload?: boolean;
  uploadCommittedOnError?: boolean;
  uploadFailureReason?: ReleaseProcessError['reason'];
  malformedUpload?: boolean;
  groupAction?: string;
  groupIds?: string[];
  groupFailure?: 'network' | 'compliance';
  appBundleId?: string;
  uploadVisible?: boolean;
}

function mock(overrides: Partial<MockState> = {}): { state: MockState; run: AscJsonRunner } {
  const state: MockState = {
    commands: [],
    processingState: 'PROCESSING',
    membership: true,
    uploadVisible: false,
    ...overrides,
  };
  const run: AscJsonRunner = async (args) => {
    const command = args.slice(0, 3).join(' ');
    state.commands.push(args.join(' '));
    if (command.startsWith('apps view')) {
      return {
        data: { type: 'apps', id: appId, attributes: { bundleId: state.appBundleId ?? bundleId } },
      };
    }
    if (command.startsWith('testflight groups list')) {
      const membership = args.includes('--build-id');
      return {
        data: membership && !state.membership
          ? []
          : [
              {
                type: 'betaGroups',
                id: groupId,
                attributes: { isInternalGroup: true },
              },
            ],
      };
    }
    if (command.startsWith('builds uploads list')) {
      return {
        data: state.uploadVisible
          ? [
              {
                type: 'buildUploads',
                id: 'upload-1',
                attributes: {
                  cfBundleShortVersionString: version,
                  cfBundleVersion: buildNumber,
                  platform: 'IOS',
                },
              },
            ]
          : [],
      };
    }
    if (command.startsWith('builds list')) {
      return {
        data: state.existingBuild
          ? [
              {
                type: 'builds',
                id: 'build-1',
                attributes: { version: buildNumber, processingState: state.processingState },
              },
            ]
          : [],
      };
    }
    if (command.startsWith('builds upload')) {
      if (state.uploadFailureReason !== undefined) {
        throw new ReleaseProcessError(state.uploadFailureReason, '', 1);
      }
      if (state.throwUpload) {
        if (state.uploadCommittedOnError) {
          state.uploadVisible = true;
        }
        throw new Error('upload response lost');
      }
      if (state.malformedUpload) {
        state.uploadVisible = true;
        return { uploadId: 'upload-1', uploaded: true };
      }
      state.existingBuild = true;
      state.uploadVisible = true;
      return {
        uploadId: 'upload-1',
        fileId: 'file-1',
        fileName: 'game.ipa',
        fileSize: bytes.length,
        uploaded: true,
        operations: [],
      };
    }
    if (command.startsWith('builds add-groups')) {
      if (state.groupFailure !== undefined) {
        throw new ReleaseProcessError(
          'exit',
          state.groupFailure === 'compliance'
            ? 'export compliance declaration required'
            : 'upstream unavailable',
          1,
        );
      }
      return {
        action: state.groupAction ?? 'added',
        buildId: 'build-1',
        groupIds: state.groupIds ?? [groupId],
      };
    }
    throw new Error(`Unexpected asc command: ${command}`);
  };
  return { state, run };
}

try {
  const processing = mock();
  const upload = await submitVerifiedIosBuildWithRunner(input, processing.run);
  assert.equal(upload.status, 'processing');
  assert.equal(upload.uploadId, 'upload-1');
  assert.equal(upload.buildId, 'build-1');
  assert.equal(
    processing.state.commands.filter((command) => command.startsWith('builds upload ')).length,
    1,
  );
  assert.equal(
    processing.state.commands.some((command) => command.includes('--wait')),
    false,
  );
  assert.equal(
    processing.state.commands.some((command) => command.startsWith('builds upload ')
      && command.includes('--checksum')),
    true,
  );

  const valid = mock({ processingState: 'VALID' });
  const ready = await submitVerifiedIosBuildWithRunner(input, valid.run);
  assert.equal(ready.status, 'testflight-ready');
  assert.equal(
    valid.state.commands.some((command) => command.startsWith('builds add-groups')),
    true,
  );

  const noMembership = mock({ processingState: 'VALID', membership: false });
  assert.equal((await submitVerifiedIosBuildWithRunner(input, noMembership.run)).status, 'unknown');
  const alreadyGrouped = mock({ processingState: 'VALID', groupIds: [] });
  assert.equal(
    (await submitVerifiedIosBuildWithRunner(input, alreadyGrouped.run)).status,
    'testflight-ready',
  );
  const unrelatedGroup = mock({ processingState: 'VALID', groupIds: ['other-group'] });
  assert.equal(
    (await submitVerifiedIosBuildWithRunner(input, unrelatedGroup.run)).status,
    'unknown',
  );
  const transientGroup = mock({ processingState: 'VALID', groupFailure: 'network' });
  assert.equal(
    (await submitVerifiedIosBuildWithRunner(input, transientGroup.run)).status,
    'unknown',
  );
  const complianceGroup = mock({ processingState: 'VALID', groupFailure: 'compliance' });
  assert.equal(
    (await submitVerifiedIosBuildWithRunner(input, complianceGroup.run)).status,
    'action-required',
  );
  const failed = mock({ processingState: 'FAILED' });
  assert.equal((await submitVerifiedIosBuildWithRunner(input, failed.run)).status, 'failed');
  const existing = mock({ existingBuild: true });
  assert.equal((await submitVerifiedIosBuildWithRunner(input, existing.run)).status, 'unknown');
  assert.equal(
    existing.state.commands.some((command) => command.startsWith('builds upload ')),
    false,
  );

  const pendingUpload = mock({ uploadVisible: true });
  const pending = await submitVerifiedIosBuildWithRunner(input, pendingUpload.run);
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.uploadId, 'upload-1');
  assert.equal(
    pendingUpload.state.commands.some((command) => command.startsWith('builds upload ')),
    false,
  );

  const resumed = mock({ existingBuild: true, uploadVisible: true });
  const resume = await submitVerifiedIosBuildWithRunner(
    { ...input, resumeUploadId: 'upload-1', resumeArtifactSha256: digest },
    resumed.run,
  );
  assert.equal(resume.status, 'processing');
  assert.equal(
    resumed.state.commands.some((command) => command.startsWith('builds upload ')),
    false,
  );
  const buildOnly = mock({ existingBuild: true, processingState: 'VALID' });
  const buildOnlyResult = await submitVerifiedIosBuildWithRunner(
    { ...input, resumeBuildId: 'build-1' },
    buildOnly.run,
  );
  assert.equal(buildOnlyResult.status, 'testflight-ready');
  assert.equal(buildOnlyResult.uploadId, undefined);
  assert.equal(
    buildOnly.state.commands.some((command) => command.startsWith('builds upload ')),
    false,
  );
  const wrongBuild = mock({ existingBuild: true });
  assert.equal((await submitVerifiedIosBuildWithRunner(
    { ...input, resumeBuildId: 'another-build' }, wrongBuild.run,
  )).status, 'unknown');
  const missingUpload = mock({ uploadVisible: false });
  assert.equal((await submitVerifiedIosBuildWithRunner({ ...input, resumeUploadId: 'upload-1',
    resumeArtifactSha256: digest },
    missingUpload.run)).status, 'unknown');
  await assert.rejects(
    submitVerifiedIosBuildWithRunner(
      { ...input, resumeUploadId: 'upload-1', resumeArtifactSha256: '0'.repeat(64) },
      mock().run,
    ),
    /matching verified iOS IPA/u,
  );

  const lost = mock({ throwUpload: true, uploadCommittedOnError: true });
  assert.equal((await submitVerifiedIosBuildWithRunner(input, lost.run)).status, 'unknown');
  const lostRetry = await submitVerifiedIosBuildWithRunner(input, lost.run);
  assert.equal(lostRetry.status, 'unknown');
  assert.equal(lostRetry.uploadId, 'upload-1');
  assert.equal(
    lost.state.commands.filter((command) => command.startsWith('builds upload ')).length,
    1,
  );
  const timedOut = mock({ uploadFailureReason: 'timeout' });
  assert.match(
    (await submitVerifiedIosBuildWithRunner(input, timedOut.run)).detail ?? '',
    /\(timeout\)/u,
  );
  const aborted = mock({ uploadFailureReason: 'abort' });
  assert.match(
    (await submitVerifiedIosBuildWithRunner(input, aborted.run)).detail ?? '',
    /\(abort\)/u,
  );
  const malformed = mock({ malformedUpload: true });
  assert.equal((await submitVerifiedIosBuildWithRunner(input, malformed.run)).status, 'unknown');
  await assert.rejects(
    submitVerifiedIosBuildWithRunner(
      {
        ...input,
        onUploadCommitted: async () => {
          throw new Error('checkpoint failed');
        },
      },
      mock().run,
    ),
    IosSubmissionUncertainError,
  );
  await assert.rejects(
    submitVerifiedIosBuildWithRunner({ ...input, bundleId: 'wrong.bundle' }, mock().run),
    /matching verified iOS IPA/u,
  );
  await assert.rejects(
    submitVerifiedIosBuildWithRunner({ ...input, internalGroupId: '--output' }, mock().run),
    /matching verified iOS IPA/u,
  );
  await assert.rejects(
    submitVerifiedIosBuildWithRunner(
      {
        ...input,
        record: { ...input.record, platformVersion: { marketingVersion: '--help', buildNumber } },
      },
      mock().run,
    ),
    /matching verified iOS IPA/u,
  );
  await assert.rejects(
    submitVerifiedIosBuildWithRunner(input, mock({ appBundleId: 'wrong.bundle' }).run),
    /does not match/u,
  );
  await assert.rejects(
    submitVerifiedIosBuildWithRunner(
      { ...input, record: { ...input.record, artifactSha256: '0'.repeat(64) } },
      mock().run,
    ),
    /IPA bytes differ/u,
  );
  await assert.rejects(
    verifyPinnedAscBinary(
      ipa,
      fileURLToPath(new URL('../../../tools/deploy/asc-pin.json', import.meta.url)),
    ),
    /checksum differs/u,
  );
  console.info('TestFlight submission mock smoke passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

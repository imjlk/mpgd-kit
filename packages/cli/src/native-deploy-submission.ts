import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { NativeDeploymentPlan } from './deploy-planning.js';
import {
  checkpointNativeSubmission,
  freshSubmissionLeaseExpiresAt,
  isNativeSubmissionSettled,
  readNativeReleaseStatus,
  reclaimNativeSubmission,
  releaseNativeSubmissionLease,
  type ImmutableNativeBuildRecord,
  type NativeSubmissionCheckpoint,
} from './release-state.js';
import {
  planVerifiedAndroidBundleSubmission,
  PlaySubmissionUncertainError,
  submitVerifiedAndroidBundle,
  type PlayInternalSubmissionResult,
  type PlaySubmissionPlan,
} from './play-internal-submission.js';
import {
  assertPlayReleaseConfirmed,
  assertPlayReleaseRequest,
  defaultPlayReleaseRequest,
  defaultPlayTrack,
  playReleaseRequestDigest,
  type PlayReleaseRequest,
} from './play-release-options.js';
import {
  IosSubmissionUncertainError,
  submitVerifiedIosBuild,
  type IosTestFlightSubmissionResult,
} from './testflight-submission.js';

export type NativeStoreCredential = {
  readonly target: 'android';
  readonly serviceAccountFile: string;
} | {
  readonly target: 'ios';
  readonly ascBinary: string;
  readonly appStoreAppId: string;
  readonly apiKeyId: string;
  readonly apiIssuerId: string;
  readonly apiPrivateKeyBase64: string;
};

export interface SubmitRecordedNativeTargetInput {
  readonly plan: NativeDeploymentPlan;
  readonly gameId: string;
  readonly releaseKey: string;
  readonly credential: NativeStoreCredential;
  readonly approved: boolean;
  /** Google Play track, status, rollout, notes and mapping; defaults to internal/completed. */
  readonly androidRelease?: PlayReleaseRequest;
  /** Confirms a production release or staged rollout (`--confirm-production`). */
  readonly confirmProduction?: boolean;
  /** Called when Play accepts only a draft because the app was never published. */
  readonly onDraftAppFallback?: (track: string) => void;
  /** Allows the same caller to continue an in-process attempt without taking over its lease. */
  readonly attemptId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Credential-free injection boundary for recovery tests. */
export interface NativeSubmissionPorts {
  readonly readStatus: typeof readNativeReleaseStatus;
  readonly checkpoint: typeof checkpointNativeSubmission;
  readonly reclaim: typeof reclaimNativeSubmission;
  readonly releaseLease: typeof releaseNativeSubmissionLease;
  readonly submitAndroid: typeof submitVerifiedAndroidBundle;
  readonly submitIos: typeof submitVerifiedIosBuild;
}

const productionPorts: NativeSubmissionPorts = {
  readStatus: readNativeReleaseStatus,
  checkpoint: checkpointNativeSubmission,
  reclaim: reclaimNativeSubmission,
  releaseLease: releaseNativeSubmissionLease,
  submitAndroid: submitVerifiedAndroidBundle,
  submitIos: submitVerifiedIosBuild,
};

/**
 * `--approve`, or the profile's `preapproved-internal-test`. That preapproval
 * covers only the internal track: any other Google Play track needs `--approve`.
 */
export function isNativeDeployApproved(
  plan: Pick<NativeDeploymentPlan, 'approval'>,
  approveFlag: boolean,
  androidRelease?: Pick<PlayReleaseRequest, 'track'>,
): boolean {
  const internalOnly = androidRelease === undefined || androidRelease.track === defaultPlayTrack;
  return approveFlag || (plan.approval === 'preapproved-internal-test' && internalOnly);
}

/**
 * A committed Android release is never re-sent, so a request with other
 * Google Play options must fail instead of being skipped as done.
 */
export function assertSettledAndroidReleaseOptions(
  checkpoint: NativeSubmissionCheckpoint | undefined,
  androidRelease: PlayReleaseRequest | undefined,
): void {
  if (checkpoint?.target === 'android' && isNativeSubmissionSettled(checkpoint.status)
    && checkpoint.playReleaseSha256
      !== playReleaseRequestDigest(androidRelease ?? defaultPlayReleaseRequest)) {
    throw new Error(
      'This release was already committed to Google Play with other release options; '
      + 'change it with "mpgd deploy rollout" or submit a new release.',
    );
  }
}

/**
 * The Google Play request with the R8 mapping recorded with the build: it is
 * used when no `--mapping-file` is given, and an explicit one must have the
 * same bytes. A build without a recorded mapping keeps the request as it is.
 */
export function withRecordedR8Mapping(
  request: PlayReleaseRequest | undefined,
  record: Pick<ImmutableNativeBuildRecord, 'r8Mapping'> | undefined,
  gameRoot: string,
): PlayReleaseRequest | undefined {
  const recorded = record?.r8Mapping;
  if (recorded === undefined) {
    return request;
  }
  if (request?.mappingSha256 !== undefined) {
    if (request.mappingSha256 !== recorded.sha256) {
      throw new Error(
        `--mapping-file differs from the R8 mapping recorded with this build (${recorded.location}, `
          + `sha256 ${recorded.sha256}); omit it to use the recorded mapping.`,
      );
    }
    return request;
  }
  // A missing file is reported when the submission hashes it; an existing one
  // must not resolve outside the game through a symlink.
  const candidate = path.resolve(gameRoot, recorded.location);
  const mappingFile = existsSync(candidate)
    ? resolveRecordedArtifact(gameRoot, recorded.location)
    : candidate;
  return {
    ...(request ?? defaultPlayReleaseRequest),
    mappingFile,
    mappingSha256: recorded.sha256,
  };
}

/** Resume exactly one verified build; never rebuild or allocate another version here. */
export async function submitRecordedNativeTarget(
  input: SubmitRecordedNativeTargetInput,
): Promise<NativeSubmissionCheckpoint> {
  return submitRecordedNativeTargetWithPorts(input, productionPorts);
}

/** Verify one recorded Android build and print its Play edit without any store call. */
export async function planRecordedAndroidSubmission(
  input: Omit<SubmitRecordedNativeTargetInput, 'credential' | 'approved'>,
  readStatus: typeof readNativeReleaseStatus = readNativeReleaseStatus,
): Promise<PlaySubmissionPlan> {
  const recorded = await readRecordedSubmission(input, 'android', readStatus);
  if (input.environment?.MPGD_VERIFY_RELEASE_MANIFEST === '1') {
    verifyRecordedReleaseManifest(input.plan.gameRoot, recorded.record);
  }
  const release = withRecordedR8Mapping(input.androidRelease, recorded.record, input.plan.gameRoot);
  return planVerifiedAndroidBundleSubmission({
    record: recorded.record,
    aabFile: recorded.artifactFile,
    packageName: recorded.planned.appId,
    ...(release === undefined ? {} : { release }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function readRecordedSubmission(
  input: Omit<SubmitRecordedNativeTargetInput, 'credential' | 'approved'>,
  target: 'android' | 'ios',
  readStatus: typeof readNativeReleaseStatus,
): Promise<{
  readonly planned: NativeDeploymentPlan['targets'][number];
  readonly record: ImmutableNativeBuildRecord;
  readonly artifactFile: string;
  readonly status: Awaited<ReturnType<typeof readNativeReleaseStatus>>;
}> {
  const planned = input.plan.targets.find((entry) => entry.target === target);
  if (planned === undefined) {
    throw new Error('Native store submission requires a planned target and explicit approval.');
  }
  const status = await readStatus({
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    releaseKey: input.releaseKey,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (status.plan.targetConfigDigest !== input.plan.targetConfigSha256
    || status.plan.gameId !== input.gameId
    || status.plan.targets[target] === undefined) {
    throw new Error('Store submission plan differs from the reserved release.');
  }
  const record = status.builds[target];
  if (record === undefined || record.releaseKey !== input.releaseKey
    || record.target !== target || record.inspectedAppId !== planned.appId
    || record.deployConfigSha256 !== input.plan.deployConfigSha256
    || record.deploymentProfile !== input.plan.profile
    || record.deploymentDestination !== planned.destination
    || record.internalTestGroupId !== planned.testGroup) {
    throw new Error('Store submission requires a matching immutable native build record.');
  }
  const artifactFile = resolveRecordedArtifact(input.plan.gameRoot, record.artifactLocation);
  return { planned, record, artifactFile, status };
}

export async function submitRecordedNativeTargetWithPorts(
  input: SubmitRecordedNativeTargetInput,
  ports: NativeSubmissionPorts,
): Promise<NativeSubmissionCheckpoint> {
  const target = input.credential.target;
  const planned = input.plan.targets.find((entry) => entry.target === target);
  if (planned === undefined || !input.approved) {
    throw new Error('Native store submission requires a planned target and explicit approval.');
  }
  if (target === 'android') {
    // Refuse an invalid or unconfirmed production/staged request before the
    // release state is read or a checkpoint is written.
    const requested = input.androidRelease ?? defaultPlayReleaseRequest;
    assertPlayReleaseRequest(requested);
    assertPlayReleaseConfirmed(requested, input.confirmProduction === true);
  }
  const stateInput = {
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const { record, artifactFile, status } = await readRecordedSubmission(
    input,
    target,
    ports.readStatus,
  );
  // The build's recorded R8 mapping goes with it, the same way --mapping-file does.
  const effectiveAndroidRelease = target === 'android'
    ? withRecordedR8Mapping(input.androidRelease, record, input.plan.gameRoot)
    : undefined;
  const androidRelease = effectiveAndroidRelease ?? defaultPlayReleaseRequest;
  const releaseDigest = target === 'android' ? playReleaseRequestDigest(androidRelease) : undefined;
  let checkpoint = status.submissions[target];
  assertSettledAndroidReleaseOptions(checkpoint, androidRelease);
  // An attempt that never checkpointed a Play edit changed nothing remotely,
  // so its release options may still be corrected.
  const optionsReplaceable = checkpoint?.status === 'started'
    && checkpoint.remoteEditId === undefined && checkpoint.remoteUploadId === undefined
    && checkpoint.remoteBuildId === undefined;
  if (checkpoint !== undefined && checkpoint.playReleaseSha256 !== releaseDigest
    && !optionsReplaceable) {
    throw new Error(
      'This submission was started with other Google Play release options (track, status, '
      + 'fraction, notes or mapping); re-run it with the same options before changing them.',
    );
  }
  if (checkpoint !== undefined && isNativeSubmissionSettled(checkpoint.status)) {
    return checkpoint;
  }
  if (record.r8Mapping !== undefined && effectiveAndroidRelease?.mappingFile !== undefined
    && !existsSync(effectiveAndroidRelease.mappingFile)) {
    throw new Error(
      `The R8 mapping recorded with this build is missing: ${record.r8Mapping.location}. Restore `
        + 'the release bundle (.mpgd/releases/<release>) next to the bundle, or pass the same file '
        + 'with --mapping-file.',
    );
  }
  if (input.environment?.MPGD_VERIFY_RELEASE_MANIFEST === '1') {
    verifyRecordedReleaseManifest(input.plan.gameRoot, record);
  }
  if (checkpoint?.status === 'failed'
    || (checkpoint?.status === 'action-required'
      && checkpoint.remoteUploadId === undefined && checkpoint.remoteBuildId === undefined)
    || (checkpoint?.status === 'unknown'
      && checkpoint.remoteEditId === undefined && checkpoint.remoteUploadId === undefined
      && checkpoint.remoteBuildId === undefined)) {
    throw new Error('Submission requires operator reconciliation before another store call.');
  }
  if (checkpoint === undefined) {
    checkpoint = (await ports.checkpoint({
      ...stateInput,
      checkpoint: {
        releaseKey: input.releaseKey,
        target,
        buildRunId: record.buildRunId,
        artifactSha256: record.artifactSha256,
        attemptId: randomBytes(16).toString('hex'),
        leaseExpiresAt: freshSubmissionLeaseExpiresAt(),
        status: 'started',
        ...(releaseDigest === undefined ? {} : { playReleaseSha256: releaseDigest }),
      },
    })).checkpoint;
  } else if (Date.parse(checkpoint.leaseExpiresAt) <= Date.now()) {
    checkpoint = (await ports.reclaim({
      ...stateInput,
      releaseKey: input.releaseKey,
      target,
      expectedStateCommit: status.stateCommit,
      attemptId: randomBytes(16).toString('hex'),
    })).checkpoint;
  } else if (input.attemptId !== checkpoint.attemptId) {
    throw new Error('Another submission attempt owns the active release lease.');
  }
  if (checkpoint.buildRunId !== record.buildRunId
    || checkpoint.artifactSha256 !== record.artifactSha256) {
    throw new Error('Submission checkpoint no longer matches its immutable build.');
  }
  let activeCheckpoint: NativeSubmissionCheckpoint = checkpoint;
  if (activeCheckpoint.playReleaseSha256 !== releaseDigest) {
    const { playReleaseSha256: _replaced, ...withoutDigest } = activeCheckpoint;
    activeCheckpoint = (await ports.checkpoint({
      ...stateInput,
      checkpoint: {
        ...withoutDigest,
        ...(releaseDigest === undefined ? {} : { playReleaseSha256: releaseDigest }),
        leaseExpiresAt: freshSubmissionLeaseExpiresAt(),
      },
    })).checkpoint;
  }
  const save = async (patch: Partial<NativeSubmissionCheckpoint>): Promise<void> => {
    activeCheckpoint = (await ports.checkpoint({
      ...stateInput,
      checkpoint: {
        ...activeCheckpoint,
        ...patch,
        leaseExpiresAt: freshSubmissionLeaseExpiresAt(),
      },
    })).checkpoint;
  };
  const releaseLease = async (): Promise<void> => {
    activeCheckpoint = await ports.releaseLease({
      ...stateInput,
      releaseKey: input.releaseKey,
      target,
      attemptId: activeCheckpoint.attemptId,
    });
  };

  if (input.credential.target === 'android') {
    let result: PlayInternalSubmissionResult;
    try {
      result = await ports.submitAndroid({
        record,
        aabFile: artifactFile,
        packageName: planned.appId,
        serviceAccountFile: input.credential.serviceAccountFile,
        ...(activeCheckpoint.remoteEditId === undefined ? {} : {
          resumeEditId: activeCheckpoint.remoteEditId,
        }),
        onEditCreated: async (editId) => {
          await save({ status: 'edit-open', remoteEditId: editId });
        },
        ...(effectiveAndroidRelease === undefined ? {} : { release: effectiveAndroidRelease }),
        ...(input.confirmProduction === undefined ? {} : {
          confirmProduction: input.confirmProduction,
        }),
        ...(input.onDraftAppFallback === undefined ? {} : {
          onDraftAppFallback: input.onDraftAppFallback,
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      try {
        if (error instanceof PlaySubmissionUncertainError) {
          if (error.stage === 'checkpoint'
            && activeCheckpoint.remoteEditId !== undefined
            && activeCheckpoint.remoteEditId !== error.editId) {
            await save({ status: 'edit-open', remoteEditId: error.editId });
          }
          await save({ status: 'unknown', remoteEditId: error.editId });
        } else {
          await save({
            status: activeCheckpoint.remoteEditId === undefined ? 'started' : 'unknown',
          });
        }
        await releaseLease();
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          `Google Play submission failed and its checkpoint could not be persisted${
            error instanceof PlaySubmissionUncertainError ? ` for edit ${error.editId}` : ''
          }.`,
        );
      }
      throw error;
    }
    await save({ status: 'committed', remoteEditId: result.editId });
  } else {
    if (planned.testGroup === undefined) {
      throw new Error('TestFlight submission requires an internal group ID.');
    }
    let result: IosTestFlightSubmissionResult;
    try {
      result = await ports.submitIos({
        record,
        ipaFile: artifactFile,
        bundleId: planned.appId,
        appStoreAppId: input.credential.appStoreAppId,
        internalGroupId: planned.testGroup,
        ascBinary: input.credential.ascBinary,
        apiKeyId: input.credential.apiKeyId,
        apiIssuerId: input.credential.apiIssuerId,
        apiPrivateKeyBase64: input.credential.apiPrivateKeyBase64,
        ...(activeCheckpoint.remoteUploadId === undefined ? {} : {
          resumeUploadId: activeCheckpoint.remoteUploadId,
          resumeArtifactSha256: activeCheckpoint.artifactSha256,
        }),
        ...(activeCheckpoint.remoteBuildId === undefined ? {} : {
          resumeBuildId: activeCheckpoint.remoteBuildId,
        }),
        onUploadCommitted: async (uploadId) => {
          await save({ status: 'upload-committed', remoteUploadId: uploadId });
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      try {
        if (error instanceof IosSubmissionUncertainError) {
          await save({ status: 'unknown', remoteUploadId: error.uploadId });
        } else {
          await save({
            status: activeCheckpoint.remoteUploadId === undefined
              && activeCheckpoint.remoteBuildId === undefined ? 'started' : 'unknown',
          });
        }
        await releaseLease();
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          `TestFlight submission failed and its checkpoint could not be persisted${
            error instanceof IosSubmissionUncertainError ? ` for upload ${error.uploadId}` : ''
          }.`,
        );
      }
      throw error;
    }
    await save({
      status: result.status,
      ...(result.uploadId === undefined ? {} : { remoteUploadId: result.uploadId }),
      ...(result.buildId === undefined ? {} : { remoteBuildId: result.buildId }),
    });
    if (activeCheckpoint.status !== 'testflight-ready') {
      await releaseLease();
    }
  }
  return activeCheckpoint;
}

/** Validate the workflow-restored manifest against the immutable release-state hash. */
export function verifyRecordedReleaseManifest(
  gameRoot: string,
  record: Pick<ImmutableNativeBuildRecord,
    'artifactLocation' | 'releaseManifestSha256' | 'target'>,
): void {
  if (!/^[0-9a-f]{64}$/u.test(record.releaseManifestSha256)) {
    throw new Error('Recorded release manifest hash is invalid.');
  }
  const location = path.posix.join(
    path.posix.dirname(record.artifactLocation),
    `${record.target}-manifest-${record.releaseManifestSha256}.json`,
  );
  let manifestFile: string;
  try {
    manifestFile = resolveRecordedArtifact(gameRoot, location);
  } catch {
    throw new Error('Recorded release manifest is missing or outside the game directory.');
  }
  const metadata = statSync(manifestFile);
  if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) {
    throw new Error('Recorded release manifest is not a bounded file.');
  }
  const digest = createHash('sha256').update(readFileSync(manifestFile)).digest('hex');
  if (digest !== record.releaseManifestSha256) {
    throw new Error('Restored release manifest differs from the immutable build record.');
  }
}

function resolveRecordedArtifact(gameRoot: string, recordedLocation: string): string {
  if (path.isAbsolute(recordedLocation)) {
    throw new Error('Native artifact location must be game-relative.');
  }
  const root = realpathSync(gameRoot);
  const artifact = realpathSync(path.resolve(root, recordedLocation));
  const relative = path.relative(root, artifact);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('Native artifact location escapes the game directory.');
  }
  return artifact;
}

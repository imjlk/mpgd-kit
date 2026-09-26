import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { NativeDeploymentPlan } from './deploy-planning.js';
import {
  checkpointNativeSubmission,
  freshSubmissionLeaseExpiresAt,
  isNativeSubmissionSettled,
  readNativeReleaseStatus,
  reclaimNativeSubmission,
  releaseNativeSubmissionLease,
  type NativeSubmissionCheckpoint,
} from './release-state.js';
import {
  PlaySubmissionUncertainError,
  submitVerifiedAndroidBundle,
  type PlayInternalSubmissionResult,
} from './play-internal-submission.js';
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

/** Resume exactly one verified build; never rebuild or allocate another version here. */
export async function submitRecordedNativeTarget(
  input: SubmitRecordedNativeTargetInput,
): Promise<NativeSubmissionCheckpoint> {
  return submitRecordedNativeTargetWithPorts(input, productionPorts);
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
  const stateInput = {
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const status = await ports.readStatus({ ...stateInput, releaseKey: input.releaseKey });
  if (status.plan.targetConfigDigest !== input.plan.targetConfigSha256
    || status.plan.gameId !== input.gameId
    || status.plan.targets[target] === undefined) {
    throw new Error('Store submission plan differs from the reserved release.');
  }
  const record = status.builds[target];
  if (record === undefined || record.releaseKey !== input.releaseKey
    || record.target !== target || record.inspectedAppId !== planned.appId) {
    throw new Error('Store submission requires a matching immutable native build record.');
  }
  const artifactFile = resolveRecordedArtifact(input.plan.gameRoot, record.artifactLocation);
  let checkpoint = status.submissions[target];
  if (checkpoint !== undefined && isNativeSubmissionSettled(checkpoint.status)) {
    return checkpoint;
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
  const save = async (patch: Partial<NativeSubmissionCheckpoint>): Promise<void> => {
    activeCheckpoint = (await ports.checkpoint({
      ...stateInput,
      checkpoint: { ...activeCheckpoint, ...patch },
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
            status: activeCheckpoint.remoteEditId === undefined ? 'failed' : 'unknown',
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

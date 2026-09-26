import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  allocatePlatformVersions,
  assertPlatformVersionLedger,
  createMpgdReleaseIdentity,
  formatMpgdReleaseId,
  type MpgdReleaseIdentity,
  type PlatformVersionLedger,
  type PlatformVersionReleasePlan,
  type PlatformVersionTargetRequest,
} from '@mpgd/target-config';

import { runReleaseProcess, type ReleaseProcessInput } from './deploy-process.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';

// Build-time mirror of the private @mpgd/release-manifest schema. The packaged CLI
// must not import that workspace-only package; fixture tests cross-check both.
interface ReleaseManifest {
  readonly releaseId: string;
  readonly gitSha: string;
  readonly kitGitSha: string;
  readonly gameVersion: string;
  readonly releaseIdentity?: MpgdReleaseIdentity;
  readonly buildId: string;
  readonly targetConfigVersion: string;
  readonly catalogVersion: string;
  readonly adPlacementVersion: string;
  readonly targets: Record<string, {
    readonly artifact: string;
    readonly profile?: string;
    readonly effectiveConfig: { readonly path: string; readonly version: string; readonly digest: string };
    readonly iconManifest: {
      readonly path: string;
      readonly digest: string;
      readonly sourceSha256: string;
      readonly sharedConfigSha256: string;
      readonly renderConfigSha256: string;
      readonly generatorVersion: string;
      readonly targetProfile: string;
      readonly targetProfileVersion: string;
    };
    readonly versionName?: string;
    readonly versionCode?: number;
    readonly marketingVersion?: string;
    readonly buildNumber?: string;
    readonly nativeDelivery?: {
      readonly platform: 'android' | 'ios';
      readonly mode: 'sync' | 'debug' | 'simulator' | 'unsigned-archive'
        | 'signed-archive' | 'store-export';
      readonly signed: boolean;
      readonly submissionCandidate: boolean;
    };
    readonly appName?: string;
    readonly sdkMajor?: number;
  }>;
}

export interface NativeReleaseReservationInput {
  readonly gameRoot: string;
  readonly releaseKey: string;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly targetConfigDigest: string;
  readonly targets: readonly PlatformVersionTargetRequest[];
  /** Required only when a game has no existing release-state ledger. */
  readonly initialLedger?: PlatformVersionLedger | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface NativeReleaseReservation {
  readonly plan: PlatformVersionReleasePlan;
  readonly stateCommit: string;
  readonly reused: boolean;
}

export interface ImmutableNativeBuildRecord {
  readonly releaseKey: string;
  readonly target: 'android' | 'ios';
  readonly buildRunId: string;
  readonly gameVersion: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly kitPackageVersion: string;
  readonly buildConfigDigest: string;
  readonly targetConfigDigest: string;
  readonly platformVersion: Readonly<Record<string, unknown>>;
  readonly artifactLocation: string;
  readonly artifactSha256: string;
  readonly releaseManifestSha256: string;
  readonly inspectedAppId: string;
  readonly inspectedSignerSha256?: string | undefined;
  readonly inspectedTeamId?: string | undefined;
}

export type NativeSubmissionStatus = 'started' | 'edit-open' | 'upload-committed'
  | 'uploaded' | 'processing' | 'testflight-ready' | 'action-required'
  | 'failed' | 'unknown' | 'committed';

export interface NativeSubmissionCheckpoint {
  readonly releaseKey: string;
  readonly target: 'android' | 'ios';
  readonly buildRunId: string;
  readonly artifactSha256: string;
  readonly attemptId: string;
  readonly leaseExpiresAt: string;
  readonly status: NativeSubmissionStatus;
  readonly remoteEditId?: string;
  readonly remoteUploadId?: string;
  readonly remoteBuildId?: string;
}

export interface NativeReleaseStatus {
  readonly plan: PlatformVersionReleasePlan;
  readonly builds: Partial<Record<'android' | 'ios', ImmutableNativeBuildRecord>>;
  readonly submissions: Partial<Record<'android' | 'ios', NativeSubmissionCheckpoint>>;
  readonly stateCommit: string;
}

export interface RecordNativeBuildInput {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly releaseKey: string;
  readonly target: 'android' | 'ios';
  readonly buildRunId: string;
  readonly kitPackageVersion: string;
  readonly buildConfigDigest: string;
  readonly artifactFile: string;
  readonly expectedArtifactSha256: string;
  readonly artifactLocation: string;
  readonly releaseManifestFile: string;
  readonly expectedReleaseManifestSha256: string;
  readonly inspectedAppId: string;
  readonly inspectedSignerSha256?: string | undefined;
  readonly inspectedTeamId?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

interface GameReleaseState {
  readonly initialLedger: PlatformVersionLedger;
  readonly ledger: PlatformVersionLedger;
  readonly reservations: Record<string, PlatformVersionReleasePlan>;
  readonly builds: Record<string, ImmutableNativeBuildRecord>;
  readonly submissions?: Record<string, NativeSubmissionCheckpoint>;
}

interface ReleaseState {
  readonly schemaVersion: 1;
  readonly games: Record<string, GameReleaseState>;
}

interface StateSession {
  readonly directory: string;
  readonly previousCommit: string | undefined;
  readonly remoteUrl: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal | undefined;
  readonly state: ReleaseState;
}

const stateBranch = 'release-state';
const stateFileName = 'mpgd-release-state.json';
const releaseKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const androidFingerprintPattern = /^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/u;
const teamIdPattern = /^[A-Z0-9]{10}$/u;
const remoteIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const attemptIdPattern = /^[0-9a-f]{32}$/u;
const submissionLeaseMs = 20 * 60_000;

function normalizeAndroidFingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase();
}

/** Match the private manifest package's complete schema without a runtime workspace dependency. */
function assertCompleteReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || !isRecord(value.targets)) {
    throw new Error('Native release manifest must include target records.');
  }
  assertStringFields(
    value,
    [
      'releaseId',
      'gitSha',
      'kitGitSha',
      'gameVersion',
      'buildId',
      'targetConfigVersion',
      'catalogVersion',
      'adPlacementVersion',
    ],
    'release manifest',
  );
  if (value.releaseIdentity !== undefined) {
    if (!isRecord(value.releaseIdentity)) {
      throw new Error('Native release manifest identity is malformed.');
    }
    assertStringFields(value.releaseIdentity, ['gameVersion', 'label'], 'release identity');
    if (value.releaseIdentity.releaseRevision !== undefined
      && typeof value.releaseIdentity.releaseRevision !== 'number') {
      throw new Error('Native release manifest revision is malformed.');
    }
  }
  for (const [name, rawEntry] of Object.entries(value.targets)) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.effectiveConfig)
      || !isRecord(rawEntry.iconManifest)) {
      throw new Error(`Native release manifest target ${name} is malformed.`);
    }
    assertStringFields(rawEntry, ['artifact'], `target ${name}`);
    assertStringFields(
      rawEntry.effectiveConfig,
      ['path', 'version', 'digest'],
      `effective config ${name}`,
    );
    assertStringFields(
      rawEntry.iconManifest,
      [
        'path',
        'digest',
        'sourceSha256',
        'sharedConfigSha256',
        'renderConfigSha256',
        'generatorVersion',
        'targetProfile',
        'targetProfileVersion',
      ],
      `icon manifest ${name}`,
    );
    for (const field of ['profile', 'versionName', 'marketingVersion', 'buildNumber', 'appName']) {
      if (rawEntry[field] !== undefined && typeof rawEntry[field] !== 'string') {
        throw new Error(`Native release manifest target ${name}.${field} is malformed.`);
      }
    }
    for (const field of ['versionCode', 'sdkMajor']) {
      if (rawEntry[field] !== undefined && typeof rawEntry[field] !== 'number') {
        throw new Error(`Native release manifest target ${name}.${field} is malformed.`);
      }
    }
    if (rawEntry.nativeDelivery !== undefined) {
      if (!isRecord(rawEntry.nativeDelivery)
        || !['android', 'ios'].includes(String(rawEntry.nativeDelivery.platform))
        || !['sync', 'debug', 'simulator', 'unsigned-archive', 'signed-archive', 'store-export']
          .includes(String(rawEntry.nativeDelivery.mode))
        || typeof rawEntry.nativeDelivery.signed !== 'boolean'
        || typeof rawEntry.nativeDelivery.submissionCandidate !== 'boolean') {
        throw new Error(`Native release manifest target ${name} delivery is malformed.`);
      }
    }
  }
  const manifest = value as unknown as ReleaseManifest;
  if (!gitShaPattern.test(manifest.kitGitSha)) {
    throw new Error('Native release manifest Kit revision is invalid.');
  }
  for (const [target, entry] of Object.entries(manifest.targets)) {
    const delivery = entry.nativeDelivery;
    if (delivery === undefined) {
      continue;
    }
    const expectedSigned = delivery.mode === 'signed-archive' || delivery.mode === 'store-export';
    const validMode = delivery.platform === 'android'
      ? ['debug', 'unsigned-archive', 'signed-archive'].includes(delivery.mode)
      : ['sync', 'simulator', 'unsigned-archive', 'signed-archive', 'store-export']
        .includes(delivery.mode);
    const expectedCandidate = entry.profile === 'production' && (delivery.platform === 'android'
      ? delivery.mode === 'signed-archive' : delivery.mode === 'store-export');
    if (!validMode || delivery.signed !== expectedSigned
      || delivery.submissionCandidate !== expectedCandidate
      || (entry.profile === 'production' && !delivery.signed)) {
      throw new Error(`Native release manifest delivery is invalid: ${target}.`);
    }
  }
  if (manifest.releaseIdentity !== undefined) {
    const identity = createMpgdReleaseIdentity({
      gameVersion: manifest.releaseIdentity.gameVersion,
      ...(manifest.releaseIdentity.releaseRevision === undefined
        ? {} : { releaseRevision: manifest.releaseIdentity.releaseRevision }),
      expectedLabel: manifest.releaseIdentity.label,
    });
    if (manifest.releaseIdentity.label !== identity.label
      || manifest.releaseIdentity.gameVersion !== identity.gameVersion
      || manifest.gameVersion !== identity.gameVersion
      || manifest.releaseId !== formatMpgdReleaseId(identity.label, manifest.buildId)) {
      throw new Error('Native release manifest identity is invalid.');
    }
  }
  return manifest;
}

function assertStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (typeof value[field] !== 'string') {
      throw new Error(`Native ${label} is missing ${field}.`);
    }
  }
}

/** Reserve version numbers by committing the ledger and plan atomically. */
export async function reserveNativeRelease(
  input: NativeReleaseReservationInput,
): Promise<NativeReleaseReservation> {
  assertReleaseKey(input.releaseKey);
  if (input.targets.length === 0
    || input.targets.some((request) => request.target !== 'android' && request.target !== 'ios')) {
    throw new Error('Native release reservations require Android or iOS targets.');
  }
  if (!gitShaPattern.test(input.sourceGitSha)) {
    throw new Error('Native release source revision must be a full Git SHA.');
  }
  const source = await runReleaseProcess({
    command: 'git',
    args: ['-C', input.gameRoot, 'cat-file', '-t', input.sourceGitSha],
    cwd: input.gameRoot,
    environment: isolatedGitEnvironment(input.environment ?? process.env),
    timeoutMs: 10_000,
    signal: input.signal,
    captureMachineStdout: true,
  });
  if (source.truncated || source.machineStdout?.trim() !== 'commit') {
    throw new Error('Native release source revision is not a game Git commit.');
  }
  return withStateSession(input, async (session) => {
    const game = ownValue(session.state.games, input.gameId);
    if (game === undefined && input.initialLedger === undefined) {
      throw new Error('First release requires an explicit initial platform version ledger.');
    }
    const ledger = game?.ledger ?? assertPlatformVersionLedger(input.initialLedger);
    const existingPlan = game === undefined
      ? undefined
      : ownValue(game.reservations, input.releaseKey);
    if (existingPlan !== undefined) {
      const requested = input.targets.map((item) => item.target).sort();
      const reserved = Object.keys(existingPlan.targets).sort();
      if (JSON.stringify(requested) !== JSON.stringify(reserved)) {
        throw new Error('An existing release reservation cannot change its target set.');
      }
    }
    const allocation = allocatePlatformVersions({
      gameId: input.gameId,
      gameVersion: input.gameVersion,
      sourceGitSha: input.sourceGitSha,
      kitGitSha: input.kitGitSha,
      targetConfigDigest: input.targetConfigDigest,
      targets: input.targets,
      ledger,
      ...(existingPlan === undefined ? {} : { existingPlan }),
    });
    if (existingPlan !== undefined) {
      if (session.previousCommit === undefined) {
        throw new Error('Existing reservation has no state commit.');
      }
      return { plan: existingPlan, stateCommit: session.previousCommit, reused: true };
    }
    const nextGame: GameReleaseState = {
      initialLedger: game?.initialLedger ?? ledger,
      ledger: allocation.ledger,
      reservations: { ...(game?.reservations ?? {}), [input.releaseKey]: allocation.plan },
      builds: game?.builds ?? {},
      ...(game?.submissions === undefined ? {} : { submissions: game.submissions }),
    };
    const next: ReleaseState = {
      schemaVersion: 1,
      games: { ...session.state.games, [input.gameId]: nextGame },
    };
    const stateCommit = await commitState(session, next, `Reserve ${input.gameId}/${input.releaseKey}`);
    return { plan: allocation.plan, stateCommit, reused: false };
  });
}

/** Attach one immutable, content-hashed native artifact to a reserved release. */
export async function recordNativeReleaseBuild(
  input: RecordNativeBuildInput,
): Promise<{ readonly record: ImmutableNativeBuildRecord; readonly stateCommit: string }> {
  assertReleaseKey(input.releaseKey);
  if (input.buildRunId.trim() === '' || input.artifactLocation.trim() === ''
    || input.kitPackageVersion.trim() === ''
    || input.inspectedAppId.trim() === ''
    || (input.target === 'android' && (input.inspectedTeamId !== undefined
      || !androidFingerprintPattern.test(input.inspectedSignerSha256 ?? '')))
    || (input.target === 'ios' && (input.inspectedSignerSha256 !== undefined
      || !teamIdPattern.test(input.inspectedTeamId ?? '')))
    || !sha256Pattern.test(input.buildConfigDigest)) {
    throw new Error('Native build record is missing a run ID, artifact location, or inspection.');
  }
  if (!existsSync(input.artifactFile) || !existsSync(input.releaseManifestFile)
    || !statSync(input.artifactFile).isFile()
    || !statSync(input.releaseManifestFile).isFile()) {
    throw new Error('Native build record requires file artifacts.');
  }
  const artifactSha256 = await sha256(input.artifactFile);
  const manifestBytes = readFileSync(input.releaseManifestFile);
  const releaseManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (artifactSha256 !== input.expectedArtifactSha256
    || releaseManifestSha256 !== input.expectedReleaseManifestSha256) {
    throw new Error('Copied native artifact or release manifest differs from the verified build.');
  }
  const signer = input.target === 'android'
    ? await inspectAndroidBundleSigner(input.artifactFile)
    : undefined;
  if (signer !== undefined
    && signer !== normalizeAndroidFingerprint(input.inspectedSignerSha256 ?? '')) {
    throw new Error('Recorded Android signer does not match the signed AAB bytes.');
  }
  return withStateSession(input, async (session) => {
    const game = ownValue(session.state.games, input.gameId);
    const plan = game === undefined ? undefined : ownValue(game.reservations, input.releaseKey);
    if (game === undefined || plan === undefined || plan.targets[input.target] === undefined) {
      throw new Error('Native build record has no matching reserved target.');
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('Native release manifest is not valid JSON.');
    }
    const validatedManifest = assertCompleteReleaseManifest(manifest);
    if (validatedManifest.gitSha !== plan.sourceGitSha
      || validatedManifest.kitGitSha !== plan.kitGitSha
      || validatedManifest.buildId !== plan.buildId
      || validatedManifest.gameVersion !== plan.gameVersion) {
      throw new Error('Native build manifest does not match its reserved provenance.');
    }
    const manifestRecord = validatedManifest as unknown as Record<string, unknown>;
    const releaseIdentity = manifestRecord.releaseIdentity;
    if (typeof releaseIdentity !== 'object' || releaseIdentity === null
      || Array.isArray(releaseIdentity)
      || (releaseIdentity as Record<string, unknown>).releaseRevision !== plan.releaseRevision
      || (releaseIdentity as Record<string, unknown>).label !== plan.releaseLabel) {
      throw new Error('Native build manifest release revision does not match its reservation.');
    }
    const manifestTargets = manifestRecord.targets;
    if (typeof manifestTargets !== 'object' || manifestTargets === null
      || Array.isArray(manifestTargets)) {
      throw new Error('Native build manifest is missing target evidence.');
    }
    const targetManifest = (manifestTargets as Record<string, unknown>)[input.target];
    const plannedTarget = plan.targets[input.target];
    if (typeof targetManifest !== 'object' || targetManifest === null
      || Array.isArray(targetManifest) || plannedTarget === undefined) {
      throw new Error('Native build manifest is missing its reserved target.');
    }
    const target = targetManifest as Record<string, unknown>;
    const delivery = target.nativeDelivery;
    if (typeof delivery !== 'object' || delivery === null || Array.isArray(delivery)
      || (delivery as Record<string, unknown>).platform !== input.target
      || (delivery as Record<string, unknown>).signed !== true
      || (delivery as Record<string, unknown>).submissionCandidate !== true
      || (delivery as Record<string, unknown>).mode !== (input.target === 'android'
        ? 'signed-archive' : 'store-export')
      || target.profile !== 'production'
      || (input.target === 'android' && target.versionCode !== plannedTarget.versionCode)
      || (input.target === 'android' && target.versionName !== plannedTarget.versionName)
      || (input.target === 'ios' && target.buildNumber !== String(plannedTarget.buildNumber))
      || (input.target === 'ios' && target.marketingVersion !== plannedTarget.marketingVersion)) {
      throw new Error('Native build manifest does not match reserved signed delivery.');
    }
    const record: ImmutableNativeBuildRecord = {
      releaseKey: input.releaseKey,
      target: input.target,
      buildRunId: input.buildRunId,
      gameVersion: plan.gameVersion,
      sourceGitSha: plan.sourceGitSha,
      kitGitSha: plan.kitGitSha,
      kitPackageVersion: input.kitPackageVersion,
      buildConfigDigest: input.buildConfigDigest,
      targetConfigDigest: plan.targetConfigDigest,
      platformVersion: plannedTarget,
      artifactLocation: input.artifactLocation,
      artifactSha256,
      releaseManifestSha256,
      inspectedAppId: input.inspectedAppId,
      ...(input.target === 'android'
        ? { inspectedSignerSha256: signer }
        : { inspectedTeamId: input.inspectedTeamId ?? '' }),
    };
    const key = `${input.releaseKey}/${input.target}`;
    const previous = ownValue(game.builds, key);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous, record)) {
        throw new Error('An immutable native build record cannot be replaced.');
      }
      if (session.previousCommit === undefined) {
        throw new Error('Existing build record has no state commit.');
      }
      return { record: previous, stateCommit: session.previousCommit };
    }
    const next: ReleaseState = {
      schemaVersion: 1,
      games: {
        ...session.state.games,
        [input.gameId]: { ...game, builds: { ...game.builds, [key]: record } },
      },
    };
    const stateCommit = await commitState(session, next, `Record ${input.gameId}/${key}`);
    return { record, stateCommit };
  });
}

/** Read one explicitly named release from the authoritative game-owned state branch. */
export async function readNativeReleaseStatus(input: {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly releaseKey: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<NativeReleaseStatus> {
  assertReleaseKey(input.releaseKey);
  return withStateSession(input, async (session) => {
    const game = ownValue(session.state.games, input.gameId);
    const plan = game === undefined ? undefined : ownValue(game.reservations, input.releaseKey);
    if (game === undefined || plan === undefined || session.previousCommit === undefined) {
      throw new Error('The requested native release has not been reserved.');
    }
    const androidKey = `${input.releaseKey}/android`;
    const iosKey = `${input.releaseKey}/ios`;
    return {
      plan,
      builds: {
        ...(game.builds[androidKey] === undefined ? {} : { android: game.builds[androidKey] }),
        ...(game.builds[iosKey] === undefined ? {} : { ios: game.builds[iosKey] }),
      },
      submissions: {
        ...(game.submissions?.[androidKey] === undefined
          ? {} : { android: game.submissions[androidKey] }),
        ...(game.submissions?.[iosKey] === undefined
          ? {} : { ios: game.submissions[iosKey] }),
      },
      stateCommit: session.previousCommit,
    };
  });
}

/** Persist a resumable store checkpoint with the build record in one Git state. */
export async function checkpointNativeSubmission(input: {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly checkpoint: NativeSubmissionCheckpoint;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<{ readonly checkpoint: NativeSubmissionCheckpoint; readonly stateCommit: string }> {
  assertSubmissionCheckpoint(input.checkpoint);
  return withStateSession(input, async (session) => {
    const game = ownValue(session.state.games, input.gameId);
    const key = `${input.checkpoint.releaseKey}/${input.checkpoint.target}`;
    const build = game === undefined ? undefined : ownValue(game.builds, key);
    if (game === undefined || build === undefined
      || build.buildRunId !== input.checkpoint.buildRunId
      || build.artifactSha256 !== input.checkpoint.artifactSha256) {
      throw new Error('Store checkpoint must reference the immutable native build record.');
    }
    const previous = ownValue(game.submissions ?? {}, key);
    if (previous !== undefined) {
      if (isDeepStrictEqual(previous, input.checkpoint)) {
        if (session.previousCommit === undefined) {
          throw new Error('Existing store checkpoint has no state commit.');
        }
        return { checkpoint: previous, stateCommit: session.previousCommit };
      }
      if (previous.attemptId !== input.checkpoint.attemptId) {
        throw new Error('Store submission has another active or unreconciled attempt owner.');
      }
      if (Date.parse(previous.leaseExpiresAt) <= Date.now()) {
        throw new Error('Store submission lease expired; reconcile remote state before takeover.');
      }
      if (previous.status === 'committed' || previous.status === 'testflight-ready'
        || previous.status === 'failed'
        || previous.remoteEditId !== undefined
          && previous.remoteEditId !== input.checkpoint.remoteEditId
        || previous.remoteUploadId !== undefined
          && previous.remoteUploadId !== input.checkpoint.remoteUploadId
        || previous.remoteBuildId !== undefined
          && previous.remoteBuildId !== input.checkpoint.remoteBuildId) {
        throw new Error('A completed submission or remote checkpoint ID cannot be replaced.');
      }
      if (!allowedSubmissionTransition(previous.status, input.checkpoint.status)) {
        throw new Error('Store submission status cannot move backward.');
      }
    } else if (input.checkpoint.status !== 'started') {
      throw new Error('A new store submission must checkpoint started before remote mutation.');
    }
    if (Date.parse(input.checkpoint.leaseExpiresAt) <= Date.now()
      || Date.parse(input.checkpoint.leaseExpiresAt) > Date.now() + submissionLeaseMs) {
      throw new Error('Store submission lease must be active and no longer than 20 minutes.');
    }
    const next: ReleaseState = {
      schemaVersion: 1,
      games: {
        ...session.state.games,
        [input.gameId]: {
          ...game,
          submissions: { ...(game.submissions ?? {}), [key]: input.checkpoint },
        },
      },
    };
    const stateCommit = await commitState(session, next, `Submit ${input.gameId}/${key}`);
    return { checkpoint: input.checkpoint, stateCommit };
  });
}

/** Claim an expired attempt without discarding its remote IDs or changing its status. */
export async function reclaimNativeSubmission(input: {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly releaseKey: string;
  readonly target: 'android' | 'ios';
  readonly expectedStateCommit: string;
  readonly attemptId: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<{ readonly checkpoint: NativeSubmissionCheckpoint; readonly stateCommit: string }> {
  assertReleaseKey(input.releaseKey);
  if (!gitShaPattern.test(input.expectedStateCommit)
    || !attemptIdPattern.test(input.attemptId)) {
    throw new Error('Submission reclaim needs an explicit state commit and new attempt ID.');
  }
  return withStateSession(input, async (session) => {
    if (session.previousCommit !== input.expectedStateCommit) {
      throw new Error('Submission state changed; read its latest remote checkpoint first.');
    }
    const game = ownValue(session.state.games, input.gameId);
    const key = `${input.releaseKey}/${input.target}`;
    const previous = game === undefined ? undefined : ownValue(game.submissions ?? {}, key);
    if (game === undefined || previous === undefined) {
      throw new Error('No store submission exists to reclaim.');
    }
    if (Date.parse(previous.leaseExpiresAt) > Date.now()) {
      throw new Error('Store submission lease is still active.');
    }
    if (previous.status === 'committed' || previous.status === 'testflight-ready'
      || previous.status === 'failed' || previous.status === 'action-required'
      || (previous.status === 'unknown'
        && previous.remoteEditId === undefined && previous.remoteUploadId === undefined)) {
      throw new Error('Store submission needs operator reconciliation before reclaim.');
    }
    const checkpoint = {
      ...previous,
      attemptId: input.attemptId,
      leaseExpiresAt: new Date(Date.now() + submissionLeaseMs).toISOString(),
    };
    const next: ReleaseState = {
      schemaVersion: 1,
      games: {
        ...session.state.games,
        [input.gameId]: {
          ...game,
          submissions: { ...(game.submissions ?? {}), [key]: checkpoint },
        },
      },
    };
    const stateCommit = await commitState(session, next, `Reclaim ${input.gameId}/${key}`);
    return { checkpoint, stateCommit };
  });
}

function allowedSubmissionTransition(
  from: NativeSubmissionStatus,
  to: NativeSubmissionStatus,
): boolean {
  if (from === to) {
    return true;
  }
  const allowed: Partial<Record<NativeSubmissionStatus, readonly NativeSubmissionStatus[]>> = {
    started: ['edit-open', 'upload-committed', 'unknown', 'failed', 'action-required'],
    'edit-open': ['committed', 'unknown', 'failed', 'action-required'],
    'upload-committed': [
      'uploaded',
      'processing',
      'testflight-ready',
      'unknown',
      'failed',
      'action-required',
    ],
    uploaded: ['processing', 'testflight-ready', 'unknown', 'failed', 'action-required'],
    processing: ['testflight-ready', 'unknown', 'failed', 'action-required'],
    unknown: [
      'uploaded',
      'processing',
      'testflight-ready',
      'committed',
      'failed',
      'action-required',
    ],
    'action-required': ['processing', 'testflight-ready', 'unknown'],
  };
  return allowed[from]?.includes(to) ?? false;
}

async function withStateSession<T>(
  input: { readonly gameRoot: string; readonly environment?: NodeJS.ProcessEnv; readonly signal?: AbortSignal },
  action: (session: StateSession) => Promise<T>,
): Promise<T> {
  const environment = isolatedGitEnvironment(input.environment ?? process.env);
  // Read the authoritative write destination, not a possibly stale fetch mirror.
  // Keep the URL in memory: the redacted runner must never modify embedded auth.
  let remoteUrl: string;
  let repositoryRoot: string;
  try {
    repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: input.gameRoot,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).trim();
    remoteUrl = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], {
      cwd: input.gameRoot,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).trim();
  } catch {
    throw new Error('Could not read the game repository origin remote.');
  }
  if (remoteUrl === '' || repositoryRoot === '') {
    throw new Error('Game repository origin remote is missing.');
  }
  remoteUrl = resolveRemoteUrl(repositoryRoot, remoteUrl);
  const directory = mkdtempSync(path.join(tmpdir(), 'mpgd-release-state-'));
  try {
    const session: StateSession = {
      directory,
      previousCommit: undefined,
      remoteUrl,
      environment,
      signal: input.signal,
      state: { schemaVersion: 1, games: {} },
    };
    await git(session, ['init', '--object-format=sha1', '-q', directory]);
    await git(session, ['remote', 'add', 'origin', remoteUrl]);
    const remoteHead = await git(session, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${stateBranch}`,
    ]);
    const previousCommit = remoteHead.output.trim().split(/\s+/u)[0];
    if (previousCommit !== undefined && gitShaPattern.test(previousCommit)) {
      await git(session, ['fetch', 'origin', `refs/heads/${stateBranch}`]);
      await git(session, ['checkout', '-q', '-B', stateBranch, 'FETCH_HEAD']);
      const fetchedCommit = (await git(session, ['rev-parse', 'HEAD'])).output.trim();
      if (!gitShaPattern.test(fetchedCommit)) {
        throw new Error('Fetched release-state revision is invalid.');
      }
      const statePath = path.join(directory, stateFileName);
      if (!existsSync(statePath)) {
        throw new Error('Existing release-state branch has no state file.');
      }
      return await action({
        ...session,
        previousCommit: fetchedCommit,
        state: parseReleaseState(readFileSync(statePath, 'utf8')),
      });
    }
    if (remoteHead.output.trim() !== '') {
      throw new Error('Release-state remote returned an invalid branch reference.');
    }
    await git(session, ['checkout', '-q', '--orphan', stateBranch]);
    return await action(session);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function resolveRemoteUrl(repositoryRoot: string, remoteUrl: string): string {
  if (!path.isAbsolute(remoteUrl)
    && !/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:[^/@:\s]+@)?[^/@:\s]+:)/iu.test(remoteUrl)) {
    return path.resolve(repositoryRoot, remoteUrl);
  }
  return remoteUrl;
}

async function commitState(session: StateSession, state: ReleaseState, subject: string): Promise<string> {
  const statePath = path.join(session.directory, stateFileName);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await git(session, ['add', '--', stateFileName]);
  await git(session, [
    '-c',
    'user.name=mpgd-release',
    '-c',
    'user.email=mpgd-release@example.invalid',
    'commit',
    '--no-gpg-sign',
    '-qm',
    subject,
  ]);
  const commit = (await git(session, ['rev-parse', 'HEAD'])).output.trim();
  if (!gitShaPattern.test(commit)) {
    throw new Error('Release-state commit is not a full Git SHA.');
  }
  const expected = session.previousCommit ?? '';
  try {
    await git(session, [
      'push',
      `--force-with-lease=refs/heads/${stateBranch}:${expected}`,
      'origin',
      `HEAD:refs/heads/${stateBranch}`,
    ]);
  } catch (error) {
    let remoteCommit: string | undefined;
    let verificationFailure: unknown;
    try {
      const remoteHead = await git(session, [
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${stateBranch}`,
      ]);
      remoteCommit = remoteHead.output.trim().split(/\s+/u)[0];
    } catch (verificationError) {
      verificationFailure = verificationError;
    }
    if (remoteCommit !== commit) {
      const cause = verificationFailure === undefined
        ? error
        : new AggregateError([error, verificationFailure], 'Push and verification both failed.');
      throw new Error(
        'Release-state update conflicted or has an uncertain result; retry with the same release key.',
        { cause },
      );
    }
  }
  return commit;
}

function parseReleaseState(json: string): ReleaseState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Release-state file on the remote branch is not valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Release state must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.games !== 'object'
    || record.games === null || Array.isArray(record.games)
    || Object.keys(record).some((key) => key !== 'schemaVersion' && key !== 'games')) {
    throw new Error('Release state has an unsupported schema.');
  }
  for (const [gameId, rawGame] of Object.entries(record.games)) {
    if (typeof rawGame !== 'object' || rawGame === null || Array.isArray(rawGame)) {
      throw new Error(`Release state game ${gameId} is malformed.`);
    }
    const game = rawGame as Record<string, unknown>;
    if (Object.keys(game).some((key) => ![
      'initialLedger', 'ledger', 'reservations', 'builds', 'submissions',
    ].includes(key))
      || typeof game.reservations !== 'object' || game.reservations === null
      || Array.isArray(game.reservations)
      || typeof game.builds !== 'object' || game.builds === null
      || Array.isArray(game.builds)
      || (game.submissions !== undefined && !isRecord(game.submissions))) {
      throw new Error(`Release state game ${gameId} has invalid entries.`);
    }
    const initialLedger = assertPlatformVersionLedger(game.initialLedger);
    const ledger = assertPlatformVersionLedger(game.ledger);
    const plans: PlatformVersionReleasePlan[] = [];
    for (const [releaseKey, rawPlan] of Object.entries(game.reservations)) {
      let targetNames: string[] = [];
      if (isRecord(rawPlan) && isRecord(rawPlan.targets)) {
        targetNames = Object.keys(rawPlan.targets);
      }
      if (!releaseKeyPattern.test(releaseKey) || !isRecord(rawPlan)
        || rawPlan.schemaVersion !== 2 || !isRecord(rawPlan.targets)
        || typeof rawPlan.gameId !== 'string' || rawPlan.gameId !== gameId
        || typeof rawPlan.gameVersion !== 'string'
        || !Number.isSafeInteger(rawPlan.releaseRevision)
        || Number(rawPlan.releaseRevision) < 1
        || typeof rawPlan.releaseLabel !== 'string'
        || typeof rawPlan.buildId !== 'string'
        || !gitShaPattern.test(String(rawPlan.sourceGitSha))
        || !gitShaPattern.test(String(rawPlan.kitGitSha))
        || !sha256Pattern.test(String(rawPlan.targetConfigDigest))
        || targetNames.length === 0
        || targetNames.some((target) => target !== 'android' && target !== 'ios')
        || Object.values(rawPlan.targets).some((target) => !isRecord(target))) {
        throw new Error(`Release state game ${gameId} has an invalid reservation ${releaseKey}.`);
      }
      const plan = rawPlan as unknown as PlatformVersionReleasePlan;
      try {
        const checked = allocatePlatformVersions({
          gameId,
          gameVersion: plan.gameVersion,
          sourceGitSha: plan.sourceGitSha,
          kitGitSha: plan.kitGitSha,
          targetConfigDigest: plan.targetConfigDigest,
          targets: targetNames.map((target) => ({
            target: target as PlatformVersionTargetRequest['target'],
          })),
          ledger,
          existingPlan: plan,
        });
        if (!isDeepStrictEqual(checked.plan, plan)) {
          throw new Error('Stored release plan differs from its validated allocation.');
        }
      } catch {
        throw new Error(`Release state game ${gameId} has an invalid reservation ${releaseKey}.`);
      }
      plans.push(plan);
    }
    assertReservationHistory(gameId, initialLedger, ledger, plans);
    for (const [buildKey, rawBuild] of Object.entries(game.builds)) {
      assertStoredBuildRecord(
        gameId,
        buildKey,
        rawBuild,
        game.reservations as Record<string, unknown>,
      );
    }
    for (const [key, rawCheckpoint] of Object.entries(game.submissions ?? {})) {
      assertSubmissionCheckpoint(rawCheckpoint);
      const checkpoint = rawCheckpoint as NativeSubmissionCheckpoint;
      const build = (game.builds as Record<string, ImmutableNativeBuildRecord>)[key];
      if (key !== `${checkpoint.releaseKey}/${checkpoint.target}` || build === undefined
        || checkpoint.buildRunId !== build.buildRunId
        || checkpoint.artifactSha256 !== build.artifactSha256) {
        throw new Error(`Release state game ${gameId} has an invalid submission ${key}.`);
      }
    }
  }
  return value as ReleaseState;
}

const buildRecordFields = [
  'releaseKey',
  'target',
  'buildRunId',
  'gameVersion',
  'sourceGitSha',
  'kitGitSha',
  'kitPackageVersion',
  'buildConfigDigest',
  'targetConfigDigest',
  'platformVersion',
  'artifactLocation',
  'artifactSha256',
  'releaseManifestSha256',
  'inspectedAppId',
  'inspectedSignerSha256',
  'inspectedTeamId',
] as const;

function assertStoredBuildRecord(
  gameId: string,
  buildKey: string,
  value: unknown,
  reservations: Record<string, unknown>,
): void {
  const malformed = (): never => {
    throw new Error(`Release state game ${gameId} has an invalid build record ${buildKey}.`);
  };
  if (!isRecord(value)) {
    malformed();
  }
  const record = value as Record<string, unknown>;
  if (typeof record.releaseKey !== 'string'
    || !releaseKeyPattern.test(record.releaseKey)
    || (record.target !== 'android' && record.target !== 'ios')
    || buildKey !== `${record.releaseKey}/${record.target}`
    || Object.keys(record).some((key) => !buildRecordFields.includes(
      key as typeof buildRecordFields[number],
    ))
    || typeof record.buildRunId !== 'string' || record.buildRunId.trim() === ''
    || typeof record.kitPackageVersion !== 'string' || record.kitPackageVersion.trim() === ''
    || typeof record.artifactLocation !== 'string' || record.artifactLocation.trim() === ''
    || typeof record.inspectedAppId !== 'string' || record.inspectedAppId.trim() === ''
    || !sha256Pattern.test(String(record.buildConfigDigest))
    || !sha256Pattern.test(String(record.artifactSha256))
    || !sha256Pattern.test(String(record.releaseManifestSha256))
    || (record.target === 'android' && (record.inspectedTeamId !== undefined
      || !sha256Pattern.test(String(record.inspectedSignerSha256))))
    || (record.target === 'ios' && (record.inspectedSignerSha256 !== undefined
      || !teamIdPattern.test(String(record.inspectedTeamId))))
    || !isRecord(record.platformVersion)) {
    malformed();
  }
  const plan = ownValue(reservations, record.releaseKey as string);
  if (!isRecord(plan) || !isRecord(plan.targets)
    || !isDeepStrictEqual(record.platformVersion, plan.targets[record.target as string])
    || record.gameVersion !== plan.gameVersion
    || record.sourceGitSha !== plan.sourceGitSha
    || record.kitGitSha !== plan.kitGitSha
    || record.targetConfigDigest !== plan.targetConfigDigest) {
    malformed();
  }
}

const checkpointFields = [
  'releaseKey',
  'target',
  'buildRunId',
  'artifactSha256',
  'attemptId',
  'leaseExpiresAt',
  'status',
  'remoteEditId',
  'remoteUploadId',
  'remoteBuildId',
] as const;

function assertSubmissionCheckpoint(value: unknown): asserts value is NativeSubmissionCheckpoint {
  if (!isRecord(value)) {
    throw new Error('Native submission checkpoint is not an object.');
  }
  const id = (name: 'remoteEditId' | 'remoteUploadId' | 'remoteBuildId'): boolean =>
    value[name] === undefined || typeof value[name] === 'string'
      && remoteIdPattern.test(value[name]);
  const androidStatuses: readonly NativeSubmissionStatus[] = [
    'started',
    'edit-open',
    'committed',
    'failed',
    'action-required',
    'unknown',
  ];
  const iosStatuses: readonly NativeSubmissionStatus[] = [
    'started',
    'upload-committed',
    'uploaded',
    'processing',
    'testflight-ready',
    'failed',
    'action-required',
    'unknown',
  ];
  if (typeof value.releaseKey !== 'string' || !releaseKeyPattern.test(value.releaseKey)
    || (value.target !== 'android' && value.target !== 'ios')
    || typeof value.buildRunId !== 'string' || value.buildRunId.trim() === ''
    || !sha256Pattern.test(String(value.artifactSha256))
    || typeof value.attemptId !== 'string' || !attemptIdPattern.test(value.attemptId)
    || typeof value.leaseExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.leaseExpiresAt))
    || Object.keys(value).some((key) => !checkpointFields.includes(
      key as typeof checkpointFields[number],
    ))
    || !id('remoteEditId') || !id('remoteUploadId') || !id('remoteBuildId')
    || (value.target === 'android' && (!androidStatuses.includes(value.status as NativeSubmissionStatus)
      || value.remoteUploadId !== undefined || value.remoteBuildId !== undefined
      || (['edit-open', 'committed'].includes(String(value.status))
        && value.remoteEditId === undefined)))
    || (value.target === 'ios' && (!iosStatuses.includes(value.status as NativeSubmissionStatus)
      || value.remoteEditId !== undefined
      || (['upload-committed', 'uploaded', 'processing', 'testflight-ready']
        .includes(String(value.status)) && value.remoteUploadId === undefined)))
    || (value.status === 'started'
      && (value.remoteEditId !== undefined || value.remoteUploadId !== undefined
        || value.remoteBuildId !== undefined))) {
    throw new Error('Native submission checkpoint is malformed.');
  }
}

function assertReservationHistory(
  gameId: string,
  initialLedger: PlatformVersionLedger,
  ledger: PlatformVersionLedger,
  plans: readonly PlatformVersionReleasePlan[],
): void {
  if (plans.length === 0) {
    throw new Error(`Release state game ${gameId} has no reservation history.`);
  }
  const ordered = [...plans].sort((left, right) => left.releaseRevision - right.releaseRevision);
  if (ordered[0]?.releaseRevision !== initialLedger.releaseRevision.lastAllocated + 1) {
    throw new Error(`Release state game ${gameId} has a truncated reservation history.`);
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.releaseRevision !== Number(ordered[index - 1]?.releaseRevision) + 1) {
      throw new Error(`Release state game ${gameId} has nonconsecutive release revisions.`);
    }
  }
  if (ordered.at(-1)?.releaseRevision !== ledger.releaseRevision.lastAllocated) {
    throw new Error(`Release state game ${gameId} ledger revision differs from reservations.`);
  }
  for (const target of ['android', 'ios'] as const) {
    const key = target === 'android' ? 'versionCode' : 'buildNumber';
    const versions = ordered.flatMap((plan) => {
      const entry = plan.targets[target];
      return entry === undefined ? [] : [Number(entry[key])];
    });
    const initialVersion = target === 'android'
      ? initialLedger.platforms.android?.versionCode
      : initialLedger.platforms.ios?.buildNumber;
    if (versions.length > 0 && (initialVersion === undefined
      || versions[0] !== initialVersion + 1)) {
      throw new Error(`Release state game ${gameId} has a truncated ${target} history.`);
    }
    for (let index = 1; index < versions.length; index += 1) {
      if (versions[index] !== Number(versions[index - 1]) + 1) {
        throw new Error(`Release state game ${gameId} has nonconsecutive ${target} numbers.`);
      }
    }
    let ledgerVersion: number | undefined;
    if (target === 'android') {
      ledgerVersion = ledger.platforms.android?.versionCode;
    } else {
      ledgerVersion = ledger.platforms.ios?.buildNumber;
    }
    if (versions.length > 0 && versions.at(-1) !== ledgerVersion) {
      throw new Error(`Release state game ${gameId} ${target} ledger differs from reservations.`);
    }
    if (versions.length === 0 && ledgerVersion !== initialVersion) {
      throw new Error(`Release state game ${gameId} ${target} ledger differs from its baseline.`);
    }
  }
  if (!isDeepStrictEqual(
    ledger.platforms['microsoft-store'],
    initialLedger.platforms['microsoft-store'],
  )) {
    throw new Error(
      `Release state game ${gameId} Microsoft Store ledger differs from its baseline.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue<T>(items: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(items, key) ? items[key] : undefined;
}

function assertReleaseKey(key: string): void {
  if (!releaseKeyPattern.test(key)) {
    throw new Error('Release key must be a lowercase, path-safe identifier.');
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function isolatedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) {
    delete environment[name];
  }
  return environment;
}

async function git(
  session: StateSession,
  args: readonly string[],
): Promise<{ readonly output: string }> {
  const secrets = [session.remoteUrl];
  for (const remote of [session.remoteUrl]) {
    try {
      const url = new URL(remote);
      for (const component of [url.username, url.password]) {
        if (component !== '') {
          secrets.push(component);
          try {
            secrets.push(decodeURIComponent(component));
          } catch {
            // Retain the raw component if it is not valid percent encoding.
          }
        }
      }
    } catch {
      // Local paths and scp-style Git remotes are not URL instances.
    }
  }
  const input: ReleaseProcessInput = {
    command: 'git',
    // Apply before checkout too: a relative inherited hooksPath could execute
    // post-checkout from the fetched, untrusted release-state branch.
    args: ['-c', `core.hooksPath=${path.join(session.directory, '.git', '.mpgd-no-hooks')}`, ...args],
    cwd: session.directory,
    environment: session.environment,
    timeoutMs: 60_000,
    signal: session.signal,
    secretValues: secrets,
    captureMachineStdout: true,
  };
  const result = await runReleaseProcess(input);
  if (result.truncated || result.machineStdout === undefined) {
    throw new Error('Release-state Git machine output was truncated or unavailable.');
  }
  return { output: result.machineStdout };
}

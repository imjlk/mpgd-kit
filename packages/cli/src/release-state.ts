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
  type PlatformVersionLedger,
  type PlatformVersionReleasePlan,
  type PlatformVersionTargetRequest,
} from '@mpgd/target-config';

import { runReleaseProcess, type ReleaseProcessInput } from './deploy-process.js';

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
  readonly inspectedSignerSha256: string;
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
  readonly inspectedSignerSha256: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

interface GameReleaseState {
  readonly ledger: PlatformVersionLedger;
  readonly reservations: Record<string, PlatformVersionReleasePlan>;
  readonly builds: Record<string, ImmutableNativeBuildRecord>;
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
      ledger: allocation.ledger,
      reservations: { ...(game?.reservations ?? {}), [input.releaseKey]: allocation.plan },
      builds: game?.builds ?? {},
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
    || input.inspectedAppId.trim() === '' || !sha256Pattern.test(input.inspectedSignerSha256)
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
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
      || (manifest as Record<string, unknown>).gitSha !== plan.sourceGitSha
      || (manifest as Record<string, unknown>).kitGitSha !== plan.kitGitSha
      || (manifest as Record<string, unknown>).buildId !== plan.buildId
      || (manifest as Record<string, unknown>).gameVersion !== plan.gameVersion) {
      throw new Error('Native build manifest does not match its reserved provenance.');
    }
    const manifestRecord = manifest as Record<string, unknown>;
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
      inspectedSignerSha256: input.inspectedSignerSha256,
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
    && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^:]+:)/iu.test(remoteUrl)) {
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
    if (Object.keys(game).some((key) => !['ledger', 'reservations', 'builds'].includes(key))
      || typeof game.reservations !== 'object' || game.reservations === null
      || Array.isArray(game.reservations)
      || typeof game.builds !== 'object' || game.builds === null
      || Array.isArray(game.builds)) {
      throw new Error(`Release state game ${gameId} has invalid entries.`);
    }
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
    assertReservationHistory(gameId, ledger, plans);
    for (const [buildKey, rawBuild] of Object.entries(game.builds)) {
      assertStoredBuildRecord(
        gameId,
        buildKey,
        rawBuild,
        game.reservations as Record<string, unknown>,
      );
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
    || !sha256Pattern.test(String(record.inspectedSignerSha256))
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

function assertReservationHistory(
  gameId: string,
  ledger: PlatformVersionLedger,
  plans: readonly PlatformVersionReleasePlan[],
): void {
  if (plans.length === 0) {
    throw new Error(`Release state game ${gameId} has no reservation history.`);
  }
  const ordered = [...plans].sort((left, right) => left.releaseRevision - right.releaseRevision);
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
    args,
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

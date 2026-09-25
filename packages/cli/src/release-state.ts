import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly kitPackageVersion: string;
  readonly targetConfigDigest: string;
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
  if (!gitShaPattern.test(input.sourceGitSha)) {
    throw new Error('Native release source revision must be a full Git SHA.');
  }
  const source = await runReleaseProcess({
    command: 'git',
    args: ['-C', input.gameRoot, 'cat-file', '-t', input.sourceGitSha],
    cwd: input.gameRoot,
    environment: input.environment,
    timeoutMs: 10_000,
    signal: input.signal,
  });
  if (source.output.trim() !== 'commit') {
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
    || input.inspectedAppId.trim() === '' || !sha256Pattern.test(input.inspectedSignerSha256)) {
    throw new Error('Native build record is missing a run ID, artifact location, or inspection.');
  }
  if (!statSync(input.artifactFile).isFile() || !statSync(input.releaseManifestFile).isFile()) {
    throw new Error('Native build record requires file artifacts.');
  }
  const artifactSha256 = sha256(input.artifactFile);
  const releaseManifestSha256 = sha256(input.releaseManifestFile);
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
    const manifest: unknown = JSON.parse(readFileSync(input.releaseManifestFile, 'utf8'));
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
      || (input.target === 'ios' && target.buildNumber !== plannedTarget.buildNumber)
      || (input.target === 'ios' && target.marketingVersion !== plannedTarget.marketingVersion)) {
      throw new Error('Native build manifest does not match reserved signed delivery.');
    }
    const record: ImmutableNativeBuildRecord = {
      releaseKey: input.releaseKey,
      target: input.target,
      buildRunId: input.buildRunId,
      sourceGitSha: plan.sourceGitSha,
      kitGitSha: plan.kitGitSha,
      kitPackageVersion: input.kitPackageVersion,
      targetConfigDigest: plan.targetConfigDigest,
      artifactLocation: input.artifactLocation,
      artifactSha256,
      releaseManifestSha256,
      inspectedAppId: input.inspectedAppId,
      inspectedSignerSha256: input.inspectedSignerSha256,
    };
    const key = `${input.releaseKey}/${input.target}`;
    const previous = ownValue(game.builds, key);
    if (previous !== undefined) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) {
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
  const environment = input.environment ?? process.env;
  // Keep the origin URL in memory: the redacted process runner must never
  // return a modified URL when its embedded auth matches an environment secret.
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
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
  if (remoteUrl === '') {
    throw new Error('Game repository origin remote is missing.');
  }
  if (!path.isAbsolute(remoteUrl)
    && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^:]+:)/iu.test(remoteUrl)) {
    remoteUrl = path.resolve(input.gameRoot, remoteUrl);
  }
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
    await git(session, ['init', '-q', directory]);
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
    const remoteHead = await git(session, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${stateBranch}`,
    ]);
    if (remoteHead.output.trim().split(/\s+/u)[0] !== commit) {
      throw new Error(
        'Release-state update conflicted or has an uncertain result; retry with the same release key.',
        { cause: error },
      );
    }
  }
  return commit;
}

function parseReleaseState(json: string): ReleaseState {
  const value: unknown = JSON.parse(json);
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
    assertPlatformVersionLedger(game.ledger);
  }
  return value as ReleaseState;
}

function ownValue<T>(items: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(items, key) ? items[key] : undefined;
}

function assertReleaseKey(key: string): void {
  if (!releaseKeyPattern.test(key)) {
    throw new Error('Release key must be a lowercase, path-safe identifier.');
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function git(session: StateSession, args: readonly string[]): Promise<{ readonly output: string }> {
  const secrets = [session.remoteUrl];
  try {
    const url = new URL(session.remoteUrl);
    if (url.password !== '') {
      secrets.push(url.password, decodeURIComponent(url.password));
    }
  } catch {
    // Local paths and scp-style Git remotes are not URL instances.
  }
  const input: ReleaseProcessInput = {
    command: 'git',
    args,
    cwd: session.directory,
    environment: session.environment,
    timeoutMs: 60_000,
    signal: session.signal,
    secretValues: secrets,
  };
  return runReleaseProcess(input);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

import { runReleaseProcess, type ReleaseProcessInput } from './deploy-process.js';

export interface PinnedReleaseInput {
  readonly gameRoot: string;
  readonly gameGitSha: string;
  readonly lockfileSha256: string;
  readonly targetConfigSha256: string;
  readonly deployConfigSha256: string;
  readonly kitPackageVersion: string;
  readonly kitGitSha: string;
}

export interface PinnedReleaseWorkspace {
  readonly workspaceRoot: string;
  readonly gameRoot: string;
  readonly input: PinnedReleaseInput;
  dispose(): void;
}

export interface PinnedNativeBuildResult {
  readonly artifact: string;
  readonly releaseManifest: string;
  readonly runId: string;
}

const gitShaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const defaultCloneTimeoutMs = 5 * 60_000;
const defaultInstallTimeoutMs = 15 * 60_000;
const defaultBuildTimeoutMs = 45 * 60_000;

/** Clone the selected game commit, including its monorepo workspace packages. */
export async function preparePinnedReleaseWorkspace(
  input: PinnedReleaseInput,
  options: {
    readonly temporaryParent?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  } = {},
): Promise<PinnedReleaseWorkspace> {
  assertPinnedInput(input);
  const sourceGame = realpathSync(input.gameRoot);
  const environment = options.environment ?? process.env;
  const gitTopLevel = await runReleaseProcess({
    command: 'git',
    args: ['-C', sourceGame, 'rev-parse', '--show-toplevel'],
    cwd: sourceGame,
    environment,
    timeoutMs: 10_000,
    signal: options.signal,
  });
  const sourceRepository = realpathSync(gitTopLevel.output.trim());
  const relativeGame = path.relative(sourceRepository, sourceGame);
  if (relativeGame === '..' || relativeGame.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeGame)) {
    throw new Error('Game path is outside its Git repository.');
  }
  const parent = options.temporaryParent ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const ownedRoot = mkdtempSync(path.join(parent, 'mpgd-release-workspace-'));
  const workspaceRoot = path.join(ownedRoot, 'checkout');
  try {
    await runReleaseProcess({
      command: 'git',
      args: [
        'clone',
        '--local',
        '--no-hardlinks',
        '--no-checkout',
        '--',
        sourceRepository,
        workspaceRoot,
      ],
      cwd: ownedRoot,
      environment,
      timeoutMs: defaultCloneTimeoutMs,
      signal: options.signal,
    });
    await runReleaseProcess({
      command: 'git',
      args: ['-C', workspaceRoot, 'checkout', '--detach', input.gameGitSha],
      cwd: workspaceRoot,
      environment,
      timeoutMs: defaultCloneTimeoutMs,
      signal: options.signal,
    });
    const actualRevision = await runReleaseProcess({
      command: 'git',
      args: ['-C', workspaceRoot, 'rev-parse', 'HEAD'],
      cwd: workspaceRoot,
      environment,
      timeoutMs: 10_000,
      signal: options.signal,
    });
    if (actualRevision.output.trim() !== input.gameGitSha) {
      throw new Error('Pinned game Git revision changed during workspace preparation.');
    }
    const gameRoot = path.join(workspaceRoot, relativeGame);
    assertPinnedFiles(workspaceRoot, gameRoot, input);
    return {
      workspaceRoot,
      gameRoot,
      input,
      dispose() {
        rmSync(ownedRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Install only inside the pinned checkout; the package store may be shared. */
export async function installPinnedReleaseDependencies(
  workspace: PinnedReleaseWorkspace,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<void> {
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  await runReleaseProcess({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: workspace.workspaceRoot,
    environment: options.environment ?? process.env,
    timeoutMs: options.timeoutMs ?? defaultInstallTimeoutMs,
    signal: options.signal,
  });
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
}

/** Run the existing packed CLI native builder against the pinned checkout. */
export async function runPinnedNativeBuild(
  workspace: PinnedReleaseWorkspace,
  input: {
    readonly target: 'android' | 'ios';
    readonly profile: string;
    readonly mode: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly secretValues?: readonly string[];
  },
): Promise<PinnedNativeBuildResult> {
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  assertInstalledKitIdentity(workspace);
  const targetsFile = path.join(workspace.gameRoot, 'mpgd.targets.json');
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
    MPGD_NATIVE_BUILD_MODE: input.mode,
  };
  const processInput: ReleaseProcessInput = {
    command: 'pnpm',
    args: [
      'exec',
      'mpgd',
      'target',
      'build',
      input.target,
      input.profile,
      '--targets-file',
      targetsFile,
    ],
    cwd: workspace.gameRoot,
    environment,
    timeoutMs: input.timeoutMs ?? defaultBuildTimeoutMs,
    signal: input.signal,
    secretValues: input.secretValues,
  };
  await runReleaseProcess(processInput);
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  const statusFile = path.join(
    workspace.gameRoot,
    'artifacts/native-build-status',
    `${input.target}.json`,
  );
  const status = readJsonObject(statusFile);
  if (status.status !== 'success' || typeof status.runId !== 'string'
    || typeof status.artifact !== 'string') {
    throw new Error('Pinned native build did not record a successful current attempt.');
  }
  const artifact = assertInsideWorkspace(workspace.gameRoot, status.artifact);
  if (!existsSync(artifact)) {
    throw new Error('Pinned native build artifact is missing.');
  }
  const releaseManifest = path.join(workspace.gameRoot, 'artifacts/release-manifest.json');
  const manifest = readJsonObject(releaseManifest);
  if (manifest.gitSha !== workspace.input.gameGitSha
    || manifest.kitGitSha !== workspace.input.kitGitSha) {
    throw new Error('Pinned native build manifest provenance does not match its inputs.');
  }
  return { artifact, releaseManifest, runId: status.runId };
}

function assertPinnedInput(input: PinnedReleaseInput): void {
  if (!gitShaPattern.test(input.gameGitSha) || !gitShaPattern.test(input.kitGitSha)
    || !sha256Pattern.test(input.lockfileSha256)
    || !sha256Pattern.test(input.targetConfigSha256)
    || !sha256Pattern.test(input.deployConfigSha256)
    || input.kitPackageVersion.trim() === '') {
    throw new Error('Pinned release input contains an invalid revision, digest, or Kit version.');
  }
}

function assertPinnedFiles(
  workspaceRoot: string,
  gameRoot: string,
  input: PinnedReleaseInput,
): void {
  for (const [file, expected] of [
    [path.join(workspaceRoot, 'pnpm-lock.yaml'), input.lockfileSha256],
    [path.join(gameRoot, 'mpgd.targets.json'), input.targetConfigSha256],
    [path.join(gameRoot, 'mpgd.deploy.json'), input.deployConfigSha256],
  ] as const) {
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) {
      throw new Error(`Pinned release input differs from its plan: ${path.basename(file)}`);
    }
  }
}

function assertInstalledKitIdentity(workspace: PinnedReleaseWorkspace): void {
  const requireGame = createRequire(path.join(workspace.gameRoot, 'package.json'));
  const cliEntry = requireGame.resolve('@mpgd/cli');
  const packageRoot = path.dirname(path.dirname(cliEntry));
  const packageJson = readJsonObject(path.join(packageRoot, 'package.json'));
  const buildInfo = readJsonObject(path.join(packageRoot, 'dist/native-build-info.json'));
  if (packageJson.version !== workspace.input.kitPackageVersion
    || buildInfo.kitGitSha !== workspace.input.kitGitSha
    || buildInfo.kitDirty !== false) {
    throw new Error('Installed Kit package does not match pinned release identity.');
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${file}`);
  }
  return value as Record<string, unknown>;
}

function assertInsideWorkspace(gameRoot: string, relativeArtifact: string): string {
  const absolute = path.resolve(gameRoot, relativeArtifact);
  const fromGame = path.relative(gameRoot, absolute);
  if (fromGame === '..' || fromGame.startsWith(`..${path.sep}`)
    || path.isAbsolute(fromGame)) {
    throw new Error('Native build artifact path escapes its pinned workspace.');
  }
  return absolute;
}

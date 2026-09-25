import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

import { planNativeDeployment, type NativeDeploymentPlan } from './deploy-planning.js';
import {
  runReleaseProcess,
  type ReleaseProcessInput,
  type ReleaseProcessResult,
} from './deploy-process.js';

export interface PinnedReleaseInput {
  readonly gameRoot: string;
  readonly deploymentProfile: string;
  readonly buildProfile: NativeDeploymentPlan['buildProfile'];
  readonly targets: readonly ('android' | 'ios')[];
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
const pinnedNativeConfigOverrides = [
  'MPGD_PRODUCT_CATALOG_FILE',
  'MPGD_AD_PLACEMENTS_FILE',
  'MPGD_TARGET_CONFIG_EXTENSIONS_FILE',
  'MPGD_RELEASE_MANIFEST_FILE',
  'MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR',
  'MPGD_ICON_MANIFEST_PATH',
  'MPGD_ICON_MANIFEST_ARTIFACT_PATH',
] as const;

/** Freeze a read-only deployment plan into the exact inputs used by a release run. */
export async function pinNativeDeploymentPlan(
  plan: NativeDeploymentPlan,
  kit: { readonly packageVersion: string; readonly gitSha: string },
  options: { readonly environment?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {},
): Promise<PinnedReleaseInput> {
  const current = planNativeDeployment({
    game: plan.gameRoot,
    profile: plan.profile,
    targets: plan.targets.map((target) => target.target),
  });
  if (!sameDeploymentPlan(current, plan)) {
    throw new Error('Deployment plan differs from the current game configuration.');
  }
  const gameRoot = realpathSync(plan.gameRoot);
  const revision = await runReleaseProcess({
    command: 'git',
    args: ['-C', gameRoot, 'rev-parse', 'HEAD'],
    cwd: gameRoot,
    environment: options.environment,
    timeoutMs: 10_000,
    signal: options.signal,
    captureMachineStdout: true,
  });
  const sourceRepository = await runReleaseProcess({
    command: 'git',
    args: ['-C', gameRoot, 'rev-parse', '--show-toplevel'],
    cwd: gameRoot,
    environment: options.environment,
    timeoutMs: 10_000,
    signal: options.signal,
    captureMachineStdout: true,
  });
  const repositoryRoot = realpathSync(machineOutput(sourceRepository).trim());
  const relativeGame = path.relative(repositoryRoot, gameRoot);
  if (relativeGame === '..' || relativeGame.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeGame)) {
    throw new Error('Game path is outside its Git repository.');
  }
  const inputPaths = ['pnpm-lock.yaml', 'mpgd.targets.json', 'mpgd.deploy.json']
    .map((name, index) => index === 0
      ? name
      : path.posix.join(relativeGame.split(path.sep).join('/'), name));
  const dirtyInputs = await runReleaseProcess({
    command: 'git',
    args: [
      '-C',
      repositoryRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...inputPaths,
    ],
    cwd: repositoryRoot,
    environment: options.environment,
    timeoutMs: 10_000,
    signal: options.signal,
    captureMachineStdout: true,
  });
  if (machineOutput(dirtyInputs) !== '') {
    throw new Error(
      'Pinned release inputs have uncommitted changes. Commit the lockfile and deployment configuration first.',
    );
  }
  for (const file of [
    path.join(repositoryRoot, 'pnpm-lock.yaml'),
    path.join(gameRoot, 'mpgd.targets.json'),
    path.join(gameRoot, 'mpgd.deploy.json'),
  ]) {
    assertPinnedInputPath(repositoryRoot, file);
  }
  const input: PinnedReleaseInput = {
    gameRoot,
    deploymentProfile: plan.profile,
    buildProfile: plan.buildProfile,
    targets: plan.targets.map((target) => target.target),
    gameGitSha: machineOutput(revision).trim(),
    lockfileSha256: sha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    targetConfigSha256: plan.targetConfigSha256,
    deployConfigSha256: plan.deployConfigSha256,
    kitPackageVersion: kit.packageVersion,
    kitGitSha: kit.gitSha,
  };
  assertPinnedInput(input);
  return input;
}

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
    captureMachineStdout: true,
  });
  const sourceRepository = realpathSync(machineOutput(gitTopLevel).trim());
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
      captureMachineStdout: true,
    });
    if (machineOutput(actualRevision).trim() !== input.gameGitSha) {
      throw new Error('Pinned game Git revision changed during workspace preparation.');
    }
    const gameRoot = path.join(workspaceRoot, relativeGame);
    assertWorkspaceOutputRoots(workspaceRoot, gameRoot);
    assertPinnedFiles(workspaceRoot, gameRoot, input);
    assertPinnedTargetPaths(gameRoot, input);
    await assertNoEscapingTrackedSymlinks(workspaceRoot, environment, options.signal);
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

/** Ensure failed, cancelled, and successful release runs all remove their checkout. */
export async function withPinnedReleaseWorkspace<T>(
  input: PinnedReleaseInput,
  action: (workspace: PinnedReleaseWorkspace) => Promise<T>,
  options: {
    readonly temporaryParent?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const workspace = await preparePinnedReleaseWorkspace(input, options);
  try {
    return await action(workspace);
  } finally {
    workspace.dispose();
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
  assertWorkspaceOutputRoots(workspace.workspaceRoot, workspace.gameRoot);
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  assertPinnedTargetPaths(workspace.gameRoot, workspace.input);
  await runReleaseProcess({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: workspace.workspaceRoot,
    environment: options.environment ?? process.env,
    timeoutMs: options.timeoutMs ?? defaultInstallTimeoutMs,
    signal: options.signal,
  });
  assertWorkspaceOutputRoots(workspace.workspaceRoot, workspace.gameRoot);
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  assertPinnedTargetPaths(workspace.gameRoot, workspace.input);
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
  assertWorkspaceOutputRoots(workspace.workspaceRoot, workspace.gameRoot);
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  assertPinnedTargetPaths(workspace.gameRoot, workspace.input);
  if (!workspace.input.targets.includes(input.target)
    || input.profile !== workspace.input.buildProfile) {
    throw new Error('Native build target and profile must match the pinned deployment plan.');
  }
  const cliExecutable = assertInstalledKitIdentity(workspace);
  const targetsFile = path.join(workspace.gameRoot, 'mpgd.targets.json');
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
    MPGD_NATIVE_BUILD_MODE: input.mode,
    MPGD_SOURCE_GIT_SHA: workspace.input.gameGitSha,
  };
  for (const name of pinnedNativeConfigOverrides) {
    if (environment[name] !== undefined && environment[name] !== '') {
      throw new Error(
        `Pinned native builds cannot use ${name}; use files committed inside the game checkout.`,
      );
    }
  }
  delete environment.MPGD_KIT_PATH;
  delete environment.MPGD_RUN_IOS_ARCHIVE;
  delete environment.MPGD_RUN_IOS_SIMULATOR_BUILD;
  const statusFile = path.join(
    workspace.gameRoot,
    'artifacts/native-build-status',
    `${input.target}.json`,
  );
  const previousRunId = existsSync(statusFile) ? readJsonObject(statusFile).runId : undefined;
  const buildTemporaryDirectory = mkdtempSync(
    path.join(workspace.workspaceRoot, 'mpgd-native-tmp-'),
  );
  environment.TMPDIR = buildTemporaryDirectory;
  environment.TMP = buildTemporaryDirectory;
  environment.TEMP = buildTemporaryDirectory;
  try {
    const processInput: ReleaseProcessInput = {
      command: process.execPath,
      args: [
        cliExecutable,
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
  } finally {
    rmSync(buildTemporaryDirectory, { recursive: true, force: true });
  }
  assertPinnedFiles(workspace.workspaceRoot, workspace.gameRoot, workspace.input);
  const status = readJsonObject(statusFile);
  if (status.target !== input.target || status.status !== 'success'
    || typeof status.runId !== 'string' || status.runId === previousRunId
    || typeof status.artifact !== 'string') {
    throw new Error('Pinned native build did not record a successful current attempt.');
  }
  const artifact = assertInsideWorkspace(workspace.gameRoot, status.artifact);
  if (!existsSync(artifact)) {
    throw new Error('Pinned native build artifact is missing.');
  }
  const canonicalGameRoot = realpathSync(workspace.gameRoot);
  const canonicalArtifact = realpathSync(artifact);
  const relativeArtifact = path.relative(canonicalGameRoot, canonicalArtifact);
  if (relativeArtifact === '..' || relativeArtifact.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeArtifact)) {
    throw new Error('Pinned native build artifact resolves outside its workspace.');
  }
  const releaseManifest = path.join(workspace.gameRoot, 'artifacts/release-manifest.json');
  const manifest = readJsonObject(releaseManifest);
  const manifestTargets = manifest.targets;
  if (typeof manifestTargets !== 'object' || manifestTargets === null
    || Array.isArray(manifestTargets)) {
    throw new Error('Pinned native build manifest has no target records.');
  }
  const targetManifest = (manifestTargets as Record<string, unknown>)[input.target];
  if (typeof targetManifest !== 'object' || targetManifest === null
    || Array.isArray(targetManifest)
    || (targetManifest as Record<string, unknown>).artifact !== status.artifact
    || (targetManifest as Record<string, unknown>).profile !== input.profile) {
    throw new Error('Pinned native build manifest target does not match the current artifact.');
  }
  if (manifest.gitSha !== workspace.input.gameGitSha
    || manifest.kitGitSha !== workspace.input.kitGitSha) {
    throw new Error('Pinned native build manifest provenance does not match its inputs.');
  }
  return { artifact, releaseManifest, runId: status.runId };
}

function assertPinnedInput(input: PinnedReleaseInput): void {
  if (!gitShaPattern.test(input.gameGitSha) || !gitShaPattern.test(input.kitGitSha)
    || input.deploymentProfile.trim() === ''
    || input.buildProfile !== 'production'
    || input.targets.length === 0
    || new Set(input.targets).size !== input.targets.length
    || input.targets.some((target) => target !== 'android' && target !== 'ios')
    || !sha256Pattern.test(input.lockfileSha256)
    || !sha256Pattern.test(input.targetConfigSha256)
    || !sha256Pattern.test(input.deployConfigSha256)
    || input.kitPackageVersion.trim() === '') {
    throw new Error('Pinned release input contains an invalid revision, digest, or Kit version.');
  }
}

function machineOutput(result: ReleaseProcessResult): string {
  if (result.truncated || result.machineStdout === undefined) {
    throw new Error('Release process machine output was truncated or unavailable.');
  }
  return result.machineStdout;
}

function assertPinnedTargetPaths(gameRoot: string, input: PinnedReleaseInput): void {
  const plan = planNativeDeployment({
    game: gameRoot,
    profile: input.deploymentProfile,
    targets: input.targets,
  });
  if (plan.buildProfile !== input.buildProfile
    || plan.targets.length !== input.targets.length
    || plan.targets.some((target, index) => target.target !== input.targets[index])) {
    throw new Error('Pinned native target paths no longer match the deployment plan.');
  }
}

function sameDeploymentPlan(left: NativeDeploymentPlan, right: NativeDeploymentPlan): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.gameRoot === right.gameRoot
    && left.profile === right.profile
    && left.buildProfile === right.buildProfile
    && left.approval === right.approval
    && left.targetConfigSha256 === right.targetConfigSha256
    && left.deployConfigSha256 === right.deployConfigSha256
    && left.targets.length === right.targets.length
    && left.targets.every((target, index) => {
      const other = right.targets[index];
      return other !== undefined && target.target === other.target
        && target.destination === other.destination
        && target.appId === other.appId
        && target.testGroup === other.testGroup;
    });
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
    assertPinnedInputPath(workspaceRoot, file);
    const actual = sha256(file);
    if (actual !== expected) {
      throw new Error(`Pinned release input differs from its plan: ${path.basename(file)}`);
    }
  }
  for (const name of ['mpgd.catalog.json', 'mpgd.ad-placements.json', 'mpgd.target-config.json']) {
    const file = path.join(gameRoot, name);
    if (existsSync(file)) {
      assertPinnedInputPath(workspaceRoot, file);
    }
  }
}

async function assertNoEscapingTrackedSymlinks(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<void> {
  const tracked = await runReleaseProcess({
    command: 'git',
    args: ['-C', workspaceRoot, 'ls-files', '--stage', '-z'],
    cwd: workspaceRoot,
    environment,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
    signal,
    captureMachineStdout: true,
  });
  for (const record of machineOutput(tracked).split('\0')) {
    const separator = record.indexOf('\t');
    if (separator === -1 || !record.startsWith('120000 ')) {
      continue;
    }
    const file = path.join(workspaceRoot, record.slice(separator + 1));
    const target = path.resolve(path.dirname(file), readlinkSync(file));
    const relative = path.relative(workspaceRoot, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw new Error(`Pinned release source symlink escapes its checkout: ${file}`);
    }
  }
}

function assertPinnedInputPath(repositoryRoot: string, file: string): void {
  const relativeFile = path.relative(repositoryRoot, file);
  if (relativeFile === '..' || relativeFile.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFile)) {
    throw new Error(`Pinned release input resolves outside its checkout: ${file}`);
  }
  let current = repositoryRoot;
  for (const segment of relativeFile.split(path.sep)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Pinned release input path is symlinked: ${file}`);
    }
  }
}

function assertWorkspaceOutputRoots(workspaceRoot: string, gameRoot: string): void {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const canonicalGame = realpathSync(gameRoot);
  const relativeGame = path.relative(canonicalWorkspace, canonicalGame);
  if (relativeGame === '..' || relativeGame.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeGame)) {
    throw new Error('Pinned game resolves outside its release checkout.');
  }
  for (const name of ['artifacts', 'release-output', 'dist']) {
    assertNoOutputSymlinks(path.join(gameRoot, name));
  }
  assertNoOutputSymlinks(path.join(gameRoot, '.mpgd.targets.generated.json'));
}

function assertNoOutputSymlinks(candidate: string): void {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`Pinned native build output path is symlinked: ${candidate}`);
  }
  if (entry.isDirectory()) {
    for (const child of readdirSync(candidate)) {
      assertNoOutputSymlinks(path.join(candidate, child));
    }
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assertInstalledKitIdentity(workspace: PinnedReleaseWorkspace): string {
  const requireGame = createRequire(path.join(workspace.gameRoot, 'package.json'));
  const cliEntry = requireGame.resolve('@mpgd/cli');
  const packageRoot = path.dirname(path.dirname(cliEntry));
  assertInsideCheckout(workspace.workspaceRoot, packageRoot, 'CLI package');
  assertInsideCheckout(workspace.workspaceRoot, cliEntry, 'CLI entrypoint');
  const packageJson = readJsonObject(path.join(packageRoot, 'package.json'));
  const buildInfo = readJsonObject(path.join(packageRoot, 'dist/native-build-info.json'));
  const bin = packageJson.bin;
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)
    || (bin as Record<string, unknown>).mpgd !== './dist/bin.js') {
    throw new Error('Installed Kit package has no expected mpgd executable.');
  }
  const cliExecutable = path.join(packageRoot, 'dist/bin.js');
  assertInsideCheckout(workspace.workspaceRoot, cliExecutable, 'CLI executable');
  if (packageJson.version !== workspace.input.kitPackageVersion
    || buildInfo.packageVersion !== workspace.input.kitPackageVersion
    || buildInfo.kitGitSha !== workspace.input.kitGitSha
    || buildInfo.kitDirty !== false) {
    throw new Error('Installed Kit package does not match pinned release identity.');
  }
  return cliExecutable;
}

function assertInsideCheckout(workspaceRoot: string, candidate: string, label: string): void {
  const relative = path.relative(realpathSync(workspaceRoot), realpathSync(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`Installed ${label} resolves outside the pinned checkout.`);
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

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { initializeMicrosoftStoreStarter } from '../../packages/cli/src/microsoft-store-starter';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-microsoft-store-starter-onboarding-'));
const kitRoot = resolve('.');
const templateRoot = resolve('packages/cli/templates/phaser-game');
const binaryFixtureFile = /\.(?:avif|gif|ico|jpe?g|otf|png|ttf|wasm|webp|woff2?)$/iu;
const unresolvedTemplatePlaceholder = /__(?:CAMEL_NAME|DEFAULT_KIT_PATH|DEVVIT_APP_NAME|GAME_NAME|GAME_TITLE(?:_TS_LITERAL)?|LEGAL_LAST_UPDATED|MPGD_DEPENDENCY_VERSION(?:_[A-Z0-9_]+)?|PACKAGE_NAME|PASCAL_NAME|PNPM_WORKSPACE_KIT_PACKAGES|RECOMMENDED_MATRIX_TARGETS|TSCONFIG_(?:EXTENDS_LINE|WORKSPACE_(?:EXCLUDES|INCLUDES))|WORKSPACE_I18N_BUILD_PREFIX)__/u;
const microsoftStoreBlockStart = '<!-- mpgd:microsoft-store:start -->';
const microsoftStoreBlockEnd = '<!-- mpgd:microsoft-store:end -->';
const storeSkill = '.agents/skills/release-microsoft-store/SKILL.md';
const storeSkillMetadata = '.agents/skills/release-microsoft-store/agents/openai.yaml';
const genericSkill = '.agents/skills/use-mpgd-kit/SKILL.md';
const genericSkillMetadata = '.agents/skills/use-mpgd-kit/agents/openai.yaml';

try {
  const baseGame = createGame('without-store');
  assertGenericAgentWorkflow(baseGame);
  assertMicrosoftStoreDisabled(baseGame);
  assertNoUnresolvedTemplatePlaceholders(baseGame);

  const selectedGame = createGame('with-store', ['--microsoft-store']);
  assertGenericAgentWorkflow(selectedGame);
  assertMicrosoftStoreEnabled(selectedGame);
  assertNoUnresolvedTemplatePlaceholders(selectedGame);

  const nestedGame = createGame('nested/with-store', ['--microsoft-store']);
  assertGenericAgentWorkflow(nestedGame);
  assertMicrosoftStoreEnabled(nestedGame);
  assertNoUnresolvedTemplatePlaceholders(nestedGame);

  const initializedGame = createGame('initialized-later');
  const legacyManifest = readJson(join(initializedGame, 'agent/game-manifest.json'));
  delete legacyManifest.agentWorkflow;
  assert.ok(Array.isArray(legacyManifest.targets));
  legacyManifest.targets = legacyManifest.targets.filter((target) => target !== 'web-preview');
  writeJson(join(initializedGame, 'agent/game-manifest.json'), legacyManifest);
  const beforeDryRun = snapshotTree(initializedGame);
  const dryRun = runCli([
    'target',
    'init',
    'microsoft-store',
    '--game',
    initializedGame,
    '--kit-path',
    kitRoot,
    '--dry-run',
  ]);
  assertCliSuccess(dryRun, 'Microsoft Store initializer dry run');
  assert.match(dryRun.stdout, /Would update Microsoft Store starter workflow/u);
  assert.deepEqual(snapshotTree(initializedGame), beforeDryRun);

  const firstInit = initializeGame(initializedGame);
  assert.match(firstInit.stdout, /Updated Microsoft Store starter workflow/u);
  assertMicrosoftStoreEnabled(initializedGame);
  assertNoUnresolvedTemplatePlaceholders(initializedGame);
  const initializedManifest = readJson(join(initializedGame, 'agent/game-manifest.json'));
  assert.ok(Array.isArray(initializedManifest.targets));
  assert.equal(
    initializedManifest.targets[initializedManifest.targets.length - 1],
    'microsoft-store',
  );
  const initializedReadmeFile = join(initializedGame, 'README.md');
  const initializedReadme = readFileSync(initializedReadmeFile, 'utf8');
  const editedReadme = initializedReadme.replace(
    'the mutable generator and icon URLs',
    'the user-edited generator and icon URLs',
  );
  assert.notEqual(editedReadme, initializedReadme);
  writeFileSync(initializedReadmeFile, editedReadme);
  const documentationRefresh = initializeGame(initializedGame);
  assert.match(documentationRefresh.stdout, /1 file\(s\)/u);
  assert.doesNotMatch(readFileSync(initializedReadmeFile, 'utf8'), /user-edited generator/u);
  assertManagedDocumentationCount(initializedGame, 1);
  const afterFirstInit = snapshotTree(initializedGame);
  const secondInit = initializeGame(initializedGame);
  assert.match(secondInit.stdout, /0 file\(s\)/u);
  assert.deepEqual(snapshotTree(initializedGame), afterFirstInit);

  const applyRollbackGame = createGame('apply-rollback');
  const beforeApplyRollback = snapshotTree(applyRollbackGame);
  assert.throws(
    () => initializeMicrosoftStoreStarter(
      {
        gameRoot: applyRollbackGame,
        templateRoot,
        defaultKitPath: relative(applyRollbackGame, kitRoot),
        dryRun: false,
      },
      {
        beforeCommit: (relativePath) => {
          if (relativePath === 'mpgd.targets.json') {
            throw new Error('injected mid-apply failure');
          }
        },
      },
    ),
    /injected mid-apply failure/u,
  );
  assert.deepEqual(snapshotTree(applyRollbackGame), beforeApplyRollback);

  const incompleteRollbackGame = createGame('incomplete-rollback');
  const packageBeforeIncompleteRollback = readFileSync(
    join(incompleteRollbackGame, 'package.json'),
    'utf8',
  );
  assert.throws(
    () => initializeMicrosoftStoreStarter(
      {
        gameRoot: incompleteRollbackGame,
        templateRoot,
        defaultKitPath: relative(incompleteRollbackGame, kitRoot),
        dryRun: false,
      },
      {
        beforeCommit: (relativePath) => {
          if (relativePath === 'src/main.ts') {
            throw new Error('injected after two committed writes');
          }
        },
        beforeRollbackEntry: (relativePath) => {
          if (relativePath === 'mpgd.targets.json') {
            throw new Error('injected rollback failure');
          }
        },
      },
    ),
    /rollback was incomplete: mpgd\.targets\.json: injected rollback failure/u,
  );
  assert.equal(
    readFileSync(join(incompleteRollbackGame, 'package.json'), 'utf8'),
    packageBeforeIncompleteRollback,
  );
  assert.notEqual(
    requireRecord(
      readJson(join(incompleteRollbackGame, 'mpgd.targets.json')).targets,
      'incomplete rollback targets',
    )['microsoft-store'],
    undefined,
  );

  const unsafeShellPathGame = createGame('unsafe-shell-path');
  const beforeUnsafeShellPath = snapshotTree(unsafeShellPathGame);
  assert.throws(
    () => initializeMicrosoftStoreStarter({
      gameRoot: unsafeShellPathGame,
      templateRoot,
      defaultKitPath: '%PATH%',
      dryRun: false,
    }),
    /unsafe in a shell parameter default/u,
  );
  assert.deepEqual(snapshotTree(unsafeShellPathGame), beforeUnsafeShellPath);

  const customConfig = readJson(join(initializedGame, 'mpgd.microsoft-store.json'));
  customConfig.fixture = 'game-owned-value';
  writeJson(join(initializedGame, 'mpgd.microsoft-store.json'), customConfig);
  const afterCustomization = snapshotTree(initializedGame);
  initializeGame(initializedGame);
  assert.deepEqual(snapshotTree(initializedGame), afterCustomization);

  const managedRuntimeFile = join(initializedGame, 'src/platform/microsoftStorePwa.ts');
  writeFileSync(managedRuntimeFile, '// stale generated runtime\n');
  const runtimeRefresh = initializeGame(initializedGame);
  assert.match(runtimeRefresh.stdout, /1 file\(s\)/u);
  assert.equal(
    readFileSync(managedRuntimeFile, 'utf8'),
    readFileSync(join(templateRoot, 'src/platform/microsoftStorePwa.ts'), 'utf8'),
  );
  assert.equal(
    readJson(join(initializedGame, 'mpgd.microsoft-store.json')).fixture,
    'game-owned-value',
  );

  assertConflictIsAtomic(
    'script-conflict',
    (gameRoot) => {
      const packageJson = readJson(join(gameRoot, 'package.json'));
      const scripts = requireRecord(packageJson.scripts, 'package scripts');
      scripts['build:microsoft-store'] = 'node unexpected-packager.mjs';
      writeJson(join(gameRoot, 'package.json'), packageJson);
    },
    /build:microsoft-store already exists with a different command/u,
  );

  assertConflictIsAtomic('target-conflict', (gameRoot) => {
    const targetsJson = readJson(join(gameRoot, 'mpgd.targets.json'));
    const targets = requireRecord(targetsJson.targets, 'targets');
    targets['microsoft-store'] = {
      kind: 'web',
      gameApp: '.',
      adapter: 'verse8',
      output: 'artifacts/microsoft-store',
    };
    writeJson(join(gameRoot, 'mpgd.targets.json'), targetsJson);
  }, /must be a game-owned web target using the browser adapter/u);

  assertConflictIsAtomic('bootstrap-conflict', (gameRoot) => {
    const mainFile = join(gameRoot, 'src/main.ts');
    const source = readFileSync(mainFile, 'utf8').replace(
      "import { installPlatform } from './platform/installPlatform';",
      "import { installPlatform } from './platform/customInstallPlatform';",
    );
    writeFileSync(mainFile, source);
  }, /platform import must contain exactly one canonical insertion anchor/u);

  const symlinkGame = createGame('symlink-conflict');
  const outside = join(fixtureRoot, 'outside');
  mkdirSync(outside, { recursive: true });
  rmSync(join(symlinkGame, '.agents'), { force: true, recursive: true });
  symlinkSync(outside, join(symlinkGame, '.agents'), 'dir');
  const symlinkSnapshot = snapshotTree(symlinkGame);
  const symlinkResult = initializeGame(symlinkGame, false);
  assertCliFailure(symlinkResult, /Starter directory resolves outside the game root/u);
  assert.deepEqual(snapshotTree(symlinkGame), symlinkSnapshot);
  assert.deepEqual(readdirSync(outside), []);

  const unsupported = runCli(['target', 'init', 'telegram', '--game', baseGame]);
  assertCliFailure(unsupported, /Target initialization is not available for target: telegram/u);

  const existingGame = join(fixtureRoot, 'existing-game');
  const sentinel = join(existingGame, 'sentinel.txt');
  mkdirSync(existingGame, { recursive: true });
  writeFileSync(sentinel, 'game-owned\n');
  const existingResult = runCli([
    'game',
    'create',
    existingGame,
    '--kit-path',
    kitRoot,
    '--microsoft-store',
  ]);
  assertCliFailure(existingResult, /Game directory already exists/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'game-owned\n');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('CLI Microsoft Store starter onboarding smoke passed.');

function createGame(name: string, args: readonly string[] = []): string {
  const gameRoot = join(fixtureRoot, name);
  const result = runCli(['game', 'create', gameRoot, '--kit-path', kitRoot, ...args]);
  assertCliSuccess(result, `create game ${name}`);
  return gameRoot;
}

function initializeGame(
  gameRoot: string,
  expectSuccess = true,
): SpawnSyncReturns<string> {
  const result = runCli([
    'target',
    'init',
    'microsoft-store',
    '--game',
    gameRoot,
    '--kit-path',
    kitRoot,
  ]);

  if (expectSuccess) {
    assertCliSuccess(result, `initialize Microsoft Store in ${gameRoot}`);
  }

  return result;
}

function assertGenericAgentWorkflow(gameRoot: string): void {
  for (const relativePath of [
    'AGENTS.md',
    'docs/MPGD_KIT_WORKFLOWS.md',
    genericSkill,
    genericSkillMetadata,
  ]) {
    assertRegularFile(join(gameRoot, relativePath));
  }

  const agents = readFileSync(join(gameRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /PlatformGateway/u);
  assert.match(agents, /backend\s+ledger/u);
  const manifest = readJson(join(gameRoot, 'agent/game-manifest.json'));
  const workflow = requireRecord(manifest.agentWorkflow, 'agent workflow');
  assert.equal(workflow.guide, 'docs/MPGD_KIT_WORKFLOWS.md');
  assert.equal(workflow.routerSkill, genericSkill);
}

function assertMicrosoftStoreDisabled(gameRoot: string): void {
  assert.equal(existsSync(join(gameRoot, 'mpgd.microsoft-store.json')), false);
  assert.equal(existsSync(join(gameRoot, 'src/platform/microsoftStorePwa.ts')), false);
  assert.equal(existsSync(join(gameRoot, storeSkill)), false);
  assert.equal(existsSync(join(gameRoot, storeSkillMetadata)), false);

  const packageJson = readJson(join(gameRoot, 'package.json'));
  const scripts = requireRecord(packageJson.scripts, 'package scripts');
  assert.equal(scripts['build:microsoft-store'], undefined);
  assert.equal(scripts['smoke:microsoft-store'], undefined);
  assert.equal(scripts['preflight:microsoft-store'], undefined);
  assert.equal(scripts['package:microsoft-store'], undefined);

  const targetsJson = readJson(join(gameRoot, 'mpgd.targets.json'));
  assert.equal(requireRecord(targetsJson.targets, 'targets')['microsoft-store'], undefined);
  const manifest = readJson(join(gameRoot, 'agent/game-manifest.json'));
  assert.ok(Array.isArray(manifest.targets));
  assert.equal(manifest.targets.includes('microsoft-store'), false);
  const workflow = requireRecord(manifest.agentWorkflow, 'agent workflow');
  const targetSkills = requireRecord(workflow.targetSkills, 'target skills');
  assert.equal(targetSkills['microsoft-store'], undefined);

  const main = readFileSync(join(gameRoot, 'src/main.ts'), 'utf8');
  assert.doesNotMatch(main, /installMicrosoftStorePwa/u);
  assert.doesNotMatch(readFileSync(join(gameRoot, 'README.md'), 'utf8'), /PWABuilder/u);
  assertManagedDocumentationCount(gameRoot, 0);
}

function assertMicrosoftStoreEnabled(gameRoot: string): void {
  for (const relativePath of [
    'mpgd.microsoft-store.json',
    'src/platform/microsoftStorePwa.ts',
    storeSkill,
    storeSkillMetadata,
  ]) {
    assertRegularFile(join(gameRoot, relativePath));
  }

  const packageJson = readJson(join(gameRoot, 'package.json'));
  const scripts = requireRecord(packageJson.scripts, 'package scripts');
  for (const name of [
    'build:microsoft-store',
    'smoke:microsoft-store',
    'preflight:microsoft-store',
    'package:microsoft-store',
  ]) {
    assert.equal(typeof scripts[name], 'string', `missing script ${name}`);
  }

  const targetsJson = readJson(join(gameRoot, 'mpgd.targets.json'));
  const storeTarget = requireRecord(
    requireRecord(targetsJson.targets, 'targets')['microsoft-store'],
    'Microsoft Store target',
  );
  assert.equal(storeTarget.kind, 'web');
  assert.equal(storeTarget.adapter, 'browser');
  const manifest = readJson(join(gameRoot, 'agent/game-manifest.json'));
  assert.ok(Array.isArray(manifest.targets));
  assert.equal(manifest.targets.includes('microsoft-store'), true);
  const workflow = requireRecord(manifest.agentWorkflow, 'agent workflow');
  const targetSkills = requireRecord(workflow.targetSkills, 'target skills');
  assert.equal(targetSkills['microsoft-store'], storeSkill);

  const main = readFileSync(join(gameRoot, 'src/main.ts'), 'utf8');
  assert.match(main, /installMicrosoftStorePwa/u);
  assert.match(main, /disposeMicrosoftStorePwa\?\.\(\)/u);
  assert.match(readFileSync(join(gameRoot, 'README.md'), 'utf8'), /PWABuilder/u);
  assert.match(readFileSync(join(gameRoot, storeSkill), 'utf8'), /WACK as optional/u);
  assertManagedDocumentationCount(gameRoot, 1);
  const gitignore = readFileSync(join(gameRoot, '.gitignore'), 'utf8').split(/\r?\n/u);
  assert.ok(gitignore.includes('release-input/'));
  assert.ok(gitignore.includes('release-output/'));
}

function assertManagedDocumentationCount(gameRoot: string, expected: number): void {
  for (const relativePath of ['README.md', 'agent/brief.md', 'agent/acceptance.md']) {
    const content = readFileSync(join(gameRoot, relativePath), 'utf8');
    assert.equal(content.split(microsoftStoreBlockStart).length - 1, expected, relativePath);
    assert.equal(content.split(microsoftStoreBlockEnd).length - 1, expected, relativePath);
  }
}

function assertConflictIsAtomic(
  name: string,
  mutate: (gameRoot: string) => void,
  expectedError: RegExp,
): void {
  const gameRoot = createGame(name);
  mutate(gameRoot);
  const before = snapshotTree(gameRoot);
  const result = initializeGame(gameRoot, false);
  assertCliFailure(result, expectedError);
  assert.deepEqual(snapshotTree(gameRoot), before);
}

function assertNoUnresolvedTemplatePlaceholders(gameRoot: string): void {
  visit(gameRoot);

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(file);
        continue;
      }

      if (!entry.isFile() || binaryFixtureFile.test(entry.name)) {
        continue;
      }

      const relativePath = relative(gameRoot, file).split('\\').join('/');
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        unresolvedTemplatePlaceholder,
        `${relativePath} (unsubstituted placeholder)`,
      );
    }
  }
}

function snapshotTree(root: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  visit(root);
  return snapshot;

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const key = relative(root, file).split('\\').join('/');

      if (entry.isDirectory()) {
        snapshot[`${key}:directory`] = '';
        visit(file);
      } else if (entry.isSymbolicLink()) {
        snapshot[`${key}:symlink`] = readlinkSync(file);
      } else if (entry.isFile()) {
        snapshot[`${key}:file`] = readFileSync(file, 'utf8');
      } else {
        snapshot[`${key}:other`] = String(lstatSync(file).mode);
      }
    }
  }
}

function assertRegularFile(file: string): void {
  assert.equal(lstatSync(file).isFile(), true, `expected regular file: ${file}`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must be an object`);
  assert.equal(Array.isArray(value), false, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertCliSuccess(result: SpawnSyncReturns<string>, label: string): void {
  if (result.error !== undefined) {
    throw result.error;
  }

  assert.equal(
    result.signal,
    null,
    `${label} was killed by ${String(result.signal)}:\n${result.stderr || result.stdout}`,
  );
  assert.equal(
    result.status,
    0,
    `${label} failed with ${String(result.status)}:\n${result.stderr || result.stdout}`,
  );
}

function assertCliFailure(result: SpawnSyncReturns<string>, expectedError: RegExp): void {
  if (result.error !== undefined) {
    throw result.error;
  }

  assert.notEqual(result.status, 0, 'CLI command should fail');
  assert.match(`${result.stderr}\n${result.stdout}`, expectedError);
}

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', ...args],
    {
      cwd: kitRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: 60_000,
    },
  );
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPackedDependencyCloser,
  findInstalledDependency,
} from '../../../tools/package/packed-dependency-closure.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageManager = readJson(join(repoRoot, 'package.json')).packageManager;
assert.equal(typeof packageManager, 'string');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-tutorial-package-'));
const consumerRoot = join(fixtureRoot, 'consumer');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const consumerSmokeSource = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [tutorial, platformStorage, driver, testing] = await Promise.all([
  import('@mpgd/tutorial'),
  import('@mpgd/tutorial/platform-storage'),
  import('@mpgd/tutorial/driver'),
  import('@mpgd/tutorial/testing'),
]);

assert.equal(typeof tutorial.defineTutorial, 'function');
assert.equal(typeof tutorial.createTutorialDirector, 'function');
assert.equal(typeof platformStorage.createPlatformTutorialProgressStore, 'function');
assert.equal(typeof driver.createDriverTutorialPresenter, 'function');
assert.equal(typeof driver.bindTutorialReplayTrigger, 'function');
assert.equal(typeof testing.createMemoryTutorialProgressStore, 'function');

const definition = tutorial.defineTutorial({
  id: 'package-smoke',
  initialScene: 'lobby',
  revision: 1,
  steps: [{
    advance: { kind: 'acknowledge' },
    id: 'welcome',
    interaction: 'blocked',
    scene: 'lobby',
    target: null,
  }],
});
const director = tutorial.createTutorialDirector({
  autoStart: true,
  definition,
  progressStore: testing.createMemoryTutorialProgressStore(),
});

director.acknowledge('welcome');
assert.equal(director.getSnapshot().status, 'completed');
await director.flush();

const driverCss = await readFile(new URL(import.meta.resolve('@mpgd/tutorial/driver.css')), 'utf8');
assert.match(driverCss, /\.driver-popover/);
`;

try {
  // The offline store holds the packed packages plus every runtime dependency
  // their manifests declare (for example typia under @mpgd/platform, driver.js
  // under @mpgd/tutorial), so the install proves the published closure is complete.
  const closer = createPackedDependencyCloser({ fixture: fixtureRoot, pnpm });
  const platform = closer.pack(join(repoRoot, 'packages/platform'));
  const tutorial = closer.pack(join(repoRoot, 'packages/tutorial'));
  const driver = closer.packed('driver.js');

  mkdirSync(consumerRoot);
  writeJson(join(consumerRoot, 'package.json'), {
    name: 'mpgd-tutorial-package-smoke',
    private: true,
    type: 'module',
    packageManager,
    dependencies: {
      '@mpgd/platform': platform.tarball,
      '@mpgd/tutorial': tutorial.tarball,
      'driver.js': driver.tarball,
    },
  });
  writeFileSync(
    join(consumerRoot, 'pnpm-workspace.yaml'),
    ['packages: []', closer.overridesYaml(), ''].join('\n'),
  );

  run(pnpm, [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--store-dir',
    join(fixtureRoot, 'store'),
  ], consumerRoot);

  const installedTutorial = readJson(
    join(consumerRoot, 'node_modules/@mpgd/tutorial/package.json'),
  );
  const installedPlatform = readJson(
    join(consumerRoot, 'node_modules/@mpgd/platform/package.json'),
  );
  const installedDriver = readJson(join(consumerRoot, 'node_modules/driver.js/package.json'));

  assert.equal(installedTutorial.dependencies?.['@mpgd/platform'], installedPlatform.version);
  assert.equal(installedTutorial.dependencies?.['driver.js'], installedDriver.version);
  assert.equal(JSON.stringify(installedTutorial).includes('workspace:'), false);
  const installedPlatformDir = realpathSync(join(consumerRoot, 'node_modules/@mpgd/platform'));
  for (const dependency of Object.keys(installedPlatform.dependencies ?? {})) {
    assert.ok(
      findInstalledDependency(installedPlatformDir, dependency),
      `@mpgd/platform runtime dependency ${dependency} is missing from the packed closure.`,
    );
  }

  writeFileSync(join(consumerRoot, 'smoke.mjs'), consumerSmokeSource);
  run(process.execPath, ['smoke.mjs'], consumerRoot);

  console.log('@mpgd/tutorial packed consumer smoke passed.');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}.`);
  }

  return result;
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNativeCommandLaunch } from '../../packages/cli/dist/command-launcher.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
for (const entry of [
  ['packages/cli/dist/bin.js'],
  ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts'],
]) {
  const result = spawnSync(process.execPath, [...entry, 'kit', 'doctor'], {
    cwd: root, encoding: 'utf8', timeout: 180_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^cli package: /m, 'CLI diagnostics must survive debug stripping');
  assert.match(result.stdout, /^mpgd-kit: /m);
  assert.match(result.stdout, /^cli template: ok$/m);
}
const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mpgd-cli-source-root-')));
try {
  // Exercise the packed manifest outside any Kit checkout. Running the source
  // CLI with --kit-path masks missing published dependency versions.
  const packedRoot = path.join(fixtureRoot, 'packed');
  mkdirSync(packedRoot);
  const packLaunch = resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['pack', '--pack-destination', packedRoot],
    environment: process.env,
  });
  const packed = spawnSync(packLaunch.command, [...packLaunch.args], {
    cwd: path.join(root, 'packages/cli'), encoding: 'utf8', timeout: 180_000,
  });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const cliVersion = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')).version;
  const extracted = spawnSync('tar', ['-xf', path.join(packedRoot, `mpgd-cli-${cliVersion}.tgz`), '-C', packedRoot], {
    encoding: 'utf8', timeout: 180_000,
  });
  assert.ifError(extracted.error);
  assert.equal(extracted.status, 0, extracted.stderr);
  const installedCli = path.join(packedRoot, 'package');
  // Reuse runtime dependencies only; the tested CLI files and manifest are
  // copied from the tarball, so packageRoot/cwd cannot discover Kit sources.
  symlinkSync(path.join(root, 'packages/cli/node_modules'), path.join(installedCli, 'node_modules'), 'junction');
  const packedManifest = JSON.parse(readFileSync(path.join(installedCli, 'package.json'), 'utf8'));
  const publishedVersions = { ...packedManifest.devDependencies, ...packedManifest.dependencies, '@mpgd/cli': `^${cliVersion}` };
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:MPGD_|NODE_OPTIONS$|NODE_PATH$|TTSC_RUNNER_PROJECT$)/i.test(key)));
  for (const template of ['phaser', 'lite']) {
    const game = path.join(fixtureRoot, `packed-${template}`);
    const generated = spawnSync(process.execPath, [path.join(installedCli, 'dist/bin.js'),
      'game', 'create', game, '--template', template, '--microsoft-store'], {
      cwd: fixtureRoot, env: isolatedEnv, encoding: 'utf8', timeout: 180_000,
    });
    assert.ifError(generated.error);
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(readFileSync(path.join(game, 'package.json'), 'utf8'));
    assert.notEqual(publishedVersions['@mpgd/platform'], `^${cliVersion}`, 'Fixture must use independently versioned packages');
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (name.startsWith('@mpgd/')) {
        assert.equal(version, publishedVersions[name], `${template}: wrong public version for ${name}`);
      }
    }
  }
  for (const workspace of [false, true]) {
    const gameRoot = path.join(fixtureRoot, workspace ? 'workspace-game' : 'standalone-game');
    const result = spawnSync(process.execPath, [
      'packages/cli/dist/bin.js', 'game', 'create', gameRoot, '--kit-path', root,
      ...(workspace ? ['--workspace'] : []),
    ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
    assert.ifError(result.error);
    if (workspace && path.isAbsolute(path.relative(gameRoot, root))) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /share a filesystem root/);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const devvitConfig = readFileSync(path.join(gameRoot, 'apps/target-devvit/vite.config.ts'), 'utf8');
    if (workspace) {
      assert.doesNotMatch(devvitConfig, /from '@mpgd\/cli\/devvit'/);
      assert.match(devvitConfig, /packages\/cli\/src\/devvit-output-collisions/);
    } else {
      assert.match(devvitConfig, /from '@mpgd\/cli\/devvit'/);
    }
    const config = JSON.parse(readFileSync(path.join(gameRoot, 'tsconfig.json'), 'utf8'));
    assert.equal(typeof config.compilerOptions.rootDir, 'string', 'generated games need an explicit source root');
    const sourceRoot = path.resolve(gameRoot, config.compilerOptions.rootDir);
    let expectedRoot = gameRoot;
    while (workspace && outside(path.relative(expectedRoot, root))) {
      const parent = path.dirname(expectedRoot);
      assert.notEqual(parent, expectedRoot, 'fixture and kit need a common filesystem root');
      expectedRoot = parent;
    }
    assert.equal(sourceRoot, expectedRoot, 'the source root must contain both game and kit sources');
    assert.equal(outside(path.relative(sourceRoot, gameRoot)), false);
    if (workspace) assert.equal(outside(path.relative(sourceRoot, root)), false);
  }
  const liteRoot = path.join(fixtureRoot, 'lite-game');
  const lite = spawnSync(process.execPath, [
    'packages/cli/dist/bin.js', 'game', 'create', liteRoot, '--kit-path', root, '--template', 'lite', '--workspace',
  ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  assert.equal(lite.status, 0, lite.stderr);
  const litePackage = JSON.parse(readFileSync(path.join(liteRoot, 'package.json'), 'utf8'));
  assert.equal(litePackage.dependencies.phaser, undefined, 'lite games must not depend on Phaser');
  assert.equal(typeof litePackage.dependencies['@mpgd/lite-shell'], 'string');
  assert.equal(existsSync(path.join(liteRoot, 'src/scenes')), false);
  assert.equal(existsSync(path.join(liteRoot, 'src/lite/tapGame.ts')), true);
  const liteSources = ['src/runtime/createGame.ts', 'src/platform/devvitEntrypoint.ts', 'src/lite/tapGame.ts']
    .map((file) => readFileSync(path.join(liteRoot, file), 'utf8')).join('\n');
  assert.doesNotMatch(liteSources, /from 'phaser'/);
  const liteManifest = JSON.parse(readFileSync(path.join(liteRoot, 'agent/game-manifest.json'), 'utf8'));
  assert.equal(liteManifest.game.engine, 'lite-canvas');
  const liteTargets = JSON.parse(readFileSync(path.join(liteRoot, 'mpgd.targets.json'), 'utf8'));
  assert.equal(liteTargets.targets.reddit.inlineEntry, 'index.html');
  assert.equal(liteTargets.targets.reddit.inlineBudget.maxGzipKb, 40);
  assert.deepEqual(liteTargets.targets.reddit.inlineBudget.forbidModules, ['phaser', 'matter-js']);
  const liteGuidance = ['AGENTS.md', 'README.md', 'agent/brief.md', 'agent/acceptance.md',
    'docs/MPGD_KIT_WORKFLOWS.md', '.agents/skills/use-mpgd-kit/SKILL.md']
    .map((file) => readFileSync(path.join(liteRoot, file), 'utf8')).join('\n');
  assert.doesNotMatch(liteGuidance, /Build a Phaser|Phaser scenes|src\/scenes|Keep Phaser-loadable/);
  assert.match(liteGuidance, /Canvas2D/);
  const standaloneLiteRoot = path.join(fixtureRoot, 'standalone-lite');
  const standaloneLite = spawnSync(process.execPath, [
    'packages/cli/dist/bin.js', 'game', 'create', standaloneLiteRoot, '--template', 'lite',
  ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  assert.equal(standaloneLite.status, 0, standaloneLite.stderr);
  const standaloneLitePackage = JSON.parse(readFileSync(path.join(standaloneLiteRoot, 'package.json'), 'utf8'));
  const shellVersion = JSON.parse(readFileSync(path.join(root, 'packages/lite-shell/package.json'), 'utf8')).version;
  assert.equal(standaloneLitePackage.dependencies['@mpgd/lite-shell'], `^${shellVersion}`);
  assert.equal(standaloneLitePackage.dependencies.phaser, undefined);
  for (const [args, message] of [
    [['--template', 'pixi'], /Unsupported --template pixi/],
    [['--template', 'lite', '--renderer', 'svg'], /implemented lite renderers: canvas/],
    [['--renderer', 'canvas'], /only available with --template lite/],
  ]) {
    const rejected = spawnSync(process.execPath, [
      'packages/cli/dist/bin.js', 'game', 'create', path.join(fixtureRoot, 'rejected-game'), '--kit-path', root, ...args,
    ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, message);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log('Compiled and source CLI output smoke passed');

function outside(relative) {
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
}

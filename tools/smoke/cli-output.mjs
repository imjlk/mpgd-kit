import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const liteGuidance = ['AGENTS.md', 'README.md', 'agent/brief.md', 'agent/acceptance.md',
    'docs/MPGD_KIT_WORKFLOWS.md', '.agents/skills/use-mpgd-kit/SKILL.md']
    .map((file) => readFileSync(path.join(liteRoot, file), 'utf8')).join('\n');
  assert.doesNotMatch(liteGuidance, /Build a Phaser|Phaser scenes|src\/scenes|Keep Phaser-loadable/);
  assert.match(liteGuidance, /Canvas2D/);
  for (const [args, message] of [
    [['--template', 'lite'], /requires --workspace/],
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

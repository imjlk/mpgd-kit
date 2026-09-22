import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log('Compiled and source CLI output smoke passed');

function outside(relative) {
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
}

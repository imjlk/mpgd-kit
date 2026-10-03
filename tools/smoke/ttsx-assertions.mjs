import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const authoredSibling = new URL('../fixtures/ttsx-assertion-canary.js', import.meta.url);
const authoredContent = readFileSync(authoredSibling, 'utf8');
const externalOutputs = ['packages/platform/src/index', 'adapters/browser/src/index']
  .flatMap((stem) => ['.js', '.js.map', '.d.ts'].map((extension) => new URL(`../../${stem}${extension}`, import.meta.url)));
const snapshotExternalOutputs = () => externalOutputs.map((path) => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : undefined);
const previousExternalOutputs = snapshotExternalOutputs();
for (const shouldFail of [false, true]) {
  const result = spawnSync(process.execPath, [
    'tools/run-ttsx.mjs', 'tools/fixtures/ttsx-assertion-canary.ts',
    ...(shouldFail ? ['--expect-failure'] : []),
  ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  assert.ifError(result.error);
  assert.equal(readFileSync(authoredSibling, 'utf8'), authoredContent, 'authored source siblings must survive ttsx');
  assert.equal(result.signal, null, result.stderr);
  if (shouldFail) {
    assert.notEqual(result.status, 0, 'ttsx must preserve failing assertions');
    assert.match(result.stderr, /MPGD_ASSERTION_CANARY/);
    assert.doesNotMatch(result.stdout, /MPGD_ASSERTION_CANARY_PASSED/);
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MPGD_ASSERTION_CANARY_PASSED/);
  }
}
const boundary = spawnSync(process.execPath, [
  'tools/run-ttsx.mjs', 'tools/fixtures/ttsx-project-boundary-canary.ts',
], { cwd: root, encoding: 'utf8', timeout: 180_000 });
assert.ifError(boundary.error);
assert.equal(boundary.status, 0, boundary.stderr);
assert.match(boundary.stdout, /MPGD_PROJECT_BOUNDARY_CANARY_PASSED/);
assert.deepEqual(
  snapshotExternalOutputs(),
  previousExternalOutputs,
  'cross-project ttsx imports must not emit beside workspace sources',
);
// --compile-once emits the tools program once, runs it compiled, shares that
// emit with nested runners from this checkout, and removes it afterwards.
const compileOnceRoot = mkdtempSync(join(tmpdir(), 'mpgd-compile-once-smoke-'));
try {
  // The last case inherits an emit root without a source marker (for example a
  // prepared emit from another checkout); --compile-once must emit its own.
  const untrustedEmitRoot = join(compileOnceRoot, 'untrusted-emit');
  mkdirSync(untrustedEmitRoot);
  for (const [shouldFail, inheritUntrusted] of [[false, false], [true, false], [false, true]]) {
    const name = `${shouldFail ? 'failure' : 'success'}${inheritUntrusted ? '-untrusted' : ''}`;
    const summary = join(compileOnceRoot, `${name}.md`);
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary };
    // The prepared suite forces ttsx and provides the CI emit; this case needs neither.
    delete env.MPGD_FORCE_TTSX;
    delete env.MPGD_CI_EMIT_ROOT;
    delete env.MPGD_TOOLS_EMIT_SOURCE_ROOT;
    if (inheritUntrusted) {
      env.MPGD_CI_EMIT_ROOT = untrustedEmitRoot;
    }
    const result = spawnSync(process.execPath, [
      'tools/run-ttsx.mjs', '--compile-once', 'tools/fixtures/compile-once-canary.ts',
      ...(shouldFail ? ['--expect-failure'] : []),
    ], { cwd: root, encoding: 'utf8', env, timeout: 180_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    if (shouldFail) {
      assert.notEqual(result.status, 0, 'compiled tools must preserve failing assertions');
      assert.match(result.stderr, /MPGD_ASSERTION_CANARY/);
      assert.doesNotMatch(result.stdout, /MPGD_ASSERTION_CANARY_PASSED/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /MPGD_ASSERTION_CANARY_PASSED/);
    }
    const emitRoot = /^MPGD_COMPILE_ONCE_EMIT_ROOT=(.+)$/m.exec(result.stdout)?.[1];
    assert.ok(emitRoot, 'the compile-once entry must run from the shared emit');
    assert.notEqual(emitRoot, untrustedEmitRoot, 'an unmarked inherited emit must not be reused');
    assert.equal(existsSync(emitRoot), false, 'the command-scoped emit must be removed');
    const modes = readFileSync(summary, 'utf8').split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Mode') && !line.startsWith('| ---'))
      .map((line) => line.split('|')[1].trim());
    assert.deepEqual(modes, ['emit', 'compiled', 'compiled'], 'the nested runner must reuse the emit');
  }
} finally {
  rmSync(compileOnceRoot, { recursive: true, force: true });
}
console.log('ttsx assertion preservation smoke passed');

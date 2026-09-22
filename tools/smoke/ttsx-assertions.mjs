import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
console.log('ttsx assertion preservation smoke passed');

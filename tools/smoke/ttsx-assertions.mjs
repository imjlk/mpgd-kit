import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
for (const shouldFail of [false, true]) {
  const result = spawnSync(process.execPath, [
    'tools/run-ttsx.mjs', 'tools/fixtures/ttsx-assertion-canary.ts',
    ...(shouldFail ? ['--expect-failure'] : []),
  ], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  assert.ifError(result.error);
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
console.log('ttsx assertion preservation smoke passed');

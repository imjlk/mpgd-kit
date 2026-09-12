import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
console.log('Compiled and source CLI output smoke passed');

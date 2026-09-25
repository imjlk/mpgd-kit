import assert from 'node:assert/strict';

import { ReleaseProcessError, runReleaseProcess } from './deploy-process.js';

const cwd = process.cwd();
const secret = 'private-deploy-token';
const redacted = await runReleaseProcess({
  command: process.execPath,
  args: ['-e', [
    'process.stdout.write(process.env.MPGD_API_TOKEN.slice(0, 7));',
    'setTimeout(() => process.stdout.write(process.env.MPGD_API_TOKEN.slice(7)), 10);',
  ].join('')],
  cwd,
  environment: { ...process.env, MPGD_API_TOKEN: secret },
  timeoutMs: 5_000,
});
assert.equal(redacted.output, '[REDACTED]');
assert.equal(redacted.truncated, false);
const interleaved = runReleaseProcess({
  command: process.execPath,
  args: ['-e', [
    'process.stdout.write(process.env.MPGD_API_TOKEN.slice(0, 8));',
    'setTimeout(() => process.stderr.write("warning"), 20);',
    'setTimeout(() => process.stdout.write(process.env.MPGD_API_TOKEN.slice(8)), 40);',
    'setTimeout(() => process.exit(5), 80);',
  ].join('')],
  cwd,
  environment: { ...process.env, MPGD_API_TOKEN: secret },
  timeoutMs: 5_000,
});
await assert.rejects(interleaved, (error: unknown) => {
  assert.ok(error instanceof ReleaseProcessError);
  assert.match(error.output, /\[REDACTED\]/u);
  assert.match(error.output, /warning/u);
  assert.doesNotMatch(error.output, /private-|deploy-token/u);
  return true;
});
const shortSecret = await runReleaseProcess({
  command: process.execPath,
  args: ['-e', 'process.stdout.write("prefixpost")'],
  cwd,
  timeoutMs: 5_000,
  secretValues: ['x'],
});
assert.equal(shortSecret.output, 'prefi[REDACTED]post');

const truncated = await runReleaseProcess({
  command: process.execPath,
  args: ['-e', 'process.stdout.write("a".repeat(18) + process.env.MPGD_API_TOKEN)'],
  cwd,
  environment: { ...process.env, MPGD_API_TOKEN: secret },
  timeoutMs: 5_000,
  maxOutputBytes: 25,
});
assert.equal(truncated.truncated, true);
assert.doesNotMatch(truncated.output, /private|deploy|token/u);
assert.match(truncated.output, /output truncated/u);

const failed = runReleaseProcess({
  command: process.execPath,
  args: ['-e', 'process.stdout.write(process.env.MPGD_API_TOKEN); process.exit(3)'],
  cwd,
  environment: { ...process.env, MPGD_API_TOKEN: secret },
  timeoutMs: 5_000,
});
await assert.rejects(failed, (error: unknown) => {
  assert.ok(error instanceof ReleaseProcessError);
  assert.equal(error.reason, 'exit');
  assert.equal(error.exitCode, 3);
  assert.match(error.output, /REDACTED/u);
  assert.doesNotMatch(error.message, /private-deploy-token/u);
  return true;
});

const timedOut = runReleaseProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd,
  timeoutMs: 100,
});
await assert.rejects(timedOut, (error: unknown) => {
  assert.ok(error instanceof ReleaseProcessError);
  assert.equal(error.reason, 'timeout');
  return true;
});

const controller = new AbortController();
const cancelled = runReleaseProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd,
  timeoutMs: 5_000,
  signal: controller.signal,
});
setTimeout(() => controller.abort(), 100);
await assert.rejects(cancelled, (error: unknown) => {
  assert.ok(error instanceof ReleaseProcessError);
  assert.equal(error.reason, 'abort');
  return true;
});
console.info('Bounded release process execution passed.');

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { isObject } from '../validation/json.js';
import { loadAttemptJobs, windowsTimings } from './windows-timings.mjs';

const entry = (name: string, start: number, end: number) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  started_at: new Date(start * 1000).toISOString(),
  completed_at: new Date(end * 1000).toISOString(),
});

await test('Windows report distinguishes runner cost from elapsed fan-out time', () => {
  const result = windowsTimings([
    entry('prepare', 0, 500),
    {
      ...entry('prepare-windows-starter (packages)', 10, 100),
      steps: [entry('build packages', 20, 90)],
    },
    entry('prepare-windows-starter (tooling)', 10, 50),
    entry('build-windows-starter (phaser)', 110, 160),
    entry('build-windows-starter (lite)', 110, 180),
    entry('test-windows-native-starter (lite, ARM64)', 190, 220),
    entry('published-starters-required', 1, 999),
  ]);
  assert.equal(result.jobs.length, 5);
  assert.equal(result.runnerSeconds, 280);
  assert.equal(result.elapsedSeconds, 210);
  assert.equal(result.jobs[0]?.steps[0]?.seconds, 70);
});

await test('failed steps retain timings while unavailable observations remain null', () => {
  const result = windowsTimings([
    { ...entry('prepare-windows-starter', 10, 20), conclusion: 'failure' },
    { ...entry('build-windows-starter (lite)', 20, 20), conclusion: 'skipped' },
    { ...entry('build-windows-starter (phaser)', 50, 40) },
    { name: 'test-windows-native-starter (lite, x64)', status: 'queued', conclusion: null },
  ]);
  assert.deepEqual(
    result.jobs.map((job) => job.seconds),
    [10, null, null, null],
  );
  assert.equal(result.runnerSeconds, 10);
  assert.equal(windowsTimings([]).elapsedSeconds, null);
});

await test('timing lookup paginates the exact run attempt and rejects API failures', async () => {
  const urls: string[] = [];
  const jobs = await loadAttemptJobs('imjlk/mpgd-kit', '123', '2', 'fixture-token', async (url) => {
    urls.push(String(url));
    return Response.json({ jobs: urls.length === 1 ? Array.from({ length: 100 }, () => entry('other', 0, 1)) : [entry('prepare-windows-starter', 1, 2)] });
  });
  assert.equal(jobs.length, 101);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes('/runs/123/attempts/2/jobs?')));
  assert.ok(urls[1]?.endsWith('page=2'));
  await assert.rejects(loadAttemptJobs('imjlk/mpgd-kit', '123', '2', 'fixture-token', async () => new Response('', { status: 403 })), /HTTP 403/);
});

await test('Windows package transfer preserves dist and rejects wrong provenance or corruption', {
  skip: process.platform !== 'win32',
}, () => {
  const workflow: unknown = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.ok(isObject(workflow) && isObject(workflow.jobs));
  const jobs = workflow.jobs;
  const script = (jobName: string, stepName: string): string => {
    const job = jobs[jobName];
    assert.ok(isObject(job) && Array.isArray(job.steps));
    const step: unknown = job.steps.find((candidate: unknown) => isObject(candidate) && candidate.name === stepName);
    assert.ok(isObject(step) && typeof step.run === 'string');
    return step.run;
  };
  const archiveScript = script('prepare-windows-starter', 'Archive the Windows package build');
  const restoreScript = script('build-windows-starter', 'Verify and restore the Windows package build');
  const temporary = mkdtempSync(join(tmpdir(), 'kit Windows artifact '));
  try {
    const producer = join(temporary, 'producer');
    const evidence = join(temporary, 'evidence');
    const consumer = join(temporary, 'consumer');
    const fixture = (path: string, content: string) => {
      mkdirSync(join(producer, path, '..'), { recursive: true });
      writeFileSync(join(producer, path), content);
    };
    fixture('packages/cli/dist/bin.js', 'fixture CLI');
    fixture('adapters/web/dist/nested/file with spaces.js', 'fixture adapter');
    fixture('packages/cli/node_modules/private-cache', 'must stay local');
    fixture('node_modules/.cache/ttsc/emit/ownership', 'must stay local');
    mkdirSync(consumer);
    const environment = {
      ...process.env,
      RUNNER_TEMP: evidence,
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123',
      RUNNER_OS: 'Windows',
      RUNNER_ARCH: 'X64',
    };
    const execute = (source: string, cwd: string) => {
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', source], {
        cwd, env: environment, encoding: 'utf8', timeout: 30_000,
      });
      assert.ifError(result.error);
      return result;
    };
    const archived = execute(archiveScript, producer);
    assert.equal(archived.status, 0, archived.stderr);
    const metadataPath = join(evidence, 'windows-kit-build/source.json');
    const originalMetadata = readFileSync(metadataPath, 'utf8');
    for (const [key, value] of Object.entries({ gitSha: 'b'.repeat(40), runId: '124', platform: 'Linux', architecture: 'ARM64' })) {
      const metadata: unknown = JSON.parse(originalMetadata);
      assert.ok(isObject(metadata));
      metadata[key] = value;
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const rejected = execute(restoreScript, consumer);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /does not belong/);
      assert.equal(existsSync(join(consumer, 'packages')), false);
    }
    writeFileSync(metadataPath, originalMetadata);
    const archivePath = join(evidence, 'windows-kit-build/package-dist.tgz');
    const originalArchive = readFileSync(archivePath);
    writeFileSync(archivePath, 'corrupt');
    const corrupt = execute(restoreScript, consumer);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /hash mismatch/);
    assert.equal(existsSync(join(consumer, 'packages')), false);
    writeFileSync(archivePath, originalArchive);
    const restored = execute(restoreScript, consumer);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(join(consumer, 'packages/cli/dist/bin.js'), 'utf8'), 'fixture CLI');
    assert.equal(readFileSync(join(consumer, 'adapters/web/dist/nested/file with spaces.js'), 'utf8'), 'fixture adapter');
    assert.equal(existsSync(join(consumer, 'packages/cli/node_modules')), false);
    assert.equal(existsSync(join(consumer, 'node_modules')), false);
  } finally {
    // Only remove the isolated directory returned by mkdtempSync above.
    rmSync(temporary, { recursive: true, force: true });
  }
});

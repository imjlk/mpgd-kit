// @ts-check
// The checkout-only CI gate has no dependencies or TypeScript loader installed.
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ name: string; status: string; conclusion: string | null;
  * started_at?: string | null; completed_at?: string | null
}} TimingEntry */
/** @typedef {TimingEntry & { steps?: TimingEntry[] }} Job */

/** @param {TimingEntry} entry */
function duration(entry) {
  if (entry.conclusion === 'skipped' || !entry.started_at || !entry.completed_at) {
    return null;
  }
  const seconds = (Date.parse(entry.completed_at) - Date.parse(entry.started_at)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** @param {readonly Job[]} source */
export function windowsTimings(source) {
  const jobs = source.filter((job) => /^(?:prepare-windows-starter|build-windows-starter|test-windows-native-starter)(?: \(|$)/.test(job.name))
    .map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      seconds: duration(job),
      steps: (job.steps ?? []).map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
        seconds: duration(step),
      })),
    }));
  const measured = jobs.filter((job) => job.seconds !== null);
  return {
    jobs,
    runnerSeconds: measured.length === 0 ? null : measured.reduce((sum, job) => sum + (job.seconds ?? 0), 0),
    // Includes gaps between preparation, fan-out and native execution; excludes
    // unrelated jobs. Runner time and elapsed time are deliberately distinct.
    elapsedSeconds: measured.length === 0 ? null
      : (Math.max(...measured.map((job) => Date.parse(job.completedAt ?? '')))
        - Math.min(...measured.map((job) => Date.parse(job.startedAt ?? '')))) / 1000,
  };
}

/** @param {string} repository @param {string} run @param {string} attempt
 * @param {string} token @param {typeof fetch} [request] */
export async function loadAttemptJobs(repository, run, attempt, token, request = fetch) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(run, /^\d+$/);
  assert.match(attempt, /^\d+$/);
  /** @type {Job[]} */
  const jobs = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `https://api.github.com/repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert.ok(response.ok, `Cannot read CI timings: HTTP ${response.status}`);
    const body = await response.json();
    assert.ok(Array.isArray(body.jobs), 'Missing workflow jobs');
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) {
      return jobs;
    }
  }
  throw new Error('Too many workflow job pages');
}

/** @param {string} value */
const cell = (value) => value.replace(/[|\r\n]/g, ' ');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_SHA: sha, GH_TOKEN: token, RUNNER_TEMP: temporary, GITHUB_STEP_SUMMARY: summary } = process.env;
  assert.ok(
    repository && run && attempt && sha && token && temporary && summary,
    'Missing CI timing context',
  );
  const timings = windowsTimings(await loadAttemptJobs(repository, run, attempt, token));
  writeFileSync(join(temporary, 'windows-ci-timings.json'), `${JSON.stringify({
    schemaVersion: 1, runId: run, attempt, gitSha: sha, ...timings,
  }, null, 2)}\n`);
  const lines = [
    '### Windows CI timings',
    `Run attempt: ${attempt}. Runner seconds: ${timings.runnerSeconds ?? 'unavailable'}. Elapsed seconds: ${timings.elapsedSeconds ?? 'unavailable'}.`,
    'Elapsed time includes the gaps between Windows jobs. Skipped or incomplete timings are unavailable.',
    '| Job / step | Result | Seconds |',
    '| --- | --- | ---: |',
  ];
  for (const job of timings.jobs) {
    lines.push(
      `| **${cell(job.name)}** | ${cell(job.conclusion ?? job.status)} | ${job.seconds ?? '—'} |`,
    );
    for (const step of job.steps) {
      lines.push(
        `| ${cell(step.name)} | ${cell(step.conclusion ?? 'incomplete')} | ${step.seconds ?? '—'} |`,
      );
    }
  }
  appendFileSync(summary, `${lines.join('\n')}\n`);
}

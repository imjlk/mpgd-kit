import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  renderGameAcceptanceMarkdown,
  runGameAcceptance,
  runMpgdCli,
  type GameAcceptanceCommandRunner,
  type GameAcceptanceReport,
} from '../../packages/cli/src/index';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-game-acceptance-'));
const reportDir = path.join(fixtureRoot, 'core-report');
const releaseManifestFile = path.join(fixtureRoot, 'artifacts/release-manifest.json');

try {
  const commands: string[] = [];
  const runner: GameAcceptanceCommandRunner = (step) => {
    commands.push([step.command, ...step.args].join(' '));
    return { exitCode: 0 };
  };
  const passed = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir,
    releaseManifestFile,
    options: { targets: 'web-preview', profile: 'staging' },
    steps: [
      {
        id: 'check',
        label: 'Game check',
        command: 'pnpm',
        args: ['run', 'check'],
        cwd: fixtureRoot,
      },
      {
        id: 'playtest',
        label: 'Automated playtest',
        skipReason: 'Optional package script is not configured.',
      },
    ],
    commandRunner: runner,
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(passed.report.status, 'passed');
  assert.deepEqual(commands, ['pnpm run check']);
  assert.deepEqual(
    passed.report.steps.map((step) => step.status),
    ['passed', 'skipped'],
  );
  assert.equal(passed.report.evidence.releaseManifest?.found, false);
  assert.equal(JSON.parse(readFileSync(passed.jsonFile, 'utf8')).schemaVersion, 1);
  assert.match(readFileSync(passed.markdownFile, 'utf8'), /Game Acceptance Report/u);

  const failed = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'failed-report'),
    options: {},
    steps: [
      {
        id: 'test',
        label: 'Game tests',
        command: 'pnpm',
        args: ['run', 'test'],
        cwd: fixtureRoot,
      },
      {
        id: 'build',
        label: 'Game build',
        command: '',
        args: ['run', 'build'],
        cwd: '',
      },
    ],
    commandRunner: () => ({ exitCode: 2, detail: 'fixture failure' }),
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(failed.report.status, 'failed');
  assert.deepEqual(
    failed.report.steps.map((step) => step.status),
    ['failed', 'skipped'],
  );
  assert.equal(failed.report.steps[0]?.detail, 'fixture failure');
  assert.equal(failed.report.steps[1]?.command, null);
  assert.equal(failed.report.steps[1]?.cwd, null);
  assert.match(readFileSync(failed.markdownFile, 'utf8'), /A previous acceptance step failed/u);

  const malformed = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'malformed-report'),
    options: {},
    steps: [{ id: 'malformed', label: 'Malformed step', command: '', cwd: '' }],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(malformed.report.status, 'failed');
  assert.match(malformed.report.steps[0]?.detail ?? '', /missing command/u);
  assert.equal(malformed.report.steps[0]?.command, null);
  assert.equal(malformed.report.steps[0]?.cwd, null);

  mkdirSync(path.dirname(releaseManifestFile), { recursive: true });
  writeFileSync(releaseManifestFile, '{*invalid');
  const invalidEvidence = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'invalid-evidence-report'),
    releaseManifestFile,
    options: {},
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(invalidEvidence.report.evidence.releaseManifest?.found, true);
  assert.match(invalidEvidence.report.evidence.releaseManifest?.parseError ?? '', /JSON/u);
  assert.match(readFileSync(invalidEvidence.markdownFile, 'utf8'), /Release manifest is invalid/u);
  const escapedMarkdown = renderGameAcceptanceMarkdown({
    ...invalidEvidence.report,
    evidence: {
      releaseManifest: {
        file: 'artifacts/release-manifest.json',
        found: true,
        parseError: 'bad *value* [detail] <tag>',
        value: null,
      },
    },
  });

  assert.match(escapedMarkdown, /bad \\\*value\\\* \\\[detail\\\] &lt;tag&gt;/u);

  const timedOut = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'timeout-report'),
    options: {},
    steps: [{
      id: 'timeout',
      label: 'Timeout step',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => undefined, 10000)'],
      cwd: fixtureRoot,
    }],
    commandTimeoutMs: 10,
    log: () => undefined,
  });

  assert.equal(timedOut.report.status, 'failed');
  assert.match(timedOut.report.steps[0]?.detail ?? '', /timed out after 10ms/u);

  const cliGameRoot = path.join(fixtureRoot, 'cli-game');
  const cliReportDir = path.join(cliGameRoot, 'handoff');

  mkdirSync(cliGameRoot);
  writeFileSync(
    path.join(cliGameRoot, 'package.json'),
    `${JSON.stringify({
      name: 'acceptance-fixture',
      private: true,
      scripts: {
        check: 'node --version',
        build: 'node --version',
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(cliGameRoot, 'mpgd.targets.json'),
    `${JSON.stringify({ schemaVersion: 1, targets: {} }, null, 2)}\n`,
  );

  await runMpgdCli([
    'game',
    'accept',
    cliGameRoot,
    '--kit-path',
    process.cwd(),
    '--report-dir',
    'handoff',
    '--skip-test',
    '--skip-graph',
    '--skip-playtest',
    '--skip-target-build',
    '--skip-target-smoke',
  ]);

  const cliReport = JSON.parse(
    readFileSync(path.join(cliReportDir, 'acceptance-report.json'), 'utf8'),
  ) as GameAcceptanceReport;

  assert.equal(cliReport.status, 'passed');
  assert.equal(cliReport.steps.length, 7);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('CLI game acceptance smoke passed.');

function createClock(): () => number {
  let value = Date.UTC(2026, 6, 12);

  return () => {
    value += 10;
    return value;
  };
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runGameAcceptance,
  runMpgdCli,
  type GameAcceptanceCommandRunner,
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
        command: 'pnpm',
        args: ['run', 'build'],
        cwd: fixtureRoot,
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
  assert.match(readFileSync(failed.markdownFile, 'utf8'), /A previous acceptance step failed/u);

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
  ) as { readonly status?: unknown; readonly steps?: readonly unknown[] };

  assert.equal(cliReport.status, 'passed');
  assert.equal(cliReport.steps?.length, 7);
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

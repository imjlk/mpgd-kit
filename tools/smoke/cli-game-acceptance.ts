import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectGameplayE2EPathEvidence,
  maximumGameplayE2EStates,
  renderGameAcceptanceMarkdown,
  resolveGameAcceptanceReleaseManifestFile,
  runGameAcceptance,
  runMpgdCli,
  type GameAcceptanceCommandRunner,
  type GameAcceptanceReport,
} from '../../packages/cli/src/index';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-game-acceptance-'));
const reportDir = path.join(fixtureRoot, 'core-report');
const releaseManifestFile = path.join(fixtureRoot, 'artifacts/release-manifest.json');

assert.equal(
  resolveGameAcceptanceReleaseManifestFile(fixtureRoot, {
    MPGD_RELEASE_MANIFEST_FILE: 'custom/release.json',
  }),
  path.join(fixtureRoot, 'custom/release.json'),
);
assert.equal(
  resolveGameAcceptanceReleaseManifestFile(fixtureRoot, {
    MPGD_RELEASE_MANIFEST_FILE: path.resolve(fixtureRoot, '../external-release.json'),
  }),
  path.resolve(fixtureRoot, '../external-release.json'),
);
assert.equal(
  resolveGameAcceptanceReleaseManifestFile(fixtureRoot, {
    MPGD_RELEASE_MANIFEST_FILE: '',
  }),
  path.join(fixtureRoot, 'artifacts/release-manifest.json'),
);

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
  assert.equal(passed.report.evidence.gameplayE2E, null);
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
  const gameplayEvidenceFile = path.join(fixtureRoot, 'artifacts/gameplay-e2e/report.json');

  mkdirSync(path.dirname(gameplayEvidenceFile), { recursive: true });
  writeFileSync(gameplayEvidenceFile, `${JSON.stringify({
    schemaVersion: 1,
    status: 'failed',
    target: 'android',
    profile: 'staging',
    artifact: {
      file: 'artifacts/app.apk',
      kind: 'file',
      sha256: 'a'.repeat(64),
    },
    states: [{ id: 'launch', status: 'failed' }],
  })}\n`);
  const failedGameplayEvidence = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'failed-gameplay-evidence-report'),
    gameplayE2EReportFile: gameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: {},
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(failedGameplayEvidence.report.status, 'failed');
  assert.match(
    failedGameplayEvidence.report.evidence.gameplayE2E?.validationError ?? '',
    /status must be passed/u,
  );
  assert.match(readFileSync(failedGameplayEvidence.markdownFile, 'utf8'), /failed validation/u);
  const escapedMarkdown = renderGameAcceptanceMarkdown({
    ...invalidEvidence.report,
    gameRoot: 'root *game* <tag>\nnext',
    evidence: {
      releaseManifest: {
        file: 'artifacts/[release]*.json\nnext',
        found: true,
        parseError: 'bad *value* [detail] <tag>',
        value: null,
      },
      gameplayE2E: null,
    },
  });

  assert.match(escapedMarkdown, /bad \\\*value\\\* \\\[detail\\\] &lt;tag&gt;/u);
  assert.match(escapedMarkdown, /Game root: root \\\*game\\\* &lt;tag&gt; next/u);
  assert.match(escapedMarkdown, /artifacts\/\\\[release\\\]\\\*\.json next/u);

  writeFileSync(path.join(fixtureRoot, 'relative-release.json'), '{"version":1}\n');
  const relativeEvidence = runGameAcceptance({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'relative-evidence-report'),
    releaseManifestFile: 'relative-release.json',
    options: {},
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(relativeEvidence.report.evidence.releaseManifest?.found, true);
  assert.deepEqual(relativeEvidence.report.evidence.releaseManifest?.value, { version: 1 });

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
        'gameplay:e2e': 'node ./write-gameplay-evidence.mjs',
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(cliGameRoot, 'mpgd.targets.json'),
    `${JSON.stringify({ schemaVersion: 1, targets: {} }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(cliGameRoot, 'mpgd.game.json'),
    `${JSON.stringify({
      acceptance: {
        gameplay: {
          schemaVersion: 1,
          states: [{ id: 'launch', label: 'Launch', actions: [] }],
        },
      },
    })}\n`,
  );
  writeFileSync(path.join(cliGameRoot, 'app.apk'), 'fixture artifact\n');
  writeFileSync(path.join(cliGameRoot, 'launch.png'), 'fixture screenshot\n');
  writeFileSync(
    path.join(cliGameRoot, 'gameplay-evidence-source.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      target: 'android',
      profile: 'staging',
      plan: collectGameplayE2EPathEvidence(cliGameRoot, 'mpgd.game.json', 'plan'),
      artifact: collectGameplayE2EPathEvidence(cliGameRoot, 'app.apk', 'artifact'),
      states: [{
        id: 'launch',
        status: 'passed',
        screenshot: collectGameplayE2EPathEvidence(cliGameRoot, 'launch.png', 'screenshot'),
      }],
    })}\n`,
  );
  writeFileSync(
    path.join(cliGameRoot, 'write-gameplay-evidence.mjs'),
    [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      'const file = process.env.MPGD_GAMEPLAY_E2E_REPORT_FILE;',
      "if (file === undefined) throw new Error('Missing gameplay E2E report file.');",
      'mkdirSync(path.dirname(file), { recursive: true });',
      "writeFileSync(file, readFileSync('gameplay-evidence-source.json'));",
      '',
    ].join('\n'),
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
  const gameplayE2EStep = cliReport.steps.find((step) => step.id === 'gameplay-e2e');

  assert.equal(cliReport.status, 'passed');
  assert.equal(cliReport.steps.length, 8);
  assert.equal(gameplayE2EStep?.status, 'passed');
  assert.equal(cliReport.evidence.gameplayE2E?.found, true);
  assert.equal(cliReport.evidence.gameplayE2E?.validationError, null);
  const validGameplayEvidence = JSON.parse(
    readFileSync(path.join(cliGameRoot, 'gameplay-evidence-source.json'), 'utf8'),
  ) as Record<string, unknown>;
  const oversizedGameplayEvidenceFile = path.join(cliGameRoot, 'oversized-gameplay-evidence.json');

  writeFileSync(
    oversizedGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      states: Array.from(
        { length: maximumGameplayE2EStates + 1 },
        () => ({ status: 'passed' }),
      ),
    })}\n`,
  );
  const oversizedEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'oversized-report'),
    gameplayE2EReportFile: oversizedGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(oversizedEvidence.report.status, 'failed');
  assert.match(
    oversizedEvidence.report.evidence.gameplayE2E?.validationError ?? '',
    /cannot contain more than/u,
  );

  const escapingGameplayEvidenceFile = path.join(cliGameRoot, 'escaping-gameplay-evidence.json');

  writeFileSync(
    escapingGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      artifact: collectGameplayE2EPathEvidence(
        cliGameRoot,
        path.join(fixtureRoot, 'relative-release.json'),
        'outside artifact',
      ),
    })}\n`,
  );
  const escapingEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'escaping-report'),
    gameplayE2EReportFile: escapingGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(escapingEvidence.report.status, 'failed');
  assert.match(
    escapingEvidence.report.evidence.gameplayE2E?.validationError ?? '',
    /path escapes the game root/u,
  );

  const releaseManifestDir = path.join(cliGameRoot, 'release-manifest-dir');
  const unreadableGameplayEvidenceFile = path.join(
    cliGameRoot,
    'unreadable-gameplay-evidence.json',
  );

  mkdirSync(releaseManifestDir);
  writeFileSync(
    unreadableGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      releaseManifest: {
        file: 'release-manifest-dir',
        kind: 'file',
        sha256: 'a'.repeat(64),
      },
    })}\n`,
  );
  const unreadableEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'unreadable-report'),
    releaseManifestFile: releaseManifestDir,
    gameplayE2EReportFile: unreadableGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(unreadableEvidence.report.status, 'failed');
  assert.match(
    unreadableEvidence.report.evidence.gameplayE2E?.validationError ?? '',
    /release manifest is unreadable/u,
  );
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

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectGameplayE2EPathEvidence,
  maximumGameplayE2EReportBytes,
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
      target: 'web-preview',
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
      "const report = JSON.parse(readFileSync('gameplay-evidence-source.json', 'utf8'));",
      "if (process.env.MPGD_ACCEPTANCE_TARGETS !== 'web-preview') {",
      "  throw new Error('Expected normalized acceptance targets.');",
      '}',
      'writeFileSync(file, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() })}\\n`);',
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
    '--targets',
    'web',
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
  const validGameplayEvidence = expectRecordValue(
    cliReport.evidence.gameplayE2E?.value,
    'gameplay E2E evidence value',
  );
  const validGameplayStates = validGameplayEvidence.states;

  if (!Array.isArray(validGameplayStates)) {
    throw new Error('Expected gameplay E2E evidence states to be an array.');
  }

  const linkedReleaseManifestFile = path.join(cliGameRoot, 'linked-release-manifest.json');
  const linkedGameplayEvidenceFile = path.join(cliGameRoot, 'linked-gameplay-evidence.json');

  writeFileSync(
    linkedReleaseManifestFile,
    `${JSON.stringify({
      targets: {
        'web-preview': {
          artifact: 'app.apk',
          profile: 'staging',
        },
      },
    })}\n`,
  );
  writeFileSync(
    linkedGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      releaseManifest: collectGameplayE2EPathEvidence(
        cliGameRoot,
        linkedReleaseManifestFile,
        'release manifest',
      ),
    })}\n`,
  );
  const linkedEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'linked-report'),
    releaseManifestFile: linkedReleaseManifestFile,
    gameplayE2EReportFile: linkedGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectEqual(linkedEvidence.report.status, 'passed', 'linked release evidence status');
  expectEqual(
    linkedEvidence.report.evidence.gameplayE2E?.validationError,
    null,
    'linked release evidence validation',
  );

  const mismatchedAcceptanceTarget = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'mismatched-acceptance-target-report'),
    gameplayE2EReportFile: linkedGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    gameplayE2ETargets: ['ios'],
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    mismatchedAcceptanceTarget.report.evidence.gameplayE2E?.validationError,
    /must match an acceptance target: ios/u,
    'acceptance target binding',
  );

  const symbolicLinkArtifactEvidenceFile = path.join(
    cliGameRoot,
    'symbolic-link-artifact-evidence.json',
  );

  writeFileSync(
    symbolicLinkArtifactEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      artifact: {
        ...expectRecordValue(validGameplayEvidence.artifact, 'valid gameplay artifact'),
        kind: 'symbolic-link',
      },
    })}\n`,
  );
  const symbolicLinkArtifactEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'symbolic-link-artifact-report'),
    gameplayE2EReportFile: symbolicLinkArtifactEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    symbolicLinkArtifactEvidence.report.evidence.gameplayE2E?.validationError,
    /hashed file or directory target artifact/u,
    'symbolic-link artifact rejection',
  );

  const spoofedPlanFile = path.join(cliGameRoot, 'spoofed-plan.json');
  const spoofedPlanEvidenceFile = path.join(cliGameRoot, 'spoofed-plan-evidence.json');

  writeFileSync(
    spoofedPlanFile,
    `${JSON.stringify({
      acceptance: {
        gameplay: {
          schemaVersion: 1,
          states: [{ id: 'launch', label: 'Launch', actions: [] }],
        },
      },
    })}\n`,
  );
  writeFileSync(
    spoofedPlanEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      plan: collectGameplayE2EPathEvidence(cliGameRoot, spoofedPlanFile, 'spoofed plan'),
    })}\n`,
  );
  const spoofedPlanEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'spoofed-plan-report'),
    gameplayE2EReportFile: spoofedPlanEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    spoofedPlanEvidence.report.evidence.gameplayE2E?.validationError,
    /must link the game manifest plan path/u,
    'canonical gameplay plan path',
  );

  writeFileSync(
    linkedReleaseManifestFile,
    `${JSON.stringify({
      targets: {
        'web-preview': {
          artifact: 'different.apk',
          profile: 'staging',
        },
      },
    })}\n`,
  );
  writeFileSync(
    linkedGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      releaseManifest: collectGameplayE2EPathEvidence(
        cliGameRoot,
        linkedReleaseManifestFile,
        'release manifest',
      ),
    })}\n`,
  );
  const mismatchedReleaseTarget = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'mismatched-release-target-report'),
    releaseManifestFile: linkedReleaseManifestFile,
    gameplayE2EReportFile: linkedGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    mismatchedReleaseTarget.report.evidence.gameplayE2E?.validationError,
    /does not match the tested artifact/u,
    'release target artifact binding',
  );

  writeFileSync(
    linkedReleaseManifestFile,
    `${JSON.stringify({
      targets: {
        'web-preview': {
          artifact: 'app.apk',
          profile: 'staging',
        },
      },
      padding: 'x'.repeat(maximumGameplayE2EReportBytes),
    })}\n`,
  );
  writeFileSync(
    linkedGameplayEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      releaseManifest: collectGameplayE2EPathEvidence(
        cliGameRoot,
        linkedReleaseManifestFile,
        'release manifest',
      ),
    })}\n`,
  );
  const oversizedReleaseManifest = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'oversized-release-manifest-report'),
    releaseManifestFile: linkedReleaseManifestFile,
    gameplayE2EReportFile: linkedGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    oversizedReleaseManifest.report.evidence.releaseManifest?.parseError,
    new RegExp(`cannot exceed ${maximumGameplayE2EReportBytes} bytes`, 'u'),
    'release manifest byte limit',
  );
  expectMatch(
    oversizedReleaseManifest.report.evidence.gameplayE2E?.validationError,
    new RegExp(`cannot exceed ${maximumGameplayE2EReportBytes} bytes`, 'u'),
    'gameplay release manifest byte limit',
  );

  const incompletePlanEvidenceFile = path.join(cliGameRoot, 'incomplete-plan-evidence.json');

  writeFileSync(
    incompletePlanEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      states: [
        ...validGameplayStates,
        ...validGameplayStates,
      ],
    })}\n`,
  );
  const incompletePlanEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'incomplete-plan-report'),
    gameplayE2EReportFile: incompletePlanEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    incompletePlanEvidence.report.evidence.gameplayE2E?.validationError,
    /cover every manifest plan state in order/u,
    'manifest state coverage',
  );

  const excessiveBytesEvidenceFile = path.join(cliGameRoot, 'excessive-bytes-evidence.json');

  writeFileSync(
    excessiveBytesEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      padding: 'x'.repeat(maximumGameplayE2EReportBytes),
    })}\n`,
  );
  const excessiveBytesEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'excessive-bytes-report'),
    gameplayE2EReportFile: excessiveBytesEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectMatch(
    excessiveBytesEvidence.report.evidence.gameplayE2E?.validationError,
    new RegExp(`cannot exceed ${maximumGameplayE2EReportBytes} bytes`, 'u'),
    'gameplay evidence byte limit',
  );

  const staleGameplayEvidenceFile = path.join(cliGameRoot, 'stale-gameplay-evidence.json');

  writeFileSync(staleGameplayEvidenceFile, `${JSON.stringify(validGameplayEvidence)}\n`);
  const staleGameplayEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'stale-report'),
    gameplayE2EReportFile: staleGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    gameplayE2EStepId: 'gameplay-e2e',
    options: { profile: 'staging' },
    steps: [
      {
        id: 'prepare',
        label: 'Prepare stale evidence',
        command: 'write-stale-evidence',
        cwd: cliGameRoot,
      },
      {
        id: 'gameplay-e2e',
        label: 'Gameplay E2E',
        command: 'noop',
        cwd: cliGameRoot,
      },
    ],
    commandRunner: (step) => {
      if (step.command === 'write-stale-evidence') {
        writeFileSync(staleGameplayEvidenceFile, `${JSON.stringify(validGameplayEvidence)}\n`);
      }

      return { exitCode: 0 };
    },
    now: createClock(),
    log: () => undefined,
  });

  expectEqual(
    staleGameplayEvidence.report.evidence.gameplayE2E?.found,
    false,
    'stale gameplay evidence removal',
  );
  const outsideSymlinkedReportDir = path.join(fixtureRoot, 'outside-symlinked-report');
  const protectedOutsideEvidenceFile = path.join(
    outsideSymlinkedReportDir,
    'protected-gameplay-evidence.json',
  );
  const linkedGameplayReportDir = path.join(cliGameRoot, 'linked-gameplay-report');

  mkdirSync(outsideSymlinkedReportDir);
  writeFileSync(protectedOutsideEvidenceFile, `${JSON.stringify(validGameplayEvidence)}\n`);
  symlinkSync(outsideSymlinkedReportDir, linkedGameplayReportDir, 'dir');

  try {
    expectCallError(
      () => runGameAcceptance({
        gameRoot: cliGameRoot,
        reportDir: path.join(cliGameRoot, 'linked-gameplay-report-output'),
        gameplayE2EReportFile: path.join(
          linkedGameplayReportDir,
          'protected-gameplay-evidence.json',
        ),
        requireGameplayE2EReport: true,
        gameplayE2EStepId: 'gameplay-e2e',
        options: { profile: 'staging' },
        steps: [{
          id: 'gameplay-e2e',
          label: 'Gameplay E2E',
          command: 'noop',
          cwd: cliGameRoot,
        }],
        commandRunner: () => ({ exitCode: 0 }),
        now: createClock(),
        log: () => undefined,
      }),
      /must not cross symbolic-link ancestors/u,
      'symlinked gameplay report ancestor',
    );
    expectMatch(
      readFileSync(protectedOutsideEvidenceFile, 'utf8'),
      /"schemaVersion":1/u,
      'outside gameplay report preservation',
    );
  } finally {
    unlinkSync(linkedGameplayReportDir);
  }

  const mutableGameplayReportDir = path.join(cliGameRoot, 'mutable-gameplay-report');
  const mutableGameplayReportFile = path.join(
    mutableGameplayReportDir,
    'protected-gameplay-evidence.json',
  );

  mkdirSync(mutableGameplayReportDir);
  writeFileSync(mutableGameplayReportFile, `${JSON.stringify(validGameplayEvidence)}\n`);
  try {
    expectCallError(
      () => runGameAcceptance({
        gameRoot: cliGameRoot,
        reportDir: path.join(cliGameRoot, 'mutable-gameplay-report-output'),
        gameplayE2EReportFile: mutableGameplayReportFile,
        requireGameplayE2EReport: true,
        gameplayE2EStepId: 'gameplay-e2e',
        options: { profile: 'staging' },
        steps: [
          {
            id: 'replace-report-directory',
            label: 'Replace report directory',
            command: 'replace-report-directory',
            cwd: cliGameRoot,
          },
          {
            id: 'gameplay-e2e',
            label: 'Gameplay E2E',
            command: 'noop',
            cwd: cliGameRoot,
          },
        ],
        commandRunner: (step) => {
          if (step.command === 'replace-report-directory') {
            rmSync(mutableGameplayReportDir, { recursive: true });
            symlinkSync(outsideSymlinkedReportDir, mutableGameplayReportDir, 'dir');
          }

          return { exitCode: 0 };
        },
        now: createClock(),
        log: () => undefined,
      }),
      /must not cross symbolic-link ancestors/u,
      'gameplay report deletion time-of-check/time-of-use',
    );
    expectMatch(
      readFileSync(protectedOutsideEvidenceFile, 'utf8'),
      /"schemaVersion":1/u,
      'outside gameplay report preservation after step mutation',
    );
  } finally {
    rmSync(mutableGameplayReportDir, { recursive: true, force: true });
  }

  const outsideGameplayEvidenceFile = path.join(fixtureRoot, 'outside-gameplay-evidence.json');

  writeFileSync(outsideGameplayEvidenceFile, `${JSON.stringify(validGameplayEvidence)}\n`);
  const outsideGameplayEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'outside-evidence-report'),
    gameplayE2EReportFile: outsideGameplayEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectEqual(
    outsideGameplayEvidence.report.evidence.gameplayE2E?.file,
    '<outside-game-root>',
    'outside gameplay evidence display path',
  );
  expectEqual(
    outsideGameplayEvidence.report.evidence.gameplayE2E?.found,
    false,
    'outside gameplay evidence existence probe',
  );
  const outsideValidationError = outsideGameplayEvidence.report.evidence.gameplayE2E
    ?.validationError;

  if (
    typeof outsideValidationError !== 'string'
    || outsideValidationError.includes(fixtureRoot)
  ) {
    throw new Error('Outside gameplay evidence validation must not expose host paths.');
  }

  const outsideReleaseManifestFile = path.join(fixtureRoot, 'outside-release-manifest.json');

  writeFileSync(outsideReleaseManifestFile, '{"targets":{}}\n');
  const outsideReleaseManifest = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'outside-release-report'),
    releaseManifestFile: outsideReleaseManifestFile,
    options: {},
    steps: [],
    now: createClock(),
    log: () => undefined,
  });

  expectEqual(
    outsideReleaseManifest.report.evidence.releaseManifest?.file,
    '<outside-game-root>',
    'outside release manifest display path',
  );
  expectEqual(
    outsideReleaseManifest.report.evidence.releaseManifest?.found,
    false,
    'outside release manifest existence probe',
  );
  const outsideReleaseParseError = outsideReleaseManifest.report.evidence.releaseManifest
    ?.parseError;

  if (
    typeof outsideReleaseParseError !== 'string'
    || outsideReleaseParseError.includes(fixtureRoot)
  ) {
    throw new Error('Outside release manifest validation must not expose host paths.');
  }

  const outsideLinkedEvidenceFile = path.join(cliGameRoot, 'outside-linked-evidence.json');

  writeFileSync(
    outsideLinkedEvidenceFile,
    `${JSON.stringify({
      ...validGameplayEvidence,
      releaseManifest: {
        file: path.relative(cliGameRoot, outsideReleaseManifestFile),
        kind: 'file',
        sha256: 'a'.repeat(64),
      },
    })}\n`,
  );
  const outsideLinkedEvidence = runGameAcceptance({
    gameRoot: cliGameRoot,
    reportDir: path.join(cliGameRoot, 'outside-linked-report'),
    releaseManifestFile: outsideReleaseManifestFile,
    gameplayE2EReportFile: outsideLinkedEvidenceFile,
    requireGameplayE2EReport: true,
    options: { profile: 'staging' },
    steps: [],
    now: createClock(),
    log: () => undefined,
  });
  const outsideLinkedValidationError = outsideLinkedEvidence.report.evidence.gameplayE2E
    ?.validationError;

  if (
    typeof outsideLinkedValidationError !== 'string'
    || !outsideLinkedValidationError.includes('must stay inside the game root')
    || outsideLinkedValidationError.includes(fixtureRoot)
  ) {
    throw new Error(
      'Gameplay evidence must reject outside release manifests without probing them.',
    );
  }

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
      artifact: {
        file: path.relative(cliGameRoot, path.join(fixtureRoot, 'relative-release.json')),
        kind: 'file',
        sha256: 'a'.repeat(64),
      },
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

  expectEqual(unreadableEvidence.report.status, 'failed', 'directory release manifest status');
  expectMatch(
    unreadableEvidence.report.evidence.gameplayE2E?.validationError ?? '',
    /release manifest hash does not match its current contents/u,
    'directory release manifest evidence',
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

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function expectMatch(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    const detail = `${label}: expected to match ${String(pattern)}, received ${String(value)}.`;

    throw new Error(detail);
  }
}

function expectCallError(action: () => unknown, pattern: RegExp, label: string): void {
  let error: unknown;

  try {
    action();
  } catch (caught) {
    error = caught;
  }

  if (error === undefined) {
    throw new Error(`${label}: expected the call to throw.`);
  }

  const message = error instanceof Error ? error.message : String(error);

  if (!pattern.test(message)) {
    const detail = `${label}: expected ${String(pattern)}, received ${message}.`;

    throw new Error(detail, { cause: error });
  }
}

function expectRecordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  return value as Record<string, unknown>;
}

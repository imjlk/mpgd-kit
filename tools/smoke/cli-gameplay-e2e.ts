import assert from 'node:assert/strict';
import {
  existsSync,
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
  parseGameplayE2EPlan,
  readGameplayE2EPlan,
  renderGameplayE2EMarkdown,
  resolveGameplayE2EReportFile,
  runGameplayE2E,
  type GameplayE2EAction,
  type GameplayE2EDriver,
  type GameplayE2EObservation,
  type GameplayE2EPlan,
} from '../../packages/cli/src/index';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-gameplay-e2e-'));
const outsideRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-gameplay-e2e-outside-'));
const artifactFile = path.join(fixtureRoot, 'artifacts/target/app.bin');
const releaseManifestFile = path.join(fixtureRoot, 'artifacts/release-manifest.json');
const gameConfigFile = path.join(fixtureRoot, 'mpgd.game.json');
const reportDir = path.join(fixtureRoot, 'artifacts/gameplay-e2e');
const plan = {
  schemaVersion: 1,
  states: [
    {
      id: 'launch-ready',
      label: 'Launch ready',
      expectation: 'The initial game state is ready for input.',
      actions: [{ type: 'wait', durationMs: 25 }],
    },
    {
      id: 'primary-input',
      label: 'Primary input',
      expectation: 'The game accepts target-normalized input.',
      actions: [
        { type: 'tap', x: 0.5, y: 0.75 },
        { type: 'key', key: 'Enter' },
      ],
    },
    {
      id: 'resume-session',
      label: 'Resume session',
      expectation: 'The active session survives pause and resume.',
      actions: [{ type: 'pause-resume', backgroundMs: 50, expectSameSession: true }],
    },
  ],
} as const satisfies GameplayE2EPlan;

assert.equal(
  resolveGameplayE2EReportFile(fixtureRoot, {}),
  path.join(fixtureRoot, 'artifacts/gameplay-e2e/gameplay-e2e-report.json'),
);
assert.equal(
  resolveGameplayE2EReportFile(fixtureRoot, { MPGD_GAMEPLAY_E2E_REPORT_FILE: 'custom/e2e.json' }),
  path.join(fixtureRoot, 'custom/e2e.json'),
);
expectCallError(
  () => resolveGameplayE2EReportFile(fixtureRoot, {
    MPGD_GAMEPLAY_E2E_REPORT_FILE: path.join(outsideRoot, 'outside-report.json'),
  }),
  /must stay inside the game root/u,
  'outside gameplay report path',
);
expectCallError(
  () => resolveGameplayE2EReportFile(fixtureRoot, {
    MPGD_GAMEPLAY_E2E_REPORT_FILE: 'artifacts/gameplay-e2e/report.md',
  }),
  /must not use a Markdown extension/u,
  'Markdown gameplay JSON report path',
);

assert.throws(() => parseGameplayE2EPlan({ ...plan, unsupported: true }), /unsupported fields/u);
assert.throws(
  () => parseGameplayE2EPlan({
    schemaVersion: 1,
    states: [plan.states[0], { ...plan.states[0] }],
  }),
  /duplicated/u,
);
assert.throws(
  () => parseGameplayE2EPlan({
    schemaVersion: 1,
    states: [{ ...plan.states[0], actions: [{ type: 'tap', x: 1.1, y: 0.5 }] }],
  }),
  /between 0 and 1/u,
);
assert.throws(
  () => parseGameplayE2EPlan({
    schemaVersion: 1,
    states: [{ ...plan.states[0], actions: [{ type: 'key', key: 'Enter\n' }] }],
  }),
  /control characters/u,
);

try {
  // Happy path: load the manifest plan, execute every action, and emit hashed evidence.
  mkdirSync(path.dirname(artifactFile), { recursive: true });
  writeFileSync(artifactFile, 'target artifact\n');
  writeFileSync(releaseManifestFile, '{"schemaVersion":1}\n');
  writeFileSync(gameConfigFile, `${JSON.stringify({
    brand: { appIcon: { source: 'public/icon.svg' } },
    acceptance: { gameplay: plan },
  }, null, 2)}\n`);

  const loaded = readGameplayE2EPlan(fixtureRoot);

  assert.notEqual(loaded, null);
  assert.deepEqual(loaded?.plan, plan);
  const performed: GameplayE2EAction[] = [];
  const lifecycle: string[] = [];
  const driver = createDriver({ performed, lifecycle, sessionId: 'session-1' });
  const passed = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir,
    plan: loaded?.plan ?? plan,
    planFile: gameConfigFile,
    target: 'android',
    profile: 'staging',
    artifactFile,
    releaseManifestFile,
    driver,
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(passed.report.status, 'passed');
  assert.deepEqual(
    passed.report.states.map((state) => state.status),
    ['passed', 'passed', 'passed'],
  );
  assert.deepEqual(performed, [
    { type: 'wait', durationMs: 25 },
    { type: 'tap', x: 0.5, y: 0.75 },
    { type: 'key', key: 'Enter' },
    { type: 'wait', durationMs: 50 },
  ]);
  assert.deepEqual(lifecycle, ['pause', 'resume']);
  assert.match(passed.report.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.match(passed.report.releaseManifest?.sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(passed.report.states[2]?.observation?.sessionId, 'session-1');
  assert.match(readFileSync(passed.jsonFile, 'utf8'), /"target": "android"/u);
  expectTextMatch(
    readFileSync(passed.markdownFile, 'utf8'),
    /Session preserved/u,
    'pause/resume Markdown detail',
  );
  assert.match(renderGameplayE2EMarkdown(passed.report), /Gameplay E2E Report/u);
  await expectAsyncCallError(
    () => runGameplayE2E({
      gameRoot: fixtureRoot,
      reportDir,
      reportFile: 'artifacts/gameplay-e2e/collision.MD',
      plan: loaded?.plan ?? plan,
      planFile: gameConfigFile,
      target: 'android',
      profile: 'staging',
      artifactFile,
      driver,
      now: createClock(),
      log: () => undefined,
    }),
    /must not use a Markdown extension/u,
    'direct Markdown gameplay JSON report path',
  );
  const staleScreenshotReportDir = path.join(fixtureRoot, 'artifacts/stale-screenshot');
  const staleScreenshotFile = path.join(staleScreenshotReportDir, 'screenshots/launch-ready.png');

  mkdirSync(path.dirname(staleScreenshotFile), { recursive: true });
  writeFileSync(staleScreenshotFile, 'stale screenshot\n');
  const staleScreenshot = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: staleScreenshotReportDir,
    plan: loaded?.plan ?? plan,
    planFile: gameConfigFile,
    target: 'android',
    profile: 'staging',
    artifactFile,
    driver: { ...driver, captureScreenshot: async () => undefined },
    now: createClock(),
    log: () => undefined,
  });

  if (staleScreenshot.report.status !== 'failed') {
    throw new Error('A no-op screenshot driver must not reuse stale evidence.');
  }

  expectTextMatch(
    staleScreenshot.report.states[0]?.detail ?? '',
    /Screenshot failed/u,
    'stale screenshot rejection',
  );

  if (existsSync(staleScreenshotFile)) {
    throw new Error('The stale gameplay screenshot must be removed before capture.');
  }

  const outsideArtifactFile = path.join(outsideRoot, 'outside.bin');

  writeFileSync(outsideArtifactFile, 'outside artifact\n');
  const collectOutsideArtifact = () => collectGameplayE2EPathEvidence(
    fixtureRoot,
    outsideArtifactFile,
    'outside artifact',
  );

  expectCallError(
    collectOutsideArtifact,
    /must stay inside the game root/u,
    'outside gameplay evidence path',
  );

  const linkedArtifactsDir = path.join(fixtureRoot, 'linked-artifacts');

  symlinkSync(outsideRoot, linkedArtifactsDir, 'dir');
  const collectSymlinkedArtifact = () => collectGameplayE2EPathEvidence(
    fixtureRoot,
    path.join(linkedArtifactsDir, 'outside.bin'),
    'symlinked artifact',
  );

  try {
    expectCallError(
      collectSymlinkedArtifact,
      /must not cross symbolic-link ancestors/u,
      'symlinked gameplay evidence ancestor',
    );
  } finally {
    unlinkSync(linkedArtifactsDir);
  }

  const linkedReportsDir = path.join(fixtureRoot, 'linked-reports');

  symlinkSync(outsideRoot, linkedReportsDir, 'dir');

  try {
    await expectAsyncCallError(
      () => runGameplayE2E({
        gameRoot: fixtureRoot,
        reportDir: linkedReportsDir,
        plan: loaded?.plan ?? plan,
        planFile: gameConfigFile,
        target: 'android',
        profile: 'staging',
        artifactFile,
        driver,
        now: createClock(),
        log: () => undefined,
      }),
      /must not cross symbolic-link ancestors/u,
      'symlinked gameplay report directory',
    );
  } finally {
    unlinkSync(linkedReportsDir);
  }

  let mismatchedPlanError: unknown;
  let mismatchedPlanRejected = false;

  try {
    await runGameplayE2E({
      gameRoot: fixtureRoot,
      reportDir: path.join(fixtureRoot, 'artifacts/mismatched-plan'),
      plan: { schemaVersion: 1, states: [plan.states[0]] },
      planFile: gameConfigFile,
      target: 'android',
      profile: 'staging',
      artifactFile,
      driver,
      now: createClock(),
      log: () => undefined,
    });
  } catch (error) {
    mismatchedPlanRejected = true;
    mismatchedPlanError = error;
  }

  if (!mismatchedPlanRejected) {
    throw new Error('Expected a mismatched gameplay plan to be rejected.');
  }

  expectErrorMatch(mismatchedPlanError, /must match the linked manifest plan file/u);
  const collectBoundedArtifact = () => collectGameplayE2EPathEvidence(
    fixtureRoot,
    artifactFile,
    'bounded artifact',
    { maximumDepth: 10, maximumEntries: 10, maximumTotalFileBytes: 4 },
  );

  expectCallError(collectBoundedArtifact, /maximum hashed bytes/u, 'bounded artifact bytes');
  const entryLimitedArtifactDir = path.join(fixtureRoot, 'artifacts/entry-limited');

  mkdirSync(entryLimitedArtifactDir);
  writeFileSync(path.join(entryLimitedArtifactDir, 'a.bin'), 'a\n');
  writeFileSync(path.join(entryLimitedArtifactDir, 'b.bin'), 'b\n');
  expectCallError(
    () => collectGameplayE2EPathEvidence(
      fixtureRoot,
      entryLimitedArtifactDir,
      'entry-limited artifact',
      { maximumDepth: 10, maximumEntries: 2, maximumTotalFileBytes: 100 },
    ),
    /maximum hash entries 2/u,
    'bounded artifact entries',
  );

  // Session mismatch: continuity failure stops later states while still capturing evidence.
  const mismatchLifecycle: string[] = [];
  let inspectCount = 0;
  const mismatchPlan = {
    schemaVersion: 1,
    states: [
      plan.states[2],
      { id: 'never-run', label: 'Never run', actions: [] },
    ],
  } as const satisfies GameplayE2EPlan;
  const mismatchConfigFile = path.join(fixtureRoot, 'mpgd.mismatch.json');

  writeFileSync(mismatchConfigFile, `${JSON.stringify({
    acceptance: { gameplay: mismatchPlan },
  })}\n`);
  const mismatch = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'artifacts/mismatch'),
    plan: mismatchPlan,
    planFile: mismatchConfigFile,
    target: 'ios',
    profile: 'staging',
    artifactFile,
    driver: {
      ...createDriver({ performed: [], lifecycle: mismatchLifecycle, sessionId: 'before' }),
      inspect: async ({ phase }) => {
        inspectCount += 1;
        return observation(phase === 'resumed' ? 'after' : 'before');
      },
    },
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(mismatch.report.status, 'failed');
  assert.deepEqual(
    mismatch.report.states.map((state) => state.status),
    ['failed', 'skipped'],
  );
  assert.deepEqual(mismatchLifecycle, ['pause', 'resume']);
  assert.ok(inspectCount >= 3);
  assert.match(mismatch.report.states[0]?.detail ?? '', /did not preserve its session/u);

  // Resume safety: resume is attempted even when the background wait fails.
  const resumeAfterFailure: string[] = [];
  const failingWaitDriver = createDriver({
    performed: [],
    lifecycle: resumeAfterFailure,
    sessionId: 'session-2',
    failWait: true,
  });
  const resumePlan = {
    schemaVersion: 1,
    states: [plan.states[2]],
  } as const satisfies GameplayE2EPlan;
  const resumeConfigFile = path.join(fixtureRoot, 'mpgd.resume.json');

  writeFileSync(resumeConfigFile, `${JSON.stringify({
    acceptance: { gameplay: resumePlan },
  })}\n`);
  const waitFailure = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'artifacts/wait-failure'),
    plan: resumePlan,
    planFile: resumeConfigFile,
    target: 'android',
    profile: 'staging',
    artifactFile,
    driver: failingWaitDriver,
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(waitFailure.report.status, 'failed');
  assert.deepEqual(resumeAfterFailure, ['pause', 'resume']);
  assert.match(waitFailure.report.states[0]?.detail ?? '', /fixture wait failure/u);

  const dualFailureLifecycle: string[] = [];
  const dualFailure = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'artifacts/dual-failure'),
    plan: resumePlan,
    planFile: resumeConfigFile,
    target: 'android',
    profile: 'staging',
    artifactFile,
    driver: createDriver({
      performed: [],
      lifecycle: dualFailureLifecycle,
      sessionId: 'session-3',
      failWait: true,
      failResume: true,
    }),
    now: createClock(),
    log: () => undefined,
  });

  assert.equal(dualFailure.report.status, 'failed');
  assert.deepEqual(dualFailureLifecycle, ['pause', 'resume']);
  assert.match(dualFailure.report.states[0]?.detail ?? '', /fixture wait failure/u);
  assert.match(dualFailure.report.states[0]?.detail ?? '', /fixture resume failure/u);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

console.log('CLI gameplay E2E smoke passed.');

function createDriver(input: {
  readonly performed: GameplayE2EAction[];
  readonly lifecycle: string[];
  readonly sessionId: string;
  readonly failWait?: boolean;
  readonly failResume?: boolean;
}): GameplayE2EDriver {
  return {
    perform: async (action) => {
      input.performed.push(action);

      if (input.failWait === true && action.type === 'wait') {
        throw new Error('fixture wait failure');
      }
    },
    pause: async () => {
      input.lifecycle.push('pause');
    },
    resume: async () => {
      input.lifecycle.push('resume');

      if (input.failResume === true) {
        throw new Error('fixture resume failure');
      }
    },
    inspect: async () => observation(input.sessionId),
    captureScreenshot: async ({ file, state }) => {
      writeFileSync(file, `screenshot:${state.id}\n`);
    },
  };
}

function observation(sessionId: string): GameplayE2EObservation {
  return {
    passed: true,
    sessionId,
    detail: 'fixture state matched',
    metadata: { ready: true },
  };
}

function createClock(): () => number {
  // A fixed epoch keeps generated reports deterministic across test runs.
  let value = Date.UTC(2026, 6, 14);

  return () => {
    value += 10;
    return value;
  };
}

function expectErrorMatch(value: unknown, pattern: RegExp): void {
  const message = value instanceof Error ? value.message : String(value);

  if (!pattern.test(message)) {
    throw new Error(`Expected error to match ${String(pattern)}, received ${message}.`);
  }
}

function expectTextMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${label}: expected ${String(pattern)} in ${value}.`);
  }
}

function expectCallError(action: () => unknown, pattern: RegExp, label: string): void {
  let error: unknown;

  try {
    action();
  } catch (caught) {
    error = caught;
  }

  assertExpectedError(error, pattern, label, 'throw');
}

async function expectAsyncCallError(
  action: () => Promise<unknown>,
  pattern: RegExp,
  label: string,
): Promise<void> {
  let error: unknown;

  try {
    await action();
  } catch (caught) {
    error = caught;
  }

  assertExpectedError(error, pattern, label, 'reject');
}

function assertExpectedError(
  error: unknown,
  pattern: RegExp,
  label: string,
  behavior: 'reject' | 'throw',
): void {
  if (error === undefined) {
    throw new Error(`${label}: expected the call to ${behavior}.`);
  }

  const message = error instanceof Error ? error.message : String(error);

  if (!pattern.test(message)) {
    const detail = `${label}: expected ${String(pattern)}, received ${message}.`;

    throw new Error(detail, { cause: error });
  }
}

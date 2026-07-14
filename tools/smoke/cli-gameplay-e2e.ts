import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
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
      actions: [{ type: 'pause-resume', backgroundMs: 50 }],
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

try {
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
  assert.match(readFileSync(passed.markdownFile, 'utf8'), /Session preserved/u);
  assert.match(renderGameplayE2EMarkdown(passed.report), /Gameplay E2E Report/u);

  const mismatchLifecycle: string[] = [];
  let inspectCount = 0;
  const mismatch = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'artifacts/mismatch'),
    plan: {
      schemaVersion: 1,
      states: [
        plan.states[2],
        { id: 'never-run', label: 'Never run', actions: [] },
      ],
    },
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

  const resumeAfterFailure: string[] = [];
  const failingWaitDriver = createDriver({
    performed: [],
    lifecycle: resumeAfterFailure,
    sessionId: 'session-2',
    failWait: true,
  });
  const waitFailure = await runGameplayE2E({
    gameRoot: fixtureRoot,
    reportDir: path.join(fixtureRoot, 'artifacts/wait-failure'),
    plan: { schemaVersion: 1, states: [plan.states[2]] },
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
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('CLI gameplay E2E smoke passed.');

function createDriver(input: {
  readonly performed: GameplayE2EAction[];
  readonly lifecycle: string[];
  readonly sessionId: string;
  readonly failWait?: boolean;
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
  let value = Date.UTC(2026, 6, 14);

  return () => {
    value += 10;
    return value;
  };
}

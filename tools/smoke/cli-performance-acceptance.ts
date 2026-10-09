import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGameAcceptance } from '../../packages/cli/src/game-acceptance';
import { collectGameplayE2EPathEvidence } from '../../packages/cli/src/gameplay-e2e';
import {
  preparePerformanceAcceptance,
  validatePerformanceBudget,
} from '../../packages/cli/src/performance-acceptance';

const root = mkdtempSync(join(tmpdir(), 'mpgd-performance-acceptance-'));
const budgetFile = join(root, 'agent/performance.budget.json');
const reportFile = join(root, 'artifacts/performance/report.json');
const artifactFile = join(root, 'dist/index.html');
const releaseFile = join(root, 'artifacts/release-manifest.json');
const budget = {
  schemaVersion: 1,
  profiles: [
    {
      id: 'steady',
      target: 'web-preview',
      scenario: 'steady',
      renderer: 'webgl',
      device: 'desktop',
      minSamples: 3,
      metrics: { update: { p95: 5, p99: 6, max: 7 }, intervalMs: { p95: 18, p99: 20, max: 22 } },
      maxExcludedFrames: 0,
      maxHeapGrowthBytes: 512,
      hitchThresholdMs: 50,
      maxHitches: 1,
    },
  ],
};
let clock = 1_000_000;
const writeBudget = () => writeFileSync(budgetFile, JSON.stringify(budget));
function fixtureReport() {
  return {
    schemaVersion: 1,
    generatedAt: new Date(clock).toISOString(),
    profile: 'staging',
    budget: collectGameplayE2EPathEvidence(root, budgetFile, 'budget'),
    measurements: [
      {
        id: 'steady',
        context: {
          target: 'web-preview',
          scenario: 'steady',
          renderer: 'webgl',
          device: 'desktop',
          devicePixelRatio: 2,
          foreground: true,
          instrumentation: { trace: false, screenshots: false },
          logicalWidth: 400,
          logicalHeight: 600,
          backingWidth: 800,
          backingHeight: 1200,
        },
        artifact: collectGameplayE2EPathEvidence(root, artifactFile, 'artifact'),
        snapshot: {
          frames: 4,
          excludedFrames: 0,
          retainedSamples: 3,
          metrics: { update: { p50: 2, p95: 4, p99: 5 }, intervalMs: { p50: 16, p95: 17, p99: 18 } },
          maximums: { update: 6, intervalMs: 20 },
          sampleCounts: { update: 3, intervalMs: 3 },
        },
        heapGrowthBytes: 400,
        hitches: { thresholdMs: 50, count: 0, samples: 3 },
      },
    ],
  };
}
function accept(modify?: (value: ReturnType<typeof fixtureReport>) => void, omit = false) {
  writeBudget();
  writeFileSync(reportFile, JSON.stringify({ generatedAt: new Date(0).toISOString() }));
  return runGameAcceptance({
    gameRoot: root,
    reportDir: join(root, 'acceptance'),
    releaseManifestFile: releaseFile,
    performance: { budgetFile, reportFile, stepId: 'performance', targets: ['web-preview'] },
    options: { profile: 'staging' },
    steps: [
      {
        id: 'performance',
        label: 'Performance',
        command: 'pnpm',
        args: ['run', 'performance:e2e'],
        cwd: root,
      },
    ],
    now: () => clock++,
    log: () => undefined,
    commandRunner: () => {
      assert.equal(existsSync(reportFile), false, 'Old evidence must be removed before collecting');
      if (!omit) {
        const report = fixtureReport();
        modify?.(report);
        writeFileSync(reportFile, JSON.stringify(report));
      }
      return { exitCode: 0 };
    },
  }).report;
}
try {
  mkdirSync(join(root, 'agent'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'artifacts/performance'), { recursive: true });
  writeFileSync(artifactFile, 'tested build');
  writeFileSync(
    releaseFile,
    JSON.stringify({
      targets: { 'web-preview': { artifact: 'dist/index.html', profile: 'staging' } },
    }),
  );
  const passed = accept();
  assert.equal(passed.status, 'passed');
  assert.equal(passed.evidence.performance?.validationError, null);
  assert.match(
    readFileSync(join(root, 'acceptance/acceptance-report.md'), 'utf8'),
    /Performance Evidence/,
  );
  const cases: readonly [string, (report: ReturnType<typeof fixtureReport>) => void][] = [
    [
      'samples',
      (report) => {
        report.measurements[0]!.snapshot.sampleCounts.update = 2;
      },
    ],
    [
      'budget',
      (report) => {
        Object.assign(report.measurements[0]!.snapshot.metrics.update, { p95: 8, p99: 9 });
        report.measurements[0]!.snapshot.maximums.update = 9;
      },
    ],
    [
      'foreground',
      (report) => {
        report.measurements[0]!.context.foreground = false;
      },
    ],
    [
      'untraced',
      (report) => {
        report.measurements[0]!.context.instrumentation.trace = true;
      },
    ],
    [
      'renderer',
      (report) => {
        report.measurements[0]!.context.renderer = 'canvas';
      },
    ],
    [
      'hash',
      (report) => {
        report.measurements[0]!.artifact = { ...report.measurements[0]!.artifact, sha256: '0'.repeat(64) };
      },
    ],
    [
      'excluded',
      (report) => {
        report.measurements[0]!.snapshot.excludedFrames = 1;
      },
    ],
    [
      'heap',
      (report) => {
        report.measurements[0]!.heapGrowthBytes = 513;
      },
    ],
    [
      'hitches',
      (report) => {
        report.measurements[0]!.hitches.count = 2;
      },
    ],
    [
      'timestamp',
      (report) => {
        report.generatedAt = new Date(0).toISOString();
      },
    ],
    [
      'timestamp',
      (report) => {
        report.generatedAt = new Date(clock + 1000).toISOString();
      },
    ],
    [
      'profile',
      (report) => {
        report.profile = 'production';
      },
    ],
    [
      'every budget',
      (report) => {
        report.measurements = [];
      },
    ],
    [
      'number',
      (report) => {
        report.measurements[0]!.snapshot.metrics.update.p95 = Number.NaN;
      },
    ],
    [
      'inconsistent',
      (report) => {
        report.measurements[0]!.snapshot.metrics.update.p50 = 10;
      },
    ],
    [
      'changed',
      (report) => {
        writeFileSync(
          budgetFile,
          JSON.stringify({ ...budget, profiles: [{ ...budget.profiles[0], minSamples: 2 }] }),
        );
        report.budget = collectGameplayE2EPathEvidence(root, budgetFile, 'budget');
      },
    ],
    [
      'release target',
      (report) => {
        report.measurements[0]!.artifact = collectGameplayE2EPathEvidence(root, budgetFile, 'different artifact');
      },
    ],
  ];
  for (const [message, modify] of cases) {
    const result = accept(modify);
    assert.equal(result.status, 'failed', message);
    assert.ok(
      result.evidence.performance?.validationError?.toLowerCase().includes(message),
      result.evidence.performance?.validationError ?? message,
    );
  }
  assert.equal(
    accept(undefined, true).status,
    'failed',
    'Success exit without a fresh report must fail',
  );
  writeBudget();
  for (const name of ['acceptance-report.json', 'acceptance-report.md']) {
    const handoffFile = join(root, 'acceptance', name);
    for (const collision of ['budget', 'report']) {
      if (collision === 'budget') {
        writeFileSync(handoffFile, JSON.stringify(budget));
      }
      const before = readFileSync(handoffFile, 'utf8');
      let ran = false;
      assert.throws(
        () =>
          runGameAcceptance({
            gameRoot: root,
            reportDir: join(root, 'acceptance'),
            options: {},
            performance: {
              budgetFile: collision === 'budget' ? handoffFile : budgetFile,
              reportFile: collision === 'report' ? handoffFile : reportFile,
              stepId: 'performance',
              targets: ['web-preview'],
            },
            steps: [{ id: 'performance', label: 'Performance', command: 'pnpm', cwd: root }],
            commandRunner: () => {
              ran = true;
              return { exitCode: 0 };
            },
            log: () => undefined,
          }),
        /handoff/u,
      );
      assert.equal(ran, false, 'Collisions must be rejected before collection');
      assert.equal(
        readFileSync(handoffFile, 'utf8'),
        before,
        'Rejected inputs must preserve handoff files',
      );
    }
  }
  for (const field of ['constructor', 'prototype', 'update-cost', '1update', 'x'.repeat(65)]) {
    assert.throws(
      () =>
        validatePerformanceBudget({
          ...budget,
          profiles: [{ ...budget.profiles[0], metrics: { [field]: { p95: 1 } } }],
        }),
      /metric name/u,
    );
  }
  const customMetrics = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`field${index}`, { p95: 1 }]),
  );
  assert.doesNotThrow(() =>
    validatePerformanceBudget({
      ...budget,
      profiles: [
        {
          ...budget.profiles[0],
          metrics: { ...customMetrics, intervalMs: { p95: 1 }, totalCpuMs: { p95: 1 } },
        },
      ],
    }),
  );
  assert.throws(
    () =>
      validatePerformanceBudget({
        ...budget,
        profiles: [{ ...budget.profiles[0], metrics: { ...customMetrics, extra: { p95: 1 } } }],
      }),
    /metric budgets/u,
  );
  assert.throws(() =>
    preparePerformanceAcceptance(root, {
      budgetFile,
      reportFile: join(root, '../escaped.json'),
      stepId: 'performance',
      targets: ['web-preview'],
    }),
  );
  assert.throws(
    () =>
      preparePerformanceAcceptance(root, {
        budgetFile,
        reportFile: budgetFile,
        stepId: 'performance',
        targets: ['web-preview'],
      }),
    /overwrite/,
  );
  assert.throws(
    () =>
      validatePerformanceBudget({ ...budget, profiles: [...budget.profiles, ...budget.profiles] }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validatePerformanceBudget({ ...budget, profiles: [{ ...budget.profiles[0], minSamples: 1 }] }),
    /minSamples/,
  );
  assert.throws(
    () =>
      validatePerformanceBudget({
        ...budget,
        profiles: [{ ...budget.profiles[0], metrics: { update: { p100: 1 } } }],
      }),
    /unknown/,
  );
  assert.throws(
    () =>
      validatePerformanceBudget({
        ...budget,
        profiles: [{ ...budget.profiles[0], maxHitches: undefined }],
      }),
    /hitch/,
  );
  const defaultAcceptance = runGameAcceptance({
    gameRoot: root,
    reportDir: join(root, 'no-performance'),
    options: {},
    steps: [],
    log: () => undefined,
  });
  assert.equal('performance' in defaultAcceptance.report.evidence, false);
  console.info(
    'Performance acceptance smoke passed: fresh reports, authored budgets, samples, context, hashes and optional default behavior.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

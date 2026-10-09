import { existsSync } from 'node:fs';
import path from 'node:path';
import { formatError, readBoundedUtf8File, relativeOrAbsolute } from './evidence-io.js';
import {
  collectGameplayE2EPathEvidence,
  resolveGameplayE2EPathInsideGameRoot,
  type GameplayE2EPathEvidence,
} from './gameplay-e2e.js';

export const maximumPerformanceEvidenceBytes = 1_024 * 1_024;

export interface PerformanceMetricBudget {
  readonly p95?: number;
  readonly p99?: number;
  readonly max?: number;
}
export interface PerformanceBudgetProfile {
  readonly id: string;
  readonly target: string;
  readonly scenario: string;
  readonly renderer: string;
  readonly device: string;
  readonly minSamples: number;
  readonly metrics: Readonly<Record<string, PerformanceMetricBudget>>;
  readonly maxExcludedFrames?: number;
  readonly maxHeapGrowthBytes?: number;
  readonly hitchThresholdMs?: number;
  readonly maxHitches?: number;
}
export interface PerformanceBudget {
  readonly schemaVersion: 1;
  readonly profiles: readonly PerformanceBudgetProfile[];
}
export interface PerformanceAcceptanceInput {
  readonly budgetFile: string;
  readonly reportFile: string;
  readonly stepId: string;
  readonly targets: readonly string[];
}
export interface PreparedPerformanceAcceptance {
  readonly budget: PerformanceBudget;
  readonly budgetEvidence: GameplayE2EPathEvidence;
  readonly reportFile: string;
}
export interface PerformanceAcceptanceEvidence {
  readonly file: string;
  readonly found: boolean;
  readonly validationError: string | null;
  readonly budget: GameplayE2EPathEvidence;
  readonly report: GameplayE2EPathEvidence | null;
  readonly value: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}
function number(value: unknown, label: string, signed = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) {
    throw new Error(`${label} must be a finite ${signed ? '' : 'non-negative '}number.`);
  }
  return value;
}
function count(value: unknown, label: string, min = 0): number {
  const n = number(value, label);
  if (!Number.isSafeInteger(n) || n < min || n > 1_000_000_000) {
    throw new Error(`${label} must be an integer between ${min} and 1000000000.`);
  }
  return n;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unknown field.`);
  }
}

/** Consumer-authored budgets: no universal device/FPS thresholds are supplied. */
export function validatePerformanceBudget(value: unknown): PerformanceBudget {
  const input = record(value, 'Performance budget');
  keys(input, ['schemaVersion', 'profiles'], 'Performance budget');
  if (input.schemaVersion !== 1 || !Array.isArray(input.profiles)
    || input.profiles.length === 0 || input.profiles.length > 64) {
    throw new Error('Performance budget needs schemaVersion 1 and 1–64 profiles.');
  }
  const ids = new Set<string>();
  const profiles = input.profiles.map((item: unknown) => {
    const profile = record(item, 'Performance profile');
    keys(profile, ['id', 'target', 'scenario', 'renderer', 'device', 'minSamples', 'metrics',
      'maxExcludedFrames', 'maxHeapGrowthBytes', 'hitchThresholdMs', 'maxHitches'], 'Performance profile');
    for (const name of ['id', 'target', 'scenario', 'renderer', 'device']) {
      text(profile[name], `Performance profile ${name}`);
    }
    const id = text(profile.id, 'Performance profile id');
    if (ids.has(id)) { throw new Error(`Duplicate performance profile: ${id}`); }
    ids.add(id);
    count(profile.minSamples, `${id} minSamples`, 2);
    const metrics = record(profile.metrics, `${id} metrics`);
    const metricNames = Object.keys(metrics);
    const builtInMetrics = ['intervalMs', 'totalCpuMs'];
    const customNames = metricNames.filter((field) => !builtInMetrics.includes(field));
    if (metricNames.length === 0 || customNames.length > 64) {
      throw new Error(`${id} needs 1–66 metric budgets.`);
    }
    if (customNames.some((field) => field.length > 64 || !/^[a-z][a-zA-Z0-9]*$/.test(field)
      || ['constructor', 'prototype'].includes(field))) {
      throw new Error(`${id} has an invalid profiler metric name.`);
    }
    for (const [field, itemBudget] of Object.entries(metrics)) {
      text(field, 'Performance metric name');
      const budget = record(itemBudget, `${id}/${field} budget`);
      keys(budget, ['p95', 'p99', 'max'], `${id}/${field} budget`);
      if (Object.keys(budget).length === 0) { throw new Error(`${id}/${field} needs a threshold.`); }
      for (const [quantile, threshold] of Object.entries(budget)) {
        number(threshold, `${id}/${field}/${quantile}`);
      }
    }
    for (const name of ['maxHeapGrowthBytes', 'hitchThresholdMs']) {
      if (profile[name] !== undefined) { number(profile[name], `${id} ${name}`); }
    }
    for (const name of ['maxExcludedFrames', 'maxHitches']) {
      if (profile[name] !== undefined) { count(profile[name], `${id} ${name}`); }
    }
    if ((profile.maxHitches === undefined) !== (profile.hitchThresholdMs === undefined)
      || profile.hitchThresholdMs === 0) {
      throw new Error(`${id} hitch budgets need maxHitches and a positive hitchThresholdMs.`);
    }
    const snapshot = structuredClone(profile) as unknown as PerformanceBudgetProfile;
    for (const metric of Object.values(snapshot.metrics)) { Object.freeze(metric); }
    Object.freeze(snapshot.metrics);
    return Object.freeze(snapshot);
  });
  return Object.freeze({ schemaVersion: 1, profiles: Object.freeze(profiles) });
}

function readJson(file: string, label: string): unknown {
  const content = readBoundedUtf8File(file, maximumPerformanceEvidenceBytes);
  if (content === null) {
    throw new Error(`${label} exceeds its byte limit.`);
  }
  return JSON.parse(content) as unknown;
}
function evidence(gameRoot: string, value: unknown, label: string): GameplayE2EPathEvidence {
  const input = record(value, label);
  const file = text(input.file, `${label} file`);
  const current = collectGameplayE2EPathEvidence(gameRoot, file, label);
  if (current.kind === 'symbolic-link' || current.kind !== input.kind || current.sha256 !== input.sha256) {
    throw new Error(`${label} no longer matches its current file/directory hash.`);
  }
  return current;
}

export function preparePerformanceAcceptance(
  gameRoot: string,
  input: PerformanceAcceptanceInput,
): PreparedPerformanceAcceptance {
  const budgetFile = resolveGameplayE2EPathInsideGameRoot(
    gameRoot,
    input.budgetFile,
    'Performance budget',
  );
  const reportFile = resolveGameplayE2EPathInsideGameRoot(
    gameRoot,
    input.reportFile,
    'Performance report',
  );
  if (budgetFile === reportFile) {
    throw new Error('Performance report must not overwrite its budget.');
  }
  const budget = validatePerformanceBudget(readJson(budgetFile, 'Performance budget'));
  if (budget.profiles.some((profile) => !input.targets.includes(profile.target))) {
    throw new Error('Performance budget targets must belong to the selected acceptance targets.');
  }
  const budgetEvidence = collectGameplayE2EPathEvidence(gameRoot, budgetFile, 'Performance budget');
  if (budgetEvidence.kind !== 'file') {
    throw new Error('Performance budget must be a regular file.');
  }
  return Object.freeze({ budget, budgetEvidence: Object.freeze(budgetEvidence), reportFile });
}

/** Accept only fresh untraced foreground measurements with matching authored
 * context, adequate sample counts and current artifact/budget provenance. */
export function readPerformanceAcceptanceEvidence(input: {
  readonly gameRoot: string;
  readonly prepared: PreparedPerformanceAcceptance;
  readonly startedAtMs: number | undefined;
  readonly finishedAtMs: number;
  readonly profile: string | undefined;
  readonly releaseManifestFile?: string | undefined;
}): PerformanceAcceptanceEvidence {
  const { gameRoot, prepared } = input;
  const result: PerformanceAcceptanceEvidence = {
    file: relativeOrAbsolute(gameRoot, prepared.reportFile),
    found: false,
    validationError: null,
    budget: prepared.budgetEvidence,
    report: null,
    value: null,
  };
  let value: unknown;
  try {
    const file = resolveGameplayE2EPathInsideGameRoot(
      gameRoot,
      prepared.reportFile,
      'Performance report',
    );
    if (!existsSync(file)) {
      throw new Error('Performance collector did not produce its report.');
    }
    value = readJson(file, 'Performance report');
    const reportEvidence = collectGameplayE2EPathEvidence(gameRoot, file, 'Performance report');
    const report = record(value, 'Performance report');
    if (report.schemaVersion !== 1 || input.startedAtMs === undefined) {
      throw new Error('Performance report needs schemaVersion 1 and a completed collection step.');
    }
    text(report.profile, 'Performance report profile');
    const at = Date.parse(text(report.generatedAt, 'Performance generatedAt'));
    if (!Number.isFinite(at) || new Date(at).toISOString() !== report.generatedAt
      || at < input.startedAtMs || at > input.finishedAtMs) {
      throw new Error('Performance report timestamp must be inside this collection run.');
    }
    if (input.profile !== undefined && report.profile !== input.profile) {
      throw new Error('Performance report profile must match acceptance.');
    }
    const currentBudget = evidence(gameRoot, report.budget, 'Performance budget');
    if (currentBudget.file !== prepared.budgetEvidence.file
      || currentBudget.sha256 !== prepared.budgetEvidence.sha256) {
      throw new Error('Performance budget changed during acceptance.');
    }
    if (!Array.isArray(report.measurements) || report.measurements.length !== prepared.budget.profiles.length) {
      throw new Error('Performance report must cover every budget profile exactly once.');
    }
    const seen = new Set<string>();
    const release = input.releaseManifestFile === undefined
      ? undefined
      : record(readJson(input.releaseManifestFile, 'Release manifest'), 'Release manifest');
    for (const item of report.measurements) {
      const measurement = record(item, 'Performance measurement');
      const id = text(measurement.id, 'Performance measurement id');
      const budget = prepared.budget.profiles.find((profile) => profile.id === id);
      if (budget === undefined || seen.has(id)) {
        throw new Error('Performance measurements have missing/duplicate profiles.');
      }
      seen.add(id);
      const context = record(measurement.context, `${id} context`);
      for (const name of ['target', 'scenario', 'renderer', 'device'] as const) {
        if (context[name] !== budget[name]) {
          throw new Error(`${id} ${name} does not match its budget.`);
        }
      }
      const dpr = number(context.devicePixelRatio, `${id} devicePixelRatio`);
      if (dpr === 0 || dpr > 64 || context.foreground !== true) {
        throw new Error(`${id} must record a positive DPR and foreground measurement.`);
      }
      const instrumentation = record(context.instrumentation, `${id} instrumentation`);
      if (instrumentation.trace !== false || instrumentation.screenshots !== false) {
        throw new Error(`${id} needs an untraced measurement without screenshot capture.`);
      }
      for (const name of ['logicalWidth', 'logicalHeight', 'backingWidth', 'backingHeight']) {
        if (number(context[name], `${id} ${name}`) === 0) {
          throw new Error(`${id} dimensions must be positive.`);
        }
      }
      const artifact = evidence(gameRoot, measurement.artifact, `${id} target artifact`);
      if (release !== undefined) {
        const target = record(
          record(release.targets, 'Release targets')[budget.target],
          `${id} release target`,
        );
        if (typeof target.artifact !== 'string'
          || path.resolve(gameRoot, target.artifact) !== path.resolve(gameRoot, artifact.file)
          || (target.profile !== undefined && target.profile !== report.profile)) {
          throw new Error(`${id} artifact/profile differs from the release target.`);
        }
      }
      const snapshot = record(measurement.snapshot, `${id} snapshot`);
      const metrics = record(snapshot.metrics, `${id} metrics`);
      const maximums = record(snapshot.maximums, `${id} maximums`);
      const samples = record(snapshot.sampleCounts, `${id} sampleCounts`);
      const retained = count(snapshot.retainedSamples, `${id} retainedSamples`);
      const frames = count(snapshot.frames, `${id} frames`);
      const excluded = count(snapshot.excludedFrames, `${id} excludedFrames`);
      if (frames < retained || (budget.maxExcludedFrames !== undefined && excluded > budget.maxExcludedFrames)) {
        throw new Error(`${id} has inconsistent frame counts or too many excluded frames.`);
      }
      for (const [field, thresholds] of Object.entries(budget.metrics)) {
        const n = count(samples[field], `${id}/${field} sampleCount`);
        if (n < budget.minSamples || n > retained) {
          throw new Error(`${id}/${field} has insufficient/inconsistent samples.`);
        }
        const quantiles = record(metrics[field], `${id}/${field} quantiles`);
        const p50 = number(quantiles.p50, `${id}/${field} p50`);
        const p95 = number(quantiles.p95, `${id}/${field} p95`);
        const p99 = number(quantiles.p99, `${id}/${field} p99`);
        const max = number(maximums[field], `${id}/${field} max`);
        if (p50 > p95 || p95 > p99 || p99 > max) {
          throw new Error(`${id}/${field} quantiles are inconsistent.`);
        }
        for (const [key, threshold] of Object.entries(thresholds)) {
          const measured = key === 'max' ? max : number(quantiles[key], `${id}/${field}/${key}`);
          if (measured > threshold) {
            throw new Error(`${id}/${field} ${key} exceeds its budget.`);
          }
        }
      }
      if (budget.maxHeapGrowthBytes !== undefined
        && number(measurement.heapGrowthBytes, `${id} heapGrowthBytes`, true) > budget.maxHeapGrowthBytes) {
        throw new Error(`${id} heap growth exceeds its budget.`);
      }
      if (budget.maxHitches !== undefined) {
        const hitches = record(measurement.hitches, `${id} hitches`);
        const n = count(hitches.count, `${id} hitch count`);
        const total = count(hitches.samples, `${id} hitch samples`, budget.minSamples);
        if (n > total || n > budget.maxHitches || hitches.thresholdMs !== budget.hitchThresholdMs) {
          throw new Error(`${id} hitches exceed or do not match their budget.`);
        }
      }
    }
    return { ...result, found: true, report: reportEvidence, value };
  } catch (error) {
    return {
      ...result,
      found: existsSync(prepared.reportFile),
      validationError: formatError(error),
      value: value ?? null,
    };
  }
}

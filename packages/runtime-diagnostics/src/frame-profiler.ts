/** Maximum retained frames and named fields keep snapshot work bounded. */
export const MAX_FRAME_PROFILE_CAPACITY = 1_000;
export const MAX_FRAME_PROFILE_FIELDS = 64;

export interface FramePercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export type FrameProfileSample<Field extends string> = Record<
  Field | 'intervalMs' | 'totalCpuMs', number
>;

export interface FrameProfileSnapshot<Field extends string> {
  frames: number;
  excludedFrames: number;
  retainedSamples: number;
  current: FrameProfileSample<Field>;
  metrics: Record<Field | 'intervalMs' | 'totalCpuMs', FramePercentiles>;
  maximums: FrameProfileSample<Field>;
  sampleCounts: FrameProfileSample<Field>;
}

/**
 * Synchronous CPU costs and consumer-owned numeric counters on an injected clock.
 * No observers, engine, browser globals, GPU timings, or I/O are installed.
 */
export class NamedFrameProfiler<Field extends string> {
  readonly current: FrameProfileSample<Field>;
  private readonly keys: readonly (Field | 'intervalMs' | 'totalCpuMs')[];
  private readonly fields: readonly Field[];
  private readonly samples: FrameProfileSample<Field>[] = [];
  private cursor = 0;
  private start = 0;
  private previousStart: number | null = null;
  private lastClock: number | null = null;
  private excluded = false;
  private active = false;
  private measuring = 0;
  private frames = 0;
  private excludedFrames = 0;

  constructor(
    fields: readonly Field[],
    private readonly now: () => number,
    private readonly capacity = 300,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_FRAME_PROFILE_CAPACITY) {
      throw new Error(
        `Frame profile capacity must be an integer from 1 to ${MAX_FRAME_PROFILE_CAPACITY}.`,
      );
    }
    if (typeof now !== 'function') {
      throw new Error('Frame profile clock must be a function.');
    }
    if (!Array.isArray(fields) || fields.length > MAX_FRAME_PROFILE_FIELDS
      || new Set(fields).size !== fields.length || Array.from(fields).some((field) =>
        typeof field !== 'string' || field.length > 64 || !/^[a-z][a-zA-Z0-9]*$/.test(field)
        || ['intervalMs', 'totalCpuMs', 'constructor', 'prototype'].includes(field))) {
      throw new Error('Invalid or duplicate frame metric names.');
    }
    this.fields = [...fields];
    this.keys = ['intervalMs', 'totalCpuMs', ...this.fields];
    this.current = this.empty();
  }

  /** Excluded/manual frames also break the inter-frame cadence chain. */
  begin(excluded = false): void {
    if (this.active) {
      throw new Error('Finish the active frame before beginning another.');
    }
    if (typeof excluded !== 'boolean') {
      throw new Error('Frame exclusion must be a boolean.');
    }
    const start = this.readClock();
    for (const key of this.keys) {
      this.current[key] = 0;
    }
    this.current.intervalMs = this.previousStart === null || excluded
      ? 0 : start - this.previousStart;
    this.start = start;
    this.previousStart = excluded ? null : start;
    this.excluded = excluded;
    this.active = true;
  }

  /** Measures only the synchronous call; nested costs may overlap. */
  measure<Result>(cost: Field, action: () => Result): Result {
    this.assertActive();
    if (!this.fields.includes(cost) || typeof action !== 'function') {
      throw new Error('Frame measurement requires a registered metric and a function.');
    }
    const previous = this.current[cost];
    assertNonNegative(previous, `current.${cost}`);
    const start = this.readClock();
    this.measuring += 1;
    let result: Result | undefined;
    let failed = false;
    let failure: unknown;
    try {
      result = action();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.measuring -= 1;
    }
    try {
      const next = this.current[cost] + this.readClock() - start;
      assertNonNegative(next, `current.${cost}`);
      this.current[cost] = next;
    } catch (error) {
      if (!failed) {
        throw error;
      }
    }
    if (failed) {
      throw failure;
    }
    return result as Result;
  }

  finish(): void {
    this.assertActive();
    this.assertNotMeasuring();
    this.validateCurrent();
    const end = this.readClock();
    this.current.totalCpuMs = end - this.start;
    this.active = false;
    if (this.excluded) {
      this.excludedFrames += 1;
      return;
    }
    const sample = this.samples[this.cursor] ?? this.empty();
    for (const key of this.keys) {
      sample[key] = this.current[key];
    }
    this.samples[this.cursor] = sample;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.frames += 1;
  }

  /** Clears history, the active frame, and the previous clock epoch. */
  reset(): void {
    this.assertNotMeasuring();
    this.samples.length = 0;
    this.cursor = 0;
    this.previousStart = null;
    this.lastClock = null;
    this.active = false;
    this.frames = 0;
    this.excludedFrames = 0;
    for (const key of this.keys) {
      this.current[key] = 0;
    }
  }

  /** Nearest-rank percentiles over the retained window; missing cadence is excluded. */
  snapshot(): FrameProfileSnapshot<Field> {
    this.validateCurrent();
    const metrics = {} as FrameProfileSnapshot<Field>['metrics'];
    const maximums = this.empty();
    const sampleCounts = this.empty();
    for (const key of this.keys) {
      const values = this.samples.map((sample) => sample[key]).filter(
        (value) => key !== 'intervalMs' || value > 0,
      ).sort((a, b) => a - b);
      const percentile = (fraction: number): number => values.length === 0
        ? 0
        : (values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0);
      metrics[key] = { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
      maximums[key] = values.at(-1) ?? 0;
      sampleCounts[key] = values.length;
    }
    return {
      frames: this.frames,
      excludedFrames: this.excludedFrames,
      retainedSamples: this.samples.length,
      current: { ...this.current },
      metrics,
      maximums,
      sampleCounts,
    };
  }

  private empty(): FrameProfileSample<Field> {
    return Object.fromEntries(this.keys.map((key) => [key, 0])) as FrameProfileSample<Field>;
  }

  private readClock(): number {
    const value = this.now();
    assertNonNegative(value, 'clock');
    if (this.lastClock !== null && value < this.lastClock) {
      throw new Error('Frame profile clock must be non-decreasing.');
    }
    this.lastClock = value;
    return value;
  }

  private validateCurrent(): void {
    for (const key of this.keys) {
      assertNonNegative(this.current[key], `current.${key}`);
    }
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('Begin a frame before measuring or finishing.');
    }
  }

  private assertNotMeasuring(): void {
    if (this.measuring > 0) {
      throw new Error('Cannot finish or reset a frame during measured work.');
    }
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Frame profile ${label} must be finite and non-negative.`);
  }
}

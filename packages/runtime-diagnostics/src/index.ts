/**
 * Engine-independent frame performance diagnostics.
 *
 * This module records game-supplied frame samples, estimates causes for frame
 * hitches using optional browser observations, and aggregates bounded
 * snapshots. It installs no observers, reads no platform globals, starts no
 * timers, and performs no I/O: wiring `performance`, `PerformanceObserver`,
 * `document.visibilityState`, engine events, domain fields, and report sinks
 * is the consumer's responsibility.
 *
 * Time contract: every timestamp (`atMs`, `startAtMs`) and duration is in
 * milliseconds on one monotonic, non-decreasing clock supplied by the consumer
 * (for example `performance.now()`). The recorder never reads a clock itself,
 * so tests can drive it with synthetic timestamps.
 */

export interface FrameHitchSample {
  /**
   * Completion time of this frame's update work, in milliseconds on the
   * consumer's monotonic clock. Must not be negative.
   */
  readonly atMs: number;
  /**
   * Gap since the previous frame at the moment this frame ran. This gap is
   * the frame this sample describes: it contains the previous frame's render
   * callback, browser presentational work, idle time, and this frame's update
   * callback.
   */
  readonly frameDeltaMs: number;
  /** True when the page was hidden while this frame was sampled. */
  readonly hidden: boolean;
  /** Optional total used-JS-heap reading taken at this frame, in bytes. */
  readonly heapBytes?: number;
  /**
   * Optional change in used JS heap since the previous reading, in bytes.
   * Negative values are normal (allocation churn reversal and collection) and
   * are deliberately not validated like durations.
   */
  readonly heapDeltaBytes?: number;
  /**
   * Duration of the previous frame's render callback. It is attributed to
   * this sample's `frameDeltaMs` gap because that render executed just
   * before this frame became current — not to the previous sample's gap.
   */
  readonly previousRenderWorkMs: number;
  /** Duration of this frame's update callback, ending at `atMs`. */
  readonly updateWorkMs: number;
  /** True when this sample's gap crossed a document visibility transition. */
  readonly visibilityInterrupted: boolean;
}

export const FRAME_HITCH_CAUSES = [
  'browser-rendering',
  'game-update',
  'main-thread-long-task',
  'memory-reclamation',
  'phaser-render',
  'resource-load',
  'scheduler-or-compositor',
] as const;

export type FrameHitchCause = typeof FRAME_HITCH_CAUSES[number];

/**
 * Estimated explanation for one hitch. Every cause is a heuristic verdict
 * computed from the recorded evidence, never a confirmed root cause: see each
 * threshold constant below for what a cause does and does not prove.
 */
export interface FrameHitchDiagnosis {
  readonly atMs: number;
  readonly cause: FrameHitchCause;
  readonly frameDeltaMs: number;
  readonly relatedLongAnimationFrameMs?: number;
  readonly relatedLongTaskMs?: number;
  readonly relatedResourceLoadMs?: number;
}

/** Frames whose gap reaches this threshold are hitches. */
export const FRAME_HITCH_THRESHOLD_MS = 50;
/**
 * Update or render work reaching this threshold marks a hitch even when the
 * frame gap itself stayed below `FRAME_HITCH_THRESHOLD_MS`.
 */
export const FRAME_WORK_THRESHOLD_MS = 20;
/**
 * Heap-reclamation estimation only applies to gaps of at least this length;
 * shorter gaps with heap drops stay attributed to whatever other evidence
 * exists, because incidental minor collections are common in healthy frames.
 */
export const HEAP_RECLAMATION_FRAME_THRESHOLD_MS = 100;
/**
 * A heap drop at or below this value (that is, a large collection) is
 * evidence for `memory-reclamation` — it does not prove a major GC pause was
 * the hitch's root cause.
 */
export const HEAP_RECLAMATION_THRESHOLD_BYTES = -10 * 1024 * 1024;
/**
 * Gaps of at least this length with no explanatory game, render, or
 * observation work are estimated as `scheduler-or-compositor` interruptions.
 */
export const SCHEDULER_INTERRUPTION_THRESHOLD_MS = 1_000;
/** Default retained history length per sample list. */
export const FRAME_HITCH_HISTORY_LIMIT = 12;
/** Upper bound accepted for `historyLimit`. `snapshot()` cost grows with retained hitches times retained observations, so the bound caps the worst case rather than the defaults. */
export const MAX_FRAME_HITCH_HISTORY_LIMIT = 1_000;

export interface LongTaskSample {
  /** Completion time of the task, in milliseconds. Must not precede `startAtMs`. */
  readonly atMs: number;
  /** Task duration in milliseconds. */
  readonly durationMs: number;
  /** True when the task executed while the page was hidden. Hidden tasks are ignored. */
  readonly hidden: boolean;
  /** Consumer-sanitized diagnostic label for the task source. */
  readonly name: string;
  /** Start time of the task, in milliseconds. */
  readonly startAtMs: number;
}

export interface LongAnimationFrameSample {
  /** Completion time of the animation frame, in milliseconds. */
  readonly atMs: number;
  /** Blocking duration in milliseconds, as reported by the observer. */
  readonly blockingDurationMs: number;
  /** Total animation frame duration in milliseconds. */
  readonly durationMs: number;
  /** True when the frame executed while the page was hidden. Hidden frames are ignored. */
  readonly hidden: boolean;
  /** Render duration in milliseconds, as reported by the observer. */
  readonly renderDurationMs: number;
  /** Script duration in milliseconds, as reported by the observer. */
  readonly scriptDurationMs: number;
  /** Number of script invocations, as reported by the observer. */
  readonly scriptInvocations: number;
  /**
   * Bounded, already-sanitized script attributions. Retain at most
   * `MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES` entries; raw observer
   * attribution objects must never be stored here.
   */
  readonly scripts?: readonly LongAnimationFrameScriptSample[];
  /** Start time of the animation frame, in milliseconds. */
  readonly startAtMs: number;
  /** Style and layout duration in milliseconds, as reported by the observer. */
  readonly styleAndLayoutDurationMs: number;
}

export interface LongAnimationFrameScriptSample {
  readonly durationMs: number;
  readonly forcedStyleAndLayoutDurationMs: number;
  readonly invoker: string;
  readonly invokerType: string;
  readonly pauseDurationMs: number;
  readonly sourceFunctionName: string;
  /** Sanitized label produced by the consumer's `sourceLabel` callback. */
  readonly sourceUrl: string;
}

/** Structural subset of a `PerformanceScriptTiming` entry as reported by observers. */
export interface LongAnimationFrameScriptTiming {
  readonly duration?: number;
  readonly forcedStyleAndLayoutDuration?: number;
  readonly invoker?: string;
  readonly invokerType?: string;
  readonly pauseDuration?: number;
  readonly sourceFunctionName?: string;
  readonly sourceURL?: string;
}

/** Maximum script attributions retained per long animation frame sample. */
export const MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES = 8;
/** Maximum raw script timings accepted by `createLongAnimationFrameScriptSamples`. */
export const MAX_LONG_ANIMATION_FRAME_SCRIPT_TIMINGS = 1_024;

/**
 * Retain only the longest script attributions so diagnostic reports stay
 * predictably bounded. `sourceLabel` is the sanitization boundary: raw
 * observer URLs (which may carry query strings or tokens) must be reduced to
 * a safe label here and are never stored verbatim.
 */
export function createLongAnimationFrameScriptSamples(
  scripts: readonly LongAnimationFrameScriptTiming[],
  sourceLabel: (sourceUrl: string) => string,
): readonly LongAnimationFrameScriptSample[] {
  if (!Array.isArray(scripts)) {
    throw new Error(
      `LongAnimationFrameScriptTiming[] must be an array (received ${describeValue(scripts)}).`,
    );
  }
  if (scripts.length > MAX_LONG_ANIMATION_FRAME_SCRIPT_TIMINGS) {
    throw new Error(
      `LongAnimationFrameScriptTiming[] length ${scripts.length} exceeds ${MAX_LONG_ANIMATION_FRAME_SCRIPT_TIMINGS}.`,
    );
  }
  if (typeof sourceLabel !== 'function') {
    throw new Error(`sourceLabel must be a function (received ${describeValue(sourceLabel)}).`);
  }
  for (const script of scripts) {
    assertScriptTimingShape(script);
    if (script.duration !== undefined) {
      assertFiniteNonNegativeNumber(script.duration, 'LongAnimationFrameScriptTiming.duration');
    }
    if (script.forcedStyleAndLayoutDuration !== undefined) {
      assertFiniteNonNegativeNumber(
        script.forcedStyleAndLayoutDuration,
        'LongAnimationFrameScriptTiming.forcedStyleAndLayoutDuration',
      );
    }
    if (script.pauseDuration !== undefined) {
      assertFiniteNonNegativeNumber(
        script.pauseDuration,
        'LongAnimationFrameScriptTiming.pauseDuration',
      );
    }
    if (script.invoker !== undefined) {
      assertString(script.invoker, 'LongAnimationFrameScriptTiming.invoker');
    }
    if (script.invokerType !== undefined) {
      assertString(script.invokerType, 'LongAnimationFrameScriptTiming.invokerType');
    }
    if (script.sourceFunctionName !== undefined) {
      assertString(script.sourceFunctionName, 'LongAnimationFrameScriptTiming.sourceFunctionName');
    }
    if (script.sourceURL !== undefined) {
      assertString(script.sourceURL, 'LongAnimationFrameScriptTiming.sourceURL');
    }
  }

  const longestScripts = scripts
    .map((script) => ({ durationMs: script.duration ?? 0, script }))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES);

  return longestScripts.map(({ durationMs, script }) => {
    const labeledSourceUrl = script.sourceURL === undefined || script.sourceURL.length === 0
      ? ''
      : sourceLabel(script.sourceURL);
    assertString(labeledSourceUrl, 'sourceLabel(sourceUrl) result');
    return {
      durationMs,
      forcedStyleAndLayoutDurationMs: script.forcedStyleAndLayoutDuration ?? 0,
      invoker: script.invoker ?? '',
      invokerType: script.invokerType ?? '',
      pauseDurationMs: script.pauseDuration ?? 0,
      sourceFunctionName: script.sourceFunctionName ?? '',
      sourceUrl: labeledSourceUrl,
    };
  });
}

export interface ResourceLoadSample {
  /** Completion time of the load, in milliseconds. Must not precede `startAtMs`. */
  readonly atMs: number;
  /** Load duration in milliseconds. */
  readonly durationMs: number;
  /** True when the load completed while the page was hidden. Hidden loads are ignored. */
  readonly hidden: boolean;
  /** Consumer-sanitized diagnostic label for the resource. */
  readonly name: string;
  /** Start time of the load, in milliseconds. */
  readonly startAtMs: number;
}

/**
 * Aggregated view over one recording window. Counters marked cumulative are
 * never trimmed by history eviction; fields backed by retained history reflect
 * only the samples still held (see `hitchCauseCounts`).
 */
export interface FramePerformanceSnapshot<TSample extends FrameHitchSample = FrameHitchSample> {
  /** Mean frame delta over foreground frames only; interrupted frames are excluded. */
  readonly averageFrameMs: number;
  /** Mean previous-frame render work over foreground frames only. */
  readonly averageRenderWorkMs: number;
  /** Mean update work over foreground frames only. */
  readonly averageUpdateWorkMs: number;
  /** Frames sampled while active and uninterrupted (frameCount minus interruptionCount). */
  readonly foregroundFrameCount: number;
  /** Cumulative count of every sampled frame, including interrupted frames. */
  readonly frameCount: number;
  /** Cumulative hitch count; unlike `hitches` it never shrinks on eviction. */
  readonly hitchCount: number;
  /**
   * Shallow copies of retained hitch samples. Mutating the array or the
   * numeric base fields of a returned sample cannot corrupt the recorder;
   * nested game-context objects are shared references and must be treated as
   * read-only.
   */
  readonly hitches: readonly TSample[];
  /**
   * Cause counts over the retained hitch history only; eviction shrinks these
   * counts while `hitchCount` stays cumulative for the window.
   */
  readonly hitchCauseCounts: Readonly<Record<FrameHitchCause, number>>;
  /** Cumulative sum of frame deltas over frames excluded from the foreground averages. */
  readonly interruptedFrameMs: number;
  /** Cumulative count of hidden, visibility-interrupted, and estimated scheduler-interrupted frames. */
  readonly interruptionCount: number;
  /** Shallow copy of the most recent frame by `atMs`; omitted before the first frame. */
  readonly lastFrame?: TSample;
  /** Diagnosis recomputed for the newest retained hitch; omitted when none is retained. */
  readonly lastHitchDiagnosis?: FrameHitchDiagnosis;
  /** Shallow copy of the newest visible long animation frame; omitted when none was recorded. */
  readonly lastLongAnimationFrame?: LongAnimationFrameSample;
  /** Shallow copy of the newest visible long task; omitted when none was recorded. */
  readonly lastLongTask?: LongTaskSample;
  /** Shallow copy of the newest visible resource load; omitted when none was recorded. */
  readonly lastResourceLoad?: ResourceLoadSample;
  /** Cumulative visible long animation frame count. */
  readonly longAnimationFrameCount: number;
  /** Cumulative visible long task count. */
  readonly longTaskCount: number;
  /**
   * Cumulative memory-reclamation diagnoses; unlike
   * `hitchCauseCounts['memory-reclamation']` this is never history-trimmed.
   */
  readonly memoryReclamationHitchCount: number;
  /** Monotonic marker incremented by every `reset()`; the only field reset never clears. */
  readonly resetCount: number;
  /** Cumulative visible resource load count. */
  readonly resourceLoadCount: number;
  /** Cumulative count of estimated scheduler-or-compositor interruptions. */
  readonly schedulerInterruptionCount: number;
  /** Worst foreground frame delta; interrupted frames are excluded from this worst. */
  readonly worstFrameMs: number;
  /** Diagnosis of the worst foreground hitch; omitted when the worst frame stayed under the hitch threshold. */
  readonly worstHitchDiagnosis?: FrameHitchDiagnosis;
  /** Worst frame delta among interrupted frames (hidden, visibility, or estimated scheduler). */
  readonly worstInterruptedFrameMs: number;
  /** Worst visible long animation frame duration. */
  readonly worstLongAnimationFrameMs: number;
  /** Worst visible long task duration. */
  readonly worstLongTaskMs: number;
  /** Worst visible resource load duration. */
  readonly worstResourceLoadMs: number;
  /** Worst previous-frame render work over foreground frames. */
  readonly worstRenderWorkMs: number;
  /** Worst update work over foreground frames. */
  readonly worstUpdateWorkMs: number;
}

/** Constructor settings for `FrameHitchRecorder`. */
export interface FrameHitchRecorderOptions {
  /** Frame gaps at or above this threshold count as hitches. Must be finite and positive. */
  readonly hitchThresholdMs?: number;
  /** Update or render work at or above this threshold can mark a hitch on its own. Must be finite and positive. */
  readonly workThresholdMs?: number;
  /**
   * Maximum retained samples per history list. `0` retains no samples while
   * every cumulative counter keeps working. Must be an integer in
   * `[0, MAX_FRAME_HITCH_HISTORY_LIMIT]`.
   */
  readonly historyLimit?: number;
}

export class FrameHitchRecorder<TSample extends FrameHitchSample = FrameHitchSample> {
  private static readonly browserWorkShareLimit = 0.1;
  private static readonly explanatoryWorkRatio = 0.35;
  private static readonly relatedSampleOverlapToleranceMs = 16;
  private static readonly scriptDominanceFloorMs = 20;
  private frameCount = 0;
  private hitchCount = 0;
  private readonly hitches: TSample[] = [];
  private interruptionCount = 0;
  private lastFrame: TSample | undefined;
  private readonly longAnimationFrames: LongAnimationFrameSample[] = [];
  private lastLongAnimationFrame: LongAnimationFrameSample | undefined;
  private lastLongTask: LongTaskSample | undefined;
  private lastResourceLoad: ResourceLoadSample | undefined;
  private longAnimationFrameCount = 0;
  private readonly longTasks: LongTaskSample[] = [];
  private longTaskCount = 0;
  private memoryReclamationHitchCount = 0;
  private resetCount = 0;
  private resourceLoadCount = 0;
  private readonly resourceLoads: ResourceLoadSample[] = [];
  private schedulerInterruptionCount = 0;
  private totalFrameMs = 0;
  private totalInterruptedFrameMs = 0;
  private totalRenderWorkMs = 0;
  private totalUpdateWorkMs = 0;
  private worstFrameMs = 0;
  private worstFrameSample: TSample | undefined;
  private worstInterruptedFrameMs = 0;
  private worstLongAnimationFrameMs = 0;
  private worstLongTaskMs = 0;
  private worstResourceLoadMs = 0;
  private worstRenderWorkMs = 0;
  private worstUpdateWorkMs = 0;
  private readonly hitchThresholdMs: number;
  private readonly workThresholdMs: number;
  private readonly historyLimit: number;

  constructor(options: FrameHitchRecorderOptions = {}) {
    const hitchThresholdMs = options.hitchThresholdMs ?? FRAME_HITCH_THRESHOLD_MS;
    const workThresholdMs = options.workThresholdMs ?? FRAME_WORK_THRESHOLD_MS;
    const historyLimit = options.historyLimit ?? FRAME_HITCH_HISTORY_LIMIT;

    if (!Number.isFinite(hitchThresholdMs) || hitchThresholdMs <= 0) {
      throw new Error(
        `FrameHitchRecorderOptions.hitchThresholdMs must be a finite positive number (received ${describeValue(hitchThresholdMs)}).`,
      );
    }
    if (!Number.isFinite(workThresholdMs) || workThresholdMs <= 0) {
      throw new Error(
        `FrameHitchRecorderOptions.workThresholdMs must be a finite positive number (received ${describeValue(workThresholdMs)}).`,
      );
    }
    if (
      !Number.isInteger(historyLimit)
      || historyLimit < 0
      || historyLimit > MAX_FRAME_HITCH_HISTORY_LIMIT
    ) {
      throw new Error(
        `FrameHitchRecorderOptions.historyLimit must be an integer between 0 and ${MAX_FRAME_HITCH_HISTORY_LIMIT} (received ${describeValue(historyLimit)}).`,
      );
    }

    this.hitchThresholdMs = hitchThresholdMs;
    this.workThresholdMs = workThresholdMs;
    this.historyLimit = historyLimit;
  }

  /**
   * Record one frame sample.
   *
   * Frames that were hidden, crossed a visibility transition, or are
   * estimated scheduler interruptions are counted in `interruptionCount`
   * (with their time in `interruptedFrameMs`) and excluded from foreground
   * averages, hitches, and foreground worsts — they are never silently
   * dropped. The scheduler estimate is decided at record time from the
   * observations retained at that moment and is final: unlike retained
   * hitches, an observation arriving later does not reclassify it, so the
   * excluded gap stays visible through the interruption counters.
   */
  record(sample: TSample): void {
    validateFrameHitchSample(sample);

    this.frameCount += 1;

    if (this.lastFrame === undefined || sample.atMs >= this.lastFrame.atMs) {
      this.lastFrame = sample;
    }
    // Diagnose once per record: the verdict is deterministic for unchanged
    // recorder state, and re-scanning the observation histories would bill
    // the frame loop of an already-hitching game twice.
    let diagnosis: FrameHitchDiagnosis | undefined;
    const schedulerCandidate = !sample.hidden
      && !sample.visibilityInterrupted
      && sample.frameDeltaMs >= SCHEDULER_INTERRUPTION_THRESHOLD_MS;

    if (schedulerCandidate) {
      diagnosis = this.diagnose(sample);
    }
    const schedulerInterrupted = schedulerCandidate
      && diagnosis !== undefined
      && diagnosis.cause === 'scheduler-or-compositor';

    if (sample.hidden || sample.visibilityInterrupted || schedulerInterrupted) {
      this.interruptionCount += 1;
      this.schedulerInterruptionCount += Number(schedulerInterrupted);
      this.totalInterruptedFrameMs += sample.frameDeltaMs;
      this.worstInterruptedFrameMs = Math.max(this.worstInterruptedFrameMs, sample.frameDeltaMs);
      return;
    }

    if (sample.frameDeltaMs > this.worstFrameMs) {
      this.worstFrameMs = sample.frameDeltaMs;
      this.worstFrameSample = sample;
    }
    this.worstRenderWorkMs = Math.max(this.worstRenderWorkMs, sample.previousRenderWorkMs);
    this.worstUpdateWorkMs = Math.max(this.worstUpdateWorkMs, sample.updateWorkMs);
    this.totalFrameMs += sample.frameDeltaMs;
    this.totalRenderWorkMs += sample.previousRenderWorkMs;
    this.totalUpdateWorkMs += sample.updateWorkMs;

    if (
      sample.frameDeltaMs < this.hitchThresholdMs
      && sample.previousRenderWorkMs < this.workThresholdMs
      && sample.updateWorkMs < this.workThresholdMs
    ) {
      return;
    }

    this.hitchCount += 1;

    diagnosis ??= this.diagnose(sample);

    if (diagnosis.cause === 'memory-reclamation') {
      this.memoryReclamationHitchCount += 1;
    }

    this.hitches.push(sample);
    this.trimHistoryByAtMs(this.hitches);
  }

  /**
   * Record one long animation frame observation. Hidden samples are validated
   * and then ignored. Out-of-order samples are accepted: counts, worsts, and
   * histories account for them, `last*` keeps the newest sample by `atMs`, and
   * eviction drops the oldest by `atMs` so a late buffered sample cannot evict
   * newer evidence. Because diagnoses are recomputed at `snapshot()` time from
   * the observations still retained, a sample arriving after a retained hitch
   * can retroactively change that hitch's cause label until either sample is
   * evicted. Estimated scheduler interruptions, however, are decided at record
   * time and are not re-examined later.
   */
  recordLongAnimationFrame(sample: LongAnimationFrameSample): void {
    validateLongAnimationFrameSample(sample);

    if (sample.hidden) {
      return;
    }

    if (
      this.lastLongAnimationFrame === undefined
      || sample.atMs >= this.lastLongAnimationFrame.atMs
    ) {
      this.lastLongAnimationFrame = sample;
    }
    this.longAnimationFrameCount += 1;
    this.worstLongAnimationFrameMs = Math.max(this.worstLongAnimationFrameMs, sample.durationMs);
    this.longAnimationFrames.push(sample);
    this.trimHistoryByAtMs(this.longAnimationFrames);
  }

  /** Record one long task observation. Hidden samples are validated and then ignored. */
  recordLongTask(sample: LongTaskSample): void {
    validateLongTaskSample(sample);

    if (sample.hidden) {
      return;
    }

    if (this.lastLongTask === undefined || sample.atMs >= this.lastLongTask.atMs) {
      this.lastLongTask = sample;
    }
    this.longTaskCount += 1;
    this.worstLongTaskMs = Math.max(this.worstLongTaskMs, sample.durationMs);
    this.longTasks.push(sample);
    this.trimHistoryByAtMs(this.longTasks);
  }

  /** Record one resource load observation. Hidden samples are validated and then ignored. */
  recordResourceLoad(sample: ResourceLoadSample): void {
    validateResourceLoadSample(sample);

    if (sample.hidden) {
      return;
    }

    if (this.lastResourceLoad === undefined || sample.atMs >= this.lastResourceLoad.atMs) {
      this.lastResourceLoad = sample;
    }
    this.resourceLoadCount += 1;
    this.worstResourceLoadMs = Math.max(this.worstResourceLoadMs, sample.durationMs);
    this.resourceLoads.push(sample);
    this.trimHistoryByAtMs(this.resourceLoads);
  }

  /**
   * Estimate the cause of one frame's gap.
   *
   * The verdict is ordered heuristic evidence, not a confirmed root cause:
   *
   * - `game-update` / `phaser-render`: the frame's own update work, or the
   *   previous frame's render work, is at least `workThresholdMs` and at
   *   least `explanatoryWorkRatio` of the gap. (`phaser-render` names the
   *   render callback of the consuming engine; the classification itself is
   *   engine-independent.)
   * - `memory-reclamation`: a 100–1000 ms gap with a heap drop at or below
   *   `HEAP_RECLAMATION_THRESHOLD_BYTES`. A heap drop alone does not prove a
   *   GC pause caused the hitch, and multi-second gaps are excluded because
   *   collectors also run while the renderer is suspended.
   * - `main-thread-long-task` / `browser-rendering`: a retained observation
   *   overlapping the frame window. Overlap does not prove the observation
   *   blocked this frame's main thread.
   * - `scheduler-or-compositor`: the residual estimate when nothing else
   *   explains the gap, including long LoAF entries whose reported blocking,
   *   script, and style/layout work are a negligible share of the gap
   *   (renderer suspension). The absence of observations never proves the
   *   game performed well.
   */
  diagnose(sample: TSample): FrameHitchDiagnosis {
    validateFrameHitchSample(sample);

    const base = {
      atMs: sample.atMs,
      frameDeltaMs: sample.frameDeltaMs,
    };
    const explanatoryWorkMs =
      sample.frameDeltaMs * FrameHitchRecorder.explanatoryWorkRatio;

    if (
      sample.updateWorkMs >= this.workThresholdMs
      && sample.updateWorkMs >= explanatoryWorkMs
    ) {
      return { ...base, cause: 'game-update' };
    }

    if (
      sample.previousRenderWorkMs >= this.workThresholdMs
      && sample.previousRenderWorkMs >= explanatoryWorkMs
    ) {
      return { ...base, cause: 'phaser-render' };
    }

    if (this.isMemoryReclamationHitch(sample)) {
      return { ...base, cause: 'memory-reclamation' };
    }

    const relatedLongTask = this.findRelated(sample, this.longTasks);

    if (
      relatedLongTask !== undefined
      && relatedLongTask.durationMs >= explanatoryWorkMs
    ) {
      return {
        ...base,
        cause: 'main-thread-long-task',
        relatedLongTaskMs: relatedLongTask.durationMs,
      };
    }

    const relatedLongAnimationFrame = this.findRelated(sample, this.longAnimationFrames);

    if (relatedLongAnimationFrame !== undefined) {
      const browserWorkMs = Math.max(
        relatedLongAnimationFrame.blockingDurationMs,
        relatedLongAnimationFrame.scriptDurationMs,
        relatedLongAnimationFrame.styleAndLayoutDurationMs,
      );

      // A renderer can emit a LoAF whose duration spans an occluded or
      // suspended interval while reporting essentially no blocking, script,
      // style, or layout work. That is a browser scheduling interruption, not
      // evidence that the game spent the whole gap rendering.
      if (
        sample.frameDeltaMs >= SCHEDULER_INTERRUPTION_THRESHOLD_MS
        && browserWorkMs
          < sample.frameDeltaMs * FrameHitchRecorder.browserWorkShareLimit
      ) {
        return {
          ...base,
          cause: 'scheduler-or-compositor',
          relatedLongAnimationFrameMs: relatedLongAnimationFrame.durationMs,
        };
      }

      const scriptDominated = relatedLongAnimationFrame.scriptDurationMs
        >= FrameHitchRecorder.scriptDominanceFloorMs
        && relatedLongAnimationFrame.scriptDurationMs
          >= relatedLongAnimationFrame.renderDurationMs;
      return {
        ...base,
        cause: scriptDominated ? 'main-thread-long-task' : 'browser-rendering',
        relatedLongAnimationFrameMs: relatedLongAnimationFrame.durationMs,
      };
    }

    const relatedResourceLoad = this.findRelated(sample, this.resourceLoads);

    if (
      relatedResourceLoad !== undefined
      && relatedResourceLoad.durationMs >= explanatoryWorkMs
    ) {
      return {
        ...base,
        cause: 'resource-load',
        relatedResourceLoadMs: relatedResourceLoad.durationMs,
      };
    }

    return { ...base, cause: 'scheduler-or-compositor' };
  }

  /**
   * Clear every aggregate and retained sample for the next recording window.
   * `resetCount` is the only field that survives: it increments monotonically
   * so diagnostics can observe an accepted reset without timing guesses. Old
   * observations cannot leak into the new window because all observation
   * histories are cleared too.
   */
  reset(): void {
    this.resetCount += 1;
    this.frameCount = 0;
    this.hitchCount = 0;
    this.hitches.length = 0;
    this.interruptionCount = 0;
    this.lastFrame = undefined;
    this.lastLongAnimationFrame = undefined;
    this.lastLongTask = undefined;
    this.lastResourceLoad = undefined;
    this.longAnimationFrameCount = 0;
    this.longAnimationFrames.length = 0;
    this.longTasks.length = 0;
    this.longTaskCount = 0;
    this.memoryReclamationHitchCount = 0;
    this.resourceLoadCount = 0;
    this.resourceLoads.length = 0;
    this.schedulerInterruptionCount = 0;
    this.totalFrameMs = 0;
    this.totalInterruptedFrameMs = 0;
    this.totalRenderWorkMs = 0;
    this.totalUpdateWorkMs = 0;
    this.worstFrameMs = 0;
    this.worstFrameSample = undefined;
    this.worstInterruptedFrameMs = 0;
    this.worstLongAnimationFrameMs = 0;
    this.worstLongTaskMs = 0;
    this.worstResourceLoadMs = 0;
    this.worstRenderWorkMs = 0;
    this.worstUpdateWorkMs = 0;
  }

  /** Monotonic reset marker; equals `snapshot().resetCount`. */
  getResetCount(): number {
    return this.resetCount;
  }

  snapshot(): FramePerformanceSnapshot<TSample> {
    const foregroundFrameCount = this.frameCount - this.interruptionCount;
    const averageOverForegroundFrames = (totalMs: number): number =>
      foregroundFrameCount === 0 ? 0 : totalMs / foregroundFrameCount;

    const hitchDiagnoses = this.hitches.map((sample) => this.diagnose(sample));
    const hitchCauseCounts = createEmptyHitchCauseCounts();

    for (const diagnosis of hitchDiagnoses) {
      hitchCauseCounts[diagnosis.cause] += 1;
    }

    const lastHitchDiagnosis = hitchDiagnoses.at(-1);
    const worstHitchDiagnosis = this.worstFrameSample === undefined
      || this.worstFrameMs < this.hitchThresholdMs
      ? undefined
      : this.diagnose(this.worstFrameSample);

    return {
      averageFrameMs: averageOverForegroundFrames(this.totalFrameMs),
      averageRenderWorkMs: averageOverForegroundFrames(this.totalRenderWorkMs),
      averageUpdateWorkMs: averageOverForegroundFrames(this.totalUpdateWorkMs),
      foregroundFrameCount,
      frameCount: this.frameCount,
      hitchCount: this.hitchCount,
      hitches: this.hitches.map((sample) => ({ ...sample })),
      hitchCauseCounts,
      interruptedFrameMs: this.totalInterruptedFrameMs,
      interruptionCount: this.interruptionCount,
      ...(this.lastFrame === undefined ? {} : { lastFrame: { ...this.lastFrame } }),
      ...(lastHitchDiagnosis === undefined ? {} : { lastHitchDiagnosis }),
      ...(this.lastLongAnimationFrame === undefined
        ? {}
        : { lastLongAnimationFrame: cloneLongAnimationFrameSample(this.lastLongAnimationFrame) }),
      ...(this.lastLongTask === undefined
        ? {}
        : { lastLongTask: { ...this.lastLongTask } }),
      ...(this.lastResourceLoad === undefined
        ? {}
        : { lastResourceLoad: { ...this.lastResourceLoad } }),
      longAnimationFrameCount: this.longAnimationFrameCount,
      longTaskCount: this.longTaskCount,
      memoryReclamationHitchCount: this.memoryReclamationHitchCount,
      resetCount: this.resetCount,
      resourceLoadCount: this.resourceLoadCount,
      schedulerInterruptionCount: this.schedulerInterruptionCount,
      worstFrameMs: this.worstFrameMs,
      ...(worstHitchDiagnosis === undefined ? {} : { worstHitchDiagnosis }),
      worstInterruptedFrameMs: this.worstInterruptedFrameMs,
      worstLongAnimationFrameMs: this.worstLongAnimationFrameMs,
      worstLongTaskMs: this.worstLongTaskMs,
      worstResourceLoadMs: this.worstResourceLoadMs,
      worstRenderWorkMs: this.worstRenderWorkMs,
      worstUpdateWorkMs: this.worstUpdateWorkMs,
    };
  }

  /**
   * Find the most explanatory observation overlapping a frame's gap window.
   *
   * The window is `[updateStart - frameDeltaMs, updateStart]`, where
   * `updateStart = atMs - updateWorkMs` is where this frame's update callback
   * began. Work inside the update callback itself is deliberately excluded:
   * it is already measured by `updateWorkMs` and diagnosed as `game-update`,
   * and work after `atMs` belongs to the next frame. Anchoring the gap at the
   * update start rather than at `atMs` keeps the previous frame's render and
   * any pre-update blocking associated with this gap without absorbing
   * neighboring frames' work.
   */
  private findRelated<TObservation extends {
    readonly atMs: number;
    readonly durationMs: number;
    readonly startAtMs: number;
  }>(
    frame: FrameHitchSample,
    samples: readonly TObservation[],
  ): TObservation | undefined {
    const updateStartedAtMs = frame.atMs - frame.updateWorkMs;
    const frameWindowStartedAtMs = updateStartedAtMs - frame.frameDeltaMs;
    const overlapToleranceMs = FrameHitchRecorder.relatedSampleOverlapToleranceMs;
    let mostExplanatory: TObservation | undefined;

    for (const sample of samples) {
      const overlaps = sample.atMs >= frameWindowStartedAtMs - overlapToleranceMs
        && sample.startAtMs <= updateStartedAtMs + overlapToleranceMs;

      if (
        overlaps
        && (mostExplanatory === undefined || sample.durationMs >= mostExplanatory.durationMs)
      ) {
        mostExplanatory = sample;
      }
    }

    return mostExplanatory;
  }

  private isMemoryReclamationHitch(sample: FrameHitchSample): boolean {
    // A multi-second scheduler or occlusion gap can trigger collection while
    // suspended; trust heap correlation only for sub-second gaps so that
    // incidental collection stays an interruption.
    return sample.frameDeltaMs >= HEAP_RECLAMATION_FRAME_THRESHOLD_MS
      && sample.frameDeltaMs < SCHEDULER_INTERRUPTION_THRESHOLD_MS
      && (sample.heapDeltaBytes ?? 0) <= HEAP_RECLAMATION_THRESHOLD_BYTES;
  }

  /**
   * Keep a retained sample history ordered by `atMs` and bounded, so eviction
   * always drops the oldest sample by event time rather than by arrival
   * order. Mostly-sorted pushes make the sort near-linear; the sort runs only
   * when a sample is actually recorded, never per frame.
   */
  private trimHistoryByAtMs<TObservation extends { readonly atMs: number }>(
    samples: TObservation[],
  ): void {
    const previous = samples.at(-2);

    if (previous !== undefined && previous.atMs > (samples.at(-1) as TObservation).atMs) {
      samples.sort((left, right) => left.atMs - right.atMs);
    }
    if (samples.length > this.historyLimit) {
      samples.splice(0, samples.length - this.historyLimit);
    }
  }
}

function createEmptyHitchCauseCounts(): Record<FrameHitchCause, number> {
  return Object.fromEntries(
    FRAME_HITCH_CAUSES.map((cause) => [cause, 0]),
  ) as Record<FrameHitchCause, number>;
}

function cloneLongAnimationFrameSample(
  sample: LongAnimationFrameSample,
): LongAnimationFrameSample {
  if (sample.scripts === undefined) {
    return { ...sample };
  }
  return { ...sample, scripts: [...sample.scripts] };
}

/**
 * Structural subset of `Performance` carrying the Chromium-only `memory`
 * extension. Accepting the structural shape (instead of the DOM type) keeps
 * this package importable in DOM-free environments; the caller owns how the
 * source object is obtained.
 */
export interface HeapMemorySource {
  readonly memory?: {
    readonly usedJSHeapSize?: number;
  };
}

/** Read the used JS heap size from a supplied source; `undefined` when unavailable or non-finite. */
export function readUsedHeapBytes(source: HeapMemorySource | undefined): number | undefined {
  const usedHeap = source?.memory?.usedJSHeapSize;

  return usedHeap === undefined || !Number.isFinite(usedHeap) ? undefined : usedHeap;
}

function validateFrameHitchSample(sample: FrameHitchSample): void {
  assertFiniteNonNegativeNumber(sample.atMs, 'FrameHitchSample.atMs');
  assertFiniteNonNegativeNumber(sample.frameDeltaMs, 'FrameHitchSample.frameDeltaMs');
  assertFiniteNonNegativeNumber(
    sample.previousRenderWorkMs,
    'FrameHitchSample.previousRenderWorkMs',
  );
  assertFiniteNonNegativeNumber(sample.updateWorkMs, 'FrameHitchSample.updateWorkMs');
  assertBoolean(sample.hidden, 'FrameHitchSample.hidden');
  assertBoolean(sample.visibilityInterrupted, 'FrameHitchSample.visibilityInterrupted');
  if (sample.heapBytes !== undefined) {
    assertFiniteNonNegativeNumber(sample.heapBytes, 'FrameHitchSample.heapBytes');
  }
  if (sample.heapDeltaBytes !== undefined) {
    // Heap deltas are signed by design: a large negative delta is a normal
    // collection signal, not an invalid duration.
    assertFiniteNumber(sample.heapDeltaBytes, 'FrameHitchSample.heapDeltaBytes');
  }
}

function validateLongTaskSample(sample: LongTaskSample): void {
  validateObservationTiming(sample, 'LongTaskSample');
  assertBoolean(sample.hidden, 'LongTaskSample.hidden');
  assertString(sample.name, 'LongTaskSample.name');
}

function validateLongAnimationFrameSample(sample: LongAnimationFrameSample): void {
  validateObservationTiming(sample, 'LongAnimationFrameSample');
  assertBoolean(sample.hidden, 'LongAnimationFrameSample.hidden');
  assertFiniteNonNegativeNumber(
    sample.blockingDurationMs,
    'LongAnimationFrameSample.blockingDurationMs',
  );
  assertFiniteNonNegativeNumber(
    sample.renderDurationMs,
    'LongAnimationFrameSample.renderDurationMs',
  );
  assertFiniteNonNegativeNumber(
    sample.scriptDurationMs,
    'LongAnimationFrameSample.scriptDurationMs',
  );
  assertFiniteNonNegativeNumber(
    sample.styleAndLayoutDurationMs,
    'LongAnimationFrameSample.styleAndLayoutDurationMs',
  );
  if (!Number.isInteger(sample.scriptInvocations) || sample.scriptInvocations < 0) {
    throw new Error(
      `LongAnimationFrameSample.scriptInvocations must be a non-negative integer (received ${describeValue(sample.scriptInvocations)}).`,
    );
  }
  if (sample.scripts !== undefined) {
    if (!Array.isArray(sample.scripts)) {
      throw new Error(
        `LongAnimationFrameSample.scripts must be an array (received ${describeValue(sample.scripts)}).`,
      );
    }
    if (sample.scripts.length > MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES) {
      throw new Error(
        `LongAnimationFrameSample.scripts length ${sample.scripts.length} exceeds ${MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES}.`,
      );
    }
    for (const script of sample.scripts) {
      assertScriptSampleShape(script);
      validateLongAnimationFrameScriptSample(script);
    }
  }
}

/** Reject non-object entries before field validation dereferences them. */
function assertScriptTimingShape(script: LongAnimationFrameScriptTiming): void {
  if (typeof script !== 'object' || script === null) {
    throw new Error(
      `LongAnimationFrameScriptTiming entry must be an object (received ${describeValue(script)}).`,
    );
  }
}

/** Reject non-object entries before field validation dereferences them. */
function assertScriptSampleShape(script: LongAnimationFrameScriptSample): void {
  if (typeof script !== 'object' || script === null) {
    throw new Error(
      `LongAnimationFrameScriptSample entry must be an object (received ${describeValue(script)}).`,
    );
  }
}

function validateLongAnimationFrameScriptSample(script: LongAnimationFrameScriptSample): void {
  assertFiniteNonNegativeNumber(script.durationMs, 'LongAnimationFrameScriptSample.durationMs');
  assertFiniteNonNegativeNumber(
    script.forcedStyleAndLayoutDurationMs,
    'LongAnimationFrameScriptSample.forcedStyleAndLayoutDurationMs',
  );
  assertFiniteNonNegativeNumber(
    script.pauseDurationMs,
    'LongAnimationFrameScriptSample.pauseDurationMs',
  );
  assertString(script.invoker, 'LongAnimationFrameScriptSample.invoker');
  assertString(script.invokerType, 'LongAnimationFrameScriptSample.invokerType');
  assertString(script.sourceFunctionName, 'LongAnimationFrameScriptSample.sourceFunctionName');
  assertString(script.sourceUrl, 'LongAnimationFrameScriptSample.sourceUrl');
}

function validateResourceLoadSample(sample: ResourceLoadSample): void {
  validateObservationTiming(sample, 'ResourceLoadSample');
  assertBoolean(sample.hidden, 'ResourceLoadSample.hidden');
  assertString(sample.name, 'ResourceLoadSample.name');
}

interface ObservationTiming {
  readonly atMs: number;
  readonly startAtMs: number;
  readonly durationMs: number;
}

function validateObservationTiming(sample: ObservationTiming, label: string): void {
  assertFiniteNonNegativeNumber(sample.startAtMs, `${label}.startAtMs`);
  assertFiniteNonNegativeNumber(sample.atMs, `${label}.atMs`);
  assertFiniteNonNegativeNumber(sample.durationMs, `${label}.durationMs`);
  if (sample.atMs < sample.startAtMs) {
    throw new Error(`${label}.atMs must not precede ${label}.startAtMs.`);
  }
}

function assertFiniteNonNegativeNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${field} must be a finite non-negative number (received ${describeValue(value)}).`,
    );
  }
}

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number (received ${describeValue(value)}).`);
  }
}

function assertBoolean(value: boolean, field: string): void {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean (received ${describeValue(value)}).`);
  }
}

function assertString(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string (received ${describeValue(value)}).`);
  }
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

# `@mpgd/runtime-diagnostics`

Engine-independent frame performance diagnostics: record per-frame timing
samples, estimate why hitches happened using optional browser observations,
and read bounded aggregates — all without importing an engine, DOM, or
network stack.

The package is deliberately headless. It ships:

- sample types for frames, long tasks, long animation frames, and resource
  loads;
- `FrameHitchRecorder<TSample>`, which aggregates frames, keeps a bounded
  history, and estimates hitch causes;
- `createLongAnimationFrameScriptSamples()`, the sanitizing boundary for
  observer script attributions;
- `readUsedHeapBytes()`, a structural reader for the Chromium heap extension.

Games extend `FrameHitchSample` with their own numeric context (for example
entity counts or phase labels) through the generic parameter; the recorder
never inspects or clones those fields.

## What stays with the consumer

The recorder never touches the platform. Installing observers
(`PerformanceObserver` for long tasks and long animation frames,
`PerformanceObserver`-backed resource timing), reading
`document.visibilityState`, timing engine update/render callbacks, producing
heap deltas, rendering debug overlays, and uploading or persisting reports are
all consumer responsibilities. Importing this package causes no observer,
timer, DOM, or network side effects, which is why the tests run in plain Node.

## Time and attribution contract

- Every `atMs` / `startAtMs` timestamp and duration is in milliseconds on one
  monotonic, non-decreasing clock chosen by the consumer (for example
  `performance.now()`). The recorder never reads a clock, so tests drive it
  with synthetic timestamps.
- A frame sample describes one inter-frame gap. `frameDeltaMs` is that gap;
  `previousRenderWorkMs` is the **previous** frame's render callback, which
  executed just before this frame became current and is therefore attributed
  to this gap; `updateWorkMs` is this frame's own update callback ending at
  `atMs`. Misattributing the previous render to the previous sample's gap —
  or this frame's update to the previous gap — would double-count work, so
  the recorder keeps the two windows distinct.
- A **foreground frame** is one that was not hidden, did not cross a
  visibility transition, and was not estimated as a scheduler interruption.
  Only foreground frames feed the averages, foreground worsts, and hitch
  diagnoses.
- A **visibility interruption** (`hidden: true` or
  `visibilityInterrupted: true`) is an observed fact supplied by the consumer.
  A **scheduler interruption** is an estimate: a gap of at least
  `SCHEDULER_INTERRUPTION_THRESHOLD_MS` (1 s) whose diagnosis found no
  explanatory update, render, or observation work. Both are counted
  (`interruptionCount`, `schedulerInterruptionCount`) and their excluded time
  is reported (`interruptedFrameMs`, `worstInterruptedFrameMs`) so averages
  never silently drop a stall.
- Cumulative counters (`frameCount`, `hitchCount`, interruption and
  observation counts, `memoryReclamationHitchCount`, worsts, and the totals
  behind averages) are never trimmed by history eviction. Retained histories
  (`hitches`, long tasks, long animation frames, resource loads) each hold at
  most `historyLimit` samples, and `hitchCauseCounts` is computed over the
  retained hitches only — after eviction it shrinks while `hitchCount` does
  not.
- Diagnoses are recomputed at `snapshot()` time from the observations still
  retained, so an observation arriving after a **retained hitch** can relabel
  that hitch's cause until either sample is evicted. Estimated scheduler
  interruptions are the exception: the estimate is decided at record time from
  the evidence available then and is final — the excluded gap stays visible
  through `interruptionCount`, `schedulerInterruptionCount`, and
  `interruptedFrameMs` instead of being silently reclassified. Out-of-order
  observations are accepted: counts and worsts are order-independent, `last*`
  fields keep the newest sample by `atMs`, and eviction drops the oldest by
  event time so a late buffered sample cannot evict newer evidence.
- `reset()` clears every aggregate and every retained sample — pre-reset
  observations cannot leak into the next window — except `resetCount`, which
  increments monotonically so consumers can observe an accepted reset without
  timing guesses.

## Causes are estimates

`diagnose()` orders heuristic evidence; it never confirms a root cause:

- `game-update` / `phaser-render`: update or previous-render work is at least
  `workThresholdMs` (20 ms) and at least 35% of the gap. `phaser-render`
  names the consuming engine's render callback (the kit's primary engine is
  Phaser); the classification itself is engine-independent.
- `memory-reclamation`: a 100–1000 ms gap with a heap drop of at least 10 MiB
  (`HEAP_RECLAMATION_THRESHOLD_BYTES`). A heap drop alone does not prove a GC
  pause caused the hitch; multi-second gaps are excluded because collectors
  also run while the renderer is suspended.
- `main-thread-long-task` / `browser-rendering`: a retained observation
  overlapping the frame window with tolerance. Overlap does not prove the
  observation blocked this frame.
- `resource-load`: an overlapping resource timing entry. Resource timing
  measures network/decode work, not main-thread blocking.
- `scheduler-or-compositor`: the residual estimate when nothing else explains
  the gap — including long animation frames whose reported blocking, script,
  and style/layout work are under 10% of a multi-second gap (renderer
  suspension). The absence of observations never proves the game performed
  well.

## Input validation

All constructor options and samples are validated before any aggregate
changes, so a rejected input never leaves partially updated state. The
recorder throws `Error` with a field-qualified message when it receives:

- non-finite, negative, or NaN/Infinity durations and timestamps;
- thresholds that are not finite positive numbers;
- a `historyLimit` that is not an integer in
  `[0, MAX_FRAME_HITCH_HISTORY_LIMIT]` (1 000); `0` is valid and retains no
  samples while every counter keeps working;
- observation intervals where `atMs` precedes `startAtMs`;
- script attribution arrays longer than
  `MAX_LONG_ANIMATION_FRAME_SCRIPT_SAMPLES` (8), or raw timing arrays longer
  than `MAX_LONG_ANIMATION_FRAME_SCRIPT_TIMINGS` (1 024).

`heapDeltaBytes` only requires a finite number: negative deltas are normal
collection signals and are not validated like durations.

## Example

A toy game wires its own clocks and observers, then records:

```ts
import {
  FrameHitchRecorder,
  createLongAnimationFrameScriptSamples,
  readUsedHeapBytes,
  type FrameHitchSample,
} from '@mpgd/runtime-diagnostics';

interface ToyFrameSample extends FrameHitchSample {
  readonly enemies: number;
  readonly phase: string;
}

// The game owns clock access, observer installation, and visibility state.
const recorder = new FrameHitchRecorder<ToyFrameSample>({
  hitchThresholdMs: 50,
  workThresholdMs: 20,
  historyLimit: 12,
});

let previousHeapBytes = readUsedHeapBytes(performance);

// The game times its own callbacks and reads its own visibility state.
function onFrame(frame: {
  atMs: number;
  frameDeltaMs: number;
  updateWorkMs: number;
  previousRenderWorkMs: number;
  visibilityInterrupted: boolean;
}): void {
  const heapBytes = readUsedHeapBytes(performance);
  recorder.record({
    atMs: frame.atMs,
    enemies: countEnemies(),
    frameDeltaMs: frame.frameDeltaMs,
    hidden: document.visibilityState === 'hidden',
    heapBytes,
    heapDeltaBytes: heapBytes !== undefined && previousHeapBytes !== undefined
      ? heapBytes - previousHeapBytes
      : undefined,
    phase: currentPhase(),
    previousRenderWorkMs: frame.previousRenderWorkMs,
    updateWorkMs: frame.updateWorkMs,
    visibilityInterrupted: frame.visibilityInterrupted,
  });
  previousHeapBytes = heapBytes;
}

// The game maps PerformanceObserver entries to samples itself; the shapes
// below are already the recorder's input types, not browser types.
function onLongAnimationFrame(observed: {
  startTime: number;
  duration: number;
  blockingDuration: number;
  renderDuration: number;
  scriptDuration: number;
  scriptInvocations: number;
  styleAndLayoutDuration: number;
  scripts: readonly {
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
    invoker?: string;
    invokerType?: string;
    pauseDuration?: number;
    sourceFunctionName?: string;
    sourceURL?: string;
  }[];
  hidden: boolean;
}): void {
  recorder.recordLongAnimationFrame({
    atMs: observed.startTime + observed.duration,
    blockingDurationMs: observed.blockingDuration,
    durationMs: observed.duration,
    hidden: observed.hidden,
    renderDurationMs: observed.renderDuration,
    scriptDurationMs: observed.scriptDuration,
    scriptInvocations: observed.scriptInvocations,
    scripts: createLongAnimationFrameScriptSamples(
      observed.scripts,
      (sourceUrl) => sanitizeSourceUrl(sourceUrl),
    ),
    startAtMs: observed.startTime,
    styleAndLayoutDurationMs: observed.styleAndLayoutDuration,
  });
}

// Read a snapshot for a debug overlay or a bug report attachment.
const snapshot = recorder.snapshot();
console.log(snapshot.averageFrameMs, snapshot.hitchCauseCounts, snapshot.hitches.at(-1));

// Start a fresh window; only `resetCount` survives.
recorder.reset();
```

The example's `onFrame` / `onLongAnimationFrame` signatures are illustrative:
the consumer decides how engine callbacks and `PerformanceObserver` entries
map onto the recorder's input types. This package deliberately defines no
browser types beyond the structural `HeapMemorySource`.

## Ownership of samples

Recorded samples and snapshot results are shared by reference at the
container level: `snapshot()` returns fresh arrays and shallow copies of
samples, so mutating the array, the cause counts, or a sample's numeric base
fields cannot corrupt the recorder. Nested game-context objects inside a
sample are **not** deep-cloned; treat every sample you hand to `record()` and
every object inside a snapshot as read-only from that point on.

## Memory bounds

Every retained list is capped at `historyLimit` (default 12, at most
`MAX_FRAME_HITCH_HISTORY_LIMIT` = 1 000). Worst values and averages are
running accumulators, not lists. `snapshot()` correlates each retained hitch
against each retained observation, so its cost grows with
`hitches × observations`; the 1 000 cap bounds the worst case to a few
million comparisons while the default configuration stays trivial. Long
animation frame samples carry at most eight sanitized script attributions,
and raw observer attribution objects are never stored — `sourceLabel` is the
explicit sanitization boundary that keeps URLs, query strings, and tokens out
of diagnostic reports.

## Package status

This package is currently `private: true` and not published. It becomes
publishable when it has an initial local npm registration under the
maintainer's auth, a `.sampo/config.toml` release-group entry, and npm
Trusted Publishing/OIDC configured for the release workflow; until then it
must not be listed as a required dependency of the generated game starter.

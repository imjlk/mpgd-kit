# Performance acceptance

Opt into a consumer-owned foreground measurement after target builds:

```sh
mpgd game accept . --targets web-preview --profile staging --performance
```

The game must supply `performance:e2e` (override with `--performance-script`) and
`agent/performance.budget.json` (override with `--performance-budget`). The script
receives `MPGD_ACCEPTANCE_TARGETS`, `MPGD_ACCEPTANCE_PROFILE`,
`MPGD_RELEASE_MANIFEST_FILE`, `MPGD_PERFORMANCE_BUDGET_FILE` and
`MPGD_PERFORMANCE_REPORT_FILE`. The last defaults to
`artifacts/performance/report.json` and may be configured within the game root.
The collector owns browser/device setup, scenario execution, warm-up, sampling
and foreground checks. Missing required scripts, nonzero collection exits or
invalid evidence fail acceptance. Omission preserves the existing step/report
contract and creates no performance requirement.

A budget has schemaVersion 1 and 1–64 profiles. Each profile names an id, target,
scenario, renderer, device, minimum sample count (at least two), and 1–66 metric
budgets: the two built-ins (`intervalMs`, `totalCpuMs`) plus at most 64 custom
names of at most 64 characters matching `[a-z][a-zA-Z0-9]*`, excluding
`constructor` and `prototype`. Metric names match the profiler snapshot; thresholds `p95`, `p99` and
`max` are milliseconds. Choose limits for the actual device/scenario. There is
no global FPS threshold.

```json
{
  "schemaVersion": 1,
  "profiles": [{
    "id": "steady", "target": "web-preview", "scenario": "steady",
    "renderer": "webgl", "device": "desktop", "minSamples": 60,
    "metrics": { "update": { "p95": 5, "p99": 8 }, "intervalMs": { "p99": 30 } },
    "maxExcludedFrames": 0, "maxHeapGrowthBytes": 1048576,
    "hitchThresholdMs": 50, "maxHitches": 0
  }]
}
```

These example numbers illustrate the schema. Calibrate them for your product;
retain existing acceptance limits during refactoring. `maxExcludedFrames` and
`maxHeapGrowthBytes` are optional. A hitch budget requires both a positive
`hitchThresholdMs` and `maxHitches`; hitch counts cover the collector's complete
sample window, including frames outside the retained percentile ring.

The report has schemaVersion 1, an ISO `generatedAt`, acceptance `profile`, a
hashed `budget` reference and `measurements` covering every budget profile once.
Each measurement contains:

- `id`, plus `context` with matching target/scenario/renderer/device, positive
  devicePixelRatio (at most 64), logicalWidth/logicalHeight/backingWidth/backingHeight,
  `foreground: true`, and `instrumentation: { trace: false, screenshots: false }`.
- A hashed `artifact` reference matching the current built target and its release
  manifest when target building is enabled. Use the exported
  `collectGameplayE2EPathEvidence(gameRoot, file, label)` for budget/artifact refs.
- `snapshot` containing frames, excludedFrames, retainedSamples, metrics
  (`{ p50, p95, p99 }` per field), maximums and sampleCounts. This accepts the
  relevant fields from `NamedFrameProfiler.snapshot()` directly. Every budgeted
  metric needs enough retained samples, finite nonnegative ordered quantiles and
  a consistent maximum. The first/nonpositive cadence interval is excluded by
  the profiler and does not count towards intervalMs's minimum.
- `heapGrowthBytes` when requested (finite signed bytes; a decrease is allowed),
  and `hitches: { thresholdMs, count, samples }` when requested. The threshold
  must match the budget; total hitch samples must meet its minimum.

Before collection, acceptance removes old report output and pins the bounded
budget file's identity. It accepts only timestamps within the current collection
run and rechecks budget/artifact hashes. Report/budget JSON is capped at 1 MiB;
paths must stay inside the game root without symlink escapes and cannot collide
with the acceptance JSON/Markdown output paths. Handoff JSON and
Markdown carry the checked report/budget evidence and any validation error.

CPU fields are synchronous measured spans. They can overlap and do not certify
GPU time or FPS. Budget actual frame cadence separately using intervalMs. Trace
and screenshots belong in a separate diagnostic run because their overhead can
change the frame sample. This gate verifies the collector's report and current
provenance; it is not independent hardware attestation. Collect on actual target
devices where that evidence is required.

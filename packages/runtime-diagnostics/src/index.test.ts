import {
  createLongAnimationFrameScriptSamples,
  FRAME_HITCH_CAUSES,
  FrameHitchRecorder,
  readUsedHeapBytes,
  type FrameHitchSample,
  type FramePerformanceSnapshot,
  type LongTaskSample,
} from './index';

interface TestFrameSample extends FrameHitchSample {
  readonly activeObjects: number;
  readonly phase: string;
}

const createFrame = (
  atMs: number,
  frameDeltaMs: number,
  input: Partial<TestFrameSample> = {},
): TestFrameSample => ({
  activeObjects: 128,
  atMs,
  frameDeltaMs,
  hidden: false,
  phase: 'combat',
  previousRenderWorkMs: 1,
  updateWorkMs: 1,
  visibilityInterrupted: false,
  ...input,
});

const createLongTask = (input: Partial<LongTaskSample> = {}): LongTaskSample => ({
  atMs: 100,
  durationMs: 50,
  hidden: false,
  name: 'worker.js',
  startAtMs: 50,
  ...input,
});

// 1. Game-owned generic context survives recording, aggregation, and eviction.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>({ historyLimit: 2 });

  recorder.record(createFrame(10, 16));
  recorder.record(createFrame(20, 60, { activeObjects: 200 }));
  recorder.record(createFrame(30, 70, { activeObjects: 300 }));
  recorder.record(createFrame(40, 80, { activeObjects: 400 }));

  const snapshot = recorder.snapshot();
  assertEqual(snapshot.frameCount, 4, 'frames recorded');
  assertEqual(snapshot.hitchCount, 3, 'hitches counted');
  assertDeepEqual(
    snapshot.hitches.map(({ activeObjects }) => activeObjects),
    [300, 400],
    'retained hitch context keeps newest samples',
  );
  assertEqual(snapshot.lastFrame?.phase ?? '', 'combat', 'last frame keeps game context');
}

// 2. Normal frames, update hitches, and render hitches stay separated.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>();

  recorder.record(createFrame(16, 16));
  const beforeHitches = recorder.snapshot().hitchCount;
  recorder.record(createFrame(40, 30, { updateWorkMs: 25 }));
  recorder.record(createFrame(70, 30, { previousRenderWorkMs: 25 }));

  const snapshot = recorder.snapshot();
  assertEqual(beforeHitches, 0, 'a quiet frame is not a hitch');
  assertEqual(snapshot.hitchCount, 2, 'work thresholds mark hitches without frame spikes');
  assertDeepEqual(
    snapshot.hitches.map((sample) => recorder.diagnose(sample).cause),
    ['game-update', 'phaser-render'],
    'update and render hitches are distinguished',
  );
  assertEqual(snapshot.worstUpdateWorkMs, 25, 'worst update work tracked');
  assertEqual(snapshot.worstRenderWorkMs, 25, 'worst render work tracked');
}

// 3. Hidden and visibility interruptions are aggregated, not averaged in.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>();

  recorder.record(createFrame(16, 16));
  recorder.record(createFrame(2_016, 2_000, { hidden: true }));
  recorder.record(createFrame(2_032, 16, { visibilityInterrupted: true }));
  recorder.record(createFrame(2_048, 16));

  const snapshot = recorder.snapshot();
  assertEqual(snapshot.frameCount, 4, 'interrupted frames still count as frames');
  assertEqual(snapshot.foregroundFrameCount, 2, 'foreground excludes both interruption kinds');
  assertEqual(snapshot.interruptionCount, 2, 'both interruptions are visible');
  assertEqual(snapshot.schedulerInterruptionCount, 0, 'observed interruptions are not estimates');
  assertEqual(snapshot.interruptedFrameMs, 2_016, 'excluded interruption time is inspectable');
  assertEqual(snapshot.worstInterruptedFrameMs, 2_000, 'worst interrupted gap tracked');
  assertEqual(snapshot.averageFrameMs, 16, 'interrupted gaps stay out of the average');
  assertEqual(snapshot.hitchCount, 0, 'interrupted frames are not diagnosed as hitches');
}

// 4. Estimated scheduler interruptions are counted separately and excluded.
{
  const quietRecorder = new FrameHitchRecorder<TestFrameSample>();
  quietRecorder.record(createFrame(16, 16));
  quietRecorder.record(createFrame(2_016, 2_000));

  const quiet = quietRecorder.snapshot();
  assertEqual(quiet.schedulerInterruptionCount, 1, 'unexplained multi-second gap is estimated');
  assertEqual(quiet.foregroundFrameCount, 1, 'estimated interruptions leave the average');
  assertEqual(quiet.interruptedFrameMs, 2_000, 'estimated interruption time is reported');
  assertEqual(quiet.interruptionCount, 1, 'estimated interruptions are counted, not dropped');
  assertEqual(quiet.averageFrameMs, 16, 'average keeps only foreground frames');

  const explainedRecorder = new FrameHitchRecorder<TestFrameSample>();
  explainedRecorder.recordLongTask(
    createLongTask({
      atMs: 2_016,
      durationMs: 1_900,
      startAtMs: 116,
    }),
  );
  explainedRecorder.record(createFrame(2_016, 2_000));

  const explained = explainedRecorder.snapshot();
  assertEqual(explained.schedulerInterruptionCount, 0, 'related work defeats the estimate');
  assertEqual(explained.foregroundFrameCount, 1, 'explained gap stays foreground');
  assertEqual(explained.hitchCount, 1, 'explained gap is a diagnosed hitch');
  assertEqual(
    explained.hitchCauseCounts['main-thread-long-task'],
    1,
    'explained gap attributes to the long task',
  );

  const suspended = new FrameHitchRecorder<TestFrameSample>();
  suspended.recordLongAnimationFrame({
    atMs: 1_200,
    blockingDurationMs: 5,
    durationMs: 1_200,
    hidden: false,
    renderDurationMs: 5,
    scriptDurationMs: 5,
    scriptInvocations: 1,
    startAtMs: 0,
    styleAndLayoutDurationMs: 5,
  });
  suspended.record(createFrame(1_216, 1_200));

  const suspendedSnapshot = suspended.snapshot();
  assertEqual(
    suspendedSnapshot.schedulerInterruptionCount,
    1,
    'idle LoAF across suspension is estimated scheduler work',
  );
  assertEqual(suspendedSnapshot.interruptedFrameMs, 1_200, 'suspension gap time stays inspectable');
}

// 5. Related long task, long animation frame, and resource evidence is used.
{
  const browserRecorder = new FrameHitchRecorder<TestFrameSample>();
  browserRecorder.recordLongAnimationFrame({
    atMs: 180,
    blockingDurationMs: 130,
    durationMs: 180,
    hidden: false,
    renderDurationMs: 145,
    scriptDurationMs: 8,
    scriptInvocations: 1,
    startAtMs: 0,
    styleAndLayoutDurationMs: 120,
  });
  assertEqual(
    browserRecorder.diagnose(createFrame(185, 185)).cause,
    'browser-rendering',
    'style-heavy LoAF estimates browser rendering',
  );

  const scriptRecorder = new FrameHitchRecorder<TestFrameSample>();
  scriptRecorder.recordLongAnimationFrame({
    atMs: 180,
    blockingDurationMs: 150,
    durationMs: 180,
    hidden: false,
    renderDurationMs: 30,
    scriptDurationMs: 150,
    scriptInvocations: 3,
    startAtMs: 0,
    styleAndLayoutDurationMs: 20,
  });
  assertEqual(
    scriptRecorder.diagnose(createFrame(185, 185)).cause,
    'main-thread-long-task',
    'script-dominated LoAF estimates main-thread work',
  );

  const resourceRecorder = new FrameHitchRecorder<TestFrameSample>();
  resourceRecorder.recordResourceLoad({
    atMs: 75,
    durationMs: 75,
    hidden: false,
    name: 'late-texture.png',
    startAtMs: 0,
  });
  const resourceDiagnosis = resourceRecorder.diagnose(createFrame(80, 80));
  assertEqual(resourceDiagnosis.cause, 'resource-load', 'overlapping load estimates resource work');
  assertEqual(resourceDiagnosis.relatedResourceLoadMs, 75, 'related load duration is reported');

  const heapRecorder = new FrameHitchRecorder<TestFrameSample>();
  assertEqual(
    heapRecorder.diagnose(createFrame(280, 280, { heapDeltaBytes: -35 * 1024 * 1024 })).cause,
    'memory-reclamation',
    'sub-second gap with a large heap drop estimates reclamation',
  );
}

// 6. Late and out-of-order observations follow the documented contract.
{
  const lateRecorder = new FrameHitchRecorder<TestFrameSample>();
  lateRecorder.record(createFrame(200, 150));
  assertEqual(
    lateRecorder.snapshot().hitchCauseCounts['scheduler-or-compositor'],
    1,
    'an unexplained hitch first estimates the scheduler',
  );

  lateRecorder.recordLongAnimationFrame({
    atMs: 200,
    blockingDurationMs: 140,
    durationMs: 150,
    hidden: false,
    renderDurationMs: 100,
    scriptDurationMs: 30,
    scriptInvocations: 2,
    startAtMs: 50,
    styleAndLayoutDurationMs: 60,
  });

  const late = lateRecorder.snapshot();
  assertEqual(
    late.hitchCauseCounts['browser-rendering'],
    1,
    'a late observation relabels the retained hitch',
  );
  assertEqual(
    late.hitchCauseCounts['scheduler-or-compositor'],
    0,
    'the pre-arrival estimate does not linger',
  );
  assertEqual(late.longAnimationFrameCount, 1, 'late observations still count');

  const orderRecorder = new FrameHitchRecorder<TestFrameSample>();
  orderRecorder.record(createFrame(100, 16));
  orderRecorder.record(createFrame(200, 16));
  orderRecorder.record(createFrame(150, 16));

  const orderSnapshot = orderRecorder.snapshot();
  assertEqual(orderSnapshot.frameCount, 3, 'out-of-order frames still count');
  assertEqual(orderSnapshot.lastFrame?.atMs ?? 0, 200, 'last frame keeps the newest atMs');
  assertEqual(orderSnapshot.hitchCount, 0, 'quiet out-of-order frames add no hitches');

  // Out-of-order observations keep last*/histories anchored to event time.
  const observationOrderRecorder = new FrameHitchRecorder<TestFrameSample>({ historyLimit: 2 });
  observationOrderRecorder.recordLongTask(
    createLongTask({ atMs: 500, durationMs: 40, startAtMs: 460 }),
  );
  observationOrderRecorder.recordLongTask(
    createLongTask({ atMs: 900, durationMs: 60, startAtMs: 840 }),
  );
  // A buffered oldest task arrives last; it must not replace the newest or evict newer evidence.
  observationOrderRecorder.recordLongTask(
    createLongTask({ atMs: 400, durationMs: 30, startAtMs: 370 }),
  );
  observationOrderRecorder.recordResourceLoad({
    atMs: 800,
    durationMs: 50,
    hidden: false,
    name: 'newest.png',
    startAtMs: 750,
  });
  observationOrderRecorder.recordResourceLoad({
    atMs: 700,
    durationMs: 50,
    hidden: false,
    name: 'older.png',
    startAtMs: 650,
  });

  const observationOrder = observationOrderRecorder.snapshot();
  assertEqual(
    observationOrder.lastLongTask?.atMs ?? 0,
    900,
    'last long task keeps the newest atMs',
  );
  assertEqual(
    observationOrder.lastResourceLoad?.name ?? '',
    'newest.png',
    'last resource load keeps the newest atMs',
  );
  assertEqual(observationOrder.longTaskCount, 3, 'out-of-order observations still count');
  assertEqual(observationOrder.worstLongTaskMs, 60, 'worsts ignore arrival order');
  assertEqual(
    observationOrderRecorder.diagnose(createFrame(560, 100)).cause,
    'main-thread-long-task',
    'eviction drops the oldest by event time, not the newest by arrival',
  );

  // The scheduler estimate is decided at record time and stays final.
  const finalityRecorder = new FrameHitchRecorder<TestFrameSample>();
  finalityRecorder.record(createFrame(2_016, 2_000));
  finalityRecorder.recordLongTask(
    createLongTask({
      atMs: 2_016,
      durationMs: 1_900,
      startAtMs: 116,
    }),
  );

  const finality = finalityRecorder.snapshot();
  assertEqual(finality.schedulerInterruptionCount, 1, 'the recorded estimate is not reclassified');
  assertEqual(finality.interruptionCount, 1, 'the exclusion stays visible');
  assertEqual(finality.hitchCount, 0, 'the frame was not retained as a hitch');

  const windowRecorder = new FrameHitchRecorder<TestFrameSample>();
  windowRecorder.recordLongTask(createLongTask({ atMs: 900, durationMs: 20, startAtMs: 880 }));
  assertNotEqual(
    windowRecorder.diagnose(createFrame(1_050, 100)).cause,
    'main-thread-long-task',
    'a task before the frame window is not attributed',
  );

  windowRecorder.recordLongTask(createLongTask({ atMs: 1_040, durationMs: 80, startAtMs: 960 }));
  assertEqual(
    windowRecorder.diagnose(createFrame(1_050, 100)).cause,
    'main-thread-long-task',
    'a task inside the frame window is attributed',
  );
}

// 7. Cumulative counters survive retained-history eviction.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>({ historyLimit: 1 });

  recorder.record(createFrame(120, 120, { heapDeltaBytes: -12 * 1024 * 1024 }));
  recorder.record(createFrame(180, 60));

  const snapshot = recorder.snapshot();
  assertEqual(snapshot.hitchCount, 2, 'hitch count stays cumulative');
  assertEqual(snapshot.memoryReclamationHitchCount, 1, 'GC evidence stays cumulative');
  assertEqual(
    snapshot.hitchCauseCounts['memory-reclamation'],
    0,
    'cause counts cover only retained samples',
  );
  assertEqual(snapshot.hitches.length, 1, 'history is evicted to the configured limit');
}

// 8. Mutating a returned snapshot cannot corrupt internal state.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>();
  recorder.record(createFrame(60, 60));
  recorder.record(createFrame(120, 60));
  recorder.recordLongTask(createLongTask({ atMs: 120, durationMs: 55, startAtMs: 65 }));

  const snapshot = recorder.snapshot();
  const before = recorder.snapshot();

  (snapshot.hitches as TestFrameSample[]).pop();
  (snapshot.hitches[0] as { atMs: number }).atMs = 99_999;
  (snapshot.hitchCauseCounts as Record<string, number>)['game-update'] = 99;
  (snapshot.lastFrame as { atMs: number }).atMs = 99_999;
  (snapshot.lastLongTask as { durationMs: number }).durationMs = 99_999;

  const after = recorder.snapshot();
  assertEqual(after.hitches.length, before.hitches.length, 'hitch list is isolated');
  assertEqual(
    after.hitches[0]?.atMs ?? 0,
    before.hitches[0]?.atMs ?? 0,
    'hitch samples are copies',
  );
  assertEqual(
    after.hitchCauseCounts['game-update'],
    before.hitchCauseCounts['game-update'],
    'cause counts are isolated',
  );
  assertEqual(after.lastFrame?.atMs ?? 0, before.lastFrame?.atMs ?? 0, 'last frame is a copy');
  assertEqual(
    after.lastLongTask?.durationMs ?? 0,
    before.lastLongTask?.durationMs ?? 0,
    'last long task is a copy',
  );
}

// 9. reset clears aggregates and histories while the reset marker climbs.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>();
  recorder.record(createFrame(60, 60));
  recorder.recordLongTask(createLongTask());
  recorder.recordLongAnimationFrame({
    atMs: 100,
    blockingDurationMs: 60,
    durationMs: 90,
    hidden: false,
    renderDurationMs: 20,
    scriptDurationMs: 60,
    scriptInvocations: 1,
    startAtMs: 10,
    styleAndLayoutDurationMs: 10,
  });
  recorder.recordResourceLoad({
    atMs: 120,
    durationMs: 80,
    hidden: false,
    name: 'atlas.png',
    startAtMs: 40,
  });

  recorder.reset();

  const cleared: FramePerformanceSnapshot<TestFrameSample> = recorder.snapshot();
  assertEqual(cleared.resetCount, 1, 'reset marker increments');
  assertEqual(recorder.getResetCount(), 1, 'reset marker is readable directly');
  assertEqual(cleared.frameCount, 0, 'frames cleared');
  assertEqual(cleared.foregroundFrameCount, 0, 'foreground cleared');
  assertEqual(cleared.hitchCount, 0, 'hitches cleared');
  assertEqual(cleared.hitches.length, 0, 'hitch history cleared');
  assertEqual(cleared.interruptionCount, 0, 'interruptions cleared');
  assertEqual(cleared.interruptedFrameMs, 0, 'interrupted time cleared');
  assertEqual(cleared.schedulerInterruptionCount, 0, 'scheduler estimates cleared');
  assertEqual(cleared.longTaskCount, 0, 'long tasks cleared');
  assertEqual(cleared.longAnimationFrameCount, 0, 'long animation frames cleared');
  assertEqual(cleared.resourceLoadCount, 0, 'resource loads cleared');
  assertEqual(cleared.memoryReclamationHitchCount, 0, 'cumulative GC evidence cleared');
  assertEqual(cleared.averageFrameMs, 0, 'averages cleared');
  assertEqual(cleared.worstFrameMs, 0, 'worsts cleared');
  assertEqual(cleared.worstLongTaskMs, 0, 'worst long task cleared');
  assertEqual(cleared.lastFrame, undefined, 'last frame cleared');
  assertEqual(cleared.lastLongTask, undefined, 'last long task cleared');
  assertEqual(cleared.lastLongAnimationFrame, undefined, 'last long animation frame cleared');
  assertEqual(cleared.lastResourceLoad, undefined, 'last resource load cleared');

  // Pre-reset observations must not leak into the new window.
  recorder.record(createFrame(1_050, 100));
  const afterReset = recorder.snapshot();
  assertEqual(afterReset.hitchCount, 1, 'new window records its own hitches');
  assertEqual(
    afterReset.hitchCauseCounts['main-thread-long-task'],
    0,
    'pre-reset observations do not leak',
  );
}

// 10. Invalid options and samples are rejected without partial state changes.
{
  assertThrows(() => new FrameHitchRecorder({ hitchThresholdMs: Number.NaN }));
  assertThrows(() => new FrameHitchRecorder({ hitchThresholdMs: 0 }));
  assertThrows(() => new FrameHitchRecorder({ hitchThresholdMs: -50 }));
  assertThrows(() => new FrameHitchRecorder({ hitchThresholdMs: Number.POSITIVE_INFINITY }));
  assertThrows(() => new FrameHitchRecorder({ workThresholdMs: Number.NaN }));
  assertThrows(() => new FrameHitchRecorder({ workThresholdMs: -1 }));
  assertThrows(() => new FrameHitchRecorder({ historyLimit: -1 }));
  assertThrows(() => new FrameHitchRecorder({ historyLimit: 1.5 }));
  assertThrows(() => new FrameHitchRecorder({ historyLimit: 1_001 }));
  assertThrows(() => new FrameHitchRecorder({ historyLimit: Number.NaN }));

  const recorder = new FrameHitchRecorder<TestFrameSample>();
  recorder.record(createFrame(16, 16));
  const before = recorder.snapshot();

  assertThrows(() => recorder.record(createFrame(40, -5)));
  assertThrows(() => recorder.record(createFrame(Number.NaN, 16)));
  assertThrows(() => recorder.record(createFrame(40, Number.POSITIVE_INFINITY)));
  assertThrows(() => recorder.record(createFrame(40, 16, { updateWorkMs: Number.NaN })));
  assertThrows(() => recorder.record(createFrame(40, 16, { previousRenderWorkMs: -1 })));
  assertThrows(() => recorder.record(createFrame(40, 16, { hidden: 1 as unknown as boolean })));
  assertThrows(() =>
    recorder.record(createFrame(40, 16, { visibilityInterrupted: 'yes' as unknown as boolean })));
  assertThrows(() => recorder.record(createFrame(40, 16, { heapBytes: -1 })));
  assertThrows(() => recorder.record(createFrame(40, 16, { heapBytes: Number.NaN })));
  assertThrows(() => recorder.record(createFrame(40, 16, { heapDeltaBytes: Number.NaN })));
  assertThrows(() => recorder.recordLongTask(createLongTask({ atMs: 10, startAtMs: 50 })));
  assertThrows(() => recorder.recordLongTask(createLongTask({ durationMs: -1 })));
  assertThrows(() => recorder.recordLongTask(createLongTask({ name: 3 as unknown as string })));
  assertThrows(() => recorder.recordLongTask(createLongTask({ hidden: 0 as unknown as boolean })));
  assertThrows(() =>
    recorder.recordLongAnimationFrame({
      atMs: 100,
      blockingDurationMs: -1,
      durationMs: 100,
      hidden: false,
      renderDurationMs: 1,
      scriptDurationMs: 1,
      scriptInvocations: 1,
      startAtMs: 0,
      styleAndLayoutDurationMs: 1,
    }));
  assertThrows(() =>
    recorder.recordLongAnimationFrame({
      atMs: 100,
      blockingDurationMs: 1,
      durationMs: 100,
      hidden: false,
      renderDurationMs: 1,
      scriptDurationMs: 1,
      scriptInvocations: 1.5,
      startAtMs: 0,
      styleAndLayoutDurationMs: 1,
    }));
  assertThrows(() =>
    recorder.recordLongAnimationFrame({
      atMs: 100,
      blockingDurationMs: 1,
      durationMs: 100,
      hidden: false,
      renderDurationMs: 1,
      scriptDurationMs: 1,
      scriptInvocations: 1,
      scripts: Array.from({ length: 9 }, () => ({
        durationMs: 1,
        forcedStyleAndLayoutDurationMs: 0,
        invoker: '',
        invokerType: '',
        pauseDurationMs: 0,
        sourceFunctionName: '',
        sourceUrl: '',
      })),
      startAtMs: 0,
      styleAndLayoutDurationMs: 1,
    }));
  assertThrows(() =>
    recorder.recordLongAnimationFrame({
      atMs: 100,
      blockingDurationMs: 1,
      durationMs: 100,
      hidden: false,
      renderDurationMs: 1,
      scriptDurationMs: 1,
      scriptInvocations: 1,
      scripts: [null as unknown as {
        durationMs: number;
        forcedStyleAndLayoutDurationMs: number;
        invoker: string;
        invokerType: string;
        pauseDurationMs: number;
        sourceFunctionName: string;
        sourceUrl: string;
      }],
      startAtMs: 0,
      styleAndLayoutDurationMs: 1,
    }));
  assertThrows(() =>
    recorder.recordResourceLoad({ atMs: 10, durationMs: 5, hidden: false, name: 'x', startAtMs: 50 }));
  assertThrows(() => recorder.diagnose(createFrame(50, Number.NaN)));

  const after = recorder.snapshot();
  assertEqual(after.frameCount, before.frameCount, 'rejected frames leave counts untouched');
  assertEqual(after.hitchCount, before.hitchCount, 'rejected frames leave hitches untouched');
  assertEqual(after.longTaskCount, 0, 'rejected long tasks are not counted');
  assertEqual(after.longAnimationFrameCount, 0, 'rejected long animation frames are not counted');
  assertEqual(after.resourceLoadCount, 0, 'rejected resource loads are not counted');
}

// 11. Long recordings never exceed the configured history bounds.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>({ historyLimit: 3 });

  for (let index = 0; index < 5_000; index += 1) {
    const atMs = 16 * (index + 1);
    const frameDeltaMs = index % 250 === 0 ? 60 : 16;
    recorder.record(createFrame(atMs, frameDeltaMs));
    if (index % 500 === 0 && index > 0) {
      recorder.recordLongTask(createLongTask({ atMs, durationMs: 80, startAtMs: atMs - 80 }));
      recorder.recordResourceLoad({
        atMs,
        durationMs: 70,
        hidden: false,
        name: 'chunk.png',
        startAtMs: atMs - 70,
      });
    }
  }

  const snapshot = recorder.snapshot();
  assertEqual(snapshot.frameCount, 5_000, 'all frames counted');
  assertEqual(snapshot.hitchCount, 20, 'all hitches counted cumulatively');
  assertAtMost(snapshot.hitches.length, 3, 'hitch history bounded');
  assertEqual(snapshot.longTaskCount, 9, 'long tasks counted');
  assertEqual(snapshot.resourceLoadCount, 9, 'resource loads counted');
}

// 12. The recorder imports and runs with no DOM, engine, or platform globals.
{
  assertEqual(typeof globalThis.document, 'undefined', 'no document global in this environment');
  assertEqual(typeof globalThis.window, 'undefined', 'no window global in this environment');

  const recorder = new FrameHitchRecorder<FrameHitchSample>({ historyLimit: 4 });
  recorder.record(createFrame(16, 16));
  recorder.record(createFrame(80, 64));
  const snapshot = recorder.snapshot();
  assertEqual(snapshot.hitchCount, 1, 'headless recording still works');
  assertEqual(FRAME_HITCH_CAUSES.length, 7, 'cause enum is stable');
}

// Script attributions are capped, ordered, and sanitized.
{
  const timings = Array.from({ length: 12 }, (_, index) => ({
    duration: index * 10,
    invoker: 'Animation',
    invokerType: 'user',
    sourceFunctionName: `step${index}`,
    sourceURL: `https://cdn.example.test/assets/bundle-${index}.js?token=secret-${index}`,
  }));
  const samples = createLongAnimationFrameScriptSamples(timings, (url) => url.split('?')[0] ?? '');

  assertEqual(samples.length, 8, 'only the longest attributions survive');
  assertEqual(samples[0]?.durationMs ?? 0, 110, 'longest attribution comes first');
  assertEqual(
    samples[0]?.sourceUrl ?? '',
    'https://cdn.example.test/assets/bundle-11.js',
    'source URLs are sanitized labels',
  );

  assertThrows(
    () => createLongAnimationFrameScriptSamples([{ duration: Number.NaN }], (url) => url),
  );
  assertThrows(() =>
    createLongAnimationFrameScriptSamples([{ duration: -1 }], (url) => url));
  assertThrows(() =>
    createLongAnimationFrameScriptSamples([{ invoker: 5 as unknown as string }], (url) => url));
  assertThrows(() =>
    createLongAnimationFrameScriptSamples(
      Array.from({ length: 1_025 }, () => ({ duration: 1 })),
      (url) => url,
    ));
  assertThrows(() =>
    createLongAnimationFrameScriptSamples([{ duration: 1 }], undefined as unknown as (url: string) => string));
  assertThrows(() =>
    createLongAnimationFrameScriptSamples(
      [null as unknown as { duration?: number }],
      (url) => url,
    ));

  const unlabeled = createLongAnimationFrameScriptSamples([{ duration: 5 }], (url) => url);
  assertEqual(unlabeled[0]?.sourceUrl ?? 'missing', '', 'missing source URLs stay empty');
}

// readUsedHeapBytes accepts structural sources only.
{
  assertEqual(
    readUsedHeapBytes({ memory: { usedJSHeapSize: 42_000_000 } }),
    42_000_000,
    'heap reading returned',
  );
  assertEqual(readUsedHeapBytes({}), undefined, 'missing memory extension yields undefined');
  assertEqual(readUsedHeapBytes(undefined), undefined, 'missing source yields undefined');
  assertEqual(
    readUsedHeapBytes({ memory: { usedJSHeapSize: Number.POSITIVE_INFINITY } }),
    undefined,
    'non-finite readings yield undefined',
  );
}

// historyLimit 0 is an explicit, consistent contract.
{
  const recorder = new FrameHitchRecorder<TestFrameSample>({ historyLimit: 0 });
  recorder.record(createFrame(60, 60));
  recorder.record(createFrame(120, 70));

  const snapshot = recorder.snapshot();
  assertEqual(snapshot.hitchCount, 2, 'counters work without retained history');
  assertEqual(snapshot.hitches.length, 0, 'no samples are retained');
  assertEqual(snapshot.lastFrame?.atMs ?? 0, 120, 'the last frame is still tracked');
}

console.log('Runtime diagnostics tests passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertNotEqual<T>(actual: T, unexpected: T, message: string): void {
  if (actual === unexpected) {
    throw new Error(`${message}: both values were ${String(actual)}.`);
  }
}

function assertAtMost(actual: number, maximum: number, message: string): void {
  if (actual > maximum) {
    throw new Error(`${message}: expected at most ${String(maximum)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message: string): void {
  const encoded = JSON.stringify({ actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${encoded}.`);
  }
}

function assertThrows(action: () => void): void {
  let threw = false;

  try {
    action();
  } catch {
    threw = true;
  }

  if (!threw) {
    throw new Error('Expected the call to throw, but it completed.');
  }
}

import { NamedFrameProfiler } from './frame-profiler.js';

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}
function throws(action: () => void): void {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error('Expected rejection.');
  }
}

let now = 100;
const fields = ['physicsMs', 'audioMs', 'messages'] as const;
const profiler = new NamedFrameProfiler(fields, () => now, 2);
profiler.begin();
profiler.measure('physicsMs', () => {
  now += 2;
});
profiler.measure('audioMs', () => {
  now += 3;
});
profiler.current.messages = 7;
now += 4;
profiler.finish();
equal(profiler.snapshot().current, {
  intervalMs: 0,
  totalCpuMs: 9,
  physicsMs: 2,
  audioMs: 3,
  messages: 7,
});
equal(profiler.snapshot().sampleCounts.intervalMs, 0);
for (const cost of [2, 3]) {
  now += 100;
  profiler.begin();
  profiler.measure('physicsMs', () => {
    now += cost;
  });
  profiler.finish();
}
const snapshot = profiler.snapshot();
equal(snapshot.frames, 3);
equal(snapshot.retainedSamples, 2);
equal(snapshot.metrics.physicsMs, { p50: 2, p95: 3, p99: 3 });
snapshot.current.physicsMs = 999;
snapshot.metrics.physicsMs.p95 = 999;
snapshot.maximums.physicsMs = 999;
equal(profiler.snapshot().maximums.physicsMs, 3);

profiler.reset();
now = 0;
profiler.begin();
profiler.finish();
now = 1_000;
profiler.begin(true);
now += 200;
profiler.finish();
now += 16;
profiler.begin();
profiler.finish();
now += 16;
profiler.begin();
profiler.finish();
equal(profiler.snapshot().frames, 3);
equal(profiler.snapshot().excludedFrames, 1);
equal(profiler.snapshot().metrics.intervalMs.p99, 16);
equal(profiler.snapshot().sampleCounts.intervalMs, 1);

profiler.begin();
const failure = new Error('host failure');
let caught: unknown;
try {
  profiler.measure('physicsMs', () => {
    now += 5;
    throw failure;
  });
} catch (error) {
  caught = error;
}
equal(caught === failure, true);
equal(profiler.current.physicsMs, 5);
throws(() => profiler.begin());
throws(() => profiler.measure('missing' as typeof fields[number], () => 0));
throws(() => profiler.measure('physicsMs', () => profiler.reset()));
profiler.current.messages = NaN;
const frames = 3;
throws(() => profiler.finish());
profiler.current.messages = 0;
equal(profiler.snapshot().frames, frames);
const old = now;
now -= 1;
throws(() => profiler.finish());
now = old;
profiler.finish();
throws(() => profiler.finish());

for (const capacity of [0, -1, NaN, 1.5, Infinity, 1_001]) {
  throws(() => new NamedFrameProfiler([], () => 0, capacity));
}
for (const names of [
  ['x', 'x'],
  ['intervalMs'],
  ['constructor'],
  ['__proto__'],
  ['a'.repeat(65)],
]) {
  throws(() => new NamedFrameProfiler(names, () => 0));
}
throws(
  () => new NamedFrameProfiler(
    Array.from({ length: 65 }, (_, i) => `metric${i}`),
    () => 0,
  ),
);
const mutable = ['workMs'];
const bounded = new NamedFrameProfiler(mutable, () => now, 3);
mutable[0] = 'changed';
for (let index = 0; index < 5_000; index += 1) {
  now += 16;
  bounded.begin();
  bounded.finish();
}
equal(bounded.snapshot().retainedSamples, 3);
equal(bounded.snapshot().frames, 5_000);
equal(bounded.snapshot().metrics.workMs?.p99, 0);
const badClock = new NamedFrameProfiler([], () => NaN);
throws(() => badClock.begin());
equal(badClock.snapshot().frames, 0);
throws(() => new NamedFrameProfiler(new Array<string>(1), () => 0));

console.log('Named frame profiler tests passed.');

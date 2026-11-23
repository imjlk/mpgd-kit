import {
  createAnalyticsReporter,
  createBufferedAnalyticsSink,
  defaultBufferedAnalyticsSinkCapacity,
  type AnalyticsEvent,
} from './index';

const failingSinkReporter = createAnalyticsReporter({
  target: 'android',
  sessionId: 'session-1',
  now: () => '2026-07-04T00:00:00.000Z',
  sink: {
    track() {
      throw new Error('analytics unavailable');
    },
  },
});

await failingSinkReporter.track({
  name: 'purchase_granted',
  properties: {
    productId: 'COINS_100',
  },
});

const invalidReporter = createAnalyticsReporter({
  target: 'android',
  sessionId: 'session-1',
  now: () => '2026-07-04T00:00:00.000Z',
});

let invalidEventRejected = false;

try {
  await invalidReporter.track({
    name: 'purchase_granted',
    properties: {
      productId: 'COINS_100',
      invalid: null,
    } as never,
  });
} catch {
  invalidEventRejected = true;
}

assertEqual(
  invalidEventRejected,
  true,
  'invalid analytics event properties should still fail validation',
);

// Under its capacity, a buffered sink keeps every event a reporter tracks, in order.
const reportedSink = createBufferedAnalyticsSink();
const bufferedReporter = createAnalyticsReporter({
  target: 'browser',
  sessionId: 'session-1',
  now: () => '2026-07-04T00:00:00.000Z',
  sink: reportedSink,
});
await bufferedReporter.track({ name: 'game_started', properties: { configTarget: 'web' } });
await bufferedReporter.track({
  name: 'stage_finished',
  properties: { stage: 1, skipped: undefined },
});
assertJsonEqual(
  reportedSink.events,
  [
    {
      name: 'game_started',
      target: 'browser',
      sessionId: 'session-1',
      occurredAt: '2026-07-04T00:00:00.000Z',
      properties: { configTarget: 'web' },
    },
    {
      name: 'stage_finished',
      target: 'browser',
      sessionId: 'session-1',
      occurredAt: '2026-07-04T00:00:00.000Z',
      properties: { stage: 1 },
    },
  ],
  'reported events under the capacity',
);
assertEqual(reportedSink.trackedCount, 2, 'tracked count under the capacity');

// Past its capacity, the sink drops the oldest events and keeps the rest in order.
const smallSink = createBufferedAnalyticsSink({ capacity: 3 });
const liveEvents = smallSink.events;
const tracked = [0, 1, 2, 3, 4].map(stageEvent);
for (const event of tracked.slice(0, 3)) {
  await smallSink.track(event);
}
assertJsonEqual(stageNumbers(smallSink.events), [0, 1, 2], 'events at the capacity');
for (const event of tracked.slice(3)) {
  await smallSink.track(event);
}
assertJsonEqual(stageNumbers(smallSink.events), [2, 3, 4], 'events past the capacity');
assertEqual(smallSink.events[0], tracked[2], 'kept events are the tracked objects');
assertEqual(smallSink.trackedCount, 5, 'tracked count past the capacity');
assertEqual(liveEvents, smallSink.events, 'events stay one live array past the capacity');

// Without a capacity, the documented default applies.
assertEqual(defaultBufferedAnalyticsSinkCapacity, 1_000, 'default capacity');
const defaultSink = createBufferedAnalyticsSink();
for (let index = 0; index < defaultBufferedAnalyticsSinkCapacity + 2; index += 1) {
  await defaultSink.track(stageEvent(index));
}
assertEqual(
  defaultSink.events.length,
  defaultBufferedAnalyticsSinkCapacity,
  'events kept by default',
);
assertEqual(defaultSink.events[0]?.properties.stage, 2, 'oldest event kept by default');
assertEqual(
  defaultSink.events.at(-1)?.properties.stage,
  defaultBufferedAnalyticsSinkCapacity + 1,
  'newest event kept by default',
);
assertEqual(
  defaultSink.trackedCount,
  defaultBufferedAnalyticsSinkCapacity + 2,
  'tracked count by default',
);

// A zero capacity keeps nothing and still counts.
const countingSink = createBufferedAnalyticsSink({ capacity: 0 });
await countingSink.track(stageEvent(0));
await countingSink.track(stageEvent(1));
assertEqual(countingSink.events.length, 0, 'events kept with a zero capacity');
assertEqual(countingSink.trackedCount, 2, 'tracked count with a zero capacity');

// An invalid event is neither kept nor counted.
let invalidBufferedEventRejected = false;
try {
  await smallSink.track({ ...stageEvent(5), properties: { stage: null } } as never);
} catch {
  invalidBufferedEventRejected = true;
}
assertEqual(invalidBufferedEventRejected, true, 'invalid buffered event rejected');
assertJsonEqual(stageNumbers(smallSink.events), [2, 3, 4], 'events after an invalid event');
assertEqual(smallSink.trackedCount, 5, 'tracked count after an invalid event');

for (const capacity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  let rejected: unknown;
  try {
    createBufferedAnalyticsSink({ capacity });
  } catch (error) {
    rejected = error;
  }
  assertEqual(rejected instanceof RangeError, true, `capacity ${String(capacity)} rejected`);
}

console.log('Analytics reporter smoke test passed.');

function stageEvent(stage: number): AnalyticsEvent {
  return {
    name: 'stage_finished',
    target: 'browser',
    sessionId: 'session-1',
    occurredAt: '2026-07-04T00:00:00.000Z',
    properties: { stage },
  };
}

function stageNumbers(events: readonly AnalyticsEvent[]): unknown[] {
  return events.map((event) => event.properties.stage);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

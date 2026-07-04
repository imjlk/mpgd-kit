import { createAnalyticsReporter } from './index';

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

console.log('Analytics reporter smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

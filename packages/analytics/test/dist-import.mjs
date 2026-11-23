// Plain Node must load the shipped exports without a TS loader hiding missing .js extensions.
import assert from 'node:assert/strict';

import {
  createAnalyticsReporter,
  createBufferedAnalyticsSink,
  createMonetizationAttempt,
  defaultBufferedAnalyticsSinkCapacity,
} from '@mpgd/analytics';

const events = [];
const attempt = createMonetizationAttempt({
  operationId: 'published-consumer',
  operation: 'purchase',
  stage: 'checkout',
  mode: 'test',
  now: () => 10,
  observer: (event) => { events.push(event); },
});
attempt.finish('checkout', 'cancelled', 'USER_CANCELLED');
attempt.finish('fulfillment', 'succeeded');
assert.deepEqual(events.map(({ status, sequence }) => [status, sequence]), [
  ['requested', 0], ['cancelled', 1],
]);
assert.equal(events[1].errorCode, 'USER_CANCELLED');
await createAnalyticsReporter({ target: 'server', sessionId: 'published-consumer' }).track({
  name: 'purchase_started', properties: { productId: 'logical-product' },
});
const sink = createBufferedAnalyticsSink({ capacity: 1 });
const reporter = createAnalyticsReporter({ target: 'server', sessionId: 'published-consumer', sink });
await reporter.track({ name: 'purchase_started', properties: { productId: 'logical-product' } });
await reporter.track({ name: 'purchase_granted', properties: { productId: 'logical-product' } });
assert.deepEqual(sink.events.map(({ name }) => name), ['purchase_granted']);
assert.equal(sink.trackedCount, 2);
assert.equal(defaultBufferedAnalyticsSinkCapacity, 1_000);
console.info('Published analytics entry smoke passed.');

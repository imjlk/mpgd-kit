// Plain Node must load the shipped exports without a TS loader hiding missing .js extensions.
import assert from 'node:assert/strict';

import { createAnalyticsReporter, createMonetizationAttempt } from '@mpgd/analytics';

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
console.info('Published analytics entry smoke passed.');

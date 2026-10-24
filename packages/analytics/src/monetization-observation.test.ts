import {
  createMonetizationAttempt,
  type MonetizationAttempt,
  type MonetizationObservation,
} from './monetization-observation';

const events: MonetizationObservation[] = [];
let now = 10;
const attempt = createMonetizationAttempt({
  operationId: 'diagnostic-1',
  operation: 'purchase',
  stage: 'identity',
  mode: 'test',
  productId: 'HINT_PACK_20',
  now: () => now,
  observer: (event) => {
    events.push(event);
  },
});
now = 20;
attempt.stage('checkout', 'requested');
now = 30;
attempt.finish('checkout', 'cancelled', 'USER_CANCELLED');
attempt.finish('fulfillment', 'succeeded');
attempt.stage('confirmation', 'succeeded');
equal(
  events.map(({ stage, status, sequence, elapsedMs }) => ({ stage, status, sequence, elapsedMs })),
  [
    { stage: 'identity', status: 'requested', sequence: 0, elapsedMs: 0 },
    { stage: 'checkout', status: 'requested', sequence: 1, elapsedMs: 10 },
    { stage: 'checkout', status: 'cancelled', sequence: 2, elapsedMs: 20 },
  ],
);
equal(events[2]?.errorCode, 'USER_CANCELLED');
equal(
  events.some((event) => event.status === 'succeeded'),
  false,
);
for (const observer of [
  () => {
    throw Error('sync');
  },
  async () => {
    throw Error('async');
  },
]) {
  const broken = createMonetizationAttempt({
    operationId: 'diagnostic-2',
    operation: 'restore',
    stage: 'recovery',
    mode: 'live',
    now: () => {
      throw Error('clock');
    },
    observer,
  });
  broken.finish('recovery', 'pending');
}
const invalid = createMonetizationAttempt({
  operationId: 'not an id',
  operation: 'promotion',
  stage: 'claim',
  mode: 'unknown',
  now: () => 0,
  observer: (event) => {
    events.push(event);
  },
});
invalid.finish('claim', 'failed', 'secret message');
equal(events.length, 3);
const reentrantEvents: MonetizationObservation[] = [];
const reentrant: MonetizationAttempt = createMonetizationAttempt({
  operationId: 'reentrant',
  operation: 'purchase',
  stage: 'checkout',
  mode: 'live',
  now: () => 0,
  observer(event) {
    reentrantEvents.push(event);
    if (event.status === 'succeeded') {
      reentrant.finish('fulfillment', 'succeeded');
      reentrant.stage('confirmation', 'requested');
    }
  },
});
reentrant.finish('fulfillment', 'succeeded');
equal(reentrantEvents.length, 2);
const metadataEvents: MonetizationObservation[] = [];
const metadata = {
  operationId: 'immutable-id',
  operation: 'promotion' as const,
  stage: 'claim' as const,
  mode: 'test' as const,
  productId: 'logical-product',
  now: () => Number.NaN,
  observer: (event: MonetizationObservation) => {
    metadataEvents.push(event);
  },
};
const snapshot = createMonetizationAttempt(metadata);
metadata.operationId = 'should not leak';
metadata.productId = 'private receipt';
snapshot.stage('finalization', 'pending', 'private error message');
snapshot.finish('finalization', 'failed', 'PROMOTION_FAILED');
equal(
  metadataEvents.map((event) => [event.operationId, event.productId, event.elapsedMs]),
  [
    ['immutable-id', 'logical-product', null],
    ['immutable-id', 'logical-product', null],
    ['immutable-id', 'logical-product', null],
  ],
);
equal(metadataEvents[1]?.errorCode, undefined);
equal(metadataEvents[2]?.errorCode, 'PROMOTION_FAILED');
const invalidProduct = createMonetizationAttempt({
  ...metadata,
  operationId: 'valid-id',
  productId: 'private receipt',
});
invalidProduct.finish('claim', 'succeeded');
equal(metadataEvents.length, 3);
createMonetizationAttempt({
  operationId: 'no-observer', operation: 'catalog', stage: 'catalog', mode: 'unknown', now: () => 0,
}).finish('catalog', 'unavailable');
const unresolved = createMonetizationAttempt({
  ...metadata,
  operationId: 'unresolved',
  productId: 'valid',
  observer: () => new Promise<void>(() => {}),
});
unresolved.finish('finalization', 'pending');
await Promise.resolve();
console.log('Monetization observer lifecycle passed.');

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

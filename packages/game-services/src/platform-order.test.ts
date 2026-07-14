import {
  assertFulfillPlatformOrderInput,
  assertRefundPlatformOrderInput,
  createPlatformOrderIdempotencyKey,
  type FulfillPlatformOrderInput,
  type RefundPlatformOrderInput,
} from './platform-order';

const evidence = Object.freeze({
  schema: 'devvit.payment-order.v1',
  payload: Object.freeze({
    status: 'PAID',
  }),
});
const fulfillInput = Object.freeze({
  target: 'reddit',
  orderId: 'order-1',
  playerId: 'player-1',
  platformSku: 'cosmetic_1',
  paidAt: '2026-07-15T00:00:00.000Z',
  evidence,
}) satisfies FulfillPlatformOrderInput;
const refundInput = Object.freeze({
  target: 'reddit',
  orderId: 'order-1',
  playerId: 'player-1',
  platformSku: 'cosmetic_1',
  refundedAt: '2026-07-15T01:00:00.000Z',
  evidence: Object.freeze({
    schema: 'devvit.payment-order.v1',
    payload: Object.freeze({ status: 'REVERTED' }),
  }),
}) satisfies RefundPlatformOrderInput;

assertEqual(assertFulfillPlatformOrderInput(fulfillInput), fulfillInput);
assertEqual(assertRefundPlatformOrderInput(refundInput), refundInput);
assertEqual(createPlatformOrderIdempotencyKey(fulfillInput), 'reddit:order-1');

assertThrows(
  () => assertFulfillPlatformOrderInput({ ...fulfillInput, target: 'ait' } as never),
  'target must be reddit',
);
assertThrows(
  () => assertFulfillPlatformOrderInput({ ...fulfillInput, orderId: ' order-1' }),
  'orderId must be a non-empty identifier',
);
assertThrows(
  () => assertFulfillPlatformOrderInput({ ...fulfillInput, paidAt: 'tomorrow' }),
  'paidAt must be an ISO 8601 UTC timestamp',
);
assertThrows(
  () => assertFulfillPlatformOrderInput({
    ...fulfillInput,
    paidAt: '2026-02-31T00:00:00.000Z',
  }),
  'paidAt must be an ISO 8601 UTC timestamp',
);
assertThrows(
  () => assertRefundPlatformOrderInput({
    ...refundInput,
    refundedAt: '2025-02-29T01:00:00Z',
  }),
  'refundedAt must be an ISO 8601 UTC timestamp',
);
const wholeSecondInput = {
  ...fulfillInput,
  paidAt: '2024-02-29T00:00:00Z',
};
assertEqual(assertFulfillPlatformOrderInput(wholeSecondInput), wholeSecondInput);
assertThrows(
  () => assertRefundPlatformOrderInput({
    ...refundInput,
    evidence: {
      ...refundInput.evidence,
      payload: { status: null },
    },
  } as never),
  'evidence.payload values must be strings, numbers, or booleans',
);

console.log('Platform order contract tests passed.');

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(actual)} to equal ${String(expected)}.`);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }
    throw error;
  }

  throw new Error(`Expected callback to throw an error containing ${JSON.stringify(message)}.`);
}

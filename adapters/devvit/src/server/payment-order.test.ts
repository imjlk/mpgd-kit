import { describe, expect, it } from 'vitest';

import { normalizeDevvitFulfillmentOrder, normalizeDevvitRefundOrder } from './payment-order';

const paidOrder = Object.freeze({
  id: 'order-1',
  userId: 'player-1',
  postId: 'post-1',
  environment: 'sandbox',
  status: 'PAID',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:01:00.000Z',
  products: Object.freeze([
    Object.freeze({ sku: 'ttokdoku_final_nine_ember', quantity: 1 }),
  ]),
});

describe('Devvit payment order normalization', () => {
  it('normalizes paid orders for authoritative fulfillment', () => {
    expect(normalizeDevvitFulfillmentOrder(paidOrder)).toEqual({
      target: 'reddit',
      orderId: 'order-1',
      playerId: 'player-1',
      platformSku: 'ttokdoku_final_nine_ember',
      paidAt: '2026-07-15T00:01:00.000Z',
      evidence: {
        schema: 'devvit.payment-order.v1',
        payload: {
          orderId: 'order-1',
          status: 'PAID',
          occurredAt: '2026-07-15T00:01:00.000Z',
          postId: 'post-1',
          environment: 'sandbox',
        },
      },
    });
  });

  it('normalizes reverted orders separately from fulfillment', () => {
    expect(normalizeDevvitRefundOrder({
      ...paidOrder,
      status: 'REVERTED',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).toMatchObject({
      target: 'reddit',
      orderId: 'order-1',
      playerId: 'player-1',
      platformSku: 'ttokdoku_final_nine_ember',
      refundedAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it('fails closed for the wrong lifecycle, missing user, or multiple products', () => {
    expect(() => normalizeDevvitFulfillmentOrder({
      ...paidOrder,
      status: 'REVERTED',
    })).toThrow('status must be PAID');
    expect(() => normalizeDevvitFulfillmentOrder({
      ...paidOrder,
      userId: undefined,
    })).toThrow('order.userId must be a string');
    expect(() => normalizeDevvitFulfillmentOrder({
      ...paidOrder,
      products: [{ sku: 'first' }, { sku: 'second' }],
    })).toThrow('exactly one product');
  });
});

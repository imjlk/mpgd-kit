import { describe, expect, it } from 'vitest';

import { normalizeDevvitFulfillmentOrder, normalizeDevvitRefundOrder } from './payment-order';

const paidOrder = Object.freeze({
  id: 'order-1',
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
    expect(normalizeDevvitFulfillmentOrder({
      order: paidOrder,
      playerId: 'player-1',
    })).toEqual({
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
          playerIdSource: 'devvit-context',
          postId: 'post-1',
          environment: 'sandbox',
        },
      },
    });
  });

  it('normalizes reverted orders separately from fulfillment', () => {
    expect(normalizeDevvitRefundOrder({
      order: {
        ...paidOrder,
        status: 'REVERTED',
        updatedAt: '2026-07-16T00:00:00.000Z',
      },
      playerId: 'player-1',
    })).toMatchObject({
      target: 'reddit',
      orderId: 'order-1',
      playerId: 'player-1',
      platformSku: 'ttokdoku_final_nine_ember',
      refundedAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it('fails closed for the wrong lifecycle, mismatched context, or multiple products', () => {
    expect(() => normalizeDevvitFulfillmentOrder({
      order: { ...paidOrder, status: 'REVERTED' },
      playerId: 'player-1',
    })).toThrow('status must be PAID');
    expect(() => normalizeDevvitFulfillmentOrder({
      order: { ...paidOrder, userId: 'player-2' },
      playerId: 'player-1',
    })).toThrow('must match the authenticated context playerId');
    expect(() => normalizeDevvitFulfillmentOrder({
      order: { ...paidOrder, products: [{ sku: 'first' }, { sku: 'second' }] },
      playerId: 'player-1',
    })).toThrow('exactly one product');
  });
});

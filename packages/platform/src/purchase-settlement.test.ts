import { describe, expect, it } from 'vitest';

import { findAuthoritativePurchaseSettlement } from './index.js';

describe('authoritative purchase settlement', () => {
  it('does not treat native completion or an unrelated restore as a grant', () => {
    const purchase = {
      status: 'completed' as const,
      transactionId: 'order-1',
      entitlementIds: ['hint-20'],
    };
    const restore = {
      restoredEntitlements: [],
      settledPurchases: [{
        transactionId: 'order-2',
        productId: 'hint-20',
        status: 'granted' as const,
      }],
    };
    expect(findAuthoritativePurchaseSettlement({
      productId: 'hint-20',
      transactionId: 'order-1',
      purchase,
      restore,
    })).toBeNull();
  });

  it('accepts a server grant even when the wallet later changes', () => {
    expect(findAuthoritativePurchaseSettlement({
      productId: 'hint-20',
      purchase: {
        status: 'completed',
        transactionId: 'order-1',
        entitlementIds: ['hint-20'],
        authoritativeGrant: { ledgerEntryId: 'ledger-1' },
      },
    })).toEqual({
      transactionId: 'order-1',
      productId: 'hint-20',
      status: 'granted',
      ledgerEntryId: 'ledger-1',
    });
  });

  it('lets a verified refund supersede a past checkout grant', () => {
    expect(findAuthoritativePurchaseSettlement({
      productId: 'hint-20',
      transactionId: 'order-1',
      purchase: {
        status: 'completed',
        transactionId: 'order-1',
        entitlementIds: ['hint-20'],
        authoritativeGrant: { ledgerEntryId: 'ledger-1' },
      },
      restore: {
        restoredEntitlements: [],
        settledPurchases: [{
          transactionId: 'order-1',
          productId: 'hint-20',
          status: 'refunded',
        }],
      },
    })).toMatchObject({ status: 'refunded' });
  });

  it('does not let a different restored order shadow a confirmed checkout', () => {
    expect(findAuthoritativePurchaseSettlement({
      productId: 'hint-20',
      purchase: {
        status: 'completed',
        transactionId: 'fresh-order',
        entitlementIds: ['hint-20'],
        authoritativeGrant: { ledgerEntryId: 'fresh-ledger', alreadyProcessed: true },
      },
      restore: {
        restoredEntitlements: [],
        settledPurchases: [{
          transactionId: 'old-order',
          productId: 'hint-20',
          status: 'refunded',
        }],
      },
    })).toMatchObject({
      transactionId: 'fresh-order',
      status: 'granted',
      alreadyProcessed: true,
    });
  });

  it('does not guess which historical order settled when no transaction ID is known', () => {
    expect(findAuthoritativePurchaseSettlement({
      productId: 'hint-20',
      restore: {
        restoredEntitlements: [],
        settledPurchases: [
          { transactionId: 'order-1', productId: 'hint-20', status: 'granted' },
          { transactionId: 'order-2', productId: 'hint-20', status: 'refunded' },
        ],
      },
    })).toBeNull();
  });
});

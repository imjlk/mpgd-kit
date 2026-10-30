import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertActiveSubscription,
  assertCommerceBridgeFinishTransactionPayload,
  assertCommerceBridgeGetCapabilitiesPayload,
  assertCommerceBridgeGetCapabilitiesResult,
  assertCommerceCapabilities,
  assertCommerceEvent,
  assertCommerceEventEnvelope,
  assertCommercePurchaseTransition,
  assertCreditLot,
  assertRequestPurchaseInput,
  assertRequestPurchaseResult,
  assertRequestPurchaseSupported,
  assertStoreProduct,
  assertStorePurchase,
  canTransitionCommercePurchase,
  commerceBridgeMethods,
  CommerceError,
  commerceErrorCodes,
  commerceErrorInfoOf,
  commerceEventBufferLimit,
  commerceProtocol,
  commerceProtocolVersion,
  commercePurchaseStates,
  commercePurchaseTransitions,
  createCommerceEventBuffer,
  createDerivedPurchaseIdempotencyKey,
  createGooglePlayTokenPurchaseKey,
  createUnsupportedCommerceCapabilities,
  defaultCommerceErrorRetryable,
  isCommerceCapabilities,
  isStorePurchase,
  isTerminalCommercePurchaseState,
  summarizeCommercePurchaseState,
  terminalCommercePurchaseStates,
  type CommerceCapabilities,
  type CommerceEvent,
  type CommerceProvider,
  type CommercePurchaseState,
  type RequestPurchaseResult,
  type StorePurchase,
} from './commerce.js';
import { PlatformOperationError } from './index.js';

const evidence = { schema: 'fixture.purchase.v1', payload: { token: 'token-1' } };

function purchase(overrides: Partial<StorePurchase> = {}): StorePurchase {
  return {
    store: 'fixture.client-token',
    transactionId: 'tx-1',
    storeSku: 'gems.small',
    logicalId: 'gems_small',
    quantity: 1,
    state: 'purchased',
    purchasedAt: '2026-10-01T00:00:00Z',
    token: 'token-1',
    evidence,
    ...overrides,
  };
}

function withoutLogicalId(value: StorePurchase): StorePurchase {
  const { logicalId: _logicalId, ...rest } = value;
  return rest;
}

function capabilities(overrides: Partial<CommerceCapabilities> = {}): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'client',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: 'available',
    ...overrides,
  };
}

function provider(overrides: Partial<CommerceProvider> = {}): CommerceProvider {
  return {
    store: 'fixture.client-token',
    async getCapabilities() {
      return capabilities();
    },
    async fetchProducts() {
      return [
        {
          logicalId: 'gems_small',
          store: 'fixture.client-token',
          storeSku: 'gems.small',
          kind: 'consumable',
          title: 'Gems',
          description: 'A small pile',
          price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990000 },
        },
        {
          logicalId: 'remove_ads',
          store: 'fixture.client-token',
          storeSku: 'remove.ads',
          kind: 'durable',
          title: 'Remove ads',
          description: '',
          price: { formatted: '$1.99', currencyCode: 'USD' },
        },
        {
          logicalId: 'membership_plus',
          store: 'fixture.client-token',
          storeSku: 'membership.plus',
          kind: 'subscription',
          title: 'Plus',
          description: '',
          price: { formatted: '30 credits', currencyCode: 'credits' },
        },
      ];
    },
    async requestPurchase() {
      return { outcome: 'launched' };
    },
    async getAvailablePurchases() {
      return [];
    },
    subscribe() {
      return () => {};
    },
    ...overrides,
  };
}

describe('commerce protocol constants', () => {
  it('exposes the draft protocol version and bridge method names', () => {
    expect(commerceProtocolVersion).toBe('2.0.0-draft.1');
    expect(commerceProtocol).toBe('mpgd.commerce.v2');
    expect([...commerceBridgeMethods]).toEqual([
      'commerce.v2.getCapabilities',
      'commerce.v2.fetchProducts',
      'commerce.v2.requestPurchase',
      'commerce.v2.getAvailablePurchases',
      'commerce.v2.finishTransaction',
      'commerce.v2.restorePurchases',
    ]);
  });
});

describe('purchase lifecycle state machine', () => {
  const allowed: readonly (readonly [CommercePurchaseState, CommercePurchaseState])[] = [
    ['requested', 'launched'],
    ['requested', 'cancelled'],
    ['requested', 'failed'],
    ['launched', 'pending'],
    ['launched', 'purchased'],
    ['launched', 'cancelled'],
    ['launched', 'failed'],
    ['pending', 'purchased'],
    ['pending', 'cancelled'],
    ['pending', 'failed'],
    ['pending', 'verifying'],
    ['purchased', 'verifying'],
    ['verifying', 'granted'],
    ['verifying', 'pending'],
    ['verifying', 'rejected'],
    ['granted', 'finishing'],
    ['granted', 'finished'],
    ['granted', 'revoked'],
    ['finishing', 'finished'],
    ['finishing', 'revoked'],
    ['finished', 'revoked'],
  ];

  it('allows every transition in the RFC table and nothing else', () => {
    const allowedSet = new Set(allowed.map(([from, to]) => `${from}>${to}`));
    for (const from of commercePurchaseStates) {
      for (const to of commercePurchaseStates) {
        expect(canTransitionCommercePurchase(from, to), `${from} -> ${to}`)
          .toBe(allowedSet.has(`${from}>${to}`));
      }
    }
    expect(Object.keys(commercePurchaseTransitions).sort())
      .toEqual([...commercePurchaseStates].sort());
  });

  it('rejects a sample of disallowed transitions', () => {
    for (const [from, to] of [
      ['requested', 'purchased'],
      ['requested', 'granted'],
      ['purchased', 'granted'],
      ['verifying', 'finished'],
      ['granted', 'rejected'],
      ['finished', 'granted'],
      ['cancelled', 'launched'],
      ['revoked', 'finished'],
      ['pending', 'granted'],
    ] as const) {
      expect(() => assertCommercePurchaseTransition(from, to)).toThrow(
        `Commerce purchase state cannot move from ${from} to ${to}.`,
      );
    }
    expect(() => assertCommercePurchaseTransition('granted', 'finishing')).not.toThrow();
  });

  it('declares exactly the five terminal states', () => {
    expect([...terminalCommercePurchaseStates].sort())
      .toEqual(['cancelled', 'failed', 'finished', 'rejected', 'revoked']);
    for (const state of commercePurchaseStates) {
      expect(isTerminalCommercePurchaseState(state), state)
        .toBe((terminalCommercePurchaseStates as readonly string[]).includes(state));
    }
    // A finished record stays addressable so a later ledger revocation can reach it.
    expect(commercePurchaseTransitions.finished).toEqual(['revoked']);
    for (const state of ['cancelled', 'failed', 'rejected', 'revoked'] as const) {
      expect(commercePurchaseTransitions[state]).toEqual([]);
    }
  });

  it('maps states onto the existing summary statuses', () => {
    const summaries = Object.fromEntries(
      commercePurchaseStates.map((state) => [state, summarizeCommercePurchaseState(state)]),
    );
    expect(summaries).toEqual({
      requested: 'pending',
      launched: 'pending',
      pending: 'pending',
      purchased: 'pending',
      verifying: 'pending',
      granted: 'granted',
      finishing: 'granted',
      finished: 'granted',
      cancelled: 'cancelled',
      failed: 'failed',
      rejected: 'rejected',
      revoked: 'revoked',
    });
  });
});

describe('CommerceError', () => {
  it('marks only NETWORK and STORE_UNAVAILABLE retryable by default', () => {
    const retryable = commerceErrorCodes.filter((code) => defaultCommerceErrorRetryable(code));
    expect(retryable).toEqual(['NETWORK', 'STORE_UNAVAILABLE']);
    expect(new CommerceError('USER_CANCELLED').retryable).toBe(false);
    expect(new CommerceError('OUTCOME_UNKNOWN').retryable).toBe(false);
    expect(new CommerceError('NETWORK').retryable).toBe(true);
    expect(new CommerceError('NETWORK', { retryable: false }).retryable).toBe(false);
  });

  it('keeps the store code and converts to error info', () => {
    const error = new CommerceError('STORE_UNAVAILABLE', {
      storeCode: 'PLAY_BILLING_SERVICE_UNAVAILABLE',
      message: 'Play is down.',
    });
    expect(error).toBeInstanceOf(PlatformOperationError);
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.toCommerceErrorInfo()).toEqual({
      code: 'STORE_UNAVAILABLE',
      retryable: true,
      storeCode: 'PLAY_BILLING_SERVICE_UNAVAILABLE',
      message: 'Play is down.',
    });
    expect(commerceErrorInfoOf(error)).toEqual(error.toCommerceErrorInfo());
  });

  it('normalizes foreign failures to UNKNOWN and keeps their code', () => {
    expect(commerceErrorInfoOf(new PlatformOperationError({ code: 'STOREKIT_UNAVAILABLE', retryable: true })))
      .toEqual({ code: 'UNKNOWN', retryable: true, storeCode: 'STOREKIT_UNAVAILABLE', message: 'The platform operation failed.' });
    expect(commerceErrorInfoOf({ code: 'ITEM_UNAVAILABLE', storeCode: '4' }))
      .toEqual({ code: 'ITEM_UNAVAILABLE', retryable: false, storeCode: '4' });
    expect(commerceErrorInfoOf(new Error('boom'))).toEqual({ code: 'UNKNOWN', retryable: false, message: 'boom' });
    expect(commerceErrorInfoOf('nope')).toEqual({ code: 'UNKNOWN', retryable: false });
  });
});

describe('capabilities', () => {
  it('returns a fresh unsupported snapshot on every call', () => {
    const first = createUnsupportedCommerceCapabilities();
    const second = createUnsupportedCommerceCapabilities();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.purchase).not.toBe(second.purchase);
    expect(first.lifecycle).not.toBe(second.lifecycle);
    expect(first.availability).toBe('unsupported');
    expect(isCommerceCapabilities(first)).toBe(true);
  });

  it('rejects unsupported kinds and quantities before purchase UI opens', () => {
    const input = { logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' } as const;
    expect(() => assertRequestPurchaseSupported(capabilities(), input, 'consumable')).not.toThrow();
    expect(() => assertRequestPurchaseSupported(capabilities(), input, 'subscription'))
      .toThrow(CommerceError);
    expect(() => assertRequestPurchaseSupported(capabilities(), { ...input, quantity: 1 }, 'consumable'))
      .not.toThrow();
    let caught: unknown;
    try {
      assertRequestPurchaseSupported(capabilities(), { ...input, quantity: 2 }, 'consumable');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommerceError);
    expect((caught as CommerceError).code).toBe('ITEM_UNAVAILABLE');
    const withQuantity = capabilities({
      purchase: { consumable: true, durable: true, subscription: false, quantity: true },
    });
    expect(() => assertRequestPurchaseSupported(withQuantity, { ...input, quantity: 2 }, 'consumable'))
      .not.toThrow();
  });
});

describe('event buffer', () => {
  function updated(id: string): CommerceEvent {
    return { type: 'purchaseUpdated', purchase: purchase({ transactionId: id }) };
  }
  const errorEvent: CommerceEvent = {
    type: 'purchaseError',
    logicalId: 'gems_small',
    error: { code: 'USER_CANCELLED', retryable: false },
  };
  const subscriptionEvent: CommerceEvent = {
    type: 'subscriptionUpdated',
    subscription: {
      store: 'fixture.credit-wallet',
      logicalId: 'membership_plus',
      subscriptionId: 'sub-1',
      periodIndex: 0,
      state: 'active',
      startedAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-31T00:00:00Z',
      autoRenew: true,
    },
  };

  it('defaults to the documented limit and drains in order', () => {
    expect(commerceEventBufferLimit).toBe(64);
    const buffer = createCommerceEventBuffer();
    for (let index = 0; index < 70; index += 1) {
      buffer.push(updated(`tx-${index}`));
    }
    expect(buffer.size).toBe(64);
    const drained: string[] = [];
    expect(buffer.drain((event) => {
      drained.push(event.type === 'purchaseUpdated' ? event.purchase.transactionId : event.type);
    })).toBe(64);
    expect(drained[0]).toBe('tx-6');
    expect(drained[63]).toBe('tx-69');
    expect(buffer.size).toBe(0);
  });

  it('drops the oldest purchaseUpdated first and errors only when none remain', () => {
    const buffer = createCommerceEventBuffer({ limit: 3 });
    buffer.push(errorEvent);
    buffer.push(updated('tx-1'));
    buffer.push(subscriptionEvent);
    buffer.push(updated('tx-2'));
    const kept: CommerceEvent[] = [];
    buffer.drain((event) => kept.push(event));
    expect(kept.map((event) => (event.type === 'purchaseUpdated' ? event.purchase.transactionId : event.type)))
      .toEqual(['purchaseError', 'subscriptionUpdated', 'tx-2']);

    // A full buffer of non-recoverable events drops the newest purchaseUpdated
    // itself: it is still reported by getAvailablePurchases.
    buffer.push(errorEvent);
    buffer.push(subscriptionEvent);
    buffer.push(errorEvent);
    buffer.push(updated('tx-3'));
    expect(buffer.size).toBe(3);
    buffer.push(errorEvent);
    const second: CommerceEvent[] = [];
    buffer.drain((event) => second.push(event));
    expect(second.map((event) => event.type))
      .toEqual(['subscriptionUpdated', 'purchaseError', 'purchaseError']);
  });

  it('never evicts a revoked purchaseUpdated ahead of other events', () => {
    const buffer = createCommerceEventBuffer({ limit: 2 });
    const revoked: CommerceEvent = {
      type: 'purchaseUpdated',
      purchase: purchase({ transactionId: 'tx-revoked', state: 'revoked' }),
    };
    buffer.push(revoked);
    buffer.push(errorEvent);
    // The recoverable purchased event is evicted, not the revocation.
    buffer.push(updated('tx-1'));
    expect(buffer.size).toBe(2);
    // With nothing recoverable left, eviction falls back to the oldest event.
    buffer.push(subscriptionEvent);
    const kept: CommerceEvent[] = [];
    buffer.drain((event) => kept.push(event));
    expect(kept).toEqual([errorEvent, subscriptionEvent]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => createCommerceEventBuffer({ limit: 0 })).toThrow(RangeError);
  });
});

describe('derived idempotency keys', () => {
  it('uses the reference form for new stores', async () => {
    await expect(createDerivedPurchaseIdempotencyKey({
      store: 'fixture.client-token', transactionId: 'tx-1', token: 'token-1',
    })).resolves.toBe('store:fixture.client-token:tx-1');
  });

  it('percent-encodes components so the reference form is injective', async () => {
    const first = await createDerivedPurchaseIdempotencyKey({
      store: 'a:b', transactionId: 'c', token: 't',
    });
    const second = await createDerivedPurchaseIdempotencyKey({
      store: 'a', transactionId: 'b:c', token: 't',
    });
    expect(first).toBe('store:a%3Ab:c');
    expect(second).toBe('store:a:b%3Ac');
    expect(first).not.toBe(second);
    await expect(createDerivedPurchaseIdempotencyKey({
      store: 'wallet', transactionId: 'order/1 2', token: 't',
    })).resolves.toBe('store:wallet:order%2F1%202');
  });

  it('keeps the Apps in Toss order form', async () => {
    await expect(createDerivedPurchaseIdempotencyKey({
      store: 'apps-in-toss', transactionId: 'order-1', token: 'order-1',
    })).resolves.toBe('apps-in-toss:purchase:order-1');
    // Percent-encoded like the v1 createAppsInTossPurchaseIdempotencyKey helper.
    await expect(createDerivedPurchaseIdempotencyKey({
      store: 'apps-in-toss', transactionId: 'order:1/2', token: 'order:1/2',
    })).resolves.toBe('apps-in-toss:purchase:order%3A1%2F2');
  });

  it('hashes the Google Play token exactly like the v1 helper', async () => {
    const token = 'abc.def-ghi_123';
    const expected = `play-token-sha256:${createHash('sha256').update(token).digest('hex')}`;
    await expect(createGooglePlayTokenPurchaseKey(token)).resolves.toBe(expected);
    await expect(createDerivedPurchaseIdempotencyKey({
      store: 'google-play', transactionId: 'GPA.1234', token,
    })).resolves.toBe(expected);
    await expect(createGooglePlayTokenPurchaseKey(' padded ')).rejects.toThrow(TypeError);
    await expect(createGooglePlayTokenPurchaseKey('')).rejects.toThrow(TypeError);
  });

  it('rejects empty stores and transaction ids', async () => {
    await expect(createDerivedPurchaseIdempotencyKey({ store: '', transactionId: 'tx', token: 't' }))
      .rejects.toThrow(TypeError);
    await expect(createDerivedPurchaseIdempotencyKey({ store: 'x', transactionId: ' ', token: 't' }))
      .rejects.toThrow(TypeError);
  });
});

describe('typia validators', () => {
  it('accepts well-formed values', () => {
    expect(() => assertStorePurchase(purchase())).not.toThrow();
    expect(isStorePurchase(withoutLogicalId(purchase()))).toBe(true);
    expect(() => assertCommerceCapabilities(capabilities())).not.toThrow();
    expect(() => assertRequestPurchaseInput({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop', quantity: 2 }))
      .not.toThrow();
    expect(() => assertRequestPurchaseResult({ outcome: 'purchased', purchase: purchase() })).not.toThrow();
    expect(() => assertCommerceEventEnvelope({
      protocol: 'mpgd.commerce.v2',
      sequence: 0,
      event: { type: 'purchaseUpdated', purchase: purchase() },
    })).not.toThrow();
    expect(() => assertCreditLot({
      lotId: 'le-1',
      currency: 'credits',
      amount: 100,
      remaining: 0,
      createdAt: '2026-10-01T00:00:00Z',
      origin: { channel: 'store', store: 'google-play', titleId: 'title-a' },
      spendScope: { kind: 'title', titleId: 'title-a' },
    })).not.toThrow();
    expect(() => assertCommerceBridgeGetCapabilitiesPayload({ protocol: 'mpgd.commerce.v2' })).not.toThrow();
    expect(() => assertCommerceBridgeGetCapabilitiesResult({
      protocolVersion: commerceProtocolVersion, store: 'google-play', capabilities: capabilities(),
    })).not.toThrow();
    expect(() => assertCommerceBridgeFinishTransactionPayload({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
    })).not.toThrow();
    // A revoked (refunded) transaction's finish without a grant crosses the bridge as a flag.
    expect(() => assertCommerceBridgeFinishTransactionPayload({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, revoked: true,
    })).not.toThrow();
    expect(() => assertCommerceBridgeFinishTransactionPayload({
      transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, revoked: 'yes',
    })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => assertStorePurchase({ ...purchase(), extra: true })).toThrow();
    expect(() => assertCommerceCapabilities({ ...capabilities(), extra: true })).toThrow();
    expect(() => assertCommerceCapabilities({
      ...capabilities(),
      purchase: { consumable: true, durable: true, subscription: false, quantity: false, bundles: true },
    })).toThrow();
    expect(() => assertRequestPurchaseInput({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop', productId: 'gems_small',
    })).toThrow();
    expect(() => assertCommerceEvent({ type: 'purchaseUpdated', purchase: purchase(), sequence: 1 })).toThrow();
    expect(isCommerceCapabilities({ ...capabilities(), extra: 1 })).toBe(false);
  });

  it('rejects bad timestamps, quantities, sequences, and empty ids', () => {
    expect(() => assertStorePurchase(purchase({ purchasedAt: '2026-10-01' }))).toThrow();
    expect(() => assertStorePurchase(purchase({ purchasedAt: 'yesterday' }))).toThrow();
    expect(() => assertStorePurchase(purchase({ quantity: 0 }))).toThrow();
    expect(() => assertStorePurchase(purchase({ quantity: 1.5 }))).toThrow();
    expect(() => assertStorePurchase(purchase({ transactionId: '' }))).toThrow();
    expect(() => assertStorePurchase(purchase({ logicalId: '' }))).toThrow();
    expect(() => assertStorePurchase(purchase({ token: '' }))).toThrow();
    expect(() => assertRequestPurchaseInput({ logicalId: '', idempotencyKey: 'op-1', source: 'shop' })).toThrow();
    expect(() => assertRequestPurchaseInput({ logicalId: 'gems', idempotencyKey: 'op-1', source: 'shop', quantity: 0 }))
      .toThrow();
    expect(() => assertCommerceEventEnvelope({
      protocol: 'mpgd.commerce.v2',
      sequence: -1,
      event: { type: 'purchaseUpdated', purchase: purchase() },
    })).toThrow();
    expect(() => assertCommerceEventEnvelope({
      protocol: 'mpgd.commerce.v1',
      sequence: 0,
      event: { type: 'purchaseUpdated', purchase: purchase() },
    })).toThrow();
    expect(() => assertActiveSubscription({
      store: 'wallet',
      logicalId: 'membership_plus',
      subscriptionId: 'sub-1',
      periodIndex: 1.5,
      state: 'active',
      startedAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-31T00:00:00Z',
      autoRenew: true,
    })).toThrow();
    expect(() => assertStoreProduct({
      logicalId: 'gems_small',
      store: 'fixture',
      storeSku: 'gems.small',
      kind: 'bundle',
      title: 'x',
      description: '',
      price: { formatted: '$1', currencyCode: 'USD' },
    })).toThrow();
    expect(() => assertCommerceEvent({
      type: 'purchaseError',
      error: { code: 'NOT_A_CODE', retryable: false },
    })).toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformPurchasePresentationEvent } from '@mpgd/platform';
import { CommerceError, type RequestPurchaseInput } from '@mpgd/platform/commerce';

import { createFakeStoreSdk, fakePurchase, type FakeStoreSdk } from '../test/store-sdk-fixture.js';
import { purchasePresentationTimeoutMs } from './purchase-presentation.js';
import {
  createStoreCommerceProvider,
  type CreateStoreCommerceProviderInput,
} from './store-commerce-provider.js';

const products: CreateStoreCommerceProviderInput['products'] = [
  { logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' },
  { logicalId: 'remove_ads', storeSku: 'remove.ads', kind: 'durable' },
];

function createProvider(
  sdk: FakeStoreSdk,
  overrides: Partial<CreateStoreCommerceProviderInput> = {},
) {
  return createStoreCommerceProvider({
    sdk,
    products,
    evidenceSchema: 'fixture.store.v1',
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    ...overrides,
  });
}

function request(idempotencyKey: string, logicalId = 'gems_small'): RequestPurchaseInput {
  return { logicalId, idempotencyKey, source: 'shop' };
}

/** Facts and answers in the order a consumer observes them. */
function record(provider: ReturnType<typeof createProvider>) {
  const log: string[] = [];
  const facts: PlatformPurchasePresentationEvent[] = [];
  const unsubscribe = provider.presentation?.subscribe((event) => {
    facts.push(event);
    log.push(
      `${event.idempotencyKey}:${event.state}${event.reason === undefined ? '' : `:${event.reason}`}`,
    );
  });
  const answer = async (input: RequestPurchaseInput) => {
    try {
      const result = await provider.requestPurchase(input);
      log.push(`${input.idempotencyKey}:answer:${result.outcome}`);
      return result;
    } catch (error) {
      log.push(`${input.idempotencyKey}:answer:throw`);
      throw error;
    }
  };
  return { log, facts, answer, unsubscribe };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('store commerce provider presentation', () => {
  it('offers no presentation over an SDK that does not declare sheet facts', async () => {
    const sdk = createFakeStoreSdk();
    const provider = createProvider(sdk);
    expect(provider.presentation).toBeUndefined();
    await provider.requestPurchase(request('op-1'));
    expect(sdk.requestCalls[0]).not.toHaveProperty('presentationId');
  });

  it('reports open while the sheet is up and closed only on the SDK fact', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    const { log, facts, answer } = record(provider);
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'open');
    sdk.queueRequest({ outcome: 'launched' });

    await expect(answer(request('op-1'))).resolves.toEqual({ outcome: 'launched' });
    const presentationId = sdk.requestCalls[0]?.presentationId;
    expect(typeof presentationId).toBe('string');
    // A purchase update or a pending purchase is not closure.
    sdk.report(fakePurchase({ transactionId: 'tx-1', state: 'pending' }));
    sdk.report(fakePurchase({ transactionId: 'tx-1' }));
    expect(log).toEqual(['op-1:open', 'op-1:answer:launched']);

    sdk.present(presentationId, 'closed');
    sdk.present(presentationId, 'closed');
    sdk.present(presentationId, 'open');
    expect(log).toEqual(['op-1:open', 'op-1:answer:launched', 'op-1:closed']);
    expect(facts.map((fact) => fact.sequence)).toEqual([1, 2]);
  });

  it('answers a purchase result before the sheet closes and keeps waiting for closed', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    const { log, answer } = record(provider);
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'open');
    sdk.queueRequest({ outcome: 'purchased', purchase: fakePurchase({ transactionId: 'tx-1' }) });

    await answer(request('op-1'));
    expect(log).toEqual(['op-1:open', 'op-1:answer:purchased']);
    sdk.present(sdk.requestCalls[0]?.presentationId, 'closed');
    expect(log.at(-1)).toBe('op-1:closed');
  });

  it('reports not-started before the answer for every refusal before a sheet', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    let gateOpen = false;
    const provider = createProvider(sdk, {
      purchaseGate: () => (gateOpen ? { allowed: true } : { allowed: false }),
      accountBinding: async () => {
        throw new Error('lookup down');
      },
    });
    const { log, answer } = record(provider);

    // The gate refuses.
    await expect(answer(request('gate'))).resolves.toMatchObject({ outcome: 'failed' });
    // The gate allows; the account binding lookup fails (retryable).
    gateOpen = true;
    await expect(answer(request('binding'))).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ACCOUNT_BINDING_REQUIRED', retryable: true },
    });
    // An unmapped product throws before the store.
    await expect(answer(request('unknown', 'not_sold'))).rejects.toMatchObject({
      code: 'ITEM_UNAVAILABLE',
    });
    expect(log).toEqual([
      'gate:not-started',
      'gate:answer:failed',
      'binding:not-started',
      'binding:answer:failed',
      'unknown:not-started',
      'unknown:answer:throw',
    ]);
    expect(sdk.requestCalls).toHaveLength(0);
  });

  it('reports not-started when the store is unavailable or the SDK opened nothing', async () => {
    let availability: 'available' | 'temporarily-unavailable' = 'temporarily-unavailable';
    const sdk = createFakeStoreSdk({ presentation: true, availability: async () => availability });
    const provider = createProvider(sdk);
    const { log, answer } = record(provider);

    await expect(answer(request('down'))).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    availability = 'available';
    // The SDK reports its own not-started (a launch failure).
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'not-started');
    sdk.queueRequest({ outcome: 'failed', error: { code: 'NETWORK', retryable: true } });
    await answer(request('launch'));
    // The SDK settles with no fact at all: no sheet opened.
    sdk.onRequest = undefined;
    sdk.queueRequest({ throws: { code: 'PLAY_BILLING_SERVICE_UNAVAILABLE' } });
    await answer(request('silent'));
    expect(log).toEqual([
      'down:not-started',
      'down:answer:throw',
      'launch:not-started',
      'launch:answer:failed',
      'silent:not-started',
      'silent:answer:failed',
    ]);
  });

  it('turns a not-started after open into closed and ignores foreign facts', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    const { log, answer } = record(provider);
    sdk.onRequest = (input) => {
      sdk.present('another-call', 'open');
      sdk.present(input.presentationId, 'open');
      sdk.present(input.presentationId, 'not-started');
    };
    sdk.queueRequest({ outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } });
    await answer(request('op-1'));
    expect(log).toEqual(['op-1:open', 'op-1:closed', 'op-1:answer:cancelled']);
  });

  it('closes a sheet with no closed fact after the safety timeout', async () => {
    vi.useFakeTimers();
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    const { log, answer } = record(provider);
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'open');
    await answer(request('op-1'));

    vi.advanceTimersByTime(purchasePresentationTimeoutMs - 1);
    expect(log).toEqual(['op-1:open', 'op-1:answer:launched']);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['op-1:open', 'op-1:answer:launched', 'op-1:closed:timeout']);
    // The late native fact changes nothing.
    sdk.present(sdk.requestCalls[0]?.presentationId, 'closed');
    expect(log).toHaveLength(3);
  });

  it('keeps a native reason and closes an open sheet on dispose', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    const { log, answer } = record(provider);
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'open');
    await answer(request('first'));
    sdk.present(sdk.requestCalls[0]?.presentationId, 'closed', 'interrupted');
    await answer(request('second'));
    expect(sdk.presentationListenerCount).toBe(1);

    provider.dispose();
    expect(log).toEqual([
      'first:open',
      'first:answer:launched',
      'first:closed:interrupted',
      'second:open',
      'second:answer:launched',
      'second:closed:disposed',
    ]);
    expect(sdk.presentationListenerCount).toBe(0);
  });

  it('gives each call its own presentation id and delivers facts only to live listeners', async () => {
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    await provider.requestPurchase(request('op-1'));
    await provider.requestPurchase(request('op-1'));
    const [first, second] = sdk.requestCalls.map((call) => call.presentationId);
    expect(first).not.toBe(second);

    const late: PlatformPurchasePresentationEvent[] = [];
    const unsubscribe = provider.presentation?.subscribe((event) => late.push(event));
    // Both calls already ended with not-started; nothing is replayed.
    expect(late).toEqual([]);
    unsubscribe?.();
    sdk.onRequest = (input) => sdk.present(input.presentationId, 'open');
    await provider.requestPurchase(request('op-2'));
    expect(late).toEqual([]);
  });

  it('keeps delivering to other listeners when one throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = createFakeStoreSdk({ presentation: true });
    const provider = createProvider(sdk);
    provider.presentation?.subscribe(() => {
      throw new CommerceError('UNKNOWN');
    });
    const { log, answer } = record(provider);
    await answer(request('op-1'));
    expect(log).toEqual(['op-1:not-started', 'op-1:answer:launched']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

import { createCommerceReconciler } from '@mpgd/game-services/commerce-reconciler';
import { createInMemoryMonetizationOperationStore } from '@mpgd/game-services/monetization-operation-store';
import { describe, expect, it, vi } from 'vitest';
import {
  createUnsupportedCommerceCapabilities,
  type PlatformGateway,
  type PlatformPurchasePresentationEvent,
} from '@mpgd/platform';
import { createGameExecutionController } from '../index.js';
import { createFullScreenPresentationScope } from '../presentation/index.js';
import { createCoordinatedCommerceProvider } from './index.js';

type Commerce = NonNullable<PlatformGateway['commerce']>;
type Result = Awaited<ReturnType<Commerce['requestPurchase']>>;
const request = { logicalId: 'COINS', source: 'shop', idempotencyKey: 'first' } as const;
function fixture(withFacts = true, purchase: Commerce['requestPurchase'] = async () => ({
  outcome: 'launched',
})) {
  const listeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
  const nativeFacts = {
    subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const provider: Commerce = {
    store: 'fixture',
    getCapabilities: async () => createUnsupportedCommerceCapabilities(),
    fetchProducts: async () => [],
    requestPurchase: vi.fn(purchase),
    getAvailablePurchases: vi.fn(async function (this: Commerce) {
      expect(this).toBe(provider);
      return [];
    }),
    finishTransaction: vi.fn(async function (this: Commerce) {
      expect(this).toBe(provider);
      return { finished: true };
    }),
    subscribe: () => () => {},
    ...(withFacts ? { presentation: nativeFacts } : {}),
  };
  const execution = createGameExecutionController();
  const presentation = createFullScreenPresentationScope({ execution });
  const controlled = createCoordinatedCommerceProvider({ provider, presentation });
  return {
    provider,
    execution,
    presentation,
    controlled,
    listeners,
    emit(state: PlatformPurchasePresentationEvent['state'], sequence: number, idempotencyKey = 'first') {
      for (const listener of [...listeners]) {
        listener({ state, sequence, idempotencyKey });
      }
    },
  };
}

describe('standalone commerce presentation', () => {
  it('fails closed without native facts while preserving paid-purchase recovery', async () => {
    const f = fixture(false);
    await expect(f.controlled.requestPurchase(request)).rejects.toMatchObject({ code: 'presentation-unavailable' });
    expect(f.provider.requestPurchase).not.toHaveBeenCalled();
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    expect(await f.controlled.getAvailablePurchases()).toEqual([]);
    expect(await f.controlled.finishTransaction?.({ transactionId: 'paid', ledgerEntryId: 'ledger', isConsumable: true })).toEqual(
      { finished: true },
    );
  });
  it('does not release input/audio on a transaction callback, only a matching native closure', async () => {
    const f = fixture();
    await expect(f.controlled.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    expect(f.presentation.getSnapshot().status).toBe('unknown');
    expect(f.execution.getSnapshot().blocked).toMatchObject({ audio: true, 'gameplay-input': true });
    f.emit('closed', 1, 'another');
    expect(f.presentation.getSnapshot().owner).toBeDefined();
    f.emit('open', 2);
    f.emit('closed', 1);
    expect(f.presentation.getSnapshot().status).toBe('busy');
    f.emit('not-started', 3);
    expect(f.presentation.getSnapshot().status).toBe('unknown');
    f.emit('closed', 4);
    expect(f.presentation.getSnapshot().status).toBe('ready');
    expect(f.execution.getSnapshot().blocked.audio).toBe(false);
  });
  it('shares native surface exclusion with ads and permits retry when acquisition never launched', async () => {
    const f = fixture();
    const ad = f.presentation.acquire({ kind: 'rewarded', invocationId: 'ad' });
    await expect(f.controlled.requestPurchase(request)).rejects.toMatchObject({ code: 'busy' });
    expect(f.provider.requestPurchase).not.toHaveBeenCalled();
    ad.confirmClosed();
    await f.controlled.requestPurchase(request);
    expect(() => f.presentation.acquire({ kind: 'interstitial', invocationId: 'next-ad' })).toThrow(
      'busy',
    );
    f.emit('closed', 1);
    f.presentation.acquire({ kind: 'interstitial', invocationId: 'next-ad' }).confirmClosed();
  });
  it('coalesces the same invocation and rejects changed products or a second simultaneous checkout', async () => {
    const f = fixture();
    const first = f.controlled.requestPurchase(request);
    expect(f.controlled.requestPurchase(request)).toBe(first);
    await expect(f.controlled.requestPurchase({ ...request, logicalId: 'OTHER' })).rejects.toMatchObject({ code: 'key-conflict' });
    await first;
    await expect(f.controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).rejects.toMatchObject({ code: 'busy' });
    expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
  });
  it('retains closure observation after disposal and after a rejected SDK call', async () => {
    const f = fixture(true, async () => {
      throw new Error('native result lost');
    });
    await expect(f.controlled.requestPurchase(request)).rejects.toThrow('native result lost');
    f.controlled.dispose();
    expect(f.listeners.size).toBe(1);
    expect(f.presentation.getSnapshot().status).toBe('unknown');
    await expect(f.controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).rejects.toMatchObject({ code: 'disposed' });
    f.emit('closed', 1);
    expect(f.listeners.size).toBe(0);
    expect(f.presentation.getSnapshot().status).toBe('ready');
  });
  it('accepts native closure before the delayed business result', async () => {
    let resolve: ((value: Result) => void) | undefined;
    const f = fixture(
      true,
      () => new Promise<Result>((done) => {
        resolve = done;
      }),
    );
    const pending = f.controlled.requestPurchase(request);
    await Promise.resolve();
    expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
    f.emit('closed', 1);
    expect(f.presentation.getSnapshot().status).toBe('ready');
    resolve?.({ outcome: 'launched' });
    await pending;
    expect(f.presentation.getSnapshot().status).toBe('ready');
  });
  it('supports a trusted classifier without native event subscription and bounds retained keys', async () => {
    const f = fixture(false);
    const controlled = createCoordinatedCommerceProvider({
      provider: f.provider,
      presentation: f.presentation,
      classifyPurchasePresentation: () => 'not-started',
      maxRememberedInvocations: 1,
    });
    await controlled.requestPurchase(request);
    expect(f.presentation.getSnapshot().status).toBe('ready');
    await controlled.requestPurchase(request);
    expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
    await expect(controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).rejects.toMatchObject({ code: 'history-full' });
    controlled.dispose();
  });
  it('unsubscribes without a flight and validates capacity before subscribing', () => {
    const f = fixture();
    f.controlled.dispose();
    expect(f.listeners.size).toBe(0);
    for (const capacity of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createCoordinatedCommerceProvider({ provider: f.provider, presentation: f.presentation, maxRememberedInvocations: capacity })).toThrow(
        'capacity',
      );
      expect(f.listeners.size).toBe(0);
    }
  });
});

describe('reconciler non-launch retries', () => {
  for (const mode of ['native', 'external', 'classifier'] as const) {
    it(`delivers ${mode} non-launch facts to the durable reconciler and retries one bound intent`, async () => {
      const f = fixture(false);
      let attempts = 0;
      const events = new Set<(event: PlatformPurchasePresentationEvent) => void>();
      const facts = {
        subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
          events.add(listener);
          return () => {
            events.delete(listener);
          };
        },
      };
      const provider: Commerce = {
        ...f.provider,
        ...(mode === 'native' ? { presentation: facts } : {}),
        getCapabilities: async () => ({
          purchase: { consumable: true, durable: false, subscription: false, quantity: false },
          catalog: { products: true, offers: false, localizedPrice: true },
          lifecycle: {
            availablePurchases: true,
            pending: true,
            restore: false,
            events: true,
            finish: 'client',
          },
          authority: { evidence: 'client-token', accountBinding: 'optional' },
          availability: 'available',
        }),
        getAvailablePurchases: async () => [],
        fetchProducts: async () => [
          {
            logicalId: 'COINS',
            store: 'fixture',
            storeSku: 'coins',
            kind: 'consumable',
            title: 'Coins',
            description: 'Coins',
            price: { formatted: '$1', currencyCode: 'USD' },
          },
        ],
        requestPurchase: async (input) => {
          attempts += 1;
          const state = attempts === 1 ? 'not-started' : 'closed';
          for (const listener of events) {
            listener({ idempotencyKey: input.idempotencyKey, sequence: 1, state });
          }
          return attempts === 1
            ? { outcome: 'failed', error: { code: 'NETWORK', retryable: true } }
            : { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } };
        },
      };
      const controlled = createCoordinatedCommerceProvider({
        provider,
        presentation: f.presentation,
        maxRememberedInvocations: 1,
        ...(mode === 'external' ? { purchasePresentation: facts } : {}),
        ...(mode === 'classifier' ? { classifyPurchasePresentation: (result: Result) => result.outcome === 'failed' ? 'not-started' as const : 'closed' as const } : {}),
      });
      const observations: PlatformPurchasePresentationEvent[] = [];
      controlled.presentation?.subscribe((event) => observations.push(event));
      const verify = vi.fn(async () => {
        throw new Error('No purchase evidence; verification must not run');
      });
      const reconciler = createCommerceReconciler({
        provider: controlled,
        backend: { verifyPurchase: verify },
        store: createInMemoryMonetizationOperationStore(),
        playerId: 'player',
        target: 'android',
      });
      await reconciler.start();
      await expect(reconciler.requestPurchase(request)).resolves.toMatchObject({ outcome: 'failed' });
      expect(await reconciler.read(request.idempotencyKey)).toMatchObject({
        state: 'requested',
        error: { retryable: true },
      });
      await expect(controlled.requestPurchase({ ...request, logicalId: 'OTHER' })).rejects.toMatchObject({ code: 'key-conflict' });
      await expect(reconciler.requestPurchase(request)).resolves.toMatchObject({ outcome: 'cancelled' });
      expect(await reconciler.read(request.idempotencyKey)).toMatchObject({ state: 'cancelled' });
      expect(attempts).toBe(2);
      expect(observations.map((event) => [event.sequence, event.state])).toEqual([
        [1, 'not-started'],
        [2, 'closed'],
      ]);
      expect(verify).not.toHaveBeenCalled();
      await reconciler.stop();
      controlled.dispose();
    });
  }
  it('does not retry a failure after an opened sheet or an uncertain result', async () => {
    for (const state of ['open', 'unknown'] as const) {
      const f = fixture(true, async () => {
        f.emit(state, 1);
        return { outcome: 'failed', error: { code: 'NETWORK', retryable: true } };
      });
      const first = f.controlled.requestPurchase(request);
      await first;
      expect(f.controlled.requestPurchase(request)).toBe(first);
      expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
      expect(f.presentation.getSnapshot().owner).toBeDefined();
      f.emit('closed', 2);
      f.controlled.dispose();
    }
  });
  it('permits a same-key retry when a trusted not-started fact arrives after a retryable failure settles', async () => {
    let attempts = 0;
    const f = fixture(true, async () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: 'failed', error: { code: 'NETWORK', retryable: true } }
        : { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } };
    });
    const first = f.controlled.requestPurchase(request);
    await expect(first).resolves.toMatchObject({ outcome: 'failed', error: { retryable: true } });
    expect(f.controlled.requestPurchase(request)).toBe(first);
    f.emit('not-started', 1);
    await expect(f.controlled.requestPurchase(request)).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(attempts).toBe(2);
    expect(f.provider.requestPurchase).toHaveBeenCalledTimes(2);
    f.controlled.dispose();
  });
  it('does not reopen checkout when a late not-started fact follows an opened sheet, a launch, or a non-retryable failure', async () => {
    const opened = fixture(true, async () => {
      opened.emit('open', 1);
      return { outcome: 'failed', error: { code: 'NETWORK', retryable: true } };
    });
    const openedFirst = opened.controlled.requestPurchase(request);
    await openedFirst;
    opened.emit('not-started', 2);
    expect(opened.controlled.requestPurchase(request)).toBe(openedFirst);
    expect(opened.provider.requestPurchase).toHaveBeenCalledOnce();
    opened.controlled.dispose();

    for (const outcome of ['launched', 'failed'] as const) {
      const f = fixture(true, async () =>
        outcome === 'launched'
          ? { outcome: 'launched' }
          : { outcome: 'failed', error: { code: 'STORE_UNAVAILABLE', retryable: false } },
      );
      const first = f.controlled.requestPurchase(request);
      await first;
      f.emit('not-started', 1);
      expect(f.controlled.requestPurchase(request)).toBe(first);
      expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
      f.controlled.dispose();
    }
  });
});

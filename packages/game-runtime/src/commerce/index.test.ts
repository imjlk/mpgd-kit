import { createCommerceReconciler } from '@mpgd/game-services/commerce-reconciler';
import { createInMemoryMonetizationOperationStore } from '@mpgd/game-services/monetization-operation-store';
import { describe, expect, it, vi } from 'vitest';
import {
  commercePresentationAttempt,
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
    await expect(f.controlled.requestPurchase(request)).resolves.toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS', retryable: true, storeCode: 'PRESENTATION_BUSY' } });
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
    await expect(f.controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS', retryable: true, storeCode: 'PRESENTATION_BUSY' } });
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
    await expect(f.controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'NOT_PREPARED', retryable: true, storeCode: 'PRESENTATION_DISPOSED' } });
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
    await expect(controlled.requestPurchase({ ...request, idempotencyKey: 'second' })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS', retryable: true, storeCode: 'PRESENTATION_HISTORY_FULL' } });
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

describe('coordinator refusals keep the key', () => {
  it('answers a refusal before the provider as a retryable failure after a not-started fact', async () => {
    const f = fixture();
    const seen: string[] = [];
    f.controlled.presentation?.subscribe((event) => seen.push(`${event.idempotencyKey}:${event.sequence}:${event.state}`));
    const ad = f.presentation.acquire({ kind: 'rewarded', invocationId: 'ad' });
    await expect(f.controlled.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'IN_PROGRESS', retryable: true, storeCode: 'PRESENTATION_BUSY' },
    });
    expect(f.provider.requestPurchase).not.toHaveBeenCalled();
    // Same-key protection still holds for the refused key.
    await expect(f.controlled.requestPurchase({ ...request, logicalId: 'OTHER' })).rejects.toMatchObject({ code: 'key-conflict' });
    ad.confirmClosed();
    await f.controlled.requestPurchase(request);
    expect(f.provider.requestPurchase).toHaveBeenCalledOnce();
    f.emit('closed', 1);
    // Sequences keep increasing across the refusal and the retry.
    expect(seen).toEqual(['first:1:not-started', 'first:2:unknown', 'first:3:closed']);
  });
  it('still answers subscribers after disposal, with a not-started fact for each refused call', async () => {
    const f = fixture();
    f.controlled.dispose();
    const seen: string[] = [];
    const unsubscribe = f.controlled.presentation?.subscribe((event) => seen.push(`${event.idempotencyKey}:${event.state}`));
    await expect(f.controlled.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'NOT_PREPARED', retryable: true, storeCode: 'PRESENTATION_DISPOSED' },
    });
    expect(seen).toEqual(['first:not-started']);
    expect(f.provider.requestPurchase).not.toHaveBeenCalled();
    unsubscribe?.();
  });
  it('evicts the oldest settled key instead of refusing, never an in-flight, retryable, or last one', async () => {
    let calls = 0;
    const f = fixture(true, async (input) => {
      calls += 1;
      f.emit('closed', calls, input.idempotencyKey);
      return { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } };
    });
    const controlled = createCoordinatedCommerceProvider({ provider: f.provider, presentation: f.presentation, maxRememberedInvocations: 2 });
    await controlled.requestPurchase({ ...request, idempotencyKey: 'a' });
    await controlled.requestPurchase({ ...request, idempotencyKey: 'b' });
    // Full: `a` (settled, closed, not retryable, not the last) makes room.
    await expect(controlled.requestPurchase({ ...request, idempotencyKey: 'c' })).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(f.provider.requestPurchase).toHaveBeenCalledTimes(3);
    // The last result keeps its same-key protection.
    await expect(controlled.requestPurchase({ ...request, idempotencyKey: 'c' })).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(f.provider.requestPurchase).toHaveBeenCalledTimes(3);
    controlled.dispose();

    // An in-flight key is never evicted: the new key is refused, retryably.
    const held = fixture(true, async () => new Promise<Result>(() => {}));
    const one = createCoordinatedCommerceProvider({ provider: held.provider, presentation: held.presentation, maxRememberedInvocations: 1 });
    void one.requestPurchase({ ...request, idempotencyKey: 'live' });
    await Promise.resolve();
    await expect(one.requestPurchase({ ...request, idempotencyKey: 'next' })).resolves.toMatchObject({
      outcome: 'failed', error: { retryable: true, storeCode: 'PRESENTATION_HISTORY_FULL' },
    });
    expect(held.provider.requestPurchase).toHaveBeenCalledOnce();
  });
  it('keeps a key the coordinator refused retryable in the durable reconciler', async () => {
    const f = fixture(false);
    const events = new Set<(event: PlatformPurchasePresentationEvent) => void>();
    const sequences = new Map<string, number>();
    const fact = (idempotencyKey: string, state: PlatformPurchasePresentationEvent['state']) => {
      const sequence = (sequences.get(idempotencyKey) ?? 0) + 1;
      sequences.set(idempotencyKey, sequence);
      for (const listener of [...events]) {
        listener({ idempotencyKey, sequence, state });
      }
    };
    const product = (logicalId: string) => ({
      logicalId, store: 'fixture', storeSku: logicalId.toLowerCase(), kind: 'consumable' as const,
      title: logicalId, description: logicalId, price: { formatted: '$1', currencyCode: 'USD' },
    });
    const provider: Commerce = {
      ...f.provider,
      presentation: {
        subscribe(listener) {
          events.add(listener);
          return () => {
            events.delete(listener);
          };
        },
      },
      getCapabilities: async () => ({
        purchase: { consumable: true, durable: false, subscription: false, quantity: false },
        catalog: { products: true, offers: false, localizedPrice: true },
        lifecycle: { availablePurchases: true, pending: true, restore: false, events: true, finish: 'client' },
        authority: { evidence: 'client-token', accountBinding: 'optional' },
        availability: 'available',
      }),
      getAvailablePurchases: async () => [],
      fetchProducts: async () => [product('COINS'), product('GEMS')],
      requestPurchase: vi.fn(async (input) => {
        fact(input.idempotencyKey, 'open');
        if (input.logicalId === 'COINS') {
          return { outcome: 'launched' } as const;
        }
        fact(input.idempotencyKey, 'closed');
        return { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } } as const;
      }),
    };
    const controlled = createCoordinatedCommerceProvider({ provider, presentation: f.presentation });
    const reconciler = createCommerceReconciler({
      provider: controlled,
      backend: { verifyPurchase: vi.fn(async () => { throw new Error('nothing to verify'); }) },
      store: createInMemoryMonetizationOperationStore(),
      playerId: 'player',
      target: 'android',
    });
    await reconciler.start();
    const gems = { logicalId: 'GEMS', source: 'shop', idempotencyKey: 'gems-1' } as const;
    await expect(reconciler.requestPurchase({ logicalId: 'COINS', source: 'shop', idempotencyKey: 'coins-1' })).resolves.toMatchObject({ outcome: 'launched' });
    // The COINS sheet holds the scope: the coordinator refuses GEMS before the store.
    await expect(reconciler.requestPurchase(gems)).resolves.toMatchObject({ outcome: 'failed', error: { retryable: true } });
    expect(await reconciler.read(gems.idempotencyKey)).toMatchObject({ state: 'requested', error: { retryable: true } });
    expect(provider.requestPurchase).toHaveBeenCalledOnce();
    fact('coins-1', 'closed');
    // The same key opens the store once the sheet is gone.
    await expect(reconciler.requestPurchase(gems)).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(provider.requestPurchase).toHaveBeenCalledTimes(2);
    expect(provider.requestPurchase).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'gems-1', logicalId: 'GEMS' }));
    expect(await reconciler.read(gems.idempotencyKey)).toMatchObject({ state: 'cancelled' });
    await reconciler.stop();
    controlled.dispose();
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
            const attempt = Reflect.get(input, commercePresentationAttempt);
            listener({
              idempotencyKey: input.idempotencyKey,
              sequence: 1,
              state,
              ...(typeof attempt === 'number' ? { attempt } : {}),
            });
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
  it('retries a rejected pre-launch failure after a trusted not-started fact', async () => {
    let attempts = 0;
    const f = fixture(true, async () => {
      attempts += 1;
      if (attempts === 1) {
        f.emit('not-started', 1);
        throw Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true });
      }
      return { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } };
    });
    await expect(f.controlled.requestPurchase(request)).rejects.toMatchObject({ retryable: true });
    await expect(f.controlled.requestPurchase(request)).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(attempts).toBe(2);
    f.controlled.dispose();
  });
  it('does not retry a rejection that is not explicitly retryable or that already opened', async () => {
    const unproven = fixture(true, async () => {
      throw Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true });
    });
    const unprovenFirst = unproven.controlled.requestPurchase(request);
    await expect(unprovenFirst).rejects.toMatchObject({ retryable: true });
    expect(unproven.controlled.requestPurchase(request)).toBe(unprovenFirst);
    expect(unproven.provider.requestPurchase).toHaveBeenCalledOnce();
    unproven.controlled.dispose();

    const opened = fixture(true, async () => {
      opened.emit('open', 1);
      throw Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true });
    });
    const openedFirst = opened.controlled.requestPurchase(request);
    await expect(openedFirst).rejects.toThrow('offline');
    expect(opened.controlled.requestPurchase(request)).toBe(openedFirst);
    expect(opened.provider.requestPurchase).toHaveBeenCalledOnce();
    opened.controlled.dispose();
  });
  it('ignores a previous attempt event when the provider echoes the attempt', async () => {
    let attempts = 0;
    let emit: (event: PlatformPurchasePresentationEvent) => void = () => {};
    const facts = {
      subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
        emit = listener;
        return () => {};
      },
    };
    const base = fixture(false);
    const provider: Commerce = {
      ...base.provider,
      presentation: facts,
      requestPurchase: async (input) => {
        attempts += 1;
        const attempt = Reflect.get(input, commercePresentationAttempt);
        if (typeof attempt !== 'number') {
          throw new Error('missing attempt');
        }
        if (attempts === 1) {
          emit({ idempotencyKey: input.idempotencyKey, sequence: 1, state: 'not-started', attempt });
          return { outcome: 'failed', error: { code: 'NETWORK', retryable: true } };
        }
        return new Promise<Result>(() => {});
      },
    };
    const controlled = createCoordinatedCommerceProvider({
      provider,
      presentation: base.presentation,
    });
    await expect(controlled.requestPurchase(request)).resolves.toMatchObject({ outcome: 'failed' });
    const second = controlled.requestPurchase(request);
    await Promise.resolve();
    emit({ idempotencyKey: request.idempotencyKey, sequence: 1, state: 'not-started', attempt: 1 });
    expect(base.presentation.getSnapshot().owner).toBeDefined();
    emit({ idempotencyKey: request.idempotencyKey, sequence: 1, state: 'open', attempt: 2 });
    expect(base.presentation.getSnapshot().status).toBe('busy');
    expect(attempts).toBe(2);
    void second;
    controlled.dispose();
  });
  it('does not let a delayed untagged event from the previous attempt release the next sheet', async () => {
    let attempts = 0;
    let emit: (event: PlatformPurchasePresentationEvent) => void = () => {};
    const facts = {
      subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
        emit = listener;
        return () => {};
      },
    };
    const base = fixture(false);
    const provider: Commerce = {
      ...base.provider,
      presentation: facts,
      requestPurchase: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          emit({ idempotencyKey: input.idempotencyKey, sequence: 10, state: 'not-started' });
          return { outcome: 'failed', error: { code: 'NETWORK', retryable: true } };
        }
        return new Promise<Result>(() => {});
      },
    };
    const controlled = createCoordinatedCommerceProvider({
      provider,
      presentation: base.presentation,
    });
    await expect(controlled.requestPurchase(request)).resolves.toMatchObject({ outcome: 'failed' });
    const second = controlled.requestPurchase(request);
    await Promise.resolve();
    emit({ idempotencyKey: request.idempotencyKey, sequence: 10, state: 'not-started' });
    expect(base.presentation.getSnapshot().owner).toBeDefined();
    emit({ idempotencyKey: request.idempotencyKey, sequence: 11, state: 'open' });
    expect(base.presentation.getSnapshot().status).toBe('busy');
    void second;
    controlled.dispose();
  });
});

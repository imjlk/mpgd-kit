import { describe, expect, it, vi } from 'vitest';
import {
  createUnsupportedCapabilities,
  createUnsupportedCommerceCapabilities,
  type PlatformGateway,
  type PlatformPurchasePresentationEvent,
} from '@mpgd/platform';
import type {
  GameServicesOperationClient,
  GameServicesPurchaseResult,
} from '@mpgd/game-services/operations';
import {
  adProtocol,
  adProtocolVersion,
  type AdPresentationEvent,
  type AdProvider,
  type AdShowResult,
} from '@mpgd/platform/ads';
import { createGamePlatformRuntime } from './index.js';

describe('host loading and synchronous exit', () => {
  it('holds gameplay until the asynchronous start is acknowledged and deduplicates completion', async () => {
    const f = fixture();
    let acknowledge!: () => void;
    const complete = vi.fn(
      () => new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const setProgress = vi.fn();
    const runtime = createGamePlatformRuntime({
      gateway: { ...f.gateway, gameLoading: { setProgress, complete } },
      createServices: () => ({}),
      initialLifecycleState: 'active',
    });
    const scope = runtime.createGameplayScope();
    scope.setActive(true);
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(true);
    runtime.setLoadingProgress(250);
    expect(setProgress).toHaveBeenLastCalledWith(100);
    const first = runtime.completeLoading();
    expect(runtime.completeLoading()).toBe(first);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(runtime.execution.getSnapshot().blocked.audio).toBe(true);
    acknowledge();
    await first;
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(false);
    runtime.dispose();
  });
  it('retains a failed loading gate, retries, and refuses a late completion after disposal', async () => {
    const f = fixture();
    let acknowledge!: () => void;
    const complete = vi.fn().mockRejectedValueOnce(new Error('start failed')).mockImplementation(
      () => new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const runtime = createGamePlatformRuntime({
      gateway: { ...f.gateway, gameLoading: { setProgress: () => {}, complete } },
      createServices: () => ({}),
      initialLifecycleState: 'active',
    });
    await expect(runtime.completeLoading()).rejects.toThrow('start failed');
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(true);
    const retry = runtime.completeLoading();
    await Promise.resolve();
    runtime.dispose();
    acknowledge();
    await expect(retry).rejects.toThrow('disposed');
    expect(runtime.execution.getSnapshot().status).toBe('destroyed');
  });
  it('executes an exit checkpoint synchronously and destroys gameplay without awaiting work', () => {
    const f = fixture();
    let exit!: () => void;
    const checkpoint = vi.fn();
    const unsubscribe = vi.fn();
    const runtime = createGamePlatformRuntime({
      gateway: {
        ...f.gateway,
        lifecycle: {
          ...f.gateway.lifecycle,
          onExit(callback) {
            exit = callback;
            return unsubscribe;
          },
        },
      },
      createServices: () => ({}),
      initialLifecycleState: 'active',
      onExit: checkpoint,
    });
    exit();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(runtime.execution.getSnapshot().status).toBe('destroyed');
  });
});

function fixture() {
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  let resolve!: (value: AdShowResult) => void;
  const provider: AdProvider = {
    id: 'fixture',
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'delayed',
    getAvailability: async () => ({ state: 'available' }),
    preload: async () => ({ status: 'deferred' }),
    show: vi.fn(
      () => new Promise<AdShowResult>((done) => {
        resolve = done;
      }),
    ),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const resumes = new Set<() => void>();
  const pauses = new Set<() => void>();
  const gateway: PlatformGateway = {
    target: 'ait',
    getCapabilities: async () => createUnsupportedCapabilities(),
    identity: { getPlayer: async () => null },
    ads: {
      provider,
      preload: async () => {},
      showRewarded: async () => ({ status: 'unavailable', rewardGranted: false }),
    },
    lifecycle: {
      onPause(listener) {
        pauses.add(listener);
        return () => {
          pauses.delete(listener);
        };
      },
      onResume(listener) {
        resumes.add(listener);
        return () => {
          resumes.delete(listener);
        };
      },
    },
    leaderboard: { submitScore: async () => ({ submitted: false }), open: async () => {} },
    storage: { load: async () => null, save: async () => {} },
  };
  return {
    gateway,
    provider,
    listeners,
    resumes,
    pauses,
    resolve: (result: AdShowResult) => resolve(result),
    emit(event: AdPresentationEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}
async function flush() {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}
const input = {
  placementId: 'CONTINUE',
  format: 'rewarded' as const,
  invocationId: 'invocation',
  idempotencyKey: 'original-claim',
};
describe('game-owned platform assembly', () => {
  it('gives host mute and other audio owners independent lifetimes', () => {
    const f = fixture();
    let changed: ((muted: boolean) => void) | undefined;
    const removed = vi.fn();
    const runtime = createGamePlatformRuntime({
      gateway: {
        ...f.gateway,
        gameSettings: {
          getAudioMuted: () => true,
          onAudioMuteChange(callback: (muted: boolean) => void) {
            changed = callback;
            return removed;
          },
        },
      },
      createServices: () => ({}),
      initialLifecycleState: 'active',
    });
    expect(runtime.execution.getSnapshot().blocked.audio).toBe(true);
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(false);
    const settings = runtime.execution.acquireBlock({ reason: 'settings', channels: ['audio'] });
    changed?.(false);
    expect(runtime.execution.getSnapshot().blocked.audio).toBe(true);
    settings.release();
    expect(runtime.execution.getSnapshot().blocked.audio).toBe(false);
    changed?.(true);
    runtime.dispose();
    changed?.(false);
    expect(runtime.execution.getSnapshot().status).toBe('destroyed');
    expect(runtime.execution.getSnapshot().blocked.audio).toBe(true);
    expect(removed).toHaveBeenCalledTimes(1);
  });
  it('reports logical gameplay, keeps focus handling with the host, and preserves independent pause owners', () => {
    const f = fixture();
    const events: string[] = [];
    const runtime = createGamePlatformRuntime({
      gateway: {
        ...f.gateway,
        gameActivity: {
          handlesFocusChanges: true,
          setLoading: (loading: boolean) => {
            events.push(`loading:${loading}`);
          },
          setGameplayActive: (active: boolean) => {
            events.push(`gameplay:${active}`);
          },
        },
      },
      createServices: () => ({}),
      initialLifecycleState: 'active',
    });
    const first = runtime.createGameplayScope();
    expect(events).toEqual(['loading:true']);
    first.setActive(true);
    for (const pause of f.pauses) {
      pause();
    }
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(true);
    expect(events).toEqual(['loading:true', 'loading:false', 'gameplay:true']);
    for (const resume of f.resumes) {
      resume();
    }
    const settings = runtime.execution.acquireBlock({
      reason: 'settings',
      channels: ['simulation', 'gameplay-input'],
    });
    const native = runtime.execution.acquireBlock({
      reason: 'native-ad',
      channels: ['simulation', 'gameplay-input', 'audio'],
    });
    for (const pause of f.pauses) {
      pause();
    }
    settings.release();
    expect(events.at(-1)).toBe('gameplay:false');
    native.release();
    expect(events.at(-1)).toBe('gameplay:true');
    const beforeFocus = events.length;
    for (const resume of f.resumes) {
      resume();
    }
    expect(events.length).toBe(beforeFocus);
    const second = runtime.createGameplayScope();
    second.setActive(true);
    first.dispose();
    expect(events.at(-1)).toBe('gameplay:true');
    second.setActive(false);
    expect(events.at(-1)).toBe('gameplay:false');
    second.setActive(true);
    runtime.dispose();
    second.setActive(true);
    second.dispose();
    expect(events.filter((event) => event === 'gameplay:true')).toHaveLength(3);
    expect(events.at(-1)).toBe('gameplay:false');
    expect(f.pauses.size + f.resumes.size).toBe(0);
  });

  it('does not report initial gameplay while backgrounded and closes loading on early teardown', () => {
    const f = fixture();
    const loading = vi.fn();
    const active = vi.fn();
    const runtime = createGamePlatformRuntime({
      gateway: {
        ...f.gateway,
        gameActivity: { handlesFocusChanges: true, setLoading: loading, setGameplayActive: active },
      },
      createServices: () => ({}),
      initialLifecycleState: 'inactive',
    });
    runtime.createGameplayScope().setActive(true);
    expect(active).not.toHaveBeenCalled();
    runtime.dispose();
    expect(loading.mock.calls).toEqual([[true], [false]]);
    expect(active).not.toHaveBeenCalled();
  });
  it('requires journal recovery before v2 rewarded display', async () => {
    const f = fixture();
    const runtime = createGamePlatformRuntime({
      gateway: f.gateway,
      createServices: () => ({}),
      initialLifecycleState: 'active',
    });
    await expect(runtime.gateway.ads.provider?.show(input)).resolves.toMatchObject({ outcome: 'unavailable', reason: 'policy-disabled' });
    expect(f.provider.show).not.toHaveBeenCalled();
    runtime.dispose();
  });
  it('keeps recovery alive after game/view teardown and never replaces the original operation key', async () => {
    const f = fixture();
    const recovery = {
      reconcile: vi.fn(async () => []),
      recoverRewardResult: vi.fn(async () => ({
        status: 'pending' as const,
        reward: { status: 'pending' as const, rewardGranted: false },
      })),
    };
    const runtime = createGamePlatformRuntime({
      gateway: f.gateway,
      createServices: () => ({ monetizationRecovery: recovery }),
      initialLifecycleState: 'active',
    });
    const pending = runtime.gateway.ads.provider?.show(input);
    await flush();
    f.emit({ providerId: 'fixture', invocationId: 'invocation', sequence: 1, type: 'started' });
    for (const pause of f.pauses) {
      pause();
    }
    f.emit({ providerId: 'fixture', invocationId: 'invocation', sequence: 2, type: 'closed' });
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(true);
    f.resolve({
      providerId: 'fixture',
      invocationId: 'invocation',
      format: 'rewarded',
      outcome: 'shown',
      presentation: 'closed',
      eligibility: 'unknown',
    });
    await pending;
    runtime.dispose();
    f.emit({
      providerId: 'fixture',
      invocationId: 'invocation',
      sequence: 3,
      type: 'reward-earned',
      evidence: { schema: 'test.reward.v1', payload: { requestId: 'invocation' } },
    });
    await flush();
    expect(recovery.recoverRewardResult).toHaveBeenCalledWith('original-claim', {
      status: 'pending',
      rewardGranted: false,
      evidence: { schema: 'test.reward.v1', payload: { requestId: 'invocation' } },
    });
    expect(runtime.execution.getSnapshot().status).toBe('destroyed');
    expect(f.provider.show).toHaveBeenCalledOnce();
  });
  it('forwards a late definitive preparation failure to the reserved journal without reopening UI', async () => {
    const f = fixture();
    let expire = () => {};
    const recovery = {
      reconcile: async () => [],
      recoverRewardResult: vi.fn(async () => ({
        status: 'failed' as const,
        reward: { status: 'failed' as const, rewardGranted: false },
      })),
    };
    const runtime = createGamePlatformRuntime({
      gateway: f.gateway,
      createServices: () => ({ monetizationRecovery: recovery }),
      initialLifecycleState: 'active',
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
    });
    const pending = runtime.gateway.ads.provider?.show(input);
    await flush();
    expire();
    await pending;
    f.resolve({
      providerId: 'fixture',
      invocationId: 'invocation',
      format: 'rewarded',
      outcome: 'failed',
      presentation: 'not-started',
      eligibility: 'not-earned',
      reason: 'transient-failure',
    });
    await flush();
    expect(recovery.recoverRewardResult).toHaveBeenCalledWith('original-claim', {
      status: 'failed',
      rewardGranted: false,
    });
    expect(runtime.presentation.getSnapshot().owner).toBeUndefined();
    expect(f.provider.show).toHaveBeenCalledOnce();
    runtime.dispose();
  });
});

describe('purchase coordination without an ad provider', () => {
  type Commerce = NonNullable<PlatformGateway['commerce']>;
  type Outcome = Awaited<ReturnType<Commerce['requestPurchase']>>;
  const request = { logicalId: 'COINS', source: 'shop', idempotencyKey: 'p' } as const;
  // The standard Capacitor gateway without an ads plugin: no `ads.provider`,
  // and a commerce provider that offers sheet facts only when its SDK does.
  function noAds(options: { readonly facts: boolean; readonly purchase?: (input: { idempotencyKey: string }) => Promise<Outcome> }) {
    const f = fixture();
    const listeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
    let sequence = 0;
    const commerce: Commerce = {
      store: 'fixture',
      getCapabilities: async () => createUnsupportedCommerceCapabilities(),
      fetchProducts: async () => [],
      requestPurchase: vi.fn(options.purchase ?? (async () => ({ outcome: 'launched' as const }))),
      getAvailablePurchases: vi.fn(async () => []),
      subscribe: () => () => {},
      ...(options.facts ? {
        presentation: {
          subscribe(listener: (event: PlatformPurchasePresentationEvent) => void) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      } : {}),
    };
    const gateway: PlatformGateway = {
      ...f.gateway,
      ads: { preload: async () => {}, showRewarded: async () => ({ status: 'unavailable', rewardGranted: false }) },
      commerce,
    };
    return {
      gateway,
      commerce,
      listeners,
      fact(idempotencyKey: string, state: PlatformPurchasePresentationEvent['state']) {
        sequence += 1;
        for (const listener of [...listeners]) {
          listener({ idempotencyKey, sequence, state });
        }
      },
    };
  }

  it('takes the shared full-screen scope from the request until the sheet closes', async () => {
    const store: ReturnType<typeof noAds> = noAds({
      facts: true,
      purchase: async (input) => {
        store.fact(input.idempotencyKey, 'open');
        return { outcome: 'launched' };
      },
    });
    const runtime = createGamePlatformRuntime({ gateway: store.gateway, createServices: () => ({}), initialLifecycleState: 'active' });
    expect(runtime.gateway.ads.provider).toBeUndefined();
    const seen: string[] = [];
    runtime.gateway.commerce?.presentation?.subscribe((event) => seen.push(`${event.idempotencyKey}:${event.state}`));

    await expect(runtime.gateway.commerce?.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    // The answer proves nothing about the sheet (`unknown`): the game stays
    // paused, audio included, until the sheet's own `closed`.
    expect(runtime.presentation.getSnapshot()).toMatchObject({ status: 'unknown', owner: { kind: 'purchase', invocationId: 'p' } });
    expect(runtime.execution.getSnapshot().blocked).toMatchObject({ simulation: true, 'gameplay-input': true, audio: true });
    // A second sheet cannot open under the first one; the refusal is retryable.
    await expect(runtime.gateway.commerce?.requestPurchase({ ...request, idempotencyKey: 'q' })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS', retryable: true, storeCode: 'PRESENTATION_BUSY' } });
    expect(store.commerce.requestPurchase).toHaveBeenCalledOnce();

    store.fact('p', 'closed');
    expect(runtime.presentation.getSnapshot().status).toBe('ready');
    expect(runtime.execution.getSnapshot().blocks).toHaveLength(0);
    // The facts reach a reconciler through the coordinated provider.
    // The refused key heard `not-started`, so a reconciler keeps it retryable.
    expect(seen).toEqual(['p:open', 'p:unknown', 'q:not-started', 'p:closed']);
    // A launched key never reopens the sheet; a changed product is refused.
    await expect(runtime.gateway.commerce?.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    await expect(runtime.gateway.commerce?.requestPurchase({ ...request, logicalId: 'GEMS' })).rejects.toMatchObject({ code: 'key-conflict' });
    expect(store.commerce.requestPurchase).toHaveBeenCalledOnce();
    // Recovery reads keep their receiver and are not gated.
    await expect(runtime.gateway.commerce?.getAvailablePurchases()).resolves.toEqual([]);
    runtime.dispose();
    await expect(runtime.gateway.commerce?.requestPurchase({ ...request, idempotencyKey: 'r' })).resolves.toMatchObject({ outcome: 'failed', error: { code: 'NOT_PREPARED', retryable: true, storeCode: 'PRESENTATION_DISPOSED' } });
    expect(store.listeners.size).toBe(0);
  });

  it('keeps an older provider without sheet facts on the plain gateway', async () => {
    const store = noAds({ facts: false });
    const runtime = createGamePlatformRuntime({ gateway: store.gateway, createServices: () => ({}), initialLifecycleState: 'active' });
    expect(runtime.gateway).toBe(store.gateway);
    // Not the coordinator's strict `presentation-unavailable` refusal.
    await expect(runtime.gateway.commerce?.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    expect(store.commerce.requestPurchase).toHaveBeenCalledOnce();
    expect(runtime.presentation.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it("uses the game's purchasePresentation source when the provider offers none", async () => {
    const store = noAds({ facts: false });
    const listeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
    const runtime = createGamePlatformRuntime({
      gateway: store.gateway,
      createServices: () => ({}),
      initialLifecycleState: 'active',
      purchasePresentation: {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    });
    await runtime.gateway.commerce?.requestPurchase(request);
    expect(runtime.presentation.getSnapshot().owner).toMatchObject({ kind: 'purchase', state: 'unknown' });
    for (const listener of [...listeners]) {
      listener({ idempotencyKey: 'p', sequence: 1, state: 'closed' });
    }
    expect(runtime.presentation.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('keeps observing an open sheet after runtime disposal and prefers the game source', async () => {
    const store: ReturnType<typeof noAds> = noAds({
      facts: true,
      purchase: async (input) => {
        store.fact(input.idempotencyKey, 'open');
        return { outcome: 'launched' };
      },
    });
    const runtime = createGamePlatformRuntime({ gateway: store.gateway, createServices: () => ({}), initialLifecycleState: 'active' });
    await runtime.gateway.commerce?.requestPurchase(request);
    runtime.dispose();
    // The native observer stays until the sheet's own end, then detaches.
    expect(store.listeners.size).toBe(1);
    store.fact('p', 'closed');
    expect(store.listeners.size).toBe(0);

    const game = new Set<(event: PlatformPurchasePresentationEvent) => void>();
    const other = noAds({ facts: true });
    const preferred = createGamePlatformRuntime({
      gateway: other.gateway,
      createServices: () => ({}),
      initialLifecycleState: 'active',
      purchasePresentation: {
        subscribe(listener) {
          game.add(listener);
          return () => {
            game.delete(listener);
          };
        },
      },
    });
    expect(other.listeners.size).toBe(0);
    await preferred.gateway.commerce?.requestPurchase(request);
    for (const listener of [...game]) {
      listener({ idempotencyKey: 'p', sequence: 1, state: 'closed' });
    }
    expect(preferred.presentation.getSnapshot().status).toBe('ready');
    preferred.dispose();
  });

  it('leaves a gateway with an ad provider on the ads coordinator, whose actions rely on the lease', async () => {
    const store: ReturnType<typeof noAds> = noAds({
      facts: true,
      purchase: async (input) => {
        store.fact(input.idempotencyKey, 'open');
        return { outcome: 'launched' };
      },
    });
    const withAds = fixture();
    const runtime = createGamePlatformRuntime({
      gateway: { ...store.gateway, ads: withAds.gateway.ads },
      initialLifecycleState: 'active',
      createServices: (gateway) => ({
        client: {
          async purchase(input: { readonly productId: string; readonly source: 'shop'; readonly idempotencyKey: string }) {
            await gateway.commerce?.requestPurchase({ logicalId: input.productId, source: input.source, idempotencyKey: input.idempotencyKey });
            return { status: 'pending', purchase: { status: 'pending', entitlementIds: [] } } as unknown as GameServicesPurchaseResult;
          },
          claimRewardedAd: vi.fn(),
        } as unknown as GameServicesOperationClient,
      }),
    });
    expect(runtime.gateway.ads.provider).toBeDefined();
    const purchase = runtime.actions?.createPurchaseController().execute({ productId: 'COINS', source: 'shop', idempotencyKey: 'p' });
    await purchase;
    expect(runtime.execution.getSnapshot().blocks.map((block) => block.reason)).toEqual(['presentation:purchase']);
    store.fact('p', 'closed');
    expect(runtime.execution.getSnapshot().blocks).toHaveLength(0);
    runtime.dispose();
  });

  it('leaves a gateway without commerce unchanged', () => {
    const store = noAds({ facts: false });
    const bare = { ...store.gateway } as PlatformGateway & { commerce?: unknown };
    delete bare.commerce;
    const runtime = createGamePlatformRuntime({ gateway: bare, createServices: () => ({}), initialLifecycleState: 'active' });
    expect(runtime.gateway).toBe(bare);
    runtime.dispose();
  });

  it('keeps the action block until the business result, after the sheet closed', async () => {
    let settle!: (result: GameServicesPurchaseResult) => void;
    const store: ReturnType<typeof noAds> = noAds({
      facts: true,
      purchase: async (input) => {
        store.fact(input.idempotencyKey, 'open');
        return { outcome: 'launched' };
      },
    });
    const runtime = createGamePlatformRuntime({
      gateway: store.gateway,
      initialLifecycleState: 'active',
      createServices: (gateway) => ({
        client: {
          async purchase(input: { readonly productId: string; readonly source: 'shop'; readonly idempotencyKey: string }) {
            await gateway.commerce?.requestPurchase({ logicalId: input.productId, source: input.source, idempotencyKey: input.idempotencyKey });
            return new Promise<GameServicesPurchaseResult>((done) => {
              settle = done;
            });
          },
          claimRewardedAd: vi.fn(),
        } as unknown as GameServicesOperationClient,
      }),
    });
    const purchase = runtime.actions?.createPurchaseController().execute({ productId: 'COINS', source: 'shop', idempotencyKey: 'p' });
    await flush();
    expect(runtime.execution.getSnapshot().blocks.map((block) => block.reason).sort()).toEqual(['action:purchase', 'presentation:purchase']);
    store.fact('p', 'closed');
    // Server verification still runs: gameplay stays paused by the action.
    expect(runtime.execution.getSnapshot().blocks.map((block) => block.reason)).toEqual(['action:purchase']);
    settle({ status: 'granted', purchase: { status: 'cancelled', entitlementIds: [] } });
    await purchase;
    expect(runtime.execution.getSnapshot().blocks).toHaveLength(0);
    runtime.dispose();
  });

  // A purchase started outside `runtime.actions` (a game shop or a reconciler
  // calling the gateway's commerce) makes the actions `busy` in both modes.
  function outsidePurchase(options: { readonly ads: boolean; readonly opens?: boolean }) {
    const store: ReturnType<typeof noAds> = noAds({
      facts: true,
      purchase: async (input) => {
        if (options.opens !== false) {
          store.fact(input.idempotencyKey, 'open');
        }
        return { outcome: 'launched' };
      },
    });
    const purchase = vi.fn(async (input: { readonly productId: string; readonly source: 'shop'; readonly idempotencyKey: string }) => {
      const outcome = await runtime.gateway.commerce?.requestPurchase({ logicalId: input.productId, source: input.source, idempotencyKey: input.idempotencyKey });
      return { status: outcome?.outcome === 'failed' ? 'failed' : 'granted', purchase: { status: 'purchased', entitlementIds: [] } } as unknown as GameServicesPurchaseResult;
    });
    const runtime = createGamePlatformRuntime({
      gateway: options.ads ? { ...store.gateway, ads: fixture().gateway.ads } : store.gateway,
      initialLifecycleState: 'active',
      createServices: () => ({ client: { purchase, claimRewardedAd: vi.fn() } as unknown as GameServicesOperationClient }),
    });
    const seen: string[] = [];
    runtime.actions?.subscribeAvailability((value) => {
      seen.push(value);
    });
    return { store, runtime, purchase, seen };
  }
  const action = { productId: 'GEMS', source: 'shop', idempotencyKey: 'action' } as const;

  it.each([false, true])('reports busy while an outside purchase holds the scope (ads: %s)', async (ads) => {
    const { store, runtime, purchase, seen } = outsidePurchase({ ads });
    expect(runtime.gateway.ads.provider === undefined).toBe(!ads);
    await runtime.gateway.commerce?.requestPurchase(request);
    // The store answered first: the lease is `unknown`, still the scope's owner.
    expect(runtime.presentation.getSnapshot().owner).toMatchObject({ kind: 'purchase', invocationId: 'p' });
    expect(runtime.actions?.getAvailability()).toBe('busy');
    expect(seen).toEqual(['busy']);

    // An action purchase meanwhile is refused before the service call: the
    // key is not spent and no second sheet is requested.
    const controller = runtime.actions?.createPurchaseController();
    await expect(controller?.execute(action)).rejects.toMatchObject({ name: 'GameActionExecutionError', code: 'busy' });
    expect(purchase).not.toHaveBeenCalled();
    expect(controller?.getSnapshot()).toEqual({ kind: 'purchase', status: 'idle' });

    store.fact('p', 'closed');
    expect(runtime.actions?.getAvailability()).toBe('ready');
    expect(seen).toEqual(['busy', 'ready']);

    // The same key runs once the sheet is gone.
    await expect(controller?.execute(action)).resolves.toMatchObject({ status: 'granted' });
    expect(purchase).toHaveBeenCalledOnce();
    expect(seen).toEqual(['busy', 'ready', 'busy']);
    store.fact('action', 'closed');
    expect(seen).toEqual(['busy', 'ready', 'busy', 'ready']);
    expect(runtime.execution.getSnapshot().blocks).toHaveLength(0);
    runtime.dispose();
  });

  it.each([false, true])('clears busy on a not-started fact (ads: %s)', async (ads) => {
    const { store, runtime, seen } = outsidePurchase({ ads, opens: false });
    const pending = runtime.gateway.commerce?.requestPurchase(request);
    await flush();
    expect(seen).toEqual(['busy']);
    store.fact('p', 'not-started');
    expect(seen).toEqual(['busy', 'ready']);
    await pending;
    expect(runtime.actions?.getAvailability()).toBe('ready');
    runtime.dispose();
  });

  it('ends availability delivery at runtime disposal, under an open outside sheet', async () => {
    const { store, runtime, seen } = outsidePurchase({ ads: false });
    await runtime.gateway.commerce?.requestPurchase(request);
    const late = vi.fn();
    runtime.actions?.subscribeAvailability(late);
    runtime.dispose();
    expect(seen).toEqual(['busy', 'disposed']);
    expect(late).toHaveBeenCalledExactlyOnceWith('disposed');
    // The native sheet still ends later; nobody hears it through the actions.
    store.fact('p', 'closed');
    expect(seen).toEqual(['busy', 'disposed']);
    expect(late).toHaveBeenCalledOnce();
    expect(runtime.actions?.getAvailability()).toBe('disposed');
    expect(() => runtime.actions?.subscribeAvailability(() => {})).toThrow(expect.objectContaining({ code: 'disposed' }));
    expect(store.listeners.size).toBe(0);
  });
});

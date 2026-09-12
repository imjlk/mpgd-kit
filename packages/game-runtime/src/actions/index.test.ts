import { describe, expect, it, vi } from 'vitest';

import type {
  GameServicesOperationClient,
  GameServicesPurchaseResult,
  GameServicesRewardedAdResult,
} from '@mpgd/game-services/operations';

import { createGameExecutionController } from '../index.js';
import { createGameUiBridge } from '../ui/index.js';
import {
  createGameActionCoordinator,
  createPurchaseActionController,
  createRewardedAdActionController,
  type PurchaseActionSnapshot,
} from './index.js';

const purchaseInput = { productId: 'gems', source: 'shop', idempotencyKey: 'purchase-1' } as const;
const adInput = { placementId: 'revive', idempotencyKey: 'ad-1' } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function purchaseResult(status: GameServicesPurchaseResult['status']): GameServicesPurchaseResult {
  return { status, purchase: { status: 'cancelled', entitlementIds: [] } };
}
function adResult(status: GameServicesRewardedAdResult['status']): GameServicesRewardedAdResult {
  return { status, reward: { status: 'skipped', rewardGranted: false } };
}
function setup(client: Pick<GameServicesOperationClient, 'purchase' | 'claimRewardedAd'> = {
  purchase: async () => purchaseResult('granted'),
  claimRewardedAd: async () => adResult('granted'),
}, maxRememberedKeys?: number) {
  const execution = createGameExecutionController();
  const errors: unknown[] = [];
  const coordinator = createGameActionCoordinator({
    execution,
    client,
    ...(maxRememberedKeys === undefined ? {} : { maxRememberedKeys }),
    onObserverError: (error) => {
      errors.push(error); },
  });
  const purchase = createPurchaseActionController({ coordinator });
  const ad = createRewardedAdActionController({ coordinator });
  return { execution, coordinator, purchase, ad, errors };
}

describe('monetization action ownership', () => {
  it.each(['granted', 'cancelled', 'pending', 'failed', 'rejected'] as const)('preserves purchase %s and owns only its block', async (status) => {
    const result = purchaseResult(status);
    const { execution, purchase } = setup({ purchase: async () => result, claimRewardedAd: async () => adResult('skipped') });
    const settings = execution.acquireBlock({ reason: 'settings', channels: ['simulation', 'gameplay-input'] });
    const promise = purchase.execute(purchaseInput);
    expect(execution.getSnapshot().blocks).toHaveLength(2);
    expect(await promise).toBe(result);
    expect(purchase.getSnapshot()).toEqual({ kind: 'purchase', operationId: 1, status });
    expect(execution.getSnapshot().blocks).toEqual([settings.info]);
    settings.release();
  });

  it.each(['granted', 'skipped', 'unavailable', 'failed', 'rejected'] as const)('preserves ad %s', async (status) => {
    const { execution, ad } = setup({ purchase: async () => purchaseResult('cancelled'), claimRewardedAd: async () => adResult(status) });
    await ad.execute(adInput);
    expect(ad.getSnapshot()).toEqual({ kind: 'rewarded-ad', operationId: 1, status });
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });

  it('shares one exact in-flight Promise across recreated controllers and rejects conflicting/concurrent inputs', async () => {
    const pending = deferred<GameServicesPurchaseResult>();
    const call = vi.fn(() => pending.promise);
    const { execution, coordinator, purchase, ad } = setup({ purchase: call, claimRewardedAd: vi.fn() });
    const first = purchase.execute(purchaseInput);
    expect(purchase.execute(purchaseInput)).toBe(first);
    expect(coordinator.createPurchaseController().execute(purchaseInput)).toBe(first);
    await expect(purchase.execute({ ...purchaseInput, productId: 'different' })).rejects.toMatchObject({ code: 'key-conflict' });
    await expect(purchase.execute({ ...purchaseInput, source: 'event' })).rejects.toMatchObject({ code: 'key-conflict' });
    await expect(ad.execute({ ...adInput, idempotencyKey: purchaseInput.idempotencyKey })).rejects.toMatchObject({ code: 'key-conflict' });
    await expect(ad.execute(adInput)).rejects.toMatchObject({ code: 'busy' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(execution.getSnapshot().blocks).toHaveLength(1);
    pending.resolve(purchaseResult('granted'));
    await first;
    expect(purchase.execute(purchaseInput)).toBe(first);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('uses actual progress without treating platform completion as a grant', async () => {
    const pending = deferred<GameServicesPurchaseResult>();
    const { purchase } = setup({
      purchase: (_input, options) => {
        void options?.onProgress?.({ kind: 'purchase', sequence: 1, phase: 'platform-result', status: 'completed', receipt: 'secret' } as never);
        return pending.promise;
      }, claimRewardedAd: async () => adResult('skipped'),
    });
    const promise = purchase.execute(purchaseInput);
    expect(purchase.getSnapshot()).toEqual({ kind: 'purchase', status: 'running', operationId: 1,
      progress: { kind: 'purchase', sequence: 1, phase: 'platform-result', status: 'completed' } });
    expect(Object.isFrozen(purchase.getSnapshot())).toBe(true);
    pending.resolve(purchaseResult('rejected'));
    await promise;
    expect(purchase.getSnapshot().status).toBe('rejected');
  });

  it('falls back to running when a legacy client has no progress support', async () => {
    const pending = deferred<GameServicesPurchaseResult>();
    const { purchase } = setup({ purchase: () => pending.promise, claimRewardedAd: async () => adResult('skipped') });
    const promise = purchase.execute(purchaseInput);
    expect(purchase.getSnapshot()).toEqual({ kind: 'purchase', status: 'running', operationId: 1 });
    pending.resolve(purchaseResult('granted'));
    await promise;
  });

  it('continues validation after scope A closes and never writes its completion into scope B', async () => {
    const pending = deferred<GameServicesPurchaseResult>();
    const { purchase, execution } = setup({ purchase: () => pending.promise, claimRewardedAd: async () => adResult('skipped') });
    const ui = createGameUiBridge<string, never, string>({ initialSnapshot: 'initial' });
    const events: string[] = [];
    const a = ui.createScope();
    const viewA = purchase.bindScope(a, { snapshot: (value) => `A:${value.status}`, event: () => 'A:done' });
    const promise = viewA.execute(purchaseInput);
    a.dispose();
    const b = ui.createScope();
    purchase.bindScope(b, { snapshot: (value) => `B:${value.status}`, event: () => 'B:done' });
    b.setSnapshot('B:idle');
    b.onEvent((value) => {
      events.push(value); });
    expect(execution.getSnapshot().blocked.simulation).toBe(true);
    pending.resolve(purchaseResult('granted'));
    await promise;
    expect(ui.getSnapshot()).toBe('B:idle');
    expect(events).toEqual([]);
    expect(purchase.getSnapshot().status).toBe('granted');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });

  it('isolates throwing/rejecting listeners and detaches a view before late callbacks', async () => {
    const { purchase, errors } = setup();
    const ui = createGameUiBridge<PurchaseActionSnapshot | undefined, never, string>({ initialSnapshot: undefined });
    const scope = ui.createScope();
    const view = purchase.bindScope(scope, { snapshot: () => {
        throw new Error('projection'); }, event: () => 'done' });
    purchase.subscribe(() => {
      throw new Error('listener'); });
    purchase.subscribe(async () => {
      throw new Error('async-listener'); });
    const detached = vi.fn();
    purchase.subscribe(detached)();
    expect((await view.execute(purchaseInput)).status).toBe('granted');
    await Promise.resolve();
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(detached).not.toHaveBeenCalled();
    view.dispose();
    view.dispose();
    await expect(view.execute(purchaseInput)).rejects.toMatchObject({ code: 'disposed' });
  });

  it.each(['pending', 'exception'] as const)('does not re-invoke after %s, even with a new owner/key', async (status) => {
    const failure = new Error('provider raw detail');
    const call = vi.fn(async () => {
      if (status === 'exception') {
        throw failure; }
      return purchaseResult('pending');
    });
    const { purchase, coordinator, execution } = setup({ purchase: call, claimRewardedAd: async () => adResult('skipped') });
    const promise = purchase.execute(purchaseInput);
    if (status === 'exception') {
      await expect(promise).rejects.toBe(failure); }
    else {
      await promise; }
    expect(purchase.getSnapshot().status).toBe(status);
    expect(JSON.stringify(purchase.getSnapshot())).not.toContain('provider');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
    expect(coordinator.getAvailability()).toBe('reconciliation-required');
    expect(coordinator.createPurchaseController().execute(purchaseInput)).toBe(promise);
    await expect(purchase.execute({ ...purchaseInput, idempotencyKey: 'new' })).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('bounds key history without evicting conflict protection or replaying old purchases', async () => {
    const { purchase, coordinator } = setup(undefined, 2);
    await purchase.execute(purchaseInput);
    await purchase.execute({ ...purchaseInput, idempotencyKey: '2' });
    expect(coordinator.getAvailability()).toBe('history-full');
    await expect(purchase.execute(purchaseInput)).rejects.toMatchObject({ code: 'already-completed' });
    await expect(purchase.execute({ ...purchaseInput, productId: 'changed' })).rejects.toMatchObject({ code: 'key-conflict' });
    await expect(purchase.execute({ ...purchaseInput, idempotencyKey: '3' })).rejects.toMatchObject({ code: 'history-full' });
  });

  it('owner/coordinator disposal cannot release blocks early or discard a later result', async () => {
    const pending = deferred<GameServicesPurchaseResult>();
    const { purchase, coordinator, execution } = setup({ purchase: () => pending.promise, claimRewardedAd: async () => adResult('skipped') });
    const promise = purchase.execute(purchaseInput);
    purchase.dispose();
    purchase.dispose();
    coordinator.dispose();
    coordinator.dispose();
    expect(execution.getSnapshot().blocks).toHaveLength(1);
    await expect(purchase.execute(purchaseInput)).rejects.toMatchObject({ code: 'disposed' });
    pending.resolve(purchaseResult('granted'));
    await promise;
    expect(purchase.getSnapshot().status).toBe('granted');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });

  it('reserves before reentrant observers and checks destruction before invoking the client', async () => {
    const call = vi.fn(async () => purchaseResult('granted'));
    const { purchase, execution } = setup({ purchase: call, claimRewardedAd: async () => adResult('skipped') });
    execution.subscribe(() => {
      execution.destroy(); });
    await expect(purchase.execute(purchaseInput)).rejects.toMatchObject({ code: 'disposed' });
    expect(call).not.toHaveBeenCalled();
    expect(execution.getSnapshot().status).toBe('destroyed');
  });

  it('handles a new action started by a completion observer without stale overwrite', async () => {
    const second = deferred<GameServicesPurchaseResult>();
    const call = vi.fn().mockResolvedValueOnce(purchaseResult('granted')).mockImplementationOnce(() => second.promise);
    const { purchase, execution } = setup({ purchase: call, claimRewardedAd: async () => adResult('skipped') });
    let next: Promise<GameServicesPurchaseResult> | undefined;
    purchase.subscribe((value) => {
      if (value.status === 'granted' && value.operationId === 1) {
        void (next = purchase.execute({ ...purchaseInput, idempotencyKey: '2' }));
      }
    });
    await purchase.execute(purchaseInput);
    expect(purchase.getSnapshot()).toEqual({ kind: 'purchase', status: 'running', operationId: 2 });
    expect(execution.getSnapshot().blocks).toHaveLength(1);
    second.resolve(purchaseResult('cancelled'));
    await next;
    expect(purchase.getSnapshot().status).toBe('cancelled');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });
  it('joins safely from token release and does not retain a stale running snapshot', async () => {
    const { purchase, execution, coordinator } = setup();
    const joined = coordinator.createPurchaseController();
    let joinedPromise: Promise<GameServicesPurchaseResult> | undefined;
    execution.subscribe((value) => {
      if (value.blocks.length === 0) {
        void (joinedPromise = joined.execute(purchaseInput));
      }
    });
    const first = purchase.execute(purchaseInput);
    await first;
    expect(joinedPromise).toBe(first);
    expect(joined.getSnapshot().status).toBe('granted');
  });

  it('isolates a throwing view projection accessor without orphaning the reserved flight', async () => {
    const { purchase, execution, errors } = setup();
    const ui = createGameUiBridge<string, never, string>({ initialSnapshot: 'idle' });
    const view = purchase.bindScope(ui.createScope(), {
      snapshot: (value) => value.status,
      get event(): (value: PurchaseActionSnapshot) => string {
        throw new Error('event getter'); },
    });
    expect((await view.execute(purchaseInput)).status).toBe('granted');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it('keeps the last completed Promise when a later reservation fails before the client call', async () => {
    const { purchase, coordinator, execution } = setup();
    const first = purchase.execute(purchaseInput);
    await first;
    const aborted = coordinator.createPurchaseController();
    aborted.subscribe(() => aborted.dispose());
    await expect(aborted.execute({ ...purchaseInput, idempotencyKey: 'aborted' })).rejects.toMatchObject({ code: 'disposed' });
    expect(purchase.execute(purchaseInput)).toBe(first);
    expect(coordinator.getAvailability()).toBe('ready');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
    expect(() => aborted.subscribe(() => {})).toThrow('Game action cannot start: disposed');
  });

  it('keeps startup authority with the reserving owner when a reentrant joiner disposes', async () => {
    const call = vi.fn(async () => purchaseResult('granted'));
    const { purchase, coordinator, execution } = setup({ purchase: call, claimRewardedAd: async () => adResult('skipped') });
    const joiner = coordinator.createPurchaseController();
    joiner.subscribe(() => joiner.dispose());
    let joined: Promise<GameServicesPurchaseResult> | undefined;
    purchase.subscribe((value) => {
      if (value.status === 'running') {
        void (joined = joiner.execute(purchaseInput));
      }
    });
    const original = purchase.execute(purchaseInput);
    expect(joined).toBe(original);
    expect((await original).status).toBe('granted');
    expect(call).toHaveBeenCalledTimes(1);
    expect(joiner.getSnapshot().status).toBe('granted');
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });

  it.each(['owner', 'runtime'] as const)('publishes no business exception when %s disposal prevents invocation', async (kind) => {
    const call = vi.fn(async () => purchaseResult('granted'));
    const { purchase, execution } = setup({ purchase: call, claimRewardedAd: async () => adResult('skipped') });
    const ui = createGameUiBridge<string, never, string>({ initialSnapshot: 'idle' });
    const scope = ui.createScope();
    const events = vi.fn();
    scope.onEvent(events);
    const view = purchase.bindScope(scope, { snapshot: (value) => value.status, event: (value) => value.status });
    if (kind === 'owner') {
      purchase.subscribe(() => purchase.dispose());
    } else {
      execution.subscribe(() => execution.destroy());
    }
    await expect(view.execute(purchaseInput)).rejects.toMatchObject({ code: 'disposed' });
    expect(call).not.toHaveBeenCalled();
    expect(purchase.getSnapshot()).toEqual({ kind: 'purchase', status: 'idle' });
    expect(ui.getSnapshot()).toBe('idle');
    expect(events).not.toHaveBeenCalled();
  });

});

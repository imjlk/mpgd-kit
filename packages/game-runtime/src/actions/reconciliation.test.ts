import { describe, expect, it, vi } from 'vitest';

import type { GameServicesOperationClient } from '@mpgd/game-services/operations';

import { createGameExecutionController } from '../index.js';
import {
  createGameActionCoordinator,
  type GameActionCoordinator,
  type GameActionReconciliationPort,
} from './index.js';

const input = { productId: 'gems', source: 'shop', idempotencyKey: 'buy-1' } as const;
const transaction = {
  playerId: 'player-1',
  source: 'purchase',
  grantId: 'gems',
  idempotencyKey: 'buy-1',
  ledgerEntryId: 'ledger-1',
} as const;
const recovered = { operationId: 1, transaction };
const client = (): GameServicesOperationClient => ({
  purchase: vi.fn<GameServicesOperationClient['purchase']>(async () => ({ status: 'pending', purchase: { status: 'pending', entitlementIds: [] } })),
  claimRewardedAd: vi.fn<GameServicesOperationClient['claimRewardedAd']>(async () => ({ status: 'skipped', reward: { status: 'skipped', rewardGranted: false } })),
});
function setup(recover: GameActionReconciliationPort['recover']) {
  const service = client();
  const execution = createGameExecutionController();
  const coordinator = createGameActionCoordinator({
    execution,
    client: service,
    reconciliation: { playerId: 'player-1', recover },
  });
  return { service, execution, coordinator, purchase: coordinator.createPurchaseController() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('authoritative grant reconciliation', () => {
  it('unlocks new actions only after a matching grant and never executes the old key again', async () => {
    const recover = vi.fn(async () => recovered);
    const { coordinator, purchase, service } = setup(recover);
    expect(await coordinator.reconcile()).toEqual({ status: 'not-required' });
    const original = purchase.execute(input);
    await original;
    const operation = coordinator.getPendingOperation();
    expect(operation).toEqual({ kind: 'purchase', operationId: 1, input });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation?.input)).toBe(true);
    await expect(coordinator.createRewardedAdController().execute({ placementId: 'revive', idempotencyKey: 'ad-1' })).rejects.toMatchObject({ code: 'reconciliation-required' });
    const result = await coordinator.reconcile();
    expect(result).toEqual({ status: 'reconciled', operation, ledgerEntryId: 'ledger-1' });
    expect(recover).toHaveBeenCalledWith({ ...operation, playerId: 'player-1' });
    expect(coordinator.getPendingOperation()).toBeUndefined();
    expect(coordinator.getAvailability()).toBe('ready');
    expect(purchase.execute(input)).toBe(original);
    await coordinator.createRewardedAdController().execute({ placementId: 'revive', idempotencyKey: 'ad-1' });
    await expect(purchase.execute(input)).rejects.toMatchObject({ code: 'already-completed' });
    expect(service.purchase).toHaveBeenCalledTimes(1);
    expect(service.claimRewardedAd).toHaveBeenCalledTimes(1);
  });
  it.each([
    { playerId: 'other' }, { source: 'ad_reward' }, { grantId: 'other' },
    { idempotencyKey: 'other' }, { ledgerEntryId: '' },
  ])('rejects mismatched ledger identity %j and preserves the unresolved operation', async (change) => {
    const { coordinator, purchase } = setup(async () => ({ ...recovered, transaction: { ...transaction, ...change } }) as typeof recovered);
    await purchase.execute(input);
    const before = coordinator.getPendingOperation();
    await expect(coordinator.reconcile()).rejects.toMatchObject({ code: 'invalid-reconciliation' });
    expect(coordinator.getPendingOperation()).toBe(before);
    expect(coordinator.getAvailability()).toBe('reconciliation-required');
  });
  it.each([null, { ...recovered, operationId: 2 }, { operationId: 1 }])('rejects a malformed or stale recovery envelope', async (value) => {
    const { coordinator, purchase } = setup(async () => value as typeof recovered);
    await purchase.execute(input);
    await expect(coordinator.reconcile()).rejects.toMatchObject({ code: 'invalid-reconciliation' });
    expect(coordinator.getAvailability()).toBe('reconciliation-required');
  });
  it('keeps unresolved and failed queries retryable without issuing another purchase', async () => {
    const recover = vi.fn<GameActionReconciliationPort['recover']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(recovered);
    const { coordinator, purchase, service } = setup(recover);
    await purchase.execute(input);
    expect((await coordinator.reconcile()).status).toBe('pending');
    await expect(coordinator.reconcile()).rejects.toThrow('offline');
    expect(coordinator.getAvailability()).toBe('reconciliation-required');
    expect((await coordinator.reconcile()).status).toBe('reconciled');
    expect(service.purchase).toHaveBeenCalledTimes(1);
  });
  it('shares concurrent and reentrant queries while keeping execution blocks independent', async () => {
    const gate = deferred<typeof recovered>();
    let nested: ReturnType<GameActionCoordinator['reconcile']> | undefined;
    const recover = vi.fn(() => {
      void (nested = coordinator.reconcile());
      return gate.promise; });
    const { coordinator, purchase, execution } = setup(recover);
    await purchase.execute(input);
    const block = execution.acquireBlock({ reason: 'settings', channels: ['simulation'] });
    const first = coordinator.reconcile();
    expect(coordinator.reconcile()).toBe(first);
    await Promise.resolve();
    expect(nested).toBe(first);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(coordinator.getAvailability()).toBe('reconciliation-required');
    gate.resolve(recovered);
    await first;
    expect(execution.getSnapshot().blocks).toEqual([block.info]);
    block.release();
  });
  it.each(['coordinator', 'execution'])('does not apply late recovery after %s teardown', async (target) => {
    const gate = deferred<typeof recovered>();
    const { coordinator, purchase, execution } = setup(() => gate.promise);
    await purchase.execute(input);
    const work = coordinator.reconcile();
    await Promise.resolve();
    if (target === 'coordinator') {
      coordinator.dispose();
    } else {
      execution.destroy();
    }
    gate.resolve(recovered);
    await expect(work).rejects.toMatchObject({ code: 'disposed' });
    expect(coordinator.getAvailability()).toBe('disposed');
    expect(coordinator.getPendingOperation()).toBeDefined();
  });
  it('recovers an invoked ad exception using the ad ledger identity', async () => {
    const { coordinator, service } = setup(async () => ({ operationId: 1, transaction: {
      ...transaction, source: 'ad_reward', grantId: 'revive', idempotencyKey: 'ad-1',
    } }));
    vi.mocked(service.claimRewardedAd).mockRejectedValueOnce(new Error('analytics failed after grant'));
    await expect(coordinator.createRewardedAdController().execute({ placementId: 'revive', idempotencyKey: 'ad-1' })).rejects.toThrow('analytics');
    expect((await coordinator.reconcile()).status).toBe('reconciled');
    expect(coordinator.getAvailability()).toBe('ready');
    expect(service.claimRewardedAd).toHaveBeenCalledTimes(1);
  });
  it('retains the history capacity limit after recovery and rejects absent recovery configuration', async () => {
    const coordinator = createGameActionCoordinator({ execution: createGameExecutionController(), client: client(), maxRememberedKeys: 1, reconciliation: { playerId: 'player-1', recover: async () => recovered } });
    await coordinator.createPurchaseController().execute(input);
    await coordinator.reconcile();
    expect(coordinator.getAvailability()).toBe('history-full');
    const legacy = createGameActionCoordinator({ execution: createGameExecutionController(), client: client() });
    await legacy.createPurchaseController().execute(input);
    await expect(legacy.reconcile()).rejects.toMatchObject({ code: 'reconciliation-unavailable' });
    expect(legacy.getAvailability()).toBe('reconciliation-required');
  });
});

it('pins input and recovery identity against later caller mutation', async () => {
  const recover = vi.fn(async () => recovered);
  const port = { playerId: 'player-1', recover };
  const coordinator = createGameActionCoordinator({ execution: createGameExecutionController(), client: client(), reconciliation: port });
  const supplied = { ...input };
  const work = coordinator.createPurchaseController().execute(supplied);
  Object.assign(supplied, { productId: 'other', idempotencyKey: 'other' });
  port.playerId = 'other';
  port.recover = vi.fn(async () => {
    throw new Error('replaced'); });
  await work;
  expect((await coordinator.reconcile()).status).toBe('reconciled');
  expect(recover).toHaveBeenCalledWith({
    kind: 'purchase',
    operationId: 1,
    input,
    playerId: 'player-1',
  });
});

it('does not apply the previous grant to a later unconfirmed operation', async () => {
  const { coordinator, purchase } = setup(async () => recovered);
  await purchase.execute(input);
  await coordinator.reconcile();
  await purchase.execute({ ...input, idempotencyKey: 'buy-2' });
  await expect(coordinator.reconcile()).rejects.toMatchObject({ code: 'invalid-reconciliation' });
  expect(coordinator.getPendingOperation()?.operationId).toBe(2);
});

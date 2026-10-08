import { describe, expect, it } from 'vitest';
import type { AdPlacements } from '@mpgd/catalog';
import { createGamePlatformRuntime } from '@mpgd/game-runtime/game';
import {
  createAdRewardEvidenceVerifierRegistry,
  createAppsInTossProductionEvidenceVerifier,
  createGameServicesBackend,
  createGameServicesRuntime,
  createInMemoryGameServicesStore,
  type MonetizationOperationRecord,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import { fixture, flush } from '../test/ait-sdk-fixture.js';

// Test-only atomic journal retained across reconstructed clients; not production durability.
function testJournal() {
  const records = new Map<string, MonetizationOperationRecord>();
  const store: MonetizationOperationStore = {
    async reserve(record) {
      const previous = records.get(record.key);
      if (previous !== undefined) {
        return { created: false, record: structuredClone(previous) };
      }
      records.set(record.key, structuredClone(record));
      return { created: true, record: structuredClone(record) };
    },
    async read(key) {
      const record = records.get(key);
      return record === undefined ? undefined : structuredClone(record);
    },
    async replace(expected, record) {
      const previous = records.get(record.key);
      if (previous === undefined || previous.revision !== expected || record.revision !== expected + 1 || previous.playerId !== record.playerId || previous.kind !== record.kind || previous.target !== record.target || previous.deploymentTarget !== record.deploymentTarget || JSON.stringify(previous.input) !== JSON.stringify(record.input)) {
        throw new Error('Invalid journal CAS or identity change.');
      }
      records.set(record.key, structuredClone(record));
    },
    async listRecoverable(playerId) {
      return [...records.values()].filter((record) => record.playerId === playerId && (record.result === undefined || record.result.status === 'pending')).map(
        (record) => structuredClone(record),
      );
    },
  };
  return { store, records };
}
const placements = {
  version: 'test',
  placements: [
    {
      id: 'CONTINUE',
      type: 'rewarded',
      reward: { type: 'currency', currency: 'coin', amount: 10 },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { ait: 'reward-group' },
    },
  ],
} as const satisfies AdPlacements;
describe('actual AIT SDK host/proxy to registered server verifier and ledger', () => {
  it('recovers late earning after view disposal, verifies independently, and restarts without SDK replay', async () => {
    const f = fixture();
    const journal = testJournal();
    const ledger = createInMemoryGameServicesStore();
    let serverProofReady = false;
    let authorityLookups = 0;
    const verifier = createAppsInTossProductionEvidenceVerifier({
      rewardAuthority: {
        async verifyReward(_input) {
          authorityLookups += 1;
          if (!serverProofReady) {
            return { decision: 'pending' };
          }
          return {
            decision: 'verified',
            authorityEventId: 'server-event',
            correlationId: 'ledger-key',
            playerId: 'player',
            platformPlacementId: 'reward-group',
            verifiedAt: '2026-10-09T00:00:00Z',
          };
        },
      },
    });
    const registered = createAdRewardEvidenceVerifierRegistry([
      {
        providerId: f.source.id,
        schema: 'apps-in-toss.rewarded-ad.callback.v1',
        bindings: [{ target: 'ait' }],
        verify: (input) => verifier.verifyAdReward(input),
      },
    ]);
    const backend = createGameServicesBackend({
      catalog: { version: 'test', products: [] },
      placements,
      store: ledger,
      evidenceVerifier: {
        verifyPurchase: (input) => verifier.verifyPurchase(input),
        verifyAdReward: (input) => registered.verifyAdReward(input),
      },
    });
    const create = () =>
      createGamePlatformRuntime({
        gateway: f.original,
        initialLifecycleState: 'active',
        createServices: (gateway) =>
          createGameServicesRuntime({
            gateway,
            playerId: 'player',
            target: 'ait',
            authorityMode: 'non-production',
            allowLocalBackend: true,
            localBackend: backend,
            operationStore: journal.store,
          }),
        reconciliation: {
          playerId: 'player',
          async recover(operation) {
            const source = operation.kind === 'purchase' ? 'purchase' : 'ad_reward';
            const transaction = (await ledger.listEntitlementTransactions()).find(
              (entry) => entry.source === source && entry.playerId === operation.playerId && entry.idempotencyKey === operation.input.idempotencyKey,
            );
            return transaction === undefined
              ? undefined
              : { operationId: operation.operationId, transaction: { ...transaction, source } };
          },
        },
      });
    const runtime = create();
    const view = runtime.actions?.createRewardedAdController();
    if (view === undefined) {
      throw new Error('Missing authoritative action view.');
    }
    const pending = view.execute({ placementId: 'CONTINUE', idempotencyKey: 'ledger-key' });
    await flush();
    expect(f.show).toHaveBeenCalledOnce();
    f.callbacks[0]?.onEvent({ type: 'show' });
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(true);
    f.callbacks[0]?.onEvent({ type: 'dismissed' });
    await expect(pending).resolves.toMatchObject({ status: 'pending', reward: { rewardGranted: false } });
    expect(runtime.execution.getSnapshot().blocked.simulation).toBe(false);
    view.dispose();
    expect(await ledger.listEntitlementTransactions()).toHaveLength(0);
    f.callbacks[0]?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'untrusted-amount', unitAmount: 999999 },
    });
    await flush();
    expect(await ledger.listEntitlementTransactions()).toHaveLength(0);
    expect(authorityLookups).toBeGreaterThan(0);
    const before = [...journal.records.values()][0];
    expect(before?.kind).toBe('rewarded-ad');
    if (before?.kind !== 'rewarded-ad' || before.request === undefined) {
      throw new Error('SDK evidence did not reach the original reserved request.');
    }
    expect(before.request.idempotencyKey).toBe('ledger-key');
    expect(before.request.providerId).toBe(f.source.id);
    serverProofReady = true;
    const forged = await backend.adRewards.claimAdReward({
      ...before.request, idempotencyKey: 'forged-key', platformImpressionId: 'forged-correlation',
      evidence: { schema: 'apps-in-toss.rewarded-ad.callback.v1', payload: { event: 'user-earned-reward', correlationId: 'forged-correlation', placementId: 'reward-group' } },
    });
    expect(forged.granted).toBe(false);
    expect(await ledger.listEntitlementTransactions()).toHaveLength(0);
    await runtime.reconcile();
    expect(await ledger.listEntitlementTransactions()).toHaveLength(1);
    expect(runtime.actions?.getAvailability()).toBe('ready');
    const after = [...journal.records.values()][0];
    expect(after?.platformCompletedAt).toBe(before.platformCompletedAt);
    expect(after?.request).toEqual(before.request);
    const replay = await backend.adRewards.claimAdReward({ ...before.request, idempotencyKey: 'another-key' });
    expect(replay.granted).toBe(false);
    expect(await ledger.listEntitlementTransactions()).toHaveLength(1);
    runtime.dispose();
    const restarted = create();
    const resumed = restarted.actions?.createRewardedAdController();
    await expect(resumed?.execute({ placementId: 'CONTINUE', idempotencyKey: 'ledger-key' })).resolves.toMatchObject({ status: 'granted', claim: { granted: true, alreadyProcessed: expect.any(Boolean) } });
    expect(f.show).toHaveBeenCalledOnce();
    expect(await ledger.listEntitlementTransactions()).toHaveLength(1);
    resumed?.dispose();
    restarted.dispose();
    f.gateway.dispose();
  });
});

describe('late known non-grant after a caller deadline', () => {
  it('retires a journaled load failure and permits a new key without replaying the old SDK request', async () => {
    const f = fixture();
    const journal = testJournal();
    let failLoad = () => {};
    let expire = () => {};
    f.load.mockImplementation((callbacks) => {
      failLoad = () => callbacks.onError(new Error('No ad loaded'));
      return () => {};
    });
    const backend = createGameServicesBackend({
      catalog: { version: 'test', products: [] },
      placements,
    });
    const runtime = createGamePlatformRuntime({
      gateway: f.original,
      initialLifecycleState: 'active',
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
      createServices: (gateway) =>
        createGameServicesRuntime({
          gateway,
          playerId: 'player',
          target: 'ait',
          authorityMode: 'non-production',
          allowLocalBackend: true,
          localBackend: backend,
          operationStore: journal.store,
        }),
    });
    const view = runtime.actions?.createRewardedAdController();
    if (view === undefined) {
      throw new Error('Missing action view.');
    }
    const pending = view.execute({ placementId: 'CONTINUE', idempotencyKey: 'late-load' });
    await flush();
    expire();
    await expect(pending).resolves.toMatchObject({ status: 'pending' });
    expect(runtime.actions?.getAvailability()).toBe('busy');
    failLoad();
    await flush();
    expect(runtime.actions?.getAvailability()).toBe('ready');
    expect([...journal.records.values()][0]?.result?.status).toBe('failed');
    await view.execute({ placementId: 'CONTINUE', idempotencyKey: 'late-load' });
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.show).not.toHaveBeenCalled();
    f.load.mockImplementation((callbacks) => {
      queueMicrotask(() => callbacks.onEvent({ type: 'loaded' }));
      return () => {};
    });
    const next = view.execute({ placementId: 'CONTINUE', idempotencyKey: 'new-load' });
    await flush();
    expect(f.show).toHaveBeenCalledOnce();
    f.callbacks[0]?.onEvent({ type: 'failedToShow' });
    await next;
    view.dispose();
    runtime.dispose();
    f.gateway.dispose();
  });
});

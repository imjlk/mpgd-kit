import { describe, expect, it, vi } from 'vitest';
import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PurchaseResult,
} from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  type AdPresentationEvent,
  type AdProvider,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';
import { createGameServicesClient, type GameServicesBackendApi } from '@mpgd/game-services/client';
import { createClientRewardEvidenceRegistry } from '@mpgd/game-services/client-reward-evidence';

import { createGameExecutionController } from '../index.js';
import { createFullScreenPresentationScope } from '../presentation/index.js';
import { createGameActionCoordinator } from '../actions/index.js';
import {
  createAdClaimEvidenceRecoveryObserver,
  createCoordinatedAdProvider,
  createCoordinatedPlatformGateway,
  type PurchasePresentationEvent,
} from './index.js';

const proof = { schema: 'fixture.reward.v1', payload: { impression: 'sdk-impression' } };
const request = (invocationId = 'a'): AdShowInput => ({
  placementId: 'CONTINUE',
  format: 'rewarded',
  invocationId,
  idempotencyKey: invocationId,
});
const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};
function sdk(rewardSignal: AdProvider['rewardSignal'] = 'immediate') {
  const callbacks = new Set<(event: AdPresentationEvent) => void>();
  const calls: AdShowInput[] = [];
  const completions = new Map<string, (result: AdShowResult) => void>();
  const failures = new Map<string, (reason: Error) => void>();
  const provider: AdProvider = {
    id: 'fixture',
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal,
    getAvailability: vi.fn(async () => ({ state: 'available' as const })),
    preload: vi.fn(async () => ({ status: 'deferred' as const })),
    show(input) {
      calls.push(input);
      return new Promise((resolve, reject) => {
        completions.set(input.invocationId, resolve);
        failures.set(input.invocationId, reject);
      });
    },
    subscribe(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
  return {
    provider,
    calls,
    callbacks,
    emit(type: AdPresentationEvent['type'], invocationId: string, sequence: number) {
      const event = { providerId: 'fixture', invocationId, sequence, type, ...(type === 'reward-earned' ? { evidence: proof } : {}), ...(type === 'failed' ? { reason: 'transient-failure' } : {}) } as AdPresentationEvent;
      for (const callback of [...callbacks]) {
        callback(event);
      }
    },
    finish(input: AdShowInput, eligibility: AdShowResult['eligibility']) {
      completions.get(input.invocationId)?.({
        providerId: 'fixture',
        invocationId: input.invocationId,
        format: input.format,
        outcome: 'shown',
        presentation: 'closed',
        eligibility,
        ...(eligibility === 'eligible' ? { evidence: proof } : {}),
      });
    },
    fail(invocationId: string) {
      failures.get(invocationId)?.(new Error('SDK callback lost'));
    },
  };
}
function environment() {
  const execution = createGameExecutionController();
  const presentation = createFullScreenPresentationScope({ execution });
  return { execution, presentation };
}
function gateway(): PlatformGateway {
  return {
    target: 'browser',
    getCapabilities: async () => createUnsupportedCapabilities(),
    identity: { getPlayer: async () => ({ playerId: 'player' }) },
    commerce: {
      getProducts: async () => [],
      purchase: vi.fn(async () => ({ status: 'cancelled' as const, entitlementIds: [] })),
      getEntitlements: async () => [],
    },
    ads: {
      preload: async () => {},
      showRewarded: async () => ({ status: 'unavailable', rewardGranted: false }),
    },
    leaderboard: { submitScore: async () => ({ submitted: false }), open: async () => {} },
    lifecycle: { onPause: () => () => {}, onResume: () => () => {} },
    storage: { load: async () => null, save: async () => {} },
  };
}
describe('full-screen presentation ownership', () => {
  it('handles closure and start reentry while acquiring deferred audio', () => {
    for (const reentry of ['start', 'close'] as const) {
      const { execution, presentation } = environment();
      const ad = presentation.acquire({
        kind: 'interstitial',
        invocationId: 'audio',
        audioStart: 'started',
      });
      execution.subscribe((snapshot) => {
        if (snapshot.blocked.audio) {
          if (reentry === 'start') {
            ad.markStarted();
          } else {
            ad.confirmClosed();
          }
        }
      });
      ad.markStarted();
      if (reentry === 'start') {
        expect(execution.getSnapshot().blocks.filter((block) => block.channels.includes('audio'))).toHaveLength(
          1,
        );
      } else {
        expect(presentation.getSnapshot().status).toBe('ready');
      }
      ad.confirmClosed();
      expect(execution.getSnapshot().blocks).toHaveLength(0);
    }
  });
  it('defers audio until physical start and releases only its own blocks', () => {
    const { execution, presentation } = environment();
    const loadFailure = presentation.acquire({
      kind: 'interstitial',
      invocationId: 'a',
      audioStart: 'started',
    });
    expect(execution.getSnapshot().blocked.simulation).toBe(true);
    expect(execution.getSnapshot().blocked.audio).toBe(false);
    loadFailure.confirmClosed();
    expect(execution.getSnapshot().blocks).toHaveLength(0);
    const ad = presentation.acquire({
      kind: 'interstitial',
      invocationId: 'b',
      audioStart: 'started',
    });
    ad.markStarted();
    const settings = execution.acquireBlock({ reason: 'settings', channels: ['audio'] });
    expect(execution.getSnapshot().blocked.audio).toBe(true);
    ad.confirmClosed();
    expect(execution.getSnapshot().blocked.audio).toBe(true);
    expect(execution.getSnapshot().blocked.simulation).toBe(false);
    settings.release();
    expect(execution.getSnapshot().blocked.audio).toBe(false);
    const unknown = presentation.acquire({
      kind: 'interstitial',
      invocationId: 'c',
      audioStart: 'started',
    });
    unknown.markUnknown();
    expect(execution.getSnapshot().blocked.audio).toBe(true);
    unknown.confirmClosed();
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });
  it('shares all formats and releases only its own execution/audio blocks', () => {
    const { execution, presentation } = environment();
    const background = execution.acquireBlock({
      reason: 'background',
      channels: ['simulation', 'gameplay-input', 'audio'],
    });
    const ad = presentation.acquire({ kind: 'rewarded', invocationId: 'a' });
    expect(() => presentation.acquire({ kind: 'purchase', invocationId: 'p' })).toThrow('busy');
    ad.confirmClosed();
    expect(execution.getSnapshot().blocked.audio).toBe(true);
    const next = presentation.acquire({ kind: 'interstitial', invocationId: 'b' });
    ad.confirmClosed();
    expect(presentation.getSnapshot().owner?.invocationId).toBe('b');
    background.release();
    expect(execution.getSnapshot().blocked.simulation).toBe(true);
    next.confirmClosed();
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });
  it('retains live native ownership through disposal', () => {
    const { execution, presentation } = environment();
    const ad = presentation.acquire({ kind: 'rewarded', invocationId: 'a' });
    ad.markUnknown();
    presentation.dispose();
    expect(execution.getSnapshot().blocked.audio).toBe(true);
    expect(() => presentation.acquire({ kind: 'interstitial', invocationId: 'b' })).toThrow(
      'disposed',
    );
    ad.confirmClosed();
    expect(execution.getSnapshot().blocks).toHaveLength(0);
  });
  it('cannot overwrite an owner acquired by a reentrant input getter', () => {
    const { presentation } = environment();
    expect(() => presentation.acquire({ kind: 'rewarded', get invocationId() { presentation.acquire({ kind: 'purchase', invocationId: 'p' }); return 'a'; } })).toThrow(
      'busy',
    );
    expect(presentation.getSnapshot().owner?.invocationId).toBe('p');
  });
});
describe('coordinated advertising', () => {
  it('preserves deferred audio policy through the coordinated provider', async () => {
    const native = sdk();
    const state = environment();
    const provider = createCoordinatedAdProvider({
      provider: { ...native.provider, presentationAudio: 'started' },
      ...state,
    });
    const input = { ...request('audio'), format: 'interstitial' as const };
    const result = provider.show(input);
    await flush();
    expect(provider.presentationAudio).toBe('started');
    expect(state.execution.getSnapshot().blocked.audio).toBe(false);
    expect(state.execution.getSnapshot().blocked.simulation).toBe(true);
    native.emit('started', 'audio', 1);
    expect(state.execution.getSnapshot().blocked.audio).toBe(true);
    native.emit('closed', 'audio', 2);
    native.finish(input, 'not-applicable');
    await result;
    expect(state.execution.getSnapshot().blocked.audio).toBe(false);
    expect(state.presentation.getSnapshot().status).toBe('ready');
  });
  it('recovers late correlation using the original journal key and can retry when eligibility changes', async () => {
    const native = sdk('delayed');
    const recovery = {
      recoverRewardResult: vi.fn(async () => ({
        status: 'pending' as const,
        reward: { status: 'pending' as const, rewardGranted: false },
      })),
    };
    const onResult = vi.fn();
    let expire: (() => void) | undefined;
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      ...environment(),
      onClaimEvidence: createAdClaimEvidenceRecoveryObserver({ recovery, onResult }),
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
    });
    const input = { ...request(), idempotencyKey: 'original-journal-key' };
    const result = ads.show(input);
    await flush();
    expire?.();
    await result;
    for (const callback of native.callbacks) {
      callback({
        providerId: 'fixture',
        invocationId: 'a',
        sequence: 1,
        type: 'requested',
        claimEvidence: proof,
      });
    }
    await flush();
    expect(recovery.recoverRewardResult).toHaveBeenCalledWith('original-journal-key', {
      status: 'pending',
      rewardGranted: false,
      evidence: proof,
    });
    native.emit('reward-earned', 'a', 2);
    native.emit('reward-earned', 'a', 3);
    native.finish(input, 'eligible');
    await flush();
    expect(recovery.recoverRewardResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({
      invocationId: 'a',
      idempotencyKey: 'original-journal-key',
    });
  });
  it('makes early server correlation available at the deadline without claiming local eligibility', async () => {
    const native = sdk('delayed');
    let expire: (() => void) | undefined;
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      ...environment(),
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
    });
    const result = ads.show(request());
    await flush();
    for (const callback of native.callbacks) {
      callback({
        providerId: 'fixture',
        invocationId: 'a',
        sequence: 1,
        type: 'requested',
        claimEvidence: proof,
      });
    }
    expire?.();
    expect(await result).toMatchObject({ eligibility: 'unknown', claimEvidence: proof });
    native.emit('closed', 'a', 2);
  });
  it('resumes execution on native close while the real client waits for its backend claim', async () => {
    const native = sdk();
    const state = environment();
    const controlled = createCoordinatedPlatformGateway({
      gateway: gateway(),
      provider: native.provider,
      ...state,
    });
    let grant!: (result: { granted: boolean; ledgerEntryId: string; alreadyProcessed: boolean }) => void;
    const claim = vi.fn(
      () => new Promise<{ granted: boolean; ledgerEntryId: string; alreadyProcessed: boolean }>(
        (resolve) => {
          grant = resolve;
        },
      ),
    );
    const backend: GameServicesBackendApi = {
      purchases: { verifyPurchase: async () => ({ verified: false, alreadyProcessed: false }) },
      adRewards: { claimAdReward: claim },
      leaderboard: {
        recordScore: async () => ({
          submitted: false,
          alreadyProcessed: false,
          ledgerEntryId: '',
          rank: 0,
        }),
      },
    };
    const client = createGameServicesClient({
      gateway: controlled,
      backend,
      playerId: 'player',
      target: 'android',
      rewardEvidenceRegistry: createClientRewardEvidenceRegistry([
        { schema: proof.schema, normalize: () => ({ platformImpressionId: 'sdk-impression' }) },
      ]),
    });
    const coordinator = createGameActionCoordinator({
      client,
      execution: state.execution,
      presentation: state.presentation,
    });
    const action = coordinator.createRewardedAdController();
    const reward = action.execute({ placementId: 'CONTINUE', idempotencyKey: 'a' });
    await flush();
    native.emit('started', 'a', 1);
    native.emit('reward-earned', 'a', 2);
    native.emit('closed', 'a', 3);
    native.finish(request(), 'eligible');
    await flush();
    expect(claim).toHaveBeenCalledOnce();
    expect(state.execution.getSnapshot().blocks).toHaveLength(0);
    expect(action.getSnapshot().status).toBe('running');
    const next = controlled.ads.provider?.show({ ...request('b'), format: 'interstitial' });
    await flush();
    action.dispose();
    grant({ granted: true, ledgerEntryId: 'server-ledger', alreadyProcessed: false });
    expect(await reward).toMatchObject({
      status: 'granted',
      ledgerEntryId: 'server-ledger',
      reward: { rewardGranted: false },
    });
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('b');
    native.finish({ ...request('b'), format: 'interstitial' }, 'not-applicable');
    await next;
    coordinator.dispose();
  });
  it('rejects action coordination bound to a different execution controller', () => {
    expect(() => createGameActionCoordinator({ execution: createGameExecutionController(), presentation: environment().presentation, client: { purchase: vi.fn(), claimRewardedAd: vi.fn() } })).toThrow(
      'share one execution',
    );
  });
  it('joins duplicate invocations and rejects conflicting reuse without another SDK call', async () => {
    const native = sdk();
    const ads = createCoordinatedAdProvider({ provider: native.provider, ...environment() });
    const first = ads.show(request());
    expect(ads.show(request())).toBe(first);
    await expect(ads.show({ ...request(), placementId: 'OTHER' })).rejects.toMatchObject({ code: 'key-conflict' });
    await flush();
    expect(native.calls).toHaveLength(1);
    native.finish(request(), 'eligible');
    expect((await first).eligibility).toBe('eligible');
  });
  it('uses one surface for purchase, rewarded, and interstitial gateway calls', async () => {
    const native = sdk();
    const state = environment();
    const original = gateway();
    const controlled = createCoordinatedPlatformGateway({
      gateway: original,
      provider: native.provider,
      ...state,
    });
    const ad = controlled.ads.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'a' });
    await flush();
    await expect(controlled.commerce.purchase({ productId: 'COINS', source: 'shop', idempotencyKey: 'p' })).rejects.toMatchObject({ code: 'busy' });
    expect(original.commerce.purchase).not.toHaveBeenCalled();
    const blocked = await controlled.ads.provider?.show({ ...request('b'), format: 'interstitial' });
    expect(blocked?.reason).toBe('busy');
    native.emit('started', 'a', 1);
    native.emit('reward-earned', 'a', 2);
    native.emit('closed', 'a', 3);
    expect(state.execution.getSnapshot().blocks).toHaveLength(0);
    const next = controlled.ads.provider?.show({ ...request('c'), format: 'interstitial' });
    await flush();
    expect(native.calls).toHaveLength(2);
    native.finish(request(), 'eligible');
    expect((await ad).rewardGranted).toBe(false);
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('c');
    native.finish({ ...request('c'), format: 'interstitial' }, 'not-applicable');
    await next;
  });
  it('ends caller waiting without cancelling native UI, and isolates late closure', async () => {
    const native = sdk('delayed');
    const state = environment();
    const background = state.execution.acquireBlock({ reason: 'settings', channels: ['audio'] });
    let expire: (() => void) | undefined;
    const candidates: unknown[] = [];
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      ...state,
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
      onClaimEvidence: (value) => {
        candidates.push(value);
      },
    });
    const first = ads.show(request());
    await flush();
    native.emit('started', 'a', 1);
    expire?.();
    expect(await first).toMatchObject({ outcome: 'pending', presentation: 'unknown' });
    expect((await ads.show(request('b'))).reason).toBe('busy');
    native.emit('closed', 'a', 2);
    expect(state.execution.getSnapshot().blocked.audio).toBe(true);
    expect(state.execution.getSnapshot().blocked.simulation).toBe(false);
    const next = ads.show(request('c'));
    await flush();
    native.emit('reward-earned', 'a', 3);
    native.finish(request(), 'eligible');
    await flush();
    expect(candidates).toHaveLength(1);
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('c');
    native.emit('closed', 'a', 4);
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('c');
    native.finish(request('c'), 'eligible');
    await next;
    background.release();
  });
  it('keeps minimal terminal/evidence observation after view disposal', async () => {
    const native = sdk('delayed');
    const state = environment();
    let expire: (() => void) | undefined;
    const candidates: unknown[] = [];
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      ...state,
      deadline: {
        milliseconds: 10,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
      onClaimEvidence: (value) => {
        candidates.push(value);
      },
    });
    const result = ads.show(request());
    await flush();
    ads.dispose();
    expire?.();
    await result;
    expect(native.callbacks.size).toBe(1);
    native.emit('started', 'a', 1);
    native.emit('reward-earned', 'a', 2);
    native.emit('closed', 'a', 3);
    expect(candidates).toHaveLength(1);
    expect(state.execution.getSnapshot().blocks).toHaveLength(0);
    expect(native.callbacks.size).toBe(0);
  });
  it('gates policy, unsupported and unconfigured placements before SDK display', async () => {
    const native = sdk();
    const denied = createCoordinatedAdProvider({
      provider: native.provider,
      ...environment(),
      canShow: () => false,
    });
    expect((await denied.show(request())).reason).toBe('policy-disabled');
    expect(native.provider.getAvailability).not.toHaveBeenCalled();
    const absent = createCoordinatedAdProvider({
      provider: {
        ...native.provider,
        getAvailability: async () => ({ state: 'configuration-required' }),
      },
      ...environment(),
    });
    expect((await absent.show(request())).reason).toBe('configuration-required');
    expect(native.calls).toHaveLength(0);
  });
  it('treats an SDK rejection as uncertain and preserves closure observation', async () => {
    const native = sdk();
    const state = environment();
    const ads = createCoordinatedAdProvider({ provider: native.provider, ...state });
    const result = ads.show(request());
    await flush();
    native.fail('a');
    expect((await result).presentation).toBe('unknown');
    expect(state.execution.getSnapshot().blocked.simulation).toBe(true);
    native.emit('closed', 'a', 1);
    expect(state.execution.getSnapshot().blocks).toHaveLength(0);
  });
  it('does not let a deadline cleanup exception change a native result', async () => {
    const native = sdk();
    const onObserverError = vi.fn();
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      ...environment(),
      onObserverError,
      deadline: {
        milliseconds: 10,
        schedule: () => () => {
          throw new Error('cleanup');
        },
      },
    });
    const result = ads.show(request());
    await flush();
    native.finish(request(), 'eligible');
    expect((await result).outcome).toBe('shown');
    expect(onObserverError).toHaveBeenCalledOnce();
  });
});

describe('coordinated purchase presentation', () => {
  it('ignores contradictory no-start facts and isolates a late purchase result from the next ad', async () => {
    const state = environment();
    const native = sdk();
    const original = gateway();
    let finish!: (result: PurchaseResult) => void;
    original.commerce.purchase = () => new Promise((resolve) => { finish = resolve; });
    let callback!: (event: PurchasePresentationEvent) => void;
    const controlled = createCoordinatedPlatformGateway({ gateway: original, provider: native.provider, ...state, classifyPurchasePresentation: () => 'closed', purchasePresentation: { subscribe(listener) { callback = listener; return () => {}; } } });
    const purchase = controlled.commerce.purchase({ productId: 'COINS', source: 'shop', idempotencyKey: 'p' });
    await flush();
    callback({ idempotencyKey: 'p', sequence: 1, state: 'open' });
    callback({ idempotencyKey: 'p', sequence: 2, state: 'not-started' });
    expect(state.execution.getSnapshot().blocked.audio).toBe(true);
    callback({ idempotencyKey: 'p', sequence: 3, state: 'closed' });
    const ad = controlled.ads.provider?.show({ ...request('b'), format: 'interstitial' });
    await flush();
    finish({ status: 'cancelled', entitlementIds: [] });
    await purchase;
    callback({ idempotencyKey: 'p', sequence: 4, state: 'closed' });
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('b');
    native.finish({ ...request('b'), format: 'interstitial' }, 'not-applicable');
    await ad;
    controlled.dispose();
  });
  it('requires native closure even for completed business results, preserves class methods, and retains a close observer through disposal', async () => {
    const state = environment();
    const original = gateway();
    class Gateway {
      readonly target = 'browser' as const;
      readonly identity = original.identity;
      readonly commerce = Object.freeze(original.commerce);
      readonly ads = Object.freeze(original.ads);
      readonly leaderboard = original.leaderboard;
      readonly lifecycle = original.lifecycle;
      readonly storage = original.storage;
      #capabilities = createUnsupportedCapabilities();
      async getCapabilities() { return this.#capabilities; }
    }
    const callbacks = new Set<(event: PurchasePresentationEvent) => void>();
    const controlled = createCoordinatedPlatformGateway({ gateway: Object.freeze(new Gateway()), provider: sdk().provider, ...state, purchasePresentation: { subscribe(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; } } });
    expect(await controlled.getCapabilities()).toEqual(createUnsupportedCapabilities());
    const input = { productId: 'COINS', source: 'shop', idempotencyKey: 'p' } as const;
    const first = controlled.commerce.purchase(input);
    expect(controlled.commerce.purchase(input)).toBe(first);
    expect((await first).status).toBe('cancelled');
    expect(state.presentation.getSnapshot().status).toBe('unknown');
    controlled.dispose();
    expect(callbacks.size).toBe(1);
    for (const callback of callbacks) { callback({ idempotencyKey: 'other', sequence: 1, state: 'closed' }); }
    expect(state.presentation.getSnapshot().owner?.invocationId).toBe('p');
    for (const callback of [...callbacks]) { callback({ idempotencyKey: 'p', sequence: 1, state: 'closed' }); }
    expect(state.execution.getSnapshot().blocks).toHaveLength(0);
    expect(callbacks.size).toBe(0);
  });
  it('allows a preflight busy key to retry and prevents retired keys from reopening SDK UI', async () => {
    const state = environment();
    const original = gateway();
    const controlled = createCoordinatedPlatformGateway({ gateway: original, provider: sdk().provider, ...state, classifyPurchasePresentation: () => 'closed' });
    const blocker = state.presentation.acquire({ kind: 'interstitial', invocationId: 'ad' });
    const request = { productId: 'COINS', source: 'shop', idempotencyKey: 'p' } as const;
    await expect(controlled.commerce.purchase(request)).rejects.toMatchObject({ code: 'busy' });
    blocker.confirmClosed();
    await controlled.commerce.purchase(request);
    await controlled.commerce.purchase({ ...request, idempotencyKey: 'q' });
    await expect(controlled.commerce.purchase(request)).rejects.toMatchObject({ code: 'already-completed' });
    expect(original.commerce.purchase).toHaveBeenCalledTimes(2);
  });
});

describe('late native failures and candidate preservation', () => {
  it('keeps a failed-to-start native fact when the SDK Promise later returns a less specific result', async () => {
    const native = sdk('delayed');
    const { presentation } = environment();
    let expire = () => {};
    const late: AdShowResult[] = [];
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      presentation,
      deadline: {
        milliseconds: 1,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
      onLateResult: ({ result }) => {
        late.push(result);
      },
    });
    const pending = ads.show(request());
    await flush();
    expire();
    await pending;
    native.emit('failed', 'a', 1);
    native.finish(request(), 'not-earned');
    await flush();
    expect(presentation.getSnapshot().owner).toBeUndefined();
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((result) => result.outcome === 'failed' && result.presentation === 'not-started')).toBe(
      true,
    );
    expect(native.calls).toHaveLength(1);
    ads.dispose();
  });
  it('never forwards a negative replacement once an original claim candidate has been observed', async () => {
    const native = sdk('delayed');
    const { presentation } = environment();
    let expire = () => {};
    const late = vi.fn();
    const ads = createCoordinatedAdProvider({
      provider: native.provider,
      presentation,
      deadline: {
        milliseconds: 1,
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
      onLateResult: late,
    });
    const pending = ads.show(request());
    await flush();
    for (const callback of native.callbacks) {
      callback({
        providerId: 'fixture',
        invocationId: 'a',
        sequence: 1,
        type: 'requested',
        claimEvidence: proof,
      });
    }
    expire();
    await expect(pending).resolves.toMatchObject({ claimEvidence: proof });
    native.emit('failed', 'a', 2);
    native.finish(request(), 'not-earned');
    await flush();
    expect(late).not.toHaveBeenCalled();
    expect(native.calls).toHaveLength(1);
    ads.dispose();
  });
});

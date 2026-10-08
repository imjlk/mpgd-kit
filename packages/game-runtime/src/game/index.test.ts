import { describe, expect, it, vi } from 'vitest';
import { createUnsupportedCapabilities, type PlatformGateway } from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  type AdPresentationEvent,
  type AdProvider,
  type AdShowResult,
} from '@mpgd/platform/ads';
import { createGamePlatformRuntime } from './index.js';

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
    commerce: {
      getProducts: async () => [],
      purchase: async () => ({ status: 'failed', entitlementIds: [] }),
      getEntitlements: async () => [],
    },
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

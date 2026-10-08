import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAitPlatformGateway } from './index.js';
import { fixture, flush } from '../test/ait-sdk-fixture.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('AIT SDK to real host, proxy and coordinated gateway', () => {
  it('releases physical ownership on dismissal while late reward evidence keeps the original claim identity', async () => {
    const f = fixture();
    const pending = f.ads.show(f.input);
    await flush();
    expect(f.show).toHaveBeenCalledOnce();
    f.callbacks[0]?.onEvent({ type: 'show' });
    const background = f.execution.acquireBlock({
      reason: 'background',
      channels: ['simulation', 'gameplay-input', 'audio'],
    });
    f.callbacks[0]?.onEvent({ type: 'dismissed' });
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    expect(f.execution.getSnapshot().blocks.map((block) => block.reason)).toEqual(['background']);
    await expect(pending).resolves.toMatchObject({ outcome: 'shown', presentation: 'closed', eligibility: 'unknown' });
    expect(f.cleanups[0]).not.toHaveBeenCalled();
    f.gateway.dispose();
    f.callbacks[0]?.onEvent({ type: 'userEarnedReward', data: { unitType: 'coin', unitAmount: 1 } });
    await flush();
    expect(f.evidence).toEqual([
      {
        input: f.input,
        eligibility: 'eligible',
        evidence: {
          schema: 'apps-in-toss.rewarded-ad.callback.v1',
          payload: {
            event: 'user-earned-reward',
            correlationId: 'claim-a',
            placementId: 'reward-group',
          },
        },
      },
    ]);
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
    expect(f.execution.getSnapshot().blocks.map((block) => block.reason)).toEqual(['background']);
    background.release();
  });
  it('keeps callback and native occupancy after both caller and SDK wait limits', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.ads.show(f.input);
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown', eligibility: 'unknown' });
    expect(f.cleanups[0]).not.toHaveBeenCalled();
    expect(f.presentation.getSnapshot().owner?.invocationId).toBe('invocation-a');
    const recreated = createAitPlatformGateway({ appVersion: 'test', buildId: 'test', bridge: f.host() }).ads.provider;
    await expect(recreated?.getAvailability({ placementId: 'BREAK', format: 'interstitial' })).resolves.toEqual({ state: 'action-required', reason: 'action-required' });
    await expect(f.ads.show({ ...f.input, invocationId: 'invocation-b', idempotencyKey: 'claim-b' })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'busy' });
    expect(f.show).toHaveBeenCalledOnce();
    f.callbacks[0]?.onEvent({ type: 'show' });
    f.callbacks[0]?.onEvent({ type: 'userEarnedReward', data: { unitType: 'coin', unitAmount: 1 } });
    f.callbacks[0]?.onEvent({ type: 'dismissed' });
    await flush();
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    expect(f.evidence[0]?.input.idempotencyKey).toBe('claim-a');
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.type === 'closed')).toHaveLength(1);
    f.gateway.dispose();
  });
  it('arbitrates interstitial and purchase through the same native scope and deduplicates an invocation', async () => {
    const f = fixture();
    const first = f.ads.show(f.input);
    expect(f.ads.show(f.input)).toBe(first);
    await flush();
    f.callbacks[0]?.onEvent({ type: 'show' });
    await expect(f.ads.show({ placementId: 'BREAK', format: 'interstitial', invocationId: 'b', idempotencyKey: 'b' })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'busy' });
    await expect(f.gateway.commerce.purchase({ productId: 'hints', source: 'shop', idempotencyKey: 'purchase' })).rejects.toMatchObject({ code: 'busy' });
    expect(f.show).toHaveBeenCalledOnce();
    f.callbacks[0]?.onEvent({ type: 'failedToShow' });
    await first;
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    f.gateway.dispose();
  });
  it('reports preparation and configuration independently and handles synchronous native termination', async () => {
    const f = fixture();
    await expect(f.source.preload({ placementId: 'CONTINUE', format: 'rewarded' })).resolves.toEqual({ status: 'ready' });
    await expect(f.source.getAvailability({ placementId: 'missing', format: 'rewarded' })).resolves.toMatchObject({ state: 'configuration-required' });
    f.show.mockImplementation((callback) => {
      callback.onEvent({ type: 'failedToShow' });
      const cleanup = vi.fn();
      f.cleanups.push(cleanup);
      return cleanup;
    });
    await expect(f.ads.show(f.input)).resolves.toMatchObject({ outcome: 'failed', presentation: 'not-started', eligibility: 'not-earned' });
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    expect(f.cleanups.at(-1)).toHaveBeenCalledOnce();
    f.gateway.dispose();
  });
  it('retains occupancy on SDK bridge error until a real failed-to-show callback', async () => {
    const f = fixture();
    const pending = f.ads.show(f.input);
    await flush();
    f.callbacks[0]?.onError(new Error('Bridge response was lost'));
    await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown' });
    expect(f.cleanups[0]).not.toHaveBeenCalled();
    expect(f.presentation.getSnapshot().owner).toBeDefined();
    f.callbacks[0]?.onEvent({ type: 'failedToShow' });
    await flush();
    expect(f.presentation.getSnapshot().owner).toBeUndefined();
    expect(f.cleanups[0]).toHaveBeenCalledOnce();
    f.gateway.dispose();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewardedAdResult } from '@verse8/ads';
import {
  createVerse8PlatformGateway,
  type Verse8AdPresentationEvent,
  type Verse8AdsClient,
} from './index.js';

function fixture() {
  const callbacks = new Set<(event: Verse8AdPresentationEvent) => void>();
  let resolve!: (value: RewardedAdResult) => void;
  const show = vi.fn(
    () => new Promise<RewardedAdResult>((done) => {
      resolve = done;
    }),
  );
  const client: Verse8AdsClient = {
    showRewarded: show,
    showInterstitial: async (input) => ({ status: 'dismissed', requestId: input.requestId ?? '' }),
  };
  const presentation = {
    subscribe(listener: (event: Verse8AdPresentationEvent) => void) {
      callbacks.add(listener);
      return () => {
        callbacks.delete(listener);
      };
    },
  };
  const create = () => createVerse8PlatformGateway({
    adsClient: client,
    adPresentation: presentation,
    adsTimeoutMs: 30,
    resolveAdPlacementId: () => 'native-placement',
  });
  const provider = create().ads.provider;
  if (provider === undefined) {
    throw new Error('Verse8 provider missing.');
  }
  const input = {
    placementId: 'CONTINUE',
    format: 'rewarded' as const,
    invocationId: 'invocation',
    idempotencyKey: 'claim',
  };
  const emit = (event: Verse8AdPresentationEvent) => {
    for (const listener of callbacks) {
      listener(event);
    }
  };
  return {
    provider,
    create,
    client,
    show,
    callbacks,
    resolve: (result: RewardedAdResult) => resolve(result),
    emit,
    input,
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}
afterEach(() => {
  vi.useRealTimers();
});
describe('real Verse8 adapter advertising behavior', () => {
  it('requires trusted rewarded closure before touching SDK 0.4', async () => {
    const show = vi.fn();
    const provider = createVerse8PlatformGateway({ adsClient: { showRewarded: show, showInterstitial: show }, resolveAdPlacementId: () => 'placement' }).ads.provider;
    await expect(provider?.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'invocation', idempotencyKey: 'claim' })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'configuration-required', presentation: 'not-started' });
    expect(show).not.toHaveBeenCalled();
    await expect(provider?.preload({ placementId: 'BREAK', format: 'interstitial' })).resolves.toEqual({ status: 'deferred' });
  });
  it('keeps rewarded completion occupied until the host closes the original request', async () => {
    const f = fixture();
    const pending = f.provider.show(f.input);
    const events: string[] = [];
    f.provider.subscribe((event) => {
      events.push(event.type);
    });
    f.resolve({
      status: 'rewarded',
      requestId: 'invocation',
      reward: { amount: 999999, type: 'untrusted' },
    });
    await flush();
    await expect(f.provider.getAvailability(f.input)).resolves.toMatchObject({ reason: 'busy' });
    f.emit({ requestId: 'foreign', sequence: 100, state: 'closed' });
    await expect(f.provider.getAvailability(f.input)).resolves.toMatchObject({ reason: 'busy' });
    f.emit({ requestId: 'invocation', sequence: 1, state: 'closed' });
    await expect(pending).resolves.toMatchObject({ outcome: 'shown', presentation: 'closed', eligibility: 'eligible', evidence: { schema: 'verse8.ads.reward.v1', payload: { requestId: 'invocation', placementId: 'native-placement' } } });
    expect(f.show).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'invocation', timeoutMs: 30 }),
    );
    expect(events).toContain('closed');
    expect(f.callbacks.size).toBe(0);
  });
  it('retains host observation after caller/SDK timeout and quarantines a recreated gateway', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.provider.show(f.input);
    f.emit({ requestId: 'invocation', sequence: 2, state: 'open' });
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown', eligibility: 'unknown', claimEvidence: { payload: { requestId: 'invocation' } } });
    expect(f.callbacks.size).toBe(1);
    await expect(f.create().ads.provider?.getAvailability(f.input)).resolves.toMatchObject({ reason: 'action-required' });
    f.resolve({ status: 'failed', requestId: 'invocation', error: { code: 'timeout' } });
    await flush();
    f.emit({ requestId: 'invocation', sequence: 1, state: 'closed' });
    await expect(f.provider.getAvailability(f.input)).resolves.toMatchObject({ reason: 'action-required' });
    f.emit({ requestId: 'invocation', sequence: 3, state: 'closed' });
    await expect(f.provider.getAvailability(f.input)).resolves.toEqual({ state: 'available' });
    expect(f.callbacks.size).toBe(0);
    expect(f.show).toHaveBeenCalledOnce();
  });
  it('accepts late eligible evidence after a separately confirmed close, without reopening the SDK', async () => {
    const f = fixture();
    const observed: string[] = [];
    f.provider.subscribe((event) => {
      observed.push(event.type);
    });
    const pending = f.provider.show(f.input);
    f.emit({ requestId: 'invocation', sequence: 1, state: 'closed' });
    await expect(pending).resolves.toMatchObject({ presentation: 'closed', eligibility: 'unknown' });
    f.resolve({ status: 'rewarded', requestId: 'invocation' });
    await flush();
    expect(observed).toEqual(['requested', 'closed', 'reward-earned']);
    expect(f.show).toHaveBeenCalledOnce();
    expect(f.callbacks.size).toBe(0);
  });
  it('rejects a reward for another SDK request while retaining the original close observer', async () => {
    const f = fixture();
    const events: string[] = [];
    f.provider.subscribe((event) => {
      events.push(event.type);
    });
    const pending = f.provider.show(f.input);
    f.resolve({ status: 'rewarded', requestId: 'foreign' });
    await expect(pending).resolves.toMatchObject({ outcome: 'pending', presentation: 'unknown', eligibility: 'unknown' });
    expect(events).not.toContain('reward-earned');
    f.emit({ requestId: 'invocation', sequence: 1, state: 'closed' });
    expect(f.callbacks.size).toBe(0);
  });
});

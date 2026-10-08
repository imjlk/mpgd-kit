import { describe, expect, it, vi } from 'vitest';

import {
  adProtocol,
  adProtocolVersion,
  assertAdAvailability,
  assertAdPreparationResult,
  assertAdPresentationEvent,
  assertAdShowInput,
  assertAdShowResult,
  createAdSession,
  reduceAdSession,
  toAdAdapter,
  type AdPresentationEvent,
  type AdProvider,
  type AdShowInput,
  type AdShowResult,
} from './ads.js';

const evidence = { schema: 'fixture.reward.v1', payload: { impressionId: 'impression-a' } };
function event(type: AdPresentationEvent['type'], sequence: number): AdPresentationEvent {
  const base = { providerId: 'fixture-provider', invocationId: 'a', sequence };
  if (type === 'reward-earned') {
    return { ...base, type, evidence };
  }
  if (type === 'failed') {
    return { ...base, type, reason: 'transient-failure' };
  }
  return { ...base, type };
}
function result(overrides: Partial<AdShowResult> = {}): AdShowResult {
  return {
    providerId: 'fixture-provider',
    invocationId: 'a',
    format: 'rewarded',
    outcome: 'shown',
    presentation: 'closed',
    eligibility: 'eligible',
    evidence,
    ...overrides,
  };
}
function provider(show: (input: AdShowInput) => Promise<AdShowResult>): AdProvider {
  return {
    id: 'fixture-provider',
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'immediate',
    async getAvailability() {
      return { state: 'available' };
    },
    async preload() {
      return { status: 'deferred' };
    },
    show,
    subscribe() {
      return () => {};
    },
  };
}

describe('advertising session contract', () => {
  it('keeps earning evidence independent of native closure and any ledger grant', () => {
    const initial = createAdSession({ providerId: 'fixture-provider', invocationId: 'a', format: 'rewarded' });
    const started = reduceAdSession(initial, event('started', 1));
    const earned = reduceAdSession(started, event('reward-earned', 2));
    expect(earned).toMatchObject({ presentation: 'open', eligibility: 'eligible', terminal: false });
    expect(earned).not.toHaveProperty('ledgerEntryId');
    const closed = reduceAdSession(earned, event('closed', 3));
    expect(closed).toMatchObject({ presentation: 'closed', eligibility: 'eligible', terminal: true });
    expect(initial).toMatchObject({ presentation: 'not-started', eligibility: 'unknown', sequence: 0 });
    expect(Object.isFrozen(closed)).toBe(true);
  });

  it('accepts late native closure after caller waiting ends without fabricating a grant', () => {
    let state = createAdSession({ providerId: 'fixture-provider', invocationId: 'a', format: 'rewarded' });
    state = reduceAdSession(state, event('started', 1));
    state = reduceAdSession(state, event('unknown', 2));
    expect(state).toMatchObject({ presentation: 'unknown', reason: 'outcome-unknown', terminal: false });
    state = reduceAdSession(state, event('closed', 3));
    expect(state).toMatchObject({ presentation: 'closed', eligibility: 'not-earned' });
    expect(state).not.toHaveProperty('reason');
  });

  it('isolates invocation identity, duplicate callbacks and signals after terminal failure', () => {
    const initial = createAdSession({ providerId: 'fixture-provider', invocationId: 'a', format: 'rewarded' });
    expect(reduceAdSession(initial, { ...event('started', 1), invocationId: 'b' })).toBe(initial);
    expect(reduceAdSession(initial, { ...event('started', 1), providerId: 'other' })).toBe(initial);
    const started = reduceAdSession(initial, event('started', 2));
    expect(reduceAdSession(started, event('closed', 1))).toBe(started);
    expect(reduceAdSession(started, event('started', 2))).toBe(started);
    const failed = reduceAdSession(started, event('failed', 3));
    expect(reduceAdSession(failed, event('started', 4))).toBe(failed);
    expect(reduceAdSession(failed, event('reward-earned', 5))).toBe(failed);
  });

  it('requires declared delayed rewards to change eligibility after a non-rewarded close', () => {
    const immediate = reduceAdSession(createAdSession({
      providerId: 'fixture-provider', invocationId: 'a', format: 'rewarded',
    }), event('closed', 1));
    expect(immediate.eligibility).toBe('not-earned');
    expect(reduceAdSession(immediate, event('reward-earned', 2))).toBe(immediate);
    const delayed = reduceAdSession(createAdSession({
      providerId: 'fixture-provider', invocationId: 'a', format: 'rewarded', rewardSignal: 'delayed',
    }), event('closed', 1));
    expect(delayed.eligibility).toBe('unknown');
    const earned = reduceAdSession(delayed, event('reward-earned', 2));
    expect(earned).toMatchObject({ presentation: 'closed', eligibility: 'eligible' });
    expect(reduceAdSession(earned, event('started', 3))).toBe(earned);
  });

  it('ignores reward callbacks for interstitials', () => {
    const state = createAdSession({ providerId: 'fixture-provider', invocationId: 'a', format: 'interstitial' });
    expect(reduceAdSession(state, event('reward-earned', 1))).toBe(state);
  });

  it('rejects malformed identifiers, sequences and evidence before applying an event', () => {
    expect(() => createAdSession({ providerId: ' ', invocationId: 'a', format: 'rewarded' })).toThrow();
    expect(() => assertAdShowInput({ format: 'rewarded', placementId: 'p', invocationId: 'a', idempotencyKey: '' })).toThrow();
    expect(() => assertAdAvailability({ state: 'ready' })).toThrow();
    expect(() => assertAdPreparationResult({ status: 'completed' })).toThrow();
    expect(() => assertAdAvailability({ state: 'available', reason: 'busy' })).toThrow();
    expect(() => assertAdPreparationResult({ status: 'ready', reason: 'no-fill' })).toThrow();
    expect(() => assertAdPresentationEvent({ ...event('started', 1), sequence: NaN })).toThrow();
    expect(() => assertAdPresentationEvent({ ...event('started', 1), sequence: 0 })).toThrow();
    expect(() => assertAdPresentationEvent({ ...event('reward-earned', 1), evidence: {
      schema: 'fixture.reward.v1', payload: { amount: Infinity },
    } })).toThrow();
    expect(() => assertAdPresentationEvent({ ...event('reward-earned', 1), evidence: {
      schema: 'fixture.reward.v1', payload: { nested: {} },
    } })).toThrow();
  });

  it.each([
    { outcome: 'shown', presentation: 'unknown', reason: 'outcome-unknown' },
    { outcome: 'pending', presentation: 'closed' },
    { outcome: 'skipped', eligibility: 'eligible' },
    { eligibility: 'eligible', evidence: undefined },
    { format: 'interstitial', eligibility: 'eligible' },
    { outcome: 'pending', presentation: 'unknown', reason: undefined },
  ])('rejects contradictory result dimensions %#', (change) => {
    expect(() => assertAdShowResult({ ...result(), ...change })).toThrow();
  });

  it('clones evidence so a later caller mutation cannot change persisted identity', () => {
    const payload = { impressionId: 'original' };
    const validated = assertAdShowResult(result({ evidence: { schema: evidence.schema, payload } }));
    payload.impressionId = 'replacement';
    expect(validated.evidence?.payload.impressionId).toBe('original');
    expect(Object.isFrozen(validated.evidence?.payload)).toBe(true);
  });
});

describe('legacy advertising compatibility', () => {
  it('forwards eligibility as an ungranted claim candidate', async () => {
    const show = vi.fn(async (input: AdShowInput) => result({ invocationId: input.invocationId }));
    const gateway = toAdAdapter(provider(show));
    expect(await gateway.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'a' })).toEqual({
      status: 'completed',
      rewardGranted: false,
      evidence,
    });
    expect(show).toHaveBeenCalledWith({
      placementId: 'CONTINUE',
      idempotencyKey: 'a',
      invocationId: 'a',
      format: 'rewarded',
    });
  });

  it('keeps unknown presentation pending even with earned evidence', async () => {
    const gateway = toAdAdapter(
      provider(async () =>
        result({
          outcome: 'pending',
          presentation: 'unknown',
          reason: 'outcome-unknown',
        }),
      ),
    );
    expect(await gateway.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'a' })).toMatchObject(
      {
        status: 'pending',
        rewardGranted: false,
      },
    );
  });

  it('rejects a provider result for another invocation', async () => {
    const gateway = toAdAdapter(provider(async () => result({ invocationId: 'other' })));
    await expect(gateway.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'a' })).rejects.toThrow('invocation');
  });

  it('refuses a provider for another protocol version', () => {
    const implementation = provider(async () => result());
    expect(() => toAdAdapter({ ...implementation, protocolVersion: 'wrong' } as unknown as AdProvider)).toThrow(
      'protocol',
    );
  });

  it('allocates distinct interstitial identities across compatibility facades', async () => {
    const calls: string[] = [];
    const implementation = provider(async (input) => {
      calls.push(input.invocationId);
      return {
        providerId: 'fixture-provider',
        invocationId: input.invocationId,
        format: 'interstitial',
        outcome: 'shown',
        presentation: 'closed',
        eligibility: 'not-applicable',
      };
    });
    const first = toAdAdapter(implementation);
    const second = toAdAdapter(implementation);
    await first.showInterstitial?.({ placementId: 'END' });
    await second.showInterstitial?.({ placementId: 'END' });
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';

import { createResidencyPolicy, type ResidencyPolicy } from '../src/residency-policy.js';

const MiB = 1024 * 1024;
const TEXTURE_2048 = 2048 * 2048 * 4; // 16 MiB decoded RGBA

function loadAll(policy: ResidencyPolicy, owner: string, ids: readonly string[], bytes = TEXTURE_2048): readonly string[] {
  const plan = policy.claim(owner, ids);
  const evicted = [...plan.evict];
  for (const id of plan.load) {
    evicted.push(...policy.loaded(id, bytes));
  }
  return evicted;
}

describe('residency policy', () => {
  it('loads only missing groups and counts owners', () => {
    const policy = createResidencyPolicy({ budgetBytes: 64 * MiB });
    expect(policy.claim('menu', ['a', 'b']).load).toEqual(['a', 'b']);
    policy.loaded('a', TEXTURE_2048);
    policy.loaded('b', TEXTURE_2048);
    expect(policy.claim('level', ['a', 'b', 'c']).load).toEqual(['c']);
    expect([...policy.owners('a')].sort()).toEqual(['level', 'menu']);
    policy.release('menu');
    expect(policy.owners('a')).toEqual(['level']);
    expect(policy.state('a')).toBe('resident');
    expect(policy.state('c')).toBe('loading');
  });

  it("replaces an owner's previous claim and ignores duplicate ids", () => {
    const policy = createResidencyPolicy({ budgetBytes: 64 * MiB });
    loadAll(policy, 'screen', ['a']);
    expect(policy.claim('screen', ['b', 'b']).load).toEqual(['b']);
    expect(policy.owners('a')).toEqual([]);
    expect(policy.owners('b')).toEqual(['screen']);
    policy.claim('screen', []);
    expect(policy.owners('b')).toEqual([]);
  });

  it('keeps released groups warm until the budget is exceeded, then evicts least recently used first', () => {
    const policy = createResidencyPolicy({ budgetBytes: 48 * MiB, estimateBytes: () => TEXTURE_2048 });
    loadAll(policy, 'screen', ['a1', 'a2', 'a3']);
    policy.release('screen');
    expect(policy.snapshot().totalBytes).toBe(48 * MiB);
    policy.touch('a1');
    const plan = policy.claim('screen', ['b1']);
    expect(plan.evict).toEqual(['a2']);
    expect(policy.state('a2')).toBeUndefined();
    expect(policy.state('a1')).toBe('resident');
  });

  it('makes room from the estimate before loading, so repeated swaps peak at the budget', () => {
    const budget = 64 * MiB;
    const policy = createResidencyPolicy({ budgetBytes: budget, estimateBytes: () => TEXTURE_2048 });
    let peak = 0;
    const track = (): void => {
      peak = Math.max(peak, policy.snapshot().totalBytes);
    };
    for (const set of ['one', 'two', 'three', 'four', 'one']) {
      const ids = ['x', 'y', 'z'].map((part) => `${set}-${part}`);
      const plan = policy.claim('screen', ids);
      track();
      for (const id of plan.load) {
        policy.loaded(id, set === 'three' && id.endsWith('x') ? 2 * TEXTURE_2048 : TEXTURE_2048);
        track();
      }
      policy.release('screen');
    }
    expect(peak).toBeLessThanOrEqual(budget);
    // without make-room-first, old (48 MiB) + new (48 MiB) would be resident together
    expect(policy.snapshot().groups.filter((group) => group.id.startsWith('one-'))).toHaveLength(3);
  });

  it('never evicts owned or loading groups, even over budget', () => {
    const policy = createResidencyPolicy({ budgetBytes: 32 * MiB, estimateBytes: () => TEXTURE_2048 });
    loadAll(policy, 'screen', ['a', 'b', 'c']);
    expect(policy.snapshot().ownedBytes).toBe(48 * MiB);
    expect(policy.claim('next', ['d']).evict).toEqual([]);
    policy.release('screen');
    // a/b/c are unowned now; d is still loading and must survive
    expect(policy.loaded('d', TEXTURE_2048)).toEqual(['a', 'b']);
    expect(policy.state('d')).toBe('resident');
    expect(policy.snapshot().totalBytes).toBe(32 * MiB);
  });

  it('prefetches only into free budget and never evicts', () => {
    const policy = createResidencyPolicy({ budgetBytes: 48 * MiB, estimateBytes: () => TEXTURE_2048 });
    loadAll(policy, 'screen', ['a', 'b']);
    expect(policy.prefetch(['a', 'c', 'c', 'd'])).toEqual(['c']);
    expect(policy.state('c')).toBe('loading');
    expect(policy.owners('c')).toEqual([]);
    policy.loaded('c', TEXTURE_2048);
    expect(policy.prefetch(['d'])).toEqual([]);
    expect(policy.snapshot().groups.map((group) => group.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops an unclaimed prefetch that measures over its estimate instead of evicting warm groups', () => {
    const policy = createResidencyPolicy({ budgetBytes: 100 });
    loadAll(policy, 'screen', ['warm'], 80);
    policy.release('screen');
    expect(policy.prefetch(['speculative'])).toEqual(['speculative']); // estimate 0 fits
    expect(policy.loaded('speculative', 80)).toEqual(['speculative']);
    expect(policy.state('speculative')).toBeUndefined();
    expect(policy.state('warm')).toBe('resident');
    // a prefetch that fits after measuring is kept
    expect(policy.prefetch(['small'])).toEqual(['small']);
    expect(policy.loaded('small', 20)).toEqual([]);
    expect(policy.state('small')).toBe('resident');
  });

  it('a prefetch claimed before it finishes loads as demanded and may evict warm groups', () => {
    const policy = createResidencyPolicy({ budgetBytes: 100 });
    loadAll(policy, 'screen', ['warm'], 80);
    policy.release('screen');
    policy.prefetch(['next']);
    policy.claim('screen', ['next']);
    expect(policy.loaded('next', 80)).toEqual(['warm']);
    expect(policy.state('next')).toBe('resident');
  });

  it('a prefetched group becomes owned when claimed and is not loaded twice', () => {
    const policy = createResidencyPolicy({ budgetBytes: 48 * MiB, estimateBytes: () => TEXTURE_2048 });
    expect(policy.prefetch(['a'])).toEqual(['a']);
    expect(policy.claim('screen', ['a']).load).toEqual([]);
    expect(policy.owners('a')).toEqual(['screen']);
  });

  it('forgets failed loads, and resize / setBudget trim', () => {
    const policy = createResidencyPolicy({ budgetBytes: 40 * MiB });
    policy.claim('screen', ['a']);
    policy.failed('a');
    expect(policy.state('a')).toBeUndefined();
    loadAll(policy, 'screen', ['a', 'b']);
    policy.failed('a'); // resident groups are not forgotten by failed()
    expect(policy.state('a')).toBe('resident');
    policy.release('screen');
    policy.touch('b');
    expect(policy.resize('b', 30 * MiB)).toEqual(['a']);
    expect(policy.resize('missing', 1)).toEqual([]);
    expect(policy.setBudget(16 * MiB)).toEqual(['b']);
    expect(policy.snapshot()).toMatchObject({ budgetBytes: 16 * MiB, totalBytes: 0, groups: [] });
  });

  it('forget drops a group regardless of state', () => {
    const policy = createResidencyPolicy({ budgetBytes: 64 * MiB });
    loadAll(policy, 'screen', ['a']);
    policy.forget('a');
    expect(policy.state('a')).toBeUndefined();
    expect(policy.claim('screen', ['a']).load).toEqual(['a']);
  });

  it('rejects invalid byte counts', () => {
    expect(() => createResidencyPolicy({ budgetBytes: -1 })).toThrow(RangeError);
    expect(() => createResidencyPolicy({ budgetBytes: 1.5 })).toThrow(RangeError);
    const policy = createResidencyPolicy({ budgetBytes: 10, estimateBytes: () => Number.NaN });
    expect(() => policy.claim('screen', ['a'])).toThrow(RangeError);
    const ok = createResidencyPolicy({ budgetBytes: 10 });
    ok.claim('screen', ['a']);
    expect(() => ok.loaded('a', -5)).toThrow(RangeError);
  });

  it('reports owned and total bytes and a recency order in snapshots', () => {
    const policy = createResidencyPolicy({ budgetBytes: 64 * MiB, estimateBytes: () => 1 * MiB });
    loadAll(policy, 'screen', ['a'], 2 * MiB);
    policy.claim('other', ['b']);
    const snapshot = policy.snapshot();
    expect(snapshot.ownedBytes).toBe(3 * MiB);
    expect(snapshot.totalBytes).toBe(3 * MiB);
    const [a, b] = snapshot.groups;
    expect(a?.state).toBe('resident');
    expect(b?.state).toBe('loading');
    expect((b?.lastUsed ?? 0) > (a?.lastUsed ?? 0)).toBe(true);
  });
});

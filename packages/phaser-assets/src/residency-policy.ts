/**
 * Engine-free residency policy: which asset groups stay resident under a byte budget.
 *
 * Owners claim the groups they draw. Owned groups are never evicted, even when what is owned exceeds the budget.
 * Released groups stay resident (unowned) until room is needed; then the least recently used go first. Room is made
 * before a load starts, using the group's estimate, so swapping one set for another peaks at the budget instead of
 * at old + new. Prefetch only fills free budget and never evicts.
 *
 * The policy only decides. Callers perform loads and evictions and report results back
 * (`loaded`, `failed`, `resize`).
 */

export type ResidencyGroupState = 'loading' | 'resident';

export interface ResidencyPolicyOptions {
  /** Retention cap in bytes (for textures, usually the width x height x 4 decoded RGBA estimate). */
  readonly budgetBytes: number;
  /** Bytes a group is expected to take before it has loaded. Used to make room before a load. Default: 0. */
  readonly estimateBytes?: (groupId: string) => number;
}

export interface ResidencyPlan {
  /** Groups the caller should start loading now. */
  readonly load: readonly string[];
  /** Resident, unowned groups the caller should unload now (before starting `load`). */
  readonly evict: readonly string[];
}

export interface ResidencyGroupSnapshot {
  readonly id: string;
  readonly state: ResidencyGroupState;
  readonly owners: readonly string[];
  readonly bytes: number;
  /** Monotonic use counter; a higher value means more recently used. */
  readonly lastUsed: number;
}

export interface ResidencyPolicySnapshot {
  readonly budgetBytes: number;
  /** Resident bytes plus estimates of groups still loading. */
  readonly totalBytes: number;
  /** Bytes of groups with at least one owner. These may exceed the budget. */
  readonly ownedBytes: number;
  readonly groups: readonly ResidencyGroupSnapshot[];
}

export interface ResidencyPolicy {
  /** `owner` now needs exactly `groupIds`, replacing its previous claim. Returns what to load and what to evict first. */
  claim(owner: string, groupIds: readonly string[]): ResidencyPlan;
  /** Drop every claim of `owner`. Nothing is evicted until room is needed. */
  release(owner: string): void;
  /** Speculative loads: returns the unknown groups that fit in the free budget, in order. Never evicts others. */
  prefetch(groupIds: readonly string[]): readonly string[];
  /**
   * A load finished. Records the real size and returns groups to evict. An unclaimed prefetch that no longer fits
   * returns only itself, so speculative loads never displace warm groups.
   */
  loaded(groupId: string, bytes: number): readonly string[];
  /** A load failed. Forgets the group; its claims are dropped with it. */
  failed(groupId: string): void;
  /** A resident group's size changed (e.g. a runtime texture was attached). Returns groups to evict. */
  resize(groupId: string, bytes: number): readonly string[];
  /**
   * Several resident groups were re-measured at once. Applies every size before trimming, so one group growing while
   * another shrinks does not evict against a stale total. Validates all sizes first. Returns groups to evict.
   */
  resizeAll(sizes: ReadonlyMap<string, number>): readonly string[];
  /** Mark a group as just used. */
  touch(groupId: string): void;
  /** Change the budget. Returns groups to evict. */
  setBudget(bytes: number): readonly string[];
  /** Forget a group that was unloaded outside the policy. */
  forget(groupId: string): void;
  /**
   * A resident group's assets went missing outside the policy: mark it loading again, keeping its owners and using its
   * last size as the estimate. Returns false when the group is not resident. The caller reloads it.
   */
  invalidate(groupId: string): boolean;
  state(groupId: string): ResidencyGroupState | undefined;
  owners(groupId: string): readonly string[];
  snapshot(): ResidencyPolicySnapshot;
}

interface Entry {
  bytes: number;
  readonly owners: Set<string>;
  used: number;
  state: ResidencyGroupState;
  /** Admitted by `prefetch` and not claimed since; discarded instead of evicting others if it measures too large. */
  speculative: boolean;
}

export function createResidencyPolicy(options: ResidencyPolicyOptions): ResidencyPolicy {
  let budget = checkBytes(options.budgetBytes, 'budgetBytes');
  const estimate = (id: string): number => checkBytes(
    options.estimateBytes?.(id) ?? 0,
    `estimateBytes(${id})`,
  );
  const entries = new Map<string, Entry>();
  let clock = 0;

  const total = (): number => {
    let sum = 0;
    for (const entry of entries.values()) {
      sum += entry.bytes;
    }
    return sum;
  };

  const trim = (): readonly string[] => {
    let sum = total();
    if (sum <= budget) {
      return [];
    }
    const victims = [...entries]
      .filter(([, entry]) => entry.owners.size === 0 && entry.state === 'resident')
      .sort((a, b) => a[1].used - b[1].used);
    const evicted: string[] = [];
    for (const [id, entry] of victims) {
      if (sum <= budget) {
        break;
      }
      entries.delete(id);
      sum -= entry.bytes;
      evicted.push(id);
    }
    return evicted;
  };

  return {
    claim(owner, groupIds) {
      const wanted = new Set(groupIds);
      // Validate every estimate before mutating, so a throwing estimate leaves the policy unchanged.
      const incoming = new Map<string, number>();
      for (const id of wanted) {
        if (!entries.has(id)) {
          incoming.set(id, estimate(id));
        }
      }
      for (const [id, entry] of entries) {
        if (!wanted.has(id)) {
          entry.owners.delete(owner);
        }
      }
      const load: string[] = [];
      for (const id of wanted) {
        let entry = entries.get(id);
        if (!entry) {
          entry = { bytes: incoming.get(id) ?? 0, owners: new Set(), used: 0, state: 'loading', speculative: false };
          entries.set(id, entry);
          load.push(id);
        }
        entry.owners.add(owner);
        entry.speculative = false;
        entry.used = ++clock;
      }
      return { load, evict: trim() };
    },
    release(owner) {
      for (const entry of entries.values()) {
        entry.owners.delete(owner);
      }
    },
    prefetch(groupIds) {
      const load: string[] = [];
      let sum = total();
      const candidates = [...new Set(groupIds)]
        .filter((id) => !entries.has(id))
        .map((id) => ({ id, bytes: estimate(id) }));
      for (const { id, bytes } of candidates) {
        if (sum + bytes > budget) {
          continue;
        }
        sum += bytes;
        entries.set(id, { bytes, owners: new Set(), used: ++clock, state: 'loading', speculative: true });
        load.push(id);
      }
      return load;
    },
    loaded(groupId, bytes) {
      const entry = entries.get(groupId);
      if (!entry) {
        return [];
      }
      const measured = checkBytes(bytes, `loaded(${groupId})`);
      const speculative = entry.speculative && entry.owners.size === 0;
      entry.state = 'resident';
      entry.speculative = false;
      entry.bytes = measured;
      if (speculative && total() > budget) {
        // A prefetch that measured larger than its estimate must not displace warm groups: drop it instead.
        entries.delete(groupId);
        return [groupId];
      }
      return trim();
    },
    failed(groupId) {
      if (entries.get(groupId)?.state === 'loading') {
        entries.delete(groupId);
      }
    },
    resizeAll(sizes) {
      const next = [...sizes].map(([id, bytes]) => [id, checkBytes(bytes, `resize(${id})`)] as const);
      for (const [id, bytes] of next) {
        const entry = entries.get(id);
        if (entry) {
          entry.bytes = bytes;
        }
      }
      return trim();
    },
    resize(groupId, bytes) {
      const entry = entries.get(groupId);
      const next = checkBytes(bytes, `resize(${groupId})`);
      if (!entry || entry.bytes === next) {
        return [];
      }
      entry.bytes = next;
      return trim();
    },
    touch(groupId) {
      const entry = entries.get(groupId);
      if (entry) {
        entry.used = ++clock;
      }
    },
    setBudget(bytes) {
      budget = checkBytes(bytes, 'budgetBytes');
      return trim();
    },
    invalidate(groupId) {
      const entry = entries.get(groupId);
      if (entry?.state !== 'resident') {
        return false;
      }
      entry.state = 'loading';
      entry.speculative = false;
      return true;
    },
    forget(groupId) {
      entries.delete(groupId);
    },
    state: (groupId) => entries.get(groupId)?.state,
    owners: (groupId) => [...(entries.get(groupId)?.owners ?? [])],
    snapshot() {
      let ownedBytes = 0;
      const groups: ResidencyGroupSnapshot[] = [];
      for (const [id, entry] of entries) {
        if (entry.owners.size) {
          ownedBytes += entry.bytes;
        }
        groups.push({
          id,
          state: entry.state,
          owners: [...entry.owners],
          bytes: entry.bytes,
          lastUsed: entry.used,
        });
      }
      return { budgetBytes: budget, totalBytes: total(), ownedBytes, groups };
    },
  };
}

function checkBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid residency byte count for ${label}: ${String(value)}`);
  }
  return value;
}

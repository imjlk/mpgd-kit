import type { StorageAdapter } from './index.js';
import type { ReviewOutcome, ReviewProvider } from './reviews-contract.js';

export interface ReviewPolicy {
  readonly minimumVisits: number;
  readonly minimumCompletedPlays: number;
  readonly cooldownMs: number;
}
export type ReviewObservation = 'request' | 'requested' | 'failed' | 'storage-unavailable';
interface ReviewState {
  version: 1;
  visits: number;
  plays: number;
  lastRequestAt: number | null;
}
const maximumCount = 1_000_000;
function parseState(value: unknown): ReviewState {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('visits' in value) || !('plays' in value) || !('lastRequestAt' in value)) {
    throw new Error('Invalid review state');
  }
  const { visits, plays, lastRequestAt } = value;
  if (typeof visits !== 'number' || !Number.isSafeInteger(visits) || visits < 0 || visits > maximumCount
    || typeof plays !== 'number' || !Number.isSafeInteger(plays) || plays < 0 || plays > maximumCount
    || lastRequestAt !== null && (typeof lastRequestAt !== 'number' || !Number.isSafeInteger(lastRequestAt) || lastRequestAt < 0)) {
    throw new Error('Invalid review state');
  }
  return { version: 1, visits, plays, lastRequestAt };
}
/**
 * One controller per game runtime. Persist cooldown BEFORE requesting UI. Storage failures suppress
 * automatic prompts, without blocking gameplay. No account ID, review status or rating is stored.
 * StorageAdapter is not a cross-tab CAS: hosts own additional quotas; this is device-local courtesy.
 */
export function createReviewController(input: {
  readonly provider: ReviewProvider;
  readonly storage: StorageAdapter;
  readonly scope: string;
  readonly policy: ReviewPolicy;
  readonly now?: () => number;
  readonly onObservation?: (event: ReviewObservation) => void;
}) {
  if (!/^[a-z0-9:._-]{1,160}$/.test(input.scope)) {
    throw new TypeError('Invalid review scope');
  }
  const { policy, provider, storage } = input;
  if (![policy.minimumVisits, policy.minimumCompletedPlays, policy.cooldownMs].every(
    (n) => Number.isSafeInteger(n) && n > 0,
  )) {
    throw new TypeError('Invalid review policy');
  }
  const enabledAtStart = provider.getCapabilities().nativePrompt;
  const now = input.now ?? Date.now;
  const key = `mpgd:reviews:v1:${input.scope}:${provider.getCapabilities().providerId}`;
  let disposed = false;
  let healthy = true;
  let requested = false;
  let state: ReviewState = { version: 1, visits: 0, plays: 0, lastRequestAt: null };
  const completed = new Set<string>();
  const observe = (event: ReviewObservation) => {
    try {
      input.onObservation?.(event);
    } catch { /* Diagnostics cannot block play. */ }
  };
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const work = queue.then(action);
    queue = work.then(() => {}, () => {});
    return work;
  };
  const save = async () => {
    try {
      await storage.save({ key, value: { ...state } });
      return true;
    } catch {
      healthy = false;
      observe('storage-unavailable');
      return false;
    }
  };
  // Do not read/write anything on unsupported hosts (including Reddit inline).
  const ready = enabledAtStart
    ? enqueue(async () => {
        try {
          const saved = await storage.load({ key });
          if (disposed) {
            return;
          }
          if (saved !== null) {
            state = parseState(saved.value);
          }
          state.visits = Math.min(maximumCount, state.visits + 1);
          await save();
        } catch {
          healthy = false;
          observe('storage-unavailable');
        }
      })
    : Promise.resolve();
  return {
    ready,
    completedPlay(attemptId: string): Promise<void> {
      if (disposed || !enabledAtStart || !provider.getCapabilities().nativePrompt || !attemptId || attemptId.length > 128 || completed.has(attemptId)) { return Promise.resolve(); }
      // A bounded lifetime set prevents duplicate result renders and retry calls from counting twice.
      if (completed.size >= 10_000) { return Promise.resolve(); }
      completed.add(attemptId);
      return enqueue(async () => {
        if (disposed || !healthy) { return; }
        state.plays = Math.min(maximumCount, state.plays + 1);
        await save();
      });
    },
    /** Call after result/menu commit, with a fresh safety predicate checked after every await. */
    async consider(isSafe: () => boolean): Promise<ReviewOutcome | { readonly status: 'skipped' }> {
      const reserved = await enqueue(async () => {
        if (disposed || !enabledAtStart || !healthy || requested || !provider.getCapabilities().nativePrompt || !isSafe()
          || state.visits < policy.minimumVisits || state.plays < policy.minimumCompletedPlays) { return false; }
        const at = now();
        if (!Number.isSafeInteger(at) || at < 0 || state.lastRequestAt !== null && at - state.lastRequestAt < policy.cooldownMs) {
          return false;
        }
        requested = true;
        state.lastRequestAt = at;
        return await save();
      });
      if (!reserved || disposed || !isSafe()) { return { status: 'skipped' }; }
      observe('request');
      // Host UI promises may remain pending: keep them outside the persistence queue.
      try {
        const outcome = await provider.requestNative();
        if (outcome.status === 'requested') { observe('requested'); } else if (outcome.status === 'failed') { observe('failed'); }
        return outcome;
      } catch {
        observe('failed');
        return { status: 'failed' };
      }
    },
    dispose() { disposed = true; },
  };
}

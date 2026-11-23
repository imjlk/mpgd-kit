import type { PlatformGateway, StorageAdapter } from './index.js';
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
const scopePattern = /^[a-z0-9:._-]{1,160}$/;
function isReviewPolicy(policy: ReviewPolicy): boolean {
  return [policy.minimumVisits, policy.minimumCompletedPlays, policy.cooldownMs].every(
    (n) => Number.isSafeInteger(n) && n > 0,
  );
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
  if (!scopePattern.test(input.scope)) {
    throw new TypeError('Invalid review scope');
  }
  const { policy, provider, storage } = input;
  if (!isReviewPolicy(policy)) {
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

/**
 * Names for a game's own analytics allowlist, one per {@link ReviewObservation}. They describe the
 * request only: no host reports whether a prompt appeared or a review was written.
 */
export type ReviewAnalyticsEvent =
  | 'review_request'
  | 'review_request_resolved'
  | 'review_request_failed'
  | 'review_storage_unavailable';
export const reviewAnalyticsEvents = Object.freeze({
  request: 'review_request',
  requested: 'review_request_resolved',
  failed: 'review_request_failed',
  'storage-unavailable': 'review_storage_unavailable',
} as const satisfies Record<ReviewObservation, ReviewAnalyticsEvent>);

/**
 * A starting policy: one visit, two completed plays and fourteen days between requests. These are
 * product choices, not host quotas: the host still decides whether a prompt appears. Spread it to
 * change one value.
 */
export const defaultReviewPolicy: ReviewPolicy = Object.freeze({
  minimumVisits: 1,
  minimumCompletedPlays: 2,
  cooldownMs: 14 * 24 * 60 * 60 * 1000,
});

/**
 * The part of a review controller that {@link createReviewMoments} drives. `createReviewSession`
 * returns a controller; tests may pass their own.
 */
export interface ReviewSession {
  completedPlay(momentId: string): Promise<unknown>;
  consider(isSafe: () => boolean): Promise<unknown>;
  dispose(): void;
}

const gameIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * One review session per game runtime, or `undefined` where the gateway offers no native review
 * prompt: web, Reddit, a host without a provider, or a target whose `integrations.reviews` is not
 * `available`. Compose the provider at the target bootstrap with `withReviewProvider`; game code
 * never imports a review SDK. State is kept in the gateway storage under
 * `mpgd:reviews:v1:<gameId>:<target>:<providerId>`.
 *
 * `gameId` and `policy` are checked on every target, so a mistake shows on the first web run rather
 * than only where a provider exists. A provider whose capability read throws offers no session.
 */
export function createReviewSession(input: {
  readonly gateway: Pick<PlatformGateway, 'target' | 'storage' | 'reviews'>;
  /** Lowercase game ID such as `my-game`: letters, digits, `.`, `_` and `-`, at most 64. */
  readonly gameId: string;
  /** Defaults to {@link defaultReviewPolicy}. */
  readonly policy?: ReviewPolicy;
  readonly now?: () => number;
  /** Receives {@link reviewAnalyticsEvents} names. A throwing handler cannot block play. */
  readonly onEvent?: (event: ReviewAnalyticsEvent) => void;
}): ReviewSession | undefined {
  const { gameId, gateway, now, onEvent } = input;
  if (typeof gameId !== 'string' || !gameIdPattern.test(gameId)) {
    throw new TypeError('Invalid review game ID');
  }
  const scope = `${gameId}:${gateway.target}`;
  if (!scopePattern.test(scope)) {
    throw new TypeError('Invalid review scope');
  }
  const policy = input.policy ?? defaultReviewPolicy;
  if (!isReviewPolicy(policy)) {
    throw new TypeError('Invalid review policy');
  }
  try {
    const provider = gateway.reviews;
    if (!provider?.getCapabilities().nativePrompt) {
      return undefined;
    }
    return createReviewController({
      provider,
      storage: gateway.storage,
      scope,
      policy,
      ...(now ? { now } : {}),
      ...(onEvent ? { onObservation: (event) => onEvent(reviewAnalyticsEvents[event]) } : {}),
    });
  } catch {
    // Inputs are checked above, so only the provider can throw here: play goes on without a prompt.
    return undefined;
  }
}

/** What a game reports to the review flow. */
export interface ReviewMoments {
  /**
   * A finished play, whatever its outcome, or a reward the backend already granted. Each ID counts
   * once, so a result rendered twice reuses its ID; pass a new ID of at most 128 characters per
   * moment. A runtime counts at most 10,000 moments. Never record only wins, high scores or good
   * ratings.
   */
  record(momentId: string): void;
  /**
   * The player reached a settled screen: a menu after a result, a sheet just closed, the app back in
   * the foreground. `isSafe` says whether that screen still shows with nothing over it (no play,
   * dialog, ad, purchase or hidden document); it is checked again after every wait, and a screen
   * found covered keeps its opportunity for the next settled screen. Without a new moment the call
   * does nothing. Do not await it in navigation: it can stay pending while the host shows its own UI.
   */
  settled(isSafe: () => boolean): Promise<void>;
  /** Ends the flow with the game runtime and disposes the session; later calls do nothing. */
  dispose(): void;
}

const maximumMomentIdLength = 128;
const maximumMoments = 10_000;
/**
 * Connects game moments to a review session. A moment opens one opportunity; the request waits for a
 * settled screen and the session's policy. An opportunity whose screen was covered stays open for
 * the next settled screen, and nothing polls. Without a session every call does nothing.
 */
export function createReviewMoments(session: ReviewSession | undefined): ReviewMoments {
  let disposed = false;
  let recorded = 0;
  let considered = 0;
  const seen = new Set<string>();
  let checking: Promise<void> | undefined;
  let latest: (() => boolean) | undefined;
  let persistence: Promise<unknown> = Promise.resolve();
  const check = (review: ReviewSession): Promise<void> => {
    const run = (async () => {
      while (!disposed && latest && recorded !== considered) {
        const isSafe = latest;
        latest = undefined;
        const candidate = recorded;
        try {
          await persistence;
          if (!disposed && isSafe()) {
            const previous = considered;
            considered = candidate;
            let covered = false;
            await review.consider(() => {
              const safe = !disposed && isSafe();
              if (!safe) {
                covered = true;
              }
              return safe;
            });
            // The session found the screen covered when it checked again, so it did not ask.
            if (covered && !disposed) {
              considered = previous;
            }
          }
          // A covered screen keeps its opportunity; a newer settled screen replaces an older one.
        } catch {
          // A failed recording or a throwing check drops this opportunity, never a later moment.
          considered = candidate;
        }
      }
      // A settled screen whose moments were all considered is not kept for a later moment.
      latest = undefined;
    })().finally(() => {
      checking = undefined;
      // A screen that settled while the loop was finishing is checked now, not at the next one.
      return !disposed && latest && recorded !== considered ? check(review) : undefined;
    });
    checking = run;
    return run;
  };
  return {
    record(momentId) {
      if (disposed || !session || typeof momentId !== 'string' || !momentId
        || momentId.length > maximumMomentIdLength || seen.has(momentId)
        || seen.size >= maximumMoments) {
        return;
      }
      seen.add(momentId);
      recorded += 1;
      // Each recording waits for the previous one; a failure does not block later recordings.
      persistence = persistence.catch(() => {}).then(() => session.completedPlay(momentId));
      // The settled-screen check handles a failed recording; nothing else waits on it.
      void persistence.catch(() => {});
    },
    settled(isSafe) {
      if (disposed || !session || recorded === considered) {
        return Promise.resolve();
      }
      latest = isSafe;
      return checking ?? check(session);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      latest = undefined;
      try {
        session?.dispose();
      } catch {
        // Game teardown continues even if a host adapter fails.
      }
    },
  };
}

let momentSequence = 0;
/**
 * A process-unique moment ID with a readable prefix, for moments without their own ID such as a goal
 * reward. A long prefix is shortened so the ID stays unique and within 128 characters.
 */
export function reviewMomentId(prefix: string): string {
  momentSequence += 1;
  const suffix = `${Date.now().toString(36)}-${momentSequence.toString(36)}`;
  return `${prefix.slice(0, maximumMomentIdLength - suffix.length - 1)}-${suffix}`;
}

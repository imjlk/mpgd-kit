import { describe, expect, it, vi } from 'vitest';

import type { PlatformGateway, StorageAdapter } from './index.js';
import { createReviewProvider, type ReviewProvider } from './reviews.js';
import {
  createReviewMoments,
  createReviewSession,
  defaultReviewPolicy,
  reviewAnalyticsEvents,
  reviewMomentId,
  type ReviewSession,
} from './reviews-runtime.js';

const dayMs = 86_400_000;

function memoryStorage() {
  const values = new Map<string, unknown>();
  const storage: StorageAdapter = {
    load: vi.fn(async ({ key }) => (values.has(key) ? { value: values.get(key) } : null)),
    save: vi.fn(async ({ key, value }) => {
      values.set(key, value);
    }),
  };
  return { storage, values };
}

function gateway(
  storage: StorageAdapter,
  request: () => Promise<void> = async () => {},
): Pick<PlatformGateway, 'target' | 'storage' | 'reviews'> {
  return {
    target: 'ait',
    storage,
    reviews: createReviewProvider({ providerId: 'apps-in-toss', requestNative: request }),
  };
}

function fakeSession() {
  return {
    completedPlay: vi.fn(async (_momentId: string) => {}),
    consider: vi.fn(async (_isSafe: () => boolean) => {}),
    dispose: vi.fn(),
  } satisfies ReviewSession;
}

describe('review sessions', () => {
  it('has no session where the gateway offers no native prompt', async () => {
    const { storage } = memoryStorage();
    const pageOnly = createReviewProvider({ providerId: 'future.store', openPage: async () => true });
    const notReady = createReviewProvider({
      providerId: 'apps-in-toss',
      isAvailable: () => false,
      requestNative: async () => {},
    });
    expect(createReviewSession({ gateway: { target: 'browser', storage }, gameId: 'demo' }))
      .toBeUndefined();
    expect(createReviewSession({
      gateway: { target: 'microsoft-store', storage, reviews: pageOnly },
      gameId: 'demo',
    })).toBeUndefined();
    expect(createReviewSession({ gateway: { target: 'ait', storage, reviews: notReady }, gameId: 'demo' }))
      .toBeUndefined();
    expect(storage.load).not.toHaveBeenCalled();
    const moments = createReviewMoments(undefined);
    moments.record('a');
    await expect(moments.settled(() => true)).resolves.toBeUndefined();
    expect(() => moments.dispose()).not.toThrow();
  });

  it('checks the game ID and policy on every target, not only where a provider exists', () => {
    const { storage } = memoryStorage();
    const web = { target: 'browser', storage } as const;
    for (const gameId of ['', 'My Game', 'a:b', '-demo', 'x'.repeat(65)]) {
      expect(() => createReviewSession({ gateway: web, gameId })).toThrow('Invalid review game ID');
    }
    expect(() => createReviewSession({
      gateway: web,
      gameId: 'demo',
      policy: { ...defaultReviewPolicy, cooldownMs: 0 },
    })).toThrow('Invalid review policy');
    expect(() => createReviewSession({
      gateway: gateway(storage),
      gameId: 'demo',
      policy: { ...defaultReviewPolicy, minimumCompletedPlays: 1.5 },
    })).toThrow('Invalid review policy');
    expect(createReviewSession({ gateway: web, gameId: 'my_game.v2' })).toBeUndefined();
    expect(storage.load).not.toHaveBeenCalled();
  });

  it('treats a provider whose capability read throws as no prompt', () => {
    const { storage } = memoryStorage();
    const failing: ReviewProvider = {
      getCapabilities: () => {
        throw new Error('host');
      },
      requestNative: async () => ({ status: 'requested' }),
      openPage: async () => ({ status: 'unavailable' }),
    };
    expect(createReviewSession({ gateway: { target: 'ait', storage, reviews: failing }, gameId: 'demo' }))
      .toBeUndefined();
    expect(storage.load).not.toHaveBeenCalled();
  });

  it('starts from one visit, two completed plays and fourteen days, and cannot be changed in place', () => {
    expect(defaultReviewPolicy).toEqual({
      minimumVisits: 1,
      minimumCompletedPlays: 2,
      cooldownMs: 14 * dayMs,
    });
    expect(Object.isFrozen(defaultReviewPolicy)).toBe(true);
    expect(reviewAnalyticsEvents).toEqual({
      request: 'review_request',
      requested: 'review_request_resolved',
      failed: 'review_request_failed',
      'storage-unavailable': 'review_storage_unavailable',
    });
    expect(Object.isFrozen(reviewAnalyticsEvents)).toBe(true);
  });

  it('asks on the first settled screen after two moments, then waits out the cooldown', async () => {
    const { storage, values } = memoryStorage();
    const request = vi.fn(async () => {});
    let now = Date.UTC(2026, 10, 9);
    const events: string[] = [];
    const session = createReviewSession({
      gateway: gateway(storage, request),
      gameId: 'demo',
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    const moments = createReviewMoments(session);
    moments.record('play-1');
    await moments.settled(() => true);
    expect(request).not.toHaveBeenCalled();
    moments.record('reward-1');
    await moments.settled(() => true);
    expect(request).toHaveBeenCalledOnce();
    expect(events).toEqual(['review_request', 'review_request_resolved']);
    expect([...values.keys()]).toEqual(['mpgd:reviews:v1:demo:ait:apps-in-toss']);
    moments.dispose();

    // A later launch inside the cooldown does not ask again; after it, one more moment does.
    now += defaultReviewPolicy.cooldownMs - 1;
    const next = createReviewMoments(createReviewSession({
      gateway: gateway(storage, request),
      gameId: 'demo',
      now: () => now,
    }));
    next.record('play-2');
    await next.settled(() => true);
    expect(request).toHaveBeenCalledOnce();
    next.dispose();
    now += 1;
    const later = createReviewMoments(createReviewSession({
      gateway: gateway(storage, request),
      gameId: 'demo',
      now: () => now,
    }));
    later.record('play-3');
    await later.settled(() => true);
    expect(request).toHaveBeenCalledTimes(2);
    later.dispose();
  });

  it('reports a failed request and unavailable storage by their analytics names', async () => {
    const policy = { minimumVisits: 1, minimumCompletedPlays: 1, cooldownMs: 1000 };
    const failed = memoryStorage();
    const failedEvents: string[] = [];
    const rejecting = createReviewMoments(createReviewSession({
      gateway: gateway(failed.storage, async () => {
        throw new Error('host');
      }),
      gameId: 'demo',
      policy,
      onEvent: (event) => failedEvents.push(event),
    }));
    rejecting.record('play-1');
    await rejecting.settled(() => true);
    expect(failedEvents).toEqual(['review_request', 'review_request_failed']);

    const broken = memoryStorage();
    vi.mocked(broken.storage.load).mockRejectedValue(new Error('disk'));
    const request = vi.fn(async () => {});
    const brokenEvents: string[] = [];
    const unavailable = createReviewMoments(createReviewSession({
      gateway: gateway(broken.storage, request),
      gameId: 'demo',
      policy,
      onEvent: (event) => brokenEvents.push(event),
    }));
    unavailable.record('play-1');
    await unavailable.settled(() => true);
    expect(brokenEvents).toEqual(['review_storage_unavailable']);
    expect(request).not.toHaveBeenCalled();

    // An analytics handler that throws does not hold back the request.
    const throwing = memoryStorage();
    const asked = vi.fn(async () => {});
    const moments = createReviewMoments(createReviewSession({
      gateway: gateway(throwing.storage, asked),
      gameId: 'demo',
      policy,
      onEvent: () => {
        throw new Error('analytics');
      },
    }));
    moments.record('play-1');
    await moments.settled(() => true);
    expect(asked).toHaveBeenCalledOnce();
  });

  it('keeps the opportunity when the screen was covered as the session checked it', async () => {
    const { storage, values } = memoryStorage();
    const request = vi.fn(async () => {});
    const moments = createReviewMoments(createReviewSession({
      gateway: gateway(storage, request),
      gameId: 'demo',
      policy: { minimumVisits: 1, minimumCompletedPlays: 1, cooldownMs: 1000 },
    }));
    moments.record('play-1');
    // Safe for the moment, covered by a dialog when the session checks again, then safe again.
    let checks = 0;
    await moments.settled(() => {
      checks += 1;
      return checks !== 2;
    });
    expect(checks).toBe(2);
    expect(request).not.toHaveBeenCalled();
    expect(values.get('mpgd:reviews:v1:demo:ait:apps-in-toss')).toMatchObject({ lastRequestAt: null });
    await moments.settled(() => true);
    expect(request).toHaveBeenCalledOnce();
    moments.dispose();
  });

  it('keeps recording moments while the host request never resolves', async () => {
    const { storage, values } = memoryStorage();
    const request = vi.fn(() => new Promise<void>(() => {}));
    const moments = createReviewMoments(createReviewSession({
      gateway: gateway(storage, request),
      gameId: 'demo',
      policy: { minimumVisits: 1, minimumCompletedPlays: 1, cooldownMs: 1000 },
    }));
    moments.record('play-1');
    void moments.settled(() => true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    moments.record('play-2');
    await vi.waitFor(() => expect(values.get('mpgd:reviews:v1:demo:ait:apps-in-toss'))
      .toMatchObject({ plays: 2 }));
    // Disposing while the host still holds the request ends the flow without waiting for it.
    moments.dispose();
    moments.record('play-3');
    await expect(moments.settled(() => true)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(values.get('mpgd:reviews:v1:demo:ait:apps-in-toss')).toMatchObject({ plays: 2 });
  });
});

describe('review moments', () => {
  it('counts a moment ID once and does nothing on a settled screen without a new moment', async () => {
    const session = fakeSession();
    const moments = createReviewMoments(session);
    await moments.settled(() => true);
    moments.record('same');
    moments.record('same');
    moments.record('');
    // The controller ignores an ID over 128 characters, so it opens no opportunity either.
    moments.record('x'.repeat(129));
    await moments.settled(() => true);
    await moments.settled(() => true);
    expect(session.completedPlay).toHaveBeenCalledOnce();
    expect(session.completedPlay).toHaveBeenCalledWith('same');
    expect(session.consider).toHaveBeenCalledOnce();
  });

  it('keeps the opportunity while the screen is covered and rechecks after the recording finishes', async () => {
    const session = fakeSession();
    let finish = () => {};
    session.completedPlay.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const moments = createReviewMoments(session);
    moments.record('m');
    let safe = true;
    const pending = moments.settled(() => safe);
    await vi.waitFor(() => expect(session.completedPlay).toHaveBeenCalledOnce());
    safe = false;
    finish();
    await pending;
    expect(session.consider).not.toHaveBeenCalled();
    safe = true;
    await moments.settled(() => safe);
    expect(session.consider).toHaveBeenCalledOnce();
  });

  it('checks a newer settled screen once when the older one was covered', async () => {
    const session = fakeSession();
    let finish = () => {};
    session.completedPlay.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const moments = createReviewMoments(session);
    moments.record('m');
    const older = vi.fn(() => false);
    let newerSafe = true;
    const newer = vi.fn(() => newerSafe);
    const first = moments.settled(older);
    const second = moments.settled(newer);
    const third = moments.settled(newer);
    await vi.waitFor(() => expect(session.completedPlay).toHaveBeenCalledOnce());
    finish();
    await Promise.all([first, second, third]);
    expect(older).toHaveBeenCalledOnce();
    expect(session.consider).toHaveBeenCalledOnce();
    // The session rechecks the same screen through the predicate it was given.
    const forwarded = session.consider.mock.calls[0]?.[0];
    expect(forwarded?.()).toBe(true);
    newerSafe = false;
    expect(forwarded?.()).toBe(false);
    newerSafe = true;
    moments.dispose();
    expect(forwarded?.()).toBe(false);
  });

  it('drops only the failed opportunity and survives a failing dispose', async () => {
    const session = fakeSession();
    session.completedPlay.mockRejectedValueOnce(new Error('storage'));
    session.dispose.mockImplementation(() => {
      throw new Error('host');
    });
    const moments = createReviewMoments(session);
    moments.record('bad');
    await moments.settled(() => true);
    expect(session.consider).not.toHaveBeenCalled();
    moments.record('good');
    await moments.settled(() => true);
    expect(session.consider).toHaveBeenCalledOnce();
    // A safety check that throws drops its own opportunity too, never a later one.
    moments.record('thrown');
    await moments.settled(() => {
      throw new Error('scene');
    });
    expect(session.consider).toHaveBeenCalledOnce();
    moments.record('next');
    await moments.settled(() => true);
    expect(session.consider).toHaveBeenCalledTimes(2);
    expect(() => moments.dispose()).not.toThrow();
    moments.record('after');
    await moments.settled(() => true);
    expect(session.completedPlay).toHaveBeenCalledTimes(4);
  });

  it('does not ask after dispose while a recording is pending', async () => {
    const session = fakeSession();
    let finish = () => {};
    session.completedPlay.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const moments = createReviewMoments(session);
    moments.record('m');
    const pending = moments.settled(() => true);
    await vi.waitFor(() => expect(session.completedPlay).toHaveBeenCalledOnce());
    moments.dispose();
    moments.dispose();
    finish();
    await pending;
    expect(session.consider).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('makes distinct moment IDs within 128 characters, also from a long prefix', () => {
    const a = reviewMomentId('goal');
    const b = reviewMomentId('goal');
    expect(a).not.toBe(b);
    expect(a.startsWith('goal-')).toBe(true);
    const long = 'x'.repeat(300);
    const c = reviewMomentId(long);
    const d = reviewMomentId(long);
    expect(c.length).toBeLessThanOrEqual(128);
    expect(d.length).toBeLessThanOrEqual(128);
    expect(c).not.toBe(d);
    const session = fakeSession();
    const moments = createReviewMoments(session);
    moments.record(c);
    moments.record(d);
    return vi.waitFor(() => expect(session.completedPlay).toHaveBeenCalledTimes(2));
  });
});

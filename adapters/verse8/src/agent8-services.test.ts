import { describe, expect, it } from 'vitest';

import type { RecordVerifiedLeaderboardAttemptRequest } from '@mpgd/game-services/verified-leaderboard';
import {
  runVerifiedLeaderboardConformance,
  verifiedLeaderboardConformanceScenarios,
} from '@mpgd/game-services/verified-leaderboard-conformance';

import {
  createVerse8Agent8LeaderboardBoundary,
  createVerse8Agent8StorageService,
  createVerse8Agent8VerifiedLeaderboardProvider,
  type Verse8Agent8CollectionItem,
  type Verse8Agent8CollectionOptions,
  type Verse8Agent8ServiceContext,
} from './agent8-services';

describe('Verse8 Agent8 storage service', () => {
  it('round-trips isolated JSON values through locked user state updates', async () => {
    const fixture = createAgent8Context();
    const service = createVerse8Agent8StorageService();
    const input = { progress: { level: 3 }, inventory: ['key'] };

    await service.save('0xplayer', { key: 'slot-1', value: input }, fixture.context);
    input.progress.level = 99;

    const loaded = await service.load('0xplayer', { key: 'slot-1' }, fixture.context);
    expect(loaded).toEqual({
      value: { progress: { level: 3 }, inventory: ['key'] },
    });
    (loaded?.value as { progress: { level: number } }).progress.level = 50;
    await expect(
      service.load('0xplayer', { key: 'slot-1' }, fixture.context),
    ).resolves.toEqual({
      value: { progress: { level: 3 }, inventory: ['key'] },
    });
    expect(fixture.lockKeys).toHaveLength(1);
    expect(fixture.userUpdates).toHaveLength(1);
  });

  it('rejects malformed state, non-JSON values, and configured limits', async () => {
    const fixture = createAgent8Context();
    const service = createVerse8Agent8StorageService({
      maximumEntries: 1,
      maximumValueBytes: 32,
      maximumStateBytes: 128,
    });

    await expect(
      service.save('0xplayer', { key: 'bad', value: Number.NaN }, fixture.context),
    ).rejects.toThrow('JSON');
    await expect(
      service.save('0xplayer', { key: 'bad-object', value: new Date() }, fixture.context),
    ).rejects.toThrow('plain JSON objects');
    await expect(
      service.save('0xplayer', { key: '__proto__', value: 'unsafe' }, fixture.context),
    ).rejects.toThrow('cloud save key');
    await service.save('0xplayer', { key: 'first', value: 'ok' }, fixture.context);
    await expect(
      service.save('0xplayer', { key: 'second', value: 'ok' }, fixture.context),
    ).rejects.toThrow('maximumEntries');

    fixture.userStates.set('0xbroken', {
      mpgdVerse8Storage: { version: 2, values: {} },
    });
    await expect(
      service.load('0xbroken', { key: 'first' }, fixture.context),
    ).rejects.toThrow('cloud save state is invalid');
  });
});

describe('Verse8 Agent8 verified leaderboard provider', () => {
  it('passes the shared verified leaderboard provider conformance suite', async () => {
    const report = await runVerifiedLeaderboardConformance({
      createFixture: ({ now }) => {
        const fixture = createAgent8Context();
        return {
          service: createVerse8Agent8VerifiedLeaderboardProvider(fixture.context, {
            now: () => now,
          }),
        };
      },
    });

    expect(report.passedScenarios).toEqual(verifiedLeaderboardConformanceScenarios);
  });

  it('sorts bounded per-board collections server-side for opaque cursor pages', async () => {
    const fixture = createAgent8Context();
    const service = createVerse8Agent8VerifiedLeaderboardProvider(fixture.context, {
      now: () => '2030-01-02T03:04:05.000Z',
    });

    for (const [index, score] of [30, 20, 10].entries()) {
      await service.recordVerifiedAttempt(createAttempt({
        participantId: `participant-${String(index)}`,
        attemptId: `attempt-${String(index)}`,
        score,
      }));
    }

    const first = await service.getSnapshot({ leaderboardId: 'board', limit: 2 });
    expect(first?.entries.map((entry) => entry.score)).toEqual([30, 20]);
    expect(first?.nextCursor).toEqual(expect.any(String));

    fixture.collectionReads.length = 0;
    const second = await service.getSnapshot({
      leaderboardId: 'board',
      limit: 2,
      ...(first?.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    expect(second?.entries.map((entry) => entry.score)).toEqual([10]);
    expect(fixture.collectionReads).toContainEqual({ limit: 1_001 });
    expect(fixture.collectionReads.every((read) =>
      !('filters' in read) && !('orderBy' in read))).toBe(true);
  });

  it('stores only public retained fields and SHA-256 attempt digests', async () => {
    const fixture = createAgent8Context();
    const service = createVerse8Agent8VerifiedLeaderboardProvider(fixture.context);

    await service.recordVerifiedAttempt(createAttempt({
      participantId: 'participant',
      attemptId: 'retained-attempt',
      score: 10,
    }));
    await service.recordVerifiedAttempt(createAttempt({
      participantId: 'participant',
      attemptId: 'non-retained-attempt',
      score: 5,
    }));

    const stored = JSON.stringify(fixture.collectionWrites);
    expect(stored).not.toContain('verification');
    expect(stored).not.toContain('evidence:retained-attempt');
    expect(stored).not.toContain('evidence:non-retained-attempt');
    expect(fixture.collectionWrites).toContainEqual(expect.objectContaining({
      attemptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(fixture.collectionIds).toContain(
      'mpgdVerse8LeaderboardD29f5f5467c00c51768ef8e1229005167'
        + '763052fef08742dbbd37ec4b975c8734',
    );
    expect(fixture.collectionIds).toContain(
      'mpgdVerse8LeaderboardA4aa56d3b787ecd323aa7b3f6f63fb48c'
        + '2bfb294190bbba41048f13c5ed295152',
    );
    expect(fixture.collectionIds.every((collectionId) =>
      !collectionId.includes('retained-attempt'))).toBe(true);
  });

  it('requires game-specific verification and authenticated participant scope', async () => {
    const fixture = createAgent8Context();
    let verified: RecordVerifiedLeaderboardAttemptRequest | null = null;
    const boundary = createVerse8Agent8LeaderboardBoundary<{ readonly runId: string }>({
      context: fixture.context,
      async verifySubmission() {
        return verified;
      },
      now: () => '2030-01-02T03:04:05.000Z',
    });

    await expect(boundary.submit('0xplayer', { runId: 'rejected' })).resolves.toEqual({
      accepted: false,
      reason: 'VERIFICATION_REJECTED',
    });
    expect(fixture.collectionWrites).toHaveLength(0);

    verified = createAttempt({ participantId: '0xother', attemptId: 'mismatch', score: 1 });
    await expect(
      boundary.submit('0xplayer', { runId: 'mismatch' }),
    ).rejects.toThrow('participant must match');
    expect(fixture.collectionWrites).toHaveLength(0);

    verified = createAttempt({ participantId: '0xplayer', attemptId: 'accepted', score: 9 });
    await expect(boundary.submit('0xplayer', { runId: 'accepted' })).resolves.toMatchObject({
      accepted: true,
      record: { recorded: true, retained: true },
    });
    await expect(boundary.getSnapshot('0xplayer', {
      leaderboardId: 'board',
    })).resolves.toMatchObject({
      participantEntry: { participantId: '0xplayer' },
    });
  });
});

function createAttempt(input: {
  readonly participantId: string;
  readonly attemptId: string;
  readonly score: number;
}): RecordVerifiedLeaderboardAttemptRequest {
  return {
    definition: {
      leaderboardId: 'board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
    },
    attempt: {
      participantId: input.participantId,
      attemptId: input.attemptId,
      score: input.score,
      completedAt: '2030-01-02T03:00:00.000Z',
      verification: {
        authorityId: 'test-authority',
        evidenceId: `evidence:${input.attemptId}`,
        verifiedAt: '2030-01-02T03:00:01.000Z',
      },
    },
  };
}

interface Agent8ContextFixture {
  readonly context: Verse8Agent8ServiceContext;
  readonly userStates: Map<string, Readonly<Record<string, unknown>>>;
  readonly userUpdates: Readonly<Record<string, unknown>>[];
  readonly lockKeys: string[];
  readonly collectionReads: Verse8Agent8CollectionOptions[];
  readonly collectionWrites: Readonly<Record<string, unknown>>[];
  readonly collectionIds: string[];
}

function createAgent8Context(): Agent8ContextFixture {
  const userStates = new Map<string, Readonly<Record<string, unknown>>>();
  const userUpdates: Readonly<Record<string, unknown>>[] = [];
  const lockKeys: string[] = [];
  const collectionReads: Verse8Agent8CollectionOptions[] = [];
  const collectionWrites: Readonly<Record<string, unknown>>[] = [];
  const collectionIds: string[] = [];
  const collections = new Map<string, Map<string, Verse8Agent8CollectionItem>>();
  const lockTails = new Map<string, Promise<void>>();
  let nextItemId = 1;

  const getCollection = (collectionId: string) => {
    collectionIds.push(collectionId);
    const existing = collections.get(collectionId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, Verse8Agent8CollectionItem>();
    collections.set(collectionId, created);
    return created;
  };

  const context: Verse8Agent8ServiceContext = {
    async getUserState(account) {
      return clone(userStates.get(account) ?? {});
    },
    async updateUserState(account, patch) {
      const next = { ...userStates.get(account), ...clone(patch) };
      userStates.set(account, next);
      userUpdates.push(clone(patch));
      return clone(next);
    },
    async lock(key, callback) {
      lockKeys.push(key);
      const previous = lockTails.get(key) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      lockTails.set(key, tail);
      await previous;

      try {
        return await callback();
      } finally {
        release();

        if (lockTails.get(key) === tail) {
          lockTails.delete(key);
        }
      }
    },
    async getCollectionItems(collectionId, options = {}) {
      collectionReads.push(clone(options));
      return [...getCollection(collectionId).values()].slice(0, options.limit).map(clone);
    },
    async addCollectionItem(collectionId, item) {
      const itemId = `item-${String(nextItemId)}`;
      nextItemId += 1;
      const stored = { __id: itemId, ...clone(item) } as Verse8Agent8CollectionItem;
      getCollection(collectionId).set(itemId, stored);
      collectionWrites.push(clone(stored));
      return clone(stored);
    },
    async updateCollectionItem(collectionId, item) {
      const collection = getCollection(collectionId);

      if (!collection.has(item.__id)) {
        throw new Error('Collection item does not exist.');
      }

      const stored = clone(item) as Verse8Agent8CollectionItem;
      collection.set(item.__id, stored);
      collectionWrites.push(clone(stored));
      return clone(stored);
    },
  };

  return {
    context,
    userStates,
    userUpdates,
    lockKeys,
    collectionReads,
    collectionWrites,
    collectionIds,
  };
}

function clone<T>(input: T): T {
  return structuredClone(input);
}

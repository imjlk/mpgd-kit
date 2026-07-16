import { describe, expect, it } from 'vitest';

import {
  runVerifiedLeaderboardConformance,
  verifiedLeaderboardConformanceScenarios,
} from '@mpgd/game-services/verified-leaderboard-conformance';
import {
  createAmbiguousCommitVerifiedLeaderboardDurabilityFixture,
  runVerifiedLeaderboardDurabilityConformance,
  verifiedLeaderboardDurabilityConformanceScenarios,
} from '@mpgd/game-services/verified-leaderboard-durability-conformance';

import {
  createDevvitRedisVerifiedLeaderboardService,
  type DevvitVerifiedLeaderboardRedisLike,
  type DevvitVerifiedLeaderboardRedisMember,
  type DevvitVerifiedLeaderboardRedisTransactionLike,
} from './redis-verified-leaderboard';

describe('createDevvitRedisVerifiedLeaderboardService', () => {
  it('passes the provider-neutral verified leaderboard conformance suite', async () => {
    const report = await runVerifiedLeaderboardConformance({
      createFixture: ({ scenario, now }) => ({
        service: createDevvitRedisVerifiedLeaderboardService(new FakeDevvitRedis(), {
          keyPrefix: `test:${scenario}`,
          now: () => now,
        }),
      }),
    });

    expect(report.passedScenarios).toEqual(verifiedLeaderboardConformanceScenarios);
  });

  it('passes the provider-neutral durability conformance suite', async () => {
    const report = await runVerifiedLeaderboardDurabilityConformance({
      createFixture: ({ scenario, now }) =>
        createAmbiguousCommitVerifiedLeaderboardDurabilityFixture(
          createDevvitRedisVerifiedLeaderboardService(new FakeDevvitRedis(), {
            keyPrefix: `durability:${scenario}`,
            now: () => now,
          }),
        ),
    });

    expect(report.passedScenarios).toEqual(
      verifiedLeaderboardDurabilityConformanceScenarios,
    );
  });

  it('uses bounded opaque Redis keys for maximum-length board identifiers', async () => {
    const redis = new FakeDevvitRedis();
    const service = createDevvitRedisVerifiedLeaderboardService(redis);
    const leaderboardId = '🧪'.repeat(256);

    await service.recordVerifiedAttempt({
      definition: {
        leaderboardId,
        scoreOrder: 'ascending',
        attemptSelection: 'first',
      },
      attempt: {
        participantId: 'participant:bounded-key',
        attemptId: 'attempt:bounded-key',
        score: 1,
        completedAt: '2030-01-02T03:04:05.000Z',
        verification: {
          authorityId: 'test',
          evidenceId: 'evidence:bounded-key',
          verifiedAt: '2030-01-02T03:04:05.000Z',
        },
      },
    });

    expect(redis.observedKeys.length).toBeGreaterThan(0);
    expect(Math.max(...redis.observedKeys.map((key) => key.length))).toBeLessThanOrEqual(128);
    expect(redis.observedKeys.some((key) => key.includes(leaderboardId))).toBe(false);
  });

  it('retries bounded WATCH contention and fails when the budget is exhausted', async () => {
    const retryingRedis = new FakeDevvitRedis();
    retryingRedis.remainingContentions = 1;
    const retryingService = createDevvitRedisVerifiedLeaderboardService(retryingRedis, {
      transactionAttempts: 2,
    });

    await expect(retryingService.recordVerifiedAttempt(createRequest('retry'))).resolves.toMatchObject({
      alreadyProcessed: false,
      retained: true,
    });
    expect(retryingRedis.execCalls).toBe(2);

    const exhaustedRedis = new FakeDevvitRedis();
    exhaustedRedis.remainingContentions = 2;
    const exhaustedService = createDevvitRedisVerifiedLeaderboardService(exhaustedRedis, {
      transactionAttempts: 2,
    });

    await expect(exhaustedService.recordVerifiedAttempt(createRequest('exhausted'))).rejects
      .toThrow('contention exceeded 2 attempts');
  });

  it('re-reads a snapshot when a retained replacement commits between Redis reads', async () => {
    const redis = new FakeDevvitRedis();
    const service = createDevvitRedisVerifiedLeaderboardService(redis);
    const initialRequest = createRequest('snapshot-race');
    await service.recordVerifiedAttempt(initialRequest);
    redis.beforeNextRetainedHGet = async () => {
      await service.recordVerifiedAttempt({
        ...initialRequest,
        attempt: {
          ...initialRequest.attempt,
          attemptId: 'attempt:snapshot-race:earlier',
          completedAt: '2030-01-02T03:03:05.000Z',
          verification: {
            ...initialRequest.attempt.verification,
            evidenceId: 'evidence:snapshot-race:earlier',
          },
        },
      });
    };

    await expect(service.getSnapshot({
      leaderboardId: initialRequest.definition.leaderboardId,
    })).resolves.toMatchObject({
      entries: [{ attemptId: 'attempt:snapshot-race:earlier' }],
    });
    expect(redis.retainedHGetCalls).toBe(3);
  });

  it('uses the transaction attempt budget for retained entry reads', async () => {
    const redis = new FakeDevvitRedis();
    const service = createDevvitRedisVerifiedLeaderboardService(redis, {
      transactionAttempts: 1,
    });
    const initialRequest = createRequest('snapshot-budget');
    await service.recordVerifiedAttempt(initialRequest);
    redis.beforeNextRetainedHGet = async () => {
      await service.recordVerifiedAttempt({
        ...initialRequest,
        attempt: {
          ...initialRequest.attempt,
          attemptId: 'attempt:snapshot-budget:earlier',
          completedAt: '2030-01-02T03:03:05.000Z',
          verification: {
            ...initialRequest.attempt.verification,
            evidenceId: 'evidence:snapshot-budget:earlier',
          },
        },
      });
    };

    await expect(service.getSnapshot({
      leaderboardId: initialRequest.definition.leaderboardId,
    })).rejects.toThrow('changed during 1 consecutive reads');
  });

  it('rejects invalid provider options before using Redis', () => {
    const redis = new FakeDevvitRedis();

    expect(() => createDevvitRedisVerifiedLeaderboardService(redis, { keyPrefix: 'bad key' }))
      .toThrow('keyPrefix');
    expect(() => createDevvitRedisVerifiedLeaderboardService(redis, {
      transactionAttempts: 0,
    })).toThrow('transactionAttempts');
  });
});

function createRequest(suffix: string) {
  const now = '2030-01-02T03:04:05.000Z';

  return {
    definition: {
      leaderboardId: `board:${suffix}`,
      scoreOrder: 'ascending' as const,
      attemptSelection: 'first' as const,
    },
    attempt: {
      participantId: `participant:${suffix}`,
      attemptId: `attempt:${suffix}`,
      score: 1,
      completedAt: now,
      verification: {
        authorityId: 'test',
        evidenceId: `evidence:${suffix}`,
        verifiedAt: now,
      },
    },
  };
}

interface QueuedMutation {
  readonly key: string;
  readonly apply: () => void;
}

class FakeDevvitRedis implements DevvitVerifiedLeaderboardRedisLike {
  readonly values = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly versions = new Map<string, number>();
  readonly observedKeys: string[] = [];
  beforeNextRetainedHGet: (() => Promise<void>) | undefined;
  remainingContentions = 0;
  execCalls = 0;
  retainedHGetCalls = 0;

  async get(key: string): Promise<string | undefined> {
    this.observe(key);
    return this.values.get(key);
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    if (key.endsWith(':entries')) {
      this.retainedHGetCalls += 1;
      const beforeRetainedHGet = this.beforeNextRetainedHGet;
      this.beforeNextRetainedHGet = undefined;
      await beforeRetainedHGet?.();
    }

    this.observe(key);
    return this.hashes.get(key)?.get(field);
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<DevvitVerifiedLeaderboardRedisMember[]> {
    this.observe(key);
    const members = [...(this.sortedSets.get(key)?.entries() ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((left, right) => left.score - right.score || compareOrdinal(left.member, right.member));
    const inclusiveStop = stop < 0 ? members.length + stop : stop;
    return members.slice(start, inclusiveStop + 1);
  }

  async watch(...keys: string[]): Promise<DevvitVerifiedLeaderboardRedisTransactionLike> {
    keys.forEach((key) => this.observe(key));
    return new FakeDevvitRedisTransaction(
      this,
      new Map(keys.map((key) => [key, this.version(key)])),
    );
  }

  applySet(key: string, value: string): void {
    this.values.set(key, value);
  }

  applyHSet(key: string, fieldValues: Record<string, string>): void {
    const hash = this.hashes.get(key) ?? new Map<string, string>();

    for (const [field, value] of Object.entries(fieldValues)) {
      hash.set(field, value);
    }

    this.hashes.set(key, hash);
  }

  applyHDel(key: string, fields: readonly string[]): void {
    const hash = this.hashes.get(key);

    for (const field of fields) {
      hash?.delete(field);
    }
  }

  applyZAdd(key: string, members: readonly DevvitVerifiedLeaderboardRedisMember[]): void {
    const sortedSet = this.sortedSets.get(key) ?? new Map<string, number>();

    for (const { member, score } of members) {
      sortedSet.set(member, score);
    }

    this.sortedSets.set(key, sortedSet);
  }

  applyZRem(key: string, members: readonly string[]): void {
    const sortedSet = this.sortedSets.get(key);

    for (const member of members) {
      sortedSet?.delete(member);
    }
  }

  commit(mutations: readonly QueuedMutation[]): readonly unknown[] {
    const mutatedKeys = new Set<string>();

    for (const mutation of mutations) {
      mutation.apply();
      mutatedKeys.add(mutation.key);
    }

    for (const key of mutatedKeys) {
      this.versions.set(key, this.version(key) + 1);
    }

    return mutations.map(() => 'OK');
  }

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private observe(key: string): void {
    this.observedKeys.push(key);
  }
}

class FakeDevvitRedisTransaction implements DevvitVerifiedLeaderboardRedisTransactionLike {
  private readonly mutations: QueuedMutation[] = [];
  private multiStarted = false;

  constructor(
    private readonly redis: FakeDevvitRedis,
    private readonly watchedVersions: ReadonlyMap<string, number>,
  ) {}

  async multi(): Promise<void> {
    this.multiStarted = true;
  }

  async discard(): Promise<void> {
    this.mutations.length = 0;
    this.multiStarted = false;
  }

  async set(key: string, value: string): Promise<void> {
    this.queue(key, () => this.redis.applySet(key, value));
  }

  async hSet(key: string, fieldValues: Record<string, string>): Promise<void> {
    this.queue(key, () => this.redis.applyHSet(key, fieldValues));
  }

  async hDel(key: string, fields: string[]): Promise<void> {
    this.queue(key, () => this.redis.applyHDel(key, fields));
  }

  async zAdd(
    key: string,
    ...members: DevvitVerifiedLeaderboardRedisMember[]
  ): Promise<void> {
    this.queue(key, () => this.redis.applyZAdd(key, members));
  }

  async zRem(key: string, members: string[]): Promise<void> {
    this.queue(key, () => this.redis.applyZRem(key, members));
  }

  async exec(): Promise<readonly unknown[]> {
    this.redis.execCalls += 1;

    if (this.redis.remainingContentions > 0) {
      this.redis.remainingContentions -= 1;
      return [];
    }

    for (const [key, version] of this.watchedVersions) {
      if (this.redis.version(key) !== version) {
        return [];
      }
    }

    return this.redis.commit(this.mutations);
  }

  async unwatch(): Promise<void> {}

  private queue(key: string, apply: () => void): void {
    if (!this.multiStarted) {
      throw new Error('Redis mutation queued before MULTI.');
    }

    this.mutations.push({ key, apply });
  }
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

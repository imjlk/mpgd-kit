import { describe, expect, it } from 'vitest';

import {
  createDevvitRedisPostOperationStore,
  type DevvitRedisLike,
  type DevvitRedisRangeOptions,
  type DevvitRedisSetOptions,
  type DevvitRedisSortedSetMember,
  type DevvitRedisTransactionLike,
} from './redis-post-operation-store';

describe('createDevvitRedisPostOperationStore', () => {
  it('reads and creates values with SET NX semantics', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.read('operation')).resolves.toBeUndefined();
    await expect(store.create('operation', 'pending')).resolves.toBe(true);
    await expect(store.create('operation', 'different')).resolves.toBe(false);
    await expect(store.read('operation')).resolves.toBe('pending');
    expect(redis.setCalls).toEqual([
      {
        key: 'operation',
        value: 'pending',
        options: { nx: true },
      },
      {
        key: 'operation',
        value: 'different',
        options: { nx: true },
      },
    ]);
  });

  it('creates leases with the caller-provided absolute expiration', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);
    const expiresAt = new Date(Date.now() + 60_000);

    await expect(store.createLease('operation:lease', 'owner-1', expiresAt)).resolves.toBe(true);
    await expect(store.createLease('operation:lease', 'owner-2', expiresAt)).resolves.toBe(false);
    expect(redis.setCalls).toEqual([
      {
        key: 'operation:lease',
        value: 'owner-1',
        options: { nx: true, expiration: expiresAt },
      },
      {
        key: 'operation:lease',
        value: 'owner-2',
        options: { nx: true, expiration: expiresAt },
      },
    ]);
  });

  it('atomically replaces only the expected value', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.compareAndSet('operation', 'other', 'published')).resolves.toBe(false);
    await expect(store.compareAndSet('operation', 'pending', 'published')).resolves.toBe(true);
    await expect(store.read('operation')).resolves.toBe('published');
    expect(redis.unwatchCalls).toBe(1);
  });

  it('registers state before creation and lists stable members by lex cursor', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);
    const first = 'operation-a';
    const second = 'operation-b';

    await expect(store.createIndexed('operation-a', 'prepared-a', {
      indexKey: 'operations',
      member: first,
    })).resolves.toBe(true);
    await expect(store.createIndexed('operation-b', 'attempted-b', {
      indexKey: 'operations',
      member: second,
    })).resolves.toBe(true);
    await expect(store.listIndex('operations', undefined, 1)).resolves.toEqual([first]);
    await expect(store.listIndex('operations', first, 2)).resolves.toEqual([second]);
  });

  it('retains stable registry membership across every state CAS', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);
    const member = 'operation';

    await store.createIndexed('operation', 'prepared', {
      indexKey: 'operations',
      member,
    });
    await expect(store.compareAndSetIndexed('operation', 'prepared', 'attempted', {
      indexKey: 'operations',
      member,
    })).resolves.toBe(true);
    await expect(store.listIndex('operations', undefined, 10)).resolves.toEqual([member]);
    await expect(store.compareAndSetIndexed('operation', 'attempted', 'published', {
      indexKey: 'operations',
      member,
    })).resolves.toBe(true);
    await expect(store.listIndex('operations', undefined, 10)).resolves.toEqual([member]);
  });

  it('backfills a pre-index record before its state CAS', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);

    await store.create('operation', 'prepared');
    await expect(store.compareAndSetIndexed('operation', 'prepared', 'attempted', {
      indexKey: 'operations',
      member: 'operation',
    })).resolves.toBe(true);
    await expect(store.listIndex('operations', undefined, 10)).resolves.toEqual(['operation']);
  });

  it('does not transition a pre-index record when registry backfill fails', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis);

    await store.create('operation', 'prepared');
    redis.zAddError = new Error('registry unavailable');
    await expect(store.compareAndSetIndexed('operation', 'prepared', 'attempted', {
      indexKey: 'operations',
      member: 'operation',
    })).rejects.toThrow('registry unavailable');
    await expect(store.read('operation')).resolves.toBe('prepared');
  });

  it('keeps stable index membership while a pending state CAS retries contention', async () => {
    const redis = new FakeDevvitRedis();
    const store = createDevvitRedisPostOperationStore(redis, { transactionAttempts: 2 });

    await store.createIndexed('operation', 'prepared', {
      indexKey: 'operations',
      member: 'operation',
    });
    redis.execOutcomes.push('contention', 'success');
    await expect(store.compareAndSetIndexed('operation', 'prepared', 'attempted', {
      indexKey: 'operations',
      member: 'operation',
    })).resolves.toBe(true);
    await expect(store.read('operation')).resolves.toBe('attempted');
    await expect(store.listIndex('operations', undefined, 10)).resolves.toEqual(['operation']);
  });

  it('does not create pending state when index establishment fails', async () => {
    const redis = new FakeDevvitRedis();
    const indexError = new Error('index unavailable');
    redis.zAddError = indexError;
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.createIndexed('operation', 'prepared', {
      indexKey: 'operations',
      member: 'operation',
    })).rejects.toBe(indexError);
    await expect(store.read('operation')).resolves.toBeUndefined();
    await expect(store.listIndex('operations', undefined, 10)).resolves.toEqual([]);
  });

  it('retries confirmed transaction contention within a bounded budget', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    redis.execOutcomes.push('contention', 'success');
    const store = createDevvitRedisPostOperationStore(redis, { transactionAttempts: 2 });

    await expect(store.compareAndSet('operation', 'pending', 'published')).resolves.toBe(true);
    await expect(store.read('operation')).resolves.toBe('published');
    expect(redis.watchCalls).toBe(2);
  });

  it('retries a null transaction abort as contention', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    redis.execOutcomes.push('null-contention', 'success');
    const store = createDevvitRedisPostOperationStore(redis, { transactionAttempts: 2 });

    await expect(store.compareAndSet('operation', 'pending', 'published')).resolves.toBe(true);
    await expect(store.read('operation')).resolves.toBe('published');
    expect(redis.watchCalls).toBe(2);
  });

  it('throws instead of reporting false when transaction contention is exhausted', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    redis.execOutcomes.push('contention', 'contention');
    const store = createDevvitRedisPostOperationStore(redis, { transactionAttempts: 2 });

    await expect(store.compareAndSet('operation', 'pending', 'published')).rejects.toThrow(
      'contention exceeded 2 attempts',
    );
    await expect(store.read('operation')).resolves.toBe('pending');
  });

  it('deletes a lease only while the watched token still owns it', async () => {
    const redis = new FakeDevvitRedis([['operation:lease', 'owner-1']]);
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.releaseLease('operation:lease', 'owner-2')).resolves.toBeUndefined();
    await expect(store.read('operation:lease')).resolves.toBe('owner-1');
    await expect(store.releaseLease('operation:lease', 'owner-1')).resolves.toBeUndefined();
    await expect(store.read('operation:lease')).resolves.toBeUndefined();
  });

  it('retries fenced lease release contention without deleting a replacement token', async () => {
    const redis = new FakeDevvitRedis([['operation:lease', 'owner-1']]);
    redis.execOutcomes.push(() => {
      redis.values.set('operation:lease', 'owner-2');
      return 'contention';
    });
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.releaseLease('operation:lease', 'owner-1')).resolves.toBeUndefined();
    await expect(store.read('operation:lease')).resolves.toBe('owner-2');
  });

  it('throws when fenced lease release contention exhausts its budget', async () => {
    const redis = new FakeDevvitRedis([['operation:lease', 'owner-1']]);
    redis.execOutcomes.push('contention', 'contention');
    const store = createDevvitRedisPostOperationStore(redis, { transactionAttempts: 2 });

    await expect(store.releaseLease('operation:lease', 'owner-1')).rejects.toThrow(
      'contention exceeded 2 attempts',
    );
    await expect(store.read('operation:lease')).resolves.toBe('owner-1');
  });

  it('propagates Redis transport errors', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    const transportError = new Error('redis transport unavailable');
    redis.execOutcomes.push(transportError);
    const store = createDevvitRedisPostOperationStore(redis);

    await expect(store.compareAndSet('operation', 'pending', 'published')).rejects.toBe(
      transportError,
    );
    expect(redis.discardCalls).toBe(1);
  });

  it('rejects invalid adapter options and lease expirations', async () => {
    const redis = new FakeDevvitRedis();

    expect(() => createDevvitRedisPostOperationStore(redis, { transactionAttempts: 0 })).toThrow(
      'transactionAttempts',
    );
    const store = createDevvitRedisPostOperationStore(redis);
    await expect(store.createLease('operation:lease', 'owner', new Date(Number.NaN))).rejects
      .toThrow('valid Date');
    await expect(
      store.createLease('operation:lease', 'owner', new Date(Date.now() - 1)),
    ).rejects.toThrow('in the future');
  });
});

type ExecOutcome =
  | 'success'
  | 'contention'
  | 'null-contention'
  | Error
  | (() => 'success' | 'contention' | 'null-contention' | Error);

class FakeDevvitRedis implements DevvitRedisLike {
  readonly values: Map<string, string>;
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly setCalls: Array<{
    readonly key: string;
    readonly value: string;
    readonly options: DevvitRedisSetOptions;
  }> = [];
  readonly execOutcomes: ExecOutcome[] = [];
  watchCalls = 0;
  unwatchCalls = 0;
  discardCalls = 0;
  zAddError: Error | undefined;

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.values = new Map(entries);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options: DevvitRedisSetOptions = {},
  ): Promise<string> {
    this.setCalls.push({ key, value, options });

    if (options.nx === true && this.values.has(key)) {
      return '';
    }

    this.values.set(key, value);
    return 'OK';
  }

  async zRange(
    key: string,
    start: string,
    stop: string,
    options: DevvitRedisRangeOptions,
  ): Promise<DevvitRedisSortedSetMember[]> {
    if (stop !== '+' || options.by !== 'lex') {
      throw new Error('FakeDevvitRedis only supports forward lex ranges.');
    }

    const exclusiveStart = start === '-' ? undefined : start.slice(1);
    return [...(this.sortedSets.get(key)?.entries() ?? [])]
      .filter(([member]) => exclusiveStart === undefined || member > exclusiveStart)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(options.limit.offset, options.limit.offset + options.limit.count)
      .map(([member, score]) => ({ member, score }));
  }

  async zAdd(key: string, ...members: readonly DevvitRedisSortedSetMember[]): Promise<number> {
    if (this.zAddError !== undefined) {
      throw this.zAddError;
    }
    const previousSize = this.sortedSets.get(key)?.size ?? 0;
    this.applyZAdd(key, members);
    return (this.sortedSets.get(key)?.size ?? 0) - previousSize;
  }

  async watch(key: string): Promise<DevvitRedisTransactionLike> {
    this.watchCalls += 1;
    return new FakeDevvitRedisTransaction(this, key);
  }

  nextExecOutcome(): 'success' | 'contention' | 'null-contention' | Error {
    const configured = this.execOutcomes.shift() ?? 'success';

    return typeof configured === 'function' ? configured() : configured;
  }

  applyZAdd(key: string, members: readonly DevvitRedisSortedSetMember[]): void {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    for (const member of members) {
      set.set(member.member, member.score);
    }
    this.sortedSets.set(key, set);
  }

}

class FakeDevvitRedisTransaction implements DevvitRedisTransactionLike {
  private readonly mutations: Array<() => void> = [];
  private multiStarted = false;

  constructor(
    private readonly redis: FakeDevvitRedis,
    private readonly watchedKey: string,
  ) {}

  async multi(): Promise<void> {
    this.multiStarted = true;
  }

  async discard(): Promise<void> {
    this.redis.discardCalls += 1;
    this.mutations.length = 0;
    this.multiStarted = false;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertMultiStarted();
    this.mutations.push(() => {
      this.redis.values.set(key, value);
    });
  }

  async del(...keys: readonly string[]): Promise<void> {
    this.assertMultiStarted();
    this.mutations.push(() => {
      for (const key of keys) {
        this.redis.values.delete(key);
      }
    });
  }

  async exec(): Promise<readonly unknown[] | null> {
    const outcome = this.redis.nextExecOutcome();

    if (outcome instanceof Error) {
      throw outcome;
    }

    if (outcome === 'contention') {
      return [];
    }
    if (outcome === 'null-contention') {
      return null;
    }

    for (const mutation of this.mutations) {
      mutation();
    }
    return ['OK'];
  }

  async unwatch(): Promise<void> {
    this.redis.unwatchCalls += 1;
  }

  private assertMultiStarted(): void {
    if (!this.multiStarted) {
      throw new Error(`Mutation queued before MULTI for ${this.watchedKey}.`);
    }
  }
}

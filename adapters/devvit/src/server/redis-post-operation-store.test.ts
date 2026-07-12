import { describe, expect, it } from 'vitest';

import {
  createDevvitRedisPostOperationStore,
  type DevvitRedisLike,
  type DevvitRedisSetOptions,
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

  it('retries confirmed transaction contention within a bounded budget', async () => {
    const redis = new FakeDevvitRedis([['operation', 'pending']]);
    redis.execOutcomes.push('contention', 'success');
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
  | Error
  | (() => 'success' | 'contention' | Error);

class FakeDevvitRedis implements DevvitRedisLike {
  readonly values: Map<string, string>;
  readonly setCalls: Array<{
    readonly key: string;
    readonly value: string;
    readonly options: DevvitRedisSetOptions;
  }> = [];
  readonly execOutcomes: ExecOutcome[] = [];
  watchCalls = 0;
  unwatchCalls = 0;
  discardCalls = 0;

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

  async watch(key: string): Promise<DevvitRedisTransactionLike> {
    this.watchCalls += 1;
    return new FakeDevvitRedisTransaction(this, key);
  }

  nextExecOutcome(): 'success' | 'contention' | Error {
    const configured = this.execOutcomes.shift() ?? 'success';

    return typeof configured === 'function' ? configured() : configured;
  }
}

class FakeDevvitRedisTransaction implements DevvitRedisTransactionLike {
  private mutation: (() => void) | undefined;
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
    this.mutation = undefined;
    this.multiStarted = false;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertMultiStarted();
    this.mutation = () => {
      this.redis.values.set(key, value);
    };
  }

  async del(...keys: readonly string[]): Promise<void> {
    this.assertMultiStarted();
    this.mutation = () => {
      for (const key of keys) {
        this.redis.values.delete(key);
      }
    };
  }

  async exec(): Promise<readonly unknown[]> {
    const outcome = this.redis.nextExecOutcome();

    if (outcome instanceof Error) {
      throw outcome;
    }

    if (outcome === 'contention') {
      return [];
    }

    this.mutation?.();
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

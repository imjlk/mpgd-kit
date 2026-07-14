import type {
  DevvitDurableOperationIndexMutation,
  DevvitIndexedDurableOperationStore,
} from './post-operation.js';

const defaultTransactionAttempts = 3;
const maximumTransactionAttempts = 32;

export interface DevvitRedisSetOptions {
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly expiration?: Date;
}

export interface DevvitRedisSortedSetMember {
  readonly member: string;
  readonly score: number;
}

export interface DevvitRedisRangeOptions {
  readonly by: 'lex';
  readonly limit: {
    readonly offset: number;
    readonly count: number;
  };
}

export interface DevvitRedisTransactionLike {
  multi(): Promise<void>;
  discard(): Promise<unknown>;
  set(key: string, value: string, options?: DevvitRedisSetOptions): Promise<unknown>;
  del(...keys: readonly string[]): Promise<unknown>;
  zAdd(key: string, ...members: readonly DevvitRedisSortedSetMember[]): Promise<unknown>;
  zRem(key: string, members: readonly string[]): Promise<unknown>;
  exec(): Promise<readonly unknown[] | null>;
  unwatch(): Promise<unknown>;
}

export interface DevvitRedisLike {
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: DevvitRedisSetOptions,
  ): Promise<string | undefined | null>;
  zRange(
    key: string,
    start: string,
    stop: string,
    options: DevvitRedisRangeOptions,
  ): Promise<readonly DevvitRedisSortedSetMember[]>;
  watch(...keys: readonly string[]): Promise<DevvitRedisTransactionLike>;
}

export interface DevvitRedisPostOperationStoreOptions {
  readonly transactionAttempts?: number;
}

export function createDevvitRedisPostOperationStore(
  redis: DevvitRedisLike,
  options: DevvitRedisPostOperationStoreOptions = {},
): DevvitIndexedDurableOperationStore {
  const transactionAttempts = normalizeTransactionAttempts(options.transactionAttempts);

  return {
    read(key) {
      return redis.get(key);
    },
    async create(key, value) {
      return setIfAbsent(redis, key, value);
    },
    async createIndexed(key, value, index) {
      return createIndexedIfAbsent({
        redis,
        key,
        value,
        index,
        transactionAttempts,
      });
    },
    async compareAndSet(key, expectedValue, nextValue) {
      return mutateIfValue({
        redis,
        key,
        expectedValue,
        transactionAttempts,
        queueMutation: (transaction) => transaction.set(key, nextValue),
      });
    },
    async compareAndSetIndexed(key, expectedValue, nextValue, index) {
      return mutateIfValue({
        redis,
        key,
        expectedValue,
        transactionAttempts,
        queueMutation: async (transaction) => {
          await transaction.set(key, nextValue);
          await queueIndexMutation(transaction, index);
        },
      });
    },
    async listIndex(key, startExclusive, limit) {
      assertIndexPageLimit(limit);
      const members = await redis.zRange(
        key,
        startExclusive === undefined ? '-' : `(${startExclusive}`,
        '+',
        { by: 'lex', limit: { offset: 0, count: limit } },
      );

      return members.map((member) => {
        if (member.score !== 0 || typeof member.member !== 'string') {
          throw new Error(`Devvit Redis pending-operation index is invalid for key: ${key}`);
        }

        return member.member;
      });
    },
    async createLease(key, token, expiresAt) {
      assertExpirationDate(expiresAt);

      return setIfAbsent(redis, key, token, { expiration: expiresAt });
    },
    async releaseLease(key, token) {
      await mutateIfValue({
        redis,
        key,
        expectedValue: token,
        transactionAttempts,
        queueMutation: (transaction) => transaction.del(key),
      });
    },
  };
}

async function createIndexedIfAbsent(input: {
  readonly redis: DevvitRedisLike;
  readonly key: string;
  readonly value: string;
  readonly index: DevvitDurableOperationIndexMutation;
  readonly transactionAttempts: number;
}): Promise<boolean> {
  for (let attempt = 0; attempt < input.transactionAttempts; attempt += 1) {
    const transaction = await input.redis.watch(input.key);
    let multiStarted = false;

    try {
      if (await input.redis.get(input.key) !== undefined) {
        await transaction.unwatch();
        return false;
      }

      await transaction.multi();
      multiStarted = true;
      await transaction.set(input.key, input.value);
      await queueIndexMutation(transaction, input.index);
      const results = await transaction.exec();

      if (results === null || (Array.isArray(results) && results.length === 0)) {
        continue;
      }
      if (!Array.isArray(results)) {
        throw new Error('Devvit Redis transaction returned an unsupported response.');
      }

      return true;
    } catch (error) {
      await bestEffortReset(transaction, multiStarted);
      throw error;
    }
  }

  throw new Error(
    `Devvit Redis transaction contention exceeded ${String(input.transactionAttempts)} attempts for key: ${input.key}`,
  );
}

async function queueIndexMutation(
  transaction: DevvitRedisTransactionLike,
  mutation: DevvitDurableOperationIndexMutation,
): Promise<void> {
  if (mutation.removeMember !== undefined) {
    await transaction.zRem(mutation.indexKey, [mutation.removeMember]);
  }
  if (mutation.addMember !== undefined) {
    await transaction.zAdd(mutation.indexKey, { member: mutation.addMember, score: 0 });
  }
}

async function setIfAbsent(
  redis: DevvitRedisLike,
  key: string,
  value: string,
  options: Omit<DevvitRedisSetOptions, 'nx'> = {},
): Promise<boolean> {
  const result = await redis.set(key, value, {
    ...options,
    nx: true,
  });

  if (result === 'OK') {
    return true;
  }

  // Devvit Redis represents a failed SET NX with an empty/nil response.
  if (result === '' || result === undefined || result === null) {
    return false;
  }

  throw new Error(`Devvit Redis SET NX returned an unsupported response: ${result}`);
}

async function mutateIfValue(input: {
  readonly redis: DevvitRedisLike;
  readonly key: string;
  readonly expectedValue: string;
  readonly transactionAttempts: number;
  readonly queueMutation: (transaction: DevvitRedisTransactionLike) => Promise<unknown>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < input.transactionAttempts; attempt += 1) {
    const transaction = await input.redis.watch(input.key);
    let multiStarted = false;

    try {
      const currentValue = await input.redis.get(input.key);

      if (currentValue !== input.expectedValue) {
        await transaction.unwatch();
        return false;
      }

      await transaction.multi();
      multiStarted = true;
      await input.queueMutation(transaction);

      const results = await transaction.exec();

      if (results === null) {
        continue;
      }

      if (!Array.isArray(results)) {
        throw new Error('Devvit Redis transaction returned an unsupported response.');
      }

      if (results.length > 0) {
        return true;
      }
    } catch (error) {
      await bestEffortReset(transaction, multiStarted);
      throw error;
    }
  }

  throw new Error(
    `Devvit Redis transaction contention exceeded ${String(input.transactionAttempts)} attempts for key: ${input.key}`,
  );
}

async function bestEffortReset(
  transaction: DevvitRedisTransactionLike,
  multiStarted: boolean,
): Promise<void> {
  try {
    if (multiStarted) {
      await transaction.discard();
    } else {
      await transaction.unwatch();
    }
  } catch {
    // Preserve the original Redis failure; this cleanup is best-effort.
  }
}

function normalizeTransactionAttempts(value: number | undefined): number {
  const transactionAttempts = value ?? defaultTransactionAttempts;

  if (
    !Number.isSafeInteger(transactionAttempts)
    || transactionAttempts < 1
    || transactionAttempts > maximumTransactionAttempts
  ) {
    throw new TypeError(
      `transactionAttempts must be a safe integer from 1 to ${String(maximumTransactionAttempts)}.`,
    );
  }

  return transactionAttempts;
}

function assertIndexPageLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 101) {
    throw new TypeError('Devvit Redis index page limit must be a safe integer from 1 to 101.');
  }
}

function assertExpirationDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Devvit Redis lease expiration must be a valid Date.');
  }
  if (value.getTime() <= Date.now()) {
    throw new TypeError('Devvit Redis lease expiration must be in the future.');
  }
}

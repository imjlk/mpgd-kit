import {
  devvitPostOperationMaximumPendingPageLimit,
  type DevvitIndexedDurableOperationStore,
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
  zAdd(key: string, ...members: readonly DevvitRedisSortedSetMember[]): Promise<unknown>;
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
    async ensureIndexed(index) {
      await redis.zAdd(index.indexKey, { member: index.member, score: 0 });
    },
    async create(key, value) {
      return setIfAbsent(redis, key, value);
    },
    async createIndexed(key, value, index) {
      if (index.member !== key) {
        throw new TypeError('Indexed creation member must equal the durable state key.');
      }

      // Membership is intentionally established first. If the following state
      // write fails, listing may see a stale member but cannot miss live work.
      await redis.zAdd(index.indexKey, { member: index.member, score: 0 });
      return setIfAbsent(redis, key, value);
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
      if (index.member !== key) {
        throw new TypeError('Indexed CAS member must equal the durable state key.');
      }

      // Stable registry membership was established before state creation and
      // does not change across prepared, attempted, published, or terminal state.
      // Re-adding it backfills records created before indexed stores existed.
      await redis.zAdd(index.indexKey, { member: index.member, score: 0 });
      return mutateIfValue({
        redis,
        key,
        expectedValue,
        transactionAttempts,
        queueMutation: (transaction) => transaction.set(key, nextValue),
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
          throw new Error(`Devvit Redis operation registry is invalid for key: ${key}`);
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
      const counting = countQueuedCommands(transaction);
      await input.queueMutation(counting.transaction);

      if (counting.count() === 0) {
        throw new Error('Devvit Redis transaction queued no commands before EXEC.');
      }

      const results = await transaction.exec();

      // `@devvit/redis` `TxClient.exec()` never resolves `null`: it maps the
      // server reply to an array, so an aborted WATCH transaction surfaces as
      // an empty array. Fewer results than queued commands is a conflict; `null`
      // stays a conflict for clients that follow the classic Redis contract.
      if (results === null) {
        continue;
      }

      if (!Array.isArray(results)) {
        throw new Error('Devvit Redis transaction returned an unsupported response.');
      }

      if (results.length < counting.count()) {
        continue;
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

/**
 * Wraps a transaction so the number of commands queued after MULTI is known
 * when EXEC resolves, which is what distinguishes a completed transaction from
 * an aborted one on the Devvit Redis client.
 */
function countQueuedCommands(transaction: DevvitRedisTransactionLike): {
  readonly transaction: DevvitRedisTransactionLike;
  readonly count: () => number;
} {
  let queued = 0;

  return {
    count: () => queued,
    transaction: {
      multi: () => transaction.multi(),
      discard: () => transaction.discard(),
      exec: () => transaction.exec(),
      unwatch: () => transaction.unwatch(),
      async set(key, value, options) {
        const result = await transaction.set(key, value, options);
        queued += 1;
        return result;
      },
      async del(...keys) {
        const result = await transaction.del(...keys);
        queued += 1;
        return result;
      },
    },
  };
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
  const maximum = devvitPostOperationMaximumPendingPageLimit + 1;

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(
      `Devvit Redis index page limit must be a safe integer from 1 to ${String(maximum)}.`,
    );
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

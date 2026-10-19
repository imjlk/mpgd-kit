import type {
  DevvitNotificationRedis,
  DevvitNotificationRedisMember,
  DevvitNotificationRedisTransaction,
} from '../src/server/redis-notification-store.js';

/**
 * An in-process Devvit Redis for the notification store tests, with the
 * WATCH/MULTI/EXEC semantics the store relies on: every write bumps the
 * key's version, EXEC applies the queued commands at once unless a watched
 * key changed since WATCH, and an aborted EXEC resolves an empty array, as
 * `@devvit/redis` `TxClient.exec()` does. Every call yields first, so
 * concurrent callers interleave between commands.
 */
export interface FakeNotificationRedis extends DevvitNotificationRedis {
  /** Transactions EXEC aborted because a watched key changed. */
  readonly aborted: number;
  /** Runs before each EXEC is judged; a test changes a watched key here to force a conflict. */
  beforeExec?: ((watched: readonly string[]) => void | Promise<void>) | undefined;
  /** Writes a string outside any transaction, bumping its version. */
  poke(key: string, value: string): void;
  /**
   * Drops every numeric zero reply from a committed EXEC, as `@devvit/redis`
   * drops a reply it cannot map (a protobuf zero may arrive unset): the
   * transaction commits, and its result is short.
   */
  dropZeroReplies: boolean;
  /** How an aborted EXEC answers: no reply (as `@devvit/redis`), or one nil per queued command. */
  abortReply: 'empty' | 'nulls';
  /** Marks a key as written by another client without changing it, as a WATCH sees it. */
  touch(key: string): void;
  keys(): readonly string[];
}

type Entry =
  | { readonly type: 'string'; value: string }
  | { readonly type: 'hash'; readonly fields: Map<string, string> }
  | { readonly type: 'zset'; readonly members: Map<string, number> };

export function createFakeNotificationRedis(): FakeNotificationRedis {
  const data = new Map<string, Entry>();
  const versions = new Map<string, number>();
  let aborted = 0;
  const tick = (): Promise<void> => new Promise((resolve) => {
    setImmediate(resolve);
  });
  const bump = (key: string): void => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
  };
  const hash = (key: string, create: boolean): Map<string, string> | undefined => {
    const entry = data.get(key);
    if (entry === undefined) {
      if (!create) {
        return undefined;
      }
      const fields = new Map<string, string>();
      data.set(key, { type: 'hash', fields });
      return fields;
    }
    if (entry.type !== 'hash') {
      throw new Error(`WRONGTYPE ${key} is a ${entry.type}`);
    }
    return entry.fields;
  };
  const zset = (key: string, create: boolean): Map<string, number> | undefined => {
    const entry = data.get(key);
    if (entry === undefined) {
      if (!create) {
        return undefined;
      }
      const members = new Map<string, number>();
      data.set(key, { type: 'zset', members });
      return members;
    }
    if (entry.type !== 'zset') {
      throw new Error(`WRONGTYPE ${key} is a ${entry.type}`);
    }
    return entry.members;
  };
  const dropEmpty = (key: string): void => {
    const entry = data.get(key);
    if (
      (entry?.type === 'hash' && entry.fields.size === 0)
      || (entry?.type === 'zset' && entry.members.size === 0)
    ) {
      data.delete(key);
    }
  };

  // Writes, applied synchronously (inside EXEC, or by `poke`).
  const write = {
    set(key: string, value: string): string {
      data.set(key, { type: 'string', value });
      bump(key);
      return 'OK';
    },
    del(keys: readonly string[]): number {
      let removed = 0;
      for (const key of keys) {
        if (data.delete(key)) {
          removed += 1;
          bump(key);
        }
      }
      return removed;
    },
    hSet(key: string, values: Readonly<Record<string, string>>): number {
      const fields = hash(key, true) as Map<string, string>;
      let added = 0;
      for (const [field, value] of Object.entries(values)) {
        if (!fields.has(field)) {
          added += 1;
        }
        fields.set(field, value);
      }
      bump(key);
      return added;
    },
    hDel(key: string, names: readonly string[]): number {
      const fields = hash(key, false);
      let removed = 0;
      for (const name of names) {
        if (fields?.delete(name) === true) {
          removed += 1;
        }
      }
      if (removed > 0) {
        bump(key);
        dropEmpty(key);
      }
      return removed;
    },
    zAdd(key: string, members: readonly DevvitNotificationRedisMember[]): number {
      const set = zset(key, true) as Map<string, number>;
      let added = 0;
      for (const { member, score } of members) {
        if (!set.has(member)) {
          added += 1;
        }
        set.set(member, score);
      }
      bump(key);
      return added;
    },
    zRem(key: string, members: readonly string[]): number {
      const set = zset(key, false);
      let removed = 0;
      for (const member of members) {
        if (set?.delete(member) === true) {
          removed += 1;
        }
      }
      if (removed > 0) {
        bump(key);
        dropEmpty(key);
      }
      return removed;
    },
  };

  const parseBound = (bound: number | string, low: boolean): { value: number; open: boolean } => {
    const text = String(bound);
    if (text === '-inf') {
      return { value: Number.NEGATIVE_INFINITY, open: false };
    }
    if (text === '+inf' || text === 'inf') {
      return { value: Number.POSITIVE_INFINITY, open: false };
    }
    const open = text.startsWith('(');
    const value = Number(open ? text.slice(1) : text);
    if (!Number.isFinite(value)) {
      throw new Error(`ERR min or max is not a float: ${text} (${low ? 'min' : 'max'})`);
    }
    return { value, open };
  };

  const redis: FakeNotificationRedis = {
    dropZeroReplies: false,
    abortReply: 'empty',
    get aborted() {
      return aborted;
    },
    poke(key, value) {
      write.set(key, value);
    },
    touch(key) {
      bump(key);
    },
    keys() {
      return [...data.keys()].sort();
    },
    async get(key) {
      await tick();
      const entry = data.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.type !== 'string') {
        throw new Error(`WRONGTYPE ${key} is a ${entry.type}`);
      }
      return entry.value;
    },
    async mGet(keys) {
      await tick();
      return keys.map((key) => {
        const entry = data.get(key);
        return entry?.type === 'string' ? entry.value : null;
      });
    },
    async hGet(key, field) {
      await tick();
      return hash(key, false)?.get(field);
    },
    async hGetAll(key) {
      await tick();
      return Object.fromEntries(hash(key, false) ?? []);
    },
    async hSet(key, values) {
      await tick();
      return write.hSet(key, values);
    },
    async hMGet(key, fields) {
      await tick();
      const stored = hash(key, false);
      return fields.map((field) => stored?.get(field) ?? null);
    },
    async zRange(key, start, stop, options) {
      await tick();
      const sorted = [...(zset(key, false) ?? new Map<string, number>())]
        .map(([member, score]) => ({ member, score }))
        .sort((left, right) => left.score - right.score || compareMembers(left.member, right.member));
      if (options === undefined || options.by === 'rank') {
        if (options?.limit !== undefined) {
          throw new Error("zRange parsing error: 'limit' only allowed when 'options.by' is 'lex' or 'score'");
        }
        const size = sorted.length;
        let from = Number(start);
        let to = Number(stop);
        from = from < 0 ? Math.max(0, size + from) : from;
        to = to < 0 ? size + to : Math.min(to, size - 1);
        return from > to ? [] : sorted.slice(from, to + 1);
      }
      if (options.by !== 'score') {
        throw new Error('The fake Redis reads sorted sets by rank or score only.');
      }
      const min = parseBound(start, true);
      const max = parseBound(stop, false);
      const inRange = sorted.filter(({ score }) =>
        (min.open ? score > min.value : score >= min.value)
        && (max.open ? score < max.value : score <= max.value));
      const offset = options.limit?.offset ?? 0;
      // `@devvit/redis` reads at most 1,000 members when no limit is given.
      const count = options.limit?.count ?? 1000;
      return inRange.slice(offset, offset + count);
    },
    async zRank(key, member) {
      await tick();
      const sorted = [...(zset(key, false) ?? new Map<string, number>())]
        .map(([name, score]) => ({ member: name, score }))
        .sort((left, right) => left.score - right.score || compareMembers(left.member, right.member));
      const rank = sorted.findIndex((entry) => entry.member === member);
      return rank === -1 ? undefined : rank;
    },
    async zCard(key) {
      await tick();
      return zset(key, false)?.size ?? 0;
    },
    async watch(...watched) {
      await tick();
      const seen = new Map(watched.map((key) => [key, versions.get(key) ?? 0]));
      let queue: (() => unknown)[] | undefined;
      let closed = false;
      const queueOrFail = (command: () => unknown): Promise<unknown> => {
        if (closed) {
          return Promise.reject(new Error('The transaction is closed.'));
        }
        if (queue === undefined) {
          return Promise.reject(new Error('A write outside MULTI on a transaction client.'));
        }
        queue.push(command);
        return Promise.resolve(transaction);
      };
      const transaction: DevvitNotificationRedisTransaction = {
        async multi() {
          await tick();
          if (queue !== undefined) {
            throw new Error('ERR MULTI calls can not be nested');
          }
          queue = [];
        },
        async exec() {
          await tick();
          if (queue === undefined) {
            throw new Error('ERR EXEC without MULTI');
          }
          await redis.beforeExec?.(watched);
          const commands = queue;
          closed = true;
          queue = undefined;
          const changed = [...seen].some(([key, version]) => (versions.get(key) ?? 0) !== version);
          if (changed) {
            aborted += 1;
            return redis.abortReply === 'nulls' ? commands.map(() => null) : [];
          }
          const replies = commands.map((command) => command());
          return redis.dropZeroReplies ? replies.filter((reply) => reply !== 0) : replies;
        },
        async discard() {
          await tick();
          closed = true;
          queue = undefined;
        },
        // Simplification: the store abandons a transaction client after
        // UNWATCH or DISCARD, so the fake closes it rather than keeping the
        // connection usable as Redis does.
        async unwatch() {
          await tick();
          closed = true;
        },
        set: (key, value) => queueOrFail(() => write.set(key, value)),
        del: (...keys) => queueOrFail(() => write.del(keys)),
        hSet: (key, values) => queueOrFail(() => write.hSet(key, values)),
        hDel: (key, fields) => queueOrFail(() => write.hDel(key, fields)),
        zAdd: (key, ...members) => queueOrFail(() => write.zAdd(key, members)),
        zRem: (key, members) => queueOrFail(() => write.zRem(key, members)),
      };
      return transaction;
    },
  };
  return redis;
}

/** Byte order for the ASCII members the store writes (Redis compares members as bytes). */
function compareMembers(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

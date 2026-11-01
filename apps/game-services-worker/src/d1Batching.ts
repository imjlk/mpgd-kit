import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * D1 statement batching for one invocation (a notifications bulk send).
 *
 * D1 counts a `db.batch()` call as one query against its queries-per-Worker-
 * invocation limit (1,000 on Workers Paid), not one per statement
 * (https://developers.cloudflare.com/d1/platform/limits/, checked
 * 2026-11-01). Inside `runWithD1Batching`, every statement a
 * `batchingDatabase` runs is queued instead of sent, and the statements that
 * the invocation's concurrent work queued side by side go to D1 together in
 * one `db.batch()`. The store code is unchanged: each statement keeps its
 * own SQL, conditions, and result, so a conditional write (a send's version,
 * `ON CONFLICT DO NOTHING`) is as conditional as before, and a store's own
 * `db.batch()` stays atomic (it is queued as one group, never split).
 *
 * - **Order.** Statements run in the order they were queued, and batches one
 *   after the other. Each caller has at most one statement or group
 *   waiting, so a batch runs them as one serial order of the calls, which
 *   concurrent calls could have had anyway.
 * - **When a batch goes.** Once a timer turn passes with nothing new queued
 *   and no tracked outside call (an identity lookup, a provider call, a
 *   copy lookup: `trackD1BatchingIo`) in flight, or at the latest
 *   `d1BatchMaxWaitMs` after its first statement, so concurrent callers that
 *   wait on other I/O between their statements still meet in one batch.
 * - **Size.** At most `d1BatchMaxStatements` statements per `db.batch()`;
 *   more go in several, one after the other. D1 documents no statement count
 *   per batch, but a batch must finish within its 30-second query duration,
 *   and each statement keeps the per-statement limits (100 bound parameters,
 *   100 KB of SQL), which the store's statements already respect.
 * - **A failing statement.** D1 runs a batch as one SQL transaction, so a
 *   statement that fails rolls the whole batch back and nothing in it is
 *   applied. A batch that fails with a SQL error (a constraint, a type, a
 *   statement D1 refuses) is run again in halves until the failing caller's
 *   statement is alone, and only that caller gets the error; the others'
 *   statements run as they would have alone. The halving makes at most
 *   `d1BatchMaxIsolationQueries` queries in a scope: an error that many
 *   callers hit (a missing column) fails the callers still left in its
 *   batch at once rather than spend the invocation's queries. Any other
 *   failure (the database unreachable, full, busy, or read-only, a
 *   timeout, a reset) fails every caller in the batch, as each of their
 *   own calls would have failed, and is never retried: the batch may have
 *   been applied. So one such failure reaches up to a whole batch of
 *   callers, where it used to reach the calls in flight at that moment.
 */

/** Statements one `db.batch()` carries at most. */
export const d1BatchMaxStatements = 500;
/** Queries one scope spends at most on running failed batches again in halves. */
export const d1BatchMaxIsolationQueries = 64;
/** How long the first queued statement waits for others at most, in milliseconds. */
export const d1BatchMaxWaitMs = 500;

/** What one batching scope did, for logs and tests. */
export interface D1BatchingStats {
  /** `db.batch()` calls made: D1 queries, as its per-invocation limit counts them. */
  readonly queries: number;
  /** Statements those calls carried. */
  readonly statements: number;
  /** The most statements one call carried. */
  readonly largestBatch: number;
}

interface Entry {
  readonly statements: readonly D1PreparedStatement[];
  readonly resolve: (results: readonly D1Result[]) => void;
  readonly reject: (error: unknown) => void;
}

interface Batcher {
  enqueue(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]>;
  poke(): void;
}

interface Scope {
  readonly batchers: Map<D1Database, Batcher>;
  external: number;
  queries: number;
  statements: number;
  largestBatch: number;
  isolationQueries: number;
}

const scopes = new AsyncLocalStorage<Scope>();

/**
 * Runs `work` with the D1 statements of every `batchingDatabase` it uses
 * batched (see above), and answers its value with what the batching did.
 */
export async function runWithD1Batching<Value>(
  work: () => Promise<Value>,
): Promise<{ readonly value: Value; readonly stats: D1BatchingStats }> {
  const scope: Scope = {
    batchers: new Map(),
    external: 0,
    queries: 0,
    statements: 0,
    largestBatch: 0,
    isolationQueries: 0,
  };
  const value = await scopes.run(scope, work);
  return {
    value,
    stats: {
      queries: scope.queries,
      statements: scope.statements,
      largestBatch: scope.largestBatch,
    },
  };
}

/** The queries the current batching scope made so far, or `undefined` outside a scope. */
export function d1BatchingQueries(): number | undefined {
  return scopes.getStore()?.queries;
}

/**
 * Runs an outside call (not D1) made inside a batching scope; while it is
 * in flight, a batch waits for the statements its caller may queue next
 * (up to `d1BatchMaxWaitMs`). Outside a scope it only runs `work`.
 */
export async function trackD1BatchingIo<Value>(work: () => Promise<Value>): Promise<Value> {
  const scope = scopes.getStore();
  if (scope === undefined) {
    return work();
  }
  scope.external += 1;
  try {
    return await work();
  } finally {
    scope.external -= 1;
    if (scope.external === 0) {
      for (const batcher of scope.batchers.values()) {
        batcher.poke();
      }
    }
  }
}

/**
 * `db`, with each statement's `first`, `all`, and `run` and each `batch`
 * queued in the current batching scope; outside a scope, every call goes
 * to `db` as it is. `raw`, `exec`, and `dump` are never batched.
 */
export function batchingDatabase(db: D1Database): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const queued = (statement: D1PreparedStatement): Promise<D1Result> | undefined => {
    const scope = scopes.getStore();
    if (scope === undefined) {
      return undefined;
    }
    return batcherOf(scope, db).enqueue([statement]).then((results) => {
      const result = results[0];
      if (result === undefined) {
        throw new Error('D1 answered no result for a batched statement.');
      }
      return result;
    });
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      async first(column?: string) {
        const batched = queued(statement);
        if (batched === undefined) {
          return column === undefined ? statement.first() : statement.first(column);
        }
        const row = ((await batched).results as readonly Record<string, unknown>[] | undefined)?.[0];
        if (row === undefined) {
          return null;
        }
        if (column === undefined) {
          return row;
        }
        if (!(column in row)) {
          throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
        }
        return row[column];
      },
      async all() {
        return queued(statement) ?? statement.all();
      },
      async run() {
        return queued(statement) ?? statement.run();
      },
      raw: ((...args: unknown[]) =>
        (statement.raw as (...inner: unknown[]) => unknown).apply(statement, args)) as D1PreparedStatement['raw'],
    };
    originals.set(wrapped, statement);
    return wrapped as unknown as D1PreparedStatement;
  };
  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    async batch(statements: D1PreparedStatement[]) {
      const unwrapped = statements.map((statement) => originals.get(statement) ?? statement);
      const scope = scopes.getStore();
      if (scope === undefined) {
        return db.batch(unwrapped);
      }
      return [...await batcherOf(scope, db).enqueue(unwrapped)];
    },
    dump: () => db.dump(),
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

function batcherOf(scope: Scope, db: D1Database): Batcher {
  let batcher = scope.batchers.get(db);
  if (batcher === undefined) {
    batcher = createBatcher(scope, db);
    scope.batchers.set(db, batcher);
  }
  return batcher;
}

function createBatcher(scope: Scope, db: D1Database): Batcher {
  let pending: Entry[] = [];
  let pendingStatements = 0;
  let seen = -1;
  let turn: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let waitingOnIo = false;
  let running: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (turn === undefined) {
      turn = setTimeout(tick, 0);
    }
  };
  function tick(): void {
    turn = undefined;
    if (pending.length === 0) {
      return;
    }
    const grew = pendingStatements !== seen;
    seen = pendingStatements;
    if (scope.external > 0) {
      // The deadline timer flushes if the outside calls outlast it.
      waitingOnIo = true;
      return;
    }
    if (grew) {
      schedule();
      return;
    }
    flush();
  }
  function flush(): void {
    if (turn !== undefined) {
      clearTimeout(turn);
      turn = undefined;
    }
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    waitingOnIo = false;
    const entries = pending;
    pending = [];
    pendingStatements = 0;
    seen = -1;
    if (entries.length === 0) {
      return;
    }
    running = running.then(() => runEntries(entries));
  }
  async function runEntries(entries: readonly Entry[]): Promise<void> {
    let chunk: Entry[] = [];
    let size = 0;
    for (const entry of entries) {
      if (size > 0 && size + entry.statements.length > d1BatchMaxStatements) {
        await runChunk(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(entry);
      size += entry.statements.length;
    }
    if (chunk.length > 0) {
      await runChunk(chunk);
    }
  }
  async function runChunk(chunk: readonly Entry[]): Promise<void> {
    const statements = chunk.flatMap((entry) => entry.statements);
    let results: readonly D1Result[];
    scope.queries += 1;
    scope.statements += statements.length;
    scope.largestBatch = Math.max(scope.largestBatch, statements.length);
    try {
      results = await db.batch([...statements]);
    } catch (error) {
      if (
        chunk.length > 1
        && isStatementError(error)
        && scope.isolationQueries + 2 <= d1BatchMaxIsolationQueries
      ) {
        // The transaction rolled back: nothing ran. Halves isolate the failing caller.
        scope.isolationQueries += 2;
        const middle = Math.ceil(chunk.length / 2);
        await runChunk(chunk.slice(0, middle));
        await runChunk(chunk.slice(middle));
        return;
      }
      for (const entry of chunk) {
        entry.reject(error);
      }
      return;
    }
    if (results.length !== statements.length) {
      const error = new Error(
        `D1 answered ${results.length} results for a batch of ${statements.length}.`,
      );
      for (const entry of chunk) {
        entry.reject(error);
      }
      return;
    }
    let offset = 0;
    for (const entry of chunk) {
      entry.resolve(results.slice(offset, offset + entry.statements.length));
      offset += entry.statements.length;
    }
  }

  return {
    enqueue(statements) {
      return new Promise((resolve, reject) => {
        if (pending.length === 0) {
          deadline = setTimeout(flush, d1BatchMaxWaitMs);
        }
        pending.push({ statements, resolve, reject });
        pendingStatements += statements.length;
        schedule();
      });
    },
    poke() {
      if (waitingOnIo && pending.length > 0) {
        waitingOnIo = false;
        schedule();
      }
    },
  };
}

/**
 * Whether a failed batch failed on a statement (SQL D1 or SQLite refused),
 * which a smaller batch without it would not hit. Anything else, such as a
 * lost connection, a timeout, or a reset, may have been applied, so it is
 * not run again.
 */
function isStatementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/network|connection|timeout|timed out|reset|transient|overloaded|internal error|unavailable/iu.test(
    message,
  )) {
    return false;
  }
  // A full, busy, locked, read-only, or failing database fails any batch alike.
  if (/SQLITE_(?:FULL|BUSY|LOCKED|IOERR|READONLY|CORRUPT|NOMEM|INTERRUPT|PROTOCOL|CANTOPEN)/u.test(
    message,
  )) {
    return false;
  }
  return /constraint failed|SQLITE_(?:CONSTRAINT|MISMATCH|TOOBIG|RANGE|ERROR)|D1_TYPE_ERROR|D1_COLUMN_NOTFOUND|no such (?:table|column)|syntax error|datatype mismatch|too many SQL variables|too big/iu
    .test(message);
}

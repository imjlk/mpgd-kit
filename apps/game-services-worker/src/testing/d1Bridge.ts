import type { Miniflare } from 'miniflare';

// Test support: D1 in miniflare, driven from Node at the speed the Worker sees.

// Runs the statements a request names on the database, inside workerd: one request is one D1 query.
export const d1BridgeScript = `export default {
  async fetch(request, env) {
    const { mode, statements } = await request.json();
    try {
      const prepared = statements.map((item) => env.DB.prepare(item.sql).bind(...item.params));
      const results = mode === 'batch' ? await env.DB.batch(prepared) : [await prepared[0].all()];
      return Response.json({ ok: true, results });
    } catch (error) {
      return Response.json({ ok: false, message: String(error && error.message || error) });
    }
  },
};`;

/**
 * D1 as the Worker sees it, with every query counted: a statement call, or
 * a batch (one query, as D1 counts it). Statements are built here and run
 * inside workerd (`d1BridgeScript`) on the miniflare D1 database, one
 * dispatch per query, because a statement prepared and bound through
 * miniflare's Node proxy costs a round trip per call.
 */
export function bridgedD1Database(mf: Miniflare) {
  let queries = 0;
  let statements = 0;
  let largestBatch = 0;
  interface Bound {
    readonly sql: string;
    readonly params: readonly unknown[];
  }
  const run = async (mode: 'one' | 'batch', list: readonly Bound[]): Promise<D1Result[]> => {
    queries += 1;
    statements += list.length;
    if (mode === 'batch') {
      largestBatch = Math.max(largestBatch, list.length);
    }
    const response = await mf.dispatchFetch('http://bridge.test/', {
      method: 'POST',
      body: JSON.stringify({ mode, statements: list }),
    });
    const answer = await response.json() as
      | { readonly ok: true; readonly results: D1Result[] }
      | { readonly ok: false; readonly message: string };
    if (!answer.ok) {
      throw new Error(answer.message);
    }
    return answer.results;
  };
  const bound = new WeakMap<object, Bound>();
  const statement = (sql: string, params: readonly unknown[]): D1PreparedStatement => {
    const self = {
      bind: (...values: unknown[]) => statement(sql, values),
      async first(column?: string) {
        const [result] = await run('one', [{ sql, params }]);
        const row = (result?.results as readonly Record<string, unknown>[] | undefined)?.[0];
        return row === undefined ? null : column === undefined ? row : (row[column] ?? null);
      },
      all: async () => (await run('one', [{ sql, params }]))[0],
      run: async () => (await run('one', [{ sql, params }]))[0],
      async raw() {
        throw new Error('raw() is not bridged.');
      },
    };
    bound.set(self, { sql, params });
    return self as unknown as D1PreparedStatement;
  };
  return {
    db: {
      prepare: (sql: string) => statement(sql, []),
      batch: (list: D1PreparedStatement[]) =>
        run('batch', list.map((item) => {
          const entry = bound.get(item);
          if (entry === undefined) {
            throw new Error('A statement from another database.');
          }
          return entry;
        })),
      async exec() {
        throw new Error('exec() is not bridged.');
      },
      async dump() {
        throw new Error('dump() is not bridged.');
      },
    } as unknown as D1Database,
    reset() {
      queries = 0;
      statements = 0;
      largestBatch = 0;
    },
    snapshot: () => ({ queries, statements, largestBatch }),
  };
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { runNotificationStoreConformance } from '@mpgd/game-services/notifications/store-conformance';
import { Miniflare } from 'miniflare';

import {
  batchingDatabase,
  d1BatchMaxStatements,
  d1BatchMaxWaitMs,
  runWithD1Batching,
  trackD1BatchingIo,
} from './d1Batching.js';
import { createD1NotificationStore } from './notificationsD1.js';
import { bridgedD1Database, d1BridgeScript } from './testing/d1Bridge.js';

// D1 statement batching (d1Batching.ts): statements queued side by side go
// in one db.batch(), each keeps its own result and condition, and a failing
// statement fails only its own caller.

const miniflare = new Miniflare({
  modules: true,
  script: d1BridgeScript,
  d1Databases: { DB: 'd1-batching' },
});

try {
  const bridged = bridgedD1Database(miniflare);
  const db = batchingDatabase(bridged.db);
  await bridged.db.prepare(`CREATE TABLE items (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (value <> 'bad')
  )`).run();
  const count = async () =>
    (await bridged.db.prepare('SELECT COUNT(*) AS n FROM items').first<{ readonly n: number }>())?.n;

  // Outside a scope every call goes to D1 as it is.
  bridged.reset();
  await db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind('a', 'x').run();
  assert.deepEqual(await db.prepare('SELECT value FROM items WHERE id = ?').bind('a').first(), {
    value: 'x',
  });
  assert.deepEqual(bridged.snapshot(), { queries: 2, statements: 2, largestBatch: 0 });

  // Inside a scope, concurrent calls share one batch, and each keeps its own answer.
  bridged.reset();
  {
    const { value, stats } = await runWithD1Batching(async () => Promise.all([
      db.prepare('SELECT value FROM items WHERE id = ?').bind('a').first(),
      db.prepare('SELECT value FROM items WHERE id = ?').bind('a').first('value'),
      db.prepare('SELECT value FROM items WHERE id = ?').bind('missing').first(),
      db.prepare('SELECT id FROM items ORDER BY id').all(),
      // A conditional write keeps its condition: the stale version changes nothing.
      db.prepare('UPDATE items SET value = ? WHERE id = ? AND version = ?').bind('y', 'a', 9).run(),
      db.prepare('UPDATE items SET value = ?, version = 2 WHERE id = ? AND version = ?').bind('z', 'a', 1).run(),
      db.batch([
        db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind('b', 'x'),
        db.prepare('SELECT version FROM items WHERE id = ?').bind('b'),
      ]),
    ]));
    assert.deepEqual(stats, { queries: 1, statements: 8, largestBatch: 8 });
    assert.deepEqual(bridged.snapshot(), { queries: 1, statements: 8, largestBatch: 8 });
    assert.deepEqual(value[0], { value: 'x' });
    assert.equal(value[1], 'x');
    assert.equal(value[2], null);
    assert.deepEqual(value[3].results, [{ id: 'a' }]);
    assert.equal(value[4].meta.changes, 0);
    assert.equal(value[5].meta.changes, 1);
    assert.deepEqual(value[6][1]?.results, [{ version: 1 }]);
  }

  // A statement that fails (a constraint) fails only its caller: the batch is
  // run again in halves, and every other caller's statement is applied once.
  bridged.reset();
  {
    const before = await count();
    bridged.reset();
    const { value, stats } = await runWithD1Batching(async () => Promise.allSettled([
      ...['c', 'd', 'e'].map((id) => db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind(id, 'x').run()),
      db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind('f', 'bad').run(),
      ...['g', 'h'].map((id) => db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind(id, 'x').run()),
      // A store's own batch stays atomic: its failing statement takes its first one back too.
      db.batch([
        db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind('i', 'x'),
        db.prepare('INSERT INTO items (id, version, value) VALUES (?, 1, ?)').bind('a', 'x'),
      ]),
    ]));
    assert.deepEqual(
      value.map((settled) => settled.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected'],
    );
    assert.match(String((value[3] as PromiseRejectedResult).reason), /CHECK constraint failed/u);
    assert.match(String((value[6] as PromiseRejectedResult).reason), /UNIQUE constraint failed/u);
    assert.equal(await count(), (before ?? 0) + 5);
    assert.equal(await db.prepare('SELECT id FROM items WHERE id = ?').bind('i').first(), null);
    // One try, then halves down to each failing caller: a few queries, not one per statement.
    assert.ok(stats.queries > 1 && stats.queries <= 9, String(stats.queries));
  }

  // Any other failure (D1 unreachable) fails every caller once and is not run again: it may have been applied.
  {
    let batches = 0;
    const unreachable = batchingDatabase({
      ...bridged.db,
      prepare: (sql: string) => bridged.db.prepare(sql),
      async batch() {
        batches += 1;
        throw new Error('D1_ERROR: Network connection lost.');
      },
    } as unknown as D1Database);
    const { value } = await runWithD1Batching(async () =>
      Promise.allSettled([
        unreachable.prepare('SELECT 1').first(),
        unreachable.prepare('SELECT 2').first(),
      ]),
    );
    assert.deepEqual(
      value.map((settled) => settled.status),
      ['rejected', 'rejected'],
    );
    assert.equal(batches, 1);
  }

  // More statements than one batch carries go in several, in order.
  bridged.reset();
  {
    const total = d1BatchMaxStatements * 2 + 7;
    const { value, stats } = await runWithD1Batching(async () =>
      Promise.all(
        Array.from({ length: total }, (_, index) =>
          db.prepare('SELECT ? AS n').bind(index).first<{ readonly n: number }>(),
        ),
      ),
    );
    assert.deepEqual(
      value.map((row) => row?.n),
      Array.from({ length: total }, (_, index) => index),
    );
    assert.deepEqual(stats, { queries: 3, statements: total, largestBatch: d1BatchMaxStatements });
  }

  // A tracked outside call holds the batch for the statements its caller queues
  // after it, up to the wait bound; an untracked one does not.
  {
    const lookup = (ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    const tracked = await runWithD1Batching(async () => Promise.all([
      db.prepare('SELECT 1 AS n').first(),
      (async () => {
        await trackD1BatchingIo(() => lookup(20));
        return db.prepare('SELECT 2 AS n').first();
      })(),
    ]));
    assert.equal(tracked.stats.queries, 1);
    const untracked = await runWithD1Batching(async () => Promise.all([
      db.prepare('SELECT 1 AS n').first(),
      (async () => {
        await lookup(20);
        return db.prepare('SELECT 2 AS n').first();
      })(),
    ]));
    assert.equal(untracked.stats.queries, 2);
    const started = performance.now();
    const outlasted = await runWithD1Batching(async () =>
      Promise.all([
        db.prepare('SELECT 1 AS n').first(),
        trackD1BatchingIo(() => lookup(d1BatchMaxWaitMs * 4)),
      ]),
    );
    assert.equal(outlasted.stats.queries, 1);
    // The statement went at the wait bound, not after the outside call.
    assert.ok(performance.now() - started >= d1BatchMaxWaitMs * 4);
  }

  // The notifications store keeps its contract with every statement batched,
  // including the conformance suite's concurrent writes to one key.
  const migration = (await Promise.all(
    ['0007_notifications.sql', '0008_notification_scheduler.sql'].map((file) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
  )).join('\n');
  for (const statement of migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)) {
    await bridged.db.prepare(statement).run();
  }
  bridged.reset();
  const conformance = await runWithD1Batching(() =>
    runNotificationStoreConformance(async () => {
      for (const table of [
        'notification_consent_records',
        'notification_endpoints',
        'notification_platform_registrations',
        'notification_notices_given',
        'notification_sends',
        'notification_delivery_history',
        'notification_schedule',
      ]) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
      return createD1NotificationStore(db);
    }));
  // Every statement went through a batch.
  assert.equal(conformance.stats.queries, bridged.snapshot().queries);
  assert.ok(conformance.stats.largestBatch > 1);
  console.info('D1 statement batching passed.');
} finally {
  await miniflare.dispose();
}

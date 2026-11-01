import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { Miniflare } from 'miniflare';

import type { GameServicesWorkerEnv } from './handler.js';
import { bridgedD1Database, d1BridgeScript } from './testing/d1Bridge.js';
import {
  asWorkerNotificationRpcResult,
  deliverWorkerNotificationBulk,
  workerNotificationBulkLimits,
} from './notificationsHandler.js';

// A bulk send of 2,500 Apps in Toss recipients through the Worker on local D1
// (miniflare), with account-deletion tombstones bound: the D1 queries one
// invocation makes are counted, and must stay under D1's 1,000 queries per
// Worker invocation (Workers Paid) with margin.

const recipientsPerCall = Number(process.env['MPGD_BULK_TEST_RECIPIENTS'] ?? 2_500);
/** The most queries one 2,500-recipient call may make here: half of D1's 1,000. */
const queryCeiling = 500;

// The service reads the clock through `new Date()`; the test moves it to a
// fixed day, so the Apps in Toss hold window (20:55 to 08:00 in Seoul) is
// outside or inside as each case needs, and time still passes.
const RealDate = Date;
let clockOffset = 0;
class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(RealDate.now() + clockOffset);
    } else {
      super(...(args as [string | number]));
    }
  }

  static override now(): number {
    return RealDate.now() + clockOffset;
  }
}
globalThis.Date = TestDate as DateConstructor;
const setClock = (iso: string): void => {
  clockOffset = RealDate.parse(iso) - RealDate.now();
};

const miniflare = new Miniflare({
  modules: true,
  script: d1BridgeScript,
  d1Databases: { DB: 'notifications-bulk' },
});

try {
  const raw = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const migration of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
    await applyMigration(raw, migration);
  }
  const counted = bridgedD1Database(miniflare);

  const partnerCalls: { readonly url: string; readonly recipients: number }[] = [];
  let identityLookups = 0;
  /** How many recipients of the next bulk call the fake partner API says it reached; all when undefined. */
  let reachedNext: number | undefined;
  const env = {
    MPGD_STORE: 'd1',
    DB: counted.db,
    GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: 'k'.repeat(48),
    MPGD_NOTIFICATIONS_CATALOG: {
      version: '2026-11-01',
      defaultLocale: 'ko',
      topics: [
        {
          id: 'energy-full',
          purpose: 'service',
          channels: ['remote'],
          route: '/?entry=energy',
          copy: { ko: { title: '에너지', body: '에너지가 가득 찼어요.' } },
          targets: { ait: { templateSetCode: 'my-game-energy-full', agreement: 'none' } },
        },
      ],
    },
    MPGD_AIT_NOTIFICATIONS: JSON.stringify({ recipientKey: 'toss-user' }),
    AIT_PARTNER_MTLS: {
      async fetch(input: string, init?: RequestInit) {
        const bulk = input.endsWith('/send-bulk-message');
        const recipients = bulk
          ? (JSON.parse(String(init?.body)) as { readonly contextList: readonly unknown[] }).contextList.length
          : 1;
        partnerCalls.push({ url: input, recipients });
        const sent = bulk ? (reachedNext ?? recipients) : 1;
        reachedNext = undefined;
        return Response.json({
          resultType: 'SUCCESS',
          success: {
            msgCount: sent,
            sentPushCount: sent,
            sentInboxCount: 0,
            sentSmsCount: 0,
            sentAlimtalkCount: 0,
            sentFriendtalkCount: 0,
            detail: {
              sentPush: [],
              sentInbox: [],
              sentSms: [],
              sentAlimtalk: [],
              sentFriendtalk: [],
            },
            fail: { sentPush: [], sentInbox: [], sentSms: [], sentAlimtalk: [], sentFriendtalk: [] },
          },
        });
      },
    },
    GAME_SERVICES_NOTIFICATIONS_IDENTITY: {
      async resolveNotificationRecipient({ playerId }: { readonly provider: string; readonly playerId: string }) {
        identityLookups += 1;
        return playerId.startsWith('p-')
          ? String(1_000_000 + Number(playerId.replace(/^p-[a-z]+-/u, '')))
          : null;
      },
    },
  } satisfies GameServicesWorkerEnv;

  const limits = workerNotificationBulkLimits(env);
  console.info('Bulk limits on D1 with tombstones:', limits);
  const audience = (name: string, count = recipientsPerCall) =>
    Array.from({ length: count }, (_, index) => ({ player: `p-${name}-${index + 1}` }));
  const send = async (idempotencyKey: string, recipients: readonly { readonly player: string }[]) => {
    counted.reset();
    identityLookups = 0;
    const calls = partnerCalls.length;
    const started = performance.now();
    const answer = await asWorkerNotificationRpcResult(() =>
      deliverWorkerNotificationBulk(env, {
        idempotencyKey,
        provider: 'apps-in-toss',
        topic: 'energy-full',
        recipients,
      }),
    );
    assert.ok(answer.ok, JSON.stringify(answer));
    const measured = {
      ...counted.snapshot(),
      ms: Math.round(performance.now() - started),
      // The other subrequests the call makes: Workers Paid allows 10,000 per invocation.
      identityLookups,
      partnerCalls: partnerCalls.length - calls,
    };
    assert.ok(measured.queries + measured.identityLookups + measured.partnerCalls < 10_000);
    console.info(`${idempotencyKey}:`, measured, answer.value.summary, answer.value.providerCalls);
    return { result: answer.value, measured };
  };
  const delivered = (count: number) => ({
    delivered: count,
    alreadyProcessed: 0,
    deferred: 0,
    inFlight: 0,
    suppressed: 0,
    unavailable: 0,
    notAttempted: 0,
    failed: 0,
  });

  // Noon in Seoul: outside the hold window, so one send-bulk-message call takes all 2,500.
  setClock('2030-01-15T03:00:00.000Z');
  {
    const first = await send('event-noon', audience('noon'));
    assert.deepEqual(first.result.summary, delivered(recipientsPerCall));
    assert.deepEqual(first.result.providerCalls, { batch: 1, single: 0 });
    assert.deepEqual(
      partnerCalls.map((call) => call.recipients),
      [recipientsPerCall],
    );
    assert.ok(
      first.measured.queries <= queryCeiling,
      `${first.measured.queries} D1 queries for ${recipientsPerCall} recipients`,
    );
    // The same call again answers every recipient from the ledger and calls no one.
    partnerCalls.length = 0;
    const again = await send('event-noon', audience('noon'));
    assert.equal(again.result.summary.alreadyProcessed, recipientsPerCall);
    assert.deepEqual(again.result.providerCalls, { batch: 0, single: 0 });
    assert.equal(partnerCalls.length, 0);
    assert.ok(
      again.measured.queries <= queryCeiling / 5,
      `${again.measured.queries} D1 queries for a retry`,
    );
  }

  // A partial answer (the partner API reached fewer than it was sent): every
  // recipient stays in flight, unattributed, and a retry sends none again.
  {
    partnerCalls.length = 0;
    reachedNext = recipientsPerCall - 1;
    const partial = await send('event-partial', audience('partial'));
    assert.equal(partial.result.summary.inFlight, recipientsPerCall);
    assert.deepEqual(partial.result.providerCalls, { batch: 1, single: 0 });
    assert.ok(partial.measured.queries <= queryCeiling);
    partnerCalls.length = 0;
    const retried = await send('event-partial', audience('partial'));
    assert.equal(retried.result.summary.inFlight, recipientsPerCall);
    assert.equal(partnerCalls.length, 0);
  }

  // Deleted players and players without a Toss user: refused before any
  // write or provider call, each with its own answer; the rest still go in one call.
  {
    const deleted = new Set(['p-mixed-3', 'p-mixed-40']);
    const now = new Date();
    for (const player of deleted) {
      await raw.prepare(`INSERT INTO account_deletion_tombstones (player_key, expires_at) VALUES (?1, ?2)`)
        .bind(await hmacHex('k'.repeat(48), player), new Date(now.getTime() + 86_400_000).toISOString())
        .run();
    }
    partnerCalls.length = 0;
    const recipients = [
      ...audience('mixed', recipientsPerCall - 10),
      ...Array.from({ length: 10 }, (_, index) => ({ player: `unknown-${index}` })),
    ];
    const mixed = await send('event-mixed', recipients);
    assert.equal(mixed.result.summary.failed, deleted.size);
    assert.equal(mixed.result.summary.unavailable, 10);
    assert.equal(mixed.result.summary.delivered, recipientsPerCall - 10 - deleted.size);
    for (const player of deleted) {
      const answer = mixed.result.recipients.find((recipient) => recipient.player === player);
      assert.equal(answer?.status, 'failed');
    }
    assert.deepEqual(
      partnerCalls.map((call) => call.recipients),
      [recipientsPerCall - 10 - deleted.size],
    );
    assert.ok(mixed.measured.queries <= queryCeiling);
  }

  // 22:00 in Seoul: inside the hold window, each recipient is one send-message call.
  setClock('2030-01-15T13:00:00.000Z');
  {
    partnerCalls.length = 0;
    const night = await send('event-night', audience('night'));
    assert.equal(
      night.result.summary.delivered + night.result.summary.inFlight,
      recipientsPerCall,
      JSON.stringify(night.result.summary),
    );
    assert.equal(night.result.providerCalls.batch, 0);
    assert.ok(partnerCalls.every((call) => call.url.endsWith('/send-message')));
    assert.ok(
      night.measured.queries <= queryCeiling,
      `${night.measured.queries} D1 queries for ${recipientsPerCall} single sends`,
    );
  }
  console.info('Worker bulk D1 query budget passed.');
} finally {
  globalThis.Date = RealDate;
  await miniflare.dispose();
}

async function hmacHex(key: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const sql = (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  // Statements end at `;`, except inside a trigger body (BEGIN ... END;).
  let pending = '';
  for (const piece of sql.split(';')) {
    pending = pending.length === 0 ? piece : `${pending};${piece}`;
    const statement = pending.trim();
    if (statement.length === 0) {
      pending = '';
      continue;
    }
    if (/\bCREATE\s+TRIGGER\b/iu.test(statement) && !/\bEND$/iu.test(statement)) {
      continue;
    }
    await db.prepare(statement).run();
    pending = '';
  }
}

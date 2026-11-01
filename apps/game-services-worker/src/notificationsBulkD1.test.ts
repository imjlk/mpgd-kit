import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { Miniflare } from 'miniflare';

import type { GameServicesWorkerEnv } from './handler.js';
import { createD1NotificationStore } from './notificationsD1.js';
import { bridgedD1Database, d1BridgeScript } from './testing/d1Bridge.js';
import {
  asWorkerNotificationRpcResult,
  deliverWorkerNotificationBulk,
  workerNotificationBulkBatchQueryReserve,
  workerNotificationBulkLimits,
  workerNotificationBulkQueryBudget,
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
      night.result.summary.delivered,
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
  // One FCM player with many devices: the devices go one round after the
  // other and a round batches only across players, so the call stops starting
  // rounds while 300 of its 900 queries are left and the rest stay queued.
  {
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const label = ['PRIVATE', 'KEY'].join(' ');
    const fcmSends: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'bulk-test-token', expires_in: 3600 });
      }
      if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-bulk-test/messages:send') {
        fcmSends.push(String(init?.body));
        return Response.json({ name: `projects/mpgd-bulk-test/messages/${fcmSends.length}` });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const devices = 150;
      const at = new Date().toISOString();
      const store = createD1NotificationStore(counted.db);
      for (let index = 0; index < devices; index += 1) {
        await store.putEndpoint({
          provider: 'fcm',
          installationId: `install-${String(index).padStart(3, '0')}`,
          player: 'p-devices-1',
          address: { kind: 'fcm-token', value: `token-${index}` },
          permission: 'granted',
          target: 'android',
          sessionId: `session-${index}`,
          lastRegisteredAt: at,
        });
      }
      const fcmEnv = {
        MPGD_STORE: 'd1',
        DB: counted.db,
        GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: 'k'.repeat(48),
        FCM_SERVICE_ACCOUNT: JSON.stringify({
          type: 'service_account',
          project_id: 'mpgd-bulk-test',
          private_key_id: 'bulk-test-key',
          private_key: `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END ${label}-----\n`,
          client_email: 'sender@mpgd-bulk-test.iam.gserviceaccount.com',
        }),
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
              targets: { android: { channelId: 'energy' } },
            },
          ],
        },
      } satisfies GameServicesWorkerEnv;
      counted.reset();
      const answer = await asWorkerNotificationRpcResult(() =>
        deliverWorkerNotificationBulk(fcmEnv, {
          idempotencyKey: 'event-devices',
          provider: 'fcm',
          topic: 'energy-full',
          recipients: [{ player: 'p-devices-1' }],
        }),
      );
      assert.ok(answer.ok, JSON.stringify(answer));
      const measured = counted.snapshot();
      console.info('event-devices:', measured, answer.value.summary, { sent: fcmSends.length });
      assert.equal(answer.value.summary.delivered, 1);
      assert.ok(measured.queries <= 900, `${measured.queries} D1 queries for ${devices} devices`);
      assert.ok(
        fcmSends.length > 1 && fcmSends.length < devices,
        `${fcmSends.length} devices sent`,
      );
      const queued = await store.getSend('event-devices:p-devices-1');
      assert.equal(
        queued?.send.rows.filter((row) => row.state.status === 'in-flight').length,
        devices - fcmSends.length,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  // CR1: an FCM advertising bulk under the Korean rules, whose refresh pauses
  // advertising once a re-confirmation is overdue. Every player consented
  // 25 months ago, so each check also reads the notices given; half recorded
  // the re-confirmation and are sent, half did not and are paused. The extra
  // reads share the call's batches.
  {
    setClock('2030-01-15T03:00:00.000Z');
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const label = ['PRIVATE', 'KEY'].join(' ');
    let fcmSends = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'bulk-test-token', expires_in: 3600 });
      }
      if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-bulk-test/messages:send') {
        fcmSends += 1;
        return Response.json({ name: `projects/mpgd-bulk-test/messages/${fcmSends}` });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const noticeText = (title: string) => ({
        title: `[Game] ${title}`,
        body: '{{consentDate}} 안내',
      });
      const advertisingEnv = {
        MPGD_STORE: 'd1',
        DB: counted.db,
        GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: 'k'.repeat(48),
        FCM_SERVICE_ACCOUNT: JSON.stringify({
          type: 'service_account',
          project_id: 'mpgd-bulk-test',
          private_key_id: 'bulk-test-key',
          private_key: `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END ${label}-----\n`,
          client_email: 'sender@mpgd-bulk-test.iam.gserviceaccount.com',
        }),
        MPGD_NOTIFICATIONS_DEPLOYMENT: JSON.stringify({
          advertisingRules: 'kr',
          advertisingSender: { name: 'Game', contact: '080-1234-5678' },
        }),
        MPGD_NOTIFICATIONS_CATALOG: {
          version: '2026-11-01',
          defaultLocale: 'ko',
          notices: {
            topic: 'consent-notice',
            copy: {
              ko: {
                'consent-result.advertising.granted': noticeText('동의 결과'),
                'consent-result.advertising.withdrawn': noticeText('철회 결과'),
                'consent-result.night.granted': noticeText('야간 동의 결과'),
                'consent-result.night.withdrawn': noticeText('야간 철회 결과'),
                'reconfirmation.advertising': noticeText('동의 확인'),
                'reconfirmation.night': noticeText('야간 동의 확인'),
              },
            },
          },
          topics: [
            {
              id: 'events',
              purpose: 'advertising',
              channels: ['remote'],
              route: '/?entry=events',
              optOutRoute: '/?entry=notification-settings',
              copy: { ko: { title: '이벤트', body: '새 이벤트가 시작됐어요.' } },
              targets: { ios: {} },
            },
            {
              id: 'consent-notice',
              purpose: 'service',
              channels: ['remote'],
              route: '/?entry=notification-settings',
              targets: { ios: {} },
            },
          ],
        },
      } satisfies GameServicesWorkerEnv;
      const setup = createD1NotificationStore(raw);
      /**
       * One advertising bulk to 2,500 players, half of whom are sent. The
       * baseline's consents are recent, so no check reads the notices given,
       * and its other half never consented; the paused run's consents are 25
       * months old, so every check reads the notices given, and its other
       * half did not record the re-confirmation.
       */
      const advertisingRun = async (name: string, overdue: boolean) => {
        const players = audience(name);
        for (const [index, { player }] of players.entries()) {
          await setup.putEndpoint({
            provider: 'fcm',
            installationId: `install-${player}`,
            player,
            address: { kind: 'fcm-token', value: `token-${player}` },
            permission: 'granted',
            target: 'ios',
            sessionId: `session-${player}`,
            lastRegisteredAt: new Date().toISOString(),
          });
          const sent = index % 2 === 0;
          if (!overdue && !sent) {
            continue;
          }
          const record = await setup.appendConsent({
            player,
            record: { kind: 'advertising', state: 'granted', source: 'player', textVersion: '1' },
            at: overdue ? '2027-12-01T03:00:00.000Z' : '2029-12-01T03:00:00.000Z',
          });
          if (overdue && sent) {
            // Due by 2029-11-30; recorded in the game.
            await setup.addNoticeGiven({
              kind: 'reconfirmation',
              record: { kind: 'advertising', at: record.at },
              dueBy: '2029-11-30',
              player,
              channel: 'in-game',
              at: '2029-11-20T03:00:00.000Z',
            });
          }
        }
        fcmSends = 0;
        counted.reset();
        const answer = await asWorkerNotificationRpcResult(() =>
          deliverWorkerNotificationBulk(advertisingEnv, {
            idempotencyKey: `event-${name}`,
            provider: 'fcm',
            topic: 'events',
            recipients: players,
          }),
        );
        assert.ok(answer.ok, JSON.stringify(answer));
        const measured = counted.snapshot();
        console.info(`event-${name}:`, measured, answer.value.summary, { sent: fcmSends });
        // Even indexes are sent: half, rounded up for an odd count.
        const sentCount = Math.ceil(recipientsPerCall / 2);
        assert.equal(answer.value.summary.delivered, sentCount);
        assert.equal(answer.value.summary.suppressed, recipientsPerCall - sentCount);
        assert.equal(fcmSends, sentCount);
        const reasons = new Set(
          answer.value.recipients.flatMap((recipient) =>
            recipient.status === 'answered' && recipient.outcome.status === 'suppressed'
              ? [recipient.outcome.reason]
              : [],
          ),
        );
        assert.deepEqual(
          [...reasons],
          [overdue ? 'reconfirmation-overdue' : 'advertising-consent-missing'],
        );
        return measured.queries;
      };
      const baseline = await advertisingRun('advertising-fresh', false);
      const paused = await advertisingRun('advertising-overdue', true);
      // The notices-given reads share the call's batches: the paused run stays
      // within the budget less the reserve for a batch in flight (600 of
      // D1's 1,000), and close to the baseline. One device per player sends
      // through FCM one by one, so these calls cost more than an Apps in
      // Toss bulk call, which cannot carry advertising.
      assert.ok(
        paused <= workerNotificationBulkQueryBudget - workerNotificationBulkBatchQueryReserve,
        `${paused} D1 queries for ${recipientsPerCall} advertising recipients under kr`,
      );
      assert.ok(
        paused <= baseline + Math.ceil(baseline / 5),
        `${paused} D1 queries with the notices-given reads, ${baseline} without`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
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

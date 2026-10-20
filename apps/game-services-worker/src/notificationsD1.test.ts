import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createNotificationProviderRegistry,
  createNotificationService,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteDeliveryRequest,
} from '@mpgd/game-services/notifications';
import { runNotificationStoreConformance } from '@mpgd/game-services/notifications/store-conformance';
import {
  referenceNotificationProviders,
  type NotificationConsentRecord,
} from '@mpgd/platform/notifications';
import { Miniflare } from 'miniflare';

import {
  createD1NotificationStore,
  d1NotificationPurgeBatch,
  d1NotificationPurgeMaxBatches,
} from './notificationsD1.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'notifications-store' },
});

async function applyMigration(db: D1Database): Promise<void> {
  const sql = (await Promise.all(
    ['0007_notifications.sql', '0008_notification_scheduler.sql'].map((file) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
  )).join('\n');
  // Strip comments, then run each statement.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  await applyMigration(db);
  // Applying the migration twice is harmless.
  await applyMigration(db);

  let fresh = 0;
  await runNotificationStoreConformance(async () => {
    fresh += 1;
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
  });
  assert.equal(fresh, 1);

  // Pruning more instants than one statement binds: chunked, counted, and the notices go too.
  {
    const store = createD1NotificationStore(db);
    const written: NotificationConsentRecord[] = [];
    for (let index = 0; index < 205; index += 1) {
      written.push(await store.appendConsent({
        player: 'p-chunk',
        record: { kind: 'advertising', state: index % 2 === 0 ? 'granted' : 'withdrawn', source: 'player', textVersion: 'v1' },
        at: '2026-10-19T03:00:00Z',
      }));
    }
    // Notices about records in the first, second, and third statement, and one about a kept record.
    for (const record of [0, 95, 199, 204].map((index) => written[index]).filter(
      (record) => record !== undefined,
    )) {
      await store.addNoticeGiven({
        kind: 'consent-result',
        record: { kind: 'advertising', at: record.at },
        dueBy: '2026-11-02',
        player: 'p-chunk',
        channel: 'in-game',
        at: '2026-10-20T03:00:00Z',
      });
    }
    const pruned = written.slice(0, 200).map((record) => record.at);
    assert.equal(await store.pruneConsent({ player: 'p-chunk', at: [...pruned, ...pruned] }), 200);
    assert.deepEqual(
      (await store.listConsent('p-chunk')).map((record) => record.at),
      written.slice(200).map((record) => record.at),
    );
    assert.deepEqual(
      (await store.listNoticesGiven('p-chunk')).map((notice) => notice.record.at),
      [written[204]?.at],
    );
  }

  // The service over D1: fan-out, a dead token, the key states, and consent dating.
  for (const table of [
    'notification_consent_records',
    'notification_endpoints',
    'notification_sends',
    'notification_delivery_history',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  let now = Date.parse('2026-10-19T03:00:00Z');
  const answers: NotificationRemoteDeliveryAnswer[] = [
    { status: 'accepted' },
    { status: 'unregistered' },
  ];
  const calls: NotificationRemoteDeliveryRequest[] = [];
  const store = createD1NotificationStore(db);
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      {
        entry: referenceNotificationProviders.fcm,
        delivery: {
          id: 'fcm',
          async send(request) {
            calls.push(request);
            return answers.shift() ?? { status: 'accepted' };
          },
        },
        targets: ['android'],
      },
    ]),
    catalog: {
      defaultLocale: 'ko',
      topicsFor: () => [
        {
          id: 'friend-challenge',
          purpose: 'service',
          channels: ['remote'],
          route: '/?entry=challenge',
          copy: { ko: { title: '도전', body: '도전이 왔어요.' } },
          mapping: { channelId: 'social' },
        },
      ],
    },
    now: () => new Date(now).toISOString(),
  });
  for (const installationId of ['i-1', 'i-2']) {
    await service.registerEndpoint(
      { player: 'p-1', sessionId: `s-${installationId}`, installationId },
      {
        target: 'android',
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: `tok-${installationId}`, permission: 'granted' },
          locale: 'ko-KR',
          timeZone: 'Asia/Seoul',
        },
      },
    );
  }
  const send = { idempotencyKey: 'd1-1', player: 'p-1', topic: 'friend-challenge' };
  assert.deepEqual(await service.deliver(send), { status: 'delivered', alreadyProcessed: false });
  assert.deepEqual(
    calls.map((call) => [call.idempotencyKey, call.topic.mapping, call.locale]),
    [
      ['d1-1:i-1', { channelId: 'social' }, 'ko-KR'],
      ['d1-1:i-2', { channelId: 'social' }, 'ko-KR'],
    ],
  );
  assert.deepEqual(await service.deliver(send), { status: 'delivered', alreadyProcessed: true });
  assert.equal(calls.length, 2);
  await assert.rejects(service.deliver({ ...send, locale: 'en' }), {
    code: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT',
  });
  assert.equal(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'i-2' }))?.status,
    'invalid',
  );
  const consent = await Promise.all([
    service.recordConsent(
      { player: 'p-1', sessionId: 's', installationId: 'i-1' },
      {
        kind: 'topic-preference',
        topic: 'friend-challenge',
        state: 'withdrawn',
        source: 'player',
      },
    ),
    service.recordConsent(
      { player: 'p-1', sessionId: 's', installationId: 'i-1' },
      {
        kind: 'topic-preference',
        topic: 'friend-challenge',
        state: 'granted',
        source: 'player',
      },
    ),
  ]);
  assert.deepEqual(
    consent.map((record) => record.at).sort((left, right) => Date.parse(left) - Date.parse(right)),
    ['2026-10-19T03:00:00Z', '2026-10-19T03:00:00.001Z'],
  );
  now += 31 * 86_400_000;
  assert.deepEqual(await service.purge(), { sends: 1, history: 1, endpoints: 1 });

  // Purge deletes in bounded statements, and stops after the per-call cap.
  {
    const statements: string[] = [];
    const recording = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: (batch: D1PreparedStatement[]) => db.batch(batch),
      dump: () => db.dump(),
      exec: (query: string) => db.exec(query),
    } as D1Database;
    const bounded = createD1NotificationStore(recording);
    for (const table of [
      'notification_sends',
      'notification_delivery_history',
      'notification_endpoints',
    ]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    const extra = d1NotificationPurgeBatch + 1;
    for (let index = 0; index < extra; index += 1) {
      await db.prepare(`INSERT INTO notification_sends
        (send_key, version, player_id, in_flight, changed_at_ms, send_json)
        VALUES (?, 'v', 'p-purge', 0, 1, '{}')`).bind(`purge-send-${index}`).run();
      await db.prepare(`INSERT INTO notification_delivery_history
        (send_key, provider, player_id, topic, at_ms)
        VALUES (?, 'fcm', 'p-purge', 't', 1)`).bind(`purge-hist-${index}`).run();
      await db.prepare(`INSERT INTO notification_endpoints (
          provider, installation_id, player_id, address_kind, address_value, permission, status,
          session_id, last_registered_at_ms, invalidated_at_ms, endpoint_json
        ) VALUES ('fcm', ?, 'p-purge', 'fcm-token', ?, 'granted', 'invalid', 's-purge', 1, 1, '{}')`)
        .bind(`purge-i-${index}`, `purge-tok-${index}`)
        .run();
    }
    statements.length = 0;
    const future = '2099-01-01T00:00:00Z';
    assert.deepEqual(await bounded.purge({
      sendsChangedBefore: future,
      historyBefore: future,
      invalidEndpointsBefore: future,
      staleEndpointsBefore: future,
      sessionEndpointsBefore: future,
    }), { sends: extra, history: extra, endpoints: extra });
    const deletes = statements.filter((sql) => sql.includes('rowid IN'));
    assert.ok(
      deletes.length > 0 && deletes.every((sql) => sql.includes('LIMIT ?')),
      deletes.join('\n'),
    );
    assert.equal(deletes.filter((sql) => sql.includes('notification_sends')).length, 2);
    const capped = d1NotificationPurgeBatch * d1NotificationPurgeMaxBatches;
    for (let index = 0; index < capped + 1; index += 1) {
      await db.prepare(`INSERT INTO notification_sends
        (send_key, version, player_id, in_flight, changed_at_ms, send_json)
        VALUES (?, 'v', 'p-purge', 0, 1, '{}')`).bind(`cap-send-${index}`).run();
    }
    const cappedCounts = await bounded.purge({
      sendsChangedBefore: future,
      historyBefore: future,
      invalidEndpointsBefore: future,
      staleEndpointsBefore: future,
      sessionEndpointsBefore: future,
    });
    assert.equal(cappedCounts.sends, capped);
    const left = await db.prepare('SELECT COUNT(*) AS count FROM notification_sends')
      .first<{ count: number }>();
    assert.equal(left?.count, 1);
  }
  console.info('D1 notification store passed.');
} finally {
  await miniflare.dispose();
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assertNotificationCapabilities,
  assertNotificationEventEnvelope,
  checkNotificationNightWindow,
  createNotificationNoticeIdempotencyKey,
  createNotificationReminderIdempotencyKey,
  createUnsupportedNotificationCapabilities,
  evaluateNotificationDelivery,
  listNotificationNotices,
  NotificationError,
  notificationBridgeMethods,
  notificationsProtocol,
  notificationsProtocolVersion,
  referenceNotificationProviders,
  routeNotificationReminder,
  toNotificationSubscriptionAdapter,
} from '@mpgd/platform/notifications';
import {
  assertNotificationConformanceVector,
  notificationConformanceVectorNameOf,
} from '@mpgd/platform/notifications-vectors';

assert.equal(notificationsProtocolVersion, '2.0.0-draft.1');
assert.equal(notificationsProtocol, 'mpgd.notifications.v2');
assert.equal(notificationBridgeMethods.length, 9);

const unsupported = createUnsupportedNotificationCapabilities();
assert.notEqual(createUnsupportedNotificationCapabilities(), unsupported);
assertNotificationCapabilities(unsupported);
assert.throws(() => assertNotificationCapabilities({ ...unsupported, extra: true }));
assert.throws(() => assertNotificationCapabilities({ ...unsupported, remote: { ...unsupported.remote, supported: true } }));
assert.equal(
  routeNotificationReminder({ channels: ['local', 'remote'], purpose: 'requested' }, unsupported),
  'none',
);

const gesture = new NotificationError('NOTIFICATIONS_USER_GESTURE_REQUIRED');
assert.equal(gesture.code, 'NOTIFICATIONS_USER_GESTURE_REQUIRED');
assert.equal(gesture.retryable, false);

assertNotificationEventEnvelope({
  protocol: notificationsProtocol,
  sequence: 0,
  event: { type: 'opened', channel: 'remote', source: 'cold', route: '/?entry=continue' },
});

const topic = {
  id: 'weekend-event',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events/weekend',
  optOutRoute: '/settings/notifications',
  copy: { ko: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
};
const kr = { advertisingRules: 'kr', advertisingSender: { contact: '080-1234-5678' } };
const gate = (consent, at = '2026-10-12T03:00:00Z', deployment = kr) =>
  evaluateNotificationDelivery({
    entry: referenceNotificationProviders.fcm,
    deployment,
    topic,
    recipientResolved: true,
    consent,
    endpointPermission: 'granted',
    history: [],
    at,
    timeZone: 'Asia/Seoul',
    defaultLocale: 'ko',
  });
const advertisingConsent = {
  kind: 'advertising',
  state: 'granted',
  source: 'player',
  at: '2026-10-12T03:00:00Z',
  textVersion: 'ad-consent-v1',
};
assert.deepEqual(gate([]), { status: 'suppressed', reason: 'advertising-consent-missing' });
assert.deepEqual(gate([advertisingConsent]), {
  status: 'allowed',
  content: {
    title: '(광고) 주말 이벤트',
    body: '(광고) 080-1234-5678\n주말 이벤트가 시작됐어요.\n무료 수신거부: 수신거부 버튼',
    route: '/events/weekend',
    actions: [{ id: 'advertising-opt-out', title: '수신거부', route: '/settings/notifications' }],
    source: 'catalog',
  },
  expiresAt: '2026-10-12T12:00:00Z',
});
assert.deepEqual(gate([advertisingConsent], undefined, { advertisingRules: 'kr' }), {
  status: 'suppressed',
  reason: 'advertising-sender-missing',
});
assert.deepEqual(gate([advertisingConsent], '2026-10-12T13:00:00Z'), {
  status: 'deferred',
  reason: 'night-window',
  until: '2026-10-12T23:00:00Z',
});
assert.equal(gate([advertisingConsent], '2026-10-12T13:00:00Z', { advertisingRules: 'none' }).status, 'allowed');
assert.deepEqual(
  evaluateNotificationDelivery({
    entry: referenceNotificationProviders.fcm,
    topic: undefined,
    recipientResolved: true,
    consent: [],
    history: [],
    at: '2026-10-12T03:00:00Z',
    defaultLocale: 'ko',
  }),
  { status: 'suppressed', reason: 'topic-unknown' },
);
assert.deepEqual(checkNotificationNightWindow('2026-10-12T23:00:00Z'), { inside: false });
assert.deepEqual(
  listNotificationNotices([advertisingConsent], [], '2026-10-12T03:00:00Z')
    .map((notice) => [notice.kind, notice.dueBy]),
  [['consent-result', '2026-10-26']],
);
// A re-confirmation is listed from 60 days before its due date.
assert.deepEqual(
  listNotificationNotices([advertisingConsent], [], '2028-08-11T15:00:00Z')
    .map((notice) => [notice.kind, notice.dueBy]),
  [['consent-result', '2026-10-26'], ['reconfirmation', '2028-10-11']],
);
assert.equal(
  createNotificationNoticeIdempotencyKey({
    player: 'p-1',
    kind: 'reconfirmation',
    record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' },
    dueBy: '2028-10-11',
  }),
  'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2028-10-11',
);
assert.equal(
  createNotificationReminderIdempotencyKey({ player: 'p-1', key: 'energy', fireAt: '2026-10-12T06:00:00.000Z' }),
  'reminder:p-1:energy:2026-10-12T06:00:00Z',
);

const requests = [];
const adapter = toNotificationSubscriptionAdapter({
  async getPermission() {
    return { topics: { 'daily-ready': 'granted' }, sources: { 'daily-ready': 'record' } };
  },
  async requestPermission(input) {
    requests.push(input);
    return { snapshot: { topics: {} }, outcomes: { 'daily-ready': 'dismissed' } };
  },
}, [{ id: 'daily-ready' }]);
assert.equal(await adapter.getStatus('daily-ready'), 'subscribed');
assert.equal(await adapter.requestSubscription('daily-ready'), 'unavailable');
assert.deepEqual(requests, [{ topics: ['daily-ready'], gesture: true }]);
assert.equal(await adapter.getStatus('streak-at-risk'), 'configuration-required');

const vectorPath = new URL(
  '../../../docs/specs/notifications/vectors/os-permission-granted.json', import.meta.url,
);
const vector = assertNotificationConformanceVector(JSON.parse(readFileSync(vectorPath, 'utf8')));
assert.equal(vector.vector, notificationConformanceVectorNameOf(vectorPath.pathname));
assert.equal(vector.protocol, notificationsProtocolVersion);
console.info('Notifications contract and vector dist entrypoints passed.');

import { describe, expect, it } from 'vitest';

import {
  applyNotificationAdvertisingLabel,
  checkNotificationNightWindow,
  checkNotificationQuietHours,
  createNotificationNoticeIdempotencyKey,
  createNotificationReminderIdempotencyKey,
  evaluateLocalNotificationReminder,
  evaluateNotificationDelivery,
  evaluateNotificationReminderConsent,
  fillNotificationTemplate,
  findNotificationCopy,
  isNotificationCalendarDate,
  isRecordableNotificationPermissionState,
  isRootRelativeNotificationRoute,
  isSameNotificationNotice,
  latestNotificationConsent,
  listNotificationNotices,
  normalizeNotificationTimestamp,
  notificationConsentResultDueBy,
  notificationKeyIssue,
  notificationNoticeSendFrom,
  notificationPermissionConsentKind,
  notificationPermissionStateOf,
  notificationReconfirmationDueBy,
  notificationReconfirmationListDays,
  notificationRegistryMismatch,
  notificationReservedKeyPrefix,
  notificationSendFingerprint,
  notificationTemplateDataIssue,
  notificationTopicDefinitionIssues,
  notificationTopicNeedsNoAgreement,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
  renderNotificationAdvertisement,
  resolveNotificationAdvertisingSettings,
  resolveNotificationContent,
  routeNotificationReminder,
  toSeoulCalendarDate,
  type EvaluateNotificationDeliveryInput,
  type NotificationConsentRecord,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationNoticeIdentity,
  type NotificationTopicDeclaration,
} from './notifications-policy.js';

import type { NotificationCapabilities } from './notifications-contract.js';

const noon = '2026-10-12T03:00:00Z'; // 12:00 Asia/Seoul
const tenPm = '2026-10-12T13:00:00Z'; // 22:00 Asia/Seoul

/** A record of any kind; the cast spares each test the full union's fields. */
const record = (
  kind: NotificationConsentRecord['kind'],
  state: NotificationConsentRecord['state'],
  extra: Readonly<Record<string, unknown>> = {},
): NotificationConsentRecord =>
  ({
    kind,
    state,
    source: kind === 'topic-preference' || kind === 'advertising' || kind === 'night'
      ? 'player'
      : 'client-report',
    at: '2026-10-12T01:00:00Z',
    ...(kind === 'advertising' || kind === 'night' ? { textVersion: 'ads-v1' } : {}),
    ...extra,
  }) as NotificationConsentRecord;

const fcm: NotificationDeliveryProviderEntry = referenceNotificationProviders.fcm;
const hostTemplate: NotificationDeliveryProviderEntry = referenceNotificationProviders['apps-in-toss'];
const devvit: NotificationDeliveryProviderEntry = referenceNotificationProviders.devvit;
const perSend: NotificationDeliveryProviderEntry = {
  ...hostTemplate,
  provider: 'fixture.per-send',
  permission: { scope: 'topic', serverReadable: false, allowance: 'per-send' },
};
const appUser: NotificationDeliveryProviderEntry = {
  ...devvit,
  provider: 'fixture.app-user',
  permission: { scope: 'app', serverReadable: false, allowance: 'persistent' },
  link: false,
};
const kr: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-1234-5678' },
};

const service: NotificationTopicDeclaration = {
  id: 'rival-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  copy: {
    ko: { title: '새 도전장', body: '{{rival}}님이 도전장을 보냈어요.' },
    en: { title: 'New challenge', body: '{{rival}} sent you a challenge.' },
  },
  mapping: { channelId: 'social' },
};
const requested: NotificationTopicDeclaration = {
  id: 'energy-full',
  purpose: 'requested',
  channels: ['local', 'remote'],
  route: '/?entry=continue',
  copy: { ko: { title: '에너지 충전 완료', body: '에너지가 가득 찼어요.' } },
};
const advertising: NotificationTopicDeclaration = {
  id: 'weekend-event',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events/weekend',
  optOutRoute: '/settings/notifications',
  copy: { ko: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
};
const optIn = record('topic-preference', 'granted', { topic: 'energy-full' });
const optOut = record('topic-preference', 'withdrawn', { topic: 'energy-full' });

function input(patch: Partial<EvaluateNotificationDeliveryInput> = {}): EvaluateNotificationDeliveryInput {
  return {
    entry: fcm,
    deployment: kr,
    topic: service,
    recipientResolved: true,
    consent: [],
    endpointPermission: 'granted',
    history: [],
    at: noon,
    timeZone: 'Asia/Seoul',
    defaultLocale: 'ko',
    templateData: { rival: 'Mina' },
    ...patch,
  };
}

describe('evaluateNotificationDelivery', () => {
  it('allows a service send with catalog copy in the delivery locale', () => {
    expect(evaluateNotificationDelivery(input({ locale: 'en' }))).toEqual({
      status: 'allowed',
      content: {
        title: 'New challenge',
        body: 'Mina sent you a challenge.',
        route: '/?entry=challenge',
        source: 'catalog',
      },
    });
  });

  it('step 1: refuses an undeclared topic, a topic without the remote channel, and an unsupported purpose', () => {
    expect(evaluateNotificationDelivery(input({ topic: undefined })))
      .toEqual({ status: 'suppressed', reason: 'topic-unknown' });
    // The first failing step decides: an unresolved recipient does not matter yet.
    expect(evaluateNotificationDelivery(input({ topic: undefined, recipientResolved: false })))
      .toEqual({ status: 'suppressed', reason: 'topic-unknown' });
    // The channel is checked before the purpose.
    expect(evaluateNotificationDelivery(input({
      entry: hostTemplate,
      topic: { ...advertising, channels: ['local'] },
    }))).toEqual({ status: 'suppressed', reason: 'channel-unsupported' });
    const unsupported = { status: 'suppressed', reason: 'purpose-unsupported' };
    expect(evaluateNotificationDelivery(input({ entry: hostTemplate, topic: advertising })))
      .toEqual(unsupported);
    // A host-template provider cannot carry the advertising label even if it lists the purpose.
    expect(evaluateNotificationDelivery(input({
      entry: { ...hostTemplate, purposes: ['service', 'requested', 'advertising'] },
      topic: advertising,
    }))).toEqual(unsupported);
    // Under the Korean rules advertising also needs an expiry and the opt-out action.
    for (const entry of [{ ...fcm, expiry: false }, { ...fcm, actions: false }]) {
      expect(evaluateNotificationDelivery(input({ entry, topic: advertising }))).toEqual(unsupported);
      expect(evaluateNotificationDelivery(input({
        entry,
        topic: advertising,
        deployment: { advertisingRules: 'none' },
      }))).toEqual({ status: 'suppressed', reason: 'advertising-consent-missing' });
    }
  });

  it('step 2: answers no-endpoint without a recipient and link-missing without a link where one is needed', () => {
    expect(evaluateNotificationDelivery(input({ recipientResolved: false })))
      .toEqual({ status: 'unavailable', reason: 'no-endpoint' });
    const devvitTopic = { ...service, mapping: { title: 'Duel', body: '{{rival}} wants a duel.' } };
    const devvitInput = input({ entry: devvit, topic: devvitTopic, serverPermission: 'granted' });
    expect(evaluateNotificationDelivery(devvitInput))
      .toEqual({ status: 'unavailable', reason: 'link-missing' });
    expect(evaluateNotificationDelivery({ ...devvitInput, link: 't3_abc' }).status).toBe('allowed');
    expect(evaluateNotificationDelivery({
      ...devvitInput,
      topic: { ...devvitTopic, mapping: { ...devvitTopic.mapping, link: 't3_abc' } },
    }).status).toBe('allowed');
  });

  it('step 3: a device endpoint needs the permission its latest registration reported', () => {
    // The endpoint decides; delivery-permission records do not.
    expect(evaluateNotificationDelivery(input({
      consent: [record('delivery-permission', 'denied')],
    })).status).toBe('allowed');
    for (const state of ['denied', 'blocked', 'prompt-with-rationale', 'prompt', 'unknown'] as const) {
      expect(evaluateNotificationDelivery(input({ endpointPermission: state })))
        .toEqual({ status: 'suppressed', reason: 'permission-denied' });
    }
    const { endpointPermission: _endpointPermission, ...unreported } = input();
    expect(evaluateNotificationDelivery(unreported))
      .toEqual({ status: 'suppressed', reason: 'permission-denied' });
  });

  it('step 3: an app-scope platform-user provider needs a granted latest delivery-permission record', () => {
    const topic = { ...service, mapping: { title: 'Duel', body: 'A duel.' } };
    expect(evaluateNotificationDelivery(input({ entry: appUser, topic })))
      .toEqual({ status: 'suppressed', reason: 'permission-denied' });
    for (const state of ['denied', 'blocked', 'prompt-with-rationale'] as const) {
      expect(evaluateNotificationDelivery(input({
        entry: appUser,
        topic,
        consent: [record('delivery-permission', 'granted'), record('delivery-permission', state)],
      }))).toEqual({ status: 'suppressed', reason: 'permission-denied' });
    }
    expect(evaluateNotificationDelivery(input({
      entry: appUser,
      topic,
      consent: [record('delivery-permission', 'denied'), record('delivery-permission', 'granted')],
    })).status).toBe('allowed');
  });

  it('step 3: a server-readable provider decides by the send-time host answer only', () => {
    const base = input({
      entry: devvit,
      topic: { ...service, mapping: { title: 'Duel', body: '{{rival}} wants a duel.', link: 't3_abc' } },
      consent: [record('delivery-permission', 'denied')],
    });
    expect(evaluateNotificationDelivery({ ...base, serverPermission: 'granted' }).status).toBe('allowed');
    for (const state of ['denied', 'prompt', 'unknown', 'action-required'] as const) {
      expect(evaluateNotificationDelivery({ ...base, serverPermission: state }))
        .toEqual({ status: 'suppressed', reason: 'permission-denied' });
    }
    expect(() => evaluateNotificationDelivery(base)).toThrow(/needs the host answer at send time/u);
  });

  it('step 3: a topic-scope provider needs a granted host agreement unless the topic needs none', () => {
    const topic = { ...requested, mapping: { templateSetCode: 'energy', agreement: 'required' } };
    const agreed = record('host-agreement', 'granted', { topic: 'energy-full' });
    expect(evaluateNotificationDelivery(input({ entry: hostTemplate, topic, consent: [optIn] })))
      .toEqual({ status: 'suppressed', reason: 'agreement-missing' });
    expect(evaluateNotificationDelivery(input({
      entry: hostTemplate,
      topic,
      consent: [record('host-agreement', 'granted', { topic: 'other-topic' }), optIn],
    }))).toEqual({ status: 'suppressed', reason: 'agreement-missing' });
    // A provider's rejection appends a denial that outranks the earlier agreement.
    expect(evaluateNotificationDelivery(input({
      entry: hostTemplate,
      topic,
      consent: [agreed, optIn, record('host-agreement', 'denied', { topic: 'energy-full', source: 'provider' })],
    }))).toEqual({ status: 'suppressed', reason: 'agreement-missing' });
    expect(evaluateNotificationDelivery(input({ entry: hostTemplate, topic, consent: [agreed, optIn] })))
      .toEqual({ status: 'allowed', content: { route: '/?entry=continue', source: 'host-template' } });
    const { copy: _copy, ...withoutCopy } = service;
    const receipt: NotificationTopicDeclaration = {
      ...withoutCopy,
      mapping: { templateSetCode: 'receipt', agreement: 'none' },
    };
    expect(evaluateNotificationDelivery(input({ entry: hostTemplate, topic: receipt })))
      .toEqual({ status: 'allowed', content: { route: '/?entry=challenge', source: 'host-template' } });
  });

  it('step 3: a per-send provider allows one delivery per acceptance', () => {
    const topic = { ...requested, mapping: { templateSetCode: 'energy', agreement: 'required' } };
    const accepted = record('host-agreement', 'granted', { topic: 'energy-full' });
    const sent = { provider: 'fixture.per-send', topic: 'energy-full', at: noon };
    expect(evaluateNotificationDelivery(input({ entry: perSend, topic, consent: [accepted, optIn] })).status)
      .toBe('allowed');
    expect(evaluateNotificationDelivery(input({
      entry: perSend,
      topic,
      consent: [accepted, optIn],
      history: [sent],
    }))).toEqual({ status: 'suppressed', reason: 'allowance-exhausted' });
    expect(evaluateNotificationDelivery(input({
      entry: perSend,
      topic,
      consent: [accepted, accepted, optIn],
      history: [sent],
    })).status).toBe('allowed');
    // Sends of another topic or by another provider do not use this topic's acceptance.
    expect(evaluateNotificationDelivery(input({
      entry: perSend,
      topic,
      consent: [accepted, optIn],
      history: [{ ...sent, topic: 'other' }, { ...sent, provider: 'fcm' }],
    })).status).toBe('allowed');
  });

  it('step 4: only topic-preference records decide, and the latest one wins', () => {
    expect(evaluateNotificationDelivery(input({ topic: requested })))
      .toEqual({ status: 'suppressed', reason: 'request-missing' });
    expect(evaluateNotificationDelivery(input({ topic: requested, consent: [optIn] })).status).toBe('allowed');
    expect(evaluateNotificationDelivery(input({ topic: requested, consent: [optIn, optOut] })))
      .toEqual({ status: 'suppressed', reason: 'preference-off' });
    expect(evaluateNotificationDelivery(input({ topic: requested, consent: [optOut, optIn] })).status)
      .toBe('allowed');
    expect(evaluateNotificationDelivery(input({
      consent: [record('topic-preference', 'withdrawn', { topic: 'rival-challenge' })],
    }))).toEqual({ status: 'suppressed', reason: 'preference-off' });
    // An opt-in for another topic is not this topic's opt-in.
    expect(evaluateNotificationDelivery(input({
      topic: requested,
      consent: [record('topic-preference', 'granted', { topic: 'rival-challenge' })],
    }))).toEqual({ status: 'suppressed', reason: 'request-missing' });
    // A granted host agreement is not an opt-in: the runtime writes the preference with it.
    const topic = { ...requested, mapping: { templateSetCode: 'energy', agreement: 'required' } };
    expect(evaluateNotificationDelivery(input({
      entry: hostTemplate,
      topic,
      consent: [record('host-agreement', 'granted', { topic: 'energy-full' })],
    }))).toEqual({ status: 'suppressed', reason: 'request-missing' });
  });

  it('step 5: advertising needs a granted latest advertising record', () => {
    expect(evaluateNotificationDelivery(input({ topic: advertising })))
      .toEqual({ status: 'suppressed', reason: 'advertising-consent-missing' });
    expect(evaluateNotificationDelivery(input({
      topic: advertising,
      consent: [record('advertising', 'granted'), record('advertising', 'withdrawn')],
    }))).toEqual({ status: 'suppressed', reason: 'advertising-consent-missing' });
    // Advertising consent outranks the night window: step 5 runs before step 6.
    expect(evaluateNotificationDelivery(input({ topic: advertising, at: tenPm })))
      .toEqual({ status: 'suppressed', reason: 'advertising-consent-missing' });
  });

  it('step 6: under the Korean rules defers advertising in the night window without night consent', () => {
    const consent = [record('advertising', 'granted')];
    expect(evaluateNotificationDelivery(input({ topic: advertising, consent, at: tenPm })))
      .toEqual({ status: 'deferred', reason: 'night-window', until: '2026-10-12T23:00:00Z' });
    expect(evaluateNotificationDelivery(input({
      topic: advertising,
      consent: [...consent, record('night', 'granted')],
      at: tenPm,
    })).status).toBe('allowed');
    expect(evaluateNotificationDelivery(input({
      topic: { ...advertising, deferrable: false },
      consent,
      at: tenPm,
    }))).toEqual({ status: 'suppressed', reason: 'night-consent-missing' });
    // The window holds neither other purposes nor a deployment without the Korean rules.
    expect(evaluateNotificationDelivery(input({ at: tenPm })).status).toBe('allowed');
    expect(evaluateNotificationDelivery(input({
      topic: advertising,
      consent,
      at: tenPm,
      deployment: { advertisingRules: 'none' },
    })).status).toBe('allowed');
    // A deployment that never chose its rules fails closed for advertising, and only for it.
    expect(() => evaluateNotificationDelivery(input({ topic: advertising, consent, deployment: {} })))
      .toThrow(/needs the deployment's advertisingRules/u);
    const { deployment: _deployment, ...undeployed } = input({ topic: advertising, consent });
    expect(() => evaluateNotificationDelivery(undeployed)).toThrow(/advertisingRules/u);
    expect(evaluateNotificationDelivery({ ...input(), deployment: {} }).status).toBe('allowed');
  });

  it('step 6: quiet hours hold any purpose in the recipient zone', () => {
    const quiet = { ...service, quietHours: { start: '22:00', end: '08:00' } };
    expect(evaluateNotificationDelivery(input({ topic: quiet, at: '2026-10-12T13:30:00Z' })))
      .toEqual({ status: 'deferred', reason: 'quiet-hours', until: '2026-10-12T23:00:00Z' });
    expect(evaluateNotificationDelivery(input({
      topic: quiet,
      at: '2026-10-12T13:30:00Z',
      timeZone: 'Europe/London',
    })).status).toBe('allowed');
    // Without a registered zone the deployment's zone decides.
    const { timeZone: _zone, ...unzoned } = input({ topic: quiet, at: '2026-10-12T13:30:00Z' });
    expect(evaluateNotificationDelivery({ ...unzoned, deployment: { timeZone: 'Europe/London' } }).status)
      .toBe('allowed');
    expect(evaluateNotificationDelivery(unzoned).status).toBe('deferred');
    expect(evaluateNotificationDelivery(input({
      topic: { ...quiet, deferrable: false },
      at: '2026-10-12T13:30:00Z',
    }))).toEqual({ status: 'suppressed', reason: 'quiet-hours' });
    expect(evaluateNotificationDelivery(input({
      topic: { ...advertising, quietHours: { start: '12:00', end: '13:00' } },
      consent: [record('advertising', 'granted'), record('night', 'granted')],
    }))).toEqual({ status: 'deferred', reason: 'quiet-hours', until: '2026-10-12T04:00:00Z' });
    // Quiet hours that close where the night window opens leave advertising
    // without night consent no time to send: suppressed, never deferred forever.
    const daytimeQuiet = { ...advertising, quietHours: { start: '08:00', end: '21:00' } };
    expect(evaluateNotificationDelivery(input({
      topic: daytimeQuiet,
      consent: [record('advertising', 'granted')],
    }))).toEqual({ status: 'suppressed', reason: 'night-consent-missing' });
    expect(evaluateNotificationDelivery(input({
      topic: daytimeQuiet,
      consent: [record('advertising', 'granted'), record('night', 'granted')],
    }))).toEqual({ status: 'deferred', reason: 'quiet-hours', until: '2026-10-12T12:00:00Z' });
  });

  it('step 7: caps the topic frequency first, then the provider limits over rolling windows', () => {
    const capped = { ...service, frequency: { maxPerDay: 1 } };
    const sent = (at: string, topic = 'rival-challenge') => ({ provider: 'fcm', topic, at });
    const daily = { ...fcm, limits: [{ count: 2, windowSeconds: 86_400 }] };
    const minute = { ...fcm, limits: [{ count: 2, windowSeconds: 60 }] };
    expect(evaluateNotificationDelivery(input({ topic: capped, history: [sent('2026-10-11T03:00:01Z')] })))
      .toEqual({ status: 'suppressed', reason: 'frequency-capped' });
    // A send at s counts for a send at t when t - window < s <= t.
    expect(evaluateNotificationDelivery(input({ topic: capped, history: [sent('2026-10-11T03:00:00Z')] })).status)
      .toBe('allowed');
    expect(evaluateNotificationDelivery(input({
      topic: capped,
      entry: daily,
      history: [sent(noon), sent(noon, 'other')],
    }))).toEqual({ status: 'suppressed', reason: 'frequency-capped' });
    expect(evaluateNotificationDelivery(input({
      entry: daily,
      history: [sent(noon, 'other'), sent(noon, 'another')],
    }))).toEqual({ status: 'suppressed', reason: 'provider-limit' });
    // A window shorter than a day defers until the oldest counted send leaves it.
    expect(evaluateNotificationDelivery(input({
      entry: minute,
      history: [sent('2026-10-12T02:59:10Z', 'other'), sent('2026-10-12T02:59:40Z', 'other')],
    }))).toEqual({ status: 'deferred', reason: 'provider-limit', until: '2026-10-12T03:00:10Z' });
    expect(evaluateNotificationDelivery(input({
      entry: minute,
      history: [sent('2026-10-12T02:59:00Z', 'other'), sent('2026-10-12T02:59:40Z', 'other')],
    })).status).toBe('allowed');
    // Another provider's sends do not count against this provider's limits.
    expect(evaluateNotificationDelivery(input({
      entry: minute,
      history: [{ ...sent(noon), provider: 'apps-in-toss' }, { ...sent(noon), provider: 'apps-in-toss' }],
    })).status).toBe('allowed');
    // A full limit of a day or longer suppresses whatever the order of the limits,
    // and full shorter limits defer until every one of them has room.
    const recent = [sent('2026-10-12T02:59:20Z'), sent('2026-10-12T02:59:30Z'), sent('2026-10-12T02:59:40Z')];
    for (const limits of [
      [{ count: 2, windowSeconds: 60 }, { count: 3, windowSeconds: 86_400 }],
      [{ count: 3, windowSeconds: 86_400 }, { count: 2, windowSeconds: 60 }],
    ]) {
      expect(evaluateNotificationDelivery(input({ entry: { ...fcm, limits }, history: recent })))
        .toEqual({ status: 'suppressed', reason: 'provider-limit' });
    }
    expect(evaluateNotificationDelivery(input({
      entry: { ...fcm, limits: [{ count: 3, windowSeconds: 60 }, { count: 1, windowSeconds: 120 }] },
      history: recent,
    }))).toEqual({ status: 'deferred', reason: 'provider-limit', until: '2026-10-12T03:01:40Z' });
  });

  it('step 8: under the Korean rules renders advertising with the label, sender, opt-out line and action, and expiry', () => {
    const consent = [record('advertising', 'granted')];
    expect(evaluateNotificationDelivery(input({ topic: advertising, consent }))).toEqual({
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
    // Night consent removes the expiry; the deployment can name the sender and the opt-out line.
    const named = evaluateNotificationDelivery(input({
      topic: advertising,
      consent: [...consent, record('night', 'granted')],
      at: tenPm,
      deployment: {
        advertisingRules: 'kr',
        advertisingSender: { name: ' Puzzle Studio ', contact: ' 080-000-0000 ' },
        advertisingOptOutLine: '무료 수신거부: 설정 > 알림',
      },
    }));
    expect(named).toEqual({
      status: 'allowed',
      content: expect.objectContaining({
        body: '(광고) Puzzle Studio 080-000-0000\n주말 이벤트가 시작됐어요.\n무료 수신거부: 설정 > 알림',
      }),
    });
    // From 08:00 the expiry is the next 21:00.
    expect(evaluateNotificationDelivery(input({ topic: advertising, consent, at: '2026-10-12T23:00:00Z' })))
      .toMatchObject({ status: 'allowed', expiresAt: '2026-10-13T12:00:00Z' });
    for (const deployment of [{ advertisingRules: 'kr' }, { ...kr, advertisingSender: { contact: ' ' } }] as const) {
      expect(evaluateNotificationDelivery(input({ topic: advertising, consent, deployment })))
        .toEqual({ status: 'suppressed', reason: 'advertising-sender-missing' });
    }
    // A blank name is left out of the sender line, and a blank opt-out line gives way to the default.
    expect(evaluateNotificationDelivery(input({
      topic: advertising,
      consent,
      deployment: { ...kr, advertisingSender: { name: ' ', contact: '080-1234-5678' }, advertisingOptOutLine: ' \t' },
    }))).toMatchObject({
      status: 'allowed',
      content: { body: '(광고) 080-1234-5678\n주말 이벤트가 시작됐어요.\n무료 수신거부: 수신거부 버튼' },
    });
    // Step 7 decides before step 8.
    expect(evaluateNotificationDelivery(input({
      topic: { ...advertising, frequency: { maxPerDay: 1 } },
      consent,
      deployment: { advertisingRules: 'kr' },
      history: [{ provider: 'fcm', topic: 'weekend-event', at: noon }],
    }))).toEqual({ status: 'suppressed', reason: 'frequency-capped' });
    // Without the Korean rules advertising goes out as written, with no label, sender, or expiry.
    expect(evaluateNotificationDelivery(input({
      topic: advertising,
      consent,
      deployment: { advertisingRules: 'none' },
    }))).toEqual({
      status: 'allowed',
      content: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.', route: '/events/weekend', source: 'catalog' },
    });
    const { optOutRoute: _optOutRoute, ...withoutOptOut } = advertising;
    expect(() => evaluateNotificationDelivery(input({ topic: withoutOptOut, consent })))
      .toThrow(/declares no optOutRoute/u);
  });
});

describe('notification topic routes', () => {
  const base = 'https://mpgd.invalid';
  // Each passes a same-origin check against a placeholder base, yet resolves to
  // a protocol-relative pathname that a client opens as a link to another host.
  const protocolRelativeOnceResolved = [
    '/.//evil.example/x',
    '/levels/..//evil.example/x',
    '/%2e//evil.example/x',
    '/./\\evil.example/x',
  ];

  it('refuses a route that resolves to a protocol-relative path', () => {
    for (const route of protocolRelativeOnceResolved) {
      const resolved = new URL(route, base);
      expect(resolved.origin).toBe(base);
      expect(resolved.pathname).toBe('//evil.example/x');
      expect(isRootRelativeNotificationRoute(route)).toBe(false);
      const topic = { ...service, route, purpose: 'advertising', optOutRoute: route } as const;
      expect(notificationTopicDefinitionIssues(topic).map((issue) => issue.path))
        .toEqual(['topic.route', 'topic.optOutRoute']);
    }
  });

  it('refuses a route a client that decodes the path would open on another host', () => {
    for (const route of ['/%2F%2Fevil.example/x', '/%2fevil.example', '/%5Cevil.example', '/%09/evil.example']) {
      // A URL parser keeps the encoded path on the game's origin...
      const resolved = new URL(route, base);
      expect(resolved.origin).toBe(base);
      // ...but decoded once it starts with `//`, holds a backslash, or a tab a parser drops.
      const decoded = decodeURIComponent(resolved.pathname);
      expect(new URL(decoded, base).origin === base && !decoded.includes('\\')).toBe(false);
      expect(isRootRelativeNotificationRoute(route), route).toBe(false);
    }
    // Decoded dot segments and paths that cannot be decoded are refused too.
    for (const route of ['/levels/%252e%252e', '/50%', '/%E0%A4%A']) {
      expect(isRootRelativeNotificationRoute(route), route).toBe(false);
    }
  });

  it('accepts root-relative routes that resolve to themselves on the game origin', () => {
    for (const route of [
      '/',
      '/?entry=continue',
      '/events/weekend/',
      '/a/b?c=d#e',
      '/?next=//evil.example',
      '/levels/%2e1',
      '/a%20b',
      '/levels/%E2%9C%93',
    ]) {
      expect(isRootRelativeNotificationRoute(route)).toBe(true);
      const resolved = new URL(route, base);
      expect(resolved.origin).toBe(base);
      expect(resolved.pathname.startsWith('//')).toBe(false);
      expect(`${resolved.pathname}${resolved.search}${resolved.hash}`).toBe(route);
    }
  });

  it('refuses dot segments in any spelling, backslashes, control characters, and other origins', () => {
    for (const route of [
      '',
      'events/weekend',
      'https://example.com/',
      '//evil.example/path',
      '/\\evil.example',
      '/a/../b',
      '/./a',
      '/a/..',
      '/%2E/a',
      '/a/%2e%2E/b',
      '/a/.%2e',
      '/a/%2e.',
      ' /padded',
      '/\t/evil.example',
      '/line\nbreak',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(isRootRelativeNotificationRoute(route), JSON.stringify(route)).toBe(false);
    }
  });

  it('refuses advertising on the local channel and the reserved __proto__ id', () => {
    expect(notificationTopicDefinitionIssues({ ...advertising, channels: ['local', 'remote'] }))
      .toEqual([{ path: 'topic.channels', message: expect.stringMatching(/may not use the local channel/u) }]);
    expect(notificationTopicDefinitionIssues({ ...service, id: '__proto__' }).map((issue) => issue.path))
      .toEqual(['topic.id']);
    expect(notificationTopicDefinitionIssues({ ...service, quietHours: { start: '22:00', end: '22:00' } })
      .map((issue) => issue.path)).toEqual(['topic.quietHours']);
    expect(notificationTopicDefinitionIssues(requested)).toEqual([]);
  });
});

describe('notification content', () => {
  it('finds copy by locale, then its language, then the default locale, ignoring case', () => {
    const copy = (title: string) => ({ title, body: title });
    const topic = { copy: { ko: copy('ko'), en: copy('en'), 'pt-BR': copy('pt') } };
    expect(findNotificationCopy(topic, 'en-US', 'ko')?.title).toBe('en');
    expect(findNotificationCopy(topic, 'en_GB', 'ko')?.title).toBe('en');
    expect(findNotificationCopy(topic, 'EN', 'ko')?.title).toBe('en');
    expect(findNotificationCopy(topic, 'pt-br', 'ko')?.title).toBe('pt');
    expect(findNotificationCopy(topic, 'fr', 'ko')?.title).toBe('ko');
    expect(findNotificationCopy(topic, undefined, 'KO')?.title).toBe('ko');
    expect(findNotificationCopy({}, 'en', 'ko')).toBeUndefined();
  });

  it('prefers mapping copy, then the host template, then catalog copy with a default-locale fallback', () => {
    const base = { content: 'free-form', defaultLocale: 'ko', templateData: { rival: 'Jun' } } as const;
    expect(resolveNotificationContent({
      ...base,
      topic: { ...service, mapping: { title: 'Duel', body: '{{rival}} wants a duel.' } },
    })).toEqual({ title: 'Duel', body: 'Jun wants a duel.', route: '/?entry=challenge', source: 'mapping' });
    expect(resolveNotificationContent({ ...base, topic: service, content: 'host-template' }))
      .toEqual({ route: '/?entry=challenge', source: 'host-template' });
    expect(resolveNotificationContent({ ...base, topic: service, locale: 'fr' }))
      .toMatchObject({ title: '새 도전장', body: 'Jun님이 도전장을 보냈어요.' });
    const { copy: _copy, ...withoutCopy } = service;
    expect(() => resolveNotificationContent({ ...base, topic: withoutCopy }))
      .toThrow(/has no copy for ko/u);
  });

  it('fills placeholders with strings, numbers, and booleans and refuses a missing value', () => {
    expect(fillNotificationTemplate('{{ a }}, {{b}}, {{c}}', { a: 1, b: 'two', c: false }))
      .toBe('1, two, false');
    expect(fillNotificationTemplate('no placeholders')).toBe('no placeholders');
    expect(() => fillNotificationTemplate('{{missing}}', {})).toThrow(/no value for \{\{missing\}\}/u);
    expect(() => fillNotificationTemplate('{{toString}}', {})).toThrow(/no value/u);
  });

  it('puts (광고) and one space before the text, once', () => {
    expect(applyNotificationAdvertisingLabel('Sale')).toBe('(광고) Sale');
    expect(applyNotificationAdvertisingLabel('(광고) Sale')).toBe('(광고) Sale');
    expect(applyNotificationAdvertisingLabel('(광고)Sale')).toBe('(광고) Sale');
    expect(applyNotificationAdvertisingLabel(' (광고)  Sale')).toBe('(광고) Sale');
    expect(applyNotificationAdvertisingLabel('  Sale')).toBe('(광고) Sale');
  });

  it('renders an advertisement around host-free content and keeps a body-less one body-less', () => {
    const content = { title: 'Sale', body: 'Today only.', route: '/events/weekend', source: 'catalog' } as const;
    expect(renderNotificationAdvertisement(advertising, content, { name: 'Studio', contact: '080' })).toEqual({
      title: '(광고) Sale',
      body: '(광고) Studio 080\nToday only.\n무료 수신거부: 수신거부 버튼',
      route: '/events/weekend',
      actions: [{ id: 'advertising-opt-out', title: '수신거부', route: '/settings/notifications' }],
      source: 'catalog',
    });
    expect(renderNotificationAdvertisement(
      advertising,
      { route: '/events/weekend', source: 'host-template' },
      { contact: '080' },
    )).toEqual({
      route: '/events/weekend',
      actions: [{ id: 'advertising-opt-out', title: '수신거부', route: '/settings/notifications' }],
      source: 'host-template',
    });
    expect(() => renderNotificationAdvertisement(advertising, content, { contact: '  ' }))
      .toThrow(/sender contact that is not blank/u);
  });

  it('reads the advertising settings the way gate step 8 does, and names each field it cannot use', () => {
    expect(resolveNotificationAdvertisingSettings(kr)).toEqual({
      sender: { contact: '080-1234-5678' },
      optOutLine: '무료 수신거부: 수신거부 버튼',
      issues: [],
    });
    expect(resolveNotificationAdvertisingSettings({
      advertisingRules: 'kr',
      advertisingSender: { name: ' Studio ', contact: ' 080 ' },
      advertisingOptOutLine: ' 무료 수신거부: 설정 > 알림 ',
    })).toEqual({
      sender: { name: 'Studio', contact: '080' },
      optOutLine: '무료 수신거부: 설정 > 알림',
      issues: [],
    });
    const blank = resolveNotificationAdvertisingSettings({
      advertisingRules: 'kr',
      advertisingSender: { name: '\t', contact: ' ' },
      advertisingOptOutLine: ' ',
    }, 'settings');
    expect(blank.sender).toBeUndefined();
    expect(blank.optOutLine).toBe('무료 수신거부: 수신거부 버튼');
    expect(blank.issues.map((issue) => issue.path)).toEqual([
      'settings.advertisingSender.contact',
      'settings.advertisingSender.name',
      'settings.advertisingOptOutLine',
    ]);
    expect(resolveNotificationAdvertisingSettings(undefined).issues.map((issue) => issue.path))
      .toEqual(['deployment.advertisingSender']);
  });

  it('refuses to send a route or opt-out route that is not root-relative', () => {
    expect(() => resolveNotificationContent({
      topic: { ...service, route: '/.//evil.example/x' },
      content: 'host-template',
      defaultLocale: 'ko',
    })).toThrow(/route that is not root-relative/u);
    expect(() => evaluateNotificationDelivery(input({
      topic: { ...advertising, optOutRoute: '/%2e//evil.example/y' },
      consent: [record('advertising', 'granted')],
    }))).toThrow(/optOutRoute that is not root-relative/u);
  });
});

describe('notification time windows', () => {
  it('holds the night window from 21:00 inclusive to 08:00 exclusive in Asia/Seoul', () => {
    expect(checkNotificationNightWindow('2026-10-12T11:59:59Z')).toEqual({ inside: false });
    expect(checkNotificationNightWindow('2026-10-12T12:00:00Z'))
      .toEqual({ inside: true, until: '2026-10-12T23:00:00Z' });
    expect(checkNotificationNightWindow('2026-10-12T15:00:00Z'))
      .toEqual({ inside: true, until: '2026-10-12T23:00:00Z' });
    expect(checkNotificationNightWindow('2026-10-12T22:59:59.999Z'))
      .toEqual({ inside: true, until: '2026-10-12T23:00:00Z' });
    expect(checkNotificationNightWindow('2026-10-12T23:00:00Z')).toEqual({ inside: false });
    // Across a month end.
    expect(checkNotificationNightWindow('2026-10-31T13:00:00Z'))
      .toEqual({ inside: true, until: '2026-10-31T23:00:00Z' });
  });

  it('holds quiet hours in any zone, same-day or across midnight', () => {
    const overnight = { start: '22:00', end: '08:00' };
    expect(checkNotificationQuietHours('2026-10-12T13:00:00Z', overnight, 'Asia/Seoul'))
      .toEqual({ inside: true, until: '2026-10-12T23:00:00Z' });
    expect(checkNotificationQuietHours(noon, overnight, 'Asia/Seoul')).toEqual({ inside: false });
    expect(checkNotificationQuietHours(noon, overnight, 'America/New_York'))
      .toEqual({ inside: true, until: '2026-10-12T12:00:00Z' });
    expect(checkNotificationQuietHours('2026-10-12T04:30:00Z', { start: '13:00', end: '14:00' }, 'Asia/Seoul'))
      .toEqual({ inside: true, until: '2026-10-12T05:00:00Z' });
    expect(checkNotificationQuietHours('2026-10-12T05:00:00Z', { start: '13:00', end: '14:00' }, 'Asia/Seoul'))
      .toEqual({ inside: false });
    expect(checkNotificationQuietHours(noon, { start: '08:00', end: '08:00' }, 'UTC')).toEqual({ inside: false });
  });

  it('ends quiet hours at the right instant across daylight-saving changes', () => {
    // 2026-03-08 New York: 02:00 EST jumps to 03:00 EDT. 02:30 does not exist, so the
    // window ends at 03:30 EDT, as Temporal's 'compatible' disambiguation does.
    expect(checkNotificationQuietHours('2026-03-08T06:15:00Z', { start: '01:00', end: '02:30' }, 'America/New_York'))
      .toEqual({ inside: true, until: '2026-03-08T07:30:00Z' });
    // The end of an overnight window on the day the clocks change keeps the new offset.
    expect(checkNotificationQuietHours('2026-03-08T04:00:00Z', { start: '22:00', end: '08:00' }, 'America/New_York'))
      .toEqual({ inside: true, until: '2026-03-08T12:00:00Z' });
    // 2026-11-01: 01:30 happens twice; the window ends at the first one.
    expect(checkNotificationQuietHours('2026-11-01T04:00:00Z', { start: '00:00', end: '01:30' }, 'America/New_York'))
      .toEqual({ inside: true, until: '2026-11-01T05:30:00Z' });
  });

  it('normalizes timestamps to UTC with milliseconds only when they are not zero', () => {
    expect(normalizeNotificationTimestamp('2026-10-12T12:00:00.000+09:00')).toBe('2026-10-12T03:00:00Z');
    expect(normalizeNotificationTimestamp('2026-10-12T03:00:00.250Z')).toBe('2026-10-12T03:00:00.250Z');
    expect(() => normalizeNotificationTimestamp('soon')).toThrow(/Invalid ISO-8601/u);
    // A time without an offset would depend on the process's zone.
    expect(() => normalizeNotificationTimestamp('2026-10-12T03:00:00')).toThrow();
    // RFC 3339 allows lower-case separators; calendar fields out of range are refused, not rolled over.
    expect(normalizeNotificationTimestamp('2026-10-12t03:00:00z')).toBe('2026-10-12T03:00:00Z');
    expect(normalizeNotificationTimestamp('2028-02-29T23:30:00-01:00')).toBe('2028-03-01T00:30:00Z');
    expect(normalizeNotificationTimestamp('0050-01-01T00:00:00Z')).toBe('0050-01-01T00:00:00Z');
    expect(normalizeNotificationTimestamp('2026-10-12T03:00:00.123456789Z')).toBe('2026-10-12T03:00:00.123Z');
    for (const at of [
      '2026-02-31T00:00:00Z',
      '2027-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-12T24:00:00Z',
      '2026-10-12T23:59:60Z',
      '2026-10-12T03:00:00+24:00',
    ]) {
      expect(() => normalizeNotificationTimestamp(at), at).toThrow(/Invalid ISO-8601/u);
    }
  });
});

describe('notification consent notices', () => {
  it('dates notices on Korean calendar days', () => {
    expect(toSeoulCalendarDate('2026-10-12T14:59:59Z')).toBe('2026-10-12');
    expect(toSeoulCalendarDate('2026-10-12T15:00:00Z')).toBe('2026-10-13');
    expect(notificationConsentResultDueBy(noon)).toBe('2026-10-26');
    // 23:30 UTC is the next Seoul day.
    expect(notificationConsentResultDueBy('2026-10-12T23:30:00Z')).toBe('2026-10-27');
    expect(notificationReconfirmationDueBy(noon)).toBe('2028-10-11');
    expect(notificationReconfirmationDueBy(noon, 2)).toBe('2030-10-11');
    // A 29 February consent date counts as 28 February.
    expect(notificationReconfirmationDueBy('2028-02-29T03:00:00Z')).toBe('2030-02-27');
    expect(notificationReconfirmationDueBy('2026-03-01T03:00:00Z')).toBe('2028-02-29');
    expect(() => notificationReconfirmationDueBy(noon, 0)).toThrow(/ordinal/u);
    expect(notificationNoticeSendFrom('2026-10-26')).toBe('2026-10-19');
    expect(notificationNoticeSendFrom('2026-11-03')).toBe('2026-10-27');
    // A date that does not exist is refused rather than rolled over.
    expect(() => notificationNoticeSendFrom('2026-02-31')).toThrow(/Invalid calendar date/u);
    expect(isNotificationCalendarDate('2028-02-29')).toBe(true);
    for (const date of ['2027-02-29', '2026-13-01', '2026-10-1', '2026-10-12T00:00:00Z']) {
      expect(isNotificationCalendarDate(date), date).toBe(false);
    }
  });

  it('owes a result notice per record and the next re-confirmation per kind whose latest record is a consent', () => {
    const records = [
      record('delivery-permission', 'granted'),
      record('advertising', 'granted', { at: noon }),
      record('night', 'granted', { at: '2026-10-13T03:00:00Z' }),
      record('advertising', 'withdrawn', { at: '2026-10-20T03:00:00Z' }),
    ];
    const summary = (notices: ReturnType<typeof listNotificationNotices>) =>
      notices.map((notice) => [notice.kind, notice.record.kind, notice.record.state, notice.dueBy]);
    expect(summary(listNotificationNotices(records, [], '2028-09-01T03:00:00Z'))).toEqual([
      ['consent-result', 'advertising', 'granted', '2026-10-26'],
      ['consent-result', 'night', 'granted', '2026-10-27'],
      ['consent-result', 'advertising', 'withdrawn', '2026-11-03'],
      ['reconfirmation', 'night', 'granted', '2028-10-12'],
    ]);
    // A given notice is matched by its name, the record's time compared as an instant.
    const given = [
      { kind: 'consent-result', record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' }, dueBy: '2026-10-26' },
      { kind: 'reconfirmation', record: { kind: 'night', at: '2026-10-13T03:00:00Z' }, dueBy: '2028-10-12' },
    ] as const;
    expect(summary(listNotificationNotices(records, given, '2030-09-01T03:00:00Z'))).toEqual([
      ['consent-result', 'night', 'granted', '2026-10-27'],
      ['consent-result', 'advertising', 'withdrawn', '2026-11-03'],
      ['reconfirmation', 'night', 'granted', '2030-10-12'],
    ]);
    // A new consent restarts the series from its own date.
    expect(listNotificationNotices([
      record('advertising', 'granted', { at: noon }),
      record('advertising', 'granted', { at: '2027-01-05T03:00:00Z' }),
    ], [{ kind: 'reconfirmation', record: { kind: 'advertising', at: noon }, dueBy: '2028-10-11' }], '2028-12-01T03:00:00Z')
      .filter((notice) => notice.kind === 'reconfirmation')
      .map((notice) => [notice.record.at, notice.dueBy])).toEqual([['2027-01-05T03:00:00Z', '2029-01-04']]);
  });

  it('names a notice by its kind, its record kind and time, and its due date', () => {
    // One call can write an advertising and a night record at one instant.
    const records = [record('advertising', 'granted', { at: noon }), record('night', 'granted', { at: noon })];
    const resultOf = (kind: 'advertising' | 'night') =>
      ({ kind: 'consent-result', record: { kind, at: noon }, dueBy: '2026-10-26' }) as const;
    // Giving the advertising result notice leaves the night one owed.
    expect(listNotificationNotices(records, [resultOf('advertising')], noon)
      .map((notice) => [notice.kind, notice.record.kind])).toEqual([['consent-result', 'night']]);
    expect(isSameNotificationNotice(resultOf('advertising'), {
      ...resultOf('advertising'),
      record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' },
    })).toBe(true);
    expect(isSameNotificationNotice(resultOf('advertising'), resultOf('night'))).toBe(false);
    expect(isSameNotificationNotice(resultOf('advertising'), { ...resultOf('advertising'), dueBy: '2026-10-27' }))
      .toBe(false);
  });

  it('lists a re-confirmation from 60 days before its due date, once the previous one is given', () => {
    expect(notificationReconfirmationListDays).toBe(60);
    const records = [record('advertising', 'granted', { at: noon })];
    const result = { kind: 'consent-result', record: { kind: 'advertising', at: noon }, dueBy: '2026-10-26' } as const;
    const first = { kind: 'reconfirmation', record: { kind: 'advertising', at: noon }, dueBy: '2028-10-11' } as const;
    const listed = (at: string, given: readonly NotificationNoticeIdentity[] = []) =>
      listNotificationNotices(records, [result, ...given], at).map((notice) => notice.dueBy);
    // The first one, due 2028-10-11, is listed from 2028-08-12 KST.
    expect(listed('2028-08-11T14:59:59Z')).toEqual([]);
    expect(listed('2028-08-11T15:00:00Z')).toEqual(['2028-10-11']);
    // Overdue, it stays listed until it is given.
    expect(listed('2029-06-01T03:00:00Z')).toEqual(['2028-10-11']);
    // Once given, the next one waits for its own window, however late the first was given.
    expect(listed('2029-06-01T03:00:00Z', [first])).toEqual([]);
    expect(listed('2030-08-11T14:59:59Z', [first])).toEqual([]);
    expect(listed('2030-08-11T15:00:00Z', [first])).toEqual(['2030-10-11']);
    // A notice given twice, or one of another record, does not move the series.
    expect(listed('2030-08-11T15:00:00Z', [first, first, { ...first, record: { kind: 'night', at: noon } }]))
      .toEqual(['2030-10-11']);
  });

  it('lists the re-confirmation of a 29 February consent from 60 days before its due date', () => {
    const at = '2024-02-29T03:00:00Z';
    const records = [record('advertising', 'granted', { at })];
    const result = { kind: 'consent-result', record: { kind: 'advertising', at }, dueBy: '2024-03-14' } as const;
    const listed = (when: string) =>
      listNotificationNotices(records, [result], when).map((notice) => [notice.kind, notice.dueBy]);
    // Due the day before 28 February two years on; listed from 2025-12-29 KST.
    expect(notificationReconfirmationDueBy(at)).toBe('2026-02-27');
    expect(listed('2025-12-28T14:59:59Z')).toEqual([]);
    expect(listed('2025-12-28T15:00:00Z')).toEqual([['reconfirmation', '2026-02-27']]);
  });

  it('keys a scheduled notice by player, kind, record kind, record time, and due date', () => {
    expect(createNotificationNoticeIdempotencyKey({
      player: 'a:b',
      kind: 'consent-result',
      record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' },
      dueBy: '2026-10-26',
    })).toBe('notice:a%3Ab:consent-result:advertising:2026-10-12T03:00:00Z:2026-10-26');
    const result = { player: 'p-1', kind: 'consent-result', record: { kind: 'advertising', at: noon }, dueBy: '2026-10-26' } as const;
    // The advertising and night notices of records written at one instant have their own keys.
    expect(createNotificationNoticeIdempotencyKey({ ...result, record: { kind: 'night', at: noon } }))
      .toBe('notice:p-1:consent-result:night:2026-10-12T03:00:00Z:2026-10-26');
    expect(createNotificationNoticeIdempotencyKey({ ...result, record: { kind: 'night', at: noon } }))
      .not.toBe(createNotificationNoticeIdempotencyKey(result));
    // So does every re-confirmation of one consent.
    const series = [1, 2, 3].map((ordinal) => createNotificationNoticeIdempotencyKey({
      ...result,
      kind: 'reconfirmation',
      dueBy: notificationReconfirmationDueBy(noon, ordinal),
    }));
    expect(series).toEqual([
      'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2028-10-11',
      'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2030-10-11',
      'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2032-10-11',
    ]);
    expect(() => createNotificationNoticeIdempotencyKey({ ...result, player: '' })).toThrow(/non-empty player/u);
    expect(() => createNotificationNoticeIdempotencyKey({ ...result, dueBy: '2026-02-30' })).toThrow(/dueBy date/u);
    expect(() => createNotificationNoticeIdempotencyKey({
      ...result,
      record: { kind: 'topic-preference' as 'night', at: noon },
    })).toThrow(/advertising or night record/u);
    expect(() => createNotificationNoticeIdempotencyKey({ ...result, record: { kind: 'night', at: 'today' } }))
      .toThrow(/Invalid ISO-8601/u);
  });
});

describe('notification reminders', () => {
  const local = { supported: true } as const;
  const noLocal = { supported: false } as const;
  const remote = { supported: true, purposes: ['service'], addressing: 'device', content: 'free-form' } as const;
  const noRemote = { ...remote, supported: false, addressing: 'none' } as const;

  it('routes to one route only: local first, then remote, else none', () => {
    expect(routeNotificationReminder(requested, { local, remote })).toBe('local');
    expect(routeNotificationReminder(requested, { local: noLocal, remote })).toBe('remote');
    expect(routeNotificationReminder(service, { local, remote })).toBe('remote');
    expect(routeNotificationReminder({ channels: ['local'], purpose: 'requested' }, { local: noLocal, remote }))
      .toBe('none');
    expect(routeNotificationReminder(requested, { local: noLocal, remote: noRemote })).toBe('none');
    // Advertising never takes the local route, even from an unvalidated catalog.
    expect(routeNotificationReminder({ ...advertising, channels: ['local', 'remote'] }, { local, remote }))
      .toBe('remote');
    expect(routeNotificationReminder({ ...advertising, channels: ['local'] }, { local, remote })).toBe('none');
  });

  it('applies permission, then the topic preference, then the daily cap before a local schedule', () => {
    const base = {
      topic: requested,
      permission: 'granted',
      consent: [optIn],
      fireAt: '2026-10-12T06:00:00Z',
      timeZone: 'Asia/Seoul',
    } as const;
    expect(evaluateLocalNotificationReminder(base))
      .toEqual({ status: 'schedule', fireAt: '2026-10-12T06:00:00Z' });
    expect(evaluateLocalNotificationReminder({ ...base, permission: 'prompt', consent: [] }))
      .toEqual({ status: 'permission-required' });
    expect(evaluateLocalNotificationReminder({ ...base, consent: [] }))
      .toEqual({ status: 'request-missing' });
    expect(evaluateLocalNotificationReminder({ ...base, consent: [optIn, optOut] }))
      .toEqual({ status: 'preference-off' });
    const capped = { ...base, topic: { ...requested, frequency: { maxPerDay: 2 } } };
    expect(evaluateLocalNotificationReminder({
      ...capped,
      pending: [{ fireAt: '2026-10-12T05:00:00Z' }, { fireAt: '2026-10-12T07:00:00Z' }],
    })).toEqual({ status: 'frequency-capped' });
    // Reminders more than a day apart never share a 24-hour window.
    expect(evaluateLocalNotificationReminder({
      ...capped,
      pending: [{ fireAt: '2026-10-11T05:00:00Z' }, { fireAt: '2026-10-13T07:00:00Z' }],
    }).status).toBe('schedule');
  });

  it('moves a local fireAt to the end of quiet hours and keeps it otherwise', () => {
    const base = {
      topic: service,
      permission: 'granted',
      consent: [],
      fireAt: tenPm,
      timeZone: 'Asia/Seoul',
    } as const;
    // 22:00 KST is inside the night window, which does not apply to local reminders.
    expect(evaluateLocalNotificationReminder(base)).toEqual({ status: 'schedule', fireAt: tenPm });
    expect(evaluateLocalNotificationReminder({
      ...base,
      topic: { ...service, quietHours: { start: '22:00', end: '09:00' } },
    })).toEqual({ status: 'schedule', fireAt: '2026-10-13T00:00:00Z' });
    // The registration's zone decides: 13:00Z is 14:00 in London, outside the hours.
    expect(evaluateLocalNotificationReminder({
      ...base,
      topic: { ...service, quietHours: { start: '22:00', end: '09:00' } },
      timeZone: 'Europe/London',
    })).toEqual({ status: 'schedule', fireAt: tenPm });
  });

  it('checks gate steps 3 to 5 when a server reminder is set', () => {
    const base = {
      entry: fcm,
      topic: requested,
      consent: [optIn],
      endpointPermission: 'granted',
      history: [],
    } as const;
    expect(evaluateNotificationReminderConsent(base)).toBeUndefined();
    const { endpointPermission: _permission, ...unregistered } = base;
    expect(evaluateNotificationReminderConsent(unregistered)).toBe('permission-required');
    expect(evaluateNotificationReminderConsent({ ...base, consent: [] })).toBe('request-missing');
    expect(evaluateNotificationReminderConsent({ ...base, consent: [optIn, optOut] })).toBe('preference-off');
    expect(evaluateNotificationReminderConsent({ ...base, topic: advertising })).toBe('advertising-consent-missing');
    expect(evaluateNotificationReminderConsent({
      ...base,
      entry: hostTemplate,
      topic: { ...requested, mapping: { templateSetCode: 'energy', agreement: 'required' } },
    })).toBe('permission-required');
  });

  it('keys a server reminder send by player, key, and the canonical fireAt', () => {
    expect(createNotificationReminderIdempotencyKey({
      player: 'p-1',
      key: 'energy',
      fireAt: '2026-10-12T06:00:00.000Z',
    })).toBe('reminder:p-1:energy:2026-10-12T06:00:00Z');
    expect(createNotificationReminderIdempotencyKey({
      player: 'a:b',
      key: 'c',
      fireAt: '2026-10-12T15:00:00.250+09:00',
    })).toBe('reminder:a%3Ab:c:2026-10-12T06:00:00.250Z');
    expect(createNotificationReminderIdempotencyKey({ player: 'a', key: 'b:c', fireAt: noon }))
      .not.toBe(createNotificationReminderIdempotencyKey({ player: 'a:b', key: 'c', fireAt: noon }));
    expect(() => createNotificationReminderIdempotencyKey({ player: '', key: 'k', fireAt: noon })).toThrow();
    expect(() => createNotificationReminderIdempotencyKey({ player: 'p', key: '\uD800', fireAt: noon })).toThrow();
  });
});

describe('notification inputs and idempotency', () => {
  it('bounds keys and reserves the scheduler prefixes', () => {
    expect(notificationKeyIssue('k-1')).toBeUndefined();
    for (const key of ['', 'a'.repeat(2049), 'a\u0000b', 'a\nb', '\uD800']) {
      expect(notificationKeyIssue(key), JSON.stringify(key)).toBeDefined();
    }
    expect(notificationReservedKeyPrefix('reminder:p:k:2026-10-12T06:00:00Z')).toBe('reminder:');
    expect(notificationReservedKeyPrefix('notice:p:consent-result:x')).toBe('notice:');
    expect(notificationReservedKeyPrefix('reminders-1')).toBeUndefined();
  });

  it('bounds template data and routing data', () => {
    expect(notificationTemplateDataIssue({ a: 'x', b: 1, c: true })).toBeUndefined();
    expect(notificationTemplateDataIssue({ a: 'x' }, { stringsOnly: true })).toBeUndefined();
    expect(notificationTemplateDataIssue({ b: 1 }, { stringsOnly: true })).toMatch(/must be a string/u);
    expect(notificationTemplateDataIssue({ a: Number.NaN })).toMatch(/finite number/u);
    expect(notificationTemplateDataIssue({ a: {} })).toMatch(/finite number/u);
    expect(notificationTemplateDataIssue({ a: 'x'.repeat(16_385) })).toMatch(/longer than/u);
    expect(notificationTemplateDataIssue(
      Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index])),
    )).toMatch(/at most 128/u);
    for (const data of [null, [], 'x']) {
      expect(notificationTemplateDataIssue(data)).toMatch(/expected an object/u);
    }
  });

  it('binds a key to the request without the resolved address', () => {
    const request = {
      player: 'p-1',
      topic: 'rival-challenge',
      templateData: { rival: 'Mina', round: 2 },
      data: { challengeId: 'c-1' },
      locale: 'en',
    };
    const fingerprint = notificationSendFingerprint(request);
    expect(notificationSendFingerprint({ ...request, templateData: { round: 2, rival: 'Mina' } }))
      .toBe(fingerprint);
    for (const patch of [
      { player: 'p-2' },
      { provider: 'fcm' },
      { templateData: { rival: 'Jun', round: 2 } },
      { data: { challengeId: 'c-2' } },
      { locale: 'ko' },
      { link: 't3_abc' },
    ]) {
      expect(notificationSendFingerprint({ ...request, ...patch }), JSON.stringify(patch)).not.toBe(fingerprint);
    }
  });
});

describe('notification permission helpers and registry', () => {
  it('reads a topic state, records only decided states, and finds the latest record', () => {
    expect(notificationPermissionStateOf({ app: 'granted', topics: {} }, 't')).toBe('granted');
    expect(notificationPermissionStateOf({ topics: { t: 'denied' } }, 't')).toBe('denied');
    expect(notificationPermissionStateOf({ topics: {} }, 'constructor')).toBe('unknown');
    expect(['granted', 'prompt', 'prompt-with-rationale', 'denied', 'blocked', 'unknown', 'action-required', 'unsupported']
      .filter((state) => isRecordableNotificationPermissionState(state as never)))
      .toEqual(['granted', 'prompt-with-rationale', 'denied', 'blocked']);
    expect(notificationPermissionConsentKind('app')).toBe('delivery-permission');
    expect(notificationPermissionConsentKind('topic')).toBe('host-agreement');
    const records = [
      record('host-agreement', 'granted', { topic: 'a' }),
      record('host-agreement', 'denied', { topic: 'b' }),
    ];
    expect(latestNotificationConsent(records, 'host-agreement', 'a')?.state).toBe('granted');
    expect(latestNotificationConsent(records, 'host-agreement')).toBeUndefined();
    expect(notificationTopicNeedsNoAgreement({ mapping: { agreement: 'none' } })).toBe(true);
    expect(notificationTopicNeedsNoAgreement({ mapping: { agreement: 'required' } })).toBe(false);
    expect(notificationTopicNeedsNoAgreement({})).toBe(false);
  });

  it('ships frozen reference registry entries for the RFC provider profiles', () => {
    expect(referenceNotificationProviders['apps-in-toss'].mapping).toEqual({
      templateSetCode: { required: true },
      agreement: { required: true, values: ['required', 'none'] },
    });
    expect(referenceNotificationProviders.devvit.limits).toEqual([{ count: 2, windowSeconds: 86_400 }]);
    expect(referenceNotificationProviders.devvit.mapping['link']).toEqual({
      required: false,
      pattern: '^t[13]_[A-Za-z0-9]+$',
    });
    expect(referenceNotificationProviders['apps-in-toss'].limits).toEqual([{ count: 10, windowSeconds: 60 }]);
    expect(referenceNotificationProviders['apps-in-toss'].rate).toEqual({ count: 15_000, windowSeconds: 60 });
    expect(referenceNotificationProviders.fcm).toMatchObject({ expiry: true, actions: true, link: false });
    expect(referenceNotificationProviders.fcm.purposes).toContain('advertising');
    expect(Object.isFrozen(referenceNotificationProviders.fcm.purposes)).toBe(true);
    expect(referenceNotificationTargetProviders).toEqual({
      android: 'fcm',
      ios: 'fcm',
      ait: 'apps-in-toss',
      reddit: 'devvit',
    });
  });

  it('compares a client provider with its registry entry', () => {
    const capabilities: NotificationCapabilities = {
      availability: 'available',
      permission: {
        scope: 'app',
        prompt: 'os',
        readable: true,
        serverReadable: false,
        allowance: 'persistent',
        userGesture: false,
        settings: true,
      },
      remote: {
        supported: true,
        purposes: ['advertising', 'service', 'requested'],
        addressing: 'device',
        content: 'free-form',
      },
      local: { supported: true },
      open: 'payload',
    };
    expect(notificationRegistryMismatch(capabilities, fcm)).toBeUndefined();
    expect(notificationRegistryMismatch(capabilities, hostTemplate)).toMatch(/addressing device/u);
    expect(notificationRegistryMismatch({
      ...capabilities,
      remote: { ...capabilities.remote, purposes: ['service'] },
    }, fcm)).toMatch(/purposes service differ/u);
    expect(notificationRegistryMismatch({
      ...capabilities,
      permission: { ...capabilities.permission, allowance: 'per-send' },
    }, fcm)).toMatch(/allowance differs/u);
    expect(notificationRegistryMismatch({
      ...capabilities,
      remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    }, fcm)).toBe('the provider declares no remote delivery');
  });
});

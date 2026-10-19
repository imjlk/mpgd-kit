import assert from 'node:assert/strict';

import type {
  NotificationCapabilities,
  NotificationConsentRecord,
  NotificationEvent,
  NotificationNotice,
  NotificationPermissionResult,
  NotificationPermissionSnapshot,
  NotificationProvider,
  NotificationRuntime,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import { createStarterNotificationSettings } from '../templates/notifications-overlay/common/src/platform/notificationSettings.js';
import { routeNotificationOpens } from '../templates/notifications-overlay/common/src/platform/notificationOpens.js';

// The notification settings screen's model, which the generated Phaser scene
// and lite panel drive (`--providers notifications`).

const topics: readonly NotificationTopicDeclaration[] = [
  { id: 'daily-ready', purpose: 'requested', channels: ['local', 'remote'], route: '/' },
  { id: 'friend-challenge', purpose: 'service', channels: ['remote'], route: '/' },
  { id: 'events', purpose: 'advertising', channels: ['remote'], route: '/', optOutRoute: '/' },
];

function capabilities(scope: 'app' | 'topic', prompt: 'os' | 'host' | 'game', settings = true): NotificationCapabilities {
  return {
    availability: 'available',
    permission: {
      scope,
      prompt,
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: prompt !== 'os',
      settings,
    },
    remote: {
      supported: true,
      purposes: ['service', 'requested', 'advertising'],
      addressing: 'device',
      content: 'free-form',
    },
    local: { supported: true },
    open: 'payload',
  };
}

function fakeProvider(
  caps: NotificationCapabilities,
  state: { app?: NotificationPermissionSnapshot['app']; topics?: Record<string, NotificationPermissionSnapshot['topics'][string]> },
  answer: Partial<NotificationPermissionResult> = {},
) {
  const calls: string[] = [];
  const provider: NotificationProvider = {
    provider: 'fake',
    getCapabilities: async () => caps,
    getPermission: async () => ({
      ...(state.app === undefined ? {} : { app: state.app }),
      topics: state.topics ?? {},
    }),
    requestPermission: async (input) => {
      calls.push(`request:${input.topics.join(',')}`);
      return {
        snapshot: { topics: {} },
        outcomes: Object.fromEntries(input.topics.map((topic) => [topic, 'granted'])),
        ...answer,
      };
    },
    openSettings: async () => {
      calls.push('settings');
      return 'opened';
    },
    subscribe: () => () => undefined,
  };
  return { provider, calls };
}

/**
 * A runtime over an in-memory backend: player actions append consent records,
 * and `listConsent` answers them newest first, as a backend may.
 */
function fakeRuntime(provider: NotificationProvider, notices: readonly NotificationNotice[] = []) {
  const calls: unknown[] = [];
  const records: NotificationConsentRecord[] = [];
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const append = (record: Omit<NotificationConsentRecord, 'at' | 'source'>): void => {
    clock += 1000;
    records.push(
      { ...record, source: 'player', at: new Date(clock).toISOString() } as NotificationConsentRecord,
    );
  };
  const listConsent = async (): Promise<readonly NotificationConsentRecord[]> => [...records].reverse();
  const runtime: NotificationRuntime = {
    getPermission: async (input) => ({ ...(await provider.getPermission(input)), sources: {} }),
    requestPermission: async (input) => {
      calls.push({ request: input });
      return provider.requestPermission(input);
    },
    revokePermission: async (input) => {
      calls.push({ revoke: input.topics });
      return { snapshot: { topics: {} }, outcomes: {} };
    },
    register: async () => undefined,
    unregister: async () => undefined,
    setTopicPreference: async (input) => {
      calls.push({ preference: input });
      append({
        kind: 'topic-preference',
        topic: input.topic,
        state: input.enabled ? 'granted' : 'withdrawn',
      });
    },
    setAdvertisingConsent: async (input) => {
      calls.push({ advertising: input });
      for (const kind of ['advertising', 'night'] as const) {
        const state = input[kind];
        if (state !== undefined) {
          append({ kind, state, textVersion: input.textVersion });
        }
      }
    },
    reminders: {
      set: async () => ({ route: 'none', status: 'unavailable' }),
      cancel: async () => ({ route: 'none', status: 'cancelled' }),
    },
    notices: {
      list: async () => notices,
      recordShown: async (input) => {
        calls.push({ shown: input });
      },
    },
    openSettings: async () => 'opened',
    subscribe: () => () => undefined,
  };
  return { runtime, calls, records, append, listConsent };
}

const common = {
  topics,
  defaultLocale: 'ko',
  consentTextVersion: '1',
  locale: 'ko',
} as const;

// A target without notifications shows nothing to switch.
{
  const view = await createStarterNotificationSettings({ ...common, provider: undefined, runtime: undefined }).load();
  assert.equal(view.available, false);
  assert.deepEqual(view.reminders, []);
}

// Without a runtime: the OS prompt still works from a tap, but nothing can be
// recorded, so reminders and advertising stay off and say why.
{
  const { provider, calls } = fakeProvider(capabilities('app', 'os'), { app: 'prompt' });
  const settings = createStarterNotificationSettings({ ...common, provider, runtime: undefined });
  const view = await settings.load();
  assert.equal(view.recording, false);
  assert.equal(view.permission.canRequest, true);
  assert.deepEqual(
    view.reminders.map((reminder) => [reminder.topic, reminder.enabled]),
    [['daily-ready', false]],
  );
  assert.equal(view.choices, 'no-server');
  assert.deepEqual(view.advertising, { granted: false, night: false, nightSelectable: false });
  // The permission asked up front leaves the advertising topic out.
  // Without a runtime the OS permission is on, but nothing is sent yet: the message says so.
  assert.equal(
    (await settings.turnOn()).message,
    '알림 권한을 켰어요. 게임 서버가 연결되면 알림을 받을 수 있어요.',
  );
  assert.deepEqual(calls, ['request:daily-ready,friend-challenge']);
  const refused = await settings.setAdvertising({ advertising: true });
  assert.match(refused.message ?? '', /서버가 연결되지 않아/u);
  assert.equal(refused.advertising?.granted, false);
  assert.match(
    (await settings.setReminder('daily-ready', true)).message ?? '',
    /서버가 연결되지 않아/u,
  );
}

// With a runtime: the switches show the player's latest backend records, and
// advertising and night consent are recorded with the text version.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, calls, listConsent } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  const loaded = await settings.load();
  assert.equal(loaded.choices, 'records');
  assert.equal(loaded.recording, true);
  // Night consent is not selectable before advertising consent.
  assert.deepEqual(loaded.advertising, { granted: false, night: false, nightSelectable: false });
  const early = await settings.setAdvertising({ night: true });
  assert.equal(
    early.message,
    '야간 광고성 정보 수신은 광고성 정보 수신에 먼저 동의해야 켤 수 있어요.',
  );
  assert.deepEqual(calls, []);
  const advertising = await settings.setAdvertising({ advertising: true });
  assert.deepEqual(advertising.advertising, { granted: true, night: false, nightSelectable: true });
  assert.equal(advertising.message, '광고성 정보 수신에 동의했어요.');
  const night = await settings.setAdvertising({ night: true });
  assert.deepEqual(night.advertising, { granted: true, night: true, nightSelectable: true });
  // Withdrawing advertising consent withdraws the night consent in the same call.
  const withdrawn = await settings.setAdvertising({ advertising: false });
  assert.deepEqual(withdrawn.advertising, { granted: false, night: false, nightSelectable: false });
  assert.equal(withdrawn.message, '광고성 정보 수신동의와 야간 광고성 정보 수신동의를 철회했어요.');
  // A night consent never granted is not withdrawn again (that would be a refusal).
  await settings.setAdvertising({ advertising: true });
  await settings.setAdvertising({ advertising: false });
  // Both at once is one consent call.
  const both = await settings.setAdvertising({ advertising: true, night: true });
  assert.deepEqual(both.advertising, { granted: true, night: true, nightSelectable: true });
  assert.deepEqual(calls, [
    { advertising: { advertising: 'granted', textVersion: '1' } },
    { advertising: { night: 'granted', textVersion: '1' } },
    { advertising: { advertising: 'withdrawn', night: 'withdrawn', textVersion: '1' } },
    { advertising: { advertising: 'granted', textVersion: '1' } },
    { advertising: { advertising: 'withdrawn', textVersion: '1' } },
    { advertising: { advertising: 'granted', night: 'granted', textVersion: '1' } },
  ]);
  // Reminders: a granted app permission needs no prompt; the preference is recorded.
  const reminder = await settings.setReminder('daily-ready', true);
  assert.deepEqual(reminder.reminders, [
    { topic: 'daily-ready', label: '오늘의 플레이 알림', enabled: true },
  ]);
  assert.deepEqual(calls.at(-1), { preference: { topic: 'daily-ready', enabled: true } });
  // A topic that is not a reminder cannot be toggled as one.
  assert.equal(
    (await settings.setReminder('events', true)).message,
    '이 기기에서는 알림을 켤 수 없어요.',
  );
}

// A withdrawal made elsewhere (another device, a notice, support) shows on the
// next read: the switches never keep a stale on.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, append, listConsent } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  await settings.load();
  await settings.setAdvertising({ advertising: true, night: true });
  await settings.setReminder('daily-ready', true);
  const on = await settings.load();
  assert.deepEqual(on.advertising, { granted: true, night: true, nightSelectable: true });
  assert.equal(on.reminders[0]?.enabled, true);
  append({ kind: 'advertising', state: 'withdrawn', textVersion: '1' });
  append({ kind: 'night', state: 'withdrawn', textVersion: '1' });
  append({ kind: 'topic-preference', topic: 'daily-ready', state: 'withdrawn' });
  const off = await settings.load();
  assert.deepEqual(off.advertising, { granted: false, night: false, nightSelectable: false });
  assert.equal(off.reminders[0]?.enabled, false);
  // A night consent left standing by another client counts for nothing
  // without advertising consent, so it shows off.
  append({ kind: 'night', state: 'granted', textVersion: '1' });
  const standing = await settings.load();
  assert.deepEqual(standing.advertising, { granted: false, night: false, nightSelectable: false });
}

// A tap decides from the records as they are when it happens, not as the
// screen last showed them, and writes only the kinds that change.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, calls, append, listConsent } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  await settings.load();
  await settings.setAdvertising({ advertising: true });
  // Another device grants night consent after this screen read the records.
  append({ kind: 'night', state: 'granted', textVersion: '1' });
  const off = await settings.setAdvertising({ advertising: false });
  assert.equal(off.message, '광고성 정보 수신동의와 야간 광고성 정보 수신동의를 철회했어요.');
  assert.deepEqual(calls.at(-1), {
    advertising: { advertising: 'withdrawn', night: 'withdrawn', textVersion: '1' },
  });
  // Another device grants advertising again; a stale "off" screen asks for on:
  // nothing is written twice, which would restart the re-confirmation count.
  append({ kind: 'advertising', state: 'granted', textVersion: '1' });
  const count = calls.length;
  const again = await settings.setAdvertising({ advertising: true });
  assert.equal(again.message, '광고성 정보 수신에 동의했어요.');
  assert.equal(calls.length, count);
  // An explicit night withdrawal of a night consent never granted writes
  // nothing (it would be a refusal), and both off at once is one call.
  await settings.setAdvertising({ night: false });
  assert.equal(calls.length, count);
  await settings.setAdvertising({ night: true });
  const both = await settings.setAdvertising({ advertising: false, night: false });
  assert.equal(both.message, '광고성 정보 수신동의와 야간 광고성 정보 수신동의를 철회했어요.');
  assert.deepEqual(calls.at(-1), {
    advertising: { advertising: 'withdrawn', night: 'withdrawn', textVersion: '1' },
  });
  // Night consent with advertising consent withdrawn in the same change is refused.
  const refused = await settings.setAdvertising({ advertising: false, night: true });
  assert.equal(
    refused.message,
    '야간 광고성 정보 수신은 광고성 정보 수신에 먼저 동의해야 켤 수 있어요.',
  );
}

// On a per-topic host, a reminder whose host agreement was withdrawn in host
// settings shows off, though the preference record is still on.
{
  const { provider } = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'daily-ready': 'denied' },
  });
  const { runtime, append, listConsent } = fakeRuntime(provider);
  append({ kind: 'topic-preference', topic: 'daily-ready', state: 'granted' });
  const view = await createStarterNotificationSettings({ ...common, provider, runtime, listConsent }).load();
  assert.equal(view.reminders[0]?.enabled, false);
  // With the agreement granted the same record shows on.
  const agreed = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'daily-ready': 'granted' },
  });
  const agreedRuntime = fakeRuntime(agreed.provider);
  agreedRuntime.append({ kind: 'topic-preference', topic: 'daily-ready', state: 'granted' });
  const agreedView = await createStarterNotificationSettings({
    ...common,
    provider: agreed.provider,
    runtime: agreedRuntime.runtime,
    listConsent: agreedRuntime.listConsent,
  }).load();
  assert.equal(agreedView.reminders[0]?.enabled, true);
}

// A night consent an older client left standing after advertising was
// withdrawn: a new advertising consent does not revive it, and any change
// withdraws it; messages say what was written.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, calls, append, listConsent } = fakeRuntime(provider);
  append({ kind: 'advertising', state: 'granted', textVersion: '1' });
  append({ kind: 'night', state: 'granted', textVersion: '1' });
  append({ kind: 'advertising', state: 'withdrawn', textVersion: '1' });
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  assert.deepEqual((await settings.load()).advertising, {
    granted: false,
    night: false,
    nightSelectable: false,
  });
  const on = await settings.setAdvertising({ advertising: true });
  assert.deepEqual(calls.at(-1), {
    advertising: { advertising: 'granted', night: 'withdrawn', textVersion: '1' },
  });
  assert.equal(
    on.message,
    '광고성 정보 수신에 동의했어요. 예전에 남아 있던 야간 광고성 정보 수신동의는 철회했어요. 원하면 다시 켤 수 있어요.',
  );
  assert.deepEqual(on.advertising, { granted: true, night: false, nightSelectable: true });
  // Both on again from a stale night consent writes a fresh night consent:
  // the old record is not revived without a new act.
  append({ kind: 'advertising', state: 'withdrawn', textVersion: '1' });
  append({ kind: 'night', state: 'granted', textVersion: '1' });
  await settings.setAdvertising({ advertising: true, night: true });
  assert.deepEqual(calls.at(-1), {
    advertising: { advertising: 'granted', night: 'granted', textVersion: '1' },
  });
  // Advertising already off: only the standing night consent is withdrawn, and the message says so.
  append({ kind: 'advertising', state: 'withdrawn', textVersion: '1' });
  append({ kind: 'night', state: 'granted', textVersion: '1' });
  const off = await settings.setAdvertising({ advertising: false });
  assert.deepEqual(calls.at(-1), { advertising: { night: 'withdrawn', textVersion: '1' } });
  assert.equal(off.message, '야간 광고성 정보 수신동의를 철회했어요.');
}

// A record whose time does not parse cannot be ordered: no switch is shown.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, listConsent } = fakeRuntime(provider);
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const view = await createStarterNotificationSettings({
      ...common,
      provider,
      runtime,
      listConsent: async () => [
        ...(await listConsent()),
        {
          kind: 'advertising',
          state: 'withdrawn',
          source: 'player',
          at: 'yesterday',
        } as unknown as NotificationConsentRecord,
      ],
    }).load();
    assert.equal(view.choices, 'unreadable');
  } finally {
    console.warn = original;
  }
}

// Nothing on the device stands in for a record: a new device, or one whose
// storage was cleared, shows the backend's records as they are.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, listConsent } = fakeRuntime(provider);
  const first = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  await first.load();
  await first.setAdvertising({ advertising: true });
  const fresh = await createStarterNotificationSettings({ ...common, provider, runtime, listConsent }).load();
  assert.deepEqual(fresh.advertising, { granted: true, night: false, nightSelectable: true });
  // Another player's backend records are their own: a fresh backend shows nothing on.
  const other = fakeRuntime(provider);
  const otherView = await createStarterNotificationSettings({
    ...common,
    provider,
    runtime: other.runtime,
    listConsent: other.listConsent,
  }).load();
  assert.deepEqual(otherView.advertising, { granted: false, night: false, nightSelectable: false });
}

// Records that cannot be read show no switch, and no change is made blind.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, calls } = fakeRuntime(provider);
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const failing = createStarterNotificationSettings({
      ...common,
      provider,
      runtime,
      listConsent: async () => {
        throw new Error('offline');
      },
    });
    const view = await failing.load();
    assert.equal(view.available, true);
    assert.equal(view.choices, 'unreadable');
    assert.equal(view.recording, false);
    assert.deepEqual(view.advertising, { granted: false, night: false, nightSelectable: false });
    const blind = await failing.setAdvertising({ advertising: false });
    assert.equal(
      blind.message,
      '수신 설정을 불러오지 못해 바꾸지 않았어요. 잠시 후 다시 시도해 주세요.',
    );
    assert.deepEqual(calls, []);
    // A runtime without a records reader cannot show the switches either.
    const noReader = await createStarterNotificationSettings({ ...common, provider, runtime }).load();
    assert.equal(noReader.choices, 'unreadable');
  } finally {
    console.warn = original;
  }
}

// A per-topic host (Apps in Toss): turning a reminder on opens that topic's
// sheet from the tap; a refusal records no preference.
{
  const { provider } = fakeProvider(
    capabilities('topic', 'host', false),
    { topics: { 'daily-ready': 'unknown' } },
    {
      outcomes: { 'daily-ready': 'denied' },
    },
  );
  const { runtime, calls, listConsent } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, listConsent });
  const view = await settings.load();
  assert.equal(view.permission.perTopic, true);
  assert.equal(view.permission.canRequest, false);
  const denied = await settings.setReminder('daily-ready', true);
  assert.equal(denied.message, '알림이 꺼져 있어요. 원하면 언제든 다시 켤 수 있어요.');
  assert.deepEqual(calls, [{ request: { topics: ['daily-ready'], gesture: true } }]);
}

// A per-topic host: a service template that needs the player's agreement
// gets its own agree action (no reminder switch covers it); one that needs
// no agreement is not listed; an app-scope host lists none.
{
  const aitTopics: readonly NotificationTopicDeclaration[] = [
    {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      mapping: { templateSetCode: 'challenge', agreement: 'required' },
    },
    {
      id: 'purchase-result',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      mapping: { templateSetCode: 'purchase', agreement: 'none' },
    },
  ];
  const { provider, calls } = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'friend-challenge': 'prompt', 'purchase-result': 'granted' },
  });
  const settings = createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider,
    runtime: undefined,
  });
  const view = await settings.load();
  assert.deepEqual(view.agreements, [
    { topic: 'friend-challenge', label: '친구의 도전 알림', state: 'prompt', canRequest: true },
  ]);
  const agreed = await settings.agree('friend-challenge');
  assert.deepEqual(calls, ['request:friend-challenge']);
  assert.equal(agreed.message, '알림 권한을 켰어요. 게임 서버가 연결되면 알림을 받을 수 있어요.');
  // A topic that is not listed is not asked for.
  assert.equal(
    (await settings.agree('purchase-result')).message,
    '이 기기에서는 알림을 켤 수 없어요.',
  );
  assert.equal(calls.length, 1);
  const app = fakeProvider(capabilities('app', 'os'), { app: 'prompt' });
  const appView = await createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: app.provider,
    runtime: undefined,
  }).load();
  assert.deepEqual(appView.agreements, []);
  // …and asks for nothing per topic there.
  const appSettings = createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: app.provider,
    runtime: undefined,
  });
  await appSettings.load();
  assert.equal(
    (await appSettings.agree('friend-challenge')).message,
    '이 기기에서는 알림을 켤 수 없어요.',
  );
  assert.deepEqual(app.calls, []);
  // A host that gives no read: an agreement made in this session shows as on.
  const unread = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'friend-challenge': 'unknown' },
  });
  const session = createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: unread.provider,
    runtime: undefined,
  });
  assert.equal((await session.load()).agreements[0]?.canRequest, true);
  assert.deepEqual((await session.agree('friend-challenge')).agreements[0], {
    topic: 'friend-challenge',
    label: '친구의 도전 알림',
    state: 'granted',
    canRequest: false,
  });
  // A screen opened again (a new model over the same gateway's set) still shows it.
  const shared = new Set<string>();
  const first = createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: unread.provider,
    runtime: undefined,
    agreedThisSession: shared,
  });
  await first.load();
  await first.agree('friend-challenge');
  const reopened = await createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: unread.provider,
    runtime: undefined,
    agreedThisSession: shared,
  }).load();
  assert.equal(reopened.agreements[0]?.state, 'granted');
  // With a runtime the sheet is asked for as the tap's, and a granted topic offers nothing.
  const hosted = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'friend-challenge': 'prompt' },
  });
  const { runtime, calls: runtimeCalls, listConsent } = fakeRuntime(hosted.provider);
  const withRuntime = createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: hosted.provider,
    runtime,
    listConsent,
  });
  await withRuntime.load();
  assert.equal((await withRuntime.agree('friend-challenge')).message, '알림을 켰어요.');
  assert.deepEqual(runtimeCalls, [{ request: { topics: ['friend-challenge'], gesture: true } }]);
  const granted = fakeProvider(capabilities('topic', 'host', false), {
    topics: { 'friend-challenge': 'granted' },
  });
  const grantedView = await createStarterNotificationSettings({
    ...common,
    topics: aitTopics,
    provider: granted.provider,
    runtime: undefined,
  }).load();
  assert.equal(grantedView.agreements[0]?.canRequest, false);
}

// A host that needs login first (Devvit), and a game-rendered consent the player can withdraw.
{
  const { provider } = fakeProvider(
    capabilities('app', 'game'),
    { app: 'granted' },
    {
      outcomes: { 'daily-ready': 'action-required' },
      requiredAction: 'login',
    },
  );
  const { runtime, calls } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({
    ...common,
    provider,
    runtime,
    locale: 'en',
  });
  const view = await settings.load();
  assert.equal(view.permission.canRevoke, true);
  assert.equal((await settings.turnOn()).message, 'Log in first to turn notifications on.');
  await settings.turnOff();
  assert.deepEqual(calls.at(-1), { revoke: ['daily-ready', 'friend-challenge'] });
}

// A logged-out Devvit player reads action-required: the screen offers the
// login, which asks the host, and then reads again.
{
  const { provider } = fakeProvider(capabilities('app', 'game'), { app: 'action-required' });
  const loggedOut: NotificationProvider = {
    ...provider,
    getPermission: async () => ({ app: 'action-required', topics: {}, requiredAction: 'login' }),
  };
  let logins = 0;
  const settings = createStarterNotificationSettings({
    ...common,
    provider: loggedOut,
    runtime: undefined,
    requestLogin: async () => {
      logins += 1;
    },
  });
  const view = await settings.load();
  assert.equal(view.permission.canRequest, false);
  assert.equal(view.permission.canLogin, true);
  await settings.logIn();
  assert.equal(logins, 1);
  // Without a login prompt the screen offers none.
  const noPrompt = await createStarterNotificationSettings({ ...common, provider: loggedOut, runtime: undefined }).load();
  assert.equal(noPrompt.permission.canLogin, false);
}

// Without a runtime a game-rendered consent is still withdrawn in the game,
// through the provider (RFC "Turn off where it was turned on").
{
  const { provider } = fakeProvider(capabilities('app', 'game'), { app: 'granted' });
  const revoked: string[][] = [];
  const devvit: NotificationProvider = {
    ...provider,
    revokePermission: async (input) => {
      revoked.push([...input.topics]);
      return { snapshot: { topics: {} }, outcomes: {} };
    },
  };
  const settings = createStarterNotificationSettings({
    ...common,
    provider: devvit,
    runtime: undefined,
  });
  assert.equal((await settings.load()).permission.canRevoke, true);
  assert.equal((await settings.turnOff()).message, '알림을 껐어요.');
  assert.deepEqual(revoked, [['daily-ready', 'friend-challenge']]);
  // A provider without revocation offers no turn-off without a runtime.
  const os = await createStarterNotificationSettings({
    ...common,
    provider: fakeProvider(capabilities('app', 'os'), { app: 'granted' }).provider,
    runtime: undefined,
  }).load();
  assert.equal(os.permission.canRevoke, false);
}

// An empty change records nothing.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime: quiet, calls, listConsent } = fakeRuntime(provider);
  const empty = await createStarterNotificationSettings({ ...common, provider, runtime: quiet, listConsent })
    .setAdvertising({});
  assert.equal(empty.message, '이 기기에서는 알림을 켤 수 없어요.');
  assert.deepEqual(calls, []);
}

// A host read that fails is shown as a message, never thrown into the screen.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const failing: NotificationProvider = {
    ...provider,
    getPermission: async () => {
      throw new Error('bridge down');
    },
  };
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const view = await createStarterNotificationSettings({ ...common, provider: failing, runtime: undefined }).load();
    assert.equal(view.available, false);
    assert.equal(view.message, '알림 설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  } finally {
    console.warn = original;
  }
}

// A blocked OS permission offers only the system settings.
{
  const { provider, calls } = fakeProvider(capabilities('app', 'os'), { app: 'blocked' });
  const settings = createStarterNotificationSettings({ ...common, provider, runtime: undefined });
  const view = await settings.load();
  assert.equal(view.permission.canRequest, false);
  assert.equal(view.permission.canOpenSettings, true);
  await settings.openSettings();
  assert.deepEqual(calls, ['settings']);
}

// Notices the server lists are shown in the player's language with the
// record's Asia/Seoul date, and recorded as given in the game.
{
  const notice: NotificationNotice = {
    kind: 'consent-result',
    record: {
      kind: 'advertising',
      state: 'withdrawn',
      at: '2026-10-18T16:30:00.000Z',
      textVersion: '1',
    },
    dueBy: '2026-11-02',
    variant: 'consent-result.advertising.refused',
  };
  const text = (title: string) => ({ title, body: '{{consentDate}} 처리' });
  const localeCopy = {
    'consent-result.advertising.granted': text('동의'),
    'consent-result.advertising.withdrawn': text('철회'),
    'consent-result.night.granted': text('야간 동의'),
    'consent-result.night.withdrawn': text('야간 철회'),
    'reconfirmation.advertising': text('확인'),
    'reconfirmation.night': text('야간 확인'),
  };
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  // A second notice whose variant this copy lacks: it is not shown, so not recorded.
  const unknown: NotificationNotice = {
    ...notice,
    variant: 'reconfirmation.night',
    dueBy: '2026-11-03',
  };
  const partialCopy = Object.fromEntries(
    Object.entries(localeCopy).filter(([key]) => key !== 'reconfirmation.night'),
  ) as never;
  const { runtime, calls } = fakeRuntime(provider, [notice, unknown]);
  const settings = createStarterNotificationSettings({
    ...common,
    provider,
    runtime,
    noticeCopy: { ko: partialCopy },
  });
  const view = await settings.load();
  // A refusal without its own text is given in the withdrawal's, dated in Seoul.
  assert.deepEqual(view.notices, [{ title: '철회', body: '2026-10-19 처리' }]);
  // Loading records nothing; the screen records what it showed, once.
  assert.deepEqual(calls, []);
  await settings.recordNoticesShown();
  assert.deepEqual(calls, [{ shown: notice }]);
  await settings.recordNoticesShown();
  assert.equal(calls.length, 1);
  // Without a provider (a target without notifications) nothing is listed or recorded.
  const hidden = fakeRuntime(provider, [notice]);
  const unavailable = createStarterNotificationSettings({
    ...common,
    provider: undefined,
    runtime: hidden.runtime,
    noticeCopy: { ko: localeCopy },
  });
  assert.deepEqual((await unavailable.load()).notices, []);
  await unavailable.recordNoticesShown();
  assert.deepEqual(hidden.calls, []);
}

// A provider that reports unsupported shows no notices, so records none, and
// a new visit starts without the previous outcome.
{
  const notice: NotificationNotice = {
    kind: 'reconfirmation',
    record: {
      kind: 'advertising',
      state: 'granted',
      at: '2024-10-18T00:00:00.000Z',
      textVersion: '1',
    },
    dueBy: '2026-10-25',
    variant: 'reconfirmation.advertising',
  };
  const caps = { ...capabilities('app', 'os'), availability: 'unsupported' as const };
  const { provider } = fakeProvider(caps, { app: 'unsupported' });
  const { runtime, calls } = fakeRuntime(provider, [notice]);
  const settings = createStarterNotificationSettings({
    ...common,
    provider,
    runtime,
    noticeCopy: {
      ko: { 'reconfirmation.advertising': { title: '확인', body: '{{consentDate}}' } } as never,
    },
  });
  const view = await settings.load();
  assert.equal(view.available, false);
  assert.deepEqual(view.notices, []);
  await settings.recordNoticesShown();
  assert.deepEqual(calls, []);
  const { provider: os } = fakeProvider(capabilities('app', 'os'), { app: 'prompt' });
  const visits = createStarterNotificationSettings({ ...common, provider: os, runtime: undefined });
  assert.ok((await visits.setReminder('daily-ready', true)).message);
  assert.equal((await visits.load()).message, undefined);
}

// A runtime whose recordShown throws synchronously is a logged rejection.
{
  const notice: NotificationNotice = {
    kind: 'reconfirmation',
    record: {
      kind: 'advertising',
      state: 'granted',
      at: '2024-10-18T00:00:00.000Z',
      textVersion: '1',
    },
    dueBy: '2026-10-25',
    variant: 'reconfirmation.advertising',
  };
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime } = fakeRuntime(provider, [notice]);
  const throwing: NotificationRuntime = {
    ...runtime,
    notices: {
      list: async () => [notice],
      recordShown: () => {
        throw new Error('sync');
      },
    },
  };
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const settings = createStarterNotificationSettings({
      ...common,
      provider,
      runtime: throwing,
      noticeCopy: {
        ko: { 'reconfirmation.advertising': { title: '확인', body: '{{consentDate}}' } } as never,
      },
    });
    assert.equal((await settings.load()).notices.length, 1);
    await settings.recordNoticesShown();
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
  }
}

// A failing action reports a message instead of throwing into the scene.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, listConsent } = fakeRuntime(provider);
  const failing: NotificationRuntime = {
    ...runtime,
    setAdvertisingConsent: async () => {
      throw new Error('offline');
    },
  };
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const settings = createStarterNotificationSettings({
      ...common,
      provider,
      runtime: failing,
      listConsent,
    });
    await settings.load();
    const view = await settings.setAdvertising({ advertising: true });
    assert.equal(view.message, '설정을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    assert.equal(view.advertising?.granted, false);
  } finally {
    console.warn = original;
  }
}

// The one open listener: the settings route opens the screen, every other
// open reaches `other` with an unsafe route left out, and nothing throws.
{
  let listener: ((event: NotificationEvent) => void) | undefined;
  const source = {
    subscribe: (next: (event: NotificationEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  let settings = 0;
  const others: unknown[] = [];
  const unsubscribe = routeNotificationOpens(source, {
    settings: () => {
      settings += 1;
    },
    other: (open) => {
      others.push(open);
    },
  });
  const opened = (route: string | undefined): NotificationEvent => ({
    type: 'opened',
    channel: 'remote',
    source: 'cold',
    topic: 'daily-ready',
    ...(route === undefined ? {} : { route }),
    data: { day: '3' },
  });
  listener?.(opened('/?entry=notification-settings'));
  listener?.(opened('/?entry=continue'));
  listener?.(opened('//evil.example/?entry=notification-settings'));
  listener?.(opened('http://['));
  listener?.({ type: 'received', channel: 'remote' });
  assert.equal(settings, 1);
  assert.deepEqual(others, [
    {
      type: 'opened',
      channel: 'remote',
      source: 'cold',
      topic: 'daily-ready',
      route: '/?entry=continue',
      data: { day: '3' },
    },
    { type: 'opened', channel: 'remote', source: 'cold', topic: 'daily-ready', data: { day: '3' } },
    { type: 'opened', channel: 'remote', source: 'cold', topic: 'daily-ready', data: { day: '3' } },
  ]);
  unsubscribe();
  assert.equal(listener, undefined);
  // A route with no `entry` is another open, not the settings screen.
  const plainListeners: ((event: NotificationEvent) => void)[] = [];
  let plain = 0;
  routeNotificationOpens(
    {
      subscribe: (next) => {
        plainListeners.push(next);
        return () => undefined;
      },
    },
    {
      settings: () => {
        plain += 1;
      },
    },
  );
  for (const next of plainListeners) {
    next(opened('/'));
  }
  assert.equal(plainListeners.length, 1);
  assert.equal(plain, 0);
}

console.info('Notification settings model checks passed.');

import assert from 'node:assert/strict';

import type {
  NotificationCapabilities,
  NotificationEvent,
  NotificationNotice,
  NotificationPermissionResult,
  NotificationPermissionSnapshot,
  NotificationProvider,
  NotificationRuntime,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import { createStarterNotificationSettings } from '../templates/notifications/common/src/platform/notificationSettings.js';
import { routeNotificationOpens } from '../templates/notifications/common/src/platform/notificationOpens.js';

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

function fakeRuntime(provider: NotificationProvider, notices: readonly NotificationNotice[] = []) {
  const calls: unknown[] = [];
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
    },
    setAdvertisingConsent: async (input) => {
      calls.push({ advertising: input });
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
  return { runtime, calls };
}

const memoryStorage = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      load: async ({ key }: { readonly key: string }) => (values.has(key)
        ? { value: values.get(key) }
        : null),
      save: async ({ key, value }: { readonly key: string; readonly value: unknown }) => {
        values.set(key, value);
      },
    },
  };
};

const common = {
  topics,
  defaultLocale: 'ko',
  consentTextVersion: '1',
  locale: 'ko',
  playerId: 'player-1',
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
  assert.deepEqual(view.advertising, { granted: false, night: false });
  // The permission asked up front leaves the advertising topic out.
  assert.equal((await settings.turnOn()).message, '알림을 켰어요.');
  assert.deepEqual(calls, ['request:daily-ready,friend-challenge']);
  const refused = await settings.setAdvertising({ advertising: true });
  assert.match(refused.message ?? '', /서버가 연결되지 않아/u);
  assert.equal(refused.advertising?.granted, false);
  assert.match(
    (await settings.setReminder('daily-ready', true)).message ?? '',
    /서버가 연결되지 않아/u,
  );
}

// With a runtime: advertising and night consent are recorded separately, with
// the text version, and the switches follow what was recorded on this device.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime, calls } = fakeRuntime(provider);
  const { storage, values } = memoryStorage();
  const settings = createStarterNotificationSettings({ ...common, provider, runtime, storage });
  assert.deepEqual((await settings.load()).advertising, { granted: false, night: false });
  const advertising = await settings.setAdvertising({ advertising: true });
  assert.deepEqual(advertising.advertising, { granted: true, night: false });
  assert.equal(advertising.message, '광고성 정보 수신에 동의했어요.');
  const night = await settings.setAdvertising({ night: true });
  assert.deepEqual(night.advertising, { granted: true, night: true });
  const withdrawn = await settings.setAdvertising({ advertising: false });
  // Withdrawing advertising consent leaves the night consent as it was (RFC: it stands).
  assert.deepEqual(withdrawn.advertising, { granted: false, night: true });
  assert.deepEqual(calls, [
    { advertising: { advertising: 'granted', textVersion: '1' } },
    { advertising: { night: 'granted', textVersion: '1' } },
    { advertising: { advertising: 'withdrawn', textVersion: '1' } },
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
  // The choices are remembered for the next screen.
  assert.ok(values.size === 1);
  const again = createStarterNotificationSettings({ ...common, provider, runtime, storage });
  const reloaded = await again.load();
  assert.deepEqual(reloaded.advertising, { granted: false, night: true });
  assert.equal(reloaded.reminders[0]?.enabled, true);
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
  const { runtime, calls } = fakeRuntime(provider);
  const settings = createStarterNotificationSettings({ ...common, provider, runtime });
  const view = await settings.load();
  assert.equal(view.permission.perTopic, true);
  assert.equal(view.permission.canRequest, false);
  const denied = await settings.setReminder('daily-ready', true);
  assert.equal(denied.message, '알림이 꺼져 있어요. 원하면 언제든 다시 켤 수 있어요.');
  assert.deepEqual(calls, [{ request: { topics: ['daily-ready'], gesture: true } }]);
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

// The remembered switches belong to one player on the device.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime } = fakeRuntime(provider);
  const { storage } = memoryStorage();
  await createStarterNotificationSettings({ ...common, provider, runtime, storage })
    .setAdvertising({ advertising: true });
  const other = await createStarterNotificationSettings({
    ...common,
    provider,
    runtime,
    storage,
    playerId: 'player-2',
  }).load();
  assert.deepEqual(other.advertising, { granted: false, night: false });
  // An empty change records nothing.
  const { runtime: quiet, calls } = fakeRuntime(provider);
  const empty = await createStarterNotificationSettings({ ...common, provider, runtime: quiet })
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

// A failing action reports a message instead of throwing into the scene.
{
  const { provider } = fakeProvider(capabilities('app', 'os'), { app: 'granted' });
  const { runtime } = fakeRuntime(provider);
  const failing: NotificationRuntime = {
    ...runtime,
    setAdvertisingConsent: async () => {
      throw new Error('offline');
    },
  };
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const view = await createStarterNotificationSettings({ ...common, provider, runtime: failing })
      .setAdvertising({ advertising: true });
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
}

console.info('Notification settings model checks passed.');

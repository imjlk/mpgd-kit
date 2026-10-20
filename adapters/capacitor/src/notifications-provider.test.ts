import type { FirebaseMessagingPlugin } from '@capacitor-firebase/messaging';
import { LocalNotifications, type LocalNotificationsPlugin } from '@capacitor/local-notifications';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createUnsupportedNotificationCapabilities,
  type NotificationEvent,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import {
  createFakeNotificationSdks,
  type FakeNotificationSdks,
} from '../test/notifications-sdk-fixture.js';
import {
  capacitorAdvertisingActionTypeId,
  capacitorLocalNotificationId,
  capacitorNotificationChannelId,
  capacitorSettingsReturnTimeoutMs,
  createCapacitorNotificationProvider,
  type CreateCapacitorNotificationProviderInput,
} from './notifications-provider.js';
import {
  loadCapacitorNotificationSdks,
  type LocalNotificationSdk,
  type PushSdk,
} from './notifications-sdk.js';

// The plugins satisfy the interfaces the provider speaks. (The messaging
// plugin's web fallback needs the `firebase` package, which this workspace
// does not install, so it is checked by type only.)
const pluginsFit: [
  FirebaseMessagingPlugin extends PushSdk ? true : never,
  LocalNotificationsPlugin extends LocalNotificationSdk ? true : never,
] = [true, true];
void pluginsFit;

const topics: readonly NotificationTopicDeclaration[] = [
  {
    id: 'energy-full',
    purpose: 'requested',
    channels: ['local', 'remote'],
    route: '/?entry=continue',
    mapping: { channelId: 'reminders' },
  },
  {
    id: 'friend-challenge',
    purpose: 'service',
    channels: ['remote'],
    route: '/?entry=friend-challenge',
    mapping: {},
  },
  {
    id: 'weekend-event',
    purpose: 'advertising',
    channels: ['remote'],
    route: '/events/weekend',
    optOutRoute: '/settings/notifications',
    mapping: {},
  },
];

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup(
  options: Partial<CreateCapacitorNotificationProviderInput> & {
    readonly sdkPush?: boolean;
    readonly sdkLocal?: boolean;
  } = {},
) {
  const { sdkPush, sdkLocal, ...overrides } = options;
  const platform = overrides.platform ?? 'android';
  const sdks = createFakeNotificationSdks({
    platform,
    ...(sdkPush === undefined ? {} : { push: sdkPush }),
    ...(sdkLocal === undefined ? {} : { local: sdkLocal }),
    now: () => '2026-10-12T03:00:00Z',
  });
  const errors: unknown[] = [];
  const provider = createCapacitorNotificationProvider({
    platform,
    topics,
    ...(sdks.push === undefined ? {} : { push: sdks.push }),
    ...(sdks.local === undefined ? {} : { local: sdks.local }),
    app: sdks.app,
    timeZone: () => 'Asia/Seoul',
    locale: () => 'ko-KR',
    now: () => Date.parse('2026-10-12T03:00:00Z'),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { sdks, provider, errors };
}

function grant(sdks: FakeNotificationSdks): void {
  sdks.osState = 'granted';
}

const reminder = {
  key: 'energy',
  topic: 'energy-full',
  fireAt: '2026-10-12T06:00:00Z',
  title: 'Energy full',
  body: 'Your energy is full.',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Capacitor notifications provider: capabilities', () => {
  it('declares the Android profile: promptLimit 2, no pending ceiling, payload opens', async () => {
    const { provider } = setup({ openSettings: async () => undefined });
    expect(await provider.getCapabilities()).toEqual({
      availability: 'available',
      permission: {
        scope: 'app',
        prompt: 'os',
        readable: true,
        serverReadable: false,
        allowance: 'persistent',
        userGesture: false,
        promptLimit: 2,
        settings: true,
      },
      remote: {
        supported: true,
        purposes: ['service', 'requested'],
        addressing: 'device',
        content: 'free-form',
      },
      local: { supported: true },
      open: 'payload',
    });
    expect(provider.provider).toBe('fcm');
    expect(provider.revokePermission).toBeUndefined();
  });

  it('declares promptLimit 1 and 64 pending reminders on iOS, and 1 for an old Android target', async () => {
    const ios = (await setup({ platform: 'ios' }).provider.getCapabilities());
    expect(ios.permission.promptLimit).toBe(1);
    expect(ios.local).toEqual({ supported: true, maxPending: 64 });
    expect(ios.permission.settings).toBe(false);
    expect(ios.remote.purposes).toEqual(['service', 'requested', 'advertising']);
    const legacy = await setup({ androidPromptLimit: 1 }).provider.getCapabilities();
    expect(legacy.permission.promptLimit).toBe(1);
  });

  it('returns a fresh block on every read', async () => {
    const { provider } = setup();
    const first = await provider.getCapabilities();
    (first.remote.purposes as string[]).length = 0;
    expect((await provider.getCapabilities()).remote.purposes).toHaveLength(2);
  });

  it('fails closed without the plugins: unsupported reads, unavailable requests, no prompt', async () => {
    const { provider, sdks } = setup({ sdkPush: false, sdkLocal: false });
    expect(await provider.getCapabilities()).toEqual(createUnsupportedNotificationCapabilities());
    expect(provider.register).toBeUndefined();
    expect(provider.scheduleLocal).toBeUndefined();
    expect(await provider.getPermission({ topics: ['energy-full'] })).toEqual({
      app: 'unsupported',
      topics: { 'energy-full': 'unsupported' },
    });
    expect(await provider.requestPermission({ topics: ['energy-full'] })).toEqual({
      snapshot: { app: 'unsupported', topics: { 'energy-full': 'unsupported' } },
      outcomes: { 'energy-full': 'unavailable' },
    });
    expect(await provider.openSettings?.()).toBe('unavailable');
    expect(sdks.prompts).toBe(0);
  });

  it('declares no remote delivery without the push plugin and no local reminders without the local one', async () => {
    const localOnly = setup({ sdkPush: false });
    expect((await localOnly.provider.getCapabilities()).remote).toEqual({
      supported: false,
      purposes: [],
      addressing: 'none',
      content: 'free-form',
    });
    expect(localOnly.provider.register).toBeUndefined();
    const pushOnly = setup({ sdkLocal: false });
    expect((await pushOnly.provider.getCapabilities()).local).toEqual({ supported: false });
    expect(pushOnly.provider.scheduleLocal).toBeUndefined();
    expect(pushOnly.provider.listLocal).toBeUndefined();
  });
});

describe('Capacitor notifications provider: permission', () => {
  it('maps the OS states and reads the local plugin, which reflects the system setting', async () => {
    const { provider, sdks } = setup();
    const read = async () => (await provider.getPermission({ topics: ['energy-full'] })).app;
    expect(await read()).toBe('prompt');
    sdks.osState = 'prompt-with-rationale';
    expect(await read()).toBe('prompt-with-rationale');
    sdks.osState = 'denied';
    expect(await read()).toBe('blocked');
    // Android 12 and lower: the push plugin says granted whatever the setting is.
    const checks = vi.spyOn(sdks.push!, 'checkPermissions');
    sdks.osState = 'denied';
    expect(await read()).toBe('blocked');
    expect(checks).not.toHaveBeenCalled();
  });

  it('reads a provisional or ephemeral authorization as still promptable', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    sdks.osState = 'provisional';
    expect((await provider.getPermission({ topics: [] })).app).toBe('prompt');
    sdks.osState = 'ephemeral';
    expect((await provider.getPermission({ topics: [] })).app).toBe('prompt');
  });

  it('reads Android notifications turned off in settings as blocked even when the permission is granted', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    sdks.notificationsEnabled = false;
    expect((await provider.getPermission({ topics: [] })).app).toBe('blocked');
  });

  it('reads the push plugin when the local plugin is absent', async () => {
    const { provider, sdks } = setup({
      sdkLocal: false,
      topics: topics.filter((topic) => topic.purpose !== 'advertising'),
    });
    grant(sdks);
    expect((await provider.getCapabilities()).availability).toBe('available');
    expect((await provider.getPermission({ topics: [] })).app).toBe('granted');
  });

  it('is configuration-required without the local plugin when the catalog maps advertising', async () => {
    const { provider, sdks } = setup({ platform: 'ios', sdkLocal: false });
    grant(sdks);
    expect((await provider.getCapabilities()).availability).toBe('configuration-required');
    for (const call of [
      () => provider.getPermission({ topics: ['friend-challenge'] }),
      () => provider.requestPermission({ topics: ['friend-challenge'] }),
      () => provider.register!(),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
        message: expect.stringContaining('@capacitor/local-notifications'),
      });
    }
    expect(sdks.prompts).toBe(0);
    // Nor does it announce an address the backend could send advertising to.
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await settle();
    expect(events).toEqual([]);
    // An advertising topic this target does not map needs no opt-out action.
    const unmapped = setup({
      platform: 'ios',
      sdkLocal: false,
      topics: topics.map(({ mapping, ...topic }) =>
        topic.purpose === 'advertising' ? topic : { ...topic, ...(mapping === undefined ? {} : { mapping }) }),
    });
    expect((await unmapped.provider.getCapabilities()).availability).toBe('available');
  });

  it('turns an unknown plugin state into a retryable failure', async () => {
    const { provider, sdks } = setup();
    sdks.osState = 'limited' as never;
    await expect(provider.getPermission({ topics: [] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('keeps a missing native plugin as configuration-required with its host code', async () => {
    const { provider, sdks } = setup();
    sdks.failNext('local.checkPermissions', Object.assign(new Error('not implemented'), {
      code: 'UNIMPLEMENTED',
    }));
    await expect(provider.getPermission({ topics: [] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'UNIMPLEMENTED',
      retryable: false,
    });
  });

  it('asks through the push plugin, which registers with APNs on iOS, then reads again', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    const pushRequest = vi.spyOn(sdks.push!, 'requestPermissions');
    const localRequest = vi.spyOn(sdks.local!, 'requestPermissions');
    sdks.queuePrompt('granted');
    expect(await provider.requestPermission({ topics: ['energy-full', 'friend-challenge'] }))
      .toEqual({
        snapshot: { app: 'granted', topics: { 'energy-full': 'granted', 'friend-challenge': 'granted' } },
        outcomes: { 'energy-full': 'granted', 'friend-challenge': 'granted' },
      });
    expect(pushRequest).toHaveBeenCalledOnce();
    expect(localRequest).not.toHaveBeenCalled();
    sdks.queuePrompt('already-granted');
    expect((await provider.requestPermission({ topics: ['energy-full'] })).outcomes)
      .toEqual({ 'energy-full': 'already-granted' });
  });

  it('asks through the local plugin without the push plugin', async () => {
    const { provider, sdks } = setup({ sdkPush: false });
    sdks.queuePrompt('granted');
    expect((await provider.requestPermission({ topics: ['energy-full'] })).outcomes)
      .toEqual({ 'energy-full': 'granted' });
    expect(sdks.prompts).toBe(1);
  });

  it('reports an Android denial, a dismissal, and the second denial as blocked', async () => {
    const { provider, sdks } = setup();
    const ask = () => provider.requestPermission({ topics: ['energy-full'] });
    sdks.queuePrompt('denied');
    expect(await ask()).toMatchObject({
      outcomes: { 'energy-full': 'denied' },
      snapshot: { app: 'prompt-with-rationale' },
    });
    sdks.queuePrompt('dismissed');
    expect(await ask()).toMatchObject({
      outcomes: { 'energy-full': 'dismissed' },
      snapshot: { app: 'prompt-with-rationale' },
    });
    sdks.queuePrompt('denied');
    expect(await ask()).toMatchObject({
      outcomes: { 'energy-full': 'denied' },
      snapshot: { app: 'blocked' },
    });
    // Blocked: the dialog would not show, so the provider does not ask.
    expect(await ask()).toMatchObject({ outcomes: { 'energy-full': 'blocked' } });
    expect(sdks.prompts).toBe(3);
  });

  it('shares one dialog between requests made while it is up', async () => {
    const { provider, sdks } = setup();
    sdks.queuePrompt('denied');
    const [first, second] = await Promise.all([
      provider.requestPermission({ topics: ['energy-full'] }),
      provider.requestPermission({ topics: ['friend-challenge', 'unknown'] }),
    ]);
    expect(sdks.prompts).toBe(1);
    expect(first).toEqual({
      snapshot: { app: 'prompt-with-rationale', topics: { 'energy-full': 'prompt-with-rationale' } },
      outcomes: { 'energy-full': 'denied' },
    });
    expect(second.outcomes).toEqual({ 'friend-challenge': 'denied', unknown: 'unavailable' });
    // The next request asks again.
    sdks.queuePrompt('granted');
    expect((await provider.requestPermission({ topics: ['energy-full'] })).outcomes)
      .toEqual({ 'energy-full': 'granted' });
    expect(sdks.prompts).toBe(2);
  });

  it('answers unavailable for a topic outside the resolved catalog without prompting', async () => {
    const { provider, sdks } = setup();
    expect(await provider.requestPermission({ topics: ['unknown', 'unknown'] })).toEqual({
      snapshot: { app: 'prompt', topics: { unknown: 'unsupported' } },
      outcomes: { unknown: 'unavailable' },
    });
    expect(sdks.prompts).toBe(0);
  });

  it('treats a declared topic without a mapping for this target as unavailable here', async () => {
    const unmapped: NotificationTopicDeclaration = {
      id: 'season-pass',
      purpose: 'requested',
      channels: ['local', 'remote'],
      route: '/season',
    };
    const { provider, sdks } = setup({ topics: [...topics, unmapped] });
    grant(sdks);
    expect(await provider.getPermission({ topics: ['season-pass', 'energy-full'] })).toEqual({
      app: 'granted',
      topics: { 'season-pass': 'unsupported', 'energy-full': 'granted' },
    });
    expect(await provider.scheduleLocal?.({ ...reminder, topic: 'season-pass' }))
      .toEqual({ status: 'unsupported' });
    await settle();
    expect(sdks.channels.map((channel) => channel.id)).not.toContain('mpgd-requested');
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationActionPerformed', {
      actionId: 'tap', notification: { data: { topic: 'season-pass', route: '/season' } },
    });
    sdks.emitLocal('localNotificationActionPerformed', {
      actionId: 'tap',
      notification: {
        id: 9, extra: { mpgdKey: 'k', mpgdTopic: 'season-pass', mpgdFireAt: '2026-10-12T06:00:00Z' },
      },
    });
    expect(events).toEqual([
      { type: 'opened', channel: 'remote', source: 'warm', route: '/season' },
      { type: 'opened', channel: 'local', source: 'warm' },
    ]);
  });

  it('refuses topics that are not a list of ids', async () => {
    const { provider } = setup();
    await expect(provider.getPermission({ topics: 'energy-full' } as never))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
  });

  it('reports a permission changed in system settings when the app returns', async () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    grant(sdks);
    await provider.getPermission({ topics: [] });
    sdks.app.setActive(false);
    sdks.app.setActive(true);
    await settle();
    expect(events).toEqual([]);
    sdks.osState = 'denied';
    sdks.app.setActive(false);
    sdks.app.setActive(true);
    await settle();
    expect(events).toEqual([{
      type: 'permission-changed',
      snapshot: {
        app: 'blocked',
        topics: { 'energy-full': 'blocked', 'friend-challenge': 'blocked', 'weekend-event': 'blocked' },
      },
    }]);
  });
});

describe('Capacitor notifications provider: endpoints', () => {
  it('registers the FCM token with the device permission, zone, and locale', async () => {
    const { provider, sdks } = setup();
    expect(await provider.register?.()).toBeNull();
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    grant(sdks);
    expect(await provider.register?.()).toEqual({
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      locale: 'ko-KR',
      timeZone: 'Asia/Seoul',
    });
  });

  it('throws configuration-required when the native plugin is missing', async () => {
    const { provider, sdks } = setup();
    sdks.failNext('push.getToken', { code: 'UNIMPLEMENTED', message: 'missing' });
    await expect(provider.register?.()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'UNIMPLEMENTED',
    });
  });

  it('publishes the newest token when permission corrections overlap', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    let calls = 0;
    let releaseOlder: ((state: { readonly display: 'denied' }) => void) | undefined;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      checkPermissions: async () => {
        calls += 1;
        if (calls === 1) {
          return { display: 'granted' };
        }
        if (calls === 2) {
          return new Promise((resolve) => {
            releaseOlder = resolve;
          });
        }
        return { display: 'denied' };
      },
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics,
      push: sdks.push!,
      local,
      app: null,
      onError: () => undefined,
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await settle();
    await provider.getPermission({ topics: [] });
    sdks.emitPush('tokenReceived', { token: 'tok-older' });
    await settle();
    expect(releaseOlder).toBeDefined();
    sdks.emitPush('tokenReceived', { token: 'tok-newer' });
    await settle();
    releaseOlder?.({ display: 'denied' });
    await settle();
    const endpoints = events.filter((event) => event.type === 'endpoint-changed');
    expect(endpoints.at(-1)).toMatchObject({
      type: 'endpoint-changed',
      registration: {
        address: { kind: 'fcm-token', value: 'tok-newer', permission: 'blocked' },
      },
    });
    expect(endpoints.some((event) => event.type === 'endpoint-changed'
      && event.registration.address.kind === 'fcm-token'
      && event.registration.address.value === 'tok-older'
      && event.registration.address.permission === 'blocked')).toBe(false);
  });

  it('is configuration-required on Android when a push-only shell cannot create channels', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android', local: false });
    const { createChannel: _createChannel, ...push } = sdks.push!;
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics: topics.filter((topic) => topic.purpose !== 'advertising'),
      push,
      app: null,
    });
    expect((await provider.getCapabilities()).availability).toBe('configuration-required');
    await expect(provider.register?.()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      message: expect.stringContaining('createChannel'),
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('tokenReceived', { token: 'tok-1' });
    await settle();
    expect(events).toEqual([]);
  });

  it('announces a rotated token with a fresh permission read, not the last one', async () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    grant(sdks);
    await provider.getPermission({ topics: [] });
    sdks.osState = 'denied';
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-rotated' });
    await settle();
    const rotated = events.filter((event) => event.type === 'endpoint-changed').at(-1);
    expect(rotated).toMatchObject({
      type: 'endpoint-changed',
      registration: {
        address: { kind: 'fcm-token', value: 'tok-rotated', permission: 'blocked' },
      },
    });
  });

  it('does not return a token when Android channel creation failed', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      createChannel: async () => Promise.reject(new Error('channel')),
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics,
      push: sdks.push!,
      local,
      app: null,
      onError: () => undefined,
    });
    await settle();
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await expect(provider.register?.()).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
  });

  it('does not return a token before Android channels exist', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    sdks.holdChannels();
    sdks.osState = 'granted';
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics,
      push: sdks.push!,
      local: sdks.local!,
      app: null,
    });
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    let settled = false;
    const pending = provider.register?.().then((value) => {
      settled = true;
      return value;
    });
    await settle();
    expect(settled).toBe(false);
    expect(sdks.channels).toEqual([]);
    sdks.releaseChannels();
    await expect(pending).resolves.toMatchObject({
      address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
    });
    expect(sdks.channels.map((channel) => channel.id)).toEqual([
      'reminders', 'mpgd-service', 'mpgd-advertising',
    ]);
  });

  it('announces a rotated token as endpoint-changed, buffered for the first subscriber', async () => {
    const { provider, sdks } = setup();
    // Before any read the permission is read first.
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await settle();
    grant(sdks);
    await provider.getPermission({ topics: [] });
    // Once read, the rotation goes out with a fresh read of that permission.
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
    await settle();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    expect(events).toEqual([
      {
        type: 'endpoint-changed',
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: 'tok-1', permission: 'prompt' },
          locale: 'ko-KR',
          timeZone: 'Asia/Seoul',
        },
      },
      {
        type: 'endpoint-changed',
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: 'tok-2', permission: 'granted' },
          locale: 'ko-KR',
          timeZone: 'Asia/Seoul',
        },
      },
    ]);
  });
});

describe('Capacitor notifications provider: events around a request', () => {
  it('announces a token issued during a request with the answer of that request', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    const push = sdks.push!;
    const request = push.requestPermissions.bind(push);
    vi.spyOn(push, 'requestPermissions').mockImplementation(async () => {
      const answer = await request();
      // iOS registers with APNs on the grant, and Firebase issues the token
      // before the provider has read the new state.
      sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
      return answer;
    });
    sdks.queuePrompt('granted');
    await provider.requestPermission({ topics: ['energy-full'] });
    await settle();
    expect(events).toEqual([{
      type: 'endpoint-changed',
      registration: expect.objectContaining({
        address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      }),
    }]);
  });

  it('announces a settings change once for two quick returns, and none for the request dialog', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    const push = sdks.push!;
    const request = push.requestPermissions.bind(push);
    vi.spyOn(push, 'requestPermissions').mockImplementation(async () => {
      // The iOS alert takes the app out of the foreground and back.
      sdks.app.setActive(false);
      const answer = await request();
      sdks.app.setActive(true);
      return answer;
    });
    sdks.queuePrompt('granted');
    await provider.requestPermission({ topics: ['energy-full'] });
    await settle();
    expect(events).toEqual([]);
    sdks.osState = 'denied';
    sdks.app.setActive(true);
    sdks.app.setActive(true);
    await settle();
    expect(events.map((event) => event.type)).toEqual(['permission-changed']);
  });

  it('reports a token failure that is not a missing plugin, once until a token arrives', async () => {
    const { provider, sdks, errors } = setup();
    sdks.failNext('push.getToken', new Error('Firebase is not configured'));
    expect(await provider.register?.()).toBeNull();
    expect(await provider.register?.()).toBeNull();
    expect(errors).toEqual([new Error('Firebase is not configured')]);
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    expect(await provider.register?.()).not.toBeNull();
    sdks.failNext('push.getToken', new Error('offline'));
    expect(await provider.register?.()).toBeNull();
    expect(errors).toEqual([new Error('Firebase is not configured'), new Error('offline')]);
  });

  it('keeps the request answer when an older read finishes after it', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    let hold: ((state: { readonly display: 'prompt' }) => void) | undefined;
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      checkPermissions: async () => {
        calls += 1;
        if (calls === 2) {
          return new Promise((resolve) => {
            hold = resolve;
          });
        }
        return { display: sdks.osState };
      },
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, push: sdks.push!, local, app: null,
      timeZone: () => undefined, locale: () => undefined,
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    // A read that starts before the dialog and answers after it.
    const stale = provider.getPermission({ topics: [] });
    sdks.queuePrompt('granted');
    await provider.requestPermission({ topics: ['energy-full'] });
    expect(hold).toBeDefined();
    hold?.({ display: 'prompt' });
    await stale;
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await settle();
    expect(events).toEqual([{
      type: 'endpoint-changed',
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      },
    }]);
  });

  it('reports a setup failure once until a try succeeds', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android', local: false });
    const errors: unknown[] = [];
    const push: PushSdk = Object.assign(Object.create(sdks.push!) as PushSdk, {
      createChannel: async () => Promise.reject(new Error('channel')),
    });
    createCapacitorNotificationProvider({
      platform: 'android', topics, push, app: sdks.app, onError: (error) => errors.push(error),
    });
    await settle();
    sdks.app.setActive(true);
    await settle();
    sdks.app.setActive(true);
    await settle();
    expect(errors).toEqual([new Error('channel')]);
  });

  it('reports a token failure again after a token arrived from Firebase', async () => {
    const { provider, sdks, errors } = setup();
    sdks.failNext('push.getToken', new Error('first'));
    await provider.register?.();
    sdks.emitPush('tokenReceived', { token: 'tok-1' });
    sdks.failNext('push.getToken', new Error('second'));
    await provider.register?.();
    expect(errors).toEqual([new Error('first'), new Error('second')]);
  });

  it('keeps the request answer when a read begun during the dialog finishes after it', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    let hold: ((state: { readonly display: 'prompt' }) => void) | undefined;
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      checkPermissions: async () => {
        calls += 1;
        // The third read: begun while the dialog is up.
        if (calls === 3) {
          return new Promise((resolve) => {
            hold = resolve;
          });
        }
        return { display: sdks.osState };
      },
    };
    const push = sdks.push!;
    const ask = push.requestPermissions.bind(push);
    let stale: Promise<unknown> | undefined;
    const pushDuringDialog: PushSdk = Object.assign(Object.create(push) as PushSdk, {
      requestPermissions: async () => {
        stale = provider.getPermission({ topics: [] });
        return ask();
      },
    });
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, push: pushDuringDialog, local, app: null,
      timeZone: () => undefined, locale: () => undefined,
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    sdks.queuePrompt('granted');
    await provider.requestPermission({ topics: ['energy-full'] });
    expect(hold).toBeDefined();
    hold?.({ display: 'prompt' });
    await stale;
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await settle();
    expect(events).toEqual([{
      type: 'endpoint-changed',
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      },
    }]);
  });

  it('shares the answer of a dialog that opened and closed during its own first read', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    let hold: ((state: { readonly display: 'prompt' }) => void) | undefined;
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      checkPermissions: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            hold = resolve;
          });
        }
        return { display: sdks.osState };
      },
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, push: sdks.push!, local, app: null,
    });
    const late = provider.requestPermission({ topics: ['energy-full'] });
    sdks.queuePrompt('granted');
    const early = await provider.requestPermission({ topics: ['friend-challenge'] });
    expect(hold).toBeDefined();
    hold?.({ display: 'prompt' });
    expect((await late).outcomes).toEqual({ 'energy-full': 'granted' });
    expect(early.outcomes).toEqual({ 'friend-challenge': 'granted' });
    expect(sdks.prompts).toBe(1);
  });

  it('announces no change for a return whose read overlapped a request', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    let hold: ((state: { readonly display: 'granted' }) => void) | undefined;
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      checkPermissions: async () => {
        calls += 1;
        if (calls === 2) {
          return new Promise((resolve) => {
            hold = resolve;
          });
        }
        return { display: sdks.osState };
      },
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, push: sdks.push!, local, app: sdks.app,
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    // The return's read hangs while a request runs and answers.
    sdks.app.setActive(true);
    await settle();
    sdks.queuePrompt('granted');
    await provider.requestPermission({ topics: ['energy-full'] });
    expect(hold).toBeDefined();
    hold?.({ display: 'granted' });
    await settle();
    expect(events).toEqual([]);
  });

  it('stops waiting for a request that failed', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    await provider.getPermission({ topics: [] });
    sdks.failNext('push.requestPermissions', new Error('native'));
    await expect(provider.requestPermission({ topics: ['energy-full'] })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    // Neither a token nor a return from settings waits for it any more.
    // The token read is asynchronous, so it is allowed to finish before the
    // settings read; both must still arrive.
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await settle();
    sdks.osState = 'denied';
    sdks.app.setActive(true);
    await settle();
    expect(events.map((event) => event.type)).toEqual(['endpoint-changed', 'permission-changed']);
  });
});

describe('Capacitor notifications provider: local reminders', () => {
  it('answers permission-required without calling the plugin, which would prompt', async () => {
    const { provider, sdks } = setup();
    const schedule = vi.spyOn(sdks.local!, 'schedule');
    expect(await provider.scheduleLocal?.(reminder)).toEqual({ status: 'permission-required' });
    sdks.osState = 'prompt-with-rationale';
    expect(await provider.scheduleLocal?.(reminder)).toEqual({ status: 'permission-required' });
    expect(schedule).not.toHaveBeenCalled();
    expect(sdks.prompts).toBe(0);
  });

  it('schedules inexactly on the topic channel, with the key in extra, and replaces by key', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    expect(await provider.scheduleLocal?.(reminder)).toEqual({ status: 'scheduled' });
    expect(await provider.scheduleLocal?.({ ...reminder, fireAt: '2026-10-12T16:00:00+09:00' }))
      .toEqual({ status: 'replaced' });
    const id = capacitorLocalNotificationId('energy');
    expect(sdks.scheduled).toEqual([
      {
        id,
        title: 'Energy full',
        body: 'Your energy is full.',
        schedule: { at: new Date('2026-10-12T06:00:00Z'), allowWhileIdle: true },
        extra: {
          mpgdKey: 'energy',
          mpgdTopic: 'energy-full',
          mpgdFireAt: '2026-10-12T06:00:00Z',
          mpgdRoute: '/?entry=continue',
        },
        channelId: 'reminders',
        isExactNotification: false,
      },
      expect.objectContaining({
        id,
        schedule: { at: new Date('2026-10-12T07:00:00Z'), allowWhileIdle: true },
        extra: expect.objectContaining({ mpgdFireAt: '2026-10-12T07:00:00Z' }),
      }),
    ]);
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' },
    ]);
  });

  it('sets no channel on iOS and keeps a route the request names', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    await provider.scheduleLocal?.({ ...reminder, route: '/shop' });
    expect(sdks.scheduled[0]).not.toHaveProperty('channelId');
    expect(sdks.scheduled[0]?.extra['mpgdRoute']).toBe('/shop');
  });

  it('refuses invalid input and advertising topics', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    await expect(provider.scheduleLocal?.({ ...reminder, fireAt: '2026-10-12T06:00:00' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    await expect(provider.scheduleLocal?.({ ...reminder, route: '//evil.example/x' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    expect(await provider.scheduleLocal?.({ ...reminder, topic: 'weekend-event' }))
      .toEqual({ status: 'unsupported' });
    // Outside the resolved catalog: no channel was created for it.
    expect(await provider.scheduleLocal?.({ ...reminder, topic: 'not-declared' }))
      .toEqual({ status: 'unsupported' });
    expect(sdks.scheduled).toEqual([]);
  });

  it('probes past an id another notification holds and never touches it', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    const id = capacitorLocalNotificationId('energy');
    sdks.addForeignPending(id);
    await provider.scheduleLocal?.(reminder);
    expect(sdks.scheduled[0]?.id).toBe(id === 0x7f_ff_ff_ff ? 1 : id + 1);
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
    await provider.cancelLocal?.({ keys: ['energy', 'other'] });
    expect(sdks.localOperations.at(-1)).toEqual({ op: 'cancel', key: 'energy', topic: 'energy-full' });
    // The foreign notification stays pending.
    expect((await sdks.local!.getPending()).notifications.map((entry) => entry.id)).toEqual([id]);
  });

  it('puts the evicted reminder back when scheduling the nearer one fails', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    for (let id = 1; id <= 63; id += 1) {
      sdks.addForeignPending(id);
    }
    await provider.scheduleLocal?.({ ...reminder, key: 'far', fireAt: '2026-10-20T00:00:00Z', route: '/far' });
    sdks.failNext('local.schedule', new Error('native'));
    await expect(provider.scheduleLocal?.({ ...reminder, key: 'near' })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'far', topic: 'energy-full', fireAt: '2026-10-20T00:00:00Z' },
    ]);
    const restored = sdks.scheduled.at(-1);
    expect(restored).toMatchObject({
      title: 'Energy full',
      body: 'Your energy is full.',
      extra: { mpgdKey: 'far', mpgdRoute: '/far' },
      isExactNotification: false,
    });
  });

  it('reports an evicted reminder it cannot restore without its title and body', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    sdks.osState = 'granted';
    const errors: unknown[] = [];
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      // A plugin that reports pending notifications without their text.
      getPending: async () => ({
        notifications: (await sdks.local!.getPending()).notifications
          .map(({ id, extra }) => ({ id, extra })),
      }),
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'ios', topics, local, app: null, onError: (error) => errors.push(error),
    });
    for (let id = 1; id <= 63; id += 1) {
      sdks.addForeignPending(id);
    }
    await provider.scheduleLocal?.({ ...reminder, key: 'far', fireAt: '2026-10-20T00:00:00Z' });
    sdks.failNext('local.schedule', new Error('native'));
    await expect(provider.scheduleLocal?.({ ...reminder, key: 'near' })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    expect(errors).toEqual([new Error('Capacitor notifications: could not restore the reminder far.')]);
  });

  it('keeps at most 64 pending on iOS, the nearest ones', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    // Another part of the app holds one of the 64 slots.
    sdks.addForeignPending(1);
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 13, 0) + hour * 3_600_000)
      .toISOString().replace('.000Z', 'Z');
    for (let index = 0; index < 63; index += 1) {
      expect(await provider.scheduleLocal?.({ ...reminder, key: `r-${index}`, fireAt: at(index + 1) }))
        .toEqual({ status: 'scheduled' });
    }
    // Farther than every pending reminder: refused.
    expect(await provider.scheduleLocal?.({ ...reminder, key: 'late', fireAt: at(100) }))
      .toEqual({ status: 'capacity-exceeded' });
    // Nearer: the farthest gives way.
    expect(await provider.scheduleLocal?.({ ...reminder, key: 'early', fireAt: at(0) }))
      .toEqual({ status: 'scheduled' });
    expect(sdks.localOperations.slice(-2)).toEqual([
      { op: 'cancel', key: 'r-62', topic: 'energy-full' },
      { op: 'schedule', key: 'early', topic: 'energy-full', fireAt: at(0), exact: false },
    ]);
    // Replacing a pending key needs no free slot.
    expect(await provider.scheduleLocal?.({ ...reminder, key: 'r-0', fireAt: at(2) }))
      .toEqual({ status: 'replaced' });
    expect((await provider.listLocal?.())?.length).toBe(63);
  });

  it('keeps a past Android alarm that is not in the shade, and omits one that is', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    await provider.scheduleLocal?.(reminder);
    sdks.addStoredLocal({
      id: 9,
      extra: {
        mpgdKey: 'fired',
        mpgdTopic: 'energy-full',
        mpgdFireAt: '2020-01-01T00:00:00Z',
      },
      delivered: true,
    });
    sdks.addStoredLocal({
      id: 10,
      extra: {
        mpgdKey: 'doze',
        mpgdTopic: 'energy-full',
        mpgdFireAt: '2020-01-02T00:00:00Z',
      },
    });
    const pending = await provider.listLocal?.();
    expect(pending).toEqual([
      { key: 'doze', topic: 'energy-full', fireAt: '2020-01-02T00:00:00Z' },
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
    await provider.cancelLocal?.({ keys: pending?.map((entry) => entry.key) ?? [] });
    expect(sdks.localOperations.filter((entry) => entry.op === 'cancel').map((entry) => entry.key))
      .toEqual(['doze', 'energy']);
    expect((await sdks.local!.getPending()).notifications.map((entry) => entry.id)).toEqual([9]);
  });

  it('lists stored rows when the shade read fails', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    await provider.scheduleLocal?.(reminder);
    sdks.addStoredLocal({
      id: 9,
      extra: {
        mpgdKey: 'doze',
        mpgdTopic: 'energy-full',
        mpgdFireAt: '2020-01-02T00:00:00Z',
      },
      delivered: true,
    });
    sdks.failNext('local.getDeliveredNotifications', new Error('shade'));
    expect(await provider.listLocal?.()).toEqual([
      { key: 'doze', topic: 'energy-full', fireAt: '2020-01-02T00:00:00Z' },
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
  });

  it('keeps a past Android row when delivered notifications cannot be read', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    const { getDeliveredNotifications: _delivered, ...local } = sdks.local!;
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics,
      local: local as LocalNotificationSdk,
      app: null,
    });
    sdks.addStoredLocal({
      id: 9,
      extra: {
        mpgdKey: 'doze',
        mpgdTopic: 'energy-full',
        mpgdFireAt: '2020-01-01T00:00:00Z',
      },
    });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'doze', topic: 'energy-full', fireAt: '2020-01-01T00:00:00Z' },
    ]);
  });

  it('reports scheduled only after iOS has the reminder pending', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    sdks.delayNextIosAdd();
    expect(await provider.scheduleLocal?.(reminder)).toEqual({ status: 'scheduled' });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
  });

  it('confirms an iOS add that lands after the first few pending reads', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    // Four misses: the old four-poll check would give up before the row appears.
    sdks.delayNextIosAdd(4);
    expect(await provider.scheduleLocal?.(reminder)).toEqual({ status: 'scheduled' });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' },
    ]);
  });

  it('does not treat the old pending row as a completed replacement', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    await provider.scheduleLocal?.(reminder);
    sdks.holdNextIosAdd();
    let settled = false;
    const replacing = provider.scheduleLocal?.({
      ...reminder,
      fireAt: '2026-10-12T07:00:00Z',
      body: 'Updated',
    }).then((value) => {
      settled = true;
      return value;
    });
    await settle();
    expect(settled).toBe(false);
    sdks.releaseIosAdds();
    await expect(replacing).resolves.toEqual({ status: 'replaced' });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' },
    ]);
  });

  it('does not treat the old topic as a completed replacement', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    await provider.scheduleLocal?.({ ...reminder, route: '/keep' });
    sdks.holdNextIosAdd();
    let settled = false;
    const replacing = provider.scheduleLocal?.({
      ...reminder,
      topic: 'friend-challenge',
      route: '/keep',
    }).then((value) => {
      settled = true;
      return value;
    });
    await settle();
    expect(settled).toBe(false);
    sdks.releaseIosAdds();
    await expect(replacing).resolves.toEqual({ status: 'replaced' });
    expect(await provider.listLocal?.()).toEqual([
      { key: 'energy', topic: 'friend-challenge', fireAt: '2026-10-12T06:00:00Z' },
    ]);
  });

  it('does not fail or restore when an iOS add is still unconfirmed', async () => {
    const { provider, sdks } = setup({ platform: 'ios', scheduleConfirmBudgetMs: 0 });
    grant(sdks);
    for (let id = 1; id <= 63; id += 1) {
      sdks.addForeignPending(id);
    }
    await provider.scheduleLocal?.({
      ...reminder,
      key: 'far',
      fireAt: '2026-10-20T00:00:00Z',
      route: '/far',
    });
    sdks.dropNextIosAdd();
    await expect(provider.scheduleLocal?.({ ...reminder, key: 'near' }))
      .resolves.toEqual({ status: 'scheduled' });
    expect(await provider.listLocal?.()).toEqual([]);
    expect(sdks.localOperations.filter((entry) => entry.op === 'cancel').map((entry) => entry.key))
      .toEqual(['far']);
    expect(sdks.scheduled.filter((entry) => entry.extra['mpgdKey'] === 'far')).toHaveLength(1);
  });
});

describe('Capacitor notifications provider: concurrent local reminders', () => {
  it('runs one operation at a time, so the last free slot is taken once', async () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    grant(sdks);
    for (let id = 1; id <= 63; id += 1) {
      sdks.addForeignPending(id);
    }
    const [first, second] = await Promise.all([
      provider.scheduleLocal?.({ ...reminder, key: 'a' }),
      provider.scheduleLocal?.({ ...reminder, key: 'b', fireAt: '2026-10-12T07:00:00Z' }),
    ]);
    expect([first, second]).toEqual([{ status: 'scheduled' }, { status: 'capacity-exceeded' }]);
    expect((await sdks.local!.getPending()).notifications).toHaveLength(64);
  });

  it('answers scheduled then replaced for two calls with one new key', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    const results = await Promise.all([
      provider.scheduleLocal?.(reminder),
      provider.scheduleLocal?.({ ...reminder, fireAt: '2026-10-12T07:00:00Z' }),
      provider.listLocal?.(),
    ]);
    expect(results).toEqual([
      { status: 'scheduled' },
      { status: 'replaced' },
      [{ key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' }],
    ]);
  });

  it('keeps the queue going after a failed operation', async () => {
    const { provider, sdks } = setup();
    grant(sdks);
    sdks.failNext('local.schedule', new Error('native'));
    const [failed, next] = await Promise.allSettled([
      provider.scheduleLocal?.(reminder),
      provider.scheduleLocal?.({ ...reminder, key: 'other' }),
    ]);
    expect(failed).toMatchObject({
      status: 'rejected',
      reason: { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' },
    });
    expect(next).toEqual({ status: 'fulfilled', value: { status: 'scheduled' } });
  });
});

describe('Capacitor notifications provider: native setup', () => {
  it('creates one Android channel per channel id, advertising apart, and the opt-out action', async () => {
    const { sdks } = setup({
      channels: { reminders: { name: 'Energy reminders', importance: 4 } },
    });
    await settle();
    expect(sdks.channels).toEqual([
      { id: 'reminders', name: 'Energy reminders', importance: 4 },
      { id: 'mpgd-service', name: 'Notifications', importance: 3 },
      { id: 'mpgd-advertising', name: 'Promotions', importance: 3 },
    ]);
    expect(sdks.actionTypes).toEqual([{
      id: capacitorAdvertisingActionTypeId,
      actions: [{ id: 'advertising-opt-out', title: '수신거부', foreground: true }],
    }]);
  });

  it('leaves the iOS categories alone for a catalog without advertising', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    createCapacitorNotificationProvider({
      platform: 'ios',
      topics: topics.filter((topic) => topic.purpose !== 'advertising'),
      local: sdks.local!,
      app: null,
    });
    await settle();
    expect(sdks.actionTypes).toEqual([]);
  });

  it('creates no channel on iOS but registers the opt-out category', async () => {
    const { sdks } = setup({ platform: 'ios', advertisingOptOutTitle: 'Unsubscribe' });
    await settle();
    expect(sdks.channels).toEqual([]);
    expect(sdks.actionTypes[0]?.actions[0]?.title).toBe('Unsubscribe');
  });

  it('refuses a channel shared by advertising and other topics', () => {
    expect(() => createCapacitorNotificationProvider({
      platform: 'android',
      topics: [
        topics[0]!,
        { ...topics[2]!, mapping: { channelId: 'reminders' } },
      ],
      app: null,
    })).toThrow(/channel reminders mixes advertising and other topics \(weekend-event\)/u);
  });

  it('names the channel of a topic by its mapping, else by its purpose', () => {
    expect(capacitorNotificationChannelId({ purpose: 'service', mapping: { channelId: 'x' } })).toBe('x');
    expect(capacitorNotificationChannelId({ purpose: 'advertising' })).toBe('mpgd-advertising');
    expect(capacitorNotificationChannelId({ purpose: 'requested', mapping: { channelId: '' } }))
      .toBe('mpgd-requested');
  });

  it('derives stable positive 32-bit ids', () => {
    expect(capacitorLocalNotificationId('energy')).toBe(capacitorLocalNotificationId('energy'));
    for (const key of ['', 'a', 'energy', '한국어', 'x'.repeat(2048)]) {
      const id = capacitorLocalNotificationId(key);
      expect(Number.isInteger(id) && id >= 1 && id <= 0x7f_ff_ff_ff).toBe(true);
    }
  });

  it('reports a failed setup instead of rejecting', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    const errors: unknown[] = [];
    const local = { ...sdks.local!, createChannel: async () => Promise.reject(new Error('boom')) };
    createCapacitorNotificationProvider({
      platform: 'android', topics, local, app: null, onError: (error) => errors.push(error),
    });
    await settle();
    expect(errors).toEqual([new Error('boom')]);
  });

  it('does not schedule onto missing channels, and tries the setup again', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    sdks.osState = 'granted';
    let failures = 1;
    const created: string[] = [];
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      createChannel: async (channel) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('channel');
        }
        created.push(channel.id);
      },
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, local, app: null, onError: () => undefined,
    });
    await settle();
    await expect(provider.scheduleLocal?.(reminder)).resolves.toEqual({ status: 'scheduled' });
    expect(created).toEqual(['reminders', 'mpgd-service', 'mpgd-advertising']);
    failures = 1;
    const later = createCapacitorNotificationProvider({
      platform: 'android', topics, local, app: null, onError: () => undefined,
    });
    await settle();
    failures = 1;
    await expect(later.scheduleLocal?.({ ...reminder, key: 'b' })).rejects.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    expect(sdks.scheduled.map((entry) => entry.extra['mpgdKey'])).toEqual(['energy']);
    await expect(later.scheduleLocal?.({ ...reminder, key: 'b' })).resolves.toEqual({ status: 'scheduled' });
  });

  it('answers permission-required before it needs the channels', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      createChannel: async () => Promise.reject(new Error('channel')),
    };
    const provider = createCapacitorNotificationProvider({
      platform: 'android', topics, local, app: null, onError: () => undefined,
    });
    await expect(provider.scheduleLocal?.(reminder)).resolves.toEqual({ status: 'permission-required' });
  });

  it('tries the channels of a push-only provider again when the app returns', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'android', local: false });
    let failures = 1;
    const created: string[] = [];
    const push: PushSdk = Object.assign(Object.create(sdks.push!) as PushSdk, {
      createChannel: async (channel: { readonly id: string }) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('channel');
        }
        created.push(channel.id);
      },
    });
    createCapacitorNotificationProvider({
      platform: 'android', topics, push, app: sdks.app, onError: () => undefined,
    });
    await settle();
    expect(created).toEqual([]);
    sdks.app.setActive(true);
    await settle();
    expect(created).toEqual(['reminders', 'mpgd-service', 'mpgd-advertising']);
  });

  it('needs no createChannel outside Android', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    const { createChannel: _createChannel, ...rest } = sdks.local!;
    const errors: unknown[] = [];
    expect(() => createCapacitorNotificationProvider({
      platform: 'ios',
      topics,
      local: rest as LocalNotificationSdk,
      app: null,
      onError: (error) => errors.push(error),
    })).not.toThrow();
    await settle();
    expect(errors).toEqual([]);
  });

  it('tries the opt-out action type again after a failure', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    sdks.osState = 'granted';
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      registerActionTypes: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('categories');
        }
      },
    };
    const errors: unknown[] = [];
    const provider = createCapacitorNotificationProvider({
      platform: 'ios', topics, local, app: null, onError: (error) => errors.push(error),
    });
    await settle();
    expect(errors).toEqual([new Error('categories')]);
    // A reminder does not need the category, so it is scheduled while it is retried.
    await expect(provider.scheduleLocal?.(reminder)).resolves.toEqual({ status: 'scheduled' });
    await settle();
    expect(calls).toBe(2);
  });

  it('tries the opt-out category again when the app returns, without a local reminder', async () => {
    const sdks = createFakeNotificationSdks({ platform: 'ios' });
    let calls = 0;
    const local: LocalNotificationSdk = {
      ...sdks.local!,
      registerActionTypes: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('categories');
        }
      },
    };
    createCapacitorNotificationProvider({
      platform: 'ios', topics, local, app: sdks.app, onError: () => undefined,
    });
    await settle();
    expect(calls).toBe(1);
    sdks.app.setActive(true);
    await settle();
    expect(calls).toBe(2);
    // Kept once it succeeded.
    sdks.app.setActive(true);
    await settle();
    expect(calls).toBe(2);
  });
});

describe('Capacitor notifications provider: opens and events', () => {
  it('buffers a cold-start open for the first subscriber only, then delivers warm opens to all', () => {
    const { provider, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge', route: '/?entry=friend-challenge', data: { challengeId: 'c-1' } });
    const first: NotificationEvent[] = [];
    const second: NotificationEvent[] = [];
    provider.subscribe((event) => first.push(event));
    provider.subscribe((event) => second.push(event));
    sdks.tap({ channel: 'local', topic: 'energy-full', route: '/?entry=continue' });
    expect(first).toEqual([
      {
        type: 'opened',
        channel: 'remote',
        source: 'cold',
        topic: 'friend-challenge',
        route: '/?entry=friend-challenge',
        data: { challengeId: 'c-1' },
      },
      { type: 'opened', channel: 'local', source: 'warm', topic: 'energy-full', route: '/?entry=continue' },
    ]);
    expect(second).toEqual([first[1]]);
  });

  it('drops a route that is not root-relative or not in normalized form, and non-string data', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    for (const route of ['//evil.example/x', '/\\evil.example', '/a/../b', 'https://evil.example/', '/%2F/evil']) {
      sdks.emitPush('notificationActionPerformed', {
        actionId: 'tap',
        notification: { data: { topic: 'friend-challenge', route, count: 3, aps: 'x', 'gcm.n.e': '1' } },
      });
    }
    expect(events).toHaveLength(5);
    for (const event of events) {
      expect(event).toEqual({ type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge' });
    }
  });

  it('keeps game data keys that only start like a reserved key, and drops the transport keys', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationActionPerformed', {
      actionId: 'tap',
      notification: {
        data: {
          topic: 'friend-challenge',
          routeId: 'r-1',
          fromUser: 'mina',
          topicality: 'high',
          from: '1234',
          collapse_key: 'k',
          'google.message_id': 'm',
          'gcm.notification.e': '1',
          fcm_options: 'x',
        },
      },
    });
    expect(events).toEqual([{
      type: 'opened',
      channel: 'remote',
      source: 'warm',
      topic: 'friend-challenge',
      data: { routeId: 'r-1', fromUser: 'mina', topicality: 'high' },
    }]);
  });

  it('reads an event without an action id as a tap', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationActionPerformed', {
      notification: { data: { topic: 'friend-challenge', route: '/?entry=friend-challenge' } },
    });
    expect(events).toEqual([{
      type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge', route: '/?entry=friend-challenge',
    }]);
  });

  it('names only a declared topic, and survives an event without a notification', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationActionPerformed', {
      actionId: 'tap',
      notification: { data: { topic: 'not-declared', route: '/shop' } },
    });
    sdks.emitPush('notificationReceived', { notification: { data: { topic: 'not-declared' } } });
    sdks.emitPush('notificationActionPerformed', { actionId: 'tap' });
    sdks.emitPush('notificationReceived', {});
    sdks.emitLocal('localNotificationActionPerformed', { actionId: 'tap' });
    expect(events).toEqual([
      { type: 'opened', channel: 'remote', source: 'warm', route: '/shop' },
      { type: 'received', channel: 'remote' },
      { type: 'opened', channel: 'remote', source: 'warm' },
      { type: 'received', channel: 'remote' },
    ]);
  });

  it('ignores a push dismiss, which is not an open', () => {
    const { provider, sdks } = setup({ platform: 'ios' });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationActionPerformed', {
      actionId: 'dismiss',
      notification: { data: { topic: 'friend-challenge', route: '/?entry=friend-challenge' } },
    });
    expect(events).toEqual([]);
  });

  it('opens the declared opt-out screen from the advertising opt-out action', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    const optOut = (topic: string) => sdks.emitPush('notificationActionPerformed', {
      actionId: 'advertising-opt-out',
      notification: { data: { topic, route: '/events/weekend' } },
    });
    optOut('weekend-event');
    // Never a route from the payload, and never for a topic that is not advertising.
    optOut('friend-challenge');
    expect(events).toEqual([
      { type: 'opened', channel: 'remote', source: 'warm', topic: 'weekend-event', route: '/settings/notifications' },
      { type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge' },
    ]);
  });

  it('reports received notifications and ignores local notifications it did not schedule', () => {
    const { provider, sdks } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    sdks.emitPush('notificationReceived', { notification: { data: { topic: 'friend-challenge' } } });
    sdks.emitPush('notificationReceived', { notification: {} });
    sdks.emitLocal('localNotificationReceived', {
      id: 1, extra: { mpgdKey: 'energy', mpgdTopic: 'energy-full', mpgdFireAt: '2026-10-12T06:00:00Z' },
    });
    sdks.emitLocal('localNotificationReceived', { id: 2, extra: { other: 'x' } });
    sdks.emitLocal('localNotificationActionPerformed', { actionId: 'tap', notification: { id: 3 } });
    sdks.emitLocal('localNotificationActionPerformed', {
      actionId: 'dismiss',
      notification: { id: 1, extra: { mpgdKey: 'energy', mpgdTopic: 'energy-full', mpgdFireAt: '2026-10-12T06:00:00Z' } },
    });
    expect(events).toEqual([
      { type: 'received', channel: 'remote', topic: 'friend-challenge' },
      { type: 'received', channel: 'remote' },
      { type: 'received', channel: 'local', topic: 'energy-full' },
    ]);
  });

  it('keeps delivering after a listener throws, and reports the error', () => {
    const { provider, sdks, errors } = setup();
    const events: NotificationEvent[] = [];
    provider.subscribe(() => {
      throw new Error('listener');
    });
    provider.subscribe((event) => events.push(event));
    sdks.tap({ channel: 'remote', topic: 'friend-challenge' });
    expect(events).toHaveLength(1);
    expect(errors).toEqual([new Error('listener')]);
  });

  it('buffers again while no listener is attached, for the next subscriber', () => {
    const { provider, sdks } = setup();
    const first: NotificationEvent[] = [];
    const leave = provider.subscribe((event) => first.push(event));
    leave();
    // Between two scenes: the open waits instead of being dropped, and a
    // receipt nobody saw is not replayed.
    sdks.emitPush('notificationReceived', { notification: { data: { topic: 'friend-challenge' } } });
    sdks.tap({ channel: 'remote', topic: 'friend-challenge', route: '/?entry=friend-challenge' });
    const next: NotificationEvent[] = [];
    provider.subscribe((event) => next.push(event));
    const other: NotificationEvent[] = [];
    provider.subscribe((event) => other.push(event));
    expect(first).toEqual([]);
    expect(next).toEqual([{
      type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge', route: '/?entry=friend-challenge',
    }]);
    // Delivered once: a second subscriber attached meanwhile does not get it again.
    expect(other).toEqual([]);
  });

  it('delivers an event dispatched while the buffer drains after the buffered ones', () => {
    const { provider, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge' });
    sdks.tap({ channel: 'remote', topic: 'weekend-event' });
    const seen: (string | undefined)[] = [];
    provider.subscribe((event) => {
      if (event.type !== 'opened') {
        return;
      }
      seen.push(event.topic);
      if (event.topic === 'friend-challenge') {
        // The game reacts to the first open in a way that taps again.
        sdks.tap({ channel: 'remote', topic: 'energy-full' });
      }
    });
    expect(seen).toEqual(['friend-challenge', 'weekend-event', 'energy-full']);
  });

  it('delivers an event dispatched during the drain to a subscriber added during it', () => {
    const { provider, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge' });
    const first: (string | undefined)[] = [];
    const second: (string | undefined)[] = [];
    let added = false;
    provider.subscribe((event) => {
      first.push(event.type === 'opened' ? event.topic : event.type);
      if (!added) {
        added = true;
        provider.subscribe((later) => second.push(later.type === 'opened' ? later.topic : later.type));
        sdks.tap({ channel: 'remote', topic: 'energy-full' });
      }
    });
    // The backlog stays the first subscriber's; the later tap reaches both.
    expect(first).toEqual(['friend-challenge', 'energy-full']);
    expect(second).toEqual(['energy-full']);
  });

  it('treats the same function subscribed twice as two subscriptions', () => {
    const { provider, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge' });
    const seen: (string | undefined)[] = [];
    const listener = (event: NotificationEvent): void => {
      seen.push(event.type === 'opened' ? event.topic : event.type);
    };
    const firstStop = provider.subscribe(listener);
    const secondStop = provider.subscribe(listener);
    sdks.tap({ channel: 'remote', topic: 'energy-full' });
    // The backlog once, to the first subscription; the live tap to both.
    expect(seen).toEqual(['friend-challenge', 'energy-full', 'energy-full']);
    // Removing one leaves the other.
    secondStop();
    sdks.tap({ channel: 'remote', topic: 'weekend-event' });
    expect(seen.at(-1)).toBe('weekend-event');
    expect(seen).toHaveLength(4);
    firstStop();
  });

  it('keeps the backlog whole when the first subscriber dispatches past the limit while draining', () => {
    const { provider, sdks } = setup();
    for (let index = 0; index < 64; index += 1) {
      sdks.tap({ channel: 'remote', topic: 'friend-challenge', data: { n: String(index) } });
    }
    const seen: string[] = [];
    let tapped = false;
    provider.subscribe((event) => {
      if (event.type === 'opened') {
        seen.push(event.data?.['n'] ?? event.topic ?? '');
      }
      if (!tapped) {
        tapped = true;
        sdks.tap({ channel: 'remote', topic: 'energy-full' });
      }
    });
    expect(seen).toHaveLength(65);
    expect(seen.slice(0, 64)).toEqual(Array.from({ length: 64 }, (_, index) => String(index)));
    expect(seen[64]).toBe('energy-full');
  });

  it('keeps the opens when the buffer overflows before the first subscriber', () => {
    const { provider, sdks } = setup();
    sdks.tap({ channel: 'remote', topic: 'friend-challenge' });
    for (let index = 0; index < 80; index += 1) {
      sdks.emitPush('notificationReceived', { notification: {} });
    }
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    expect(events).toHaveLength(64);
    expect(events[0]).toMatchObject({ type: 'opened', source: 'cold' });
  });
});

describe('Capacitor notifications provider: settings', () => {
  it('answers unavailable without a settings opener', async () => {
    const { provider } = setup();
    expect(await provider.openSettings?.()).toBe('unavailable');
  });

  it('resolves only once the app is back in the foreground', async () => {
    let opened = 0;
    const { provider, sdks } = setup({ openSettings: async () => { opened += 1; } });
    let answer: string | undefined;
    const call = provider.openSettings!().then((value) => {
      answer = value;
    });
    await settle();
    expect(opened).toBe(1);
    // A foreground report before the app left does not end the wait.
    sdks.app.setActive(true);
    await settle();
    expect(answer).toBeUndefined();
    sdks.app.setActive(false);
    await settle();
    expect(answer).toBeUndefined();
    sdks.app.setActive(true);
    await call;
    expect(answer).toBe('opened');
  });

  it('stops waiting when the app never left, or never came back', async () => {
    vi.useFakeTimers();
    const { provider, sdks } = setup({
      openSettings: async () => undefined,
      settingsLeaveTimeoutMs: 1_000,
      settingsReturnTimeoutMs: 5_000,
    });
    const stayed = provider.openSettings!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stayed).toBe('opened');
    const away = provider.openSettings!();
    await vi.advanceTimersByTimeAsync(10);
    sdks.app.setActive(false);
    let answer: string | undefined;
    void away.then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toBe('opened');
  });

  it('stops waiting for the return after two minutes by default', async () => {
    vi.useFakeTimers();
    expect(capacitorSettingsReturnTimeoutMs).toBe(120_000);
    const { provider, sdks } = setup({ openSettings: async () => undefined });
    let answer: string | undefined;
    void provider.openSettings!().then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(10);
    sdks.app.setActive(false);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toBe('opened');
  });

  it('does not wait forever for an opener that never settles', async () => {
    vi.useFakeTimers();
    let settle: (() => void) | undefined;
    const { provider, sdks, errors } = setup({
      openSettings: () => new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settingsLeaveTimeoutMs: 1_000,
      settingsReturnTimeoutMs: 5_000,
    });
    let answer: string | undefined;
    void provider.openSettings!().then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(10);
    // The app left, and the return was missed.
    sdks.app.setActive(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toBe('opened');
    expect(errors).toEqual([
      new Error('Capacitor notifications: openSettings had not settled when the settings wait timed out.'),
    ]);
    // A late settle changes nothing and reports nothing more.
    settle?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(answer).toBe('opened');
    expect(errors).toHaveLength(1);
    // A late rejection is only reported.
    const late = setup({
      openSettings: () => new Promise<void>((_resolve, reject) => {
        lateReject = reject;
      }),
      settingsLeaveTimeoutMs: 1_000,
      settingsReturnTimeoutMs: 5_000,
    });
    let lateReject: ((error: Error) => void) | undefined;
    let lateAnswer: string | undefined;
    void late.provider.openSettings!().then((value) => {
      lateAnswer = value;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lateAnswer).toBe('opened');
    lateReject?.(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
    expect(lateAnswer).toBe('opened');
    expect(late.errors).toHaveLength(2);
    expect(late.errors[1]).toEqual(new Error('late'));
    // A never-settling opener that never left the app ends at the leave timeout.
    const stalled = setup({
      openSettings: () => new Promise<void>(() => undefined),
      settingsLeaveTimeoutMs: 1_000,
      settingsReturnTimeoutMs: 5_000,
    });
    let second: string | undefined;
    void stalled.provider.openSettings!().then((value) => {
      second = value;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second).toBe('opened');
    expect(stalled.errors).toHaveLength(1);
  });

  it('reports no stall when the player returns before the opener settles', async () => {
    const { provider, sdks, errors } = setup({
      // Settles only after the settings screen closed, as some iOS openers do.
      openSettings: () => new Promise<void>(() => undefined),
    });
    const call = provider.openSettings!();
    await settle();
    sdks.app.setActive(false);
    sdks.app.setActive(true);
    expect(await call).toBe('opened');
    expect(errors).toEqual([]);
  });

  it('answers unavailable when the opener fails', async () => {
    const { provider, errors } = setup({
      openSettings: async () => Promise.reject(new Error('no settings')),
    });
    expect(await provider.openSettings?.()).toBe('unavailable');
    expect(errors).toEqual([new Error('no settings')]);
  });
});

describe('loadCapacitorNotificationSdks', () => {
  const native = (available: readonly string[]) => ({
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => available.includes(name),
  });

  it('loads nothing outside a native app', async () => {
    const importPush = vi.fn();
    expect(await loadCapacitorNotificationSdks({
      runtime: { isNativePlatform: () => false, isPluginAvailable: () => true },
      importPush,
    })).toEqual({});
    expect(importPush).not.toHaveBeenCalled();
  });

  it('loads each plugin the native shell implements', async () => {
    const FirebaseMessaging = {};
    const LocalNotifications = {};
    const loaded = await loadCapacitorNotificationSdks({
      runtime: native(['FirebaseMessaging', 'LocalNotifications']),
      importPush: async () => ({ FirebaseMessaging }),
      importLocal: async () => ({ LocalNotifications }),
    });
    expect(loaded.push).toBe(FirebaseMessaging);
    expect(loaded.local).toBe(LocalNotifications);
  });

  it('leaves out a plugin the shell lacks or that cannot be imported', async () => {
    const importLocal = vi.fn(async () => ({ LocalNotifications: {} }));
    expect(await loadCapacitorNotificationSdks({
      runtime: native(['FirebaseMessaging']),
      importPush: async () => Promise.reject(new Error('Cannot find module')),
      importLocal,
    })).toEqual({});
    expect(importLocal).not.toHaveBeenCalled();
    expect(await loadCapacitorNotificationSdks({
      runtime: native(['FirebaseMessaging']),
      importPush: async () => ({ FirebaseMessaging: undefined }),
    })).toEqual({});
  });

  it('imports the real plugin by default', async () => {
    // The plugin is a proxy that answers every property (`then` too), so it
    // is compared by identity; resolving the loader with it would hang.
    const loaded = await loadCapacitorNotificationSdks({ runtime: native(['LocalNotifications']) });
    expect(Object.keys(loaded)).toEqual(['local']);
    expect(loaded.local === LocalNotifications).toBe(true);
  });
});

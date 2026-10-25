import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationEvent, NotificationTopicDeclaration } from '@mpgd/platform/notifications';

import { createFakeNotificationSdks } from '../test/notifications-sdk-fixture.js';
import {
  capacitorAdvertisingRendererTimeoutMs,
  createCapacitorNotificationProvider,
} from './notifications-provider.js';
import { readCapacitorAdvertisingPushRenderer } from './notifications-renderer.js';

const advertising: NotificationTopicDeclaration = {
  id: 'events',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events',
  optOutRoute: '/settings/notifications',
  mapping: { channelId: 'mpgd-advertising' },
};
const service: NotificationTopicDeclaration = {
  id: 'friend-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=friend-challenge',
  mapping: {},
};

afterEach(() => {
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup(input: {
  readonly platform?: 'android' | 'ios';
  readonly topics?: readonly NotificationTopicDeclaration[];
  readonly renderer?: () => Promise<boolean>;
}) {
  const platform = input.platform ?? 'android';
  const sdks = createFakeNotificationSdks({ platform, now: () => '2026-10-25T03:00:00Z' });
  sdks.osState = 'granted';
  const errors: unknown[] = [];
  const provider = createCapacitorNotificationProvider({
    platform,
    topics: input.topics ?? [advertising, service],
    ...(sdks.push === undefined ? {} : { push: sdks.push }),
    ...(sdks.local === undefined ? {} : { local: sdks.local }),
    app: sdks.app,
    timeZone: () => 'Asia/Seoul',
    locale: () => 'ko-KR',
    onError: (error) => errors.push(error),
    ...(input.renderer === undefined ? {} : { advertisingRenderer: input.renderer }),
  });
  return { sdks, provider, errors };
}

describe('readCapacitorAdvertisingPushRenderer', () => {
  it('answers the plugin installed flag', async () => {
    for (const installed of [true, false]) {
      await expect(readCapacitorAdvertisingPushRenderer({
        getAdvertisingPushRenderer: async () => ({ installed }),
      })).resolves.toBe(installed);
    }
  });

  it('throws on a malformed answer and passes on an unimplemented method', async () => {
    for (const answer of [{}, null, 'yes', { installed: 'true' }]) {
      await expect(readCapacitorAdvertisingPushRenderer({
        getAdvertisingPushRenderer: async () => answer as never,
      })).rejects.toThrow('no installed flag');
    }
    await expect(readCapacitorAdvertisingPushRenderer({
      getAdvertisingPushRenderer: async () => {
        throw new Error('"CapacitorGameServices.getAdvertisingPushRenderer()" is not implemented on ios');
      },
    })).rejects.toThrow('not implemented');
  });
});

describe('Capacitor notifications provider: Android advertising rendering', () => {
  it('registers rendersAdvertising on Android when the shell renders advertising', async () => {
    const renderer = vi.fn(async () => true);
    const { sdks, provider } = setup({ renderer });
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'token-1' });
    await settle();
    expect(await provider.register?.()).toEqual({
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'token-1', permission: 'granted', rendersAdvertising: true },
      locale: 'ko-KR',
      timeZone: 'Asia/Seoul',
    });
    // Read once, when the provider was created.
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('leaves the claim out without the renderer, on a failed read, on iOS, and without advertising', async () => {
    const cases = [
      { renderer: async () => false },
      { renderer: async () => Promise.reject(new Error('not implemented')) },
      {},
      { platform: 'ios' as const, renderer: vi.fn(async () => true) },
      { topics: [service], renderer: vi.fn(async () => true) },
    ];
    for (const options of cases) {
      const { sdks, provider } = setup(options);
      sdks.issueEndpoint({ kind: 'fcm-token', value: 'token-1' });
      await settle();
      const registration = await provider.register?.();
      expect(registration?.address).toEqual({ kind: 'fcm-token', value: 'token-1', permission: 'granted' });
      if ('renderer' in options && vi.isMockFunction(options.renderer)) {
        // iOS shows the category's action itself; a catalog without
        // advertising on Android has nothing to render.
        expect(options.renderer).not.toHaveBeenCalled();
      }
    }
    const { errors } = setup({ renderer: async () => Promise.reject(new Error('not implemented')) });
    await settle();
    expect(errors).toEqual([new Error('not implemented')]);
  });

  it('does not report a shell without the method, and registers without the claim', async () => {
    const unimplemented = Object.assign(new Error('not implemented on android'), { code: 'UNIMPLEMENTED' });
    const { sdks, provider, errors } = setup({ renderer: async () => Promise.reject(unimplemented) });
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'token-1' });
    await settle();
    expect((await provider.register?.())?.address).toEqual({
      kind: 'fcm-token',
      value: 'token-1',
      permission: 'granted',
    });
    expect(errors).toEqual([]);
  });

  it('stops waiting for a renderer read that never answers', async () => {
    vi.useFakeTimers();
    const { sdks, provider } = setup({ renderer: () => new Promise<boolean>(() => undefined) });
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'token-1' });
    const registration = provider.register?.();
    await vi.advanceTimersByTimeAsync(capacitorAdvertisingRendererTimeoutMs);
    expect((await registration)?.address).toEqual({
      kind: 'fcm-token',
      value: 'token-1',
      permission: 'granted',
    });
  });

  it('announces a token again once the renderer read answers', async () => {
    let answer: (installed: boolean) => void = () => undefined;
    const renderer = () => new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const { sdks, provider } = setup({ renderer });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    // A first read settles the permission the token announcement carries.
    await provider.getPermission({ topics: ['events'] });
    sdks.issueEndpoint({ kind: 'fcm-token', value: 'token-1' });
    await settle();
    answer(true);
    await settle();
    await settle();
    const announced = events.flatMap((event) =>
      event.type === 'endpoint-changed' && event.registration.address.kind === 'fcm-token'
        ? [event.registration.address.rendersAdvertising === true]
        : []);
    expect(announced.at(-1)).toBe(true);
  });

  it('opens the declared opt-out screen from the renderer action, which the plugin reports as a tap', () => {
    const { sdks, provider } = setup({ renderer: async () => true });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    const open = (data: Record<string, string>) => sdks.emitPush('notificationActionPerformed', {
      actionId: 'tap',
      notification: { id: '0:1%abc', data },
    });
    const extras = {
      topic: 'events',
      route: '/events',
      offer: 'autumn',
      'google.message_id': '0:1%abc',
      'mpgd.tag': 'c0ffee',
    };
    open({ ...extras, 'mpgd.action': 'advertising-opt-out' });
    open(extras);
    // The mark on a topic that is not advertising opens nothing of the payload's.
    open({ topic: 'friend-challenge', route: '/evil', 'mpgd.action': 'advertising-opt-out' });
    expect(events).toEqual([
      {
        type: 'opened',
        channel: 'remote',
        source: 'warm',
        topic: 'events',
        route: '/settings/notifications',
        data: { offer: 'autumn' },
      },
      {
        type: 'opened',
        channel: 'remote',
        source: 'warm',
        topic: 'events',
        route: '/events',
        data: { offer: 'autumn' },
      },
      { type: 'opened', channel: 'remote', source: 'warm', topic: 'friend-challenge' },
    ]);
  });

  it('keeps a cold-start open from the renderer for the first subscriber', () => {
    const { sdks, provider } = setup({ renderer: async () => true });
    sdks.emitPush('notificationActionPerformed', {
      actionId: 'tap',
      notification: {
        data: { topic: 'events', route: '/events', 'mpgd.action': 'advertising-opt-out' },
      },
    });
    const events: NotificationEvent[] = [];
    provider.subscribe((event) => events.push(event));
    expect(events).toEqual([
      { type: 'opened', channel: 'remote', source: 'cold', topic: 'events', route: '/settings/notifications' },
    ]);
  });
});

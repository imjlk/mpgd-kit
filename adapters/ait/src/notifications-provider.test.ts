import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertNotificationCapabilities,
  NotificationError,
  type NotificationEvent,
} from '@mpgd/platform/notifications';

import { createFakeAitNotificationHost } from '../test/ait-notification-fixture.js';
import {
  aitNotificationAgreementEvidenceSchema,
  createAitNotificationCapabilities,
  createAitNotificationProvider,
  normalizeAitNotificationTopics,
  readAitNotificationLanding,
  type AitNotificationTopicMapping,
} from './notifications-provider.js';

const topics: Readonly<Record<string, AitNotificationTopicMapping>> = {
  'energy-full': { templateSetCode: 'my-game-energy-full', agreement: 'required' },
  'friend-challenge': { templateSetCode: 'my-game-challenge', agreement: 'required' },
  receipt: { templateSetCode: 'my-game-receipt', agreement: 'none' },
};

function setup(input: { readonly supported?: boolean; readonly initialUrl?: string } = {}) {
  const host = createFakeAitNotificationHost(input);
  const provider = createAitNotificationProvider({
    sdk: host.sdk,
    topics,
    timeZone: () => 'Asia/Seoul',
  });
  return { host, provider };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error instanceof NotificationError
      ? { code: error.code, hostCode: error.hostCode, retryable: error.retryable }
      : error;
  }
  throw new Error('Expected the call to fail.');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Apps in Toss notifications provider', () => {
  it('declares the Apps in Toss profile in a fresh block on every read', async () => {
    const { provider } = setup();
    const first = await provider.getCapabilities();
    expect(assertNotificationCapabilities(first)).toEqual(createAitNotificationCapabilities());
    expect(first).toMatchObject({
      availability: 'available',
      permission: { scope: 'topic', prompt: 'host', readable: false, userGesture: true, settings: false },
      remote: { supported: true, purposes: ['service', 'requested'], addressing: 'platform-user' },
      local: { supported: false },
      open: 'landing-url',
    });
    expect(await provider.getCapabilities()).not.toBe(first);
    expect(provider.provider).toBe('apps-in-toss');
  });

  it('is configuration-required without any mapped topic', async () => {
    const host = createFakeAitNotificationHost();
    const provider = createAitNotificationProvider({ sdk: host.sdk, topics: {} });
    expect((await provider.getCapabilities()).availability).toBe('configuration-required');
  });

  it('reads unknown, granted for a template without agreement, and unsupported otherwise', async () => {
    const { host, provider } = setup();
    await expect(provider.getPermission({ topics: ['energy-full', 'receipt', 'unmapped', 'receipt'] }))
      .resolves.toEqual({ topics: { 'energy-full': 'unknown', receipt: 'granted', unmapped: 'unsupported' } });
    host.setSupported(false);
    await expect(provider.getPermission({ topics: ['energy-full', 'receipt'] }))
      .resolves.toEqual({ topics: { 'energy-full': 'unsupported', receipt: 'granted' } });
    expect(host.calls).toEqual([]);
  });

  it('maps each agreement event and reports it as evidence', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'event', type: 'newAgreement' });
    await expect(provider.requestPermission({ topics: ['energy-full'] })).resolves.toEqual({
      snapshot: { topics: { 'energy-full': 'granted' } },
      outcomes: { 'energy-full': 'granted' },
      evidence: {
        schema: aitNotificationAgreementEvidenceSchema,
        payload: {
          provider: 'apps-in-toss',
          'templateSetCode:energy-full': 'my-game-energy-full',
          'result:energy-full': 'newAgreement',
        },
      },
    });
    host.queue({ kind: 'event', type: 'alreadyAgreed' });
    host.queue({ kind: 'event', type: 'agreementRejected' });
    const result = await provider.requestPermission({
      topics: ['energy-full', 'friend-challenge', 'receipt', 'unmapped'],
    });
    expect(result).toMatchObject({
      snapshot: {
        topics: {
          'energy-full': 'granted',
          'friend-challenge': 'denied',
          receipt: 'granted',
          unmapped: 'unsupported',
        },
      },
      outcomes: {
        'energy-full': 'already-granted',
        'friend-challenge': 'denied',
        receipt: 'already-granted',
        unmapped: 'unavailable',
      },
    });
    expect(result.evidence?.payload).toEqual({
      provider: 'apps-in-toss',
      'templateSetCode:energy-full': 'my-game-energy-full',
      'result:energy-full': 'alreadyAgreed',
      'templateSetCode:friend-challenge': 'my-game-challenge',
      'result:friend-challenge': 'agreementRejected',
    });
    expect(host.calls).toEqual(['my-game-energy-full', 'my-game-energy-full', 'my-game-challenge']);
    expect(host.cleanups).toBe(3);
    expect(host.open).toBe(0);
  });

  it('never prompts for a template without agreement or an unmapped topic', async () => {
    const { host, provider } = setup();
    await expect(provider.requestPermission({ topics: ['receipt', 'unmapped'] })).resolves.toEqual({
      snapshot: { topics: { receipt: 'granted', unmapped: 'unsupported' } },
      outcomes: { receipt: 'already-granted', unmapped: 'unavailable' },
    });
    expect(host.calls).toEqual([]);
  });

  it('settles a sheet without an answer as dismissed after 120 seconds and cleans up', async () => {
    vi.useFakeTimers();
    const { host, provider } = setup();
    host.queue({ kind: 'silent' });
    const pending = provider.requestPermission({ topics: ['energy-full'] });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(host.open).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      snapshot: { topics: { 'energy-full': 'unknown' } },
      outcomes: { 'energy-full': 'dismissed' },
    });
    expect(host.cleanups).toBe(1);
  });

  it('cleans up a sheet that answers before it returns its cleanup function', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'event', type: 'newAgreement', sync: true });
    await expect(provider.requestPermission({ topics: ['energy-full'] }))
      .resolves.toMatchObject({ outcomes: { 'energy-full': 'granted' } });
    expect(host.cleanups).toBe(1);
    expect(host.open).toBe(0);
  });

  it('answers a personalization-terms decline as action-required without prompting again', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'error', error: { code: 'TERMS_DISAGREED_MEMBER' } });
    await expect(provider.requestPermission({ topics: ['energy-full', 'friend-challenge'] }))
      .resolves.toEqual({
        snapshot: { topics: { 'energy-full': 'unknown', 'friend-challenge': 'unknown' } },
        outcomes: { 'energy-full': 'action-required', 'friend-challenge': 'action-required' },
        requiredAction: 'host-settings',
      });
    expect(host.calls).toEqual(['my-game-energy-full']);
    expect(host.cleanups).toBe(1);
  });

  it('normalizes host failures', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'error', error: { code: 'NOTIFICATION_AGREEMENT_FAILED' } });
    await expect(codeOf(provider.requestPermission({ topics: ['energy-full'] }))).resolves.toEqual({
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      hostCode: 'NOTIFICATION_AGREEMENT_FAILED',
      retryable: false,
    });
    host.queue({ kind: 'throw', error: Object.assign(new Error('update'), { code: 'UNSUPPORTED_APP_VERSION' }) });
    await expect(codeOf(provider.requestPermission({ topics: ['energy-full'] }))).resolves.toMatchObject({
      code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
      retryable: false,
    });
    host.queue({ kind: 'error', error: new Error('bridge gone') });
    await expect(codeOf(provider.requestPermission({ topics: ['energy-full'] }))).resolves.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    expect(host.cleanups).toBe(2);
    expect(host.open).toBe(0);
  });

  it('refuses an unknown event as a temporary failure', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'event', type: 'agreed' as never });
    await expect(codeOf(provider.requestPermission({ topics: ['energy-full'] }))).resolves.toMatchObject({
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
  });

  it('throws NOTIFICATIONS_HOST_VERSION_UNSUPPORTED before any sheet on a Toss app older than 5.255.0', async () => {
    const { host, provider } = setup({ supported: false });
    await expect(codeOf(provider.requestPermission({ topics: ['receipt', 'energy-full'] })))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED' });
    // A template without agreement needs no SDK at all.
    await expect(provider.requestPermission({ topics: ['receipt'] }))
      .resolves.toMatchObject({ outcomes: { receipt: 'already-granted' } });
    expect(host.calls).toEqual([]);
  });

  it('shows one sheet at a time when requests overlap', async () => {
    const { host } = setup();
    host.queue({ kind: 'event', type: 'newAgreement' });
    host.queue({ kind: 'event', type: 'agreementRejected' });
    let maxOpen = 0;
    const original = host.sdk.requestAgreement;
    const observed = Object.assign(
      (request: Parameters<typeof original>[0]) => {
        const cleanup = original(request);
        maxOpen = Math.max(maxOpen, host.open);
        return cleanup;
      },
      { isSupported: () => true },
    );
    const serialized = createAitNotificationProvider({
      sdk: { ...host.sdk, requestAgreement: observed },
      topics,
    });
    const [first, second] = await Promise.all([
      serialized.requestPermission({ topics: ['energy-full'] }),
      serialized.requestPermission({ topics: ['friend-challenge'] }),
    ]);
    expect(first.outcomes).toEqual({ 'energy-full': 'granted' });
    expect(second.outcomes).toEqual({ 'friend-challenge': 'denied' });
    expect(maxOpen).toBe(1);
  });

  it('returns earlier answers and their evidence when a later sheet fails', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'event', type: 'agreementRejected' });
    host.queue({ kind: 'error', error: { code: 'NOTIFICATION_AGREEMENT_FAILED' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await provider.requestPermission({
        topics: ['energy-full', 'friend-challenge', 'receipt'],
      });
      expect(result).toEqual({
        snapshot: { topics: { 'energy-full': 'denied', 'friend-challenge': 'unknown', receipt: 'granted' } },
        outcomes: { 'energy-full': 'denied', 'friend-challenge': 'dismissed', receipt: 'already-granted' },
        evidence: {
          schema: aitNotificationAgreementEvidenceSchema,
          payload: {
            provider: 'apps-in-toss',
            'templateSetCode:energy-full': 'my-game-energy-full',
            'result:energy-full': 'agreementRejected',
          },
        },
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(host.cleanups).toBe(2);
  });

  it('prompts no further topic after an unanswered sheet', async () => {
    vi.useFakeTimers();
    const { host, provider } = setup();
    host.queue({ kind: 'silent' });
    const pending = provider.requestPermission({ topics: ['energy-full', 'friend-challenge'] });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(pending).resolves.toMatchObject({
      outcomes: { 'energy-full': 'dismissed', 'friend-challenge': 'dismissed' },
    });
    expect(host.calls).toEqual(['my-game-energy-full']);
  });

  it('cleans up a sheet that fails before it returns its cleanup function', async () => {
    const { host, provider } = setup();
    host.queue({ kind: 'error', error: { code: 'TERMS_DISAGREED_MEMBER' }, sync: true });
    await expect(provider.requestPermission({ topics: ['energy-full'] }))
      .resolves.toMatchObject({ outcomes: { 'energy-full': 'action-required' } });
    expect(host.cleanups).toBe(1);
    expect(host.open).toBe(0);
  });

  it('survives a throwing cleanup, support probe, and listener', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const throwingCleanup = createAitNotificationProvider({
        sdk: {
          requestAgreement: Object.assign(
            (request: Parameters<ReturnType<typeof createFakeAitNotificationHost>['sdk']['requestAgreement']>[0]) => {
              queueMicrotask(() => request.onEvent({ type: 'newAgreement' }));
              return () => {
                throw new Error('cleanup failed');
              };
            },
            { isSupported: () => true },
          ),
          readInitialUrl: () => 'intoss://my-game/?referrer=push',
        },
        topics,
      });
      await expect(throwingCleanup.requestPermission({ topics: ['energy-full'] }))
        .resolves.toMatchObject({ outcomes: { 'energy-full': 'granted' } });
      expect(() => throwingCleanup.subscribe(() => {
        throw new Error('listener failed');
      })).not.toThrow();

      const throwingProbe = createAitNotificationProvider({
        sdk: {
          ...createFakeAitNotificationHost().sdk,
          requestAgreement: Object.assign(() => () => {}, {
            isSupported: () => {
              throw new Error('no probe');
            },
          }),
        },
        topics,
      });
      await expect(throwingProbe.getPermission({ topics: ['energy-full'] }))
        .resolves.toEqual({ topics: { 'energy-full': 'unsupported' } });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('caps the agreement timeout at 120 seconds', async () => {
    vi.useFakeTimers();
    const host = createFakeAitNotificationHost();
    const provider = createAitNotificationProvider({
      sdk: host.sdk,
      topics,
      agreementTimeoutMs: 10 * 60_000,
    });
    host.queue({ kind: 'silent' });
    const pending = provider.requestPermission({ topics: ['energy-full'] });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(pending).resolves.toMatchObject({ outcomes: { 'energy-full': 'dismissed' } });
    for (const agreementTimeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createAitNotificationProvider({ sdk: host.sdk, topics, agreementTimeoutMs }))
        .toThrow(/positive/u);
    }
  });

  it('keeps a topic id such as __proto__ an ordinary key', async () => {
    const host = createFakeAitNotificationHost();
    const provider = createAitNotificationProvider({
      sdk: host.sdk,
      topics: JSON.parse('{"__proto__":{"templateSetCode":"my-game-proto","agreement":"none"}}') as never,
    });
    const result = await provider.requestPermission({ topics: ['__proto__'] });
    expect(Object.keys(result.outcomes)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(result.outcomes)).toBe(Object.prototype);
  });

  it('registers nothing while no topic is mapped', async () => {
    const provider = createAitNotificationProvider({ sdk: createFakeAitNotificationHost().sdk, topics: {} });
    await expect(provider.register?.()).resolves.toBeNull();
  });

  it('registers the platform user with the device zone', async () => {
    const { provider } = setup();
    await expect(provider.register?.()).resolves.toEqual({
      provider: 'apps-in-toss',
      address: { kind: 'platform-user' },
      timeZone: 'Asia/Seoul',
    });
    await expect(provider.openSettings?.()).resolves.toBe('unavailable');
    expect(provider.revokePermission).toBeUndefined();
    expect(provider.scheduleLocal).toBeUndefined();
  });

  it('gives a push or inbox launch to the first subscriber once, as a cold open', () => {
    const { provider } = setup({ initialUrl: 'intoss://my-game/daily?entry=daily&referrer=inbox' });
    const first: NotificationEvent[] = [];
    const second: NotificationEvent[] = [];
    const unsubscribe = provider.subscribe((event) => first.push(event));
    unsubscribe();
    provider.subscribe((event) => second.push(event));
    expect(first).toEqual([
      { type: 'opened', channel: 'remote', source: 'cold', referrer: 'inbox', route: '/daily?entry=daily' },
    ]);
    expect(second).toEqual([]);
  });

  it('emits nothing for an ordinary launch or an unreadable launch URL', () => {
    for (const initialUrl of ['intoss://my-game/daily?referrer=gamehome', undefined]) {
      const events: NotificationEvent[] = [];
      setup(initialUrl === undefined ? {} : { initialUrl }).provider
        .subscribe((event) => events.push(event));
      expect(events).toEqual([]);
    }
    const throwing = createAitNotificationProvider({
      sdk: {
        ...createFakeAitNotificationHost().sdk,
        readInitialUrl: () => {
          throw new Error('no native constant');
        },
      },
      topics,
    });
    const events: NotificationEvent[] = [];
    throwing.subscribe((event) => events.push(event));
    expect(events).toEqual([]);
  });

  it('validates topic mappings', () => {
    expect(() => normalizeAitNotificationTopics({ a: { templateSetCode: ' ', agreement: 'required' } }))
      .toThrow(/non-empty templateSetCode/u);
    expect(() => normalizeAitNotificationTopics({
      a: { templateSetCode: 'x', agreement: 'optional' as never },
    })).toThrow(/agreement/u);
    expect(normalizeAitNotificationTopics({ a: { templateSetCode: ' x ', agreement: 'none' } }))
      .toEqual(new Map([['a', { templateSetCode: 'x', agreement: 'none' }]]));
    expect(() => createAitNotificationProvider({
      sdk: createFakeAitNotificationHost().sdk,
      topics,
      agreementTimeoutMs: 0,
    })).toThrow(/positive/u);
  });
});

describe('readAitNotificationLanding', () => {
  it.each([
    ['intoss://my-game/daily?referrer=push', { referrer: 'push', route: '/daily' }],
    ['intoss://my-game?referrer=push', { referrer: 'push', route: '/' }],
    ['intoss://my-game/?entry=continue&referrer=push&x=1', { referrer: 'push', route: '/?entry=continue&x=1' }],
    ['intoss://my-game/a/../b?referrer=inbox#top', { referrer: 'inbox', route: '/b#top' }],
    ['intoss://my-game/?referrer=%70ush', { referrer: 'push', route: '/' }],
    ['intoss-private://my-game/levels?referrer=push', { referrer: 'push', route: '/levels' }],
    ['https://my-game.apps.tossmini.com/daily?referrer=push', { referrer: 'push', route: '/daily' }],
    ['/daily?referrer=push', { referrer: 'push', route: '/daily' }],
    // The authority is never read: another app or host does not move the route.
    ['intoss://other\\@my-game/x?referrer=push', { referrer: 'push', route: '/x' }],
    // A route a client could read as another host is left out; the open still counts.
    ['intoss://my-game//evil.example/x?referrer=push', { referrer: 'push' }],
    ['intoss://my-game/%2F%2Fevil.example?referrer=push', { referrer: 'push' }],
    ['intoss://my-game/\\evil.example?referrer=push', { referrer: 'push' }],
    [`intoss://my-game/${'a'.repeat(2048)}?referrer=push`, { referrer: 'push' }],
  ])('reads %s', (url, expected) => {
    expect(readAitNotificationLanding(url)).toEqual(expected);
  });

  it.each([
    'intoss://my-game/daily',
    'intoss://my-game/daily?referrer=gamehome',
    'intoss://my-game/daily?referrerx=push',
    'intoss://my-game/daily#referrer=push',
    'intoss://my-game/da\tily?referrer=push',
    '//evil.example/?referrer=push',
    'daily?referrer=push',
    '',
  ])('does not read %s as an open', (url) => {
    expect(readAitNotificationLanding(url)).toBeUndefined();
  });

  it('takes the first referrer when a launch repeats it', () => {
    expect(readAitNotificationLanding('intoss://my-game/?referrer=gamehome&referrer=push'))
      .toBeUndefined();
    expect(readAitNotificationLanding('intoss://my-game/?referrer=push&referrer=gamehome'))
      .toEqual({ referrer: 'push', route: '/' });
  });
});

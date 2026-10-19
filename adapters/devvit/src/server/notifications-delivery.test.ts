import { describe, expect, it } from 'vitest';

import {
  createNotificationProviderRegistry,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteDeliveryRequest,
} from '@mpgd/game-services/notifications';
import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import { createFakeNotificationRedis } from '../../test/fake-notification-redis.js';
import {
  createDevvitNotificationDeliveryProvider,
  createDevvitNotificationProviderEntry,
  createDevvitNotificationService,
  devvitNotificationProviderCodes,
  devvitNotificationSession,
  type DevvitEnqueueResponse,
  type DevvitNotificationsDeliveryClient,
} from './notifications-delivery.js';

const user = 't2_alice';

interface FakePlugin extends DevvitNotificationsDeliveryClient {
  readonly calls: { title: string; body: string; userId: string; link: string; data: Record<string, string> }[];
  readonly optedIn: Set<string>;
  /** Answers for the next `enqueue` calls; a function throws or answers. */
  readonly answers: (DevvitEnqueueResponse | (() => Promise<DevvitEnqueueResponse>))[];
}

function createFakePlugin(): FakePlugin {
  const plugin: FakePlugin = {
    calls: [],
    optedIn: new Set([user]),
    answers: [],
    async enqueue(options) {
      for (const recipient of options.recipients) {
        plugin.calls.push({
          title: options.title,
          body: options.body,
          userId: recipient.userId,
          link: recipient.link,
          data: recipient.data,
        });
      }
      const next = plugin.answers.shift();
      if (typeof next === 'function') {
        return next();
      }
      return next ?? { successCount: options.recipients.length, failureCount: 0, errors: [] };
    },
    async isOptedIn(userId) {
      return plugin.optedIn.has(userId);
    },
  };
  return plugin;
}

const topic = {
  id: 'friend-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=friend-challenge',
  mapping: { title: 'New challenge', body: '{{friend}} sent you a challenge.', link: 't3_daily' },
} as const;

function request(overrides: Partial<NotificationRemoteDeliveryRequest> = {}): NotificationRemoteDeliveryRequest {
  return {
    idempotencyKey: 'k-1',
    sendKey: 'k-1',
    provider: 'devvit',
    player: user,
    topic,
    recipient: { kind: 'platform-user', id: user },
    content: {
      title: 'New challenge',
      body: 'Mina sent you a challenge.',
      route: '/?entry=friend-challenge',
      source: 'mapping',
    },
    link: 't3_daily',
    at: '2026-10-19T03:00:00Z',
    ...overrides,
  };
}

describe('createDevvitNotificationDeliveryProvider', () => {
  it('enqueues one recipient with the filled text, the link, and no template data', async () => {
    const plugin = createFakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    await expect(provider.send(request())).resolves.toEqual({ status: 'accepted' });
    expect(plugin.calls).toEqual([
      { title: 'New challenge', body: 'Mina sent you a challenge.', userId: user, link: 't3_daily', data: {} },
    ]);
  });

  it.each([
    ['a device recipient', { recipient: { kind: 'device', installationId: 'i', address: { kind: 'fcm-token', value: 'x' } } }, 'configuration', devvitNotificationProviderCodes.deviceRecipient],
    ['a recipient that is not a t2_ id', { recipient: { kind: 'platform-user', id: 'alice' } }, 'recipient', devvitNotificationProviderCodes.recipientInvalid],
    ['no link', { link: undefined }, 'configuration', devvitNotificationProviderCodes.linkInvalid],
    ['a link that is not a post or comment', { link: 't5_subreddit' }, 'configuration', devvitNotificationProviderCodes.linkInvalid],
    ['a title over 60 code points', { content: { ...request().content, title: 'x'.repeat(61), body: 'b' } }, 'configuration', devvitNotificationProviderCodes.titleTooLong],
    ['a body over 100 code points', { content: { ...request().content, title: 't', body: 'x'.repeat(101) } }, 'configuration', devvitNotificationProviderCodes.bodyTooLong],
    ['a filled text with a mustache tag', { content: { ...request().content, title: 't', body: '{{evil}} sent you a challenge.' } }, 'configuration', devvitNotificationProviderCodes.templateSyntax],
    ['a content without a body', { content: { route: '/', source: 'host-template', title: 't' } }, 'configuration', devvitNotificationProviderCodes.textMissing],
    ['a blank title', { content: { ...request().content, title: ' ' } }, 'configuration', devvitNotificationProviderCodes.textMissing],
  ] as const)('refuses %s before enqueue', async (_name, overrides, reason, providerCode) => {
    const plugin = createFakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    const merged: Record<string, unknown> = { ...request(), ...overrides };
    if ('link' in overrides && overrides.link === undefined) {
      delete merged['link'];
    }
    await expect(provider.send(merged as unknown as NotificationRemoteDeliveryRequest)).resolves.toEqual({
      status: 'rejected',
      reason,
      providerCode,
    });
    expect(plugin.calls).toEqual([]);
  });

  it('counts the limits in code points of the filled text, not UTF-16 units', async () => {
    const plugin = createFakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    // 60 emoji are 120 UTF-16 code units and 60 code points.
    const title = '🎯'.repeat(60);
    const body = 'é'.repeat(100);
    expect(title.length).toBe(120);
    await expect(provider.send(request({ content: { ...request().content, title, body } }))).resolves.toEqual({ status: 'accepted' });
    await expect(provider.send(request({ content: { ...request().content, title: `${title}!`, body } }))).resolves.toMatchObject({
      providerCode: devvitNotificationProviderCodes.titleTooLong,
    });
  });

  it.each<[string, DevvitEnqueueResponse | (() => Promise<DevvitEnqueueResponse>), NotificationRemoteDeliveryAnswer]>([
    ['a rate-limit error', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Rate limit exceeded for user' }] }, { status: 'rate-limited' }],
    ['another per-user error', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'user has not opted in' }] }, { status: 'rejected', reason: 'recipient', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['an error without a user', { successCount: 0, failureCount: 1, errors: [{ userId: undefined, message: 'too many requests' }] }, { status: 'rate-limited' }],
    ['a failure count without errors', { successCount: 0, failureCount: 1, errors: [] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a per-user error nothing names', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'internal error' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['the daily app limit', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'App reached the daily limit' }] }, { status: 'rate-limited', retryAfterSeconds: 3600 }],
    ['a success next to an error', { successCount: 1, failureCount: 1, errors: [{ userId: 't2_other', message: 'x' }] }, { status: 'accepted' }],
    ['an error for another user only', { successCount: 0, failureCount: 0, errors: [{ userId: 't2_other', message: 'x' }] }, { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueueUnanswered }],
    ['a length refusal that mentions a limit', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'title exceeds the character limit' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a refusal of the link, not the user', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'post not found' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a user refusal that names no user', { successCount: 0, failureCount: 1, errors: [{ userId: undefined, message: 'user has opted out' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a deleted user', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'User not found' }] }, { status: 'rejected', reason: 'recipient', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a notification limit at the end of the message', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'User notification limit reached' }] }, { status: 'rate-limited' }],
    ['a length limit with a preposition', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'character limit exceeded for body' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a bare limit', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Limit reached' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a named account refusal', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Account t2_alice has been suspended' }] }, { status: 'rejected', reason: 'recipient', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['adopting is not opting', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'adoption in progress' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a daily send limit without a verb', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Daily send limit' }] }, { status: 'rate-limited', retryAfterSeconds: 3600 }],
    ['a per-user limit', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Per-user limit' }] }, { status: 'rate-limited' }],
    ['plural limits', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Daily notification limits exceeded' }] }, { status: 'rate-limited', retryAfterSeconds: 3600 }],
    ['a missing link that names the user', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Link t3_abc for user t2_alice does not exist' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a recipient link', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Recipient link not found' }] }, { status: 'rejected', reason: 'configuration', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['a named user not found', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'User t2_alice not found' }] }, { status: 'rejected', reason: 'recipient', providerCode: devvitNotificationProviderCodes.enqueueRejected }],
    ['throttling', { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'Throttled: try later' }] }, { status: 'rate-limited' }],
    ['a malformed answer', null as unknown as DevvitEnqueueResponse, { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueueUnanswered }],
    ['an answer that counts nothing', { successCount: 0, failureCount: 0, errors: [] }, { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueueUnanswered }],
    ['a call that throws', () => Promise.reject(new Error('twirp unavailable')), { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueueFailed }],
  ])('maps %s per recipient', async (_name, answer, expected) => {
    const plugin = createFakePlugin();
    plugin.answers.push(answer === null ? (() => Promise.resolve(answer)) : answer);
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    await expect(provider.send(request())).resolves.toEqual(expected);
  });

  it("reports every enqueue failure with Devvit's message and the answer it got", async () => {
    const plugin = createFakePlugin();
    plugin.answers.push(
      { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'user has opted out' }] },
      () => Promise.reject(new Error('deadline exceeded')),
    );
    const reports: unknown[] = [];
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      onEnqueueError: (report) => {
        reports.push(report);
        throw new Error('a failing log');
      },
    });
    await expect(provider.send(request())).resolves.toMatchObject({ status: 'rejected', reason: 'recipient' });
    await expect(provider.send(request())).resolves.toMatchObject({ status: 'ambiguous' });
    expect(reports).toEqual([
      { sendKey: 'k-1', source: 'answer', message: 'user has opted out', answer: 'rejected', reason: 'recipient' },
      { sendKey: 'k-1', source: 'thrown', message: 'deadline exceeded', answer: 'ambiguous' },
    ]);
  });

  it('keeps the default answer when the classifier throws, and never classifies an empty answer', async () => {
    const plugin = createFakePlugin();
    plugin.answers.push(
      { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'user has opted out' }] },
      { successCount: 0, failureCount: 0, errors: [] },
    );
    const seen: string[] = [];
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      classifyEnqueueError: (message) => {
        seen.push(message);
        throw new Error('broken classifier');
      },
    });
    await expect(provider.send(request())).resolves.toMatchObject({ status: 'rejected', reason: 'recipient' });
    await expect(provider.send(request())).resolves.toMatchObject({ status: 'ambiguous' });
    expect(seen).toEqual(['user has opted out']);
  });

  it('says in the report when the classifier threw', async () => {
    const plugin = createFakePlugin();
    plugin.answers.push({ successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'internal error' }] });
    const reports: { message: string }[] = [];
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      classifyEnqueueError: () => {
        throw new Error('broken classifier');
      },
      onEnqueueError: (report) => {
        reports.push(report);
      },
    });
    await provider.send(request());
    expect(reports[0]?.message).toBe('internal error (classifyEnqueueError threw: broken classifier)');
  });

  it('lets a deployment classify a thrown error that proves nothing was sent', async () => {
    const plugin = createFakePlugin();
    plugin.answers.push(() => Promise.reject(new Error('PERMISSION_DENIED: app not approved')));
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      classifyEnqueueError: (message, source) =>
        (source === 'thrown' && message.startsWith('PERMISSION_DENIED') ? 'configuration' : undefined),
    });
    await expect(provider.send(request())).resolves.toEqual({
      status: 'rejected',
      reason: 'configuration',
      providerCode: devvitNotificationProviderCodes.enqueueFailed,
    });
  });

  it('lets a deployment classify the enqueue errors it observes', async () => {
    const plugin = createFakePlugin();
    plugin.answers.push({ successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'APP_NOT_APPROVED' }] });
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      classifyEnqueueError: (message) => (message === 'APP_NOT_APPROVED' ? 'rate-limited' : undefined),
    });
    await expect(provider.send(request())).resolves.toEqual({ status: 'rate-limited' });
  });

  it('reads isOptedIn at send time', async () => {
    const plugin = createFakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    await expect(provider.readPermission?.({ player: user, topic: 'friend-challenge' })).resolves.toBe('granted');
    plugin.optedIn.delete(user);
    await expect(provider.readPermission?.({ player: user, topic: 'friend-challenge' })).resolves.toBe('prompt');
    await expect(provider.readPermission?.({ player: 'guest', topic: 'friend-challenge' })).resolves.toBe('unknown');
  });
});

describe('createDevvitNotificationProviderEntry', () => {
  it('is the reference devvit entry with the Devvit limits, and the registry serves it for reddit', () => {
    const entry = createDevvitNotificationProviderEntry();
    expect(entry).toEqual(referenceNotificationProviders.devvit);
    expect(entry.limits).toEqual([{ count: 2, windowSeconds: 86_400 }]);
    expect(entry.rate).toEqual({ count: 25_000, windowSeconds: 86_400 });
    const registry = createNotificationProviderRegistry([
      {
        entry,
        delivery: createDevvitNotificationDeliveryProvider({ notifications: createFakePlugin() }),
      },
    ]);
    expect(registry.providerForTarget('reddit')?.entry.provider).toBe('devvit');
    expect(createDevvitNotificationProviderEntry()).not.toBe(entry);
  });
});

const catalogFile = {
  version: '2026-10-19',
  defaultLocale: 'en',
  topics: [
    {
      id: 'friend-challenge',
      purpose: 'service',
      channels: ['remote'],
      route: '/?entry=friend-challenge',
      targets: {
        reddit: {
          title: 'New challenge',
          body: '{{friend}} sent you a challenge.',
          link: 't3_daily',
        },
      },
    },
    {
      id: 'daily-puzzle',
      purpose: 'requested',
      channels: ['remote'],
      route: '/?entry=daily',
      targets: { reddit: { title: 'Daily puzzle', body: 'A new puzzle is open.' } },
    },
  ],
};

describe('createDevvitNotificationService', () => {
  const setup = (now: { value: string }, redis = createFakeNotificationRedis(), plugin = createFakePlugin()) => ({
    redis,
    plugin,
    ...createDevvitNotificationService({
      redis,
      notifications: plugin,
      catalog: catalogFile,
      now: () => now.value,
      random: () => 0,
    }),
  });

  it('sends through the gate: the send-time opt-in read, the link, and 2 per user per day', async () => {
    const now = { value: '2026-10-19T03:00:00Z' };
    const { service, plugin } = setup(now);
    const deliver = (key: string, extra: Record<string, unknown> = {}) => service.deliver({
      idempotencyKey: key,
      player: user,
      topic: 'friend-challenge',
      templateData: { friend: 'Mina' },
      ...extra,
    });
    await expect(deliver('f-1')).resolves.toMatchObject({ status: 'delivered' });
    expect(plugin.calls.at(-1)).toMatchObject({ body: 'Mina sent you a challenge.', link: 't3_daily' });
    await expect(deliver('f-2', { link: 't1_comment' })).resolves.toMatchObject({ status: 'delivered' });
    expect(plugin.calls.at(-1)).toMatchObject({ link: 't1_comment' });
    await expect(deliver('f-3')).resolves.toMatchObject({ status: 'suppressed', reason: 'provider-limit' });
    await expect(deliver('f-1')).resolves.toMatchObject({ status: 'delivered', alreadyProcessed: true });
    expect(plugin.calls).toHaveLength(2);

    plugin.optedIn.delete(user);
    now.value = '2026-10-20T04:00:00Z';
    await expect(deliver('f-4')).resolves.toMatchObject({ status: 'suppressed', reason: 'permission-denied' });
  });

  it('answers link-missing for a topic without a link when the send names none', async () => {
    const now = { value: '2026-10-19T03:00:00Z' };
    const { service, plugin } = setup(now);
    await service.recordConsent(devvitNotificationSession(user), {
      kind: 'topic-preference',
      topic: 'daily-puzzle',
      state: 'granted',
      source: 'player',
    });
    await expect(service.deliver({ idempotencyKey: 'd-1', player: user, topic: 'daily-puzzle' }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'link-missing' });
    await expect(service.deliver({ idempotencyKey: 'd-2', player: user, topic: 'daily-puzzle', link: 't3_today' }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(plugin.calls).toEqual([
      expect.objectContaining({ title: 'Daily puzzle', link: 't3_today' }),
    ]);
  });

  it('has no recipient for a player that is not a Reddit user id', async () => {
    const { service } = setup({ value: '2026-10-19T03:00:00Z' });
    await expect(service.deliver({ idempotencyKey: 'g-1', player: 'guest-1', topic: 'friend-challenge', templateData: { friend: 'M' } }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'no-endpoint' });
  });

  it('refuses a catalog the Devvit entry rejects', () => {
    const redis = createFakeNotificationRedis();
    const long = structuredClone(catalogFile);
    (long.topics[0] as { targets: { reddit: { title: string } } }).targets.reddit.title = 'x'.repeat(61);
    expect(() => createDevvitNotificationService({ redis, notifications: createFakePlugin(), catalog: long }))
      .toThrow(/60/u);
  });

  it('fences the ledger across two servers: a holder whose lease ran out cannot settle the row again', async () => {
    const now = { value: '2026-10-19T03:00:00Z' };
    const redis = createFakeNotificationRedis();
    const plugin = createFakePlugin();
    let releaseA: ((answer: DevvitEnqueueResponse) => void) | undefined;
    plugin.answers.push(() => new Promise<DevvitEnqueueResponse>((resolve) => {
      releaseA = resolve;
    }));
    const a = setup(now, redis, plugin);
    const b = setup(now, redis, plugin);
    const delivering = a.service.deliver({
      idempotencyKey: 'fence-1',
      player: user,
      topic: 'friend-challenge',
      templateData: { friend: 'Mina' },
    });
    // Server A claimed the row and is inside enqueue.
    while (releaseA === undefined) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    // The lease (300 s) runs out; server B's scheduler replays the row.
    now.value = '2026-10-19T03:05:01Z';
    const replay = await b.service.dispatchDue();
    expect(replay.failed).toBe(0);
    expect(replay.results).toEqual([{ sendKey: 'fence-1', outcome: { status: 'delivered', alreadyProcessed: false } }]);
    // A's late answer is a refusal; its claim is stale, so B's delivery stands.
    releaseA({ successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'user has not opted in' }] });
    await expect(delivering).resolves.toMatchObject({ status: 'delivered' });
    const stored = await a.store.getSend('fence-1');
    expect(stored?.send.rows.map((row) => row.state.status)).toEqual(['delivered']);
    expect(await a.store.listHistory({ player: user, since: '2026-10-19T00:00:00Z' })).toHaveLength(1);
    // Devvit's enqueue takes no idempotency key: the replay reached it twice.
    expect(plugin.calls).toHaveLength(2);
  });

  it("keeps the replay's claim when the stale holder's late answer is accepted too", async () => {
    const now = { value: '2026-10-19T03:00:00Z' };
    const redis = createFakeNotificationRedis();
    const plugin = createFakePlugin();
    let releaseA: ((answer: DevvitEnqueueResponse) => void) | undefined;
    plugin.answers.push(() => new Promise<DevvitEnqueueResponse>((resolve) => {
      releaseA = resolve;
    }));
    const a = setup(now, redis, plugin);
    const b = setup(now, redis, plugin);
    const delivering = a.service.deliver({
      idempotencyKey: 'fence-2',
      player: user,
      topic: 'friend-challenge',
      templateData: { friend: 'Mina' },
    });
    while (releaseA === undefined) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    now.value = '2026-10-19T03:05:01Z';
    await b.service.dispatchDue();
    const afterReplay = await a.store.getSend('fence-2');
    releaseA({ successCount: 1, failureCount: 0, errors: [] });
    await expect(delivering).resolves.toMatchObject({ status: 'delivered' });
    // A's stale claim wrote nothing: the row and its version are B's.
    expect((await a.store.getSend('fence-2'))?.version).toBe(afterReplay?.version);
    expect(await a.store.listHistory({ player: user, since: '2026-10-19T00:00:00Z' })).toHaveLength(1);
  });

  it('takes a store, or Redis with its store options, never both and never neither', () => {
    const redis = createFakeNotificationRedis();
    const store = setup({ value: '2026-10-19T03:00:00Z' }).store;
    const base = { notifications: createFakePlugin(), catalog: catalogFile };
    expect(() => createDevvitNotificationService({ ...base, redis, store })).toThrow(TypeError);
    expect(() => createDevvitNotificationService({ ...base, store, storeOptions: { namespace: 'x' } })).toThrow(TypeError);
    expect(() => createDevvitNotificationService(base)).toThrow(TypeError);
    expect(createDevvitNotificationService({ ...base, store }).store).toBe(store);
  });

  it('reports enqueue failures through onError', async () => {
    const errors: unknown[] = [];
    const plugin = createFakePlugin();
    plugin.answers.push({ successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'internal error' }] });
    const { service } = createDevvitNotificationService({
      redis: createFakeNotificationRedis(),
      notifications: plugin,
      catalog: catalogFile,
      now: () => '2026-10-19T03:00:00Z',
      onError: (_error, context) => {
        errors.push(context);
      },
    });
    await expect(service.deliver({ idempotencyKey: 'e-1', player: user, topic: 'friend-challenge', templateData: { friend: 'M' } }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'provider-rejected' });
    expect(errors).toContainEqual({ operation: 'devvit.enqueue', sendKey: 'e-1', provider: 'devvit' });
  });

  it("does not report a user's refusal or a rate limit through onError", async () => {
    const errors: unknown[] = [];
    const plugin = createFakePlugin();
    plugin.answers.push(
      { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'User not found' }] },
      { successCount: 0, failureCount: 1, errors: [{ userId: user, message: 'rate limit exceeded' }] },
    );
    const { service } = createDevvitNotificationService({
      redis: createFakeNotificationRedis(),
      notifications: plugin,
      catalog: catalogFile,
      now: () => '2026-10-19T03:00:00Z',
      onError: (_error, context) => {
        errors.push(context);
      },
    });
    const send = (key: string) =>
      service.deliver({ idempotencyKey: key, player: user, topic: 'friend-challenge', templateData: { friend: 'M' } });
    await expect(send('r-1')).resolves.toMatchObject({ status: 'unavailable', reason: 'provider-rejected' });
    await expect(send('r-2')).resolves.toMatchObject({ status: 'deferred' });
    expect(errors.filter((context) => (context as { operation: string }).operation === 'devvit.enqueue')).toEqual([]);
  });

  it('builds a session only for a Reddit user id', () => {
    expect(devvitNotificationSession(user)).toEqual({
      player: user,
      sessionId: `devvit:${user}`,
      installationId: `devvit:${user}`,
    });
    expect(() => devvitNotificationSession('guest')).toThrow(TypeError);
  });
});

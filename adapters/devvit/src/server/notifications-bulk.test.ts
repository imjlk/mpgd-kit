import { describe, expect, it } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';
import {
  createInMemoryNotificationStore,
  type NotificationRemoteDeliveryRequest,
  type NotificationStore,
} from '@mpgd/game-services/notifications';

import { createDevvitNotificationsBackendBridgeHandler } from './notifications-backend-bridge.js';
import {
  createDevvitNotificationDeliveryProvider,
  createDevvitNotificationService,
  devvitNotificationEnqueueMaxRecipients,
  devvitNotificationProviderCodes,
  runDevvitNotificationBulkPage,
  type DevvitEnqueueResponse,
  type DevvitNotificationsDeliveryClient,
} from './notifications-delivery.js';

/** Bulk sends on Devvit (RFC open question 5, BK1), against a fake notifications plugin. */

interface EnqueueCall {
  readonly title: string;
  readonly body: string;
  readonly userIds: readonly string[];
}

function fakePlugin(options: {
  readonly answers?: ((call: EnqueueCall) => DevvitEnqueueResponse | Promise<DevvitEnqueueResponse>)[];
  readonly optedIn?: Iterable<string>;
  readonly pages?: Readonly<Record<string, { readonly userIds: readonly string[]; readonly next?: string }>>;
} = {}) {
  const calls: EnqueueCall[] = [];
  const listed: { readonly limit?: number | undefined; readonly after?: string | undefined }[] = [];
  const optedIn = new Set(options.optedIn ?? []);
  const answers = [...(options.answers ?? [])];
  const plugin: DevvitNotificationsDeliveryClient = {
    async enqueue(input) {
      const call = {
        title: input.title,
        body: input.body,
        userIds: input.recipients.map((recipient) => recipient.userId),
      };
      calls.push(call);
      const answer = answers.shift();
      return answer === undefined
        ? { successCount: input.recipients.length, failureCount: 0, errors: [] }
        : answer(call);
    },
    async isOptedIn(userId) {
      return optedIn.has(userId);
    },
    async listOptedInUsers(input) {
      listed.push(input);
      return options.pages?.[input.after ?? ''] ?? { userIds: [] };
    },
  };
  return { plugin, calls, listed, optedIn };
}

function request(userId: string, body = 'A live event started.'): NotificationRemoteDeliveryRequest {
  return {
    idempotencyKey: `event:${userId}`,
    sendKey: `event:${userId}`,
    provider: 'devvit',
    player: userId,
    topic: { id: 'live-event', purpose: 'service', channels: ['remote'], route: '/?entry=event' },
    recipient: { kind: 'platform-user', id: userId },
    content: { title: 'Live event', body, route: '/?entry=event', source: 'mapping' },
    link: 't3_event',
    at: '2026-11-01T03:00:00Z',
  };
}

const answerShape = (answer: { readonly status: string } & Record<string, unknown>) =>
  [answer.status, answer['reason'] ?? answer['providerCode'], answer['unattributed']];

describe('the Devvit provider bulk path', () => {
  it('declares 1,000 recipients a call with per-recipient answers', () => {
    const provider = createDevvitNotificationDeliveryProvider({ notifications: fakePlugin().plugin });
    expect(provider.bulk).toEqual({ maxRecipients: 1_000, perRecipientOutcomes: true });
    expect(devvitNotificationEnqueueMaxRecipients).toBe(1_000);
  });

  it('enqueues once per text, each user once a call, and refuses what send would refuse', async () => {
    const { plugin, calls } = fakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    const answers = await provider.sendBatch?.([
      request('t2_a'),
      request('t2_b', 'Another text.'),
      request('t2_c'),
      { ...request('t2_d'), link: 't5_sub' },
      request('t2_e', '{{name}} joined.'),
    ]);
    expect(answers?.map((answer) => answerShape(answer))).toEqual([
      ['accepted', undefined, undefined],
      ['accepted', undefined, undefined],
      ['accepted', undefined, undefined],
      ['rejected', 'configuration', undefined],
      ['rejected', 'configuration', undefined],
    ]);
    expect(calls).toEqual([
      { title: 'Live event', body: 'A live event started.', userIds: ['t2_a', 't2_c'] },
      { title: 'Live event', body: 'Another text.', userIds: ['t2_b'] },
    ]);
  });

  it('splits a text past 1,000 recipients into another call', async () => {
    const { plugin, calls } = fakePlugin();
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    await provider.sendBatch?.(Array.from({ length: 1_001 }, (_, index) => request(`t2_u${index}`)));
    expect(calls.map((call) => call.userIds.length)).toEqual([1_000, 1]);
  });

  it('maps named errors per user and proves the rest only by the counts', async () => {
    const reports: string[] = [];
    const { plugin } = fakePlugin({
      answers: [
        // b is rate limited by name, c refused by name; a and d succeeded (2 of the 2 unnamed).
        () => ({
          successCount: 2,
          failureCount: 2,
          errors: [
            { userId: 't2_b', message: 'daily notification limit exceeded for user' },
            { userId: 't2_c', message: 'user t2_c has opted out' },
          ],
        }),
      ],
    });
    const provider = createDevvitNotificationDeliveryProvider({
      notifications: plugin,
      onEnqueueError: (report) => reports.push(`${report.sendKey} ${report.answer}`),
    });
    const answers = await provider.sendBatch?.([request('t2_a'), request('t2_b'), request('t2_c'), request('t2_d')]);
    expect(answers?.map((answer) => answerShape(answer))).toEqual([
      ['accepted', undefined, undefined],
      ['rate-limited', undefined, undefined],
      ['rejected', 'recipient', undefined],
      ['accepted', undefined, undefined],
    ]);
    expect(reports).toEqual(['event:t2_b rate-limited', 'event:t2_c rejected']);
  });

  it('answers a partial count over unnamed users as unattributed, never accepted', async () => {
    const { plugin } = fakePlugin({
      answers: [() => ({ successCount: 2, failureCount: 1, errors: [{ userId: undefined, message: 'internal' }] })],
    });
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    const answers = await provider.sendBatch?.([request('t2_a'), request('t2_b'), request('t2_c')]);
    expect(answers?.map((answer) => answerShape(answer))).toEqual(
      Array.from({ length: 3 }, () => ['ambiguous', devvitNotificationProviderCodes.enqueuePartial, true]),
    );
  });

  it('applies agreeing unnamed errors when nothing was queued, and a throw to every recipient', async () => {
    const { plugin } = fakePlugin({
      answers: [
        () => ({ successCount: 0, failureCount: 2, errors: [{ userId: undefined, message: 'app daily limit reached' }] }),
        () => {
          throw new Error('Enqueue timed out');
        },
        () => ({ successCount: 0, failureCount: 0, errors: [] }),
      ],
    });
    const provider = createDevvitNotificationDeliveryProvider({ notifications: plugin });
    const limited = await provider.sendBatch?.([request('t2_a'), request('t2_b')]);
    expect(limited).toEqual([
      { status: 'rate-limited', retryAfterSeconds: 3600 },
      { status: 'rate-limited', retryAfterSeconds: 3600 },
    ]);
    const thrown = await provider.sendBatch?.([request('t2_a'), request('t2_b')]);
    expect(thrown?.map((answer) => answerShape(answer))).toEqual([
      ['ambiguous', devvitNotificationProviderCodes.enqueueFailed, undefined],
      ['ambiguous', devvitNotificationProviderCodes.enqueueFailed, undefined],
    ]);
    const silent = await provider.sendBatch?.([request('t2_a'), request('t2_b')]);
    expect(silent?.map((answer) => answerShape(answer))).toEqual([
      ['ambiguous', devvitNotificationProviderCodes.enqueueUnanswered, undefined],
      ['ambiguous', devvitNotificationProviderCodes.enqueueUnanswered, undefined],
    ]);
  });
});

const catalogFile = {
  version: '2026-10-19',
  defaultLocale: 'en',
  topics: [
    {
      id: 'live-event',
      purpose: 'service',
      channels: ['remote'],
      route: '/?entry=event',
      targets: { reddit: { title: 'Live event', body: 'A live event started.', link: 't3_event' } },
    },
  ],
};

describe('Devvit bulk sends through the service', () => {
  const setup = (users: readonly string[]) => {
    const now = { value: '2026-11-01T03:00:00Z' };
    const inner = createInMemoryNotificationStore();
    // Sends the app made to other users today, counted where the pace reads the app's rate.
    const app = { sent: 0, until: '' };
    const store: NotificationStore = {
      ...inner,
      async countHistory(input) {
        const own = await inner.countHistory(input);
        return own + (input.provider === 'devvit' && now.value <= app.until ? app.sent : 0);
      },
    };
    const fake = fakePlugin({ optedIn: users });
    const { service } = createDevvitNotificationService({
      store,
      notifications: fake.plugin,
      catalog: catalogFile,
      now: () => now.value,
    });
    return { service, store, now, app, ...fake };
  };
  const bulk = (users: readonly string[]) => ({
    idempotencyKey: 'event-1',
    provider: 'devvit',
    topic: 'live-event',
    recipients: users.map((player) => ({ player })),
  });

  it('keeps to 2 per user per day and 25,000 per app per day, and reports the excess', async () => {
    const users = ['t2_a', 't2_b', 't2_c', 't2_d', 't2_e'];
    const { service, store, now, app, calls } = setup(users);
    // t2_a has had its two today; the app has sent 24,995 to other users, 24,997 in all.
    for (const sendKey of ['earlier-1', 'earlier-2']) {
      await store.addHistory({ sendKey, provider: 'devvit', player: 't2_a', topic: 'live-event', at: now.value });
    }
    app.sent = 24_995;
    app.until = '2026-11-02T03:00:00Z';
    const result = await service.deliverBulk(bulk(users));
    expect(result.recipients.map((recipient) =>
      recipient.status === 'answered'
        ? [recipient.player, recipient.outcome.status, 'reason' in recipient.outcome ? recipient.outcome.reason : undefined]
        : [recipient.player, recipient.status, recipient.status === 'not-attempted' ? recipient.reason : undefined])).toEqual([
      ['t2_a', 'suppressed', 'provider-limit'],
      ['t2_b', 'delivered', undefined],
      ['t2_c', 'delivered', undefined],
      ['t2_d', 'not-attempted', 'provider-rate'],
      ['t2_e', 'not-attempted', 'provider-rate'],
    ]);
    // t2_a took one of the three budget places before the gate refused it.
    expect(calls).toEqual([{ title: 'Live event', body: 'A live event started.', userIds: ['t2_b', 't2_c'] }]);
    // A day later the same call sends the rest; nobody is sent twice.
    now.value = '2026-11-02T03:00:01Z';
    const later = await service.deliverBulk(bulk(users));
    expect(later.summary).toMatchObject({ delivered: 3, alreadyProcessed: 2, notAttempted: 0 });
    expect(calls.at(-1)?.userIds).toEqual(['t2_a', 't2_d', 't2_e']);
  });

  it('pages the opted-in users, and the gate still refuses whom the kit records say no', async () => {
    const { service, store, now, plugin, calls, listed, optedIn } = setup(['t2_a', 't2_b', 't2_c']);
    const pages = {
      '': { userIds: ['t2_a', 't2_b', 't2_c', 'not-a-user'], next: 'cursor-2' },
      'cursor-2': { userIds: [] },
    };
    const paged = { ...plugin, listOptedInUsers: async (input: { limit?: number; after?: string | undefined }) => {
      listed.push(input);
      return pages[(input.after ?? '') as keyof typeof pages];
    } };
    // t2_b turned the topic off in the game; t2_c opted out on Reddit after the page was read.
    await store.appendConsent({
      player: 't2_b',
      record: { kind: 'topic-preference', topic: 'live-event', state: 'withdrawn', source: 'player' },
      at: now.value,
    });
    optedIn.delete('t2_c');
    const first = await runDevvitNotificationBulkPage({
      service,
      notifications: paged,
      idempotencyKey: 'campaign-1',
      topic: 'live-event',
      limit: 500,
    });
    expect(first.next).toBe('cursor-2');
    expect(first.complete).toBe(true);
    expect(first.result?.summary).toMatchObject({ delivered: 1, suppressed: 2 });
    expect(calls).toEqual([{ title: 'Live event', body: 'A live event started.', userIds: ['t2_a'] }]);
    const last = await runDevvitNotificationBulkPage({
      service,
      notifications: paged,
      idempotencyKey: 'campaign-1',
      topic: 'live-event',
      after: 'cursor-2',
    });
    expect(last).toEqual({ complete: true });
    expect(listed).toEqual([{ limit: 500 }, { limit: 1_000, after: 'cursor-2' }]);
    await expect(runDevvitNotificationBulkPage({
      service,
      notifications: paged,
      idempotencyKey: 'campaign-1',
      topic: 'live-event',
      limit: 1_001,
    })).rejects.toThrow(RangeError);
  });

  it('serves no bulk send to a player session over the backend bridge', async () => {
    const { service, calls } = setup(['t2_a']);
    const handler = createDevvitNotificationsBackendBridgeHandler({
      service,
      context: () => ({ userId: 't2_a' }),
      onError: () => undefined,
    });
    const answer = await handler.request({
      id: 'r',
      method: 'notifications.backend.deliverBulk' as BridgeRequest['method'],
      payload: { expectedPlayer: 't2_a', ...bulk(['t2_a']) },
      meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-11-01T03:00:00Z' },
    });
    expect(answer).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD', retryable: false } });
    // Nor is it in the service the bridge is typed against: the backend bridge never names deliverBulk.
    expect(calls).toEqual([]);
  });
});

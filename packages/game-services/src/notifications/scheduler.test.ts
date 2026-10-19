import assert from 'node:assert/strict';

import {
  notificationNoticeVariants,
  referenceNotificationProviders,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationNoticeCopy,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import type {
  NotificationRemoteDeliveryAnswer,
  NotificationRemoteDeliveryProvider,
  NotificationRemoteDeliveryRequest,
} from './delivery-provider.js';
import {
  createNotificationProviderRegistry,
  type NotificationProviderRegistration,
} from './registry.js';
import {
  createNotificationService,
  maxPendingNotificationReminders,
  type NotificationDispatchJob,
  type NotificationService,
  type NotificationSession,
} from './service.js';
import {
  createInMemoryNotificationStore,
  type InMemoryNotificationStore,
  type NotificationStore,
} from './store.js';

/**
 * S2's scheduler over the in-memory store: server reminders (set-time
 * checks, replace and cancel, firing through the gate), pacing by the
 * registry's `rate`, due rows through the queue, consent notice pushes with
 * their backoff, and consent compaction.
 */

const fcmEntry: NotificationDeliveryProviderEntry = referenceNotificationProviders.fcm;
const platformEntry: NotificationDeliveryProviderEntry = {
  provider: 'platform',
  purposes: ['service', 'requested'],
  addressing: 'platform-user',
  content: 'free-form',
  permission: { scope: 'app', serverReadable: false, allowance: 'persistent' },
  expiry: false,
  actions: false,
  link: false,
  mappingFields: [],
};
const templateEntry: NotificationDeliveryProviderEntry = {
  ...platformEntry,
  provider: 'template',
  content: 'host-template',
  permission: { scope: 'topic', serverReadable: false, allowance: 'persistent' },
  mappingFields: ['templateSetCode', 'agreement'],
};

function fakeProvider(id: string, answers: NotificationRemoteDeliveryAnswer[] = []) {
  const calls: NotificationRemoteDeliveryRequest[] = [];
  const provider: NotificationRemoteDeliveryProvider & { readonly calls: typeof calls } = {
    id,
    calls,
    async send(request) {
      calls.push(request);
      return answers.shift() ?? { status: 'accepted' };
    },
  };
  return provider;
}

function clock(start: string) {
  let at = Date.parse(start);
  return {
    now: () => new Date(at).toISOString(),
    advance(seconds: number) {
      at += seconds * 1000;
    },
    set(instant: string) {
      at = Date.parse(instant);
    },
  };
}

const session = (player: string, installationId = `install-${player}`): NotificationSession => ({
  player,
  sessionId: `s-${player}-${installationId}`,
  installationId,
});

async function expectCode(promise: Promise<unknown>, code: string, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { readonly code?: unknown }).code, code, message);
    return true;
  });
}

const copy = { ko: { title: 'T', body: 'B' } };
const energy: NotificationTopicDeclaration = {
  id: 'energy-full',
  purpose: 'requested',
  channels: ['remote'],
  route: '/?entry=continue',
  copy,
};
const challenge: NotificationTopicDeclaration = {
  id: 'friend-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  copy,
};
const weekend: NotificationTopicDeclaration = {
  id: 'weekend-event',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events',
  optOutRoute: '/settings',
  copy,
};
const localOnly: NotificationTopicDeclaration = {
  ...energy,
  id: 'local-only',
  channels: ['local'],
};
const noticeTopic: NotificationTopicDeclaration = {
  id: 'consent-notice',
  purpose: 'service',
  channels: ['remote'],
  route: '/settings',
};
const noticeCopy: NotificationNoticeCopy = {
  ko: Object.fromEntries(notificationNoticeVariants.map((variant) => [
    variant,
    { title: `[Game] ${variant}`, body: `{{consentDate}} ${variant}` },
  ])) as unknown as NotificationNoticeCopy[string],
};
const kr: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-000-0000' },
};

interface Harness {
  readonly service: NotificationService;
  readonly store: InMemoryNotificationStore;
  readonly time: ReturnType<typeof clock>;
  readonly fcm: ReturnType<typeof fakeProvider>;
  readonly jobs: NotificationDispatchJob[];
  readonly errors: string[];
}

function harness(options: {
  readonly start?: string;
  readonly topics?: readonly NotificationTopicDeclaration[];
  readonly deployment?: NotificationDeployment;
  readonly notices?: boolean;
  readonly answers?: NotificationRemoteDeliveryAnswer[];
  readonly fcmEntry?: NotificationDeliveryProviderEntry;
  readonly extra?: readonly NotificationProviderRegistration[];
  readonly queue?: boolean;
  readonly failEnqueue?: () => boolean;
  readonly store?: (store: InMemoryNotificationStore) => NotificationStore;
  /** Providers whose platform identity of the player is not known yet. */
  readonly unresolved?: readonly string[];
} = {}): Harness {
  const time = clock(options.start ?? '2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm', options.answers ?? []);
  const store = createInMemoryNotificationStore();
  const jobs: NotificationDispatchJob[] = [];
  const errors: string[] = [];
  const topics = options.topics ?? [energy, challenge];
  const service = createNotificationService({
    store: options.store?.(store) ?? store,
    registry: createNotificationProviderRegistry([
      { entry: options.fcmEntry ?? fcmEntry, delivery: fcm, targets: ['vector'] },
      ...(options.extra ?? []),
    ]),
    catalog: {
      defaultLocale: 'ko',
      ...(options.notices === true ? { notices: { topic: noticeTopic.id, copy: noticeCopy } } : {}),
      topicsFor: () => topics,
    },
    ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
    resolvePlatformRecipient: ({ provider, player }) =>
      options.unresolved?.includes(provider) === true ? undefined : `user-${player}`,
    ...(options.queue === true
      ? {
          queue: {
            async enqueue(batch) {
              if (options.failEnqueue?.() === true) {
                throw new Error('queue down');
              }
              jobs.push(...batch);
            },
          },
        }
      : {}),
    now: time.now,
    random: () => 0,
    onError: (_error, context) => errors.push(context.operation),
  });
  return { service, store, time, fcm, jobs, errors };
}

async function register(h: Harness, player: string, permission: 'granted' | 'blocked' = 'granted'): Promise<void> {
  await h.service.registerEndpoint(session(player), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: `tok-${player}`, permission },
    },
  });
}

async function optIn(h: Harness, player: string, topic = 'energy-full'): Promise<void> {
  await h.service.recordConsent(session(player), {
    kind: 'topic-preference',
    topic,
    state: 'granted',
    source: 'player',
  });
}

const pending = (h: Harness) =>
  h.store.inspect().schedule.filter(
    (entry) => entry.item.kind === 'reminder' && entry.item.firedAt === undefined,
  );

// Reminder input and topic checks throw before anything is stored.
{
  const h = harness({
    topics: [energy, challenge, localOnly, weekend, noticeTopic],
    notices: true,
    deployment: kr,
  });
  const set = (input: unknown) => h.service.setReminder(session('p-1'), input);
  const base = { key: 'energy', topic: 'energy-full', fireAt: '2026-10-19T06:00:00Z' };
  for (const input of [
    null,
    { ...base, extra: 1 },
    { ...base, key: '' },
    { ...base, key: 'a\u0000b' },
    { ...base, topic: '' },
    { ...base, fireAt: '2026-10-19T06:00:00' },
    { ...base, fireAt: '2026-04-31T06:00:00Z' },
    { ...base, templateData: { nested: {} } },
    { ...base, link: '' },
    { ...base, topic: 'consent-notice' },
    { ...base, topic: 'local-only' },
    { ...base, topic: 'unknown' },
  ]) {
    await expectCode(set(input), 'NOTIFICATIONS_INVALID_INPUT', JSON.stringify(input));
  }
  assert.deepEqual(h.store.inspect().schedule, []);
  // Advertising needs the deployment's rules.
  const none = harness({ topics: [weekend] });
  await expectCode(
    none.service.setReminder(session('p-1'), { ...base, topic: 'weekend-event' }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  // A host-template provider keeps template context on the server.
  const template = harness({
    topics: [{ ...energy, mapping: { templateSetCode: 'x', agreement: 'required' } }],
    fcmEntry: { ...templateEntry, provider: 'fcm' },
  });
  await expectCode(
    template.service.setReminder(session('p-1'), { ...base, templateData: { count: 1 } }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  // Also while the player is reached only through a free-form provider: a
  // host-template provider that declares the topic may reach them by the time it fires.
  const mixed = harness({
    topics: [{ ...energy, mapping: { templateSetCode: 'x', agreement: 'none' } }],
    extra: [{ entry: templateEntry, delivery: fakeProvider('template'), targets: ['template'] }],
    unresolved: ['template'],
  });
  await register(mixed, 'p-1');
  await optIn(mixed, 'p-1');
  await expectCode(
    mixed.service.setReminder(session('p-1'), { ...base, templateData: { count: 1 } }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  assert.equal((await mixed.service.setReminder(session('p-1'), base)).status, 'scheduled');
  await expectCode(
    h.service.cancelReminder(session('p-1'), { key: 'k', extra: true }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  await expectCode(
    h.service.cancelReminder(session('p-1'), { key: '' }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
}

// Gate steps 3 to 5 at set time: a refusal stores nothing; the furthest step answers.
{
  const h = harness({ topics: [energy, challenge, weekend], deployment: kr });
  const set = (topic: string, player = 'p-1') =>
    h.service.setReminder(session(player), { key: topic, topic, fireAt: '2026-10-19T06:00:00Z' });
  // No endpoint: the device permission is missing.
  assert.deepEqual(await set('friend-challenge'), { status: 'permission-required' });
  await register(h, 'p-1', 'blocked');
  assert.deepEqual(await set('friend-challenge'), { status: 'permission-required' });
  await register(h, 'p-1');
  assert.deepEqual(await set('energy-full'), { status: 'request-missing' });
  await h.service.recordConsent(session('p-1'), {
    kind: 'topic-preference',
    topic: 'energy-full',
    state: 'withdrawn',
    source: 'player',
  });
  assert.deepEqual(await set('energy-full'), { status: 'preference-off' });
  assert.deepEqual(await set('weekend-event'), { status: 'advertising-consent-missing' });
  assert.deepEqual(pending(h), []);
  assert.deepEqual(await set('friend-challenge'), { status: 'scheduled' });

  // Two providers: the one that gets further through the gate answers.
  const two = harness({
    topics: [energy],
    extra: [{ entry: platformEntry, delivery: fakeProvider('platform'), targets: ['platform'] }],
  });
  // The platform user resolves (permission is a record), the device has no endpoint.
  await two.service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  assert.deepEqual(
    await two.service.setReminder(session('p-1'), { key: 'e', topic: 'energy-full', fireAt: '2026-10-19T06:00:00Z' }),
    { status: 'request-missing' },
  );
}

// Set, replace, cancel by key; the scheduler fires the reminder through the gate and keeps it fired.
{
  const h = harness();
  await register(h, 'p-1');
  await optIn(h, 'p-1');
  const set = (fireAt: string) => h.service.setReminder(session('p-1'), {
    key: 'energy',
    topic: 'energy-full',
    fireAt,
  });
  assert.deepEqual(await set('2026-10-19T05:00:00Z'), { status: 'scheduled' });
  assert.deepEqual(await set('2026-10-19T15:00:00+09:00'), { status: 'replaced' });
  assert.deepEqual(
    pending(h).map((entry) => entry.dueAt),
    ['2026-10-19T06:00:00Z'],
  );
  assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'energy' }), {
    cancelled: true,
  });
  assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'energy' }), {
    cancelled: false,
  });
  // Another player's key is its own.
  await register(h, 'p-2');
  await optIn(h, 'p-2');
  assert.deepEqual(await set('2026-10-19T06:00:00Z'), { status: 'scheduled' });
  assert.deepEqual(
    await h.service.setReminder(session('p-2'), {
      key: 'energy',
      topic: 'energy-full',
      fireAt: '2026-10-19T06:00:00Z',
      templateData: { count: 3 },
    }),
    { status: 'scheduled' },
  );
  h.time.set('2026-10-19T05:59:59Z');
  assert.deepEqual((await h.service.runScheduler()).results, []);
  h.time.set('2026-10-19T06:00:00Z');
  const run = await h.service.runScheduler();
  assert.equal(run.failed, 0);
  assert.deepEqual(run.results.map((result) => [result.sendKey, result.outcome.status]).sort(), [
    ['reminder:p-1:energy:2026-10-19T06:00:00Z', 'delivered'],
    ['reminder:p-2:energy:2026-10-19T06:00:00Z', 'delivered'],
  ]);
  assert.deepEqual(h.fcm.calls.map((call) => [call.idempotencyKey, call.templateData]).sort(), [
    ['reminder:p-1:energy:2026-10-19T06:00:00Z:install-p-1', undefined],
    ['reminder:p-2:energy:2026-10-19T06:00:00Z:install-p-2', { count: 3 }],
  ]);
  assert.deepEqual(pending(h), []);
  // Fired reminders are kept until their key's retention ends, then forgotten.
  assert.equal(h.store.inspect().schedule.length, 2);
  assert.deepEqual((await h.service.runScheduler()).results, []);
  assert.equal(h.fcm.calls.length, 2);
  h.time.advance(30 * 86_400);
  await h.service.runScheduler();
  assert.deepEqual(h.store.inspect().schedule, []);
}

// A fired reminder's send that still waits is stopped by a replace or a cancel.
{
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const h = harness({ topics: [quiet] });
  await register(h, 'p-1');
  // 22:30 in Seoul: the send is deferred to 08:00.
  const fireAt = '2026-10-19T13:30:00Z';
  assert.deepEqual(
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt }),
    { status: 'scheduled' },
  );
  h.time.set(fireAt);
  const run = await h.service.runScheduler();
  assert.deepEqual(
    run.results.map((result) => result.outcome),
    [{ status: 'deferred', reason: 'quiet-hours', until: '2026-10-19T23:00:00Z' }],
  );
  assert.equal(h.fcm.calls.length, 0);
  assert.deepEqual(
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt: '2026-10-20T13:30:00Z' }),
    { status: 'replaced' },
    'a replace stops the waiting send',
  );
  assert.deepEqual(
    h.store.inspect().sends.map((send) => send.key),
    [],
    'the deferred send is gone',
  );
  h.time.set('2026-10-19T23:00:00Z');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 0, 'nothing is sent at 08:00');
  // The new one fires, waits, and a cancel stops it.
  h.time.set('2026-10-20T13:30:00Z');
  await h.service.runScheduler();
  assert.equal(h.store.inspect().sends.length, 1);
  assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'k' }), {
    cancelled: true,
  });
  assert.deepEqual(h.store.inspect().sends, []);
  assert.deepEqual(h.store.inspect().schedule, []);
  h.time.set('2026-10-20T23:00:00Z');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 0);
}

// A reminder the gate refuses when it comes due is spent; a delivered one is not recalled by a cancel.
{
  const h = harness();
  await register(h, 'p-1');
  await optIn(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'energy-full',
    fireAt: '2026-10-19T04:00:00Z',
  });
  await h.service.recordConsent(session('p-1'), {
    kind: 'topic-preference',
    topic: 'energy-full',
    state: 'withdrawn',
    source: 'player',
  });
  h.time.set('2026-10-19T04:00:00Z');
  assert.deepEqual((await h.service.runScheduler()).results, [
    {
      sendKey: 'reminder:p-1:k:2026-10-19T04:00:00Z',
      outcome: { status: 'suppressed', reason: 'preference-off' },
    },
  ]);
  assert.deepEqual(h.store.inspect().schedule, []);
  assert.deepEqual(h.store.inspect().sends, []);
  await optIn(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'energy-full',
    fireAt: '2026-10-19T04:00:00Z',
  });
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1);
  assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'k' }), {
    cancelled: false,
  });
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'delivered');
}

// A cancel that lands while the scheduler makes the send: nothing is stored or sent.
{
  let cancelOnFire: (() => Promise<unknown>) | undefined;
  const h = harness({
    store: (inner) => ({
      ...inner,
      async updateScheduleEntry(input) {
        const done = await inner.updateScheduleEntry(input);
        if (done && input.entry?.item.kind === 'reminder' && input.entry.item.firedAt !== undefined && cancelOnFire) {
          const cancel = cancelOnFire;
          cancelOnFire = undefined;
          await cancel();
        }
        return done;
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  cancelOnFire = async () => {
    assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'k' }), { cancelled: true });
  };
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 0);
  assert.deepEqual(h.store.inspect().sends, []);
  assert.deepEqual(h.store.inspect().schedule, []);
}

// A run that stopped after creating the send's key and before any row starts over.
{
  const h = harness();
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  const key = 'reminder:p-1:k:2026-10-19T03:00:00Z';
  await h.store.createSend({
    key,
    fingerprint: 'stale',
    request: { idempotencyKey: key, player: 'p-1', topic: 'friend-challenge' },
    origin: { kind: 'reminder', key: 'k' },
    scheduled: true,
    rows: [],
    claim: { token: 'gone', leaseUntil: '2026-10-19T02:59:00Z' },
    changedAt: '2026-10-19T02:54:00Z',
  });
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1);
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'delivered');
}

// Pacing: due rows leave at no more than the provider's rate, oldest first, across players.
{
  const h = harness({ fcmEntry: { ...fcmEntry, rate: { count: 2, windowSeconds: 60 } } });
  for (const player of ['p-1', 'p-2', 'p-3']) {
    await register(h, player);
  }
  for (const [player, fireAt] of [
    ['p-3', '2026-10-19T03:00:02Z'],
    ['p-1', '2026-10-19T03:00:03Z'],
    ['p-2', '2026-10-19T03:00:01Z'],
  ] as const) {
    await h.service.setReminder(session(player), { key: 'k', topic: 'friend-challenge', fireAt });
  }
  h.time.advance(3);
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.player),
    ['p-2', 'p-3'],
  );
  h.time.advance(59);
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 2, 'the window still holds two');
  h.time.advance(1);
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.player),
    ['p-2', 'p-3', 'p-1'],
  );
}

// Pacing counts only deliveries up to the run's time: ones dated later (the clock went back) do not hold the rate.
{
  const h = harness({ fcmEntry: { ...fcmEntry, rate: { count: 1, windowSeconds: 60 } } });
  await register(h, 'p-1');
  await h.store.addHistory({
    sendKey: 'before-the-clock-went-back',
    provider: 'fcm',
    player: 'p-9',
    topic: 'friend-challenge',
    at: '2026-10-19T03:00:30Z',
  });
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:01Z',
  });
  h.time.advance(2);
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.player),
    ['p-1'],
  );
}

// With a queue, due rows are taken for one lease and enqueued; jobs deliver them.
{
  let failNext = false;
  const h = harness({
    queue: true,
    answers: [{ status: 'ambiguous' }],
    failEnqueue: () => {
      const fail = failNext;
      failNext = false;
      return fail;
    },
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  const run = await h.service.runScheduler();
  assert.deepEqual(
    run.results.map((result) => result.outcome),
    [{ status: 'in-flight' }],
  );
  assert.equal(h.fcm.calls.length, 0, 'nothing is sent inline');
  assert.equal(h.jobs.length, 1);
  // Taken rows are not taken again while their jobs wait.
  await h.service.runScheduler();
  assert.equal(h.jobs.length, 1);
  await h.service.dispatch(h.jobs[0] as NotificationDispatchJob);
  assert.equal(h.fcm.calls.length, 1, 'the job sends; the answer is ambiguous');
  // The ambiguous row comes due after the claim lease and is taken again for a job.
  h.time.advance(300);
  failNext = true;
  const lost = await h.service.runScheduler();
  assert.equal(lost.failed, 1, 'an enqueue that fails is counted');
  assert.deepEqual(h.errors, ['queue.enqueue']);
  assert.equal(h.jobs.length, 1);
  // The taken row is due again once its lease ends.
  h.time.advance(299);
  await h.service.runScheduler();
  assert.equal(h.jobs.length, 1);
  h.time.advance(1);
  await h.service.runScheduler();
  assert.equal(h.jobs.length, 2);
  const row = h.store.inspect().sends[0]?.rows[0];
  assert.equal(
    row?.state.status === 'in-flight' && row.state.attempted && row.state.claim === undefined,
    true,
  );
  await h.service.dispatch(h.jobs[1] as NotificationDispatchJob);
  assert.equal(h.fcm.calls.length, 2);
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'delivered');
  // A redelivered job does nothing.
  await h.service.dispatch(h.jobs[1] as NotificationDispatchJob);
  assert.equal(h.fcm.calls.length, 2);
}

// Consent notices: pushed seven days before they are due, recorded as given, then the next one is scheduled.
{
  const h = harness({ topics: [weekend, noticeTopic], deployment: kr, notices: true });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  const check = () => h.store.inspect().schedule.find((entry) => entry.id === 'notices');
  assert.equal(check()?.dueAt, '2026-10-19T03:00:00Z', 'a consent makes the check due');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 0, 'not before seven days ahead of dueBy');
  // dueBy 2026-11-02: from the start of 2026-10-26 in Seoul.
  assert.equal(check()?.dueAt, '2026-10-25T15:00:00Z');
  h.time.set('2026-10-25T15:00:00Z');
  const run = await h.service.runScheduler();
  assert.deepEqual(run.results, [
    {
      sendKey: 'notice:p-1:consent-result:advertising:2026-10-19T03:00:00Z:2026-11-02',
      outcome: { status: 'delivered', alreadyProcessed: false },
    },
  ]);
  assert.deepEqual(
    h.fcm.calls.map((call) => [call.topic.id, call.content.title, call.content.body]),
    [
      [
        'consent-notice',
        '[Game] consent-result.advertising.granted',
        '2026-10-19 consent-result.advertising.granted',
      ],
    ],
  );
  assert.deepEqual(
    h.store.inspect().noticesGiven.map((given) => [given.kind, given.channel]),
    [['consent-result', 'push']],
  );
  assert.deepEqual(await h.service.listNotices(session('p-1')), []);
  // An hour later the check sees the push given and waits for the re-confirmation: dueBy 2028-10-18.
  h.time.advance(3600);
  await h.service.runScheduler();
  assert.equal(check()?.dueAt, '2028-10-10T15:00:00Z');
  assert.equal(h.fcm.calls.length, 1);
  h.time.set('2028-10-10T15:00:00Z');
  // The device registered again since (an endpoint goes stale after 60 days).
  await register(h, 'p-1');
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.idempotencyKey),
    [
      'notice:p-1:consent-result:advertising:2026-10-19T03:00:00Z:2026-11-02:install-p-1',
      'notice:p-1:reconfirmation:advertising:2026-10-19T03:00:00Z:2028-10-18:install-p-1',
    ],
  );
  // A withdrawal ends the series once its own result is pushed.
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'withdrawn',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.advance(8 * 86_400);
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.at(-1)?.content.title, '[Game] consent-result.advertising.withdrawn');
  h.time.advance(3600);
  await h.service.runScheduler();
  assert.equal(check(), undefined, 'nothing is owed any more');
}

// A refused notice push backs off, doubling from an hour; a registration lets it through.
{
  const h = harness({ topics: [weekend, noticeTopic], deployment: kr, notices: true });
  await h.service.recordConsent(session('p-1'), {
    kind: 'night',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.set('2026-10-26T00:00:00Z');
  const check = () => h.store.inspect().schedule.find((entry) => entry.id === 'notices');
  const first = await h.service.runScheduler();
  assert.deepEqual(
    first.results.map((result) => result.outcome),
    [{ status: 'unavailable', reason: 'no-endpoint' }],
  );
  assert.deepEqual(
    [check()?.dueAt, check()?.item],
    ['2026-10-26T01:00:00Z', { kind: 'notices', attempts: 1 }],
  );
  h.time.set('2026-10-26T01:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(
    [check()?.dueAt, check()?.item],
    ['2026-10-26T03:00:00Z', { kind: 'notices', attempts: 2 }],
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    h.time.set(check()?.dueAt ?? '');
    await h.service.runScheduler();
  }
  const waited = Date.parse(check()?.dueAt ?? '') - Date.parse(h.time.now());
  assert.equal(waited, 86_400_000, 'the backoff stops at a day');
  await register(h, 'p-1');
  assert.equal(
    Date.parse(check()?.dueAt ?? ''),
    Date.parse(h.time.now()),
    'a registration ends the backoff',
  );
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.content.title),
    ['[Game] consent-result.night.granted'],
  );
  assert.equal(h.fcm.calls[0]?.content.body, '2026-10-19 consent-result.night.granted');
}

// Notices go only through providers that carry them, and only under the Korean rules.
{
  const template = fakeProvider('template');
  const h = harness({
    topics: [weekend, { ...noticeTopic, mapping: { templateSetCode: 'n', agreement: 'none' } }],
    deployment: kr,
    notices: true,
    extra: [{ entry: templateEntry, delivery: template, targets: ['template'] }],
  });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.set('2026-10-26T00:00:00Z');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1);
  assert.equal(template.calls.length, 0, 'a host template cannot state the record');

  const onlyTemplate = harness({
    topics: [weekend, noticeTopic],
    deployment: kr,
    notices: true,
    fcmEntry: { ...templateEntry, provider: 'fcm' },
  });
  await onlyTemplate.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.deepEqual(
    onlyTemplate.store.inspect().schedule,
    [],
    'no check where no provider carries notices',
  );

  const none = harness({
    topics: [weekend, noticeTopic],
    deployment: { advertisingRules: 'none' },
    notices: true,
  });
  await none.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.deepEqual(none.store.inspect().schedule, [], 'no check without the Korean rules');
}

// Compaction: records no rule reads are deleted a day after they were written.
{
  const h = harness({ topics: [energy, weekend, noticeTopic], deployment: kr, notices: true });
  const prefer = (state: 'granted' | 'withdrawn') =>
    h.service.recordConsent(session('p-1'), {
      kind: 'topic-preference',
      topic: 'energy-full',
      state,
      source: 'player',
    });
  const advertise = (state: 'granted' | 'withdrawn') =>
    h.service.recordConsent(session('p-1'), {
      kind: 'advertising',
      state,
      source: 'player',
      textVersion: 'v1',
    });
  await prefer('granted');
  await prefer('withdrawn');
  await advertise('granted');
  await advertise('withdrawn');
  await advertise('withdrawn');
  const kinds = () => h.store.inspect().consent.map((record) => `${record.kind}:${record.state}`);
  h.time.advance(86_400 - 1);
  await prefer('granted');
  assert.equal(kinds().length, 6, 'nothing is a day old yet');
  // Two seconds later the first five records are over a day old (each is dated 1 ms after the one before).
  h.time.advance(2);
  await prefer('withdrawn');
  // The two earlier preferences go; every advertising record still owes its result notice.
  assert.deepEqual(kinds(), [
    'advertising:granted',
    'advertising:withdrawn',
    'advertising:withdrawn',
    'topic-preference:granted',
    'topic-preference:withdrawn',
  ]);
  // The game shows the first two results; the refusal's notice is still owed, so the record before it stays.
  for (const notice of (await h.service.listNotices(session('p-1'))).slice(0, 2)) {
    await h.service.recordNoticeShown(session('p-1'), notice);
  }
  await prefer('granted');
  assert.deepEqual(kinds(), [
    'advertising:withdrawn',
    'advertising:withdrawn',
    'topic-preference:granted',
    'topic-preference:withdrawn',
    'topic-preference:granted',
  ]);
  assert.deepEqual(
    (await h.service.listNotices(session('p-1'))).map((notice) => notice.variant),
    ['consent-result.advertising.refused'],
    'the refusal still reads as one',
  );
  assert.equal(
    h.store.inspect().noticesGiven.length,
    1,
    'the notice about the pruned record goes with it',
  );
}

// A send another run holds without rows yet leaves the reminder pending; the key frees after the lease.
{
  const h = harness();
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  const key = 'reminder:p-1:k:2026-10-19T03:00:00Z';
  await h.store.createSend({
    key,
    fingerprint: 'other-run',
    request: { idempotencyKey: key, player: 'p-1', topic: 'friend-challenge' },
    origin: { kind: 'reminder', key: 'k' },
    scheduled: true,
    rows: [],
    claim: { token: 'live', leaseUntil: '2026-10-19T03:05:00Z' },
    changedAt: '2026-10-19T03:00:00Z',
  });
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 0);
  assert.equal(pending(h).length, 1, 'the reminder is not marked fired');
  h.time.set('2026-10-19T03:05:00Z');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1, 'the next run after the lease sends it');
  assert.deepEqual(pending(h), []);
}

// A run that stops after storing the rows and before marking the reminder: the next run finds the rows.
{
  let failMark = true;
  const h = harness({
    store: (inner) => ({
      ...inner,
      async updateScheduleEntry(input) {
        if (failMark && input.entry?.item.kind === 'reminder' && input.entry.item.firedAt !== undefined) {
          failMark = false;
          throw new Error('D1 is unavailable.');
        }
        return inner.updateScheduleEntry(input);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  const first = await h.service.runScheduler();
  assert.equal(first.failed, 1);
  assert.deepEqual(h.errors, ['scheduler']);
  // The rows were stored, so the dispatch step of the same run sends them; the reminder stays pending.
  assert.equal(h.fcm.calls.length, 1);
  assert.equal(pending(h).length, 1);
  assert.equal(pending(h)[0]?.dueAt, '2026-10-19T03:01:00Z', 'a failed item waits a minute');
  h.time.advance(60);
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1, 'its stored send carries it: nothing is sent twice');
  assert.deepEqual(pending(h), []);
}

// A schedule that cannot be listed does not hold the due rows; a reminder fired past retention waits for its send.
{
  let failList = false;
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const h = harness({
    topics: [quiet],
    answers: [{ status: 'rate-limited', retryAfterSeconds: 60 }],
    store: (inner) => ({
      ...inner,
      async listDueScheduleEntries(input) {
        if (failList) {
          throw new Error('no such table: notification_schedule');
        }
        return inner.listDueScheduleEntries(input);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  await h.service.runScheduler();
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'deferred', 'rate-limited');
  failList = true;
  h.time.advance(60);
  const run = await h.service.runScheduler();
  assert.equal(run.failed, 1);
  assert.equal(h.fcm.calls.length, 2, 'the deferred row is still replayed');
  failList = false;
  // Retention: a fired reminder whose send still waits is kept a day more.
  await h.service.setReminder(session('p-1'), {
    key: 'q',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T13:30:00Z',
  });
  h.time.set('2026-10-19T13:30:00Z');
  await h.service.runScheduler();
  const fired = () => h.store.inspect().schedule.find((entry) => entry.id === 'reminder:q');
  assert.equal(
    'templateData' in (fired()?.item ?? {}),
    false,
    'a fired reminder keeps only what names its send',
  );
  const deferred = h.store.inspect().sends.find(
    (send) => send.key === 'reminder:p-1:q:2026-10-19T13:30:00Z',
  );
  assert.equal(deferred?.rows[0]?.state.status, 'deferred');
  // Hold the deferred row past the retention end by pushing its until out.
  await h.store.updateSend({
    key: deferred?.key ?? '',
    version: (await h.store.getSend(deferred?.key ?? ''))?.version ?? '',
    send: {
      ...(deferred as NonNullable<typeof deferred>),
      rows: [
        {
          ...(deferred?.rows[0] as NonNullable<NonNullable<typeof deferred>['rows'][number]>),
          state: { status: 'deferred', reason: 'quiet-hours', until: '2026-12-01T00:00:00Z' },
        },
      ],
      changedAt: '2026-11-18T13:30:00Z',
    },
  });
  h.time.set('2026-11-18T13:30:00Z');
  await h.service.runScheduler();
  assert.equal(fired()?.dueAt, '2026-11-19T13:30:00Z', 'kept a day more while its send waits');
}

// A job for a taken attempted row does not replay it once its replays ended a day after the first attempt.
{
  const h = harness({ queue: true, answers: [{ status: 'ambiguous' }] });
  await register(h, 'p-1');
  await h.service.deliver({ idempotencyKey: 'late', player: 'p-1', topic: 'friend-challenge' });
  await h.service.dispatch(h.jobs[0] as NotificationDispatchJob);
  assert.equal(h.fcm.calls.length, 1);
  h.time.advance(300);
  await h.service.runScheduler();
  assert.equal(h.jobs.length, 2, 'taken for a replay');
  h.time.advance(86_400);
  await h.service.dispatch(h.jobs[1] as NotificationDispatchJob);
  assert.equal(h.fcm.calls.length, 1, 'a job a day late replays nothing');
}

// Notice pushes the provider refuses when they are sent back off too; a delivered push without its record is recorded.
{
  const answers: NotificationRemoteDeliveryAnswer[] = Array.from({ length: 100 }, () => ({
    status: 'rejected',
    reason: 'recipient',
  }));
  const h = harness({ topics: [weekend, noticeTopic], deployment: kr, notices: true, answers });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.set('2026-10-26T00:00:00Z');
  for (let hour = 0; hour < 72; hour += 1) {
    await h.service.runScheduler();
    h.time.advance(3600);
    // Keep the endpoint fresh without ending the backoff: it reports the same permission.
  }
  assert.ok(
    h.fcm.calls.length >= 4 && h.fcm.calls.length <= 8,
    `pushes in 72 hours: ${h.fcm.calls.length}`,
  );
  answers.length = 0;
}
{
  let failGiven = true;
  const h = harness({
    topics: [weekend, noticeTopic],
    deployment: kr,
    notices: true,
    store: (inner) => ({
      ...inner,
      async addNoticeGiven(notice) {
        if (failGiven) {
          failGiven = false;
          throw new Error('D1 is unavailable.');
        }
        return inner.addNoticeGiven(notice);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.set('2026-10-26T00:00:00Z');
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1);
  assert.deepEqual(h.store.inspect().noticesGiven, [], 'the record write failed');
  h.time.advance(3600);
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1, 'not pushed again');
  assert.deepEqual(
    h.store.inspect().noticesGiven.map((given) => given.channel),
    ['push'],
  );
}

// A check that runs between the consent's mark and its write does not lose the new notice.
{
  let interleave: (() => Promise<unknown>) | undefined;
  const h = harness({
    topics: [weekend, noticeTopic],
    deployment: kr,
    notices: true,
    store: (inner) => ({
      ...inner,
      async appendConsent(input) {
        if (interleave !== undefined) {
          const run = interleave;
          interleave = undefined;
          await run();
        }
        return inner.appendConsent(input);
      },
    }),
  });
  await register(h, 'p-1');
  interleave = () => h.service.runScheduler();
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.equal(
    h.store.inspect().schedule.find((entry) => entry.id === 'notices')?.dueAt,
    '2026-10-19T03:00:00Z',
    'the check is due again after the write',
  );
}

// A run that read the history of an already-due check before a consent's write loses its settle:
// the write gives the check a new version, so the check stays due for the new record.
{
  let interleave: (() => Promise<unknown>) | undefined;
  const h = harness({
    topics: [weekend, noticeTopic],
    deployment: kr,
    notices: true,
    store: (inner) => ({
      ...inner,
      async listNoticesGiven(player) {
        if (interleave !== undefined) {
          const run = interleave;
          interleave = undefined;
          await run();
        }
        return inner.listNoticesGiven(player);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  const check = () => h.store.inspect().schedule.find((entry) => entry.id === 'notices');
  assert.equal(check()?.dueAt, '2026-10-19T03:00:00Z', 'the check is already due');
  // The run reads the history (the advertising record only), then the night record is written.
  interleave = async () => {
    h.time.advance(60);
    await h.service.recordConsent(session('p-1'), {
      kind: 'night',
      state: 'granted',
      source: 'player',
      textVersion: 'v1',
    });
  };
  await h.service.runScheduler();
  assert.equal(interleave, undefined, 'the write ran inside the check');
  assert.equal(
    check()?.dueAt,
    '2026-10-19T03:00:00Z',
    'the stale settle lost: the check is still due for the night record',
  );
  // On the send day both notices go out: the night record was not lost.
  h.time.set('2026-10-25T15:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(h.fcm.calls.map((call) => call.content.title).sort(), [
    '[Game] consent-result.advertising.granted',
    '[Game] consent-result.night.granted',
  ]);
}

// A second run that marks the same reminder fired between the first run's rows and its mark: the rows still serve it.
{
  let nested: (() => Promise<unknown>) | undefined;
  const h = harness({
    store: (inner) => ({
      ...inner,
      async updateSend(input) {
        const done = await inner.updateSend(input);
        if (done && input.send?.origin.kind === 'reminder' && input.send.rows.length > 0 && nested !== undefined) {
          const run = nested;
          nested = undefined;
          await run();
        }
        return done;
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  nested = () => h.service.runScheduler();
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1, 'sent once, not stopped');
  assert.deepEqual(pending(h), []);
}

// Re-setting a fired reminder for the same time keeps its waiting send: the send key is the same.
{
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const h = harness({ topics: [quiet] });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T13:30:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  h.time.set(fireAt);
  await h.service.runScheduler();
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'deferred');
  assert.deepEqual(
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt }),
    { status: 'scheduled' },
  );
  assert.equal(h.store.inspect().sends.length, 1, 'the waiting send stays');
  h.time.set('2026-10-19T23:00:00Z');
  await h.service.runScheduler();
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1, 'delivered once at the end of the quiet hours');
  assert.deepEqual(pending(h), []);
}

// Re-setting a reminder for the same time with other content replaces its waiting send.
{
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const other: NotificationTopicDeclaration = { ...quiet, id: 'match-ready' };
  const h = harness({ topics: [quiet, other] });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T13:30:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  h.time.set(fireAt);
  await h.service.runScheduler();
  assert.equal(h.store.inspect().sends[0]?.rows[0]?.state.status, 'deferred');
  assert.deepEqual(
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'match-ready', fireAt }),
    { status: 'replaced' },
    'the old content stops',
  );
  assert.deepEqual(h.store.inspect().sends, []);
  await h.service.runScheduler();
  h.time.set('2026-10-19T23:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.topic.id),
    ['match-ready'],
  );
}

// A run that finds a send of a replaced reminder's other content at its key sends its own.
{
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const other: NotificationTopicDeclaration = { ...quiet, id: 'match-ready' };
  const h = harness({ topics: [quiet, other] });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T13:30:00Z';
  const key = 'reminder:p-1:k:2026-10-19T13:30:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'match-ready', fireAt });
  // The send a replaced friend-challenge reminder left at the same key, still waiting.
  await h.store.createSend({
    key,
    fingerprint: 'friend-challenge-content',
    request: { idempotencyKey: key, player: 'p-1', topic: 'friend-challenge' },
    origin: { kind: 'reminder', key: 'k' },
    scheduled: true,
    rows: [
      {
        key: `${key}:install-p-1`,
        provider: 'fcm',
        installationId: 'install-p-1',
        state: { status: 'deferred', reason: 'quiet-hours', until: '2026-10-19T23:00:00Z' },
      },
    ],
    changedAt: fireAt,
  });
  h.time.set(fireAt);
  await h.service.runScheduler();
  h.time.set('2026-10-19T23:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.topic.id),
    ['match-ready'],
  );
}

// A set's stop runs before its write, so a failure leaves the set to retry; a cancel's
// second stop after the removal is best effort.
{
  let failReads = 0;
  const quiet: NotificationTopicDeclaration = {
    ...challenge,
    quietHours: { start: '22:00', end: '08:00' },
  };
  const h = harness({
    topics: [quiet],
    store: (inner) => ({
      ...inner,
      async getSend(key) {
        if (failReads > 0 && key.startsWith('reminder:')) {
          failReads -= 1;
          if (failReads === 0) {
            throw new Error('D1 is unavailable.');
          }
        }
        return inner.getSend(key);
      },
    }),
  });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T13:30:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  h.time.set(fireAt);
  await h.service.runScheduler();
  // The set's stop fails before its write: nothing changes, and the retry stops the waiting send.
  failReads = 1;
  const moved = { key: 'k', topic: 'friend-challenge', fireAt: '2026-10-20T13:30:00Z' };
  await assert.rejects(h.service.setReminder(session('p-1'), moved), /D1 is unavailable/u);
  assert.deepEqual(pending(h), []);
  assert.equal(h.store.inspect().sends.length, 1);
  assert.deepEqual(await h.service.setReminder(session('p-1'), moved), { status: 'replaced' });
  assert.deepEqual(h.store.inspect().sends, []);
  assert.equal(pending(h)[0]?.dueAt, '2026-10-20T13:30:00Z');
  // The cancel's stop before the removal runs; the one after it fails and is reported.
  h.time.set('2026-10-20T13:30:00Z');
  await h.service.runScheduler();
  failReads = 2;
  assert.deepEqual(await h.service.cancelReminder(session('p-1'), { key: 'k' }), {
    cancelled: true,
  });
  assert.deepEqual(h.errors, ['reminders.stop']);
  assert.deepEqual(
    h.store.inspect().sends.filter((send) => send.key.endsWith('2026-10-20T13:30:00Z')),
    [],
    'the waiting send was stopped before the removal',
  );
}

// A run whose mark fails after a same-time set of other content stops only its own content's send.
{
  let interleave: (() => Promise<unknown>) | undefined;
  const other: NotificationTopicDeclaration = { ...challenge, id: 'match-ready' };
  const h = harness({
    topics: [challenge, other],
    store: (inner) => ({
      ...inner,
      async updateScheduleEntry(input) {
        // Between this run storing its rows and marking its reminder: a set of other content,
        // and another run that fires it (its rows replace these at the same key).
        if (interleave !== undefined && input.entry?.item.kind === 'reminder' && input.entry.item.firedAt !== undefined) {
          const run = interleave;
          interleave = undefined;
          await run();
        }
        return inner.updateScheduleEntry(input);
      },
    }),
  });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T03:00:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  interleave = async () => {
    assert.deepEqual(
      await h.service.setReminder(session('p-1'), { key: 'k', topic: 'match-ready', fireAt }),
      { status: 'replaced' },
    );
    await h.service.runScheduler();
  };
  await h.service.runScheduler();
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.topic.id),
    ['match-ready'],
  );
  assert.deepEqual(pending(h), []);
}

// A stale run that read a replaced reminder leaves alone the newer reminder's send at the same key.
{
  let interleave: (() => Promise<unknown>) | undefined;
  const other: NotificationTopicDeclaration = { ...challenge, id: 'match-ready' };
  // A queue keeps the newer reminder's rows waiting, where a stale stop could reach them.
  const h = harness({
    topics: [challenge, other],
    queue: true,
    store: (inner) => ({
      ...inner,
      async getSend(key) {
        if (interleave !== undefined && key.startsWith('reminder:')) {
          const run = interleave;
          interleave = undefined;
          await run();
        }
        return inner.getSend(key);
      },
    }),
  });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T03:00:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  // While the first run looks the key up, a set replaces the reminder, and another run fires it.
  interleave = async () => {
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'match-ready', fireAt });
    await h.service.runScheduler();
  };
  await h.service.runScheduler();
  for (const job of h.jobs) {
    await h.service.dispatch(job);
  }
  assert.deepEqual(
    h.fcm.calls.map((call) => call.topic.id),
    ['match-ready'],
  );
  assert.deepEqual(pending(h), []);
}

// A delivered send of a replaced reminder at the same key and time keeps the key: the new one is reported, not sent.
{
  const other: NotificationTopicDeclaration = { ...challenge, id: 'match-ready' };
  const h = harness({ topics: [challenge, other] });
  await register(h, 'p-1');
  const fireAt = '2026-10-19T03:00:00Z';
  await h.service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt });
  await h.service.runScheduler();
  assert.equal(h.fcm.calls.length, 1);
  assert.deepEqual(
    await h.service.setReminder(session('p-1'), { key: 'k', topic: 'match-ready', fireAt }),
    { status: 'scheduled' },
  );
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => call.topic.id),
    ['friend-challenge'],
  );
  assert.deepEqual(h.errors, ['scheduler.reminder']);
  assert.deepEqual(pending(h), []);
}

// A fired reminder whose send cannot be read is kept, not forgotten, and looked at again a minute later.
{
  let failRead = false;
  const h = harness({
    store: (inner) => ({
      ...inner,
      async getSend(key) {
        if (failRead && key.startsWith('reminder:')) {
          throw new Error('D1 is unavailable.');
        }
        return inner.getSend(key);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'k',
    topic: 'friend-challenge',
    fireAt: '2026-10-19T03:00:00Z',
  });
  await h.service.runScheduler();
  h.time.advance(30 * 86_400);
  failRead = true;
  await h.service.runScheduler();
  const entry = h.store.inspect().schedule.find((candidate) => candidate.id === 'reminder:k');
  assert.equal(Date.parse(entry?.dueAt ?? ''), Date.parse(h.time.now()) + 60_000);
  failRead = false;
  h.time.advance(60);
  await h.service.runScheduler();
  assert.deepEqual(h.store.inspect().schedule, []);
}

// A push that survives a check and is refused later still backs off.
{
  const answers: NotificationRemoteDeliveryAnswer[] = [];
  for (let index = 0; index < 50; index += 1) {
    answers.push({ status: 'ambiguous' }, { status: 'rejected', reason: 'recipient' });
  }
  const h = harness({ topics: [weekend, noticeTopic], deployment: kr, notices: true, answers });
  await register(h, 'p-1');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  h.time.set('2026-10-26T00:00:00Z');
  for (let hour = 0; hour < 72; hour += 1) {
    await h.service.runScheduler();
    h.time.advance(3600);
  }
  // Each push costs two calls (the ambiguous one and its replay), and pushes back off.
  assert.ok(h.fcm.calls.length <= 20, `calls in 72 hours: ${h.fcm.calls.length}`);
  answers.length = 0;
}

// A player id no notice key can hold fails its check once.
{
  const h = harness({ topics: [weekend, noticeTopic], deployment: kr, notices: true });
  await h.service.recordConsent(session('p-\uD800'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  const run = await h.service.runScheduler();
  assert.equal(run.failed, 0);
  assert.deepEqual(h.store.inspect().schedule, []);
  assert.deepEqual(h.errors, ['scheduler.notice']);
}

// A provider's own failure is marked, so a host logs only its name.
{
  const contexts: { readonly operation: string; readonly fromProvider?: boolean }[] = [];
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      {
        entry: fcmEntry,
        delivery: {
          id: 'fcm',
          async send() {
            throw new Error('fetch failed for tok-secret');
          },
        },
        targets: ['vector'],
      },
    ]),
    catalog: { defaultLocale: 'ko', topicsFor: () => [challenge] },
    now: () => '2026-10-19T03:00:00Z',
    onError: (_error, context) => contexts.push(context),
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok-secret', permission: 'granted' },
    },
  });
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'x', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'in-flight',
    },
  );
  assert.deepEqual(
    contexts.map((context) => [context.operation, context.fromProvider]),
    [['provider.send', true]],
  );
}

// A reminder set for a past time is due now, behind those already due, and so are its rows; it keeps its send key.
{
  const leases: string[] = [];
  const h = harness({
    store: (inner) => ({
      ...inner,
      async updateSend(input) {
        const row = input.send?.rows[0];
        if (input.send?.origin.kind === 'reminder' && row?.state.status === 'in-flight' && !row.state.attempted) {
          leases.push(row.state.leaseUntil);
        }
        return inner.updateSend(input);
      },
    }),
  });
  await register(h, 'p-1');
  await h.service.setReminder(session('p-1'), {
    key: 'old',
    topic: 'friend-challenge',
    fireAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(pending(h)[0]?.dueAt, '2026-10-19T03:00:00Z');
  h.time.advance(60);
  await h.service.runScheduler();
  assert.deepEqual(
    leases,
    ['2026-10-19T03:00:00Z'],
    'the rows are due when the entry was, not at the past fireAt',
  );
  assert.deepEqual(
    h.fcm.calls.map((call) => call.idempotencyKey),
    ['reminder:p-1:old:2026-01-01T00:00:00Z:install-p-1'],
  );
}

// A consent is recorded even while the notice check cannot be written; the failure is reported.
{
  const h = harness({
    topics: [weekend, noticeTopic],
    deployment: kr,
    notices: true,
    store: (inner) => ({
      ...inner,
      async getScheduleEntry() {
        throw new Error('no such table: notification_schedule');
      },
    }),
  });
  const record = await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.equal(record.kind, 'advertising');
  assert.equal(h.store.inspect().consent.length, 1);
  assert.deepEqual(h.errors, ['notices.retry.before-consent', 'notices.retry.after-consent']);
  assert.equal(
    (await h.service.listNotices(session('p-1'))).length,
    1,
    'the game still lists the notice',
  );
}

// A player keeps at most maxPendingNotificationReminders pending reminders; replacing one is always allowed.
{
  const h = harness();
  await register(h, 'p-1');
  const set = (key: string, fireAt = '2026-10-20T03:00:00Z') =>
    h.service.setReminder(session('p-1'), { key, topic: 'friend-challenge', fireAt });
  for (let index = 0; index < maxPendingNotificationReminders; index += 1) {
    assert.deepEqual(await set(`k-${index}`), { status: 'scheduled' });
  }
  assert.deepEqual(await set('one-more'), { status: 'capacity-exceeded' });
  assert.deepEqual(
    await set('k-0', '2026-10-20T04:00:00Z'),
    { status: 'replaced' },
    'a replace is allowed',
  );
  assert.equal(pending(h).length, maxPendingNotificationReminders);
  // Once one fires, a new key fits again; another player has a cap of its own.
  await set('k-1', '2026-10-19T03:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(await set('one-more'), { status: 'scheduled' });
  await register(h, 'p-2');
  assert.deepEqual(
    await h.service.setReminder(session('p-2'), { key: 'k-0', topic: 'friend-challenge', fireAt: '2026-10-20T03:00:00Z' }),
    { status: 'scheduled' },
  );
  // fireAt is bounded to the horizon.
  await expectCode(set('far', '2027-01-17T03:00:01Z'), 'NOTIFICATIONS_INVALID_INPUT');
  await expectCode(
    h.service.setReminder(session('p-2'), {
      key: 'far',
      topic: 'friend-challenge',
      fireAt: '2027-01-17T03:00:01Z',
    }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  assert.deepEqual(
    await h.service.setReminder(session('p-2'), { key: 'near', topic: 'friend-challenge', fireAt: '2027-01-17T03:00:00Z' }),
    { status: 'scheduled' },
  );
}

// A topic no target of the player's endpoints maps answers unavailable, not permission-required.
{
  const fcm = fakeProvider('fcm');
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['android', 'ios'] },
    ]),
    catalog: {
      defaultLocale: 'ko',
      topicsFor: (target) => (target === 'android' ? [challenge] : []),
    },
    now: () => '2026-10-19T03:00:00Z',
  });
  await service.registerEndpoint(session('p-1'), {
    target: 'ios',
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok-ios', permission: 'granted' },
    },
  });
  assert.deepEqual(
    await service.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt: '2026-10-19T04:00:00Z' }),
    { status: 'unavailable' },
  );
}

// A reminder's link follows the gate's link step and the provider's link rule, when it is set.
{
  const linked = fakeProvider('linked');
  const linkedEntry: NotificationDeliveryProviderEntry = {
    ...platformEntry,
    provider: 'linked',
    link: true,
  };
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      {
        entry: {
          ...linkedEntry,
          mapping: { link: { required: false, pattern: '^t[13]_[A-Za-z0-9]+$' } },
        },
        delivery: linked,
        targets: ['vector'],
      },
    ]),
    catalog: { defaultLocale: 'ko', topicsFor: () => [challenge] },
    resolvePlatformRecipient: ({ player }) => `user-${player}`,
    now: () => '2026-10-19T03:00:00Z',
  });
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  const set = (link?: string) =>
    service.setReminder(session('p-1'), {
      key: 'k',
      topic: 'friend-challenge',
      fireAt: '2026-10-19T04:00:00Z',
      ...(link === undefined ? {} : { link }),
    });
  await expectCode(set(), 'NOTIFICATIONS_INVALID_INPUT', 'no link where the provider needs one');
  await expectCode(
    set('https://evil.example/'),
    'NOTIFICATIONS_INVALID_INPUT',
    'a link the rule refuses',
  );
  assert.deepEqual(await set('t3_abc123'), { status: 'scheduled' });
  // A link the topic mapping carries serves a reminder without one.
  const mappedService = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: linkedEntry, delivery: linked, targets: ['vector'] },
    ]),
    catalog: {
      defaultLocale: 'ko',
      topicsFor: () => [{ ...challenge, mapping: { link: 't3_post' } }],
    },
    resolvePlatformRecipient: ({ player }) => `user-${player}`,
    now: () => '2026-10-19T03:00:00Z',
  });
  await mappedService.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  assert.deepEqual(
    await mappedService.setReminder(session('p-1'), { key: 'k', topic: 'friend-challenge', fireAt: '2026-10-19T04:00:00Z' }),
    { status: 'scheduled' },
  );
}

// Compaction keeps every acceptance record while a per-send provider is registered (it counts them).
{
  for (const allowance of ['persistent', 'per-send'] as const) {
    const time = clock('2026-10-19T03:00:00Z');
    const store = createInMemoryNotificationStore();
    const registered = createNotificationProviderRegistry([
      { entry: platformEntry, delivery: fakeProvider('platform'), targets: ['vector'] },
    ]);
    // The registry refuses per-send entries, so the per-send case is built by hand.
    const registry = allowance === 'persistent'
      ? registered
      : {
          ...registered,
          providers: registered.providers.map((provider) => ({
            ...provider,
            entry: { ...provider.entry, permission: { ...provider.entry.permission, allowance } },
          })),
        };
    const service = createNotificationService({
      store,
      registry,
      catalog: { defaultLocale: 'ko', topicsFor: () => [challenge] },
      now: time.now,
    });
    const report = (state: 'granted' | 'denied') =>
      service.recordConsent(session('p-1'), {
        kind: 'delivery-permission',
        state,
        source: 'client-report',
      });
    await report('granted');
    await report('denied');
    await report('granted');
    time.advance(86_401);
    await report('denied');
    assert.equal(
      store.inspect().consent.length,
      allowance === 'per-send' ? 4 : 1,
      `${allowance}: acceptance records ${allowance === 'per-send' ? 'kept' : 'compacted'}`,
    );
  }
}

// One run goes on in rounds until nothing is due or its wall-time budget is used.
{
  for (const budget of ['drains', 'stops'] as const) {
    let wall = 0;
    const time = clock('2026-10-19T03:00:00Z');
    const fcm = fakeProvider('fcm');
    const store = createInMemoryNotificationStore();
    const service = createNotificationService({
      store,
      registry: createNotificationProviderRegistry([{ entry: fcmEntry, delivery: fcm, targets: ['vector'] }]),
      catalog: { defaultLocale: 'ko', topicsFor: () => [challenge] },
      now: time.now,
      // Each read of the wall clock is 6 seconds later, so a 20-second budget allows a few rounds.
      elapsedMs: () => {
        wall += budget === 'stops' ? 6_000 : 0;
        return wall;
      },
    });
    for (let index = 0; index < 25; index += 1) {
      await service.registerEndpoint(session(`p-${index}`), {
        registration: {
          provider: 'fcm',
          address: { kind: 'fcm-token', value: `tok-${index}`, permission: 'granted' },
        },
      });
      await service.setReminder(session(`p-${index}`), {
        key: 'k',
        topic: 'friend-challenge',
        fireAt: '2026-10-19T03:00:00Z',
      });
    }
    const run = await service.runScheduler({ limit: 5 });
    if (budget === 'drains') {
      assert.equal(fcm.calls.length, 25, 'one run drains five batches');
      assert.equal(run.results.length, 25);
    } else {
      // Started at 6 s; rounds end 6, 12, 18, and 24 s later: the fourth crosses the 20-second budget.
      assert.equal(fcm.calls.length, 20, 'the run stops once its budget is used');
    }
  }
}

// The pace holds across the rounds of one run: with the queue, rows taken earlier count before they deliver.
{
  const h = harness({
    queue: true,
    fcmEntry: { ...fcmEntry, rate: { count: 3, windowSeconds: 60 } },
  });
  for (let index = 0; index < 10; index += 1) {
    await register(h, `p-${index}`);
    await h.service.setReminder(session(`p-${index}`), {
      key: 'k',
      topic: 'friend-challenge',
      fireAt: '2026-10-19T03:00:00Z',
    });
  }
  await h.service.runScheduler({ limit: 2 });
  assert.equal(h.jobs.length, 3, 'no more than the rate in one run, across its rounds');
}

// A run whose remaining due rows the pace holds back ends; a round that throws keeps what came before.
{
  let listings = 0;
  const h = harness({
    fcmEntry: { ...fcmEntry, rate: { count: 1, windowSeconds: 60 } },
    store: (inner) => ({
      ...inner,
      async listDueSends(input) {
        listings += 1;
        return inner.listDueSends(input);
      },
    }),
  });
  for (let index = 0; index < 3; index += 1) {
    await register(h, `p-${index}`);
    await h.service.setReminder(session(`p-${index}`), {
      key: 'k',
      topic: 'friend-challenge',
      fireAt: '2026-10-19T03:00:00Z',
    });
  }
  await h.service.runScheduler({ limit: 2 });
  assert.equal(h.fcm.calls.length, 1, 'one send within the pace');
  assert.equal(pending(h).length, 0, 'every reminder fired into a waiting send');
  // Round 2 fires the last reminder and finds a full batch the pace holds back entirely: the run ends there.
  assert.equal(listings, 2, 'no third round for a batch the pace holds back');
}
{
  let listings = 0;
  const h = harness({
    store: (inner) => ({
      ...inner,
      async listDueSends(input) {
        listings += 1;
        if (listings === 2) {
          throw new Error('D1 is unavailable.');
        }
        return inner.listDueSends(input);
      },
    }),
  });
  for (let index = 0; index < 3; index += 1) {
    await register(h, `p-${index}`);
    await h.service.setReminder(session(`p-${index}`), {
      key: 'k',
      topic: 'friend-challenge',
      fireAt: '2026-10-19T03:00:00Z',
    });
  }
  const run = await h.service.runScheduler({ limit: 1 });
  assert.equal(h.fcm.calls.length, 1, 'the first round sent');
  assert.equal(run.results.length, 2, "its results and the failed round's fired reminder are kept");
  assert.equal(run.failed, 1);
  assert.deepEqual(h.errors, ['scheduler.round']);
}

console.info('Notifications scheduler tests passed.');

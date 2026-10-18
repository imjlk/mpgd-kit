import assert from 'node:assert/strict';

import {
  referenceNotificationProviders,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryProviderEntry,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import type {
  NotificationRemoteDeliveryAnswer,
  NotificationRemoteDeliveryProvider,
  NotificationRemoteDeliveryRequest,
} from './delivery-provider.js';
import {
  createNotificationProviderRegistry,
  createNotificationServiceCatalog,
  type NotificationServiceCatalog,
} from './registry.js';
import {
  createNotificationService,
  type NotificationDispatchJob,
  type NotificationSession,
} from './service.js';
import { createInMemoryNotificationStore, type NotificationStore } from './store.js';

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

function fakeProvider(id: string, answers: NotificationRemoteDeliveryAnswer[] = []) {
  const calls: NotificationRemoteDeliveryRequest[] = [];
  const provider: NotificationRemoteDeliveryProvider & { readonly calls: typeof calls } = {
    id,
    calls,
    async send(request) {
      calls.push(request);
      const answer = answers.shift();
      if (answer === undefined) {
        return { status: 'accepted' };
      }
      return answer;
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
  };
}

const serviceTopic: NotificationTopicDeclaration = {
  id: 'friend-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  copy: { ko: { title: '도전', body: '{{name}}님이 도전했어요.' } },
};

function vectorCatalog(topics: readonly NotificationTopicDeclaration[]): NotificationServiceCatalog {
  return { defaultLocale: 'ko', topicsFor: () => topics };
}

const session = (player: string, installationId = 'install-1', sessionId = `s-${player}-${installationId}`): NotificationSession => ({
  player,
  sessionId,
  installationId,
});

async function expectCode(promise: Promise<unknown>, code: string, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { readonly code?: unknown }).code, code, message);
    return true;
  });
}

// The registry checks itself once.
{
  const fcm = fakeProvider('fcm');
  assert.throws(
    () => createNotificationProviderRegistry([{ entry: fcmEntry, delivery: fakeProvider('other') }]),
    /registered for entry fcm/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        { entry: fcmEntry, delivery: fcm },
        { entry: fcmEntry, delivery: fcm },
      ]),
    /registered twice/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        {
          entry: {
            ...platformEntry,
            permission: { ...platformEntry.permission, allowance: 'per-send' },
          },
          delivery: fakeProvider('platform'),
          targets: ['wechat'],
        },
      ]),
    /per-send/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        {
          entry: {
            ...platformEntry,
            permission: { ...platformEntry.permission, serverReadable: true },
          },
          delivery: fakeProvider('platform'),
          targets: ['reddit'],
        },
      ]),
    /no readPermission/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        { entry: platformEntry, delivery: fakeProvider('platform') },
      ]),
    /needs its catalog targets/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        { entry: fcmEntry, delivery: fcm },
        { entry: platformEntry, delivery: fakeProvider('platform'), targets: ['ios'] },
      ]),
    /target ios is served by both fcm and platform/u,
  );
  assert.throws(
    () =>
      createNotificationProviderRegistry([
        {
          entry: { ...platformEntry, limits: [{ count: 1, windowSeconds: 31 * 86_400 }] },
          delivery: fakeProvider('platform'),
          targets: ['ait'],
        },
      ]),
    /longer than the 30-day delivery history/u,
  );
  const registry = createNotificationProviderRegistry([{ entry: fcmEntry, delivery: fcm }]);
  // The reference targets of fcm, and a published snapshot without the mapping rules.
  assert.deepEqual(registry.provider('fcm')?.targets, ['android', 'ios']);
  const snapshot = registry.snapshot();
  assert.deepEqual(snapshot.targets, { android: 'fcm', ios: 'fcm' });
  assert.equal('mapping' in (snapshot.providers[0] ?? {}), false);
}

// Two targets share FCM: each endpoint's target picks the mapping the gate and provider read.
{
  const fcm = fakeProvider('fcm');
  const registry = createNotificationProviderRegistry([{ entry: fcmEntry, delivery: fcm }]);
  const catalog = createNotificationServiceCatalog(
    {
      version: '2026-10-19',
      defaultLocale: 'ko',
      topics: [
        {
          id: 'friend-challenge',
          purpose: 'service',
          channels: ['remote'],
          route: '/?entry=challenge',
          copy: { ko: { title: '도전', body: '도전이 왔어요.' } },
          targets: { android: { channelId: 'social' }, ios: {} },
        },
        {
          id: 'android-only',
          purpose: 'service',
          channels: ['remote'],
          route: '/',
          copy: { ko: { title: 'A', body: 'B' } },
          targets: { android: { channelId: 'misc' } },
        },
      ],
    },
    { registry },
  );
  assert.throws(
    () =>
      createNotificationServiceCatalog(
        {
          version: 'x',
          defaultLocale: 'ko',
          topics: [
            { id: 'bad', purpose: 'service', channels: ['remote'], route: 'https://evil.example/' },
          ],
        },
        { registry },
      ),
    /Invalid notification topic catalog/u,
  );
  const time = clock('2026-10-19T03:00:00Z');
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({ store, registry, catalog, now: time.now });
  for (const [installation, target] of [
    ['a-android', 'android'],
    ['b-ios', 'ios'],
  ] as const) {
    await service.registerEndpoint(session('p-1', installation), {
      target,
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: `tok-${installation}`, permission: 'granted' },
      },
    });
  }
  await expectCode(
    service.registerEndpoint(session('p-1', 'c'), {
      target: 'ait',
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: 'tok-c', permission: 'granted' },
      },
    }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'k-1', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'delivered',
      alreadyProcessed: false,
    },
  );
  assert.deepEqual(
    fcm.calls.map((call) => [call.idempotencyKey, call.topic.mapping]),
    [
      ['k-1:a-android', { channelId: 'social' }],
      ['k-1:b-ios', {}],
    ],
  );
  // A topic the iOS target does not map reaches only the Android endpoint.
  await service.deliver({ idempotencyKey: 'k-2', player: 'p-1', topic: 'android-only' });
  assert.deepEqual(
    fcm.calls.slice(2).map((call) => call.idempotencyKey),
    ['k-2:a-android'],
  );
}

// Queue dispatch: the gate runs when the job runs; a lost job is replayed after the lease.
{
  const time = clock('2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm');
  const jobs: NotificationDispatchJob[] = [];
  const errors: string[] = [];
  let refuse = false;
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['vector'] },
    ]),
    catalog: vectorCatalog([serviceTopic]),
    now: time.now,
    queue: {
      async enqueue(batch) {
        if (refuse) {
          throw new Error('queue down');
        }
        jobs.push(...batch);
      },
    },
    onError: (_error, context) => {
      errors.push(context.operation);
    },
  });
  for (const installation of ['i-1', 'i-2']) {
    await service.registerEndpoint(session('p-1', installation), {
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: `tok-${installation}`, permission: 'granted' },
      },
    });
  }
  const send = {
    idempotencyKey: 'q-1',
    player: 'p-1',
    topic: 'friend-challenge',
    templateData: { name: 'Mina' },
  };
  assert.deepEqual(await service.deliver(send), { status: 'in-flight' });
  assert.equal(fcm.calls.length, 0);
  assert.deepEqual(
    jobs.map((job) => job.rowKey),
    ['q-1:i-1', 'q-1:i-2'],
  );
  // The second endpoint unbinds before its job runs: the gate, run at the call, finds no endpoint.
  await service.unregisterEndpoint(session('p-1', 'i-2'), { provider: 'fcm' });
  for (const job of jobs) {
    await service.dispatch(job);
  }
  // A duplicate queue delivery of a finished job does nothing.
  await service.dispatch(jobs[0] as NotificationDispatchJob);
  assert.deepEqual(
    fcm.calls.map((call) => call.idempotencyKey),
    ['q-1:i-1'],
  );
  assert.equal(fcm.calls[0]?.content.body, 'Mina님이 도전했어요.');
  assert.deepEqual(await service.deliver(send), { status: 'delivered', alreadyProcessed: true });
  // A queue that refuses keeps the rows; dispatchDue runs them once the lease ends.
  refuse = true;
  assert.deepEqual(await service.deliver({ ...send, idempotencyKey: 'q-2' }), {
    status: 'in-flight',
  });
  assert.deepEqual(errors, ['queue.enqueue']);
  assert.deepEqual((await service.dispatchDue()).results, []);
  time.advance(301);
  const due = await service.dispatchDue();
  assert.deepEqual(due, {
    results: [{ sendKey: 'q-2', outcome: { status: 'delivered', alreadyProcessed: false } }],
    failed: 0,
  });
  // Retrying with another request under the key is a conflict.
  await expectCode(
    service.deliver({ ...send, templateData: { name: 'Jun' } }),
    'NOTIFICATIONS_IDEMPOTENCY_CONFLICT',
  );
}

// Send inputs: bounds, unknown fields, reserved prefixes and topics, and caller errors.
{
  const fcm = fakeProvider('fcm');
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([{ entry: fcmEntry, delivery: fcm, targets: ['vector'] }]),
    catalog: {
      defaultLocale: 'ko',
      notices: {
        topic: 'consent-notice',
        copy: {
          ko: Object.fromEntries([
            'consent-result.advertising.granted',
            'consent-result.advertising.withdrawn',
            'consent-result.night.granted',
            'consent-result.night.withdrawn',
            'reconfirmation.advertising',
            'reconfirmation.night',
          ].map((variant) => [variant, { title: `[게임] ${variant}`, body: '{{consentDate}} 처리' }])) as never,
        },
      },
      topicsFor: () => [serviceTopic, { id: 'consent-notice', purpose: 'service', channels: ['remote'], route: '/' }],
    },
    now: () => '2026-10-19T03:00:00Z',
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  for (const bad of [
    null,
    { idempotencyKey: '', player: 'p-1', topic: 'friend-challenge' },
    { idempotencyKey: 'reminder:x', player: 'p-1', topic: 'friend-challenge' },
    { idempotencyKey: 'notice:x', player: 'p-1', topic: 'friend-challenge' },
    { idempotencyKey: 'k', player: 'p-1', topic: 'friend-challenge', extra: true },
    { idempotencyKey: 'k', player: 'p-1', topic: 'friend-challenge', data: { n: 1 } },
    { idempotencyKey: 'k', player: '', topic: 'friend-challenge' },
    { idempotencyKey: 'k', player: 'p-1', topic: 'consent-notice' },
  ]) {
    await expectCode(service.deliver(bad), 'NOTIFICATIONS_INVALID_INPUT', JSON.stringify(bad));
  }
  // Missing template data is a caller error, and the key stays free for a corrected send.
  await expectCode(
    service.deliver({ idempotencyKey: 'k', player: 'p-1', topic: 'friend-challenge' }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  assert.deepEqual(store.inspect().sends, []);
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'k', player: 'p-1', topic: 'friend-challenge', templateData: { name: 'A' } }),
    { status: 'delivered', alreadyProcessed: false },
  );
  assert.throws(
    () =>
      createNotificationService({
        store,
        registry: createNotificationProviderRegistry([]),
        catalog: {
          defaultLocale: 'ko',
          notices: { topic: 'consent-notice', copy: {} },
          topicsFor: () => [],
        },
      }),
    /notices block/u,
  );
}

// Consent records: dated by the backend, at least 1 ms apart, never from a provider.
{
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([]),
    catalog: vectorCatalog([]),
    now: () => '2026-10-19T03:00:00Z',
  });
  const first = await service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
    at: '1999-01-01T00:00:00Z',
  });
  const second = await service.recordConsent(session('p-1'), {
    kind: 'night',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.equal(first.at, '2026-10-19T03:00:00Z');
  assert.equal(second.at, '2026-10-19T03:00:00.001Z');
  for (const bad of [
    { kind: 'host-agreement', topic: 't', state: 'denied', source: 'provider' },
    { kind: 'advertising', state: 'granted', source: 'player' },
    { kind: 'topic-preference', topic: 't', state: 'blocked', source: 'player' },
    'granted',
  ]) {
    await expectCode(
      service.recordConsent(session('p-1'), bad),
      'NOTIFICATIONS_INVALID_INPUT',
      JSON.stringify(bad),
    );
  }
  assert.equal((await service.listConsent(session('p-1'))).length, 2);
  assert.deepEqual(await service.listConsent(session('p-2')), []);
  // Without the Korean rules no notice is listed or recorded.
  assert.deepEqual(await service.listNotices(session('p-1')), []);
}

// Notices under the Korean rules: recorded only while listed, and named to the millisecond.
{
  const time = clock('2026-10-19T03:00:00Z');
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([]),
    catalog: vectorCatalog([]),
    deployment: { advertisingRules: 'kr', advertisingSender: { contact: '02-000-0000' } },
    now: time.now,
  });
  const consent = await service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  const [notice] = await service.listNotices(session('p-1'));
  assert.deepEqual(notice, {
    kind: 'consent-result',
    record: { kind: 'advertising', state: 'granted', at: consent.at, textVersion: 'v1' },
    dueBy: '2026-11-02',
    variant: 'consent-result.advertising.granted',
  });
  await expectCode(
    service.recordNoticeShown(session('p-1'), { kind: 'consent-result' }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  // A name that names another instant records nothing.
  await service.recordNoticeShown(session('p-1'), {
    kind: 'consent-result',
    record: { kind: 'advertising', at: '2026-10-19T03:00:01Z' },
    dueBy: '2026-11-02',
  });
  assert.equal((await service.listNotices(session('p-1'))).length, 1);
  // Another spelling of the same instant matches.
  await service.recordNoticeShown(session('p-1'), {
    kind: 'consent-result',
    record: { kind: 'advertising', at: '2026-10-19T12:00:00+09:00' },
    dueBy: '2026-11-02',
  });
  await service.recordNoticeShown(session('p-1'), notice);
  assert.deepEqual(await service.listNotices(session('p-1')), []);
  assert.equal(store.inspect().noticesGiven.length, 1);
  assert.equal(store.inspect().noticesGiven[0]?.channel, 'in-game');
}

// Endpoints: bound to the session, unbound at its end or expiry, stale after 60 days, purged later.
{
  const time = clock('2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm');
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      {
        entry: fcmEntry,
        delivery: fcm,
        targets: ['vector'],
        addressKinds: ['fcm-token'],
      },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    now: time.now,
  });
  const register = (current: NotificationSession, value: string, kind = 'fcm-token') =>
    service.registerEndpoint(current, {
      registration: { provider: 'fcm', address: { kind, value, permission: 'granted' } },
    });
  await expectCode(
    register(session('p-1'), 'fid', 'fcm-installation'),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  await expectCode(
    service.registerEndpoint(session('p-1'), {
      registration: { provider: 'nope', address: { kind: 'platform-user' } },
    }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  await expectCode(
    service.registerEndpoint(session('p-1'), {
      registration: { provider: 'fcm', address: { kind: 'platform-user' } },
    }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  await assert.rejects(
    service.listConsent({ player: '', sessionId: 's', installationId: 'i' }),
    TypeError,
  );
  await register(
    { ...session('p-1', 'i-1', 'sess-a'), expiresAt: '2026-10-20T03:00:00Z' },
    'tok-a',
  );
  await register(session('p-1', 'i-2', 'sess-b'), 'tok-b');
  const deliver = (key: string) => service.deliver({
    idempotencyKey: key,
    player: 'p-1',
    topic: 'friend-challenge',
  });
  await deliver('e-1');
  assert.deepEqual(
    fcm.calls.map((call) => call.idempotencyKey),
    ['e-1:i-1', 'e-1:i-2'],
  );
  // The first session expires: its endpoint counts as unbound.
  time.advance(86_400);
  await deliver('e-2');
  assert.deepEqual(
    fcm.calls.slice(2).map((call) => call.idempotencyKey),
    ['e-2:i-2'],
  );
  // The second session ends: nothing is left.
  await service.endSession({ sessionId: 'sess-b' });
  assert.deepEqual(await deliver('e-3'), { status: 'unavailable', reason: 'no-endpoint' });
  // A new registration that is never refreshed goes stale after 60 days.
  await register(session('p-1', 'i-3', 'sess-c'), 'tok-c');
  time.advance(60 * 86_400);
  assert.deepEqual(await deliver('e-4'), { status: 'unavailable', reason: 'no-endpoint' });
  // The expired session's endpoint goes now, and both delivered keys are past their 30 days.
  assert.deepEqual(await service.purge(), { sends: 2, history: 2, endpoints: 1 });
  // The stale endpoint goes 30 days after it went stale.
  time.advance(30 * 86_400 + 1);
  assert.deepEqual(await service.purge(), { sends: 0, history: 0, endpoints: 1 });
  assert.deepEqual(store.inspect().endpoints, []);
}

// Several providers, provider failures, and the direct caller's replay after the lease.
{
  const time = clock('2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm', [{ status: 'accepted' }]);
  const platform = fakeProvider('platform');
  let throwNext = false;
  const flaky: NotificationRemoteDeliveryProvider = {
    id: 'platform',
    async send(request) {
      if (throwNext) {
        throwNext = false;
        throw new Error('socket hang up');
      }
      return platform.send(request);
    },
  };
  const store = createInMemoryNotificationStore();
  const errors: string[] = [];
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['android'] },
      { entry: platformEntry, delivery: flaky, targets: ['web'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: ({ player }) => (player === 'p-1' ? 'platform-user-1' : undefined),
    now: time.now,
    onError: (_error, context) => {
      errors.push(context.operation);
    },
  });
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  await service.registerEndpoint(session('p-1'), {
    registration: { provider: 'platform', address: { kind: 'platform-user' }, locale: 'en-US' },
  });
  // Without a provider, every provider the player has a recipient on.
  await service.deliver({ idempotencyKey: 'm-1', player: 'p-1', topic: 'friend-challenge' });
  assert.equal(fcm.calls.length, 1);
  assert.deepEqual(
    platform.calls.map((call) => [call.idempotencyKey, call.recipient, call.locale]),
    [['m-1', { kind: 'platform-user', id: 'platform-user-1' }, 'en-US']],
  );
  // A provider that throws is ambiguous: the claim is kept until the lease ends.
  throwNext = true;
  const only = {
    idempotencyKey: 'm-2',
    player: 'p-1',
    topic: 'friend-challenge',
    provider: 'platform',
  };
  assert.deepEqual(await service.deliver(only), { status: 'in-flight' });
  assert.deepEqual(errors, ['provider.send']);
  assert.deepEqual(await service.deliver(only), { status: 'in-flight' });
  time.advance(300);
  assert.deepEqual(await service.deliver(only), { status: 'delivered', alreadyProcessed: false });
  assert.deepEqual(
    platform.calls.map((call) => call.idempotencyKey),
    ['m-1', 'm-2'],
  );
  // An unknown provider has no recipient.
  assert.deepEqual(await service.deliver({ ...only, idempotencyKey: 'm-3', provider: 'nope' }), {
    status: 'unavailable',
    reason: 'no-endpoint',
  });
}

// Rate limits: the first deferral waits retryAfterSeconds, later ones back off with jitter, and 24 hours ends it.
{
  const time = clock('2026-10-19T03:00:00Z');
  const answers: NotificationRemoteDeliveryAnswer[] = Array.from({ length: 40 }, () => ({
    status: 'rate-limited',
    retryAfterSeconds: 3600,
  }));
  const platform = fakeProvider('platform', answers);
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: platformEntry, delivery: platform, targets: ['web'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
    random: () => 0.5,
  });
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  const first = await service.deliver({
    idempotencyKey: 'r-1',
    player: 'p-1',
    topic: 'friend-challenge',
  });
  assert.deepEqual(first, {
    status: 'deferred',
    reason: 'provider-rate-limited',
    until: '2026-10-19T04:00:00Z',
  });
  time.advance(3600);
  const [second] = (await service.dispatchDue()).results;
  // 3600 s doubled, with 12.5% jitter.
  assert.deepEqual(second?.outcome, {
    status: 'deferred',
    reason: 'provider-rate-limited',
    until: new Date(Date.parse('2026-10-19T04:00:00Z') + 7200 * 1.125 * 1000).toISOString().replace(
      '.000Z',
      'Z',
    ),
  });
  let last: NotificationDeliveryOutcome | undefined = second?.outcome;
  for (let round = 0; round < 10 && last?.status === 'deferred'; round += 1) {
    time.advance(86_400);
    last = (await service.dispatchDue()).results[0]?.outcome;
  }
  assert.deepEqual(last, { status: 'unavailable', reason: 'provider-rate-limited' });
  assert.deepEqual(store.inspect().sends, []);
}

// The ledger under contention, and providers that break the contract.
{
  const time = clock('2026-10-19T03:00:00Z');
  const inner = createInMemoryNotificationStore();
  let conflicts = 0;
  const contended: NotificationStore = {
    ...inner,
    async updateSend(write) {
      // Another row's worker wins the race for a send that already has rows.
      const held = await inner.getSend(write.key);
      if (conflicts > 0 && (held?.send.rows.length ?? 0) > 0) {
        conflicts -= 1;
        return false;
      }
      return inner.updateSend(write);
    },
  };
  const answers: NotificationRemoteDeliveryAnswer[] = [];
  const fcm = fakeProvider('fcm', answers);
  const reports: string[] = [];
  const service = createNotificationService({
    onError: (_error, context) => {
      reports.push(`${context.operation}:${context.provider ?? ''}:${context.rowKey ?? ''}`);
    },
    store: contended,
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['vector'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    now: time.now,
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  // A few lost compare-and-sets are retried.
  conflicts = 3;
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'c-1', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'delivered',
      alreadyProcessed: false,
    },
  );
  // A row whose claim never lands is not sent: the caller is told to retry,
  // and the stored row runs once its lease ends.
  conflicts = 1000;
  await expectCode(
    service.deliver({ idempotencyKey: 'c-2', player: 'p-1', topic: 'friend-challenge' }),
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
  );
  conflicts = 0;
  assert.equal(fcm.calls.length, 1);
  time.advance(300);
  assert.deepEqual((await service.dispatchDue()).results, [
    { sendKey: 'c-2', outcome: { status: 'delivered', alreadyProcessed: false } },
  ]);
  assert.equal(fcm.calls.length, 2);
  // An answer outside the five kinds counts as ambiguous: the claim is kept.
  answers.push({ status: 'sent' } as unknown as NotificationRemoteDeliveryAnswer);
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'c-3', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'in-flight',
    },
  );
  // An ambiguous device row is replayed after each lease, for a day, and then left in flight.
  let replays = 0;
  for (let hour = 0; hour < 26; hour += 1) {
    answers.push(...Array.from({ length: 12 }, () => ({ status: 'ambiguous' }) as const));
    for (let lease = 0; lease < 12; lease += 1) {
      time.advance(300);
      replays += (await service.dispatchDue()).results.length;
    }
    answers.length = 0;
  }
  assert.ok(replays >= 280 && replays <= 288, `replayed for about a day: ${replays}`);
  assert.deepEqual((await service.dispatchDue()).results, []);
  // The row whose replays end is reported once, with where it is.
  assert.deepEqual(
    reports.filter((entry) => entry.startsWith('dispatch.abandoned')),
    ['dispatch.abandoned:fcm:c-3:install-1'],
  );
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'c-3', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'in-flight',
    },
  );
}

// A failure before the provider call puts the row back; queued jobs run once.
{
  const time = clock('2026-10-19T03:00:00Z');
  let readFails = true;
  const platform = fakeProvider('platform', [{ status: 'ambiguous' }]);
  const readable: NotificationRemoteDeliveryProvider = {
    id: 'platform',
    send: (request) => platform.send(request),
    async readPermission() {
      if (readFails) {
        readFails = false;
        throw new Error('host down');
      }
      return 'granted';
    },
  };
  const jobs: NotificationDispatchJob[] = [];
  const errors: string[] = [];
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      {
        entry: {
          ...platformEntry,
          permission: { ...platformEntry.permission, serverReadable: true },
        },
        delivery: readable,
        targets: ['web'],
      },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
    queue: {
      async enqueue(batch) {
        jobs.push(...batch);
      },
    },
    onError: (_error, context) => {
      errors.push(context.operation);
    },
  });
  // The first read happens at the plan, and fails there: nothing is stored.
  await expectCode(
    service.deliver({ idempotencyKey: 'f-1', player: 'p-1', topic: 'friend-challenge' }),
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
  );
  assert.deepEqual(
    await service.deliver({ idempotencyKey: 'f-1', player: 'p-1', topic: 'friend-challenge' }),
    {
      status: 'in-flight',
    },
  );
  readFails = true;
  // The job's read fails: the row is released, not stranded.
  await expectCode(
    service.dispatch(jobs[0] as NotificationDispatchJob),
    'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
  );
  assert.equal(platform.calls.length, 0);
  await service.dispatch(jobs[0] as NotificationDispatchJob);
  assert.equal(platform.calls.length, 1);
  // A redelivered job does not replay an attempted (ambiguous) row; the lease does.
  await service.dispatch(jobs[0] as NotificationDispatchJob);
  assert.equal(platform.calls.length, 1);
  time.advance(300);
  assert.deepEqual((await service.dispatchDue()).results, [
    { sendKey: 'f-1', outcome: { status: 'delivered', alreadyProcessed: false } },
  ]);
  assert.equal(platform.calls.length, 2);
  assert.deepEqual(errors, []);
}

// Two sends claimed together under a cap of one: exactly one goes.
{
  const time = clock('2026-10-19T03:00:00Z');
  const release: (() => void)[] = [];
  const calls: string[] = [];
  const slow: NotificationRemoteDeliveryProvider = {
    id: 'fcm',
    async send(request) {
      calls.push(request.sendKey);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return { status: 'accepted' };
    },
  };
  const jobs: NotificationDispatchJob[] = [];
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: slow, targets: ['vector'] },
    ]),
    catalog: vectorCatalog([
      { ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } }, frequency: { maxPerDay: 1 } },
    ]),
    now: time.now,
    queue: {
      async enqueue(batch) {
        jobs.push(...batch);
      },
    },
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  await service.deliver({ idempotencyKey: 'cap-b', player: 'p-1', topic: 'friend-challenge' });
  await service.deliver({ idempotencyKey: 'cap-a', player: 'p-1', topic: 'friend-challenge' });
  const running = Promise.all(jobs.map((job) => service.dispatch(job)));
  while (calls.length === 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  for (const resolve of release) {
    resolve();
  }
  await running;
  // Claimed in the same millisecond, the lower key goes first and the other counts it.
  assert.deepEqual(calls, ['cap-a']);
}

// One send delivered through two providers is one send for the topic's cap.
{
  const fcm = fakeProvider('fcm');
  const platform = fakeProvider('platform');
  const time = clock('2026-10-19T03:00:00Z');
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['android'] },
      { entry: platformEntry, delivery: platform, targets: ['web'] },
    ]),
    catalog: vectorCatalog([
      { ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } }, frequency: { maxPerDay: 2 } },
    ]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
  });
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  const deliver = (key: string) => service.deliver({
    idempotencyKey: key,
    player: 'p-1',
    topic: 'friend-challenge',
  });
  await deliver('t-1');
  time.advance(1);
  await deliver('t-2');
  time.advance(1);
  assert.deepEqual(await deliver('t-3'), { status: 'suppressed', reason: 'frequency-capped' });
  assert.deepEqual([fcm.calls.length, platform.calls.length], [2, 2]);
}

// A platform row left ambiguous next to a delivered device row is replayed by the caller's retry.
{
  const time = clock('2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm');
  const platform = fakeProvider('platform', [{ status: 'ambiguous' }]);
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['android'] },
      { entry: platformEntry, delivery: platform, targets: ['web'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
  });
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  const send = { idempotencyKey: 'mix-1', player: 'p-1', topic: 'friend-challenge' };
  assert.deepEqual(await service.deliver(send), { status: 'delivered', alreadyProcessed: false });
  time.advance(300);
  assert.deepEqual(await service.deliver(send), { status: 'delivered', alreadyProcessed: true });
  assert.deepEqual([fcm.calls.length, platform.calls.length], [1, 2]);
  assert.deepEqual((await service.dispatchDue()).results, []);
}

// A provider serving two targets needs the registration's target; a later longer Retry-After wins.
{
  const time = clock('2026-10-19T03:00:00Z');
  const platform = fakeProvider('platform', [
    { status: 'rate-limited', retryAfterSeconds: 1 },
    { status: 'rate-limited', retryAfterSeconds: 3600 },
  ]);
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fakeProvider('fcm'), targets: ['android', 'ios'] },
      { entry: platformEntry, delivery: platform, targets: ['web'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
    random: () => 0,
  });
  await expectCode(
    service.registerEndpoint(session('p-1'), {
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
      },
    }),
    'NOTIFICATIONS_INVALID_INPUT',
  );
  await service.recordConsent(session('p-1'), {
    kind: 'delivery-permission',
    state: 'granted',
    source: 'client-report',
  });
  const first = await service.deliver({
    idempotencyKey: 'ra-1',
    player: 'p-1',
    topic: 'friend-challenge',
    provider: 'platform',
  });
  assert.deepEqual(first, {
    status: 'deferred',
    reason: 'provider-rate-limited',
    until: '2026-10-19T03:00:01Z',
  });
  time.advance(1);
  const [second] = (await service.dispatchDue()).results;
  assert.deepEqual(second?.outcome, {
    status: 'deferred',
    reason: 'provider-rate-limited',
    until: '2026-10-19T04:00:01Z',
  });
  // A game records a notice it showed, never a push.
  await expectCode(
    service.recordNoticeShown(
      session('p-1'),
      {
        kind: 'consent-result',
        record: { kind: 'advertising', at: '2026-10-19T03:00:00Z' },
        dueBy: '2026-11-02',
      },
      { channel: 'push' as never },
    ),
    'NOTIFICATIONS_INVALID_INPUT',
  );
}

// Failures in a replay: a released row backs off, a failing send is counted, history never forces a replay.
{
  const time = clock('2026-10-19T03:00:00Z');
  let readFails = 0;
  let historyFails = 0;
  const platform = fakeProvider('platform', [{ status: 'rate-limited', retryAfterSeconds: 60 }]);
  const inner = createInMemoryNotificationStore();
  const store: NotificationStore = {
    ...inner,
    async addHistory(entry) {
      if (historyFails > 0) {
        historyFails -= 1;
        throw new Error('history down');
      }
      return inner.addHistory(entry);
    },
  };
  const errors: string[] = [];
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      {
        entry: {
          ...platformEntry,
          permission: { ...platformEntry.permission, serverReadable: true },
        },
        delivery: {
          id: 'platform',
          send: (request) => platform.send(request),
          async readPermission() {
            if (readFails > 0) {
              readFails -= 1;
              throw new Error('host down');
            }
            return 'granted';
          },
        },
        targets: ['web'],
      },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    resolvePlatformRecipient: () => 'u-1',
    now: time.now,
    random: () => 0,
    onError: (_error, context) => {
      errors.push(`${context.operation}:${context.provider ?? ''}:${context.rowKey ?? ''}`);
    },
  });
  // Rate-limited first: the row waits 60 s; nothing was sent, so no replay window starts.
  assert.equal(
    (await service.deliver({ idempotencyKey: 'rf-1', player: 'p-1', topic: 'friend-challenge' })).status,
    'deferred',
  );
  const firstAttempt = inner.inspect().sends[0]?.rows[0]?.firstAttemptedAt;
  assert.equal(firstAttempt, undefined);
  // The replay's host read fails: the send counts as failed, the row is put back for a minute.
  time.advance(60);
  readFails = 1;
  assert.deepEqual(await service.dispatchDue(), {
    results: [],
    failed: 1,
  });
  assert.deepEqual(errors, ['dispatchDue::']);
  time.advance(30);
  assert.deepEqual(await service.dispatchDue(), { results: [], failed: 0 });
  time.advance(31);
  // The history write fails three times; the delivery still settles, once.
  historyFails = 3;
  const [delivered] = (await service.dispatchDue()).results;
  assert.deepEqual(delivered?.outcome, { status: 'delivered', alreadyProcessed: false });
  assert.equal(errors.filter((entry) => entry.startsWith('history.add')).length, 1);
  time.advance(600);
  assert.deepEqual(await service.dispatchDue(), { results: [], failed: 0 });
  assert.equal(platform.calls.length, 2);
  // A queue job for a long installation id is still a valid job.
  await service.dispatch({
    sendKey: 'rf-1',
    provider: 'platform',
    rowKey: `rf-1:${'%E4%B8%AD'.repeat(2048)}`,
  });
}

// The replay window starts at the first ambiguous call and survives a rate-limit deferral.
{
  const time = clock('2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm', [
    { status: 'ambiguous' },
    { status: 'rate-limited', retryAfterSeconds: 60 },
    { status: 'ambiguous' },
  ]);
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['vector'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    now: time.now,
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  await service.deliver({ idempotencyKey: 'w-1', player: 'p-1', topic: 'friend-challenge' });
  const first = store.inspect().sends[0]?.rows[0]?.firstAttemptedAt;
  assert.equal(first, '2026-10-19T03:00:00Z');
  time.advance(300);
  await service.dispatchDue();
  assert.equal(store.inspect().sends[0]?.rows[0]?.state.status, 'deferred');
  time.advance(60);
  await service.dispatchDue();
  assert.equal(store.inspect().sends[0]?.rows[0]?.firstAttemptedAt, first);
}

// Only a configuration rejection is reported; a player's refusal is not an alert.
{
  const fcm = fakeProvider('fcm', [
    { status: 'rejected', reason: 'configuration', providerCode: 'SENDER_ID_MISMATCH' },
    { status: 'rejected', reason: 'recipient' },
    { status: 'rejected', reason: 'agreement' },
  ]);
  const reports: string[] = [];
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: fcmEntry, delivery: fcm, targets: ['vector'] },
    ]),
    catalog: vectorCatalog([{ ...serviceTopic, copy: { ko: { title: 'T', body: 'B' } } }]),
    now: () => '2026-10-19T03:00:00Z',
    onError: (_error, context) => {
      reports.push(context.operation);
    },
  });
  await service.registerEndpoint(session('p-1'), {
    registration: {
      provider: 'fcm',
      address: { kind: 'fcm-token', value: 'tok', permission: 'granted' },
    },
  });
  for (const key of ['rj-1', 'rj-2', 'rj-3']) {
    assert.deepEqual(
      await service.deliver({ idempotencyKey: key, player: 'p-1', topic: 'friend-challenge' }),
      { status: 'unavailable', reason: 'provider-rejected' },
    );
  }
  assert.deepEqual(reports, ['provider.rejected']);
  assert.deepEqual(
    store.inspect().consent.map((record) => [record.kind, record.state, record.source]),
    [['host-agreement', 'denied', 'provider']],
  );
}

// A null channel is a wrong type, not the default.
{
  const service = createNotificationService({
    store: createInMemoryNotificationStore(),
    registry: createNotificationProviderRegistry([]),
    catalog: vectorCatalog([]),
    now: () => '2026-10-19T03:00:00Z',
  });
  await expectCode(
    service.recordNoticeShown(
      session('p-1'),
      {
        kind: 'consent-result',
        record: { kind: 'advertising', at: '2026-10-19T03:00:00Z' },
        dueBy: '2026-11-02',
      },
      { channel: null as never },
    ),
    'NOTIFICATIONS_INVALID_INPUT',
  );
}

console.info('Notifications service unit tests passed.');

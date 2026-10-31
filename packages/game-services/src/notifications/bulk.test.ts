import assert from 'node:assert/strict';

import type {
  NotificationDeliveryProviderEntry,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import {
  createNotificationBatchBarrier,
  isInsideNotificationHoldWindow,
  notificationBulkRecipientKey,
  type NotificationBulkDeliveryResult,
} from './bulk.js';
import type {
  NotificationRemoteBulkCapability,
  NotificationRemoteDeliveryAnswer,
  NotificationRemoteDeliveryProvider,
  NotificationRemoteDeliveryRequest,
} from './delivery-provider.js';
import { createNotificationProviderRegistry } from './registry.js';
import { createNotificationService } from './service.js';
import { createInMemoryNotificationStore, type InMemoryNotificationStore } from './store.js';

/**
 * Bulk sends (RFC open question 5, BK1) against fakes: every gate step runs
 * per recipient, each recipient keeps its own key and answer, the service
 * chunks by the provider's limits, and a retry sends only the rest.
 */

const entry: NotificationDeliveryProviderEntry = {
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

const topic: NotificationTopicDeclaration = {
  id: 'live-event',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=event',
  copy: {
    ko: { title: '공지', body: '{{event}}이 시작됐어요.' },
    en: { title: 'News', body: '{{event}} started.' },
  },
};

function clock(start: string) {
  let at = Date.parse(start);
  return {
    now: () => new Date(at).toISOString(),
    advance(seconds: number) {
      at += seconds * 1000;
    },
  };
}

type BatchAnswers = (requests: readonly NotificationRemoteDeliveryRequest[]) => readonly unknown[] | Promise<readonly unknown[]>;

function bulkProvider(
  capability: NotificationRemoteBulkCapability | undefined,
  answers: BatchAnswers = (requests) => requests.map(() => ({ status: 'accepted' })),
) {
  const batches: (readonly NotificationRemoteDeliveryRequest[])[] = [];
  const singles: NotificationRemoteDeliveryRequest[] = [];
  const provider: NotificationRemoteDeliveryProvider = {
    id: 'platform',
    async send(request) {
      singles.push(request);
      return { status: 'accepted' };
    },
    ...(capability === undefined
      ? {}
      : {
          bulk: capability,
          async sendBatch(requests: readonly NotificationRemoteDeliveryRequest[]) {
            batches.push(requests);
            return (await answers(requests)) as readonly NotificationRemoteDeliveryAnswer[];
          },
        }),
  };
  return { provider, batches, singles };
}

async function setup(options: {
  readonly provider: NotificationRemoteDeliveryProvider;
  readonly entry?: NotificationDeliveryProviderEntry;
  readonly start?: string;
  readonly players?: readonly string[];
  readonly elapsedMs?: () => number;
  readonly resolve?: (player: string, time: ReturnType<typeof clock>) => Promise<string>;
  readonly topic?: NotificationTopicDeclaration;
}) {
  const time = clock(options.start ?? '2026-11-01T03:00:00Z');
  const store = createInMemoryNotificationStore();
  const reports: string[] = [];
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: options.entry ?? entry, delivery: options.provider, targets: ['platform-target'] },
    ]),
    catalog: { defaultLocale: 'ko', topicsFor: () => [options.topic ?? topic] },
    resolvePlatformRecipient: ({ player }) =>
      options.resolve === undefined ? `u-${player}` : options.resolve(player, time),
    now: time.now,
    ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
    onError: (error, context) => {
      reports.push(
        `${context.operation}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  for (const player of options.players ?? []) {
    await grant(store, player, time.now());
  }
  return { service, store, time, reports };
}

async function grant(store: InMemoryNotificationStore, player: string, at: string): Promise<void> {
  await store.appendConsent({
    player,
    record: { kind: 'delivery-permission', state: 'granted', source: 'client-report' },
    at,
  });
}

const players = (count: number, prefix = 'p'): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const bulkInput = (key: string, recipients: readonly string[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: key,
  provider: 'platform',
  topic: 'live-event',
  templateData: { event: 'Halloween' },
  recipients: recipients.map((player) => ({ player })),
  ...extra,
});

const statuses = (result: NotificationBulkDeliveryResult) =>
  result.recipients.map((recipient) => {
    if (recipient.status === 'answered') {
      const { outcome } = recipient;
      return [recipient.player, outcome.status, 'reason' in outcome ? outcome.reason : undefined];
    }
    return [
      recipient.player,
      recipient.status,
      recipient.status === 'not-attempted' ? recipient.reason : recipient.error.code,
    ];
  });

// Each gate step runs per recipient: refused recipients never reach the provider.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { service, store, time } = await setup({
    provider: fake.provider,
    players: ['p1', 'p3', 'p4', 'p5'],
  });
  // p2 never granted delivery permission; p4 turned the topic off; p5 reads English.
  await store.appendConsent({
    player: 'p4',
    record: { kind: 'topic-preference', topic: 'live-event', state: 'withdrawn', source: 'player' },
    at: time.now(),
  });
  await store.putPlatformRegistration({
    player: 'p5',
    provider: 'platform',
    locale: 'en',
    registeredAt: time.now(),
  });
  const result = await service.deliverBulk(bulkInput('event-1', players(5)));
  assert.deepEqual(statuses(result), [
    ['p1', 'delivered', undefined],
    ['p2', 'suppressed', 'permission-denied'],
    ['p3', 'delivered', undefined],
    ['p4', 'suppressed', 'preference-off'],
    ['p5', 'delivered', undefined],
  ]);
  assert.equal(fake.batches.length, 1, 'one provider call for the allowed recipients');
  assert.deepEqual(
    fake.batches[0]?.map((request) => [
      request.idempotencyKey,
      request.recipient,
      request.content.body,
    ]),
    [
      ['event-1:p1', { kind: 'platform-user', id: 'u-p1' }, 'Halloween이 시작됐어요.'],
      ['event-1:p3', { kind: 'platform-user', id: 'u-p3' }, 'Halloween이 시작됐어요.'],
      ['event-1:p5', { kind: 'platform-user', id: 'u-p5' }, 'Halloween started.'],
    ],
  );
  assert.deepEqual(result.summary, {
    delivered: 3,
    alreadyProcessed: 0,
    deferred: 0,
    inFlight: 0,
    suppressed: 2,
    unavailable: 0,
    notAttempted: 0,
    failed: 0,
  });
  assert.deepEqual(result.providerCalls, { batch: 1, single: 0 });
  assert.equal(notificationBulkRecipientKey('event-1', 'a:b c'), 'event-1:a%3Ab%20c');
  // Each recipient is an ordinary send: `deliver` with its key answers it.
  assert.deepEqual(
    await service.deliver({
      idempotencyKey: 'event-1:p1',
      player: 'p1',
      provider: 'platform',
      topic: 'live-event',
      templateData: { event: 'Halloween' },
    }),
    { status: 'delivered', alreadyProcessed: true },
  );
}

// A partial provider failure maps per recipient; an unattributed answer is never replayed.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true }, () => [
    { status: 'accepted' },
    { status: 'rate-limited', retryAfterSeconds: 120 },
    { status: 'rejected', reason: 'recipient' },
    { status: 'ambiguous' },
    { status: 'ambiguous', providerCode: 'PARTIAL', unattributed: true },
  ]);
  const { service, time, reports } = await setup({ provider: fake.provider, players: players(5) });
  const result = await service.deliverBulk(bulkInput('event-2', players(5)));
  assert.deepEqual(statuses(result), [
    ['p1', 'delivered', undefined],
    ['p2', 'deferred', 'provider-rate-limited'],
    ['p3', 'unavailable', 'provider-rejected'],
    ['p4', 'in-flight', undefined],
    ['p5', 'in-flight', undefined],
  ]);
  assert.ok(
    reports.some(
      (report) => report.startsWith('dispatch.unattributed: ') && report.includes('PARTIAL'),
    ),
  );
  // The scheduler replays the rate-limited and the ambiguous recipients one by one, never the unattributed one.
  for (let step = 0; step < 30; step += 1) {
    time.advance(3_600);
    await service.dispatchDue();
  }
  assert.deepEqual([...new Set(fake.singles.map((request) => request.idempotencyKey))].sort(), [
    'event-2:p2',
    'event-2:p4',
  ]);
  // A retry of the call answers the unattributed recipient from the ledger and sends nothing to it.
  const retried = await service.deliverBulk(bulkInput('event-2', ['p5']));
  assert.deepEqual(statuses(retried), [['p5', 'in-flight', undefined]]);
  assert.equal(fake.batches.length, 1);
}

// A retry skips recipients already accepted and sends only the rest.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { service } = await setup({ provider: fake.provider, players: players(4) });
  const first = await service.deliverBulk(bulkInput('event-3', players(4)), { maxRecipients: 2 });
  assert.deepEqual(statuses(first), [
    ['p1', 'delivered', undefined],
    ['p2', 'delivered', undefined],
    ['p3', 'not-attempted', 'count-budget'],
    ['p4', 'not-attempted', 'count-budget'],
  ]);
  // Recipients answered from the ledger cost none of the call's budget.
  const second = await service.deliverBulk(bulkInput('event-3', players(4)), { maxRecipients: 2 });
  assert.deepEqual(second.summary.alreadyProcessed, 2);
  assert.deepEqual(second.summary.delivered, 2);
  assert.deepEqual(
    fake.batches.map((batch) => batch.map((request) => request.idempotencyKey)),
    [
      ['event-3:p1', 'event-3:p2'],
      ['event-3:p3', 'event-3:p4'],
    ],
    'nobody is sent twice',
  );
  // Another request under a recipient's key is a conflict for that recipient alone.
  const conflict = await service.deliverBulk({
    ...bulkInput('event-3', ['p1', 'p9']),
    templateData: { event: 'Other' },
  });
  assert.deepEqual(statuses(conflict), [
    ['p1', 'failed', 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT'],
    ['p9', 'suppressed', 'permission-denied'],
  ]);
}

// A batch call that throws leaves its recipients in flight: a retry inside the lease sends nothing.
{
  let throwing = true;
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true }, (requests) => {
    if (throwing) {
      throw new Error('socket hang up');
    }
    return requests.map(() => ({ status: 'accepted' }));
  });
  const { service, time } = await setup({ provider: fake.provider, players: players(3) });
  const first = await service.deliverBulk(bulkInput('event-4', players(3)));
  assert.deepEqual(first.summary.inFlight, 3);
  throwing = false;
  const inside = await service.deliverBulk(bulkInput('event-4', players(3)));
  assert.deepEqual(inside.summary.inFlight, 3);
  assert.equal(fake.batches.length, 1);
  // After the lease the same call replays them, as `deliver` replays its own platform rows.
  time.advance(301);
  const after = await service.deliverBulk(bulkInput('event-4', players(3)));
  assert.deepEqual(after.summary.delivered, 3);
  assert.equal(fake.batches.length, 2);
  // An answer list of the wrong length is ambiguous for every request of the batch.
  const short = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true }, () => [
    { status: 'accepted' },
  ]);
  const shortSetup = await setup({ provider: short.provider, players: players(2) });
  const shortResult = await shortSetup.service.deliverBulk(bulkInput('event-5', players(2)));
  assert.deepEqual(shortResult.summary.inFlight, 2);
  assert.ok(shortSetup.reports.some((report) => report.includes('1 answers for a batch of 2')));
}

// Chunking at the provider's limits; a remainder under the minimum goes one by one.
{
  const fake = bulkProvider({ maxRecipients: 3, minRecipients: 2, perRecipientOutcomes: true });
  const { service } = await setup({ provider: fake.provider, players: players(7) });
  const result = await service.deliverBulk(bulkInput('event-6', players(7)));
  assert.deepEqual(
    fake.batches.map((batch) => batch.length),
    [3, 3],
  );
  assert.deepEqual(
    fake.singles.map((request) => request.idempotencyKey),
    ['event-6:p7'],
  );
  assert.deepEqual(result.providerCalls, { batch: 2, single: 1 });
  assert.equal(result.summary.delivered, 7);
  // A smaller batch size than the provider's maximum.
  const small = bulkProvider({ maxRecipients: 3, minRecipients: 2, perRecipientOutcomes: true });
  const smallSetup = await setup({ provider: small.provider, players: players(4) });
  await smallSetup.service.deliverBulk(bulkInput('event-7', players(4), { batchSize: 2 }));
  assert.deepEqual(
    small.batches.map((batch) => batch.length),
    [2, 2],
  );
}

// The minimum-size fallback (Apps in Toss: 50) and the provider's hold window.
{
  const capability: NotificationRemoteBulkCapability = {
    maxRecipients: 2_500,
    minRecipients: 50,
    perRecipientOutcomes: false,
    holdWindow: { start: '21:00', end: '08:00', timeZone: 'Asia/Seoul' },
  };
  const under = bulkProvider(capability);
  const underSetup = await setup({ provider: under.provider, players: players(49) });
  const underResult = await underSetup.service.deliverBulk(bulkInput('event-8', players(49)));
  assert.deepEqual([under.batches.length, under.singles.length], [0, 49]);
  assert.deepEqual(underResult.providerCalls, { batch: 0, single: 49 });
  const at = bulkProvider(capability);
  const atSetup = await setup({ provider: at.provider, players: players(50) });
  await atSetup.service.deliverBulk(bulkInput('event-9', players(50)));
  assert.deepEqual([at.batches.map((batch) => batch.length), at.singles.length], [[50], 0]);
  // 22:00 in Seoul: the host would hold a bulk call until 08:00, so the gate's timing stands one by one.
  const night = bulkProvider(capability);
  const nightSetup = await setup({
    provider: night.provider,
    players: players(50),
    start: '2026-11-01T13:00:00Z',
  });
  await nightSetup.service.deliverBulk(bulkInput('event-10', players(50)));
  assert.deepEqual([night.batches.length, night.singles.length], [0, 50]);
  assert.equal(
    isInsideNotificationHoldWindow(capability.holdWindow, Date.parse('2026-11-01T22:59:00Z')),
    true,
  );
  assert.equal(
    isInsideNotificationHoldWindow(capability.holdWindow, Date.parse('2026-11-01T23:00:00Z')),
    false,
  );
  assert.equal(
    isInsideNotificationHoldWindow(capability.holdWindow, Date.parse('2026-11-01T12:00:00Z')),
    true,
  );
  assert.equal(
    isInsideNotificationHoldWindow(capability.holdWindow, Date.parse('2026-11-01T11:59:00Z')),
    false,
  );
}

// A provider without a bulk path sends one recipient per call through the same gate and ledger.
{
  const fake = bulkProvider(undefined);
  const { service } = await setup({ provider: fake.provider, players: players(3) });
  const result = await service.deliverBulk(bulkInput('event-11', players(4)));
  assert.deepEqual(result.providerCalls, { batch: 0, single: 3 });
  assert.deepEqual(
    statuses(result).map((row) => row[1]),
    ['delivered', 'delivered', 'delivered', 'suppressed'],
  );
}

// The provider's app-wide rate caps what one call attempts; the excess is reported and retried later.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { service, time } = await setup({
    provider: fake.provider,
    entry: { ...entry, rate: { count: 3, windowSeconds: 3_600 } },
    players: players(5),
  });
  const first = await service.deliverBulk(bulkInput('event-12', players(5)));
  assert.deepEqual(statuses(first).slice(3), [
    ['p4', 'not-attempted', 'provider-rate'],
    ['p5', 'not-attempted', 'provider-rate'],
  ]);
  assert.equal(first.summary.delivered, 3);
  // Nothing was stored for them: the same call after the window sends them.
  time.advance(3_600);
  const second = await service.deliverBulk(bulkInput('event-12', players(5)));
  assert.deepEqual([second.summary.alreadyProcessed, second.summary.delivered], [3, 2]);
}

// A time budget stops starting batches; the rest answer not-attempted.
{
  let elapsed = 0;
  const fake = bulkProvider({ maxRecipients: 2, perRecipientOutcomes: true }, (requests) => {
    elapsed += 1_000;
    return requests.map(() => ({ status: 'accepted' }));
  });
  const { service } = await setup({
    provider: fake.provider,
    players: players(5),
    elapsedMs: () => elapsed,
  });
  const result = await service.deliverBulk(bulkInput('event-13', players(5)), { budgetMs: 1_500 });
  assert.deepEqual(
    statuses(result).map((row) => row[2] ?? row[1]),
    ['delivered', 'delivered', 'delivered', 'delivered', 'time-budget'],
  );
}

// The read budget bounds the keys one call looks up, in request order.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { service } = await setup({ provider: fake.provider, players: players(4) });
  const result = await service.deliverBulk(bulkInput('event-14', players(4)), { maxLookups: 2 });
  assert.deepEqual(
    statuses(result).map((row) => row[2] ?? row[1]),
    ['delivered', 'delivered', 'count-budget', 'count-budget'],
  );
}

// A recipient whose claim may run out before the batch's call answers is not sent with it.
{
  const fake = bulkProvider({ maxRecipients: 10, minRecipients: 2, perRecipientOutcomes: true });
  let p3Reads = 0;
  const { service, time, reports } = await setup({
    provider: fake.provider,
    players: players(3),
    resolve: async (player, clockNow) => {
      if (player === 'p3' && (p3Reads += 1) === 2) {
        // Every row is claimed; p3's gate is slow and ends 200 s later (the lease is 300 s).
        await new Promise((resolve) => setTimeout(resolve, 50));
        clockNow.advance(200);
      }
      return `u-${player}`;
    },
  });
  const result = await service.deliverBulk(bulkInput('event-15', players(3)));
  assert.deepEqual(
    statuses(result).map((row) => row[2]),
    ['provider-rate-limited', 'provider-rate-limited', 'provider-rate-limited'],
  );
  assert.deepEqual([fake.batches.length, fake.singles.length], [0, 0]);
  assert.equal(reports.filter((report) => report.startsWith('dispatch.stale: ')).length, 3);
  // Nothing was sent, so the scheduler sends them once they are due.
  time.advance(120);
  await service.dispatchDue();
  assert.deepEqual(fake.singles.map((request) => request.idempotencyKey).sort(), [
    'event-15:p1',
    'event-15:p2',
    'event-15:p3',
  ]);
}

// The gate runs again when the batch is sent: quiet hours that began while it gathered hold every recipient.
{
  const fake = bulkProvider({ maxRecipients: 10, minRecipients: 2, perRecipientOutcomes: true });
  let p3Reads = 0;
  const { service, store, time, reports } = await setup({
    provider: fake.provider,
    players: players(3),
    topic: { ...topic, quietHours: { start: '03:01', end: '04:00' } },
    resolve: async (player, clockNow) => {
      if (player === 'p3' && (p3Reads += 1) === 2) {
        // p1 and p2 were allowed at 03:00:00 and wait; p3's gate ends at 03:01, inside the quiet hours.
        await new Promise((resolve) => setTimeout(resolve, 50));
        clockNow.advance(60);
      }
      return `u-${player}`;
    },
  });
  for (const player of players(3)) {
    await store.putPlatformRegistration({
      player,
      provider: 'platform',
      timeZone: 'UTC',
      registeredAt: time.now(),
    });
  }
  const result = await service.deliverBulk(bulkInput('event-18', players(3)));
  assert.deepEqual(statuses(result), [
    ['p1', 'deferred', 'provider-rate-limited'],
    ['p2', 'deferred', 'provider-rate-limited'],
    ['p3', 'deferred', 'quiet-hours'],
  ]);
  assert.deepEqual([fake.batches.length, fake.singles.length], [0, 0]);
  assert.equal(
    reports.filter((report) => report.includes('no longer allowed by the gate')).length,
    2,
  );
}

// One provider call per call group, each just after its own gate check: a window that opens between them holds the later group.
{
  const fake = bulkProvider(
    { maxRecipients: 10, minRecipients: 2, perRecipientOutcomes: true, callKey: (request) => request.content.body ?? '' },
    (requests) => {
      // The first group's call takes a minute, into the quiet hours.
      groupClock.current?.advance(60);
      return requests.map(() => ({ status: 'accepted' }));
    },
  );
  const groupClock: { current?: ReturnType<typeof clock> } = {};
  const { service, store, time } = await setup({
    provider: fake.provider,
    players: players(4),
    topic: { ...topic, quietHours: { start: '03:01', end: '04:00' } },
  });
  groupClock.current = time;
  for (const [player, locale] of [
    ['p1', 'ko'],
    ['p2', 'en'],
    ['p3', 'ko'],
    ['p4', 'en'],
  ] as const) {
    await store.putPlatformRegistration({
      player,
      provider: 'platform',
      locale,
      timeZone: 'UTC',
      registeredAt: time.now(),
    });
  }
  const result = await service.deliverBulk(bulkInput('event-19', players(4)));
  assert.deepEqual(
    fake.batches.map((batch) => batch.map((request) => request.idempotencyKey)),
    [['event-19:p1', 'event-19:p3']],
  );
  assert.deepEqual(
    statuses(result).map((row) => row[2] ?? row[1]),
    ['delivered', 'provider-rate-limited', 'delivered', 'provider-rate-limited'],
  );
}

// A device provider's deliveries count each device against the call's attempts.
{
  const fcmLike: NotificationDeliveryProviderEntry = {
    ...entry,
    provider: 'devices',
    addressing: 'device',
  };
  const sent: string[] = [];
  const provider: NotificationRemoteDeliveryProvider = {
    id: 'devices',
    async send(request) {
      sent.push(request.idempotencyKey);
      return { status: 'accepted' };
    },
  };
  const store = createInMemoryNotificationStore();
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: fcmLike, delivery: provider, targets: ['device-target'] },
    ]),
    catalog: { defaultLocale: 'ko', topicsFor: () => [topic] },
    now: () => '2026-11-01T03:00:00Z',
  });
  for (const [player, installations] of [
    ['p1', ['i1', 'i2', 'i3']],
    ['p2', ['i4']],
  ] as const) {
    for (const installationId of installations) {
      await service.registerEndpoint(
        { player, sessionId: `s-${installationId}`, installationId },
        {
          registration: {
            provider: 'devices',
            address: { kind: 'fcm-token', value: `tok-${installationId}`, permission: 'granted' },
          },
        },
      );
    }
  }
  const result = await service.deliverBulk(
    { ...bulkInput('event-16', ['p1', 'p2']), provider: 'devices', batchSize: 1 },
    { maxRecipients: 2 },
  );
  assert.deepEqual(
    statuses(result).map((row) => row[2] ?? row[1]),
    ['delivered', 'count-budget'],
  );
  // p1's third device waits for the scheduler; p2 is not attempted.
  assert.deepEqual(sent.sort(), ['event-16:p1:i1', 'event-16:p1:i2']);

  // Each device takes one of the provider's rate: a device over it stays queued for the scheduler's pace.
  const paced = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      {
        entry: { ...fcmLike, rate: { count: 2, windowSeconds: 3_600 } },
        delivery: provider,
        targets: ['device-target'],
      },
    ]),
    catalog: { defaultLocale: 'ko', topicsFor: () => [topic] },
    now: () => '2026-11-01T05:00:00Z',
  });
  sent.length = 0;
  const pacedResult = await paced.deliverBulk({
    ...bulkInput('event-17', ['p1']),
    provider: 'devices',
  });
  assert.deepEqual(statuses(pacedResult), [['p1', 'delivered', undefined]]);
  assert.equal(sent.length, 2, 'the third device waits for the pace');
}

// Malformed bulk sends fail as a whole; the registry checks each bulk capability once.
{
  const fake = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { service } = await setup({ provider: fake.provider });
  for (const [input, pattern] of [
    [bulkInput('event-x', ['p1', 'p1']), /a player is named once/u],
    [bulkInput('reminder:x', ['p1']), /reserved for the scheduler/u],
    [bulkInput('event-x', []), /expected 1 to 10000 recipients/u],
    [{ ...bulkInput('event-x', ['p1']), provider: 'fcm' }, /no notifications provider fcm/u],
    [{ ...bulkInput('event-x', ['p1']), extra: true }, /extra: not a bulk send field/u],
    [{ ...bulkInput('event-x', ['p1']), batchSize: 0 }, /batchSize/u],
  ] as const) {
    await assert.rejects(service.deliverBulk(input), (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, 'NOTIFICATIONS_INVALID_INPUT');
      assert.match((error as Error).message, pattern);
      return true;
    });
  }
  const { provider } = bulkProvider({ maxRecipients: 10, perRecipientOutcomes: true });
  const { sendBatch: _sendBatch, ...withoutBatch } = provider;
  for (const [delivery, pattern] of [
    [withoutBatch, /bulk capability and sendBatch together/u],
    [
      { ...provider, bulk: { maxRecipients: 0, perRecipientOutcomes: true } },
      /maxRecipients must be a positive integer/u,
    ],
    [
      { ...provider, bulk: { maxRecipients: 5, minRecipients: 6, perRecipientOutcomes: true } },
      /minRecipients/u,
    ],
    [
      {
        ...provider,
        bulk: {
          maxRecipients: 5,
          perRecipientOutcomes: true,
          holdWindow: { start: '25:00', end: '08:00', timeZone: 'Asia/Seoul' },
        },
      },
      /holdWindow/u,
    ],
  ] as const) {
    assert.throws(
      () => createNotificationProviderRegistry([{ entry, delivery, targets: ['platform-target'] }]),
      pattern,
    );
  }
}

// The batch barrier flushes once every participant arrived or left.
{
  const flushed: number[][] = [];
  const barrier = createNotificationBatchBarrier<number, string>(3, async (items) => {
    flushed.push([...items]);
    return items.map((item) => `answer-${item}`);
  });
  const first = barrier.arrive(1);
  barrier.leave();
  assert.deepEqual(flushed, []);
  const second = barrier.arrive(2);
  assert.deepEqual(await Promise.all([first, second]), ['answer-1', 'answer-2']);
  assert.deepEqual(flushed, [[1, 2]]);
}

console.info('Notifications bulk send tests passed.');

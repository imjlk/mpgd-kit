import type {
  NotificationEndpointWrite,
  NotificationStore,
  NotificationStoredSend,
} from './store.js';

/**
 * The behavior every `NotificationStore` must have, run against a fresh
 * store: the atomic steps the service relies on (consent dating, endpoint
 * address uniqueness and dead addresses, versioned compare-and-set on sends,
 * idempotent notices and history) and the purge cutoffs. A durable store
 * (the Worker's D1 store, a Redis store) runs it in its own tests. Throws on
 * the first difference.
 */
export async function runNotificationStoreConformance(
  createStore: () => NotificationStore | Promise<NotificationStore>,
): Promise<void> {
  const store = await createStore();
  const at = (offsetMs: number): string => new Date(Date.parse('2026-10-19T03:00:00Z') + offsetMs)
    .toISOString()
    .replace('.000Z', 'Z');

  // Consent: dated at least 1 ms after the player's previous record, per player.
  const first = await store.appendConsent({
    player: 'p-1',
    record: { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v1' },
    at: at(0),
  });
  const second = await store.appendConsent({
    player: 'p-1',
    record: { kind: 'night', state: 'granted', source: 'player', textVersion: 'v1' },
    at: at(0),
  });
  const earlier = await store.appendConsent({
    player: 'p-1',
    record: { kind: 'topic-preference', topic: 'energy-full', state: 'granted', source: 'player' },
    at: at(-60_000),
  });
  const other = await store.appendConsent({
    player: 'p-2',
    record: {
      kind: 'host-agreement',
      topic: 'energy-full',
      state: 'denied',
      source: 'provider',
      evidence: { schema: 'fixture.host-agreement.v1', payload: { code: 'x' } },
    } as never,
    at: at(0),
  });
  equal(first.at, at(0), 'consent: the first record keeps the backend time');
  equal(second.at, at(1), 'consent: a second record in the same millisecond is 1 ms later');
  equal(earlier.at, at(2), 'consent: a record dated before the latest moves after it');
  equal(other.at, at(0), 'consent: another player has its own sequence');
  deepEqual(
    (await store.listConsent('p-1')).map((record) => [record.kind, record.at]),
    [
      ['advertising', at(0)],
      ['night', at(1)],
      ['topic-preference', at(2)],
    ],
    'consent: listed oldest first',
  );
  deepEqual(await store.listConsent('p-2'), [other], 'consent: evidence round-trips');

  // Endpoints.
  const endpoint = (installationId: string, value: string, extra: Partial<NotificationEndpointWrite> = {}): NotificationEndpointWrite => ({
    provider: 'fcm',
    installationId,
    player: 'p-1',
    address: { kind: 'fcm-token', value },
    permission: 'granted',
    sessionId: `session-${installationId}`,
    lastRegisteredAt: at(0),
    ...extra,
  });
  const stored = await store.putEndpoint(
    endpoint('i-1', 'tok-1', {
      locale: 'ko-KR',
      timeZone: 'Asia/Seoul',
      target: 'android',
      sessionExpiresAt: at(86_400_000),
      address: { kind: 'fcm-token', value: 'tok-1', environment: 'production' },
    }),
  );
  equal(stored.status, 'valid', 'endpoints: a new endpoint is valid');
  deepEqual(
    await store.getEndpoint({ provider: 'fcm', installationId: 'i-1' }),
    stored,
    'endpoints: read back as written',
  );
  // The same address on another installation moves there.
  await store.putEndpoint(endpoint('i-2', 'tok-1'));
  equal(
    await store.getEndpoint({ provider: 'fcm', installationId: 'i-1' }),
    undefined,
    'endpoints: an address is unique per provider',
  );
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'i-2',
    value: 'tok-other',
    at: at(5),
  });
  equal(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'i-2' }))?.status,
    'valid',
    'endpoints: invalidation names the address',
  );
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'i-2',
    value: 'tok-1',
    at: at(5),
  });
  const dead = await store.getEndpoint({ provider: 'fcm', installationId: 'i-2' });
  equal(dead?.status, 'invalid', 'endpoints: a dead address is invalid');
  equal(dead?.invalidatedAt, at(5), 'endpoints: the invalidation time is kept');
  equal(
    (await store.putEndpoint(endpoint('i-2', 'tok-1', { lastRegisteredAt: at(10) }))).status,
    'invalid',
    'endpoints: a dead address stays dead',
  );
  equal(
    (await store.putEndpoint(endpoint('i-2', 'tok-2'))).status,
    'valid',
    'endpoints: a new address revives the endpoint',
  );
  await store.putEndpoint(endpoint('i-3', 'tok-3', { player: 'p-2', sessionId: 'shared' }));
  await store.putEndpoint({
    ...endpoint('i-4', 'tok-4', { sessionId: 'shared' }),
    provider: 'other',
  });
  deepEqual(
    (await store.listEndpoints({ player: 'p-1', provider: 'fcm' })).map((row) => row.installationId),
    ['i-2'],
    'endpoints: listed per player and provider',
  );
  await store.removeEndpoints({ installationId: 'i-3', player: 'p-1' });
  equal(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'i-3' }))?.player,
    'p-2',
    'endpoints: an unbind names the player',
  );
  equal(
    await store.removeSessionEndpoints({ sessionId: 'shared' }),
    2,
    'endpoints: the session end unbinds what it registered',
  );
  await store.removeEndpoints({ installationId: 'i-2', player: 'p-1', provider: 'fcm' });
  deepEqual(
    await store.listEndpoints({ player: 'p-1', provider: 'fcm' }),
    [],
    'endpoints: unbound',
  );

  // Platform registrations.
  await store.putPlatformRegistration({
    player: 'p-1',
    provider: 'ait',
    locale: 'ko',
    registeredAt: at(0),
  });
  await store.putPlatformRegistration({
    player: 'p-1',
    provider: 'ait',
    timeZone: 'Asia/Seoul',
    registeredAt: at(1),
  });
  deepEqual(
    await store.getPlatformRegistration({ player: 'p-1', provider: 'ait' }),
    { player: 'p-1', provider: 'ait', timeZone: 'Asia/Seoul', registeredAt: at(1) },
    'platform registrations: the latest replaces the earlier',
  );
  equal(
    await store.getPlatformRegistration({ player: 'p-2', provider: 'ait' }),
    undefined,
    'platform registrations: per player',
  );

  // Notices given: idempotent by name, compared as instants.
  const notice = {
    kind: 'consent-result',
    record: { kind: 'advertising', at: at(0) },
    dueBy: '2026-11-02',
    player: 'p-1',
    channel: 'in-game',
    at: at(100),
  } as const;
  await store.addNoticeGiven(notice);
  await store.addNoticeGiven({ ...notice, channel: 'push', at: at(200) });
  deepEqual(await store.listNoticesGiven('p-1'), [notice], 'notices: recorded once');

  // Sends: create once, compare-and-set on the version, delete.
  const send: NotificationStoredSend = {
    key: 'k-1',
    fingerprint: 'f',
    request: { idempotencyKey: 'k-1', player: 'p-1', topic: 'energy-full' },
    origin: { kind: 'send' },
    scheduled: false,
    rows: [
      {
        key: 'k-1:i-1',
        provider: 'fcm',
        installationId: 'i-1',
        state: { status: 'deferred', reason: 'quiet-hours', until: at(60_000) },
      },
    ],
    changedAt: at(0),
  };
  const version = await store.createSend(send);
  ok(typeof version === 'string', 'sends: created');
  equal(await store.createSend(send), undefined, 'sends: a key is created once');
  const held = await store.getSend('k-1');
  deepEqual(held?.send, send, 'sends: read back as written');
  equal(held?.version, version, 'sends: with its version');
  deepEqual(
    await store.listDueSends({ at: at(59_999), limit: 10 }),
    [],
    'sends: not due before until',
  );
  deepEqual(
    await store.listDueSends({ at: at(60_000), limit: 10 }),
    ['k-1'],
    'sends: due at until',
  );
  const inFlight: NotificationStoredSend = {
    ...send,
    rows: [
      {
        key: 'k-1:i-1',
        provider: 'fcm',
        installationId: 'i-1',
        state: { status: 'in-flight', leaseUntil: at(300_000), claim: 'c', attempted: true },
      },
    ],
  };
  ok(
    await store.updateSend({ key: 'k-1', version: version ?? '', send: inFlight }),
    'sends: a write with the version succeeds',
  );
  ok(
    !await store.updateSend({ key: 'k-1', version: version ?? '', send }),
    'sends: a stale version is refused',
  );
  deepEqual(
    (await store.listInFlightSends('p-1')).map((row) => row.key),
    ['k-1'],
    'sends: in-flight by player',
  );
  deepEqual(await store.listInFlightSends('p-2'), [], 'sends: in-flight is per player');
  deepEqual(
    await store.listDueSends({ at: at(300_000), limit: 10 }),
    ['k-1'],
    'sends: a device lease is due when it ends',
  );
  const current = await store.getSend('k-1');
  ok(
    current !== undefined && current.version !== version,
    'sends: every write changes the version',
  );
  ok(
    await store.updateSend({ key: 'k-1', version: current?.version ?? '', send: undefined }),
    'sends: deleted with the version',
  );
  equal(await store.getSend('k-1'), undefined, 'sends: gone');
  ok(
    !await store.updateSend({ key: 'k-1', version: current?.version ?? '', send }),
    'sends: a deleted key is not written back',
  );
  for (const [key, until] of [
    ['k-3', 30],
    ['k-2', 10],
    ['k-4', 20],
  ] as const) {
    await store.createSend({
      ...send,
      key,
      request: { ...send.request, idempotencyKey: key },
      rows: [
        { ...send.rows[0], key: `${key}:i-1`, state: { status: 'deferred', reason: 'quiet-hours', until: at(until) } } as NotificationStoredSend['rows'][number],
      ],
    });
  }
  deepEqual(
    await store.listDueSends({ at: at(100), limit: 2 }),
    ['k-2', 'k-4'],
    'sends: due earliest first, limited',
  );

  // History: one entry per send and provider, read from a time on.
  await store.addHistory({
    sendKey: 'h-1',
    provider: 'fcm',
    player: 'p-1',
    topic: 't',
    at: at(10),
  });
  await store.addHistory({
    sendKey: 'h-1',
    provider: 'fcm',
    player: 'p-1',
    topic: 't',
    at: at(20),
  });
  await store.addHistory({ sendKey: 'h-2', provider: 'fcm', player: 'p-1', topic: 't', at: at(5) });
  await store.addHistory({
    sendKey: 'h-3',
    provider: 'fcm',
    player: 'p-2',
    topic: 't',
    at: at(30),
  });
  deepEqual(
    (await store.listHistory({ player: 'p-1', since: at(0) })).map((entry) => [
      entry.sendKey,
      entry.at,
    ]),
    [
      ['h-2', at(5)],
      ['h-1', at(10)],
    ],
    'history: once per send and provider, oldest first',
  );
  deepEqual(
    (await store.listHistory({ player: 'p-1', since: at(10) })).map((entry) => entry.sendKey),
    ['h-1'],
    'history: since is inclusive',
  );

  // Purge.
  await store.putEndpoint(endpoint('p-invalid', 'tok-p1'));
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'p-invalid',
    value: 'tok-p1',
    at: at(0),
  });
  await store.putEndpoint(endpoint('p-stale', 'tok-p2', { lastRegisteredAt: at(-1) }));
  await store.putEndpoint(endpoint('p-session', 'tok-p3', { sessionExpiresAt: at(-1) }));
  await store.putEndpoint(
    endpoint('p-kept', 'tok-p4', { lastRegisteredAt: at(1), sessionExpiresAt: at(1) }),
  );
  const counts = await store.purge({
    sendsChangedBefore: at(1),
    historyBefore: at(10),
    invalidEndpointsBefore: at(1),
    staleEndpointsBefore: at(0),
    sessionEndpointsBefore: at(0),
  });
  deepEqual(counts, { sends: 3, history: 1, endpoints: 3 }, 'purge: counts what it deleted');
  deepEqual(
    (await store.listEndpoints({ player: 'p-1', provider: 'fcm' })).map((row) => row.installationId),
    ['p-kept'],
    'purge: keeps endpoints inside every cutoff',
  );
  deepEqual(
    (await store.listHistory({ player: 'p-1', since: at(0) })).map((entry) => entry.sendKey),
    ['h-1'],
    'purge: history from the cutoff on is kept',
  );
}

function fail(message: string, actual: unknown, expected: unknown): never {
  throw new Error(
    `Notification store conformance: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
  );
}

function ok(value: boolean, message: string): void {
  if (!value) {
    fail(message, value, true);
  }
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    fail(message, actual, expected);
  }
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonical(actual) !== canonical(expected)) {
    fail(message, actual, expected);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

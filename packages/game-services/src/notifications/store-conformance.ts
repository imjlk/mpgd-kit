import type { NotificationConsentRecord } from '@mpgd/platform/notifications';

import type {
  NotificationConsentRecordInput,
  NotificationEndpointWrite,
  NotificationScheduleEntry,
  NotificationStore,
  NotificationStoredSend,
} from './store.js';

/**
 * The behavior every `NotificationStore` must have, run against a fresh
 * store: the atomic steps the service relies on (consent dating, endpoint
 * address uniqueness and dead addresses, versioned compare-and-set on sends
 * and schedule entries, idempotent notices and history, consent pruning,
 * provider-wide history counts) and the purge cutoffs. A durable store
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
    } as NotificationConsentRecordInput,
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
  // A session's later end moves its endpoints' ends; an earlier one or another session's does not.
  await store.putEndpoint(
    endpoint('i-5', 'tok-5', { sessionId: 'extended', sessionExpiresAt: at(60_000) }),
  );
  await store.putEndpoint(endpoint('i-6', 'tok-6', { sessionId: 'extended' }));
  await store.putEndpoint(
    endpoint('i-7', 'tok-7', { sessionId: 'other', sessionExpiresAt: at(60_000) }),
  );
  equal(
    await store.extendSessionEndpoints({ sessionId: 'extended', expiresAt: at(30_000) }),
    0,
    'endpoints: a session end never moves earlier',
  );
  equal(
    await store.extendSessionEndpoints({ sessionId: 'extended', expiresAt: at(60_000) }),
    0,
    'endpoints: the same end changes nothing',
  );
  equal(
    await store.extendSessionEndpoints({ sessionId: 'extended', expiresAt: at(120_000) }),
    1,
    'endpoints: a later session end moves only the endpoints that have one',
  );
  equal(
    Date.parse(
      (await store.getEndpoint({ provider: 'fcm', installationId: 'i-5' }))?.sessionExpiresAt ?? '',
    ),
    Date.parse(at(120_000)),
    'endpoints: the moved end reads back',
  );
  equal(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'i-6' }))?.sessionExpiresAt,
    undefined,
    'endpoints: an endpoint without an end keeps none',
  );
  equal(
    Date.parse(
      (await store.getEndpoint({ provider: 'fcm', installationId: 'i-7' }))?.sessionExpiresAt ?? '',
    ),
    Date.parse(at(60_000)),
    'endpoints: only the named session moves',
  );
  equal(
    await store.extendSessionEndpoints({ sessionId: 'extended' }),
    1,
    'endpoints: a session that no longer ends clears the end',
  );
  equal(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'i-5' }))?.sessionExpiresAt,
    undefined,
    'endpoints: the cleared end reads back',
  );
  await store.removeSessionEndpoints({ sessionId: 'extended' });
  await store.removeSessionEndpoints({ sessionId: 'other' });
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

  await runConcurrencyAndEdgeClauses(store, at, endpoint, send);
  await runSchedulerClauses(store, at);
}

/**
 * The steps S2's scheduler adds: schedule entries (create once,
 * compare-and-set, the due index), provider-wide history counts for
 * pacing, and consent pruning with the notices that name pruned records.
 */
async function runSchedulerClauses(store: NotificationStore, at: (offsetMs: number) => string): Promise<void> {
  const base = 40 * 86_400_000;
  const t = (offsetMs: number): string => at(base + offsetMs);

  // Consent pruning: by instant, per player, with the notices given that report on a pruned record.
  const records: NotificationConsentRecord[] = [];
  for (const record of [
    { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v1' },
    { kind: 'advertising', state: 'withdrawn', source: 'player', textVersion: 'v1' },
    { kind: 'topic-preference', topic: 'energy-full', state: 'granted', source: 'player' },
    { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v2' },
  ] as const) {
    records.push(await store.appendConsent({ player: 'p-prune', record, at: t(0) }));
  }
  const other = await store.appendConsent({
    player: 'p-prune-other',
    record: { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v1' },
    at: t(0),
  });
  const [granted, withdrawn, preference, regranted] = records;
  const given = (recordAt: string, dueBy: string, player = 'p-prune') => ({
    kind: 'consent-result' as const,
    record: { kind: 'advertising' as const, at: recordAt },
    dueBy,
    player,
    channel: 'push' as const,
    at: t(10),
  });
  await store.addNoticeGiven(given(granted?.at ?? '', '2026-12-12'));
  await store.addNoticeGiven(given(regranted?.at ?? '', '2026-12-13'));
  await store.addNoticeGiven(given(other.at, '2026-12-12', 'p-prune-other'));
  equal(
    await store.pruneConsent({
      player: 'p-prune',
      // The same instant in another spelling names the same record.
      at: [
        granted?.at ?? '',
        new Date(Date.parse(withdrawn?.at ?? '')).toISOString().replace('Z', '+00:00'),
        // An instant with no record of this player.
        t(-5),
      ],
    }),
    2,
    'prune: deletes the records at those instants',
  );
  deepEqual(
    (await store.listConsent('p-prune')).map((record) => record.at),
    [preference?.at, regranted?.at],
    'prune: the other records stay, oldest first',
  );
  deepEqual(
    (await store.listNoticesGiven('p-prune')).map((notice) => notice.record.at),
    [regranted?.at],
    'prune: a notice given about a pruned record goes with it',
  );
  equal((await store.listConsent('p-prune-other')).length, 1, 'prune: per player');
  equal(
    (await store.listNoticesGiven('p-prune-other')).length,
    1,
    'prune: another player keeps its notices',
  );
  equal(
    await store.pruneConsent({ player: 'p-prune', at: [] }),
    0,
    'prune: nothing named, nothing deleted',
  );
  const next = await store.appendConsent({
    player: 'p-prune',
    record: { kind: 'night', state: 'granted', source: 'player', textVersion: 'v1' },
    at: t(0),
  });
  equal(
    Date.parse(next.at),
    Date.parse(regranted?.at ?? '') + 1,
    'prune: a later record is still dated after the latest one',
  );

  // History counts per provider across players, from `since` on.
  for (const [sendKey, provider, player, offset] of [
    ['count-1', 'paced', 'p-a', 100],
    ['count-2', 'paced', 'p-b', 200],
    ['count-3', 'paced', 'p-a', 300],
    ['count-4', 'other-paced', 'p-a', 300],
  ] as const) {
    await store.addHistory({ sendKey, provider, player, topic: 't', at: t(offset) });
  }
  equal(await store.countHistory({ provider: 'paced', since: t(0) }), 3, 'count: every player');
  equal(
    await store.countHistory({ provider: 'paced', since: t(200) }),
    2,
    'count: since is inclusive',
  );
  equal(await store.countHistory({ provider: 'paced', since: t(301) }), 0, 'count: none after');
  equal(
    await store.countHistory({ provider: 'other-paced', since: t(0) }),
    1,
    'count: per provider',
  );

  // Schedule entries: create once, compare-and-set, the due index.
  const entry = (player: string, id: string, dueAt: string | undefined): NotificationScheduleEntry => ({
    player,
    id,
    ...(dueAt === undefined ? {} : { dueAt }),
    item: {
      kind: 'reminder',
      key: id.slice('reminder:'.length),
      topic: 'energy-full',
      fireAt: dueAt ?? t(0),
      templateData: { count: 3, ready: true, name: 'x' },
      link: 't3_x',
    },
  });
  const first = entry('p-s', 'reminder:energy', t(1_000));
  const version = await store.createScheduleEntry(first);
  ok(typeof version === 'string', 'schedule: created');
  equal(
    await store.createScheduleEntry(first),
    undefined,
    'schedule: an id is created once per player',
  );
  const held = await store.getScheduleEntry({ player: 'p-s', id: 'reminder:energy' });
  deepEqual(held?.entry, first, 'schedule: read back as written');
  equal(held?.version, version, 'schedule: with its version');
  equal(
    await store.getScheduleEntry({ player: 'p-s2', id: 'reminder:energy' }),
    undefined,
    'schedule: per player',
  );
  ok(
    typeof await store.createScheduleEntry(entry('p-s2', 'reminder:energy', t(500))) === 'string',
    'schedule: another player has its own ids',
  );
  await store.createScheduleEntry({
    player: 'p-s',
    id: 'notices',
    item: { kind: 'notices', attempts: 2, failed: ['k'] },
  });
  await store.createScheduleEntry(entry('p-s3', 'reminder:later', t(2_000)));
  deepEqual(
    await store.listDueScheduleEntries({ at: t(999), limit: 10 }),
    [{ player: 'p-s2', id: 'reminder:energy' }],
    'schedule: not due before dueAt',
  );
  deepEqual(
    await store.listDueScheduleEntries({ at: t(2_000), limit: 10 }),
    [
      { player: 'p-s2', id: 'reminder:energy' },
      { player: 'p-s', id: 'reminder:energy' },
      { player: 'p-s3', id: 'reminder:later' },
    ],
    'schedule: due at dueAt, earliest first; an entry without dueAt is never due',
  );
  deepEqual(
    await store.listDueScheduleEntries({ at: t(2_000), limit: 1 }),
    [{ player: 'p-s2', id: 'reminder:energy' }],
    'schedule: limited',
  );
  const moved = {
    ...first,
    dueAt: t(3_000),
    item: { ...first.item, fireAt: t(3_000) },
  } as NotificationScheduleEntry;
  ok(
    await store.updateScheduleEntry({ player: 'p-s', id: 'reminder:energy', version: version ?? '', entry: moved }),
    'schedule: a write with the version succeeds',
  );
  ok(
    !await store.updateScheduleEntry({ player: 'p-s', id: 'reminder:energy', version: version ?? '', entry: first }),
    'schedule: a stale version is refused',
  );
  const current = await store.getScheduleEntry({ player: 'p-s', id: 'reminder:energy' });
  deepEqual(current?.entry, moved, 'schedule: the write is stored');
  ok(
    current !== undefined && current.version !== version,
    'schedule: every write changes the version',
  );
  deepEqual(
    (await store.listDueScheduleEntries({ at: t(2_999), limit: 10 })).map((due) => due.player),
    ['p-s2', 'p-s3'],
    'schedule: the due index follows the write',
  );
  const notices = await store.getScheduleEntry({ player: 'p-s', id: 'notices' });
  ok(
    notices !== undefined && await store.updateScheduleEntry({
      player: 'p-s',
      id: 'notices',
      version: notices.version,
      entry: { player: 'p-s', id: 'notices', dueAt: t(0), item: { kind: 'notices', attempts: 0 } },
    }),
    'schedule: an entry gains a due time',
  );
  deepEqual(
    (await store.listDueScheduleEntries({ at: t(0), limit: 10 })).map((due) => due.id),
    ['notices'],
    'schedule: and is listed from then',
  );
  ok(
    await store.updateScheduleEntry({
      player: 'p-s',
      id: 'reminder:energy',
      version: current?.version ?? '',
      entry: undefined,
    }),
    'schedule: deleted with the version',
  );
  equal(
    await store.getScheduleEntry({ player: 'p-s', id: 'reminder:energy' }),
    undefined,
    'schedule: gone',
  );
  ok(
    !await store.updateScheduleEntry({
      player: 'p-s',
      id: 'reminder:energy',
      version: current?.version ?? '',
      entry: first,
    }),
    'schedule: a deleted entry is not written back',
  );

  // Parallel callers.
  const created = await Promise.all(
    Array.from({ length: 6 }, () => store.createScheduleEntry(entry('p-race', 'reminder:r', t(0)))),
  );
  equal(
    created.filter((value) => value !== undefined).length,
    1,
    'concurrency: one of parallel creates wins',
  );
  const raced = await store.getScheduleEntry({ player: 'p-race', id: 'reminder:r' });
  const updated = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      store.updateScheduleEntry({
        player: 'p-race',
        id: 'reminder:r',
        version: raced?.version ?? '',
        entry: entry('p-race', 'reminder:r', t(index)),
      }),
    ),
  );
  equal(
    updated.filter(Boolean).length,
    1,
    'concurrency: one of parallel writes with one version wins',
  );
}

/**
 * The clauses a store can get wrong while passing the sequential ones:
 * parallel callers of each atomic step, the dead-address and unbind edges,
 * the due and in-flight indexes as rows change state, and purge boundaries.
 */
async function runConcurrencyAndEdgeClauses(
  store: NotificationStore,
  at: (offsetMs: number) => string,
  endpoint: (
    installationId: string,
    value: string,
    extra?: Partial<NotificationEndpointWrite>,
  ) => NotificationEndpointWrite,
  send: NotificationStoredSend,
): Promise<void> {
  const later = (offsetMs: number): string => at(10 * 86_400_000 + offsetMs);

  // Parallel callers of each atomic step.
  const parallel = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.appendConsent({
        player: 'p-parallel',
        record: { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v1' },
        at: later(0),
      }),
    ),
  );
  deepEqual(
    parallel.map((record) => Date.parse(record.at)).sort((left, right) => left - right),
    Array.from({ length: 8 }, (_, index) => Date.parse(later(index))),
    'concurrency: parallel consent records each take their own millisecond',
  );
  deepEqual(
    (await store.listConsent('p-parallel')).map((record) => record.at),
    Array.from({ length: 8 }, (_, index) => later(index)),
    'concurrency: parallel consent records are listed in time order',
  );
  await Promise.all([
    store.putEndpoint(endpoint('race-1', 'tok-race', { player: 'p-race' })),
    store.putEndpoint(endpoint('race-2', 'tok-race', { player: 'p-race' })),
  ]);
  equal(
    (await store.listEndpoints({ player: 'p-race', provider: 'fcm' })).length,
    1,
    'concurrency: one address stays on one installation',
  );
  const racing = {
    ...send,
    key: 'race-send',
    request: { ...send.request, idempotencyKey: 'race-send' },
  };
  const versions = await Promise.all(Array.from({ length: 4 }, () => store.createSend(racing)));
  equal(
    versions.filter((version) => version !== undefined).length,
    1,
    'concurrency: a key is created once',
  );
  const racingVersion = (await store.getSend('race-send'))?.version ?? '';
  const writes = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.updateSend({
        key: 'race-send',
        version: racingVersion,
        send: { ...racing, changedAt: later(1) },
      }),
    ),
  );
  equal(writes.filter(Boolean).length, 1, 'concurrency: one write wins a version');

  // Dead addresses and unbinding.
  await store.putEndpoint(endpoint('dead-1', 'tok-dead', { player: 'p-edge' }));
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'dead-1',
    value: 'tok-dead',
    at: later(5),
  });
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'dead-1',
    value: 'tok-dead',
    at: later(9),
  });
  const reregistered = await store.putEndpoint(
    endpoint('dead-1', 'tok-dead', {
      player: 'p-edge',
      permission: 'blocked',
      lastRegisteredAt: later(20),
    }),
  );
  deepEqual(
    [
      reregistered.status,
      reregistered.invalidatedAt,
      reregistered.permission,
      reregistered.lastRegisteredAt,
    ],
    ['invalid', later(5), 'blocked', later(20)],
    'endpoints: a dead address keeps its first invalidation and takes the new registration fields',
  );
  // Another installation that reports the dead address takes it, valid.
  const taken = await store.putEndpoint(endpoint('dead-2', 'tok-dead', { player: 'p-edge' }));
  equal(taken.status, 'valid', 'endpoints: another installation takes a dead address as valid');
  equal(
    await store.getEndpoint({ provider: 'fcm', installationId: 'dead-1' }),
    undefined,
    'endpoints: the dead copy goes',
  );
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'dead-2',
    value: 'tok-dead',
    at: later(40),
  });
  const revived = await store.putEndpoint(endpoint('dead-2', 'tok-new', { player: 'p-edge' }));
  deepEqual(
    [revived.status, revived.invalidatedAt],
    ['valid', undefined],
    'endpoints: a revived endpoint is valid, without an invalidation time',
  );
  await store.putEndpoint({
    ...endpoint('multi', 'tok-m1', { player: 'p-edge' }),
    provider: 'fcm',
  });
  await store.putEndpoint({
    ...endpoint('multi', 'tok-m2', { player: 'p-edge' }),
    provider: 'other',
  });
  await store.removeEndpoints({ installationId: 'multi', player: 'p-edge', provider: 'other' });
  ok(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'multi' })) !== undefined
      && (await store.getEndpoint({ provider: 'other', installationId: 'multi' })) === undefined,
    'endpoints: an unbind of one provider removes it and keeps the other',
  );
  await store.putEndpoint({
    ...endpoint('multi', 'tok-m2', { player: 'p-edge' }),
    provider: 'other',
  });
  await store.removeEndpoints({ installationId: 'multi', player: 'p-edge' });
  ok(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'multi' })) === undefined
      && (await store.getEndpoint({ provider: 'other', installationId: 'multi' })) === undefined,
    'endpoints: an unbind without a provider removes every provider',
  );

  // Notices are named by instant and per player.
  const notice = {
    kind: 'reconfirmation',
    record: { kind: 'night', at: '2026-10-19T03:00:00Z' },
    dueBy: '2028-10-18',
    player: 'p-edge',
    channel: 'in-game',
    at: later(0),
  } as const;
  await store.addNoticeGiven(notice);
  await store.addNoticeGiven({
    ...notice,
    record: { kind: 'night', at: '2026-10-19T12:00:00+09:00' },
  });
  await store.addNoticeGiven({ ...notice, player: 'p-other' });
  equal(
    (await store.listNoticesGiven('p-edge')).length,
    1,
    'notices: another spelling of the instant is the same notice',
  );
  equal(
    (await store.listNoticesGiven('p-other')).length,
    1,
    'notices: the same name for another player is recorded',
  );

  // The due and in-flight indexes follow the rows.
  const edge = (key: string, rows: NotificationStoredSend['rows'], extra: Partial<NotificationStoredSend> = {}) => ({
    ...send,
    key,
    request: { ...send.request, idempotencyKey: key, player: 'p-index' },
    rows,
    changedAt: later(0),
    ...extra,
  });
  const queued = edge('idx-queued', [
    {
      key: 'idx-queued',
      provider: 'platform',
      state: { status: 'in-flight', leaseUntil: later(300), attempted: false },
    },
  ]);
  const mixed = edge('idx-mixed', [
    { key: 'idx-mixed:a', provider: 'fcm', installationId: 'a', state: { status: 'delivered' } },
    {
      key: 'idx-mixed',
      provider: 'platform',
      firstAttemptedAt: later(0),
      state: {
        status: 'in-flight',
        leaseUntil: later(400),
        claim: 'c',
        attempted: true,
        attemptedAt: later(0),
      },
    },
  ]);
  const abandoned = edge('idx-abandoned', [
    {
      key: 'idx-abandoned',
      provider: 'platform',
      firstAttemptedAt: later(0),
      state: {
        status: 'in-flight',
        leaseUntil: later(86_400_000),
        claim: 'c',
        attempted: true,
        attemptedAt: later(86_100_000),
      },
    },
  ]);
  const claimOnly = edge('idx-claim', [], { claim: { token: 't', leaseUntil: later(300) } });
  for (const created of [queued, mixed, abandoned, claimOnly]) {
    await store.createSend(created);
  }
  deepEqual(
    await store.getSend('idx-mixed').then((held) => held?.send),
    mixed,
    'sends: attempt times round-trip',
  );
  ok(
    !(await store.listDueSends({ at: later(299), limit: 100 })).includes('idx-queued'),
    'sends: a queued row is not due before its lease ends',
  );
  deepEqual(
    [...await store.listDueSends({ at: later(2 * 86_400_000), limit: 100 })].filter((key) => key.startsWith('idx-')).sort(),
    ['idx-mixed', 'idx-queued'],
    'sends: a queued and an attempted row are due at their lease; an abandoned row and a bare claim never',
  );
  deepEqual(
    (await store.listInFlightSends('p-index')).map((row) => row.key).sort(),
    ['idx-abandoned', 'idx-mixed', 'idx-queued'],
    'sends: a send with any in-flight row is in flight, even next to a delivered row',
  );
  const settled = await store.getSend('idx-mixed');
  await store.updateSend({
    key: 'idx-mixed',
    version: settled?.version ?? '',
    send: { ...mixed, rows: [mixed.rows[0] as NotificationStoredSend['rows'][number]] },
  });
  ok(
    !(await store.listDueSends({ at: later(2 * 86_400_000), limit: 100 })).includes('idx-mixed')
      && !(await store.listInFlightSends('p-index')).some((row) => row.key === 'idx-mixed'),
    'sends: a send whose rows all delivered leaves both indexes',
  );

  // History keeps one entry per send and provider.
  await store.addHistory({
    sendKey: 'two-providers',
    provider: 'fcm',
    player: 'p-edge',
    topic: 't',
    at: later(1),
  });
  await store.addHistory({
    sendKey: 'two-providers',
    provider: 'other',
    player: 'p-edge',
    topic: 't',
    at: later(2),
  });
  equal(
    (await store.listHistory({ player: 'p-edge', since: later(0) })).length,
    2,
    'history: another provider is another entry',
  );

  // Purge cutoffs are exclusive, and records outside purge survive it.
  await store.putEndpoint(
    endpoint('edge-invalid', 'tok-edge', { player: 'p-edge', lastRegisteredAt: later(0) }),
  );
  await store.invalidateEndpoint({
    provider: 'fcm',
    installationId: 'edge-invalid',
    value: 'tok-edge',
    at: later(50),
  });
  await store.putEndpoint(
    endpoint('edge-session', 'tok-es', {
      player: 'p-edge',
      lastRegisteredAt: later(0),
      sessionExpiresAt: later(0),
    }),
  );
  await store.putPlatformRegistration({
    player: 'p-edge',
    provider: 'ait',
    registeredAt: later(0),
  });
  await store.purge({
    sendsChangedBefore: later(0),
    historyBefore: later(1),
    invalidEndpointsBefore: later(50),
    staleEndpointsBefore: later(0),
    sessionEndpointsBefore: later(0),
  });
  ok(
    (await store.getSend('idx-queued')) !== undefined,
    'purge: a send changed at the cutoff is kept',
  );
  ok(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'edge-invalid' })) !== undefined,
    'purge: an endpoint invalidated, and last registered, at the cutoffs is kept',
  );
  ok(
    (await store.getEndpoint({ provider: 'fcm', installationId: 'edge-session' })) !== undefined,
    'purge: an endpoint whose session ends at the cutoff is kept',
  );
  equal(
    (await store.listHistory({ player: 'p-edge', since: later(0) })).length,
    2,
    'purge: history at the cutoff is kept',
  );
  equal((await store.listConsent('p-parallel')).length, 8, 'purge: consent records are not purged');
  equal((await store.listNoticesGiven('p-edge')).length, 1, 'purge: notices given are not purged');
  ok(
    (await store.getPlatformRegistration({ player: 'p-edge', provider: 'ait' })) !== undefined,
    'purge: registrations are not purged',
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

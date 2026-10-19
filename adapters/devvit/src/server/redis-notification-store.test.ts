import { describe, expect, it } from 'vitest';

import type { NotificationStoredSend } from '@mpgd/game-services/notifications';
import { runNotificationStoreConformance } from '@mpgd/game-services/notifications/store-conformance';

import { createFakeNotificationRedis } from '../../test/fake-notification-redis.js';
import { createDevvitRedisNotificationStore } from './redis-notification-store.js';

const send = (key: string, rows: NotificationStoredSend['rows']): NotificationStoredSend => ({
  key,
  fingerprint: 'f',
  request: { idempotencyKey: key, player: 't2_player', topic: 'friend-challenge' },
  origin: { kind: 'send' },
  scheduled: false,
  rows,
  changedAt: '2026-10-19T03:00:00Z',
});

const claimed = (token: string, leaseUntil: string): NotificationStoredSend['rows'][number] => ({
  key: 'k',
  provider: 'devvit',
  firstAttemptedAt: '2026-10-19T03:00:00Z',
  state: {
    status: 'in-flight',
    leaseUntil,
    claim: token,
    attempted: true,
    attemptedAt: '2026-10-19T03:00:00Z',
  },
});

describe('createDevvitRedisNotificationStore', () => {
  it('passes the notification store conformance suite', async () => {
    await expect(runNotificationStoreConformance(() =>
      createDevvitRedisNotificationStore(createFakeNotificationRedis()))).resolves.toBeUndefined();
  });

  it('passes it under a namespace, writing only namespaced keys', async () => {
    const redis = createFakeNotificationRedis();
    await runNotificationStoreConformance(() =>
      createDevvitRedisNotificationStore(redis, { namespace: 'my-game:pn' }));
    expect(redis.keys().length).toBeGreaterThan(0);
    expect(redis.keys().filter((key) => !key.startsWith('my-game:pn:'))).toEqual([]);
  });

  it('fences a stale claim: a holder whose lease was taken over cannot write its answer back', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const first = await store.createSend(send('k', [claimed('holder-a', '2026-10-19T03:05:00Z')]));
    expect(first).toBeTypeOf('string');
    // The lease ended; holder B claims the row with the version it read.
    const read = await store.getSend('k');
    expect(await store.updateSend({
      key: 'k',
      version: read?.version ?? '',
      send: send('k', [claimed('holder-b', '2026-10-19T03:10:00Z')]),
    })).toBe(true);
    // Holder A answers with the version it read before B's claim: refused.
    expect(await store.updateSend({
      key: 'k',
      version: first ?? '',
      send: send('k', [{ key: 'k', provider: 'devvit', state: { status: 'delivered' } }]),
    })).toBe(false);
    expect((await store.getSend('k'))?.send.rows[0]?.state).toMatchObject({ claim: 'holder-b' });
  });

  it('refuses a write whose version a concurrent writer replaced between its read and its EXEC', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const version = await store.createSend(send('k', [claimed('holder-a', '2026-10-19T03:05:00Z')]));
    let interfered = false;
    redis.beforeExec = async (watched) => {
      if (interfered || !watched.some((key) => key.includes(':send:'))) {
        return;
      }
      interfered = true;
      redis.beforeExec = undefined;
      // Holder B's claim commits after A read the version and before A's EXEC.
      const read = await store.getSend('k');
      await store.updateSend({
        key: 'k',
        version: read?.version ?? '',
        send: send('k', [claimed('holder-b', '2026-10-19T03:10:00Z')]),
      });
    };
    expect(await store.updateSend({
      key: 'k',
      version: version ?? '',
      send: send('k', [{ key: 'k', provider: 'devvit', state: { status: 'delivered' } }]),
    })).toBe(false);
    expect(interfered).toBe(true);
    // A's EXEC aborted, its retry saw B's version, and B's claim stands.
    expect(redis.aborted).toBeGreaterThanOrEqual(1);
    expect((await store.getSend('k'))?.send.rows[0]?.state).toMatchObject({ claim: 'holder-b' });
  });

  it('keeps the due and in-flight indexes in the transaction that writes the send', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const version = await store.createSend(send('k', [claimed('a', '2026-10-19T03:05:00Z')]));
    expect(await store.listDueSends({ at: '2026-10-19T03:05:00Z', limit: 10 })).toEqual(['k']);
    expect((await store.listInFlightSends('t2_player')).map((row) => row.key)).toEqual(['k']);
    await store.updateSend({
      key: 'k',
      version: version ?? '',
      send: send('k', [{ key: 'k', provider: 'devvit', state: { status: 'delivered' } }]),
    });
    expect(await store.listDueSends({ at: '2026-10-20T00:00:00Z', limit: 10 })).toEqual([]);
    expect(await store.listInFlightSends('t2_player')).toEqual([]);
    expect(redis.keys().filter((key) => key.includes('in-flight') || key.endsWith(':due'))).toEqual([]);
  });

  it('pages the due index past one zRange page', async () => {
    const store = createDevvitRedisNotificationStore(createFakeNotificationRedis());
    for (let index = 0; index < 1_203; index += 1) {
      await store.createSend({
        ...send(`k-${String(index).padStart(4, '0')}`, [
          { key: 'r', provider: 'devvit', state: { status: 'deferred', reason: 'quiet-hours', until: '2026-10-19T04:00:00Z' } },
        ]),
      });
    }
    const due = await store.listDueSends({ at: '2026-10-19T05:00:00Z', limit: 1_200 });
    expect(due).toHaveLength(1_200);
    expect(new Set(due).size).toBe(1_200);
    expect(await store.listDueSends({ at: '2026-10-19T05:00:00Z', limit: 0 })).toEqual([]);
  });

  it('fails a contended step after its attempts instead of writing blind', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis, { transactionAttempts: 2 });
    redis.beforeExec = (watched) => {
      // Another writer changes the watched consent set before every EXEC.
      for (const key of watched) {
        redis.touch(key);
      }
    };
    await expect(store.appendConsent({
      player: 't2_player',
      record: { kind: 'delivery-permission', state: 'granted', source: 'client-report' },
      at: '2026-10-19T03:00:00Z',
    })).rejects.toThrow(/contention exceeded 2 attempts/u);
  });

  it('reads a committed EXEC with a short reply list as committed, not as a lost race', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    redis.dropLastReply = true;
    const version = await store.createSend(send('k', [claimed('a', '2026-10-19T03:05:00Z')]));
    expect(version).toBeTypeOf('string');
    expect((await store.getSend('k'))?.version).toBe(version);
    expect(await store.updateSend({
      key: 'k',
      version: version ?? '',
      send: send('k', [{ key: 'k', provider: 'devvit', state: { status: 'delivered' } }]),
    })).toBe(true);
    const current = await store.getSend('k');
    expect(current?.send.rows[0]?.state.status).toBe('delivered');
    expect(await store.updateSend({ key: 'k', version: current?.version ?? '', send: undefined })).toBe(true);
    expect(await store.getSend('k')).toBeUndefined();
  });

  it('keeps players, keys with separators, and namespaces apart', async () => {
    const redis = createFakeNotificationRedis();
    const one = createDevvitRedisNotificationStore(redis, { namespace: 'game-a' });
    const two = createDevvitRedisNotificationStore(redis, { namespace: 'game-b' });
    const record = { kind: 'delivery-permission', state: 'granted', source: 'client-report' } as const;
    await one.appendConsent({ player: 'a:b', record, at: '2026-10-19T03:00:00Z' });
    await one.appendConsent({ player: 'a%3Ab', record, at: '2026-10-19T03:00:00Z' });
    await two.appendConsent({ player: 'a:b', record, at: '2026-10-19T03:00:00Z' });
    expect(await one.listConsent('a:b')).toHaveLength(1);
    expect(await one.listConsent('a%3Ab')).toHaveLength(1);
    expect(await two.listConsent('a%3Ab')).toEqual([]);
    await one.createSend(send('x:y', []));
    expect(await one.getSend('x%3Ay')).toBeUndefined();
    expect(await two.getSend('x:y')).toBeUndefined();
  });

  it('purges in batches, drops stale index entries and unreadable values, and keeps newer history', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis, { purgeLimit: 600 });
    for (let index = 0; index < 700; index += 1) {
      await store.addHistory({
        sendKey: `h-${String(index)}`,
        provider: 'devvit',
        player: 't2_player',
        topic: 't',
        at: '2026-10-01T00:00:00Z',
      });
    }
    expect(await store.listHistory({ player: 't2_player', since: '2026-09-01T00:00:00Z' })).toHaveLength(700);
    await store.createSend(send('old', []));
    // A send value that is not JSON, and an index entry whose value is gone.
    redis.poke('mpgd:notifications:send:broken', 'not json');
    const index = await redis.watch();
    await index.multi();
    await index.zAdd('mpgd:notifications:sends:changed', { member: 'broken', score: 0 }, { member: 'gone', score: 0 });
    await index.exec();
    const cutoffs = {
      sendsChangedBefore: '2026-11-01T00:00:00Z',
      historyBefore: '2026-11-01T00:00:00Z',
      invalidEndpointsBefore: '2026-11-01T00:00:00Z',
      staleEndpointsBefore: '2026-11-01T00:00:00Z',
      sessionEndpointsBefore: '2026-11-01T00:00:00Z',
    };
    const first = await store.purge(cutoffs);
    expect(first).toEqual({ sends: 2, history: 600, endpoints: 0 });
    expect(await store.getSend('old')).toBeUndefined();
    expect(redis.keys().filter((key) => key.includes(':send:') || key.endsWith(':changed'))).toEqual([]);
    const second = await store.purge(cutoffs);
    expect(second.history).toBe(100);
    expect(await store.listHistory({ player: 't2_player', since: '2026-09-01T00:00:00Z' })).toEqual([]);
    expect(redis.keys().filter((key) => key.includes('history'))).toEqual([]);
    expect(() => createDevvitRedisNotificationStore(redis, { purgeLimit: 0 })).toThrow(TypeError);
  });

  it('rejects an empty namespace and out-of-range attempts', () => {
    const redis = createFakeNotificationRedis();
    expect(() => createDevvitRedisNotificationStore(redis, { namespace: '' })).toThrow(TypeError);
    expect(() => createDevvitRedisNotificationStore(redis, { transactionAttempts: 0 })).toThrow(TypeError);
    expect(() => createDevvitRedisNotificationStore(redis, { transactionAttempts: 65 })).toThrow(TypeError);
  });
});

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

  it('reads an abort that answers only nil as an abort', async () => {
    const redis = createFakeNotificationRedis();
    redis.abortReply = 'nulls';
    await runNotificationStoreConformance(() => createDevvitRedisNotificationStore(redis));
    expect(redis.aborted).toBeGreaterThan(0);
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

  it('reads a committed EXEC whose zero replies Devvit dropped as committed, not as a lost race', async () => {
    const redis = createFakeNotificationRedis();
    redis.dropZeroReplies = true;
    // The whole conformance suite still holds when every zero reply is dropped.
    await runNotificationStoreConformance(() => createDevvitRedisNotificationStore(redis));
    const store = createDevvitRedisNotificationStore(createFakeNotificationRedis());
    const zeroes = createFakeNotificationRedis();
    zeroes.dropZeroReplies = true;
    const dropping = createDevvitRedisNotificationStore(zeroes);
    for (const target of [store, dropping]) {
      await target.putEndpoint({
        provider: 'fcm',
        installationId: 'i-1',
        player: 't2_player',
        address: { kind: 'fcm-token', value: 'tok' },
        permission: 'granted',
        sessionId: 's',
        sessionExpiresAt: '2026-10-20T00:00:00Z',
        lastRegisteredAt: '2026-10-19T00:00:00Z',
      });
      // HSET of an existing field replies 0: the count must still be 1.
      expect(await target.extendSessionEndpoints({ sessionId: 's', expiresAt: '2026-10-21T00:00:00Z' })).toBe(1);
    }
    expect(zeroes.aborted).toBe(0);
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
    const unbounded = createDevvitRedisNotificationStore(redis);
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
    for (let index = 0; index < 700; index += 1) {
      await unbounded.addHistory({
        sendKey: `again-${String(index)}`,
        provider: 'devvit',
        player: 't2_player',
        topic: 't',
        at: '2026-10-01T00:00:00Z',
      });
    }
    // Without purgeLimit, one call deletes every row past its cutoff.
    expect((await unbounded.purge(cutoffs)).history).toBe(700);
    expect(() => createDevvitRedisNotificationStore(redis, { purgeLimit: 0 })).toThrow(TypeError);
  });

  it('drops a malformed history member and keeps an entry its index misdates', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await store.addHistory({ sendKey: 'h-1', provider: 'devvit', player: 't2_p', topic: 't', at: '2026-12-01T00:00:00Z' });
    const index = await redis.watch();
    await index.multi();
    await index.zAdd(
      'mpgd:notifications:history-all',
      { member: 'not json', score: 0 },
      // An index entry dated before the cutoff for an entry that is not old.
      { member: JSON.stringify(['t2_p', JSON.stringify(['h-1', 'devvit'])]), score: 0 },
    );
    await index.exec();
    const counts = await store.purge({
      sendsChangedBefore: '2026-11-01T00:00:00Z',
      historyBefore: '2026-11-01T00:00:00Z',
      invalidEndpointsBefore: '2026-11-01T00:00:00Z',
      staleEndpointsBefore: '2026-11-01T00:00:00Z',
      sessionEndpointsBefore: '2026-11-01T00:00:00Z',
    });
    expect(counts.history).toBe(0);
    expect(await store.listHistory({ player: 't2_p', since: '2026-11-15T00:00:00Z' })).toHaveLength(1);
    const left = await redis.zRange('mpgd:notifications:history-all', '-inf', '+inf', { by: 'score' });
    expect(left.map((entry) => entry.member)).not.toContain('not json');
    // The misdated entry is rescored to its time, no longer at the head of the next purge.
    expect(left).toEqual([
      { member: JSON.stringify(['t2_p', JSON.stringify(['h-1', 'devvit'])]), score: Date.parse('2026-12-01T00:00:00Z') },
    ]);
  });

  it('rescores a misdated send entry, drops one whose time does not parse, and refuses cutoffs that do not parse', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const zset = async (key: string) =>
      (await redis.zRange(`mpgd:notifications:${key}`, '-inf', '+inf', { by: 'score' })).map((entry) => [entry.member, entry.score]);
    await store.createSend({ ...send('new', []), changedAt: '2026-12-01T00:00:00Z' });
    await store.createSend(send('odd', []));
    redis.poke('mpgd:notifications:send:odd', JSON.stringify({ version: 'v', send: { ...send('odd', []), changedAt: 'x' } }));
    await store.putEndpoint({
      provider: 'fcm',
      installationId: 'a',
      player: 't2_me',
      address: { kind: 'fcm-token', value: 'tok' },
      permission: 'granted',
      sessionId: 's',
      lastRegisteredAt: '2026-08-01T00:00:00Z',
    });
    redis.poke('mpgd:notifications:endpoint:fcm:a', JSON.stringify({
      ...(await store.getEndpoint({ provider: 'fcm', installationId: 'a' })),
      lastRegisteredAt: 'x',
    }));
    const drift = await redis.watch();
    await drift.multi();
    await drift.zAdd('mpgd:notifications:sends:changed', { member: 'new', score: 0 }, { member: 'odd', score: 0 });
    await drift.exec();
    const garbage = {
      sendsChangedBefore: 'garbage',
      historyBefore: 'garbage',
      invalidEndpointsBefore: 'garbage',
      staleEndpointsBefore: 'garbage',
      sessionEndpointsBefore: 'garbage',
    };
    // A cutoff that does not parse is refused before anything is read or deleted, even beside good ones.
    const good = {
      sendsChangedBefore: '2026-11-01T00:00:00Z',
      historyBefore: '2026-01-01T00:00:00Z',
      invalidEndpointsBefore: '2026-01-01T00:00:00Z',
      staleEndpointsBefore: '2026-10-01T00:00:00Z',
      sessionEndpointsBefore: '2026-01-01T00:00:00Z',
    };
    await expect(store.purge(garbage)).rejects.toThrow(TypeError);
    await expect(store.purge({ ...good, historyBefore: 'garbage' })).rejects.toThrow(TypeError);
    expect(await zset('sends:changed')).toEqual([['new', 0], ['odd', 0]]);
    expect((await zset('endpoints-registered')).map(([member]) => member)).toEqual([JSON.stringify(['fcm', 'a'])]);
    expect(await store.purge(good)).toEqual({ sends: 0, history: 0, endpoints: 0 });
    expect(await zset('sends:changed')).toEqual([['new', Date.parse('2026-12-01T00:00:00Z')]]);
    // An endpoint whose time does not parse is never purged; it leaves the time index.
    expect(await zset('endpoints-registered')).toEqual([]);
    expect(await store.getSend('odd')).toBeDefined();
    expect(await store.getEndpoint({ provider: 'fcm', installationId: 'a' })).toBeDefined();
  });

  it("skips an unreadable in-flight row instead of failing the player's list", async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await store.createSend(send('ok', [claimed('a', '2026-10-19T03:05:00Z')]));
    await store.createSend(send('bad', [claimed('a', '2026-10-19T03:05:00Z')]));
    redis.poke('mpgd:notifications:send:bad', JSON.stringify({ version: 'v', send: {} }));
    expect((await store.listInFlightSends('t2_player')).map((row) => row.key)).toEqual(['ok']);
    // Rows that are not rows make the value unreadable too, and a read of it says so.
    redis.poke('mpgd:notifications:send:bad', JSON.stringify({
      version: 'v',
      send: { ...send('bad', []), rows: ['x'] },
    }));
    expect((await store.listInFlightSends('t2_player')).map((row) => row.key)).toEqual(['ok']);
    await expect(store.getSend('bad')).rejects.toThrow(/not a send/u);
    redis.poke('mpgd:notifications:send:bad', 'null');
    await expect(store.getSend('bad')).rejects.toThrow(/not a send/u);
  });

  it('discards a transaction whose EXEC throws, and keeps the error', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    redis.beforeExec = () => {
      throw new Error('connection reset');
    };
    await expect(store.createSend(send('k', []))).rejects.toThrow('connection reset');
    redis.beforeExec = undefined;
    expect(await store.getSend('k')).toBeUndefined();
    expect(await store.createSend(send('k', []))).toBeTypeOf('string');
  });

  it('drops a stale key from the due index when purge finds its value gone', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const index = await redis.watch();
    await index.multi();
    await index.zAdd('mpgd:notifications:sends:changed', { member: 'gone', score: 0 });
    await index.zAdd('mpgd:notifications:sends:due', { member: 'gone', score: 0 });
    await index.exec();
    await store.purge({
      sendsChangedBefore: '2026-11-01T00:00:00Z',
      historyBefore: '2026-11-01T00:00:00Z',
      invalidEndpointsBefore: '2026-11-01T00:00:00Z',
      staleEndpointsBefore: '2026-11-01T00:00:00Z',
      sessionEndpointsBefore: '2026-11-01T00:00:00Z',
    });
    expect(await store.listDueSends({ at: '2026-11-01T00:00:00Z', limit: 10 })).toEqual([]);
  });

  it("touches only one player's endpoint keys, never a key shared by every endpoint", async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const endpoint = (installationId: string, player: string, value: string) => ({
      provider: 'fcm',
      installationId,
      player,
      address: { kind: 'fcm-token' as const, value },
      permission: 'granted' as const,
      sessionId: `s-${installationId}`,
      lastRegisteredAt: '2026-10-19T03:00:00Z',
    });
    for (let index = 0; index < 20; index += 1) {
      await store.putEndpoint(endpoint(`other-${String(index)}`, `t2_other${String(index)}`, `tok-${String(index)}`));
    }
    const touched: string[] = [];
    const record = <Args extends unknown[], Value>(name: keyof typeof redis, call: (...args: Args) => Value) =>
      (...args: Args): Value => {
        const [first] = args;
        touched.push(...(Array.isArray(first) ? first.map(String) : [String(first)]));
        void name;
        return call(...args);
      };
    const spied = {
      ...redis,
      get: record('get', redis.get.bind(redis)),
      mGet: record('mGet', redis.mGet.bind(redis)),
      hGet: record('hGet', redis.hGet.bind(redis)),
      hGetAll: record('hGetAll', redis.hGetAll.bind(redis)),
      zRange: record('zRange', redis.zRange.bind(redis)),
      watch: (...watched: string[]) => {
        touched.push(...watched);
        return redis.watch(...watched);
      },
    };
    const scoped = createDevvitRedisNotificationStore(spied);
    await scoped.putEndpoint(endpoint('mine', 't2_me', 'tok-mine'));
    await scoped.getEndpoint({ provider: 'fcm', installationId: 'mine' });
    expect((await scoped.listEndpoints({ player: 't2_me', provider: 'fcm' })).map((row) => row.installationId))
      .toEqual(['mine']);
    await scoped.invalidateEndpoint({ provider: 'fcm', installationId: 'mine', value: 'tok-mine', at: '2026-10-19T04:00:00Z' });
    await scoped.removeEndpoints({ installationId: 'mine', player: 't2_me' });
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((key) => key.includes('other') || /:endpoints-(?:registered|invalidated|session-end)$/u.test(key))).toEqual([]);
    // The other players' endpoints are untouched.
    expect(await store.listEndpoints({ player: 't2_other3', provider: 'fcm' })).toHaveLength(1);
  });

  it('keeps device tokens out of key names, purges endpoints in bounded batches, and drops dangling entries', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis, { purgeLimit: 2 });
    for (let index = 0; index < 5; index += 1) {
      await store.putEndpoint({
        provider: 'fcm',
        installationId: `i-${String(index)}`,
        player: 't2_me',
        address: { kind: 'fcm-token', value: `secret-token-${String(index)}` },
        permission: 'granted',
        sessionId: 's',
        lastRegisteredAt: '2026-08-01T00:00:00Z',
      });
    }
    expect(redis.keys().filter((key) => key.includes('secret-token'))).toEqual([]);
    // A dangling index entry: its endpoint value is gone.
    const index = await redis.watch();
    await index.multi();
    await index.zAdd('mpgd:notifications:endpoints-registered', { member: JSON.stringify(['fcm', 'gone']), score: 0 });
    await index.exec();
    const cutoffs = {
      sendsChangedBefore: '2026-01-01T00:00:00Z',
      historyBefore: '2026-01-01T00:00:00Z',
      invalidEndpointsBefore: '2026-01-01T00:00:00Z',
      staleEndpointsBefore: '2026-10-01T00:00:00Z',
      sessionEndpointsBefore: '2026-01-01T00:00:00Z',
    };
    // At most two endpoint rows per cutoff and call; the dangling entry is one of them.
    expect((await store.purge(cutoffs)).endpoints).toBe(1);
    expect((await store.purge(cutoffs)).endpoints).toBe(2);
    expect((await store.purge(cutoffs)).endpoints).toBe(2);
    expect((await store.purge(cutoffs)).endpoints).toBe(0);
    expect(await store.listEndpoints({ player: 't2_me', provider: 'fcm' })).toEqual([]);
    expect(redis.keys().filter((key) => key.includes(':endpoint'))).toEqual([]);
  });

  it('keeps the purge time indexes in step with invalidation, session extension, and takeover', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const zset = async (key: string) =>
      (await redis.zRange(`mpgd:notifications:${key}`, '-inf', '+inf', { by: 'score' })).map((entry) => [entry.member, entry.score]);
    const base = {
      provider: 'fcm',
      player: 't2_me',
      permission: 'granted' as const,
      lastRegisteredAt: '2026-10-19T03:00:00Z',
    };
    await store.putEndpoint({
      ...base,
      installationId: 'a',
      address: { kind: 'fcm-token', value: 'tok-a' },
      sessionId: 's',
      sessionExpiresAt: '2026-10-20T00:00:00Z',
    });
    const a = JSON.stringify(['fcm', 'a']);
    await store.invalidateEndpoint({ provider: 'fcm', installationId: 'a', value: 'tok-a', at: '2026-10-19T04:00:00Z' });
    expect(await zset('endpoints-invalidated')).toEqual([[a, Date.parse('2026-10-19T04:00:00Z')]]);
    await store.extendSessionEndpoints({ sessionId: 's', expiresAt: '2026-10-21T00:00:00Z' });
    expect(await zset('endpoints-session-end')).toEqual([[a, Date.parse('2026-10-21T00:00:00Z')]]);
    await store.extendSessionEndpoints({ sessionId: 's' });
    expect(await zset('endpoints-session-end')).toEqual([]);
    // A new address revives the endpoint: it leaves the invalidated index.
    await store.putEndpoint({ ...base, installationId: 'a', address: { kind: 'fcm-token', value: 'tok-a2' }, sessionId: 's' });
    expect(await zset('endpoints-invalidated')).toEqual([]);
    // Another installation takes the address: the loser leaves every index.
    await store.putEndpoint({ ...base, installationId: 'b', address: { kind: 'fcm-token', value: 'tok-a2' }, sessionId: 's' });
    expect((await zset('endpoints-registered')).map(([member]) => member)).toEqual([JSON.stringify(['fcm', 'b'])]);
    // A drifted index entry is rescored by the purge that reads it, not left at the head.
    const drift = await redis.watch();
    await drift.multi();
    await drift.zAdd('mpgd:notifications:endpoints-registered', { member: JSON.stringify(['fcm', 'b']), score: 0 });
    await drift.exec();
    await store.purge({
      sendsChangedBefore: '2026-01-01T00:00:00Z',
      historyBefore: '2026-01-01T00:00:00Z',
      invalidEndpointsBefore: '2026-01-01T00:00:00Z',
      staleEndpointsBefore: '2026-10-01T00:00:00Z',
      sessionEndpointsBefore: '2026-01-01T00:00:00Z',
    });
    expect(await zset('endpoints-registered')).toEqual([[JSON.stringify(['fcm', 'b']), Date.parse('2026-10-19T03:00:00Z')]]);
  });

  it('keeps an address pointer that another installation took when the first moves on', async () => {
    const store = createDevvitRedisNotificationStore(createFakeNotificationRedis());
    const base = {
      provider: 'fcm',
      player: 't2_me',
      permission: 'granted' as const,
      lastRegisteredAt: '2026-10-19T03:00:00Z',
    };
    await store.putEndpoint({ ...base, installationId: 'a', address: { kind: 'fcm-token', value: 'tok' }, sessionId: 's-a' });
    await store.putEndpoint({ ...base, installationId: 'b', address: { kind: 'fcm-token', value: 'tok' }, sessionId: 's-b' });
    // b took the address; a is gone, and a new address for a does not free b's.
    expect(await store.getEndpoint({ provider: 'fcm', installationId: 'a' })).toBeUndefined();
    await store.putEndpoint({ ...base, installationId: 'a', address: { kind: 'fcm-token', value: 'tok-2' }, sessionId: 's-a' });
    await store.putEndpoint({ ...base, installationId: 'c', address: { kind: 'fcm-token', value: 'tok' }, sessionId: 's-c' });
    expect(await store.getEndpoint({ provider: 'fcm', installationId: 'b' })).toBeUndefined();
    expect((await store.listEndpoints({ player: 't2_me', provider: 'fcm' })).map((row) => row.installationId))
      .toEqual(['a', 'c']);
  });

  it('refuses send, history, and due times that do not parse before anything is written', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await expect(store.listDueSends({ at: 'x', limit: 1 })).rejects.toThrow(TypeError);
    await expect(store.listHistory({ player: 'p', since: 'x' })).rejects.toThrow(TypeError);
    await expect(store.addHistory({ sendKey: 'k', provider: 'devvit', player: 'p', topic: 't', at: 'x' }))
      .rejects.toThrow(TypeError);
    await expect(store.countHistory({ provider: 'devvit', since: 'x', until: '2026-10-19T00:00:00Z' }))
      .rejects.toThrow(TypeError);
    await expect(store.listDueScheduleEntries({ at: 'x', limit: 1 })).rejects.toThrow(TypeError);
    await expect(store.pruneConsent({ player: 'p', at: ['x'] })).rejects.toThrow(TypeError);
    expect(redis.keys()).toEqual([]);
  });

  it('counts provider history by rank, keeps the provider index through purge, and reads a reversed range as none', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    for (let index = 0; index < 1_200; index += 1) {
      await store.addHistory({
        sendKey: `k-${String(index)}`,
        provider: 'devvit',
        player: `t2_${String(index % 7)}`,
        topic: 't',
        at: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1_000).toISOString(),
      });
    }
    // More than one page of members, and equal bounds count a member at that instant.
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }))
      .toBe(1_200);
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:10Z', until: '2026-10-01T00:00:10Z' }))
      .toBe(1);
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:10Z', until: '2026-10-01T00:00:09Z' }))
      .toBe(0);
    expect(await store.countHistory({ provider: 'fcm', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }))
      .toBe(0);
    // Purge deletes the provider's index entries with the rows.
    expect((await store.purge({
      sendsChangedBefore: '2026-01-01T00:00:00Z',
      historyBefore: '2026-10-01T00:10:00Z',
      invalidEndpointsBefore: '2026-01-01T00:00:00Z',
      staleEndpointsBefore: '2026-01-01T00:00:00Z',
      sessionEndpointsBefore: '2026-01-01T00:00:00Z',
    })).history).toBe(600);
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }))
      .toBe(600);
    expect(await redis.zCard('mpgd:notifications:history-provider:devvit')).toBe(600);
  });

  it('counts members at the same millisecond at either bound, by rank without paging', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const at = (seconds: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + seconds * 1_000).toISOString();
    for (const [sendKey, seconds] of [['a', 0], ['b', 1], ['c', 1], ['d', 1], ['e', 2], ['f', 3], ['g', 3], ['h', 4]] as const) {
      await store.addHistory({ sendKey, provider: 'devvit', player: `t2_${sendKey}`, topic: 't', at: at(seconds) });
    }
    const zRange = redis.zRange.bind(redis);
    const ranges: unknown[] = [];
    redis.zRange = async (key, start, stop, options) => {
      ranges.push(options?.limit?.count);
      return zRange(key, start, stop, options);
    };
    expect(await store.countHistory({ provider: 'devvit', since: at(1), until: at(3) })).toBe(6);
    expect(await store.countHistory({ provider: 'devvit', since: at(3), until: at(3) })).toBe(2);
    // Each read takes one member: no page of the range is read.
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((count) => count === 1)).toBe(true);
  });

  it('reads the count again when a purge moves the ranks between the reads', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    for (const [sendKey, at] of [['old', '2026-09-01T00:00:00Z'], ['a', '2026-10-01T00:00:00Z'], ['b', '2026-10-01T00:00:01Z']] as const) {
      await store.addHistory({ sendKey, provider: 'devvit', player: 'p', topic: 't', at });
    }
    const zRank = redis.zRank.bind(redis);
    let purged = false;
    redis.zRank = async (key, member) => {
      const rank = await zRank(key, member);
      if (!purged) {
        // A purge removes the old row after the start rank was read.
        purged = true;
        await store.purge({
          sendsChangedBefore: '2026-01-01T00:00:00Z',
          historyBefore: '2026-09-15T00:00:00Z',
          invalidEndpointsBefore: '2026-01-01T00:00:00Z',
          staleEndpointsBefore: '2026-01-01T00:00:00Z',
          sessionEndpointsBefore: '2026-01-01T00:00:00Z',
        });
      }
      return rank;
    };
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }))
      .toBe(2);
  });

  it('counts by pages when the first member keeps leaving between the reads', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await store.addHistory({ sendKey: 'a', provider: 'devvit', player: 'p', topic: 't', at: '2026-10-01T00:00:00Z' });
    await store.addHistory({ sendKey: 'b', provider: 'devvit', player: 'p', topic: 't', at: '2026-10-01T00:00:01Z' });
    let ranks = 0;
    redis.zRank = async () => {
      ranks += 1;
      // Another writer removed the member just read.
      return undefined;
    };
    expect(await store.countHistory({ provider: 'devvit', since: '2026-10-01T00:00:00Z', until: '2026-10-01T00:00:01Z' }))
      .toBe(2);
    // Four tries, each reading the start rank twice (the end has no member past it), then pages.
    expect(ranks).toBe(8);
  });

  it('orders due schedule entries by code point with a member that holds no separator of its own', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const reminder = (player: string, id: string) => ({
      player,
      id,
      dueAt: '2026-10-19T03:00:00Z',
      item: { kind: 'reminder' as const, key: id, topic: 't', fireAt: '2026-10-19T03:00:00Z' },
    });
    // A player that is a prefix of another sorts first, though a space sorts before a quote in JSON.
    for (const [player, id] of [['a b', 'reminder:x'], ['a', 'reminder:y'], ['a.b', 'reminder:.'], ['', 'reminder:']] as const) {
      await store.createScheduleEntry(reminder(player, id));
    }
    expect(await store.listDueScheduleEntries({ at: '2026-10-19T03:00:00Z', limit: 10 })).toEqual([
      { player: '', id: 'reminder:' },
      { player: 'a', id: 'reminder:y' },
      { player: 'a b', id: 'reminder:x' },
      { player: 'a.b', id: 'reminder:.' },
    ]);
    // An index member that is not one this store writes is skipped.
    const index = await redis.watch();
    await index.multi();
    await index.zAdd('mpgd:notifications:schedule-due', { member: 'zz.not-hex', score: 0 });
    await index.exec();
    expect(await store.listDueScheduleEntries({ at: '2026-10-19T03:00:00Z', limit: 10 })).toHaveLength(4);
    expect(await store.countPendingReminders('a')).toBe(1);
    redis.poke('mpgd:notifications:schedule:a:reminder%3Ay', 'not json');
    await expect(store.getScheduleEntry({ player: 'a', id: 'reminder:y' })).rejects.toThrow(/not a schedule entry/u);
  });

  it('prunes consent records and their notices in one transaction', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    const record = await store.appendConsent({
      player: 'p',
      record: { kind: 'advertising', state: 'granted', source: 'player', textVersion: 'v1' },
      at: '2026-10-19T03:00:00Z',
    });
    await store.appendConsent({
      player: 'p',
      record: { kind: 'advertising', state: 'withdrawn', source: 'player', textVersion: 'v1' },
      at: '2026-10-19T03:00:00Z',
    });
    await store.addNoticeGiven({
      kind: 'consent-result',
      record: { kind: 'advertising', at: record.at },
      dueBy: '2026-11-01',
      player: 'p',
      channel: 'push',
      at: '2026-10-19T04:00:00Z',
    });
    // A writer touches the notices between the read and EXEC: the step reads again and still deletes both.
    let touched = false;
    redis.beforeExec = (watched) => {
      if (!touched && watched.includes('mpgd:notifications:notices:p')) {
        touched = true;
        redis.touch('mpgd:notifications:notices:p');
      }
    };
    expect(await store.pruneConsent({ player: 'p', at: [record.at] })).toBe(1);
    expect(redis.aborted).toBe(1);
    expect(await store.listNoticesGiven('p')).toEqual([]);
    expect(await store.listConsent('p')).toHaveLength(1);
  });

  it('lists history when hMGet is disabled', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await store.addHistory({
      sendKey: 'h-1',
      provider: 'devvit',
      player: 't2_player',
      topic: 't',
      at: '2026-10-19T03:00:00Z',
    });
    redis.disableHMGet();
    await expect(redis.hMGet('unused', ['field'])).rejects.toThrow(/HMGET/u);
    await expect(store.listHistory({ player: 't2_player', since: '2026-10-01T00:00:00Z' })).resolves.toEqual([
      expect.objectContaining({ sendKey: 'h-1', player: 't2_player' }),
    ]);
  });

  it('retries a transient watch or planning read and still throws a non-transient error', async () => {
    const redis = createFakeNotificationRedis();
    const backoffs: number[] = [];
    let watchThrows = 1;
    let getThrows = 1;
    const flaky = {
      ...redis,
      async get(key: string) {
        if (getThrows > 0) {
          getThrows -= 1;
          throw new Error('Redis transaction limit exceeded: 20 concurrent transactions');
        }
        return redis.get(key);
      },
      async watch(...watched: string[]) {
        if (watchThrows > 0) {
          watchThrows -= 1;
          throw new Error('transaction timed out after 5 seconds');
        }
        return redis.watch(...watched);
      },
    };
    const store = createDevvitRedisNotificationStore(flaky, {
      transactionAttempts: 4,
      backoff: async (attempt) => {
        backoffs.push(attempt);
      },
    });
    await expect(store.createSend(send('k', []))).resolves.toEqual(expect.any(String));
    expect(backoffs.length).toBeGreaterThan(0);
    expect(watchThrows).toBe(0);
    expect(getThrows).toBe(0);

    const fatal = {
      ...redis,
      async get(): Promise<string | undefined> {
        throw new Error('WRONGTYPE key is a hash');
      },
      watch: redis.watch.bind(redis),
    };
    const failing = createDevvitRedisNotificationStore(fatal, {
      transactionAttempts: 4,
      backoff: async () => {
        throw new Error('a non-transient error must not retry');
      },
    });
    await expect(failing.createSend(send('bad', []))).rejects.toThrow(/WRONGTYPE/u);
  });

  it('drops the in-flight index member when purge deletes an unreadable send', async () => {
    const redis = createFakeNotificationRedis();
    const store = createDevvitRedisNotificationStore(redis);
    await store.createSend(send('k', [claimed('holder', '2026-10-19T03:05:00Z')]));
    expect((await store.listInFlightSends('t2_player')).map((row) => row.key)).toEqual(['k']);
    const valueKey = redis.keys().find((key) => key.includes(':send:') && key.endsWith(':k'));
    expect(valueKey).toBeTypeOf('string');
    redis.poke(valueKey ?? '', '{not-a-send');
    await store.purge({
      sendsChangedBefore: '2026-11-01T00:00:00Z',
      historyBefore: '2026-11-01T00:00:00Z',
      invalidEndpointsBefore: '2026-11-01T00:00:00Z',
      staleEndpointsBefore: '2026-11-01T00:00:00Z',
      sessionEndpointsBefore: '2026-11-01T00:00:00Z',
    });
    expect(await store.listInFlightSends('t2_player')).toEqual([]);
    expect(redis.keys().filter((key) => key.includes('in-flight'))).toEqual([]);
  });

  it('rejects an empty namespace and out-of-range attempts', () => {
    const redis = createFakeNotificationRedis();
    expect(() => createDevvitRedisNotificationStore(redis, { namespace: '' })).toThrow(TypeError);
    expect(() => createDevvitRedisNotificationStore(redis, { transactionAttempts: 0 })).toThrow(TypeError);
    expect(() => createDevvitRedisNotificationStore(redis, { transactionAttempts: 65 })).toThrow(TypeError);
  });
});

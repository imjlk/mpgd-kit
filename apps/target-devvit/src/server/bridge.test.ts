import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import {
  createDevvitBridgeHandler,
  maxEncodedStorageKeyLength,
  maxStorageKeyLength,
  maxStorageKeysPerPlayer,
  maxStorageValueBytes,
  storageIndexKey,
  storageValueKey,
  type DevvitBridgeRedisLike,
  type DevvitBridgeRedisTransactionLike,
} from './bridge.js';

const playerId = 't2_player';

test('identity comes from the Devvit context and never from the payload', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, playerId);

  const session = await handler(request('identity.getSession', { playerId: 't2_attacker' }));
  assert.deepEqual(session, {
    id: 'req',
    ok: true,
    data: { identityLevel: 'authenticated', playerId, trustLevel: 'server-verified' },
  });

  const saved = await handler(request('storage.save', {
    playerId: 't2_attacker',
    key: 'slot',
    value: { level: 3 },
  }));
  assert.deepEqual(saved, { id: 'req', ok: true, data: { saved: true, playerId } });
  assert.equal(redis.strings.get(storageValueKey(playerId, 'slot')), '{"level":3}');
  assert.equal(redis.strings.has(storageValueKey('t2_attacker', 'slot')), false);

  const loaded = await handler(request('storage.load', { playerId: 't2_attacker', key: 'slot' }));
  assert.deepEqual(loaded, {
    id: 'req',
    ok: true,
    data: { __mpgdBridgeProtocol: 'mpgd.storage.load.v1', found: true, value: { level: 3 } },
  });
});

test('guests cannot load or save storage', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, undefined);

  assert.deepEqual(await handler(request('identity.getPlayer', {})), {
    id: 'req',
    ok: true,
    data: null,
  });
  assertError(
    await handler(request('storage.save', { key: 'slot', value: 1 })),
    'DEVVIT_STORAGE_IDENTITY_REQUIRED',
  );
  assertError(
    await handler(request('storage.load', { key: 'slot' })),
    'DEVVIT_STORAGE_IDENTITY_REQUIRED',
  );
  assert.equal(redis.strings.size, 0);
  assert.equal(redis.hashes.size, 0);
});

test('storage keys are namespaced per player and URI-encoded', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, 't2_a:b/c');

  const response = await handler(request('storage.save', { key: 'profile:main/é', value: true }));
  assert.equal(response.ok, true);
  assert.equal(storageValueKey('t2_a:b/c', 'profile:main/é'), 'mpgd:save:t2_a%3Ab%2Fc:profile%3Amain%2F%C3%A9');
  assert.equal(storageIndexKey('t2_a:b/c'), 'mpgd:save-keys:t2_a%3Ab%2Fc');
  assert.deepEqual([...redis.strings.keys()], ['mpgd:save:t2_a%3Ab%2Fc:profile%3Amain%2F%C3%A9']);
  assert.deepEqual(
    redis.hashes.get('mpgd:save-keys:t2_a%3Ab%2Fc'),
    new Map([['profile%3Amain%2F%C3%A9', '1']]),
  );

  assertError(await handler(request('storage.save', { key: '', value: 1 })), 'INVALID_STORAGE_KEY');
  assertError(await handler(request('storage.save', { value: 1 })), 'INVALID_STORAGE_KEY');
  assertError(
    await handler(request('storage.save', { key: 'k'.repeat(maxStorageKeyLength + 1), value: 1 })),
    'INVALID_STORAGE_KEY',
  );
  assertError(
    await handler(request('storage.save', { key: 'é'.repeat(maxStorageKeyLength), value: 1 })),
    'INVALID_STORAGE_KEY',
  );
  assert.ok('é'.repeat(maxStorageKeyLength).length <= maxStorageKeyLength);
  assert.ok(encodeURIComponent('é'.repeat(maxStorageKeyLength)).length > maxEncodedStorageKeyLength);
  assert.equal(redis.strings.size, 1);
});

test('values are capped by UTF-8 byte size and must be JSON serializable', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, playerId);

  // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes once JSON-quoted.
  const oversized = 'é'.repeat(Math.ceil(maxStorageValueBytes / 2));
  assertError(
    await handler(request('storage.save', { key: 'slot', value: oversized })),
    'DEVVIT_STORAGE_QUOTA_EXCEEDED',
  );
  assertError(
    await handler(request('storage.save', { key: 'slot', value: undefined })),
    'INVALID_STORAGE_VALUE',
  );
  assertError(
    await handler(request('storage.save', { key: 'slot', value: 1n })),
    'INVALID_STORAGE_VALUE',
  );
  assert.equal(redis.strings.size, 0);
  assert.equal(redis.hashes.size, 0);

  const fitting = 'a'.repeat(maxStorageValueBytes - 2);
  assert.equal((await handler(request('storage.save', { key: 'slot', value: fitting }))).ok, true);
});

test('each player may hold a bounded number of distinct storage keys', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, playerId);

  for (let index = 0; index < maxStorageKeysPerPlayer; index += 1) {
    const response = await handler(request('storage.save', { key: `slot-${String(index)}`, value: index }));
    assert.equal(response.ok, true, `save ${String(index)} should succeed`);
  }

  assertError(
    await handler(request('storage.save', { key: 'slot-overflow', value: 1 })),
    'DEVVIT_STORAGE_KEY_LIMIT',
  );
  assert.equal(redis.strings.has(storageValueKey(playerId, 'slot-overflow')), false);
  assert.equal(redis.hashes.get(storageIndexKey(playerId))?.size, maxStorageKeysPerPlayer);

  // Overwriting an existing key stays allowed at the cap.
  assert.equal((await handler(request('storage.save', { key: 'slot-0', value: 'again' }))).ok, true);
  assert.equal(redis.strings.get(storageValueKey(playerId, 'slot-0')), '"again"');
  assert.equal(redis.hashes.get(storageIndexKey(playerId))?.size, maxStorageKeysPerPlayer);

  // Another player's index is independent.
  const other = createHandler(redis, 't2_other');
  assert.equal((await other(request('storage.save', { key: 'slot-overflow', value: 1 }))).ok, true);
  assert.equal(redis.hashes.get(storageIndexKey('t2_other'))?.size, 1);
});

test('values written before the index existed are backfilled instead of counted as new', async () => {
  const redis = new FakeDevvitRedis();
  redis.strings.set(storageValueKey(playerId, 'legacy'), '"old"');
  const handler = createHandler(redis, playerId);

  for (let index = 0; index < maxStorageKeysPerPlayer; index += 1) {
    assert.equal((await handler(request('storage.save', { key: `slot-${String(index)}`, value: index }))).ok, true);
  }

  assert.equal((await handler(request('storage.save', { key: 'legacy', value: 'new' }))).ok, true);
  assert.equal(redis.strings.get(storageValueKey(playerId, 'legacy')), '"new"');
  assert.equal(redis.hashes.get(storageIndexKey(playerId))?.has('legacy'), true);
  assertError(
    await handler(request('storage.save', { key: 'slot-overflow', value: 1 })),
    'DEVVIT_STORAGE_KEY_LIMIT',
  );
});

test('index and value are written atomically and contention is retried', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, playerId);

  // Simulate a concurrent writer touching the index after WATCH on the first attempt.
  redis.onWatch = () => {
    redis.onWatch = undefined;
    redis.hashes.set(storageIndexKey(playerId), new Map([['concurrent', '1']]));
    redis.touch(storageIndexKey(playerId));
  };

  assert.equal((await handler(request('storage.save', { key: 'slot', value: 1 }))).ok, true);
  assert.equal(redis.execCalls, 2);
  assert.deepEqual(
    [...(redis.hashes.get(storageIndexKey(playerId)) ?? new Map()).keys()].sort(),
    ['concurrent', 'slot'],
  );
  assert.equal(redis.strings.get(storageValueKey(playerId, 'slot')), '1');

  // Persistent contention surfaces as a retryable save failure, not a partial write.
  redis.onWatch = () => {
    redis.touch(storageIndexKey(playerId));
  };
  const response = await handler(request('storage.save', { key: 'contended', value: 1 }));
  assertError(response, 'DEVVIT_STORAGE_SAVE_FAILED');
  assert.equal(response.ok === false && response.error.retryable, true);
  assert.equal(redis.strings.has(storageValueKey(playerId, 'contended')), false);
  assert.equal(redis.hashes.get(storageIndexKey(playerId))?.has('contended'), false);
});

test('a null EXEC result is retried as contention like the empty array', async () => {
  const redis = new FakeDevvitRedis();
  redis.abortedExecResult = null;
  const handler = createHandler(redis, playerId);

  redis.onWatch = () => {
    redis.onWatch = undefined;
    redis.touch(storageIndexKey(playerId));
  };

  assert.equal((await handler(request('storage.save', { key: 'slot', value: 1 }))).ok, true);
  assert.equal(redis.execCalls, 2);
  assert.equal(redis.strings.get(storageValueKey(playerId, 'slot')), '1');
  assert.equal(redis.hashes.get(storageIndexKey(playerId))?.has('slot'), true);
});

test('a truncated EXEC result is never reported as a completed save', async () => {
  const redis = new FakeDevvitRedis();
  redis.truncateExecResults = true;
  const handler = createHandler(redis, playerId);

  const response = await handler(request('storage.save', { key: 'slot', value: 1 }));
  assertError(response, 'DEVVIT_STORAGE_SAVE_FAILED');
  assert.equal(redis.execCalls, 3);
});

test('the storage key namespace is injectable for generated games', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createDevvitBridgeHandler({
    redis,
    currentPlayerId: () => playerId,
    currentDisplayName: async (id) => `u/${id}`,
    storageKeyNamespace: 'my-game',
    warn: () => {},
  });

  assert.equal((await handler(request('storage.save', { key: 'slot', value: 1 }))).ok, true);
  assert.equal(storageValueKey(playerId, 'slot', 'my-game'), 'my-game:save:t2_player:slot');
  assert.equal(storageIndexKey(playerId, 'my-game'), 'my-game:save-keys:t2_player');
  assert.deepEqual([...redis.strings.keys()], ['my-game:save:t2_player:slot']);
  assert.deepEqual([...redis.hashes.keys()], ['my-game:save-keys:t2_player']);
  assert.equal(redis.strings.has(storageValueKey(playerId, 'slot')), false);
  assert.throws(
    () => createDevvitBridgeHandler({
      redis,
      currentPlayerId: () => playerId,
      currentDisplayName: async (id) => `u/${id}`,
      storageKeyNamespace: '',
    }),
    TypeError,
  );
});

test('missing and corrupted values load with the storage protocol envelope', async () => {
  const redis = new FakeDevvitRedis();
  const handler = createHandler(redis, playerId);

  assert.deepEqual(await handler(request('storage.load', { key: 'missing' })), {
    id: 'req',
    ok: true,
    data: { __mpgdBridgeProtocol: 'mpgd.storage.load.v1', found: false },
  });

  redis.strings.set(storageValueKey(playerId, 'broken'), '{not json');
  assertError(await handler(request('storage.load', { key: 'broken' })), 'CORRUPTED_STORAGE_VALUE');
});

function createHandler(redis: FakeDevvitRedis, currentPlayerId: string | undefined) {
  return createDevvitBridgeHandler({
    redis,
    currentPlayerId: () => currentPlayerId,
    currentDisplayName: async (id) => `u/${id}`,
    warn: () => {},
  });
}

function request(method: BridgeRequest['method'], payload: unknown): BridgeRequest {
  return {
    id: 'req',
    method,
    payload,
    meta: {
      target: 'reddit',
      appVersion: '0.0.0-test',
      buildId: 'test',
      sentAt: '2026-10-03T00:00:00.000Z',
    },
  };
}

function assertError(response: BridgeResponse, code: string): void {
  assert.equal(response.ok, false, `expected bridge error ${code}`);
  if (response.ok === false) {
    assert.equal(response.error.code, code);
  }
}

/**
 * In-memory Devvit Redis double. WATCH records key versions; EXEC applies the
 * queued commands only when no watched key changed since WATCH, mirroring the
 * optimistic-locking semantics the bridge relies on. An aborted EXEC resolves
 * to an empty array by default, which is what `@devvit/redis` `TxClient.exec()`
 * returns for a WATCH conflict (it never resolves `null`).
 */
class FakeDevvitRedis implements DevvitBridgeRedisLike {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly versions = new Map<string, number>();
  execCalls = 0;
  onWatch: (() => void) | undefined;
  abortedExecResult: readonly unknown[] | null = [];
  truncateExecResults = false;

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async exists(...keys: readonly string[]): Promise<number> {
    return keys.filter((key) => this.strings.has(key) || this.hashes.has(key)).length;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hLen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  async watch(...keys: readonly string[]): Promise<DevvitBridgeRedisTransactionLike> {
    const watched = keys.map((key) => [key, this.version(key)] as const);
    this.onWatch?.();

    return new FakeTransaction(this, watched);
  }

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  touch(key: string): void {
    this.versions.set(key, this.version(key) + 1);
  }
}

class FakeTransaction implements DevvitBridgeRedisTransactionLike {
  private readonly queued: Array<() => void> = [];
  private inMulti = false;

  constructor(
    private readonly redis: FakeDevvitRedis,
    private readonly watched: ReadonlyArray<readonly [string, number]>,
  ) {}

  async multi(): Promise<void> {
    this.inMulti = true;
  }

  async discard(): Promise<void> {
    this.queued.length = 0;
    this.inMulti = false;
  }

  async set(key: string, value: string): Promise<void> {
    this.queue(() => {
      this.redis.strings.set(key, value);
      this.redis.touch(key);
    });
  }

  async hSet(key: string, fieldValues: Readonly<Record<string, string>>): Promise<void> {
    this.queue(() => {
      const hash = this.redis.hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fieldValues)) {
        hash.set(field, value);
      }
      this.redis.hashes.set(key, hash);
      this.redis.touch(key);
    });
  }

  async expire(): Promise<void> {
    this.queue(() => {});
  }

  async exec(): Promise<readonly unknown[] | null> {
    this.redis.execCalls += 1;
    const conflicted = this.watched.some(([key, version]) => this.redis.version(key) !== version);
    const queued = this.queued.splice(0);
    this.inMulti = false;

    if (conflicted) {
      return this.redis.abortedExecResult;
    }

    if (this.redis.truncateExecResults) {
      // Simulate a reply that lost commands without applying anything.
      return queued.slice(1).map(() => 'OK');
    }

    for (const apply of queued) {
      apply();
    }

    return queued.map(() => 'OK');
  }

  async unwatch(): Promise<void> {
    this.queued.length = 0;
  }

  private queue(apply: () => void): void {
    if (!this.inMulti) {
      throw new Error('Commands must be queued inside MULTI.');
    }

    this.queued.push(apply);
  }
}

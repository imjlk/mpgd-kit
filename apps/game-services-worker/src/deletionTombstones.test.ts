import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { encodeAdMobSsvCustomData } from '@mpgd/game-services';
import { Miniflare } from 'miniflare';

import { createD1AdMobSsvCallbackStore } from './admobSsvD1.js';
import { createAdMobSsvCallbackFetchHandler } from './admobSsvHandler.js';
import {
  AccountDeletedWriteError,
  accountDeletionTombstoneKeyOf,
  accountDeletionTombstoneTtlMs,
  argumentField,
  createAccountDeletionTombstoneEraser,
  createD1AccountDeletionTombstones,
  createMemoryAccountDeletionTombstones,
  refuseDeletedPlayerWrites,
  resolveAccountDeletionTombstones,
  type AccountDeletionTombstones,
} from './deletionTombstones.js';

// Account deletion tombstones: keyed, expiring, and refusing a deleted
// player's writes (docs/GAME_SERVICES_BACKEND.md#account-deletion).

const key = 'k'.repeat(48);
const timestamp = Date.now();
const placements = {
  version: 'admob-test',
  placements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
      reward: { type: 'continue', amount: 1 },
      frequencyCap: { cooldownSeconds: 60, maxPerSession: 3 },
      platformPlacementIds: { android: 'reward_continue' },
    },
  ],
} as const;
const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'deletion-tombstones' },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const migration of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
    await applyMigration(db, migration);
  }

  // The stored key: an HMAC of the id, never the id, and another key's differs.
  const stored = await accountDeletionTombstoneKeyOf(key, 'player-1');
  assert.match(stored, /^[0-9a-f]{64}$/u);
  assert.equal(await accountDeletionTombstoneKeyOf(key, 'player-1'), stored);
  assert.notEqual(await accountDeletionTombstoneKeyOf('x'.repeat(48), 'player-1'), stored);
  assert.ok(!stored.includes('player'));

  const start = new Date('2030-01-01T00:00:00.000Z');
  const later = (ms: number) => new Date(start.getTime() + ms);
  const behaves = async (tombstones: AccountDeletionTombstones) => {
    assert.equal(await tombstones.isDeleted('player-1', start), false);
    await tombstones.add('player-1', start);
    await tombstones.add('player-1', start);
    assert.equal(await tombstones.isDeleted('player-1', later(1)), true);
    assert.equal(await tombstones.isDeleted('player-2', later(1)), false);
    // A later add (the final pass) extends it; an earlier one never shortens it.
    await tombstones.add('player-1', later(60_000));
    await tombstones.add('player-1', start);
    assert.equal(
      await tombstones.isDeleted('player-1', later(accountDeletionTombstoneTtlMs)),
      true,
    );
    assert.equal(
      await tombstones.isDeleted('player-1', later(accountDeletionTombstoneTtlMs + 60_000)),
      false,
    );
    assert.equal(await tombstones.purgeExpired(later(accountDeletionTombstoneTtlMs)), 0);
    assert.equal(await tombstones.purgeExpired(later(accountDeletionTombstoneTtlMs + 60_000)), 1);
  };
  await behaves(createD1AccountDeletionTombstones(db, key));
  await behaves(createMemoryAccountDeletionTombstones(key));
  // D1 keeps only the keyed hash and its expiry.
  const d1 = createD1AccountDeletionTombstones(db, key);
  await d1.add('player-raw-id', start);
  const rows = (await db.prepare('SELECT * FROM account_deletion_tombstones').all()).results;
  assert.deepEqual(rows, [
    {
      player_key: await accountDeletionTombstoneKeyOf(key, 'player-raw-id'),
      expires_at: later(accountDeletionTombstoneTtlMs).toISOString(),
    },
  ]);
  assert.ok(!JSON.stringify(rows).includes('player-raw-id'));
  // The eraser writes the tombstone and erases nothing itself.
  const memory = createMemoryAccountDeletionTombstones(key);
  assert.deepEqual(
    await createAccountDeletionTombstoneEraser(memory, () => start)
      .erasePlayerData({ playerId: 'player-3', retainedPlayerId: 'deleted:d-3' }),
    { deleted: 0, retained: 0 },
  );
  assert.equal(await memory.isDeleted('player-3', later(1)), true);

  // Guarded writes refuse a deleted player before writing; the rest pass.
  {
    const calls: string[] = [];
    const target = {
      label: 'store',
      async record(input: { readonly playerId: string }) {
        calls.push(`record:${input.playerId}`);
        return this.label;
      },
      async read(input: { readonly playerId: string }) {
        calls.push(`read:${input.playerId}`);
        return 'read';
      },
    };
    const guarded = refuseDeletedPlayerWrites(target, memory, {
      record: argumentField('playerId'),
    });
    await assert.rejects(guarded.record({ playerId: 'player-3' }), AccountDeletedWriteError);
    assert.equal(await guarded.record({ playerId: 'player-4' }), 'store', 'this is the target');
    assert.equal(await guarded.read({ playerId: 'player-3' }), 'read');
    assert.equal(guarded.label, 'store');
    assert.deepEqual(calls, ['record:player-4', 'read:player-3']);
  }

  // Resolution: D1 needs a long enough key; a memory deployment keeps its own.
  assert.equal(resolveAccountDeletionTombstones({ MPGD_STORE: 'd1', DB: db }), undefined);
  const consoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    assert.equal(
      resolveAccountDeletionTombstones({
        MPGD_STORE: 'd1',
        DB: db,
        GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: 'short',
      }),
      undefined,
    );
  } finally {
    console.error = consoleError;
  }
  assert.match(String(errors[0]?.[0]), /at least 32 characters/u);
  assert.ok(
    resolveAccountDeletionTombstones({
      MPGD_STORE: 'd1',
      DB: db,
      GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY: key,
    }) !== undefined,
  );
  assert.equal(
    resolveAccountDeletionTombstones({ MPGD_STORE: 'memory' }),
    resolveAccountDeletionTombstones({}),
  );

  // A verified AdMob SSV callback Google delivers late for a deleted player
  // is acknowledged (so Google stops retrying) and not kept.
  {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const publicKeySpki = Buffer.from(await crypto.subtle.exportKey('spki', keyPair.publicKey))
      .toString('base64');
    const tombstones = createD1AccountDeletionTombstones(db, key);
    await tombstones.add('ssv-deleted', new Date(timestamp));
    const intake = createAdMobSsvCallbackFetchHandler({
      db,
      placements,
      adUnits: { android: 'reward_continue' },
      fetcher: (async () => Response.json({ keys: [{ keyId: 1, base64: publicKeySpki }] })) as typeof fetch,
      now: () => new Date(timestamp + 1_000),
      isPlayerDeleted: (playerId) => tombstones.isDeleted(playerId),
    });
    const callbacks = createD1AdMobSsvCallbackStore(db);
    const operation = (playerId: string) => ({
      target: 'android',
      playerId,
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: `reward-${playerId}`,
    } as const);
    for (const [playerId, transactionId] of [
      ['ssv-deleted', 'aa11'],
      ['ssv-live', 'bb22'],
    ] as const) {
      const url = await signedCallback(
        keyPair.privateKey,
        playerId,
        `reward-${playerId}`,
        transactionId,
      );
      assert.equal((await intake(new Request(url)))?.status, 200, playerId);
    }
    assert.equal(await callbacks.find(operation('ssv-deleted')), undefined);
    assert.equal((await callbacks.find(operation('ssv-live')))?.transactionId, 'bb22');
  }

  console.info('Account deletion tombstones passed.');
} finally {
  await miniflare.dispose();
}

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const sql = (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  // Statements end at `;`, except inside a trigger body (BEGIN ... END;).
  let pending = '';
  for (const piece of sql.split(';')) {
    pending = pending.length === 0 ? piece : `${pending};${piece}`;
    const statement = pending.trim();
    if (statement.length === 0) {
      pending = '';
      continue;
    }
    if (/\bCREATE\s+TRIGGER\b/iu.test(statement) && !/\bEND$/iu.test(statement)) {
      continue;
    }
    await db.prepare(statement).run();
    pending = '';
  }
}

async function signedCallback(
  privateKey: CryptoKey,
  playerId: string,
  idempotencyKey: string,
  transactionId: string,
): Promise<string> {
  const customData = encodeURIComponent(
    encodeAdMobSsvCustomData({
      playerId,
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey,
    }),
  );
  const query = [
    'ad_network=5450213213286189855',
    'ad_unit=reward_continue',
    `custom_data=${customData}`,
    'reward_amount=1',
    'reward_item=continue',
    `timestamp=${String(timestamp)}`,
    `transaction_id=${transactionId}`,
    `user_id=${playerId}`,
  ].join('&');
  const signedBytes = new TextEncoder().encode(decodeURIComponent(query));
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    signedBytes,
  ));
  const signature = Buffer.from(derSignature(rawSignature)).toString('base64url');
  return `https://game.test/admob/ssv/android?${query}&signature=${signature}&key_id=1`;
}

function derSignature(raw: Uint8Array): Uint8Array {
  const first = encodeDerInteger(raw.subarray(0, 32));
  const second = encodeDerInteger(raw.subarray(32));
  const length = first.length + second.length;
  return Uint8Array.of(0x30, length, ...first, ...second);
}

function encodeDerInteger(component: Uint8Array): Uint8Array {
  let start = 0;
  while (start < component.length - 1 && component[start] === 0) {
    start += 1;
  }
  const bytes = component.subarray(start);
  const positive = (bytes[0] ?? 0) >= 0x80 ? Uint8Array.of(0, ...bytes) : bytes;
  return Uint8Array.of(0x02, positive.length, ...positive);
}

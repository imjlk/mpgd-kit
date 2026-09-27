import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { Miniflare } from 'miniflare';

import { createD1AdMobSsvCallbackStore, type VerifiedAdMobSsvCallback } from './admobSsvD1.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'admob-ssv-callbacks' },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  const migration = await readFile(
    new URL('../migrations/0005_admob_ssv_callbacks.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration.replace(/\s+/gu, ' ').trim());
  const store = createD1AdMobSsvCallbackStore(db);
  const callback: VerifiedAdMobSsvCallback = {
    transactionId: 'aabbccdd',
    target: 'android',
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'reward-1',
    callbackUrl: 'https://game.test/admob/ssv/android?transaction_id=aabbccdd',
    acceptedAdUnit: 'reward_continue',
    keyId: '123',
    publicKeySpki: 'base64-spki',
    receivedAt: '2026-09-27T00:00:00.000Z',
  };
  assert.equal(await store.find(callback), undefined);
  assert.equal(await store.record(callback), 'created');
  assert.deepEqual(await store.find(callback), callback);
  assert.equal(await store.record(callback), 'already-recorded');
  assert.equal(await store.record({ ...callback, playerId: 'player-2' }), 'conflict');
  assert.equal(await store.record({ ...callback, transactionId: 'eeff0011' }), 'conflict');
  assert.equal(await store.record({ ...callback, callbackUrl: 'https://other.test/' }), 'conflict');
  assert.deepEqual(await store.find(callback), callback);
  const concurrent = await Promise.all([
    store.record({ ...callback, transactionId: '33445566', idempotencyKey: 'reward-2' }),
    store.record({ ...callback, transactionId: '33445566', idempotencyKey: 'reward-2' }),
  ]);
  assert.deepEqual([...concurrent].sort(), ['already-recorded', 'created']);
  console.info('D1 AdMob SSV callback uniqueness passed.');
} finally {
  await miniflare.dispose();
}

import assert from 'node:assert/strict';

import { fetchAdMobSsvPublicKeySpki } from './admobSsvKeys.js';

let called = 0;
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  called += 1;
  assert.equal(String(input), 'https://www.gstatic.com/admob/reward/verifier-keys.json');
  assert.equal(init?.redirect, 'error');
  return Response.json({
    keys: [
      { keyId: 1, base64: 'YWJj' },
      { keyId: 2, base64: 'ZGVm' },
    ],
  });
}) as typeof fetch;

assert.equal(await fetchAdMobSsvPublicKeySpki('2', { fetcher }), 'ZGVm');
assert.equal(await fetchAdMobSsvPublicKeySpki('3', { fetcher }), undefined);
assert.equal(await fetchAdMobSsvPublicKeySpki('bad', { fetcher }), undefined);
assert.equal(called, 2);
const duplicateFetcher = (async () => Response.json({
  keys: [{ keyId: 1, base64: 'YWJj' }, { keyId: '1', base64: 'ZGVm' }],
})) as typeof fetch;
await assert.rejects(
  fetchAdMobSsvPublicKeySpki('1', { fetcher: duplicateFetcher }),
  /duplicate key ID/u,
);
const oversizedFetcher = (async () => new Response('x'.repeat(70_000))) as typeof fetch;
await assert.rejects(
  fetchAdMobSsvPublicKeySpki('1', { fetcher: oversizedFetcher }),
  /size limit/u,
);
const originalFetch = globalThis.fetch;
globalThis.fetch = fetcher;
try {
  const beforeCache = called;
  assert.equal(await fetchAdMobSsvPublicKeySpki('2'), 'ZGVm');
  assert.equal(await fetchAdMobSsvPublicKeySpki('2'), 'ZGVm');
  assert.equal(await fetchAdMobSsvPublicKeySpki('3'), undefined);
  assert.equal(called, beforeCache + 1, 'a cached feed also covers unknown key IDs');
} finally {
  globalThis.fetch = originalFetch;
}
console.info('AdMob SSV public key feed validation passed.');

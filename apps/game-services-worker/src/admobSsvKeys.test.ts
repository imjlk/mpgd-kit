import assert from 'node:assert/strict';

import { fetchAdMobSsvPublicKeySpki } from './admobSsvKeys.js';

let called = 0;
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  called += 1;
  assert.equal(String(input), 'https://www.gstatic.com/admob/reward/verifier-keys.json');
  assert.equal(init?.redirect, 'manual');
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
  keys: [
    { keyId: 1, base64: 'YWJj' },
    { keyId: '1', base64: 'ZGVm' },
  ],
})) as typeof fetch;
await assert.rejects(
  fetchAdMobSsvPublicKeySpki('1', { fetcher: duplicateFetcher }),
  /duplicate key ID/u,
);
const oversizedFetcher = (async () => new Response('x'.repeat(70_000))) as typeof fetch;
await assert.rejects(fetchAdMobSsvPublicKeySpki('1', { fetcher: oversizedFetcher }), /size limit/u);
// Workers only support manual redirects; a 3xx with a plausible key feed must fail closed.
let redirectInit: RequestInit | undefined;
const redirectFetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
  redirectInit = init;
  return Response.json(
    { keys: [{ keyId: 1, base64: 'YWJj' }] },
    { status: 302, headers: { Location: 'https://attacker.example/verifier-keys.json' } },
  );
}) as typeof fetch;
await assert.rejects(fetchAdMobSsvPublicKeySpki('1', { fetcher: redirectFetcher }), /HTTP 302/u);
assert.equal(redirectInit?.redirect, 'manual');
const followedFetcher = (async () => {
  const response = Response.json({ keys: [{ keyId: 1, base64: 'YWJj' }] });
  Object.defineProperty(response, 'redirected', { value: true });
  return response;
}) as typeof fetch;
await assert.rejects(fetchAdMobSsvPublicKeySpki('1', { fetcher: followedFetcher }), /HTTP 200/u);
const originalFetch = globalThis.fetch;
globalThis.fetch = fetcher;
try {
  const beforeCache = called;
  const concurrent = await Promise.all([
    fetchAdMobSsvPublicKeySpki('2'),
    fetchAdMobSsvPublicKeySpki('2'),
    fetchAdMobSsvPublicKeySpki('3'),
  ]);
  assert.deepEqual(concurrent, ['ZGVm', 'ZGVm', undefined]);
  assert.equal(await fetchAdMobSsvPublicKeySpki('2'), 'ZGVm');
  assert.equal(called, beforeCache + 1, 'concurrent and cached lookups share one feed');
} finally {
  globalThis.fetch = originalFetch;
}
console.info('AdMob SSV public key feed validation passed.');

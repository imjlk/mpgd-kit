import assert from 'node:assert/strict';
import { createAppsInTossPartnerApiClient } from './apps-in-toss-partner-api';

const calls: Array<{ url: string; init?: RequestInit }> = [];
const client = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch(url, init) {
      calls.push({ url, ...(init ? { init } : {}) });
      return Response.json({
        resultType: 'SUCCESS',
        success: { anonKey: 'verified-opaque-identity' },
      });
    },
  },
});
assert.deepEqual(await client.exchangeAnonymousAuthorizationCode({ code: 'sdk-issued-code' }), {
  anonymousKey: 'verified-opaque-identity',
});
assert.equal(calls.length, 1);
assert.equal(
  calls[0]?.url,
  'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/users/anon-key/exchange',
);
assert.equal(calls[0]?.init?.redirect, 'error');
assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { code: 'sdk-issued-code' });

for (const body of [
  { resultType: 'FAIL', success: { anonKey: 'forged' } },
  { resultType: 'HTTP_TIMEOUT', success: { anonKey: 'forged' } },
  { resultType: 'SUCCESS', success: { anonKey: '' } },
]) {
  const rejected = createAppsInTossPartnerApiClient({
    mtls: {
      async fetch() {
        return Response.json(body);
      },
    },
  });
  await assert.rejects(rejected.exchangeAnonymousAuthorizationCode({ code: 'code' }), {
    name: 'AppsInTossPartnerApiError',
  });
}

const aborted = new AbortController();
aborted.abort(new Error('private-abort-reason'));
const before = calls.length;
await assert.rejects(
  client.exchangeAnonymousAuthorizationCode({ code: 'code', signal: aborted.signal }),
  { code: 'ABORTED' },
);
assert.equal(calls.length, before);

let failedCalls = 0;
const failed = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch() {
      failedCalls++;
      throw new Error('private-provider-code');
    },
  },
});
await assert.rejects(failed.exchangeAnonymousAuthorizationCode({ code: 'code' }), (error) => {
  assert.equal((error as { code?: string }).code, 'UPSTREAM_UNAVAILABLE');
  assert.ok(!String(error).includes('private-provider-code'));
  return true;
});
assert.equal(failedCalls, 1);

const oversized = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch() {
      return new Response('ignored', { headers: { 'content-length': String(10 * 1024 * 1024) } });
    },
  },
});
await assert.rejects(oversized.exchangeAnonymousAuthorizationCode({ code: 'code' }), {
  code: 'UPSTREAM_UNAVAILABLE',
});

const timeout = createAppsInTossPartnerApiClient({
  timeoutMs: 5,
  mtls: {
    async fetch(_url, init) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('private', 'AbortError')),
          { once: true },
        );
      });
    },
  },
});
await assert.rejects(timeout.exchangeAnonymousAuthorizationCode({ code: 'code' }), {
  code: 'TIMEOUT',
});
console.log('AIT anonymous auth integration passed.');

const prefixed = createAppsInTossPartnerApiClient({
  baseUrl: 'https://proxy.example/toss/',
  mtls: {
    async fetch(url) {
      assert.equal(
        url,
        'https://proxy.example/toss/api-partner/v1/apps-in-toss/users/anon-key/exchange',
      );
      return Response.json({ resultType: 'SUCCESS', success: { anonKey: 'identity' } });
    },
  },
});
assert.deepEqual(await prefixed.exchangeAnonymousAuthorizationCode({ code: 'code' }), {
  anonymousKey: 'identity',
});

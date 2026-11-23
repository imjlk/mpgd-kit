import assert from 'node:assert/strict';

import {
  HttpBodyError,
  readBoundedJsonRequest,
  readBoundedJsonResponse,
  readBoundedRequestText,
  readBoundedResponseText,
} from '@mpgd/platform/http-body';

const json = { 'Content-Type': 'application/json' };
const post = (body, headers = json) =>
  new Request('https://game.example/api', { method: 'POST', headers, body });
const refused = (code, status) => (error) =>
  error instanceof HttpBodyError && error.code === code && error.status === status;

assert.deepEqual(await readBoundedJsonRequest(post('{"score":1}'), 64), { score: 1 });
assert.equal(await readBoundedRequestText(post('plain', {}), 64), 'plain');
assert.deepEqual(await readBoundedJsonResponse(new Response('[1]', { headers: json }), 64), [1]);
assert.equal(await readBoundedResponseText(new Response(null), 64), '');

await assert.rejects(
  readBoundedJsonResponse(new Response('x'.repeat(65), { headers: json }), 64),
  refused('BODY_TOO_LARGE', 413),
);
await assert.rejects(
  readBoundedJsonRequest(post('{}', { 'Content-Type': 'text/plain' }), 64),
  refused('JSON_REQUIRED', 415),
);
await assert.rejects(
  readBoundedResponseText(new Response(new Uint8Array([0xff])), 64),
  refused('INVALID_UTF8', 400),
);
await assert.rejects(
  readBoundedJsonResponse(new Response('{', { headers: json }), 64),
  refused('INVALID_JSON', 400),
);
const stalled = new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
  headers: json,
});
await assert.rejects(
  readBoundedJsonResponse(stalled, 64, { timeoutMs: 5 }),
  refused('BODY_READ_TIMEOUT', 408),
);

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { probeAppleSdk, probeGooglePublisher } from '../dist/index.js';

async function mockServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('Google Android Publisher creates an edit using the compiled client', async (t) => {
  const { server, baseUrl } = await mockServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer compatibility-fixture-token');
    assert.match(request.url ?? '', /\/androidpublisher\/v3\/applications\/dev\.mpgd\.compat\/edits/u);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'mock-edit-id' }));
  });
  t.after(() => server.close());
  assert.equal(await probeGooglePublisher(baseUrl), 'mock-edit-id');
});

test('Apple SDK candidate reads a mocked build response from compiled JavaScript', async (t) => {
  const { server, baseUrl } = await mockServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v1/builds');
    assert.equal(request.headers.authorization, 'Bearer compatibility-fixture-token');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ type: 'builds', id: 'mock-build-id' }] }));
  });
  t.after(() => server.close());
  assert.equal(await probeAppleSdk(baseUrl), 'mock-build-id');
});

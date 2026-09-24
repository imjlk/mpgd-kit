import assert from 'node:assert/strict';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import { GameServicesBackendError } from '@mpgd/game-services/client';
import { createGuestSessionCoordinator } from '@mpgd/game-services/guest-session';

let defaultFetchCalls = 0;
globalThis.fetch = async () => {
  defaultFetchCalls += 1;
  throw new Error('Default fetch must not run for an injected transport.');
};

const requests = [];
const gateway = {
  target: 'android',
  commerce: {
    async purchase(input) {
      return {
        status: 'completed',
        transactionId: `native-${input.idempotencyKey}`,
        entitlementIds: [],
      };
    },
  },
};
let authorization = 'Bearer first';
const runtime = createGameServicesRuntime({
  gateway,
  playerId: 'packed-player',
  authorityMode: 'production',
  baseUrl: 'https://api.example.com',
  httpTransport: {
    async send(request) {
      requests.push(request);
      return {
        status: request.body.idempotencyKey === 'failed' ? 503 : 200,
        body: { verified: true, ledgerEntryId: 'packed-ledger', alreadyProcessed: false },
      };
    },
  },
  getHeaders: () => ({ authorization }),
});
assert.equal(runtime.mode, 'http');
assert.ok(runtime.client);

const first = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'first',
});
assert.equal(first.status, 'granted');
authorization = 'Bearer refreshed';
const second = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'second',
});
assert.equal(second.status, 'granted');
assert.deepEqual(requests.map((request) => request.headers.authorization), [
  'Bearer first', 'Bearer refreshed',
]);
assert.equal(defaultFetchCalls, 0);

await assert.rejects(runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'failed',
}), (error) => error instanceof GameServicesBackendError && error.status === 503);
assert.equal(defaultFetchCalls, 0);

const secureValues = new Map();
const guest = createGuestSessionCoordinator({
  installationId: 'packed-installation',
  credentials: {
    async load({ key }) { return secureValues.get(key) ?? null; },
    async save({ key, value }) { secureValues.set(key, value); },
    async remove({ key }) { secureValues.delete(key); },
  },
  backend: {
    async issueGuest() {
      return {
        serverUserId: 'packed-server-user', sessionId: 'packed-session',
        identityLevel: 'guest', accessToken: 'packed-access',
        refreshToken: 'packed-refresh', accessExpiresAt: '2030-01-01T00:00:00Z',
      };
    },
    async refresh() { throw new Error('Unexpected refresh'); },
    async revoke() {},
    async bindAccount() { return { status: 'conflict' }; },
  },
  now: () => Date.parse('2029-01-01T00:00:00Z'),
});
const session = await guest.start();
assert.equal(session.serverUserId, 'packed-server-user');
assert.equal(Object.hasOwn(session, 'accessToken'), false);
assert.deepEqual(guest.getHeaders(), { authorization: 'Bearer packed-access' });
await guest.logout();
assert.equal(secureValues.size, 0);
console.info('Packed @mpgd/game-services custom runtime transport passed.');

import assert from 'node:assert/strict';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import { GameServicesBackendError } from '@mpgd/game-services/client';

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
console.info('Packed @mpgd/game-services custom runtime transport passed.');

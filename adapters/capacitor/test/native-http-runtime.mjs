import assert from 'node:assert/strict';

import { createCapacitorNativeJsonTransport } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';

const baseUrl = 'https://api.example.com';
const sent = [];
const httpTransport = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl,
  allowedOrigin: baseUrl,
  getPlatform: () => 'android',
  http: {
    async request(options) {
      sent.push(options);
      return {
        status: 200,
        url: options.url,
        headers: { 'content-type': 'application/json' },
        data: { verified: true, ledgerEntryId: 'native-ledger', alreadyProcessed: false },
      };
    },
  },
});
let defaultFetchCalls = 0;
globalThis.fetch = async () => {
  defaultFetchCalls += 1;
  throw new Error('Default fetch must not run.');
};
const runtime = createGameServicesRuntime({
  gateway: {
    target: 'android',
    commerce: {
      async purchase() {
        return { status: 'completed', transactionId: 'native-transaction', entitlementIds: [] };
      },
    },
  },
  playerId: 'native-player',
  authorityMode: 'production',
  baseUrl,
  transport: 'http',
  httpTransport,
  getHeaders: () => ({ authorization: 'Bearer current' }),
});
const result = await runtime.client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'native-operation',
});
assert.equal(result.status, 'granted');
assert.equal(result.ledgerEntryId, 'native-ledger');
assert.equal(sent.length, 1);
assert.equal(sent[0].headers.authorization, 'Bearer current');
assert.equal(defaultFetchCalls, 0);
console.info('Public Capacitor native HTTP and Game Services runtime composition passed.');

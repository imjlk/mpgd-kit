import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMicrosoftStoreNativeBridgeClient } from '@mpgd/adapter-browser/microsoft-store-native';

const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const listeners = new Set();
const webView = {
  postMessage(request) {
    const response = JSON.parse(fixtures[request.method]);
    response.requestId = request.requestId;
    queueMicrotask(() => { for (const listener of listeners) listener({ data: response }); });
  },
  addEventListener(_event, listener) { listeners.add(listener); },
  removeEventListener(_event, listener) { listeners.delete(listener); },
};
const client = createMicrosoftStoreNativeBridgeClient({ webView });
try {
  assert.equal((await client.getDetails(['wire.coins']))[0].itemId, 'wire.coins');
  assert.equal((await client.signIn()).playerId, 'fixture-player');
  assert.equal((await client.listPurchases())[0].purchaseToken, 'wire.coins');
  assert.deepEqual(await client.requestPurchase('wire.coins'), { status: 'succeeded', purchaseToken: 'wire.coins' });
  console.log('C# serialized results accepted by the public TypeScript bridge client: 4');
} finally { client.dispose(); }

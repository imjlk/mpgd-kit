import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const requireFromConsumer = createRequire(join(process.argv[3], 'package.json'));
const { createMicrosoftStoreNativeBridgeClient } = await import(
  pathToFileURL(requireFromConsumer.resolve('@mpgd/adapter-browser/microsoft-store-native')).href,
);

const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const listeners = new Set();
const webView = {
  postMessage(request) {
    const key = request.method === 'catalog.getDetails' && request.payload.itemIds.length > 1
      ? 'catalog.getDetails.large' : request.method;
    const response = JSON.parse(fixtures[key]);
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
  const largeCatalog = await client.getDetails(Array.from({ length: 64 }, (_value, index) => `wire.coins.${index}`));
  assert.equal(largeCatalog.length, 64);
  assert.equal(largeCatalog[63].description.length, 4096);
  console.log('C# serialized results accepted by the public TypeScript bridge client: 5 (including a large localized catalog)');
} finally { client.dispose(); }

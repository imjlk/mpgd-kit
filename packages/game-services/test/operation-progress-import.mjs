import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createGameServicesClient } from '@mpgd/game-services/client';

const events = [];
const client = createGameServicesClient({
  target: 'reddit', playerId: 'compiled-consumer', gateway: {}, backend: {},
});
const result = await client.purchase({
  productId: 'COINS_100', source: 'shop', idempotencyKey: 'compiled-consumer-key',
}, { onProgress: (event) => events.push(event) });
assert.equal(result.status, 'rejected');
assert.deepEqual(events, [{ phase: 'completed', status: 'rejected', kind: 'purchase', sequence: 1 }]);
assert.equal(Object.isFrozen(events[0]), true);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const entrypoint of Object.keys(manifest.exports)) {
  await import(`@mpgd/game-services${entrypoint === '.' ? '' : entrypoint.slice(1)}`);
}
console.log('Game services compiled client progress import passed');

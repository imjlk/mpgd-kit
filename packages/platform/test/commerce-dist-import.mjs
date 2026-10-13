import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assertCommerceCapabilities,
  assertCommerceEventEnvelope,
  assertRequestPurchaseSupported,
  canTransitionCommercePurchase,
  CommerceError,
  commerceProtocol,
  commerceProtocolVersion,
  createCommerceEventBuffer,
  createDerivedPurchaseIdempotencyKey,
  createUnsupportedCommerceCapabilities,
  summarizeCommercePurchaseState,
} from '@mpgd/platform/commerce';
import {
  assertCommerceConformanceVector,
  commerceConformanceVectorNameOf,
} from '@mpgd/platform/commerce-vectors';

assert.equal(commerceProtocolVersion, '2.0.0-draft.1');
assert.equal(commerceProtocol, 'mpgd.commerce.v2');
assert.equal(canTransitionCommercePurchase('granted', 'finishing'), true);
assert.equal(canTransitionCommercePurchase('finished', 'granted'), false);
assert.equal(summarizeCommercePurchaseState('finishing'), 'granted');

const unsupported = createUnsupportedCommerceCapabilities();
assert.equal(unsupported.availability, 'unsupported');
assert.notEqual(createUnsupportedCommerceCapabilities(), unsupported);
assertCommerceCapabilities(unsupported);
assert.throws(() => assertCommerceCapabilities({ ...unsupported, extra: true }));

const error = new CommerceError('STORE_UNAVAILABLE', { storeCode: 'packed-unavailable' });
assert.equal(error.retryable, true);
assert.deepEqual(error.toCommerceErrorInfo(), {
  code: 'STORE_UNAVAILABLE', retryable: true, storeCode: 'packed-unavailable',
  message: 'Commerce operation failed: STORE_UNAVAILABLE.',
});
assert.throws(
  () => assertRequestPurchaseSupported(
    unsupported, { logicalId: 'gems', idempotencyKey: 'op-1', source: 'shop' }, 'consumable',
  ),
  (thrown) => thrown instanceof CommerceError && thrown.code === 'ITEM_UNAVAILABLE',
);

assert.equal(
  await createDerivedPurchaseIdempotencyKey({ store: 'packed', transactionId: 'tx-1', token: 't' }),
  'store:packed:tx-1',
);

const purchase = {
  store: 'packed',
  transactionId: 'tx-1',
  storeSku: 'gems.small',
  logicalId: 'gems_small',
  quantity: 1,
  state: 'purchased',
  token: 'token-1',
  evidence: { schema: 'packed.purchase.v1', payload: { token: 'token-1' } },
};
assertCommerceEventEnvelope({
  protocol: commerceProtocol, sequence: 0, event: { type: 'purchaseUpdated', purchase },
});
const buffer = createCommerceEventBuffer({ limit: 1 });
buffer.push({ type: 'purchaseUpdated', purchase });
buffer.push({ type: 'purchaseError', error: { code: 'USER_CANCELLED', retryable: false } });
const drained = [];
buffer.drain((event) => drained.push(event.type));
assert.deepEqual(drained, ['purchaseError']);

const commerceModule = await import('@mpgd/platform/commerce');
for (const removed of ['toCommerceAdapter', 'deriveLegacyCommerceCapabilities']) {
  assert.equal(removed in commerceModule, false, `${removed} was removed in C4`);
}
const platformModule = await import('@mpgd/platform');
assert.equal('findAuthoritativePurchaseSettlement' in platformModule, false);
assert.equal(platformModule.createUnsupportedCapabilities().commerce.availability, 'unsupported');
assert.equal('nativeIap' in platformModule.createUnsupportedCapabilities(), false);

const vectorPath = new URL(
  '../../../docs/specs/commerce/vectors/purchase-client-finish.json', import.meta.url,
);
const vector = assertCommerceConformanceVector(JSON.parse(readFileSync(vectorPath, 'utf8')));
assert.equal(vector.vector, commerceConformanceVectorNameOf(vectorPath.pathname));
assert.equal(vector.protocol, commerceProtocolVersion);
console.info('Commerce contract and vector dist entrypoints passed.');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createAppsInTossPurchaseIdempotencyKey } from '@mpgd/game-services/apps-in-toss-evidence-verification';
import * as googlePlayPurchase from '@mpgd/game-services/google-play-purchase';
import {
  createDerivedPurchaseIdempotencyKey,
  createGooglePlayTokenPurchaseKey,
} from '@mpgd/platform/commerce';

// A4 replaced the two `createGooglePlayTokenTransactionId` copies with the
// platform helper and C4 removed the aliases. The helper must keep the v1
// `play-token-sha256:<hex>` form byte for byte so ledgers written by v1 keep
// deduplicating; the expected digest comes from Node's own SHA-256.
assert.equal('createGooglePlayTokenTransactionId' in googlePlayPurchase, false);

const tokens = [
  'abc.def-ghi_123',
  'a',
  'x'.repeat(4096),
  'ping.AO-J1OxyZ0123456789_abcdefghijklmnopqrstuvwxyz',
  'unicode-\ud55c\uae00',
  'slash/token+value',
];

for (const token of tokens) {
  const expected = `play-token-sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
  assert.equal(await createGooglePlayTokenPurchaseKey(token), expected);
  assert.equal(
    await createDerivedPurchaseIdempotencyKey({
      store: 'google-play',
      transactionId: 'GPA.0000-0000-0000-00000',
      token,
    }),
    expected,
  );
  assert.match(expected, /^play-token-sha256:[0-9a-f]{64}$/u);
}

for (const invalid of [
  '',
  ' padded',
  'trailing ',
  'x'.repeat(4097),
  'line\nbreak',
  'control\u0001byte',
]) {
  await assert.rejects(createGooglePlayTokenPurchaseKey(invalid), TypeError);
}

// C1: the Apps in Toss form must match the v1 helper byte for byte, reserved
// characters included, so a purchase the reconciler discovers deduplicates
// against ledger entries the v1 adapter wrote.
for (const orderId of ['ait-order-1', 'order:with/reserved?chars&more', 'unicode-한글']) {
  const expected = createAppsInTossPurchaseIdempotencyKey(orderId);
  assert.equal(expected, `apps-in-toss:purchase:${encodeURIComponent(orderId)}`);
  assert.equal(
    await createDerivedPurchaseIdempotencyKey({
      store: 'apps-in-toss',
      transactionId: orderId,
      token: orderId,
    }),
    expected,
  );
}

console.info('Commerce derived purchase key parity passed.');

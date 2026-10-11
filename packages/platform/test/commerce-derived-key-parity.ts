import assert from 'node:assert/strict';

import { createGooglePlayTokenTransactionId } from '@mpgd/game-services/google-play-purchase';
import {
  createDerivedPurchaseIdempotencyKey,
  createGooglePlayTokenPurchaseKey,
} from '@mpgd/platform/commerce';

// The platform helper must reproduce the v1 Google Play key byte for byte so
// ledgers written by v1 keep deduplicating once A4 replaces the two copies.
const tokens = [
  'abc.def-ghi_123',
  'a',
  'x'.repeat(4096),
  'ping.AO-J1OxyZ0123456789_abcdefghijklmnopqrstuvwxyz',
];

for (const token of tokens) {
  const expected = await createGooglePlayTokenTransactionId(token);
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

for (const invalid of ['', ' padded', 'x'.repeat(4097), 'line\nbreak']) {
  await assert.rejects(createGooglePlayTokenTransactionId(invalid), TypeError);
  await assert.rejects(createGooglePlayTokenPurchaseKey(invalid), TypeError);
}

console.info('Commerce derived purchase key parity passed.');

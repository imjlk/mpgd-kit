import assert from 'node:assert/strict';

import type { ProductCatalog } from '@mpgd/catalog';

import { listActiveEntitlementTransactions } from './commerce-ledger.js';
import {
  createGooglePlayProductPurchaseBoundary,
  createGooglePlayProductVerificationId,
  googlePlayProductPurchaseEvidenceSchema,
  type GooglePlayProductPurchaseClient,
} from './google-play-purchase.js';
import { createGooglePlayProductPurchaseConformanceFixture } from './google-play-purchase-conformance.js';
import { createGooglePlayPublisherClient } from './google-play-publisher-client.js';
import {
  retryGooglePlayPurchaseFinalization,
  revokeGooglePlayVoidedPurchase,
  sweepGooglePlayVoidedPurchases,
  type GooglePlayVoidedPurchasesClient,
  type GooglePlayVoidedPurchasesPage,
} from './google-play-store-server.js';
import {
  createGameServicesBackend,
  createInMemoryGameServicesStore,
  type GameServicesStore,
} from './server.js';

const packageName = 'com.example.game';
const catalog = {
  version: 'play-store-server',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { android: 'coins_100_android' },
    },
  ],
} as const satisfies ProductCatalog;

async function grantToken(
  store: GameServicesStore,
  purchaseToken: string,
  playerId = 'player-1',
  target = 'android',
) {
  return store.recordEntitlementGrant({
    source: 'purchase',
    playerId,
    grantId: 'COINS_100',
    idempotencyKey: `checkout-${purchaseToken}`,
    grantedAt: '2026-10-20T00:00:00.000Z',
    evidenceVerificationId: await createGooglePlayProductVerificationId(packageName, purchaseToken),
    payload: { target, store: 'google-play' },
  });
}

// --- The publisher transport ---------------------------------------------
{
  const urls: string[] = [];
  const client = createGooglePlayPublisherClient({
    getAccessToken: () => 'access-token',
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          tokenPagination: { nextPageToken: 'page-2' },
          voidedPurchases: [
            {
              kind: 'androidpublisher#voidedPurchase',
              purchaseToken: 'token-a',
              orderId: 'GPA.1',
              voidedTimeMillis: '1761300000000',
              voidedSource: 0,
              voidedReason: 7,
            },
            { orderId: 'GPA.no-token' },
            'not-an-object',
          ],
        }),
      );
    },
  });
  const page = await client.listVoidedPurchases({
    packageName,
    startTimeMillis: 1_761_000_000_000,
    endTimeMillis: 1_761_300_000_000,
    maxResults: 500,
    signal: new AbortController().signal,
  });
  assert.equal(
    urls[0],
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.game'
      + '/purchases/voidedpurchases?startTime=1761000000000&endTime=1761300000000&maxResults=500',
    'the official voided purchases endpoint with the time window',
  );
  assert.deepEqual(
    page,
    {
      voidedPurchases: [
        {
          purchaseToken: 'token-a',
          orderId: 'GPA.1',
          voidedTimeMillis: '1761300000000',
          voidedSource: 0,
          voidedReason: 7,
        },
      ],
      nextPageToken: 'page-2',
    },
    'entries without a purchase token are dropped',
  );
  await client.listVoidedPurchases({
    packageName,
    startTimeMillis: 1,
    endTimeMillis: 2,
    pageToken: 'page-2',
    signal: new AbortController().signal,
  });
  assert.equal(
    urls[1]?.endsWith('/purchases/voidedpurchases?token=page-2'),
    true,
    'a page token replaces the window, which Google ignores with a token',
  );
  await assert.rejects(
    client.listVoidedPurchases({
      packageName,
      startTimeMillis: 1,
      endTimeMillis: 2,
      maxResults: 1001,
      signal: new AbortController().signal,
    }),
    /maxResults/u,
  );
}

// --- One voided purchase --------------------------------------------------
{
  const store = createInMemoryGameServicesStore();
  const grant = await grantToken(store, 'token-refunded');
  const first = await revokeGooglePlayVoidedPurchase({
    store,
    packageName,
    voided: {
      purchaseToken: 'token-refunded',
      orderId: 'GPA.2',
      voidedTimeMillis: '1761300000000',
      voidedReason: '1',
      voidedSource: '0',
    },
  });
  assert.equal(first.status === 'revoked' && !first.alreadyProcessed, true, 'the grant is revoked');
  const [revocation] = await store.findEntitlementRevocations({
    ledgerEntryIds: [grant.ledgerEntryId],
  });
  assert.equal(revocation?.reason, 'voided');
  assert.equal(revocation?.revokedAt, new Date(1_761_300_000_000).toISOString());
  assert.equal(revocation?.payload.googlePlayVoidedReason, 1);
  assert.equal(revocation?.payload.googlePlayOrderId, 'GPA.2');
  assert.equal(
    JSON.stringify(revocation?.payload).includes('token-refunded'),
    false,
    'the raw purchase token is never written to the ledger',
  );
  const again = await revokeGooglePlayVoidedPurchase({
    store,
    packageName,
    voided: { purchaseToken: 'token-refunded' },
  });
  assert.equal(
    again.status === 'revoked' && again.alreadyProcessed,
    true,
    'a re-read is idempotent',
  );
  assert.equal((await listActiveEntitlementTransactions(store)).length, 0);

  const chargebackGrant = await grantToken(store, 'token-chargeback', 'player-2');
  await revokeGooglePlayVoidedPurchase({
    store,
    packageName,
    voided: { purchaseToken: 'token-chargeback', voidedReason: 7 },
    now: () => '2026-10-25T00:00:00.000Z',
  });
  const [chargeback] = await store.findEntitlementRevocations({
    ledgerEntryIds: [chargebackGrant.ledgerEntryId],
  });
  assert.equal(chargeback?.reason, 'chargeback', 'reason 7 is a chargeback');
  assert.equal(chargeback?.playerId, 'player-2', 'the grant’s own player is revoked');
  assert.equal(chargeback?.revokedAt, '2026-10-25T00:00:00.000Z', 'no voided time uses the clock');

  assert.deepEqual(
    await revokeGooglePlayVoidedPurchase({ store, packageName, voided: { purchaseToken: 'unknown' } }),
    { status: 'grant_not_found' },
  );
  assert.deepEqual(
    await revokeGooglePlayVoidedPurchase({
      store,
      packageName: 'com.other.game',
      voided: { purchaseToken: 'token-refunded' },
    }),
    { status: 'grant_not_found' },
    'a token of another package never matches',
  );
  await grantToken(store, 'token-ios', 'player-3', 'ios');
  assert.deepEqual(
    await revokeGooglePlayVoidedPurchase({ store, packageName, voided: { purchaseToken: 'token-ios' } }),
    { status: 'grant_not_found' },
    'a grant of another target is never revoked',
  );
  assert.equal(
    (await revokeGooglePlayVoidedPurchase({
      store,
      packageName,
      voided: { purchaseToken: '' },
    })).status,
    'invalid',
  );
}

// --- The sweep ------------------------------------------------------------
{
  const store = createInMemoryGameServicesStore();
  await grantToken(store, 'token-1');
  await grantToken(store, 'token-2');
  const requests: { startTimeMillis: number; endTimeMillis: number; pageToken?: string }[] = [];
  const pages: Record<string, GooglePlayVoidedPurchasesPage> = {
    first: {
      voidedPurchases: [{ purchaseToken: 'token-1' }, { purchaseToken: 'elsewhere' }],
      nextPageToken: 'next',
    },
    next: { voidedPurchases: [{ purchaseToken: 'token-2' }, { purchaseToken: 'token-1' }] },
  };
  const client: GooglePlayVoidedPurchasesClient = {
    async listVoidedPurchases(input) {
      requests.push({
        startTimeMillis: input.startTimeMillis,
        endTimeMillis: input.endTimeMillis,
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      });
      return pages[input.pageToken ?? 'first'] ?? { voidedPurchases: [] };
    },
  };
  const endTimeMillis = Date.parse('2026-10-25T00:00:00.000Z');
  const sweep = await sweepGooglePlayVoidedPurchases({
    client,
    store,
    packageName,
    startTimeMillis: 0,
    endTimeMillis,
    signal: new AbortController().signal,
  });
  assert.deepEqual(sweep, {
    complete: true,
    pages: 2,
    revoked: 2,
    alreadyProcessed: 1,
    notFound: 1,
    failed: 0,
  });
  assert.equal(
    requests[0]?.startTimeMillis,
    endTimeMillis - 30 * 24 * 60 * 60 * 1000 + 60_000,
    'the window is clamped inside Google’s 30 days',
  );
  assert.equal(requests[1]?.pageToken, 'next');

  const capped = await sweepGooglePlayVoidedPurchases({
    client,
    store,
    packageName,
    startTimeMillis: endTimeMillis - 60_000,
    endTimeMillis,
    maxPages: 1,
    signal: new AbortController().signal,
  });
  assert.equal(capped.complete, false, 'a page cap leaves the sweep incomplete');
  assert.equal(capped.pages, 1);

  let budget = 1;
  const stopped = await sweepGooglePlayVoidedPurchases({
    client,
    store,
    packageName,
    startTimeMillis: endTimeMillis - 60_000,
    endTimeMillis,
    signal: new AbortController().signal,
    shouldContinue: () => budget-- > 0,
  });
  assert.deepEqual(
    stopped,
    {
      complete: false,
      pages: 1,
      revoked: 0,
      alreadyProcessed: 0,
      notFound: 0,
      failed: 0,
    },
    'shouldContinue stops before the next purchase',
  );
  await assert.rejects(
    sweepGooglePlayVoidedPurchases({
      client,
      store,
      packageName,
      startTimeMillis: endTimeMillis + 1,
      endTimeMillis,
      signal: new AbortController().signal,
    }),
    /window/u,
  );
}

// --- Server-side acknowledge / consume retry --------------------------------
{
  const purchaseToken = 'token-client-gone';
  const response = createGooglePlayProductPurchaseConformanceFixture({ orderId: 'GPA.retry-1' });
  let consumeFails = true;
  const consumed: string[] = [];
  const client: GooglePlayProductPurchaseClient = {
    async getProductPurchaseV2() {
      return structuredClone(response);
    },
    async acknowledgeProductPurchase() {
      throw new Error('unexpected acknowledge');
    },
    async consumeProductPurchase(input) {
      if (consumeFails) {
        throw new Error('Play is unavailable');
      }
      consumed.push(input.purchaseToken);
      const lineItem = (response.productLineItem as { productOfferDetails: Record<string, unknown> }[])[0];
      if (lineItem !== undefined) {
        lineItem.productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
      }
    },
  };
  const boundary = createGooglePlayProductPurchaseBoundary({
    client,
    packageName,
    allowUnboundAuthenticatedPlayer: true,
  });
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements: { version: 'play-store-server', placements: [] },
    store,
    evidenceVerifier: {
      verifyPurchase: (input) => boundary.verifyPurchase(input),
      verifyAdReward: async () => ({ status: 'rejected', reason: 'unsupported' }),
    },
    purchaseGrantFinalizer: boundary,
  });
  const verified = await backend.purchases.verifyPurchase({
    target: 'android',
    playerId: 'player-1',
    productId: 'COINS_100',
    platformTransactionId: 'GPA.retry-1',
    idempotencyKey: 'checkout-retry-1',
    purchasedAt: '2026-10-24T00:00:00.000Z',
    evidence: { schema: googlePlayProductPurchaseEvidenceSchema, payload: { purchaseToken } },
  });
  assert.equal(verified.verified, true, 'the grant is durable');
  assert.equal(verified.finalization?.status, 'pending', 'the consume failed with the client gone');
  const ledgerEntryId = verified.ledgerEntryId ?? '';

  consumeFails = false;
  const retried = await retryGooglePlayPurchaseFinalization({
    finalizer: boundary,
    store,
    ledgerEntryId,
    purchaseToken,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  });
  assert.deepEqual(retried, { status: 'completed', action: 'consume', alreadyCompleted: false });
  assert.deepEqual(consumed, [purchaseToken], 'the server consumed the purchase');
  const again = await retryGooglePlayPurchaseFinalization({
    finalizer: boundary,
    store,
    ledgerEntryId,
    purchaseToken,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  });
  assert.equal(
    again.status === 'completed' && again.alreadyCompleted,
    true,
    'a repeat is idempotent',
  );

  assert.deepEqual(
    await retryGooglePlayPurchaseFinalization({
      finalizer: boundary,
      store,
      ledgerEntryId,
      purchaseToken: 'another-token',
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    }),
    { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_EVIDENCE_MISMATCH' },
    'a kept token must be the one the grant was verified with',
  );
  assert.deepEqual(
    await retryGooglePlayPurchaseFinalization({
      finalizer: boundary,
      store,
      ledgerEntryId: 'missing',
      purchaseToken,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    }),
    { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_GRANT_NOT_FOUND' },
  );
  await revokeGooglePlayVoidedPurchase({ store, packageName, voided: { purchaseToken } });
  assert.deepEqual(
    await retryGooglePlayPurchaseFinalization({
      finalizer: boundary,
      store,
      ledgerEntryId,
      purchaseToken,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    }),
    { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_GRANT_REVERSED' },
    'a voided grant is never finalized',
  );
}

console.log('Google Play store-server tests passed.');

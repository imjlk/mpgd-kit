import type { BridgeMethod, BridgeRequest } from '@mpgd/bridge';
import type { CapacitorServiceProvider } from '@mpgd/adapter-capacitor';
import type { PurchaseVerificationApi } from '@mpgd/game-services/client';
import {
  createGooglePlayTokenTransactionId as createServerTokenTransactionId,
} from '@mpgd/game-services/google-play-purchase';

import {
  createCapacitorPlayBillingProvider,
  createGooglePlayTokenTransactionId,
  recoverOwnedPlayPurchases,
} from './provider.js';
import type { CapacitorPlayBillingPlugin, PlayPurchaseOutcome } from './definitions.js';

const calls: string[] = [];
let nativeError: Error | undefined;
let productOffers = [{ offerToken: 'offer-1', formattedPrice: '$1.00', currencyCode: 'USD' }];
let nextOutcome: PlayPurchaseOutcome = {
  status: 'purchased',
  purchase: {
    productIds: ['coins_100'],
    purchaseToken: 'private-play-token',
    orderId: 'GPA.1111-2222',
    state: 'purchased',
  },
};
async function getProducts() {
  const product = {
    productId: 'coins_100',
    title: '100 Coins',
    description: '100 game coins',
    offers: productOffers,
  };
  return { products: [product] };
}

async function purchase(input: { readonly productId: string; readonly obfuscatedAccountId: string }) {
  calls.push(`purchase:${input.productId}:${input.obfuscatedAccountId}`);
  if (nativeError !== undefined) {
    throw nativeError;
  }
  return nextOutcome;
}

async function getPurchases() {
  calls.push('getPurchases');
  return {
    purchases: [
      {
        productIds: ['coins_100'],
        purchaseToken: 'private-play-token',
        orderId: 'GPA.1111-2222',
        purchaseTimeMillis: 1_893_456_000_000,
        state: 'purchased' as const,
      },
      {
        productIds: ['coins_100'],
        purchaseToken: 'pending-recovery-token',
        state: 'pending' as const,
      },
      {
        productIds: ['unknown-store-product'],
        purchaseToken: 'unrelated-token',
        state: 'purchased' as const,
      },
    ],
  };
}

type TestSdk = Pick<CapacitorPlayBillingPlugin, 'getProducts' | 'purchase' | 'getPurchases'>;
const sdk: TestSdk = { getProducts, purchase, getPurchases };
const provider = createCapacitorPlayBillingProvider({
  products: [{ id: 'COINS_100', type: 'consumable', storeId: 'coins_100' }],
  getObfuscatedAccountId: () => 'player-hash-1',
  isAndroid: () => true,
  sdk,
});
const registryCompatible: CapacitorServiceProvider = provider;
void registryCompatible;

try {
  createCapacitorPlayBillingProvider({
    products: Array.from({ length: 101 }, (_, index) => ({
      id: `PRODUCT_${index}`,
      storeId: `product_${index}`,
      type: 'consumable' as const,
    })),
    getObfuscatedAccountId: () => 'player-hash-1',
    isAndroid: () => true,
    sdk,
  });
  throw new Error('Oversized product config should fail.');
} catch (error) {
  if (!(error instanceof TypeError) || !error.message.includes('at most 100')) {
    throw error;
  }
}

function request(method: BridgeMethod, payload: unknown = {}): BridgeRequest {
  return {
    id: 'request-1',
    method,
    payload,
    meta: {
      target: 'android',
      appVersion: '0.1.0',
      buildId: 'test-build',
      sentAt: '2030-01-01T00:00:00Z',
    },
  };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match`);
  }
}

equal(await provider.getAvailability(), { nativeIap: 'available' }, 'availability');
const expectedProduct = {
  id: 'COINS_100',
  type: 'consumable',
  title: '100 Coins',
  description: '100 game coins',
  price: { formatted: '$1.00', currencyCode: 'USD' },
};
const expectedProducts = { id: 'request-1', ok: true, data: [expectedProduct] };
equal(await provider.bridge.request(request('commerce.getProducts')), expectedProducts, 'products');

productOffers = [
  { offerToken: 'offer-1', formattedPrice: '$1.00', currencyCode: 'USD' },
  { offerToken: 'offer-2', formattedPrice: '$0.50', currencyCode: 'USD' },
];
const ambiguousProducts = await provider.bridge.request(request('commerce.getProducts'));
equal(ambiguousProducts.ok, false, 'multiple offers require an explicit selection');
productOffers = productOffers.slice(0, 1);

equal(await provider.bridge.request(request('commerce.purchase', {
  productId: 'COINS_100',
})), {
  id: 'request-1',
  ok: true,
  data: {
    status: 'completed',
    transactionId: 'GPA.1111-2222',
    entitlementIds: [],
    evidence: {
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'private-play-token' },
    },
  },
}, 'completed purchase is provisional evidence only');
equal(calls, ['purchase:coins_100:player-hash-1'], 'native purchase arguments');

nextOutcome = {
  status: 'purchased',
  purchase: {
    productIds: ['coins_100'],
    purchaseToken: 'order-not-yet-visible',
    state: 'purchased',
  },
};
const orderlessRequest = request('commerce.purchase', { productId: 'COINS_100' });
const orderless = await provider.bridge.request(orderlessRequest);
if (!orderless.ok || typeof orderless.data !== 'object' || orderless.data === null) {
  throw new Error('Orderless purchase should remain valid provisional evidence.');
}
const expectedTokenId = await createGooglePlayTokenTransactionId('order-not-yet-visible');
equal((orderless.data as { transactionId?: string }).transactionId, expectedTokenId, 'token ID');
const serverTokenId = await createServerTokenTransactionId('order-not-yet-visible');
equal(expectedTokenId, serverTokenId, 'server token ID');
for (const token of ['simple-token', 'internal space', 'unicode-한글', 'slash/token+value']) {
  const clientId = await createGooglePlayTokenTransactionId(token);
  const serverId = await createServerTokenTransactionId(token);
  equal(clientId, serverId, 'token ID conformance');
}
for (const token of ['', ' padded', 'trailing ', 'control\u0001byte']) {
  const client = await Promise.allSettled([createGooglePlayTokenTransactionId(token)]);
  const server = await Promise.allSettled([createServerTokenTransactionId(token)]);
  equal(client[0]?.status, 'rejected', 'client rejects invalid token');
  equal(server[0]?.status, 'rejected', 'server rejects invalid token');
}
if (JSON.stringify(orderless).includes('authoritativeGrant')) {
  throw new Error('Native purchase must not claim a server grant.');
}

nextOutcome = {
  status: 'pending',
  purchase: {
    productIds: ['coins_100'],
    purchaseToken: 'pending-token',
    state: 'pending',
  },
};
equal(await provider.bridge.request(request('commerce.purchase', {
  productId: 'COINS_100',
})), {
  id: 'request-1',
  ok: true,
  data: {
    status: 'pending',
    entitlementIds: [],
    evidence: {
      schema: 'google-play.product-purchase.v2',
      payload: { purchaseToken: 'pending-token' },
    },
  },
}, 'pending purchase is not granted');

nextOutcome = { status: 'cancelled' };
equal(await provider.bridge.request(request('commerce.purchase', {
  productId: 'COINS_100',
})), {
  id: 'request-1',
  ok: true,
  data: { status: 'cancelled', entitlementIds: [] },
}, 'cancelled purchase is not granted');

nativeError = Object.assign(new Error('busy'), { code: 'PLAY_BILLING_BUSY' });
const busy = await provider.bridge.request(orderlessRequest);
const busyError = { code: 'PLAY_BILLING_BUSY', message: 'PLAY_BILLING_BUSY', retryable: false };
const expectedBusy = { id: 'request-1', ok: false, error: busyError };
equal(busy, expectedBusy, 'busy purchase is not retried automatically');
nativeError = undefined;

nativeError = Object.assign(new Error('service unavailable'), {
  code: 'PLAY_BILLING_SERVICE_UNAVAILABLE',
});
const serviceUnavailable = await provider.bridge.request(orderlessRequest);
equal(serviceUnavailable.ok, false, 'service failure is reported');
if (serviceUnavailable.ok || serviceUnavailable.error.retryable !== true) {
  throw new Error('Transient Billing failure must be retryable.');
}
nativeError = undefined;

nextOutcome = {
  status: 'purchased',
  purchase: { productIds: ['different-product'], purchaseToken: 'unsafe', state: 'purchased' },
};
const mismatch = await provider.bridge.request(orderlessRequest);
const mismatchError = {
  code: 'PLAY_BILLING_EVIDENCE_INVALID',
  message: 'PLAY_BILLING_EVIDENCE_INVALID',
  retryable: false,
};
const expectedMismatch = { id: 'request-1', ok: false, error: mismatchError };
equal(mismatch, expectedMismatch, 'mismatched purchase is a non-retryable integrity failure');

const owned = await provider.getOwnedPurchases();
equal(owned.length, 2, 'unknown products are ignored on recovery');
equal(owned[0]?.productId, 'COINS_100', 'owned logical product');
equal(owned[0]?.result.status, 'completed', 'owned result state');
equal(owned[1]?.result.status, 'pending', 'pending purchases are not granted');

const verificationRequests: unknown[] = [];
let verificationReply = { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-1' };
const recoveryBackend: PurchaseVerificationApi = {
  async verifyPurchase(input) {
    verificationRequests.push(input);
    return verificationReply;
  },
};
const recovered = await recoverOwnedPlayPurchases({
  provider,
  playerId: 'authenticated-player',
  now: () => '2030-01-01T00:00:00Z',
  backend: recoveryBackend,
});
const recoveryStatuses = recovered.map((item) => item.status);
equal(recoveryStatuses, ['granted', 'pending'], 'recovery decisions');
equal(verificationRequests.length, 1, 'pending purchase never calls backend');
const requestSent = verificationRequests[0] as {
  idempotencyKey: string;
  playerId: string;
  purchasedAt: string;
};
equal(requestSent.playerId, 'authenticated-player', 'recovery player binding');
equal(requestSent.purchasedAt, '2030-01-01T00:00:00.000Z', 'recovery purchase time');
const recoveredTokenId = await createGooglePlayTokenTransactionId('private-play-token');
equal(requestSent.idempotencyKey, recoveredTokenId, 'stable recovery idempotency');

verificationReply = { verified: false, alreadyProcessed: false, ledgerEntryId: 'ledger-1' };
const legacyRecovery = await recoverOwnedPlayPurchases({
  provider,
  playerId: 'authenticated-player',
  backend: recoveryBackend,
});
equal(legacyRecovery[0]?.status, 'pending', 'legacy non-grant remains retryable');

const uncertainRecovery = await recoverOwnedPlayPurchases({
  provider,
  playerId: 'authenticated-player',
  backend: {
    async verifyPurchase() {
      throw new Error('network unavailable');
    },
  },
});
const uncertainStatuses = uncertainRecovery.map((item) => item.status);
equal(uncertainStatuses, ['pending', 'pending'], 'uncertain recovery');
const expectedRestore = { id: 'request-1', ok: true, data: { restoredEntitlements: [] } };
const restore = await provider.bridge.request(request('commerce.restore'));
equal(restore, expectedRestore, 'native ownership is not a grant');

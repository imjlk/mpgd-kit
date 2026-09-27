import type { CapacitorServiceProvider } from '@mpgd/adapter-capacitor';
import type { BridgeMethod, BridgeRequest } from '@mpgd/bridge';

import type {
  CapacitorStoreKitPlugin,
  StoreKitPurchaseOutcome,
  StoreKitTransaction,
} from './definitions.js';
import {
  createCapacitorStoreKitProvider,
  recoverStoreKitPurchases,
  type StoreKitPurchaseVerification,
} from './provider.js';

const accountToken = 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2';
const transaction: StoreKitTransaction = {
  transactionId: '2000000123456789',
  originalTransactionId: '2000000123456789',
  productId: 'com.example.game.coins100',
  type: 'consumable',
  appAccountToken: accountToken,
  purchasedAt: '2026-07-16T12:00:00.000Z',
  signedTransaction: 'header.payload.signature',
};
const calls: string[] = [];
let outcome: StoreKitPurchaseOutcome = { status: 'purchased', transaction };
let finishFails = false;
let purchaseErrorCode: string | undefined;
let transactions: readonly StoreKitTransaction[] = [transaction];
type TestSdk = Pick<
  CapacitorStoreKitPlugin,
  'getProducts' | 'purchase' | 'getTransactions' | 'finishTransaction'
>;
async function getProducts() {
  const product = {
    productId: transaction.productId,
    type: 'consumable' as const,
    title: '100 Coins',
    description: 'Game currency',
    formattedPrice: '$1.00',
    currencyCode: 'USD',
  };
  return { products: [product] };
}
async function purchase(input: { productId: string; appAccountToken: string }) {
  calls.push(`purchase:${input.productId}:${input.appAccountToken}`);
  if (purchaseErrorCode !== undefined) {
    throw Object.assign(new Error('native failure'), { code: purchaseErrorCode });
  }
  return outcome;
}
async function getTransactions() {
  return { transactions };
}
async function finishTransaction(input: { transactionId: string; ledgerEntryId: string }) {
  calls.push(`finish:${input.transactionId}:${input.ledgerEntryId}`);
  if (finishFails) {
    throw new Error('finish failed');
  }
  return { finished: true };
}
const sdk: TestSdk = { getProducts, purchase, getTransactions, finishTransaction };

const provider = createCapacitorStoreKitProvider({
  products: [{ id: 'COINS_100', storeId: transaction.productId, type: 'consumable' }],
  getAppAccountToken: () => accountToken,
  isIos: () => true,
  sdk,
});
const registryCompatible: CapacitorServiceProvider = provider;
void registryCompatible;

function request(method: BridgeMethod, payload: unknown = {}): BridgeRequest {
  return {
    id: 'request-1',
    method,
    payload,
    meta: {
      target: 'ios',
      appVersion: '1',
      buildId: 'test',
      sentAt: '2026-07-16T12:00:00Z',
    },
  };
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
  }
}

equal(await provider.getAvailability(), { nativeIap: 'available' }, 'StoreKit availability');
const expectedProduct = {
  id: 'COINS_100',
  type: 'consumable',
  title: '100 Coins',
  description: 'Game currency',
  price: { formatted: '$1.00', currencyCode: 'USD' },
};
const expectedProducts = { id: 'request-1', ok: true, data: [expectedProduct] };
equal(await provider.bridge.request(request('commerce.getProducts')), expectedProducts, 'products');

const purchaseRequest = request('commerce.purchase', { productId: 'COINS_100' });
const purchased = await provider.bridge.request(purchaseRequest);
const expectedPurchase = {
  id: 'request-1',
  ok: true,
  data: { status: 'completed', transactionId: transaction.transactionId, entitlementIds: [] },
};
equal(purchased, expectedPurchase, 'Purchase callback is provisional and never grants locally');
equal(calls[0], `purchase:${transaction.productId}:${accountToken}`, 'purchase account token');

outcome = { status: 'pending' };
equal(
  await provider.bridge.request(request('commerce.purchase', { productId: 'COINS_100' })),
  { id: 'request-1', ok: true, data: { status: 'pending', entitlementIds: [] } },
  'Ask to Buy remains pending',
);
outcome = { status: 'cancelled' };
equal(
  await provider.bridge.request(request('commerce.purchase', { productId: 'COINS_100' })),
  { id: 'request-1', ok: true, data: { status: 'cancelled', entitlementIds: [] } },
  'cancelled purchase',
);
outcome = { status: 'purchased', transaction: { ...transaction, appAccountToken: crypto.randomUUID() } };
equal(
  (await provider.bridge.request(request('commerce.purchase', { productId: 'COINS_100' }))).ok,
  false,
  'mismatched account binding is rejected',
);
outcome = { status: 'purchased', transaction };
purchaseErrorCode = 'STOREKIT_PURCHASE_UNCERTAIN';
equal(
  await provider.bridge.request(request('commerce.purchase', { productId: 'COINS_100' })),
  { id: 'request-1', ok: true, data: { status: 'pending', entitlementIds: [] } },
  'uncertain purchase requires requery',
);
purchaseErrorCode = 'STOREKIT_PRODUCT_LOOKUP_FAILED';
const lookupFailure = await provider.bridge.request(purchaseRequest);
const lookupError = {
  code: 'STOREKIT_PRODUCT_LOOKUP_FAILED',
  message: 'STOREKIT_PRODUCT_LOOKUP_FAILED',
  retryable: true,
};
const expectedLookupFailure = { id: 'request-1', ok: false, error: lookupError };
equal(lookupFailure, expectedLookupFailure, 'pre-sheet lookup failure is not pending');
purchaseErrorCode = undefined;

equal(
  await provider.bridge.request(request('commerce.restore')),
  { id: 'request-1', ok: true, data: { restoredEntitlements: [] } },
  'native restore is not an entitlement grant',
);

const verificationCalls: string[] = [];
let verificationFails = false;
let nextVerification: StoreKitPurchaseVerification = {
  verified: true,
  alreadyProcessed: false,
  ledgerEntryId: 'ledger-1',
};
const backend = {
  async verifyPurchase(input: {
    readonly platformTransactionId: string;
    readonly idempotencyKey: string;
    readonly playerId: string;
  }) {
    verificationCalls.push(`${input.playerId}:${input.platformTransactionId}:${input.idempotencyKey}`);
    if (verificationFails) {
      throw new Error('backend unavailable');
    }
    return nextVerification;
  },
};
const recovered = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
const expectedRecovered = {
  productId: 'COINS_100',
  transactionId: transaction.transactionId,
  status: 'granted',
  finishPending: false,
  verification: { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-1' },
};
equal(recovered, [expectedRecovered], 'verified backend grant precedes native finish');
equal(
  verificationCalls,
  [`player-1:${transaction.transactionId}:app-store:${transaction.transactionId}`],
  'stable server idempotency',
);
equal(calls.at(-1), `finish:${transaction.transactionId}:ledger-1`, 'finish after ledger grant');

finishFails = true;
equal(
  (await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' }))[0]?.finishPending,
  true,
  'failed finish remains recoverable',
);
finishFails = false;
nextVerification = { verified: false, disposition: 'rejected', alreadyProcessed: false };
const finishCount = calls.filter((call) => call.startsWith('finish:')).length;
const rejected = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
equal(rejected[0]?.status, 'rejected', 'permanent backend rejection is distinct');
const rejectedFinishCount = calls.filter((call) => call.startsWith('finish:')).length;
equal(rejectedFinishCount, finishCount, 'rejected purchase is not finished without a grant');
verificationFails = true;
const uncertain = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
equal(uncertain[0]?.status, 'pending', 'network uncertainty stays pending');
verificationFails = false;
nextVerification = { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-1' };
const beforeMismatch = verificationCalls.length;
transactions = [{ ...transaction, appAccountToken: crypto.randomUUID() }];
equal(
  (await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' }))[0]?.status,
  'rejected',
  'another game account is never credited',
);
equal(
  (await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' }))[0]?.reason,
  'account-mismatch',
  'other account remains distinguishable',
);
equal(verificationCalls.length, beforeMismatch, 'other account never reaches backend');

transactions = [{ ...transaction, transactionId: '2000000123456790', signedTransaction: '' },
  transaction];
const mixed = await provider.getRecoverableTransactions();
equal(mixed.transactions.length, 1, 'valid purchase survives malformed sibling');
const expectedInvalid = {
  productId: 'COINS_100',
  transactionId: '2000000123456790',
  reason: 'invalid-evidence',
};
equal(mixed.invalid, [expectedInvalid], 'malformed evidence is reported separately');
const mixedRecovered = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
const mixedStatuses = mixedRecovered.map((item) => item.status);
equal(mixedStatuses, ['granted', 'rejected'], 'malformed sibling does not block valid purchase');

transactions = [{ ...transaction, revokedAt: '2026-07-17T12:00:00.000Z' }];
const revoked = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
equal(revoked[0]?.reason, 'revoked', 'revoked transaction is never sent to backend');

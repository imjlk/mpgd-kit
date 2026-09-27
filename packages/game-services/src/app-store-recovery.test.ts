import { createAppStoreRecoveryBackend, type AppStoreRecoveryRequest } from './app-store-recovery';
import { createInMemoryGameServicesStore } from './server';
import type { VerifyPurchaseRequest } from './types';

const request = {
  target: 'ios',
  playerId: 'player-1',
  productId: 'COINS_100',
  platformTransactionId: '2000000123456789',
  purchasedAt: '2026-07-16T12:00:00.000Z',
} satisfies AppStoreRecoveryRequest;

const store = createInMemoryGameServicesStore();
const existingGrant = await store.recordEntitlementGrant({
  source: 'purchase',
  playerId: request.playerId,
  grantId: request.productId,
  idempotencyKey: 'original-checkout-1',
  grantedAt: request.purchasedAt,
  evidenceVerificationId: '9:app-store:10:Production:16:com.example.game:16:2000000123456789',
  payload: {
    target: 'ios',
    productId: request.productId,
    platformTransactionId: request.platformTransactionId,
  },
});

const calls: VerifyPurchaseRequest[] = [];
const purchases = {
  async verifyPurchase(input: VerifyPurchaseRequest) {
    calls.push(input);
    if (input.platformTransactionId === request.platformTransactionId) {
      return {
        verified: true,
        alreadyProcessed: true,
        ledgerEntryId: existingGrant.ledgerEntryId,
      };
    }
    const grant = await store.recordEntitlementGrant({
      source: 'purchase',
      playerId: input.playerId,
      grantId: input.productId,
      idempotencyKey: input.idempotencyKey,
      grantedAt: input.purchasedAt,
      evidenceVerificationId: '9:app-store:10:Production:16:com.example.game:16:2000000123456790',
      payload: {
        target: 'ios',
        productId: input.productId,
        platformTransactionId: input.platformTransactionId,
      },
    });
    return { verified: true, alreadyProcessed: false, ledgerEntryId: grant.ledgerEntryId };
  },
};
const backend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  purchases,
  store,
});

const existing = await backend.recoverPurchase(request);
assert(
  existing.verified && calls[0]?.idempotencyKey === 'original-checkout-1',
  'an existing App Store ledger grant must reuse its original key',
);
assert(
  calls[0]?.platformTransactionId === request.platformTransactionId,
  'the original transaction identity must be sent to the existing backend',
);

const wrongOwner = await backend.recoverPurchase({ ...request, playerId: 'player-2' });
const wrongProduct = await backend.recoverPurchase({ ...request, productId: 'OTHER_PRODUCT' });
assert(
  !wrongOwner.verified && wrongOwner.disposition === 'rejected',
  'a different player must not recover another account grant',
);
assert(
  !wrongProduct.verified && wrongProduct.disposition === 'rejected',
  'a different logical product must not recover another grant',
);
assert(calls.length === 1, 'mismatched identities must never reach the backend');

const newRequest = { ...request, platformTransactionId: '2000000123456790' };
const unknown = await backend.recoverPurchase(newRequest);
assert(
  !unknown.verified && unknown.disposition === 'pending',
  'unknown evidence must remain pending without an original key',
);
assert(calls.length === 1, 'unknown evidence must not mint an idempotency key');

const journalBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  purchases,
  store,
  async resolveOriginalIdempotencyKey() {
    return 'original-checkout-2';
  },
});
const fromJournal = await journalBackend.recoverPurchase(newRequest);
assert(
  fromJournal.verified && calls[1]?.idempotencyKey === 'original-checkout-2',
  'new evidence must use the durable checkout key supplied by the game journal',
);

const conflictingBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  purchases,
  store,
  async resolveOriginalIdempotencyKey() {
    return 'original-checkout-1';
  },
});
const conflict = await conflictingBackend.recoverPurchase({
  ...request,
  platformTransactionId: '2000000123456793',
});
assert(
  !conflict.verified && conflict.disposition === 'rejected',
  'an existing key must not be reused for another Apple transaction',
);
assert(calls.length === 2, 'conflicting journal keys must not reach verification');

const unavailableBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  purchases,
  store,
  async resolveOriginalIdempotencyKey() {
    throw new Error('Journal unavailable');
  },
});
const dependencyOutage = await unavailableBackend.recoverPurchase({
  ...request,
  platformTransactionId: '2000000123456791',
});
assert(
  !dependencyOutage.verified && dependencyOutage.disposition === 'pending',
  'journal outages must remain retryable without exposing internal errors',
);

const racyBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store,
  purchases: {
    async verifyPurchase() {
      return {
        verified: true,
        alreadyProcessed: true,
        ledgerEntryId: existingGrant.ledgerEntryId,
      };
    },
  },
  async resolveOriginalIdempotencyKey() {
    return 'racy-checkout';
  },
});
const wrongVerdict = await racyBackend.recoverPurchase({
  ...request,
  platformTransactionId: '2000000123456792',
});
assert(
  !wrongVerdict.verified && wrongVerdict.disposition === 'rejected',
  'a backend verdict for a different Apple transaction must not be accepted',
);

const configuredBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  deploymentTarget: 'ios-production',
  purchases,
  store,
});
const wrongDeployment = await configuredBackend.recoverPurchase({
  ...request,
  deploymentTarget: 'ios-staging',
});
assert(
  !wrongDeployment.verified && wrongDeployment.disposition === 'rejected',
  'recovery must not cross a bound deployment target',
);

const boundStore = createInMemoryGameServicesStore();
const boundGrant = await boundStore.recordEntitlementGrant({
  source: 'purchase',
  playerId: request.playerId,
  grantId: request.productId,
  idempotencyKey: 'bound-original-checkout',
  grantedAt: request.purchasedAt,
  evidenceVerificationId: '9:app-store:10:Production:16:com.example.game:16:2000000123456789',
  payload: {
    target: 'ios',
    deploymentTarget: 'ios-production',
    productId: request.productId,
    platformTransactionId: request.platformTransactionId,
  },
});
let forwardedDeployment: string | undefined;
const boundBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store: boundStore,
  purchases: {
    async verifyPurchase(input) {
      forwardedDeployment = input.deploymentTarget;
      return {
        verified: true,
        alreadyProcessed: true,
        ledgerEntryId: boundGrant.ledgerEntryId,
      };
    },
  },
});
const boundResult = await boundBackend.recoverPurchase(request);
assert(
  boundResult.verified && forwardedDeployment === 'ios-production',
  'an existing grant must retry with the exact stored deployment target',
);

console.log('App Store recovery ledger tests passed.');

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

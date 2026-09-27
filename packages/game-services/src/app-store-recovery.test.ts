import type { ProductCatalog } from '@mpgd/catalog';

import { createAppStoreRecoveryBackend, type AppStoreRecoveryRequest } from './app-store-recovery';
import { createAppStoreVerificationId } from './app-store-verifier';
import type { GameServicesEvidenceVerifier } from './evidence-verification';
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

const restoredStore = createInMemoryGameServicesStore();
const originalTransactionId = '2000000123457000';
const originalVerificationId = createAppStoreVerificationId({
  environment: 'Production',
  bundleId: 'com.example.game',
  transactionId: originalTransactionId,
});
const restoredGrant = await restoredStore.recordEntitlementGrant({
  source: 'purchase',
  playerId: request.playerId,
  grantId: 'REMOVE_ADS',
  idempotencyKey: 'original-non-consumable-checkout',
  grantedAt: request.purchasedAt,
  evidenceVerificationId: originalVerificationId,
  payload: {
    target: 'ios',
    deploymentTarget: 'ios-production',
    productId: 'REMOVE_ADS',
    productType: 'non_consumable',
    platformTransactionId: '2000000123457001',
    appStoreOriginalTransactionId: originalTransactionId,
  },
});
const restoredRequest = {
  ...request,
  productId: 'REMOVE_ADS',
  platformTransactionId: '2000000123457002',
  originalTransactionId,
  productType: 'non_consumable',
} as const;
let restoreEvidenceCalls = 0;
let restoredRetryKey = '';
let restoredRetryDeployment = '';
let signedOriginalTransactionId = originalTransactionId;
const restoredProduct: ProductCatalog['products'][number] = {
  id: 'REMOVE_ADS',
  type: 'non_consumable',
  grant: { type: 'entitlement', entitlement: 'remove_ads' },
  platformProductIds: { 'ios-production': 'com.example.game.remove_ads' },
};
const restoredCatalog: ProductCatalog = { version: '1', products: [restoredProduct] };
const restoredEvidenceVerifier = {
  async verifyPurchase(input) {
    restoreEvidenceCalls += 1;
    assert(
      input.request.platformTransactionId === restoredRequest.platformTransactionId,
      'the current restored transaction must be verified by Apple',
    );
    assert(
      input.request.deploymentTarget === 'ios-production'
        && input.platformProductId === 'com.example.game.remove_ads',
      'the existing grant deployment must be resolved before product verification',
    );
    return {
      status: 'verified' as const,
      verificationId: originalVerificationId,
      verifiedAt: request.purchasedAt,
      payload: {
        appStoreOriginalTransactionId: signedOriginalTransactionId,
        appStoreTransactionType: 'Non-Consumable',
        appStoreEnvironment: 'Production',
        appStoreBundleId: 'com.example.game',
      },
    };
  },
  async verifyAdReward() {
    return { status: 'rejected' as const, reason: 'unsupported' };
  },
} satisfies GameServicesEvidenceVerifier;
const restoredBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store: restoredStore,
  purchases: {
    async verifyPurchase(input) {
      restoredRetryKey = input.idempotencyKey;
      restoredRetryDeployment = input.deploymentTarget ?? '';
      return {
        verified: true,
        alreadyProcessed: true,
        ledgerEntryId: restoredGrant.ledgerEntryId,
      };
    },
  },
  restoredNonConsumables: {
    catalog: restoredCatalog,
    evidenceVerifier: restoredEvidenceVerifier,
    bundleId: 'com.example.game',
    environment: 'Production',
  },
});
const restored = await restoredBackend.recoverPurchase(restoredRequest);
assert(
  restored.verified && restoredRetryKey === 'original-non-consumable-checkout'
    && restoredRetryDeployment === 'ios-production'
    && restoreEvidenceCalls === 1,
  'a signed restored non-consumable must reuse its original grant after Apple verification',
);
signedOriginalTransactionId = '2000000123457999';
restoredRetryKey = '';
const mismatchedRestore = await restoredBackend.recoverPurchase(restoredRequest);
assert(
  !mismatchedRestore.verified && mismatchedRestore.disposition === 'rejected'
    && restoredRetryKey === '',
  'a client-reported original transaction must match the server-verified Apple original',
);
signedOriginalTransactionId = originalTransactionId;
const beforeIdentityMismatch = calls.length;
const wrongIdentityBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store: restoredStore,
  purchases,
  restoredNonConsumables: {
    catalog: restoredCatalog,
    evidenceVerifier: restoredEvidenceVerifier,
    bundleId: 'com.example.game',
    environment: 'Sandbox',
  },
});
const wrongStoreIdentity = await wrongIdentityBackend.recoverPurchase({
  ...restoredRequest,
  deploymentTarget: 'ios-production',
});
assert(
  !wrongStoreIdentity.verified && wrongStoreIdentity.disposition === 'rejected'
    && calls.length === beforeIdentityMismatch,
  'the signed environment must match the configured App Store identity',
);
const unverifiedRestore = await createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store: restoredStore,
  purchases,
}).recoverPurchase(restoredRequest);
assert(
  !unverifiedRestore.verified && unverifiedRestore.disposition === 'pending',
  'restoration without an Apple verifier must not reuse the old grant',
);
const timeoutBackend = createAppStoreRecoveryBackend({
  playerId: request.playerId,
  store: restoredStore,
  purchases,
  restoredNonConsumables: {
    catalog: restoredCatalog,
    bundleId: 'com.example.game',
    environment: 'Production',
    timeoutMs: 20,
    evidenceVerifier: {
      async verifyPurchase() {
        return new Promise(() => {});
      },
      async verifyAdReward() {
        return { status: 'rejected', reason: 'unsupported' };
      },
    },
  },
});
const timedOutRestore = await timeoutBackend.recoverPurchase(restoredRequest);
assert(
  !timedOutRestore.verified
    && timedOutRestore.reason === 'APP_STORE_RESTORE_VERIFICATION_TIMEOUT',
  'a verifier that ignores abort must not hang StoreKit recovery',
);

console.log('App Store recovery ledger tests passed.');

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

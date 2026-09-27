import { resolveProductPlatformId, type ProductCatalog } from '@mpgd/catalog';

import {
  createAppStoreVerificationId,
  isAppStoreVerificationId,
  type AppStoreEnvironment,
} from './app-store-verifier.js';
import type { PurchaseVerificationApi } from './client.js';
import type { GameServicesEvidenceVerifier } from './evidence-verification.js';
import type { GameServicesStore } from './server.js';
import type {
  ProductGrantTransaction,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

export type AppStoreRecoveryRequest = Omit<
  VerifyPurchaseRequest,
  'target' | 'idempotencyKey' | 'evidence'
> & { readonly target: 'ios' };

export interface AppStoreRestoredTransactionIdentity {
  readonly originalTransactionId?: string;
  readonly productType?: 'consumable' | 'non_consumable';
}

export interface CreateAppStoreRecoveryBackendOptions {
  /** Bind this instance to a player authenticated by the game server. */
  readonly playerId: string;
  readonly deploymentTarget?: string;
  readonly purchases: PurchaseVerificationApi;
  readonly store: GameServicesStore;
  /** Required to re-verify restored non-consumables whose current transaction ID changed. */
  readonly restoredNonConsumables?: {
    readonly catalog: ProductCatalog;
    readonly evidenceVerifier: GameServicesEvidenceVerifier;
    readonly bundleId: string;
    readonly environment: AppStoreEnvironment;
    readonly timeoutMs?: number;
  };
  /** Look up the original, durable checkout key; never derive one from the transaction ID. */
  readonly resolveOriginalIdempotencyKey?: (
    input: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity,
  ) => Promise<string | undefined>;
}

export interface AppStoreRecoveryBackend {
  recoverPurchase(
    input: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity,
  ): Promise<VerifyPurchaseResponse>;
}

/**
 * Connect StoreKit recovery to the existing authoritative purchase ledger.
 * This is a server-side helper, not an authentication or Apple verifier.
 */
export function createAppStoreRecoveryBackend(
  options: CreateAppStoreRecoveryBackendOptions,
): AppStoreRecoveryBackend {
  if (options.playerId.trim() === '') {
    throw new TypeError('App Store recovery requires an authenticated player ID.');
  }
  const restoreTimeoutMs = options.restoredNonConsumables?.timeoutMs;
  if (restoreTimeoutMs !== undefined
    && (!Number.isSafeInteger(restoreTimeoutMs) || restoreTimeoutMs <= 0)) {
    throw new TypeError('Restored App Store verification timeout must be positive.');
  }

  return {
    async recoverPurchase(input) {
      if (input?.target !== 'ios' || input.playerId !== options.playerId
        || typeof input.productId !== 'string' || input.productId.trim() === ''
        || typeof input.platformTransactionId !== 'string'
        || input.platformTransactionId.trim() === ''
        || typeof input.purchasedAt !== 'string' || input.purchasedAt.trim() === ''
        || (options.deploymentTarget !== undefined
          && input.deploymentTarget !== undefined
          && input.deploymentTarget !== options.deploymentTarget)) {
        return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
      }

      let request: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity = {
        ...input,
        ...(options.deploymentTarget === undefined
          ? {}
          : { deploymentTarget: options.deploymentTarget }),
      };
      try {
        const restoreConfig = options.restoredNonConsumables;
        if (input.productType === 'non_consumable'
          && input.originalTransactionId !== undefined
          && input.originalTransactionId !== input.platformTransactionId
          && restoreConfig !== undefined) {
          const candidateId = createAppStoreVerificationId({
            environment: restoreConfig.environment,
            bundleId: restoreConfig.bundleId,
            transactionId: input.originalTransactionId,
          });
          const candidate = await findByVerificationId(options.store, candidateId);
          if (candidate !== undefined) {
            if (candidate.source !== 'purchase'
              || candidate.playerId !== request.playerId
              || candidate.grantId !== request.productId
              || candidate.payload.target !== 'ios'
              || candidate.payload.productType !== 'non_consumable'
              || candidate.payload.appStoreOriginalTransactionId
                !== input.originalTransactionId) {
              return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
            }
            if (typeof candidate.payload.deploymentTarget === 'string') {
              if (request.deploymentTarget !== undefined
                && request.deploymentTarget !== candidate.payload.deploymentTarget) {
                return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
              }
              request = { ...request, deploymentTarget: candidate.payload.deploymentTarget };
            }
          } else if (options.deploymentTarget === undefined) {
            // A request-supplied target is not a server-bound deployment identity.
            return pending('APP_STORE_RECOVERY_DEPLOYMENT_TARGET_REQUIRED');
          }
        }
        const restoredVerificationId = await verifyRestoredNonConsumable(
          input,
          request,
          options,
        );
        if (typeof restoredVerificationId !== 'string') {
          return restoredVerificationId;
        }
        const platformGrant = await findByPlatformEvidence(
          options.store,
          request.platformTransactionId,
        );
        const originalGrant = restoredVerificationId === ''
          ? undefined
          : await findByVerificationId(options.store, restoredVerificationId);
        if (platformGrant !== undefined && originalGrant !== undefined
          && platformGrant.ledgerEntryId !== originalGrant.ledgerEntryId) {
          return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
        }
        const existing = platformGrant ?? originalGrant;
        if (existing !== undefined
          && !matchesRecovery(existing, request, restoredVerificationId)) {
          return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
        }

        let key = existing?.idempotencyKey;
        if (key === undefined) {
          key = await options.resolveOriginalIdempotencyKey?.(request);
        }
        if (key === undefined || key.trim() === '') {
          return pending('APP_STORE_ORIGINAL_PURCHASE_NOT_FOUND');
        }

        const keyedGrant = await findByIdempotency(options.store, options.playerId, key);
        if (keyedGrant !== undefined
          && !matchesRecovery(keyedGrant, request, restoredVerificationId)) {
          return rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
        }

        const priorGrant = existing ?? keyedGrant;
        if (request.deploymentTarget === undefined
          && typeof priorGrant?.payload.deploymentTarget === 'string') {
          request = { ...request, deploymentTarget: priorGrant.payload.deploymentTarget };
        }

        // A stored grant lets the backend's normal retry path return its original entry.
        const response = await options.purchases.verifyPurchase({
          ...request,
          idempotencyKey: key,
        });
        if (!response.verified) {
          return response;
        }
        if (response.ledgerEntryId === undefined) {
          return pending('APP_STORE_RECOVERY_LEDGER_UNAVAILABLE');
        }
        const recorded = await options.store.getEntitlementTransaction(response.ledgerEntryId);
        if (recorded === undefined) {
          return pending('APP_STORE_RECOVERY_LEDGER_UNAVAILABLE');
        }
        return matchesRecovery(recorded, request, restoredVerificationId)
          ? response
          : rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
      } catch {
        return pending('APP_STORE_RECOVERY_DEPENDENCY_UNAVAILABLE');
      }
    },
  };
}

async function verifyRestoredNonConsumable(
  input: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity,
  request: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity,
  options: CreateAppStoreRecoveryBackendOptions,
): Promise<string | VerifyPurchaseResponse> {
  if (input.productType !== 'non_consumable'
    || input.originalTransactionId === undefined
    || input.originalTransactionId === input.platformTransactionId) {
    return '';
  }
  const config = options.restoredNonConsumables;
  if (config === undefined) {
    return pending('APP_STORE_RESTORE_VERIFIER_REQUIRED');
  }
  const product = config.catalog.products.find((item) => item.id === request.productId);
  if (product?.type !== 'non_consumable') {
    return rejected('APP_STORE_RECOVERY_PRODUCT_TYPE_MISMATCH');
  }
  const platformProductId = resolveProductPlatformId(
    product,
    request.deploymentTarget ?? request.target,
  );
  if (platformProductId === undefined) {
    return rejected('APP_STORE_RECOVERY_PRODUCT_UNAVAILABLE');
  }
  const timeoutMs = config.timeoutMs ?? 10_000;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Awaited<ReturnType<GameServicesEvidenceVerifier['verifyPurchase']>>>(
    (resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({ status: 'pending', reason: 'APP_STORE_RESTORE_VERIFICATION_TIMEOUT' });
        controller.abort();
      }, timeoutMs);
    },
  );
  // This probe calls only the evidence verifier; it never writes a ledger grant.
  let decision: Awaited<ReturnType<GameServicesEvidenceVerifier['verifyPurchase']>>;
  try {
    decision = await Promise.race([
      config.evidenceVerifier.verifyPurchase({
        request: { ...request, idempotencyKey: 'app-store-recovery-evidence-probe' },
        product,
        platformProductId,
        signal: controller.signal,
        timeoutMs,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
  if (decision.status === 'pending') {
    return pending(decision.reason ?? 'APP_STORE_RESTORE_VERIFICATION_PENDING');
  }
  if (decision.status === 'rejected') {
    return rejected(decision.reason);
  }
  const originalTransactionId = decision.payload?.appStoreOriginalTransactionId;
  const environment = decision.payload?.appStoreEnvironment;
  const bundleId = decision.payload?.appStoreBundleId;
  if (decision.payload?.appStoreTransactionType !== 'Non-Consumable'
    || originalTransactionId !== input.originalTransactionId
    || (environment !== 'Production' && environment !== 'Sandbox')
    || environment !== config.environment
    || bundleId !== config.bundleId
    || decision.verificationId !== createAppStoreVerificationId({
      environment,
      bundleId,
      transactionId: originalTransactionId,
    })) {
    return rejected('APP_STORE_RESTORE_EVIDENCE_MISMATCH');
  }
  return decision.verificationId;
}

async function findByPlatformEvidence(
  store: GameServicesStore,
  platformTransactionId: string,
): Promise<ProductGrantTransaction | undefined> {
  const identity = {
    source: 'purchase',
    target: 'ios',
    platformEvidenceId: platformTransactionId,
  } as const;
  if (store.findEntitlementTransactionByPlatformEvidence !== undefined) {
    return store.findEntitlementTransactionByPlatformEvidence(identity);
  }
  return (await store.listEntitlementTransactions()).find((transaction) => {
    return transaction.source === identity.source
      && transaction.payload.target === identity.target
      && transaction.payload.platformTransactionId === identity.platformEvidenceId;
  });
}

async function findByIdempotency(
  store: GameServicesStore,
  playerId: string,
  idempotencyKey: string,
): Promise<ProductGrantTransaction | undefined> {
  const identity = { source: 'purchase', playerId, idempotencyKey } as const;
  if (store.findEntitlementTransactionByIdempotency !== undefined) {
    return store.findEntitlementTransactionByIdempotency(identity);
  }
  return (await store.listEntitlementTransactions()).find((transaction) => {
    return transaction.source === identity.source
      && transaction.playerId === identity.playerId
      && transaction.idempotencyKey === identity.idempotencyKey;
  });
}

async function findByVerificationId(
  store: GameServicesStore,
  evidenceVerificationId: string,
): Promise<ProductGrantTransaction | undefined> {
  const identity = { source: 'purchase', evidenceVerificationId } as const;
  if (store.findEntitlementTransactionByEvidenceVerificationId !== undefined) {
    return store.findEntitlementTransactionByEvidenceVerificationId(identity);
  }
  return (await store.listEntitlementTransactions()).find((transaction) => {
    return transaction.source === identity.source
      && (transaction.evidenceVerificationId
        ?? transaction.payload.evidenceVerificationId) === identity.evidenceVerificationId;
  });
}

function matchesRecovery(
  transaction: ProductGrantTransaction,
  request: AppStoreRecoveryRequest & AppStoreRestoredTransactionIdentity,
  restoredVerificationId = '',
): boolean {
  const verificationId = transaction.evidenceVerificationId
    ?? transaction.payload.evidenceVerificationId;
  const environment = transaction.payload.appStoreEnvironment;
  const bundleId = transaction.payload.appStoreBundleId;
  const originalTransactionId = transaction.payload.appStoreOriginalTransactionId;
  const grantTransactionId = restoredVerificationId === ''
    ? request.platformTransactionId
    : originalTransactionId;
  return transaction.source === 'purchase'
    && transaction.playerId === request.playerId
    && transaction.grantId === request.productId
    && transaction.payload.target === 'ios'
    && (request.deploymentTarget === undefined
      || transaction.payload.deploymentTarget === request.deploymentTarget)
    && (restoredVerificationId === ''
      ? transaction.payload.platformTransactionId === request.platformTransactionId
      : transaction.payload.productType === 'non_consumable'
        && transaction.payload.appStoreOriginalTransactionId
          === request.originalTransactionId
        && verificationId === restoredVerificationId)
    && typeof verificationId === 'string'
    && isAppStoreVerificationId(verificationId)
    && (environment === 'Production' || environment === 'Sandbox')
    && typeof bundleId === 'string'
    && typeof grantTransactionId === 'string'
    && verificationId === createAppStoreVerificationId({
      environment,
      bundleId,
      transactionId: grantTransactionId,
    });
}

function pending(reason: string): VerifyPurchaseResponse {
  return { verified: false, disposition: 'pending', alreadyProcessed: false, reason };
}

function rejected(reason: string): VerifyPurchaseResponse {
  return { verified: false, disposition: 'rejected', alreadyProcessed: false, reason };
}

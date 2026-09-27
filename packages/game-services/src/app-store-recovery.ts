import type { PurchaseVerificationApi } from './client.js';
import { isAppStoreVerificationId } from './app-store-verifier.js';
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

export interface CreateAppStoreRecoveryBackendOptions {
  /** Bind this instance to a player authenticated by the game server. */
  readonly playerId: string;
  readonly deploymentTarget?: string;
  readonly purchases: PurchaseVerificationApi;
  readonly store: GameServicesStore;
  /** Look up the original, durable checkout key; never derive one from the transaction ID. */
  readonly resolveOriginalIdempotencyKey?: (
    input: AppStoreRecoveryRequest,
  ) => Promise<string | undefined>;
}

export interface AppStoreRecoveryBackend {
  recoverPurchase(input: AppStoreRecoveryRequest): Promise<VerifyPurchaseResponse>;
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

      let request: AppStoreRecoveryRequest = {
        ...input,
        ...(options.deploymentTarget === undefined
          ? {}
          : { deploymentTarget: options.deploymentTarget }),
      };
      try {
        const existing = await findByPlatformEvidence(
          options.store,
          request.platformTransactionId,
        );
        if (existing !== undefined && !matchesRecovery(existing, request)) {
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
        if (keyedGrant !== undefined && !matchesRecovery(keyedGrant, request)) {
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
        return matchesRecovery(recorded, request)
          ? response
          : rejected('APP_STORE_RECOVERY_IDENTITY_MISMATCH');
      } catch {
        return pending('APP_STORE_RECOVERY_DEPENDENCY_UNAVAILABLE');
      }
    },
  };
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

function matchesRecovery(
  transaction: ProductGrantTransaction,
  request: AppStoreRecoveryRequest,
): boolean {
  const verificationId = transaction.evidenceVerificationId
    ?? transaction.payload.evidenceVerificationId;
  return transaction.source === 'purchase'
    && transaction.playerId === request.playerId
    && transaction.grantId === request.productId
    && transaction.payload.target === 'ios'
    && (request.deploymentTarget === undefined
      || transaction.payload.deploymentTarget === request.deploymentTarget)
    && transaction.payload.platformTransactionId === request.platformTransactionId
    && typeof verificationId === 'string'
    && isAppStoreVerificationId(verificationId);
}

function pending(reason: string): VerifyPurchaseResponse {
  return { verified: false, disposition: 'pending', alreadyProcessed: false, reason };
}

function rejected(reason: string): VerifyPurchaseResponse {
  return { verified: false, disposition: 'rejected', alreadyProcessed: false, reason };
}

import { Capacitor } from '@capacitor/core';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { ProductInfo, PurchaseResult } from '@mpgd/platform';

import { CapacitorStoreKit } from './plugin.js';
import type {
  CapacitorStoreKitPlugin,
  StoreKitPurchaseOutcome,
  StoreKitTransaction,
} from './definitions.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const productPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const transactionPattern = /^[1-9][0-9]{0,19}$/u;

/**
 * Backend-verified grants per provider instance: transaction ID to ledger
 * entry ID. Only recoverStoreKitPurchases records entries, after the game
 * backend answered verified=true, so finishGrantedTransaction cannot finish
 * an unfinished purchase on the strength of a caller-supplied string alone.
 */
const verifiedGrants = new WeakMap<CapacitorStoreKitProvider, Map<string, string>>();

export interface StoreKitProductMapping {
  readonly id: string;
  readonly storeId: string;
  readonly type: 'consumable' | 'non_consumable';
}

export interface StoreKitProviderOptions {
  readonly products: readonly StoreKitProductMapping[];
  /** Must agree with the authenticated backend's resolveAppAccountToken. */
  readonly getAppAccountToken: () => string | Promise<string>;
  readonly sdk?: Pick<
    CapacitorStoreKitPlugin,
    'getProducts' | 'purchase' | 'getTransactions' | 'sync' | 'finishTransaction'
  >;
  readonly isIos?: () => boolean;
}

export interface RecoverableStoreKitTransaction {
  readonly productId: string;
  readonly originalTransactionId: string;
  readonly type: 'consumable' | 'non_consumable';
  readonly appAccountToken?: string;
  readonly purchasedAt: string;
  readonly result: PurchaseResult;
}

export interface InvalidStoreKitTransaction {
  readonly productId: string;
  readonly transactionId?: string;
  readonly reason: 'invalid-evidence' | 'revoked';
}

export interface StoreKitRecoverySnapshot {
  readonly transactions: readonly RecoverableStoreKitTransaction[];
  readonly invalid: readonly InvalidStoreKitTransaction[];
}

export interface CapacitorStoreKitProvider {
  readonly id: 'apple-storekit';
  readonly features: readonly ['nativeIap'];
  readonly methods: readonly [
    'commerce.getProducts',
    'commerce.purchase',
    'commerce.restore',
    'commerce.getEntitlements',
  ];
  readonly bridge: { request(input: BridgeRequest): Promise<BridgeResponse> };
  getAvailability(): Promise<Readonly<{
    nativeIap: 'available' | 'configuration-required' | 'temporarily-unavailable' | 'unsupported';
  }>>;
  getAppAccountToken(): Promise<string>;
  getRecoverableTransactions(): Promise<StoreKitRecoverySnapshot>;
  /**
   * Finish a transaction the backend already granted. The provider accepts
   * only a transaction and ledger entry pair that recoverStoreKitPurchases
   * recorded from a verified backend answer in this session; any other pair
   * is rejected so an unfinished purchase keeps its recovery signal.
   */
  finishGrantedTransaction(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  }): Promise<boolean>;
}

export interface StoreKitPurchaseVerification {
  readonly verified: boolean;
  readonly disposition?: 'pending' | 'rejected';
  readonly alreadyProcessed: boolean;
  readonly ledgerEntryId?: string;
  readonly reason?: string;
}

export interface StoreKitRecoveryBackend {
  /**
   * Resolve a journaled checkout with its ORIGINAL idempotency key, or return
   * the already-recorded grant for matching App Store evidence and owner.
   * The backend must verify Apple data before returning verified=true.
   */
  recoverPurchase(input: {
    readonly target: 'ios';
    readonly deploymentTarget?: string;
    readonly playerId: string;
    readonly productId: string;
    readonly platformTransactionId: string;
    readonly originalTransactionId: string;
    readonly productType: 'consumable' | 'non_consumable';
    readonly purchasedAt: string;
  }): Promise<StoreKitPurchaseVerification>;
}

export interface RecoveredStoreKitPurchase {
  readonly productId: string;
  readonly transactionId?: string;
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly reason?: 'invalid-evidence' | 'revoked' | 'account-mismatch';
  readonly finishPending?: boolean;
  readonly verification?: StoreKitPurchaseVerification;
}

/** Submit unfinished purchases to the backend before asking StoreKit to finish. */
export async function recoverStoreKitPurchases(input: {
  readonly provider: CapacitorStoreKitProvider;
  readonly backend: StoreKitRecoveryBackend;
  readonly playerId: string;
  readonly deploymentTarget?: string;
}): Promise<readonly RecoveredStoreKitPurchase[]> {
  if (input.playerId.trim() === '') {
    throw new TypeError('StoreKit recovery requires an authenticated player ID.');
  }
  const token = await input.provider.getAppAccountToken();
  const snapshot = await input.provider.getRecoverableTransactions();
  const recovered = await Promise.all(snapshot.transactions.map(async (item) => {
    const transactionId = item.result.transactionId;
    if (transactionId === undefined) {
      return { productId: item.productId, status: 'rejected', reason: 'invalid-evidence' } as const;
    }
    if (item.appAccountToken?.toLowerCase() !== token) {
      // Shared Apple IDs can expose a transaction owned by another game user.
      return {
        productId: item.productId, transactionId, status: 'rejected', reason: 'account-mismatch',
      } as const;
    }
    try {
      const verification = await input.backend.recoverPurchase({
        target: 'ios',
        ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
        playerId: input.playerId,
        productId: item.productId,
        platformTransactionId: transactionId,
        originalTransactionId: item.originalTransactionId,
        productType: item.type,
        purchasedAt: item.purchasedAt,
      });
      if (!verification.verified) {
        return {
          productId: item.productId,
          transactionId,
          status: verification.disposition ?? 'pending',
          verification,
        } as const;
      }
      if (verification.ledgerEntryId === undefined || verification.ledgerEntryId.trim() === '') {
        return { productId: item.productId, transactionId, status: 'pending', verification } as const;
      }
      verifiedGrants.get(input.provider)?.set(transactionId, verification.ledgerEntryId);
      try {
        const finished = await input.provider.finishGrantedTransaction({
          transactionId,
          ledgerEntryId: verification.ledgerEntryId,
        });
        return {
          productId: item.productId,
          transactionId,
          status: 'granted',
          finishPending: !finished,
          verification,
        } as const;
      } catch {
        return {
          productId: item.productId,
          transactionId,
          status: 'granted',
          finishPending: true,
          verification,
        } as const;
      }
    } catch {
      return { productId: item.productId, transactionId, status: 'pending' } as const;
    }
  }));
  return [
    ...recovered,
    ...snapshot.invalid.map((item) => ({ ...item, status: 'rejected' as const })),
  ];
}

export function createCapacitorStoreKitProvider(
  options: StoreKitProviderOptions,
): CapacitorStoreKitProvider {
  const sdk = options.sdk ?? CapacitorStoreKit;
  const isIos = options.isIos ?? (() => Capacitor.getPlatform() === 'ios');
  const byLogicalId = new Map<string, StoreKitProductMapping>();
  const byStoreId = new Map<string, StoreKitProductMapping>();
  for (const product of options.products) {
    if (!productPattern.test(product.id)
      || !productPattern.test(product.storeId)
      || byLogicalId.has(product.id)
      || byStoreId.has(product.storeId)) {
      throw new TypeError('StoreKit product mappings must be unique and valid.');
    }
    byLogicalId.set(product.id, product);
    byStoreId.set(product.storeId, product);
  }
  if (byLogicalId.size === 0 || byLogicalId.size > 100) {
    throw new TypeError('StoreKit requires 1-100 one-time product mappings.');
  }

  async function getAppAccountToken(): Promise<string> {
    const token = (await options.getAppAccountToken()).toLowerCase();
    if (!uuidPattern.test(token)) {
      throw new TypeError('StoreKit requires a UUID app account token.');
    }
    return token;
  }

  async function getRecoverableTransactions(): Promise<StoreKitRecoverySnapshot> {
    if (!isIos()) {
      throw new Error('StoreKit is only available on iOS.');
    }
    const response = await sdk.getTransactions();
    const owned: RecoverableStoreKitTransaction[] = [];
    const invalid: InvalidStoreKitTransaction[] = [];
    const seen = new Set<string>();
    for (const transaction of response.transactions) {
      const mapping = byStoreId.get(transaction.productId);
      if (mapping === undefined) {
        continue;
      }
      if (mapping.type !== transaction.type || !validTransaction(transaction)) {
        invalid.push({
          productId: mapping.id,
          transactionId: transaction.transactionId,
          reason: 'invalid-evidence',
        });
        continue;
      }
      if (transaction.revokedAt !== undefined) {
        invalid.push({
          productId: mapping.id,
          transactionId: transaction.transactionId,
          reason: 'revoked',
        });
        continue;
      }
      if (seen.has(transaction.transactionId)) {
        continue;
      }
      seen.add(transaction.transactionId);
      owned.push({
        productId: mapping.id,
        originalTransactionId: transaction.originalTransactionId,
        type: transaction.type,
        ...(transaction.appAccountToken === undefined
          ? {} : { appAccountToken: transaction.appAccountToken }),
        purchasedAt: transaction.purchasedAt,
        result: toPurchaseResult(transaction),
      });
    }
    return { transactions: owned, invalid };
  }

  async function request(input: BridgeRequest): Promise<BridgeResponse> {
    if (!isIos()) {
      return failure(input.id, 'STOREKIT_IOS_REQUIRED');
    }
    try {
      switch (input.method) {
        case 'commerce.getProducts': {
          const response = await sdk.getProducts({ productIds: [...byStoreId.keys()] });
          const products: ProductInfo[] = [];
          for (const item of response.products) {
            const mapping = byStoreId.get(item.productId);
            if (mapping === undefined || mapping.type !== item.type) {
              continue;
            }
            products.push({
              id: mapping.id,
              type: mapping.type,
              title: item.title,
              description: item.description,
              price: { formatted: item.formattedPrice, currencyCode: item.currencyCode },
            });
          }
          return success(input.id, products);
        }
        case 'commerce.purchase': {
          const payload = input.payload;
          const productId = isRecord(payload) ? payload.productId : undefined;
          const mapping = typeof productId === 'string' ? byLogicalId.get(productId) : undefined;
          if (mapping === undefined) {
            return failure(input.id, 'STOREKIT_PRODUCT_UNKNOWN');
          }
          const appAccountToken = await getAppAccountToken();
          const outcome = await sdk.purchase({
            productId: mapping.storeId,
            appAccountToken,
          });
          return success(input.id, convertOutcome(outcome, mapping, appAccountToken));
        }
        case 'commerce.restore':
          await sdk.sync();
          return success(input.id, { restoredEntitlements: [] });
        case 'commerce.getEntitlements':
          return success(input.id, []);
        default:
          return failure(input.id, 'STOREKIT_METHOD_UNSUPPORTED');
      }
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (input.method === 'commerce.purchase' && code === 'STOREKIT_PURCHASE_UNCERTAIN') {
        return success(input.id, { status: 'pending', entitlementIds: [] });
      }
      if (typeof code === 'string' && /^STOREKIT_[A-Z_]+$/u.test(code)) {
        const retryable = code === 'STOREKIT_UNAVAILABLE'
          || code === 'STOREKIT_PRODUCT_LOOKUP_FAILED'
          || code === 'STOREKIT_SYNC_FAILED';
        return failure(input.id, code, retryable);
      }
      if (error instanceof TypeError) {
        return failure(input.id, 'STOREKIT_CONFIGURATION_ERROR');
      }
      return failure(input.id, 'STOREKIT_UNAVAILABLE', true);
    }
  }

  const grants = new Map<string, string>();
  const provider: CapacitorStoreKitProvider = {
    id: 'apple-storekit',
    features: ['nativeIap'],
    methods: [
      'commerce.getProducts',
      'commerce.purchase',
      'commerce.restore',
      'commerce.getEntitlements',
    ],
    bridge: { request },
    async getAvailability() {
      if (!isIos()) {
        return { nativeIap: 'unsupported' };
      }
      try {
        await getAppAccountToken();
        const response = await sdk.getProducts({ productIds: [...byStoreId.keys()] });
        const available = response.products.some((item) => {
          const mapping = byStoreId.get(item.productId);
          return mapping !== undefined && mapping.type === item.type;
        });
        return { nativeIap: available ? 'available' : 'configuration-required' };
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        return { nativeIap: code === 'STOREKIT_INVALID_PRODUCTS'
          || code === 'STOREKIT_PRODUCT_UNAVAILABLE'
          || error instanceof TypeError
            ? 'configuration-required' : 'temporarily-unavailable' };
      }
    },
    getAppAccountToken,
    getRecoverableTransactions,
    async finishGrantedTransaction(input) {
      if (!isIos() || !transactionPattern.test(input.transactionId)
        || input.ledgerEntryId.trim() === '') {
        throw new TypeError('StoreKit finish requires a verified grant and transaction ID.');
      }
      if (grants.get(input.transactionId) !== input.ledgerEntryId) {
        throw new TypeError(
          'StoreKit finish requires the ledger entry the backend returned for this transaction via recoverStoreKitPurchases.',
        );
      }
      const response = await sdk.finishTransaction({
        transactionId: input.transactionId,
        ledgerEntryId: input.ledgerEntryId,
      });
      if (response.finished) {
        grants.delete(input.transactionId);
      }
      return response.finished;
    },
  };
  verifiedGrants.set(provider, grants);
  return provider;
}

function convertOutcome(
  outcome: StoreKitPurchaseOutcome,
  mapping: StoreKitProductMapping,
  expectedAccountToken: string,
): PurchaseResult {
  if (outcome.status !== 'purchased') {
    return { status: outcome.status, entitlementIds: [] };
  }
  if (outcome.transaction.productId !== mapping.storeId
    || outcome.transaction.type !== mapping.type
    || outcome.transaction.appAccountToken?.toLowerCase() !== expectedAccountToken
    || !validTransaction(outcome.transaction)) {
    throw Object.assign(new Error('StoreKit purchase evidence is invalid.'), {
      code: 'STOREKIT_EVIDENCE_INVALID',
    });
  }
  return toPurchaseResult(outcome.transaction);
}

function toPurchaseResult(transaction: StoreKitTransaction): PurchaseResult {
  return {
    status: 'completed',
    transactionId: transaction.transactionId,
    entitlementIds: [],
  };
}

function validTransaction(value: StoreKitTransaction): boolean {
  return transactionPattern.test(value.transactionId)
    && /^[0-9]{1,20}$/u.test(value.originalTransactionId)
    && productPattern.test(value.productId)
    && (value.type === 'consumable' || value.type === 'non_consumable')
    && Number.isFinite(Date.parse(value.purchasedAt))
    && typeof value.signedTransaction === 'string'
    && value.signedTransaction.length > 0
    && value.signedTransaction.length <= 128 * 1024
    && value.signedTransaction.split('.').length === 3
    && (value.revokedAt === undefined || Number.isFinite(Date.parse(value.revokedAt)))
    && (value.appAccountToken === undefined || uuidPattern.test(value.appAccountToken));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function success(id: string, data: unknown): BridgeResponse {
  return { id, ok: true, data };
}

function failure(id: string, code: string, retryable = false): BridgeResponse {
  return { id, ok: false, error: { code, message: code, retryable } };
}

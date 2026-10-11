import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  defaultStoreSdkErrorCodeMap,
  type StoreSdk,
  type StoreSdkCapabilities,
  type StoreSdkError,
  type StoreSdkErrorCodeMap,
  type StoreSdkEvent,
  type StoreSdkEventName,
  type StoreSdkEventOf,
  type StoreSdkFetchProductsInput,
  type StoreSdkFinishTransactionInput,
  type StoreSdkFinishTransactionResult,
  type StoreSdkProduct,
  type StoreSdkPurchase,
  type StoreSdkRequestPurchaseInput,
  type StoreSdkRequestPurchaseResult,
} from '@mpgd/adapter-capacitor';
import type { PlatformProviderAvailability } from '@mpgd/platform';
import type { CommerceErrorCode, StorePurchaseAccountBinding } from '@mpgd/platform/commerce';

import type {
  CapacitorStoreKitPlugin,
  StoreKitProduct,
  StoreKitTransaction,
} from './definitions.js';
import { CapacitorStoreKit } from './plugin.js';

/** The plugin surface the commerce v2 SDK drives; `CapacitorStoreKit` by default. */
export type CapacitorStoreKitStoreSdkPlugin = Pick<
  CapacitorStoreKitPlugin,
  'getProducts' | 'purchase' | 'getTransactions' | 'sync' | 'finishTransaction' | 'addListener'
>;

export interface CreateCapacitorStoreKitStoreSdkInput {
  /** Store product ids the availability probe looks up; the provider passes its catalog SKUs. */
  readonly productIds: readonly string[];
  readonly sdk?: CapacitorStoreKitStoreSdkPlugin;
  readonly isIos?: () => boolean;
}

/**
 * Capacitor StoreKit `StoreSdk`: the commerce v2 surface over the native
 * StoreKit 2 collector (RFC B3). The App Store profile is consumable plus
 * durable, no subscriptions, no quantity, `pending` (Ask to Buy), `restore`
 * (`AppStore.sync`), and `finish: 'client'` after the ledger grant. Every
 * purchase carries the StoreKit-verified `signedTransaction` JWS as its
 * `token`; the backend verifies that JWS itself and nothing here grants.
 */
export function createCapacitorStoreKitStoreSdk(
  input: CreateCapacitorStoreKitStoreSdkInput,
): StoreSdk {
  const sdk = input.sdk ?? CapacitorStoreKit;
  const isIos = input.isIos ?? (() => Capacitor.getPlatform() === 'ios');
  const productIds = [...input.productIds];
  for (const productId of productIds) {
    if (!productPattern.test(productId)) {
      throw new TypeError(`StoreKit product id ${productId} is invalid.`);
    }
  }

  const listeners = new Map<StoreSdkEventName, Set<(event: never) => void>>();
  let nativeHandle: Promise<PluginListenerHandle> | undefined;
  const emit = (event: StoreSdkEvent): void => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) {
      (listener as (value: StoreSdkEvent) => void)(event);
    }
  };
  const onTransactionUpdated = (transaction: unknown): void => {
    if (!isValidStoreKitTransaction(transaction)) {
      emit({
        type: 'purchaseError',
        ...(isRecord(transaction) && typeof transaction.productId === 'string'
          ? { sku: transaction.productId }
          : {}),
        error: evidenceInvalid(),
      });
      return;
    }
    emit({ type: 'purchaseUpdated', purchase: toSdkPurchase(transaction) });
  };
  const attachNative = (): void => {
    if (nativeHandle !== undefined || !isIos()) {
      return;
    }
    // Registered synchronously so an event delivered right after the first
    // subscriber attaches is not lost; a rejected attach is forgotten so the
    // next subscriber retries it.
    let handle: Promise<PluginListenerHandle>;
    try {
      handle = sdk.addListener('transactionUpdated', onTransactionUpdated);
    } catch {
      return;
    }
    nativeHandle = handle;
    handle.catch(() => {
      if (nativeHandle === handle) {
        nativeHandle = undefined;
      }
    });
  };
  const detachNative = (): void => {
    const handle = nativeHandle;
    nativeHandle = undefined;
    handle?.then((value) => value.remove()).catch(() => undefined);
  };

  const requireIos = (): void => {
    if (!isIos()) {
      throw storeKitError('STOREKIT_IOS_REQUIRED', 'StoreKit is only available on iOS.', false);
    }
  };

  // Overlapping finishes for the same transaction and ledger entry share one
  // native call; the v2 reconciler is the gate that authorizes the call.
  const inFlightFinishes = new Map<
    string,
    { readonly ledgerEntryId: string; readonly promise: Promise<StoreSdkFinishTransactionResult> }
  >();

  return {
    store: 'app-store',
    capabilities: storeKitStoreSdkCapabilities,
    async fetchProducts(request: StoreSdkFetchProductsInput): Promise<readonly StoreSdkProduct[]> {
      requireIos();
      if (request.type === 'subscription' || request.skus.length === 0) {
        return [];
      }
      const products: StoreSdkProduct[] = [];
      for (let index = 0; index < request.skus.length; index += maxProductIdsPerLookup) {
        const response = await sdk.getProducts({
          productIds: request.skus.slice(index, index + maxProductIdsPerLookup),
        });
        if (!isRecord(response) || !Array.isArray(response.products)) {
          throw evidenceInvalid('StoreKit returned an invalid product list.');
        }
        for (const product of response.products as readonly unknown[]) {
          if (!isValidStoreKitProduct(product)) {
            throw evidenceInvalid('StoreKit returned an invalid product.');
          }
          products.push({
            sku: product.productId,
            kind: product.type === 'consumable' ? 'consumable' : 'durable',
            title: product.title,
            description: product.description,
            price: { formatted: product.formattedPrice, currencyCode: product.currencyCode },
          });
        }
      }
      return products;
    },
    async requestPurchase(
      request: StoreSdkRequestPurchaseInput,
    ): Promise<StoreSdkRequestPurchaseResult> {
      requireIos();
      const appAccountToken = readAppAccountToken(request.accountBinding);
      const outcome: unknown = await sdk.purchase({ productId: request.sku, appAccountToken });
      if (!isRecord(outcome)) {
        throw evidenceInvalid('StoreKit returned an invalid purchase result.');
      }
      switch (outcome.status) {
        case 'purchased': {
          const transaction: unknown = outcome.transaction;
          if (
            !isValidStoreKitTransaction(transaction)
            || transaction.productId !== request.sku
            || transaction.appAccountToken?.toLowerCase() !== appAccountToken
          ) {
            throw evidenceInvalid('StoreKit purchase evidence is invalid.');
          }
          return { outcome: 'purchased', purchase: toSdkPurchase(transaction) };
        }
        case 'pending':
          // Ask to Buy: the transaction arrives through `transactionUpdated`.
          return { outcome: 'launched' };
        case 'cancelled':
          return {
            outcome: 'cancelled',
            error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'userCancelled' },
          };
        default:
          throw evidenceInvalid('StoreKit returned an invalid purchase result.');
      }
    },
    async getAvailablePurchases(): Promise<readonly StoreSdkPurchase[]> {
      // Pending (Ask to Buy) transactions never appear in `Transaction.unfinished`
      // before approval, so `includePending` has nothing to filter here.
      requireIos();
      const response: unknown = await sdk.getTransactions();
      if (!isRecord(response) || !Array.isArray(response.transactions)) {
        throw evidenceInvalid('StoreKit returned an invalid transaction list.');
      }
      const purchases: StoreSdkPurchase[] = [];
      const seen = new Set<string>();
      for (const transaction of response.transactions as readonly unknown[]) {
        if (!isValidStoreKitTransaction(transaction)) {
          // One malformed transaction is reported on its own and never blocks
          // a valid sibling.
          emit({
            type: 'purchaseError',
            ...(isRecord(transaction) && typeof transaction.productId === 'string'
              ? { sku: transaction.productId }
              : {}),
            error: evidenceInvalid(),
          });
          continue;
        }
        // Available means unfinished: a current entitlement the native side
        // marks finished is not listed. A build without the flag lists every
        // transaction, which the backend answers idempotently.
        if (transaction.unfinished === false || seen.has(transaction.transactionId)) {
          continue;
        }
        seen.add(transaction.transactionId);
        purchases.push(toSdkPurchase(transaction));
      }
      return purchases;
    },
    async finishTransaction(
      request: StoreSdkFinishTransactionInput,
    ): Promise<StoreSdkFinishTransactionResult> {
      requireIos();
      const { transactionId, ledgerEntryId } = request;
      if (
        typeof transactionId !== 'string' || !transactionPattern.test(transactionId)
        || typeof ledgerEntryId !== 'string' || ledgerEntryId.trim() === ''
      ) {
        throw storeKitError(
          'STOREKIT_FINISH_REQUIRES_GRANT',
          'StoreKit finish requires a transaction id and the ledger entry that granted it.',
          false,
        );
      }
      const active = inFlightFinishes.get(transactionId);
      if (active !== undefined && active.ledgerEntryId === ledgerEntryId) {
        return active.promise;
      }
      const promise = (async (): Promise<StoreSdkFinishTransactionResult> => {
        const reported: unknown = await sdk.finishTransaction({ transactionId, ledgerEntryId });
        if (!isRecord(reported) || typeof reported.finished !== 'boolean') {
          throw evidenceInvalid('StoreKit returned an invalid finish result.');
        }
        return { finished: reported.finished };
      })();
      inFlightFinishes.set(transactionId, { ledgerEntryId, promise });
      try {
        return await promise;
      } finally {
        if (inFlightFinishes.get(transactionId)?.promise === promise) {
          inFlightFinishes.delete(transactionId);
        }
      }
    },
    async restorePurchases(): Promise<void> {
      requireIos();
      const reported: unknown = await sdk.sync();
      if (!isRecord(reported) || reported.synced !== true) {
        throw storeKitError(
          'STOREKIT_SYNC_FAILED',
          'StoreKit account synchronization did not complete.',
          true,
        );
      }
    },
    addListener<TEvent extends StoreSdkEventName>(
      eventName: TEvent,
      listener: (event: StoreSdkEventOf<TEvent>) => void,
    ): () => void {
      const set = listeners.get(eventName) ?? new Set<(event: never) => void>();
      listeners.set(eventName, set);
      set.add(listener as (event: never) => void);
      if (eventName === 'purchaseUpdated') {
        attachNative();
      }
      return () => {
        set.delete(listener as (event: never) => void);
        if (eventName === 'purchaseUpdated' && set.size === 0) {
          detachNative();
        }
      };
    },
    async getAvailability(): Promise<PlatformProviderAvailability> {
      if (!isIos()) {
        return 'unsupported';
      }
      if (productIds.length === 0) {
        return 'configuration-required';
      }
      try {
        const response: unknown = await sdk.getProducts({
          productIds: productIds.slice(0, maxProductIdsPerLookup),
        });
        const products = isRecord(response) && Array.isArray(response.products)
          ? response.products as readonly unknown[]
          : [];
        return products.some((product) =>
          isValidStoreKitProduct(product) && productIds.includes(product.productId))
          ? 'available'
          : 'configuration-required';
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        return code === 'STOREKIT_INVALID_PRODUCTS' || code === 'STOREKIT_PRODUCT_UNAVAILABLE'
          ? 'configuration-required'
          : 'temporarily-unavailable';
      }
    },
  };
}

/** The App Store profile from the RFC "Capabilities" table. */
export const storeKitStoreSdkCapabilities: StoreSdkCapabilities = Object.freeze({
  purchase: Object.freeze({
    consumable: true,
    durable: true,
    subscription: false,
    quantity: false,
  }),
  offers: false,
  pending: true,
  restore: true,
  finish: 'client',
});

/**
 * StoreKit plugin codes merged over `defaultStoreSdkErrorCodeMap`. Codes the
 * default table already carries (`STOREKIT_PURCHASE_UNCERTAIN`,
 * `STOREKIT_UNAVAILABLE`, `STOREKIT_PRODUCT_UNKNOWN`,
 * `STOREKIT_PRODUCT_UNAVAILABLE`, `STOREKIT_CONFIGURATION_ERROR`,
 * `STOREKIT_EVIDENCE_INVALID`) are repeated here so the table reads complete.
 */
export const storeKitStoreSdkErrorCodeMap: StoreSdkErrorCodeMap = Object.freeze({
  STOREKIT_PURCHASE_UNCERTAIN: 'OUTCOME_UNKNOWN',
  STOREKIT_UNKNOWN_RESULT: 'OUTCOME_UNKNOWN',
  STOREKIT_UNAVAILABLE: 'STORE_UNAVAILABLE',
  STOREKIT_IOS_REQUIRED: 'STORE_UNAVAILABLE',
  STOREKIT_PRODUCT_LOOKUP_FAILED: 'STORE_UNAVAILABLE',
  STOREKIT_SYNC_FAILED: 'STORE_UNAVAILABLE',
  STOREKIT_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
  STOREKIT_PRODUCT_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  STOREKIT_CONFIGURATION_ERROR: 'CONFIGURATION_REQUIRED',
  STOREKIT_INVALID_PRODUCTS: 'CONFIGURATION_REQUIRED',
  STOREKIT_INVALID_PURCHASE: 'CONFIGURATION_REQUIRED',
  STOREKIT_FINISH_REQUIRES_GRANT: 'CONFIGURATION_REQUIRED',
  STOREKIT_EVIDENCE_INVALID: 'INVALID_RESPONSE',
  STOREKIT_TRANSACTION_UNVERIFIED: 'INVALID_RESPONSE',
} satisfies Record<string, CommerceErrorCode>);

/** The default table plus every StoreKit code; what the provider uses. */
export const capacitorStoreKitErrorCodeMap: StoreSdkErrorCodeMap = Object.freeze({
  ...defaultStoreSdkErrorCodeMap,
  ...storeKitStoreSdkErrorCodeMap,
});

const maxProductIdsPerLookup = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const nilUuid = '00000000-0000-0000-0000-000000000000';
const productPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// Shape only: the native side parses the UInt64 id and verified the JWS; the
// backend verifies the JWS again. The patterns stay open so a fake plugin in
// the conformance vectors can use the vector ids.
const transactionPattern = /^[A-Za-z0-9._:-]{1,64}$/u;
const maxSignedTransactionLength = 128 * 1024;

/** Normalizes a required `app-account-token` binding to the lowercase UUID StoreKit expects. */
export function readAppAccountToken(binding: StorePurchaseAccountBinding | undefined): string {
  if (binding === undefined) {
    throw storeKitError(
      'ACCOUNT_BINDING_REQUIRED',
      'StoreKit requires an app account token before a purchase.',
      false,
    );
  }
  if (binding.kind !== 'app-account-token') {
    throw storeKitError(
      'STOREKIT_CONFIGURATION_ERROR',
      `StoreKit requires an app-account-token binding, not ${binding.kind}.`,
      false,
    );
  }
  const value = typeof binding.value === 'string' ? binding.value.toLowerCase() : '';
  if (!uuidPattern.test(value) || value === nilUuid) {
    throw storeKitError(
      'STOREKIT_CONFIGURATION_ERROR',
      'StoreKit requires a non-nil UUID app account token.',
      false,
    );
  }
  return value;
}

/** Maps a verified StoreKit transaction to the SDK purchase: the JWS is the token. */
export function toSdkPurchase(transaction: StoreKitTransaction): StoreSdkPurchase {
  return {
    sku: transaction.productId,
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    state: transaction.revokedAt === undefined ? 'purchased' : 'revoked',
    purchasedAt: transaction.purchasedAt,
    token: transaction.signedTransaction,
    quantity: 1,
    ...(transaction.appAccountToken === undefined
      ? {}
      : {
          accountBinding: {
            kind: 'app-account-token',
            value: transaction.appAccountToken.toLowerCase(),
          },
        }),
    raw: {
      type: transaction.type,
      ...(transaction.revokedAt === undefined ? {} : { revokedAt: transaction.revokedAt }),
      ...(transaction.unfinished === undefined ? {} : { unfinished: transaction.unfinished }),
    },
  };
}

/** Shape check of a transaction the native side reported; the backend verifies the JWS. */
export function isValidStoreKitTransaction(value: unknown): value is StoreKitTransaction {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.transactionId === 'string' && transactionPattern.test(value.transactionId)
    && typeof value.originalTransactionId === 'string'
    && transactionPattern.test(value.originalTransactionId)
    && typeof value.productId === 'string' && productPattern.test(value.productId)
    && (value.type === 'consumable' || value.type === 'non_consumable')
    && typeof value.purchasedAt === 'string' && Number.isFinite(Date.parse(value.purchasedAt))
    && typeof value.signedTransaction === 'string'
    && value.signedTransaction.length > 0
    && value.signedTransaction.length <= maxSignedTransactionLength
    && (value.revokedAt === undefined
      || (typeof value.revokedAt === 'string' && Number.isFinite(Date.parse(value.revokedAt))))
    && (value.appAccountToken === undefined
      || (typeof value.appAccountToken === 'string' && uuidPattern.test(value.appAccountToken)))
    && (value.unfinished === undefined || typeof value.unfinished === 'boolean');
}

function isValidStoreKitProduct(value: unknown): value is StoreKitProduct {
  return isRecord(value)
    && typeof value.productId === 'string' && productPattern.test(value.productId)
    && (value.type === 'consumable' || value.type === 'non_consumable')
    && typeof value.title === 'string'
    && typeof value.description === 'string'
    && typeof value.formattedPrice === 'string'
    && typeof value.currencyCode === 'string' && value.currencyCode.length > 0;
}

function storeKitError(code: string, message: string, retryable: boolean): StoreSdkError & Error {
  return Object.assign(new Error(message), { code, retryable });
}

function evidenceInvalid(message = 'StoreKit transaction evidence is invalid.'): StoreSdkError & Error {
  return storeKitError('STOREKIT_EVIDENCE_INVALID', message, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

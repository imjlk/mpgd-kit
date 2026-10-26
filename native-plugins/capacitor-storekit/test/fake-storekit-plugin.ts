import type { PluginListenerHandle } from '@capacitor/core';

import type {
  StoreKitProduct,
  StoreKitPurchaseOutcome,
  StoreKitTransaction,
} from '../src/definitions.js';
import type { CapacitorStoreKitStoreSdkPlugin } from '../src/store-sdk.js';

export const fakeAccountToken = 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2';

export type FakePurchaseScript = StoreKitPurchaseOutcome | { readonly throws: unknown };
export type FakeFinishScript = { readonly finished: boolean } | { readonly throws: unknown };

export interface FakeStoreKitPlugin extends CapacitorStoreKitStoreSdkPlugin {
  readonly products: StoreKitProduct[];
  /** What `getTransactions` reports. */
  readonly transactions: StoreKitTransaction[];
  readonly calls: string[];
  readonly listenerCount: number;
  productsError: unknown;
  syncError: unknown;
  syncResult: { readonly synced: boolean };
  queuePurchase(script: FakePurchaseScript): void;
  queueFinish(script: FakeFinishScript): void;
  /** Emits `transactionUpdated` with any payload, valid or not. */
  emit(transaction: unknown): void;
  /** Upserts the transaction and emits `transactionUpdated`. */
  report(transaction: StoreKitTransaction): void;
  upsert(transaction: StoreKitTransaction): void;
  remove(transactionId: string): void;
}

export function fakeProduct(overrides: Partial<StoreKitProduct> = {}): StoreKitProduct {
  return {
    productId: 'com.example.game.coins100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Game currency',
    formattedPrice: '$1.00',
    currencyCode: 'USD',
    ...overrides,
  };
}

export function fakeTransaction(
  overrides: Partial<StoreKitTransaction> & { readonly transactionId: string },
): StoreKitTransaction {
  return {
    originalTransactionId: overrides.transactionId,
    productId: 'com.example.game.coins100',
    type: 'consumable',
    appAccountToken: fakeAccountToken,
    purchasedAt: '2026-07-16T12:00:00Z',
    signedTransaction: `header.payload.signature-${overrides.transactionId}`,
    ...overrides,
  };
}

/**
 * In-memory `CapacitorStoreKitPlugin`: `purchase` answers `pending` (the
 * store UI opened, the result arrives as an event) unless a script is queued,
 * `finishTransaction` answers `{ finished: true }` and drops the transaction
 * unless a script is queued, and `transactionUpdated` listeners are
 * registered synchronously like the Capacitor proxy does.
 */
export function createFakeStoreKitPlugin(input: {
  readonly products?: readonly StoreKitProduct[];
  readonly transactions?: readonly StoreKitTransaction[];
} = {}): FakeStoreKitPlugin {
  const products: StoreKitProduct[] = [...(input.products ?? [fakeProduct()])];
  const transactions: StoreKitTransaction[] = [...(input.transactions ?? [])];
  const calls: string[] = [];
  const listeners = new Set<(event: StoreKitTransaction) => void>();
  const purchaseQueue: FakePurchaseScript[] = [];
  const finishQueue: FakeFinishScript[] = [];

  const upsert = (transaction: StoreKitTransaction): void => {
    const index = transactions.findIndex(
      (entry) => entry.transactionId === transaction.transactionId,
    );
    if (index === -1) {
      transactions.push(transaction);
    } else {
      transactions[index] = transaction;
    }
  };
  const remove = (transactionId: string): void => {
    const index = transactions.findIndex((entry) => entry.transactionId === transactionId);
    if (index !== -1) {
      transactions.splice(index, 1);
    }
  };
  const emit = (transaction: unknown): void => {
    for (const listener of [...listeners]) {
      listener(transaction as StoreKitTransaction);
    }
  };

  const plugin: FakeStoreKitPlugin = {
    products,
    transactions,
    calls,
    productsError: undefined,
    syncError: undefined,
    syncResult: { synced: true },
    get listenerCount() {
      return listeners.size;
    },
    async getProducts(request) {
      calls.push(`getProducts:${request.productIds.join(',')}`);
      if (plugin.productsError !== undefined) {
        throw plugin.productsError;
      }
      return {
        products: products.filter((product) => request.productIds.includes(product.productId)),
      };
    },
    async purchase(request) {
      calls.push(`purchase:${request.productId}:${request.appAccountToken}`);
      const script = purchaseQueue.shift() ?? { status: 'pending' as const };
      if ('throws' in script) {
        throw script.throws;
      }
      if (script.status === 'purchased') {
        upsert(script.transaction);
      }
      return script;
    },
    async getTransactions() {
      calls.push('getTransactions');
      return { transactions: [...transactions] };
    },
    async sync() {
      calls.push('sync');
      if (plugin.syncError !== undefined) {
        throw plugin.syncError;
      }
      return plugin.syncResult;
    },
    async finishTransaction(request) {
      calls.push(
        `finish:${request.transactionId}:${request.ledgerEntryId}:${request.appAccountToken}`,
      );
      const script = finishQueue.shift();
      if (script === undefined) {
        // The native token match: a listed transaction bound to another (or
        // no) token is not finished.
        const listed = transactions.find((entry) => entry.transactionId === request.transactionId);
        if (listed !== undefined && listed.appAccountToken?.toLowerCase() !== request.appAccountToken) {
          return { finished: false };
        }
        remove(request.transactionId);
        return { finished: true };
      }
      if ('throws' in script) {
        throw script.throws;
      }
      if (script.finished) {
        remove(request.transactionId);
      }
      return { finished: script.finished };
    },
    addListener(_eventName, listener): Promise<PluginListenerHandle> {
      listeners.add(listener);
      calls.push('addListener:transactionUpdated');
      return Promise.resolve({
        remove: async () => {
          listeners.delete(listener);
          calls.push('removeListener:transactionUpdated');
        },
      });
    },
    queuePurchase(script) {
      purchaseQueue.push(script);
    },
    queueFinish(script) {
      finishQueue.push(script);
    },
    emit,
    report(transaction) {
      upsert(transaction);
      emit(transaction);
    },
    upsert,
    remove,
  };
  return plugin;
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

export async function assertThrowsCode(
  operation: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    const actual = typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
    assertEqual(actual, code, message);
    return error;
  }
  throw new Error(`${message}: expected a rejection with code ${code}.`);
}

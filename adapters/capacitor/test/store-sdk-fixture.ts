import type { PlatformProviderAvailability } from '@mpgd/platform';
import { vi } from 'vitest';

import type {
  StoreSdk,
  StoreSdkCapabilities,
  StoreSdkEvent,
  StoreSdkEventName,
  StoreSdkEventOf,
  StoreSdkFinishTransactionInput,
  StoreSdkFinishTransactionResult,
  StoreSdkProduct,
  StoreSdkPurchase,
  StoreSdkRequestPurchaseInput,
  StoreSdkRequestPurchaseResult,
} from '../src/store-sdk.js';

export type FakeStoreSdkRequestScript =
  | StoreSdkRequestPurchaseResult
  | { readonly throws: unknown };

export type FakeStoreSdkFinishScript =
  | StoreSdkFinishTransactionResult
  | { readonly throws: unknown };

export interface FakeStoreSdkOptions {
  readonly store?: string;
  readonly capabilities?: Partial<StoreSdkCapabilities>;
  readonly products?: readonly StoreSdkProduct[];
  /** Implement `finishTransaction`. Defaults to true. */
  readonly finish?: boolean;
  /** Implement `restorePurchases`. Defaults to true. */
  readonly restore?: boolean;
  /** Implement `getAvailability`; omitted means the SDK reports nothing. */
  readonly availability?: () => Promise<PlatformProviderAvailability>;
}

export interface FakeStoreSdk extends StoreSdk {
  /** Unfinished purchases the SDK reports. */
  readonly purchases: StoreSdkPurchase[];
  readonly requestCalls: StoreSdkRequestPurchaseInput[];
  readonly finishCalls: StoreSdkFinishTransactionInput[];
  readonly fetchCalls: { readonly skus: readonly string[]; readonly type: string }[];
  readonly listenerCount: number;
  restoreCalls: number;
  emit(event: StoreSdkEvent): void;
  /** Adds or replaces a purchase by transaction id and emits `purchaseUpdated`. */
  report(purchase: StoreSdkPurchase): void;
  upsert(purchase: StoreSdkPurchase): void;
  remove(transactionId: string): void;
  queueRequest(script: FakeStoreSdkRequestScript): void;
  queueFinish(script: FakeStoreSdkFinishScript): void;
}

export function createFakeStoreSdk(options: FakeStoreSdkOptions = {}): FakeStoreSdk {
  const listeners = new Map<StoreSdkEventName, Set<(event: never) => void>>();
  const purchases: StoreSdkPurchase[] = [];
  const requestQueue: FakeStoreSdkRequestScript[] = [];
  const finishQueue: FakeStoreSdkFinishScript[] = [];
  const requestCalls: StoreSdkRequestPurchaseInput[] = [];
  const finishCalls: StoreSdkFinishTransactionInput[] = [];
  const fetchCalls: { readonly skus: readonly string[]; readonly type: string }[] = [];
  const products = options.products ?? [];
  const finish = options.finish ?? true;
  const restore = options.restore ?? true;

  const upsert = (purchase: StoreSdkPurchase): void => {
    const index = purchases.findIndex((entry) => entry.transactionId === purchase.transactionId);
    if (index === -1) {
      purchases.push(purchase);
    } else {
      purchases[index] = purchase;
    }
  };
  const remove = (transactionId: string): void => {
    const index = purchases.findIndex((entry) => entry.transactionId === transactionId);
    if (index !== -1) {
      purchases.splice(index, 1);
    }
  };
  const emit = (event: StoreSdkEvent): void => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) {
      (listener as (value: StoreSdkEvent) => void)(event);
    }
  };

  const sdk: FakeStoreSdk = {
    store: options.store ?? 'fixture.store',
    capabilities: {
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      pending: true,
      restore,
      finish: finish ? 'client' : 'server',
      ...options.capabilities,
    },
    purchases,
    requestCalls,
    finishCalls,
    fetchCalls,
    restoreCalls: 0,
    get listenerCount() {
      let count = 0;
      for (const set of listeners.values()) {
        count += set.size;
      }
      return count;
    },
    fetchProducts: vi.fn(async (input) => {
      fetchCalls.push({ skus: [...input.skus], type: input.type });
      return products.filter((product) => input.skus.includes(product.sku));
    }),
    requestPurchase: vi.fn(async (input) => {
      requestCalls.push(input);
      const script = requestQueue.shift() ?? { outcome: 'launched' as const };
      if ('throws' in script) {
        throw script.throws;
      }
      if (script.outcome === 'purchased') {
        upsert(script.purchase);
      }
      return script;
    }),
    getAvailablePurchases: vi.fn(async (input) => purchases.filter(
      (purchase) => (input.includePending ?? false) || purchase.state !== 'pending',
    )),
    ...(finish
      ? {
          finishTransaction: vi.fn(async (input: StoreSdkFinishTransactionInput) => {
            finishCalls.push(input);
            const script = finishQueue.shift() ?? { finished: true };
            if ('throws' in script) {
              throw script.throws;
            }
            if (script.finished) {
              remove(input.transactionId);
            }
            return script;
          }),
        }
      : {}),
    ...(restore
      ? {
          restorePurchases: vi.fn(async () => {
            sdk.restoreCalls += 1;
          }),
        }
      : {}),
    ...(options.availability === undefined ? {} : { getAvailability: options.availability }),
    addListener<TEvent extends StoreSdkEventName>(
      eventName: TEvent,
      listener: (event: StoreSdkEventOf<TEvent>) => void,
    ) {
      const set = listeners.get(eventName) ?? new Set();
      listeners.set(eventName, set);
      set.add(listener as (event: never) => void);
      return () => {
        set.delete(listener as (event: never) => void);
      };
    },
    emit,
    report(purchase) {
      upsert(purchase);
      emit({ type: 'purchaseUpdated', purchase });
    },
    upsert,
    remove,
    queueRequest(script) {
      requestQueue.push(script);
    },
    queueFinish(script) {
      finishQueue.push(script);
    },
  };
  return sdk;
}

export function fakePurchase(
  overrides: Partial<StoreSdkPurchase> & { readonly transactionId: string },
): StoreSdkPurchase {
  return {
    sku: 'gems.small',
    state: 'purchased',
    token: `token-${overrides.transactionId}`,
    quantity: 1,
    ...overrides,
  };
}

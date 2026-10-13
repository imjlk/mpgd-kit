import type { PluginListenerHandle } from '@capacitor/core';

import type {
  CapacitorPlayBillingPlugin,
  PlayProduct,
  PlayPurchase,
  PlayPurchaseOutcome,
} from '../src/definitions.js';

export type FakePlayBillingPurchaseScript =
  | PlayPurchaseOutcome
  | { readonly throws: unknown };

export interface FakePlayBillingPluginOptions {
  readonly products?: readonly PlayProduct[];
  /** Thrown by `getProducts` and `getPurchases` while set. */
  readonly failure?: () => unknown;
  /**
   * Answer of an unscripted `purchase` call. Defaults to a `pending` outcome
   * for the requested product, emitted as `purchaseUpdated` first.
   */
  readonly defaultPurchase?: () => FakePlayBillingPurchaseScript;
}

export interface FakePlayBillingPurchaseCall {
  readonly productId: string;
  readonly offerToken?: string;
  readonly obfuscatedAccountId: string;
}

/**
 * In-memory `CapacitorPlayBillingPlugin`: `getPurchases` lists `purchases`,
 * `purchase` answers the next queued script (default: a `pending` outcome
 * after emitting `purchaseUpdated`, as the Java plugin does), and `report`
 * mirrors the Java `onPurchasesUpdated` path by upserting the purchase and
 * emitting `purchaseUpdated` with the same shape.
 */
export interface FakePlayBillingPlugin extends CapacitorPlayBillingPlugin {
  readonly purchases: PlayPurchase[];
  readonly purchaseCalls: FakePlayBillingPurchaseCall[];
  readonly productCalls: (readonly string[])[];
  readonly listenerCount: number;
  getPurchasesCalls: number;
  failure: (() => unknown) | undefined;
  queuePurchase(script: FakePlayBillingPurchaseScript): void;
  emit(outcome: PlayPurchaseOutcome): void;
  /** Adds or replaces a purchase by token and emits `purchaseUpdated` for it. */
  report(purchase: PlayPurchase): void;
  upsert(purchase: PlayPurchase): void;
  remove(purchaseToken: string): void;
  /** What a backend finalizer does: consume (remove) or acknowledge (flag) a purchase. */
  finalize(purchaseToken: string, how: 'consume' | 'acknowledge'): void;
}

export function createFakePlayBillingPlugin(
  options: FakePlayBillingPluginOptions = {},
): FakePlayBillingPlugin {
  const listeners = new Set<(event: PlayPurchaseOutcome) => void>();
  const purchases: PlayPurchase[] = [];
  const purchaseCalls: FakePlayBillingPurchaseCall[] = [];
  const productCalls: (readonly string[])[] = [];
  const queue: FakePlayBillingPurchaseScript[] = [];
  const products = options.products ?? [];

  const emit = (outcome: PlayPurchaseOutcome): void => {
    for (const listener of [...listeners]) {
      listener(outcome);
    }
  };
  const upsert = (purchase: PlayPurchase): void => {
    const index = purchases.findIndex((entry) => entry.purchaseToken === purchase.purchaseToken);
    if (index === -1) {
      purchases.push(purchase);
    } else {
      purchases[index] = purchase;
    }
  };
  const remove = (purchaseToken: string): void => {
    const index = purchases.findIndex((entry) => entry.purchaseToken === purchaseToken);
    if (index !== -1) {
      purchases.splice(index, 1);
    }
  };

  const plugin: FakePlayBillingPlugin = {
    purchases,
    purchaseCalls,
    productCalls,
    getPurchasesCalls: 0,
    failure: options.failure,
    get listenerCount() {
      return listeners.size;
    },
    async getProducts(input) {
      productCalls.push([...input.productIds]);
      if (plugin.failure !== undefined) {
        throw plugin.failure();
      }
      return {
        products: products.filter((product) => input.productIds.includes(product.productId)),
      };
    },
    async purchase(input) {
      purchaseCalls.push({ ...input });
      const script = queue.shift() ?? options.defaultPurchase?.();
      if (script === undefined) {
        // Java resolves the call after notifying listeners of the same update.
        const purchase = fakePlayPurchase({
          products: [input.productId],
          purchaseToken: `pending-${input.productId}-${purchaseCalls.length}`,
          purchaseState: 'pending',
          obfuscatedAccountId: input.obfuscatedAccountId,
        });
        upsert(purchase);
        const outcome: PlayPurchaseOutcome = { status: 'pending', purchase };
        emit(outcome);
        return outcome;
      }
      if ('throws' in script) {
        throw script.throws;
      }
      if (script.purchase !== undefined) {
        upsert(script.purchase);
        emit(script);
      }
      return script;
    },
    async getPurchases() {
      plugin.getPurchasesCalls += 1;
      if (plugin.failure !== undefined) {
        throw plugin.failure();
      }
      return { purchases: [...purchases] };
    },
    async addListener(_eventName, listener): Promise<PluginListenerHandle> {
      listeners.add(listener);
      return {
        async remove() {
          listeners.delete(listener);
        },
      };
    },
    queuePurchase(script) {
      queue.push(script);
    },
    emit,
    report(purchase) {
      upsert(purchase);
      emit({ status: purchase.purchaseState, purchase });
    },
    upsert,
    remove,
    finalize(purchaseToken, how) {
      if (how === 'consume') {
        remove(purchaseToken);
        return;
      }
      const existing = purchases.find((entry) => entry.purchaseToken === purchaseToken);
      if (existing !== undefined) {
        upsert({ ...existing, isAcknowledged: true });
      }
    },
  };
  return plugin;
}

/** A plugin purchase with the Billing 9.1.0 names, as the Java plugin encodes it. */
export function fakePlayPurchase(
  overrides: Partial<PlayPurchase> & { readonly purchaseToken: string },
): PlayPurchase {
  return {
    products: overrides.products ?? ['gems.small'],
    purchaseToken: overrides.purchaseToken,
    purchaseState: overrides.purchaseState ?? 'purchased',
    purchaseTime: overrides.purchaseTime ?? 1_790_000_000_000,
    isAcknowledged: overrides.isAcknowledged ?? false,
    quantity: overrides.quantity ?? 1,
    ...(overrides.orderId === undefined ? {} : { orderId: overrides.orderId }),
    ...(overrides.obfuscatedAccountId === undefined
      ? {}
      : { obfuscatedAccountId: overrides.obfuscatedAccountId }),
  };
}

export function fakePlayProduct(
  overrides: Partial<PlayProduct> & { readonly productId: string },
): PlayProduct {
  return {
    title: `Product ${overrides.productId}`,
    description: `Fixture product ${overrides.productId}`,
    offers: [
      {
        offerToken: `offer-${overrides.productId}`,
        formattedPrice: '$0.99',
        currencyCode: 'USD',
        priceAmountMicros: 990_000,
      },
    ],
    ...overrides,
  };
}

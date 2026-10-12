import type { CommerceCapabilities } from '@mpgd/platform';
import type {
  ActiveSubscription,
  CommerceProvider,
  FinishTransactionInput,
  RequestPurchaseInput,
  RequestPurchaseResult,
  StoreProduct,
  StorePurchase,
} from '@mpgd/platform/commerce';

/** A commerce capability block, the only commerce source of a capability snapshot. */
export function createCommerceBlock(
  options: {
    readonly oneTime?: boolean;
    readonly subscription?: boolean;
    readonly availability?: CommerceCapabilities['availability'];
  } = {},
): CommerceCapabilities {
  const oneTime = options.oneTime ?? true;
  return {
    purchase: {
      consumable: oneTime,
      durable: oneTime,
      subscription: options.subscription ?? false,
      quantity: false,
    },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'client',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: options.availability ?? 'available',
  };
}

export function createStoreProduct(
  logicalId: string,
  kind: StoreProduct['kind'] = 'consumable',
): StoreProduct {
  return {
    logicalId,
    store: 'fixture-store',
    storeSku: logicalId.toLowerCase(),
    kind,
    title: `Fixture ${logicalId}`,
    description: 'Fixture only',
    price: { formatted: '$1.00', currencyCode: 'USD' },
  };
}

export interface RecordingCommerceProvider extends CommerceProvider {
  /** Every call that reached this provider, by name. */
  readonly calls: string[];
}

/** A provider that records which calls reach it, so a test can prove a call was or was not forwarded. */
export function createRecordingCommerceProvider(
  input: {
    readonly capabilities?: CommerceCapabilities;
    readonly products?: readonly StoreProduct[];
    readonly available?: readonly StorePurchase[];
    readonly withRestore?: boolean;
    /** Offer `getActiveSubscriptions` and answer these subscriptions. */
    readonly activeSubscriptions?: readonly ActiveSubscription[];
    readonly purchaseResult?: RequestPurchaseResult;
    readonly onCall?: (name: string) => void;
  } = {},
): RecordingCommerceProvider {
  const calls: string[] = [];
  const record = (name: string): void => {
    calls.push(name);
    input.onCall?.(name);
  };
  return {
    store: 'fixture-store',
    calls,
    async getCapabilities() {
      record('getCapabilities');
      return input.capabilities ?? createCommerceBlock();
    },
    async fetchProducts() {
      record('fetchProducts');
      return input.products ?? [];
    },
    async requestPurchase(request: RequestPurchaseInput) {
      record(`requestPurchase:${request.logicalId}`);
      return input.purchaseResult ?? { outcome: 'launched' };
    },
    async getAvailablePurchases() {
      record('getAvailablePurchases');
      return input.available ?? [];
    },
    async finishTransaction(request: FinishTransactionInput) {
      record(`finishTransaction:${request.transactionId}`);
      return { finished: true };
    },
    ...(input.withRestore === true
      ? {
          async restorePurchases() {
            record('restorePurchases');
          },
        }
      : {}),
    ...(input.activeSubscriptions === undefined
      ? {}
      : {
          async getActiveSubscriptions() {
            record('getActiveSubscriptions');
            return input.activeSubscriptions ?? [];
          },
        }),
    subscribe() {
      record('subscribe');
      return () => {};
    },
  };
}

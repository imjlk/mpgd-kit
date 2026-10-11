import type { PlatformProviderAvailability, ProductType } from '@mpgd/platform';
import {
  assertRequestPurchaseSupported,
  assertStoreProduct,
  CommerceError,
  createCommerceEventBuffer,
  type CommerceCapabilities,
  type CommerceEvent,
  type CommerceProvider,
  type FetchProductsInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import {
  createVerse8CommerceCapabilities,
  createVerse8StorePurchase,
  maximumVerse8ReportedPurchases,
  readVerse8Identifier,
  verse8CommerceStoreId,
  type Verse8RecordedPurchase,
} from './commerce-contract.js';

/** Store codes the provider attaches to failures of its own. */
export const verse8CommerceStoreCodes = Object.freeze({
  productNotConfigured: 'VERSE8_PRODUCT_NOT_CONFIGURED',
  shopUnavailable: 'VERSE8_SHOP_UNAVAILABLE',
  shopRefreshFailed: 'VERSE8_SHOP_REFRESH_FAILED',
  productNotListed: 'VERSE8_PRODUCT_NOT_LISTED',
  productNotPurchasable: 'VERSE8_PRODUCT_NOT_PURCHASABLE',
  purchaseLimitReached: 'VERSE8_PURCHASE_LIMIT_REACHED',
  shopDialogFailed: 'VERSE8_SHOP_DIALOG_FAILED',
  purchasesUnavailable: 'VERSE8_PURCHASES_UNAVAILABLE',
} as const);

/** The VXShop item fields the provider reads (`VXShopItem` of `@verse8/platform`). */
export interface Verse8CommerceShopItem {
  readonly productId: string;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly purchasable: boolean;
  readonly purchaseLimitReached: boolean;
  readonly purchaseBlockReason?: string | undefined;
}

export interface Verse8CommerceDialogClosedPayload {
  readonly purchased: boolean;
}

/** The VXShop surface the provider drives (`VXShop` of `@verse8/platform/vanilla` fits). */
export interface Verse8CommerceShopClient {
  init(options?: {
    readonly verseId?: string;
    readonly account?: string;
    readonly autoRefresh?: boolean;
  }): void;
  getItem(productId: string): Verse8CommerceShopItem | undefined;
  getItems(): readonly Verse8CommerceShopItem[];
  buyItem(productId: string): void;
  refresh(): Promise<void>;
  /** The dialog closing; its `purchased` flag is a signal to re-read the server, never evidence. */
  onClose?(callback: (payload: Verse8CommerceDialogClosedPayload) => void): () => void;
}

export interface Verse8CommerceProviderProduct {
  readonly id: string;
  readonly type: ProductType;
  /** The VXShop product id (`platformProductIds.verse8`). */
  readonly platformProductId: string;
}

/**
 * The server-push lookup of the Verse8 provider: the purchases the Agent8
 * server recorded from `$onItemPurchased`, read through a game-owned
 * authenticated Agent8 method (`listPurchases` of
 * `createVerse8Agent8CommerceService`). VXShop itself reports no purchase id
 * to the iframe, so this is the only source of a transaction id.
 */
export interface Verse8PurchaseSource {
  listPurchases(): Promise<readonly Verse8RecordedPurchase[]>;
}

export interface Verse8PurchasesChange {
  /**
   * Recorded purchases the signaller already knows, for example the purchase
   * a game-owned realtime message named. The provider reports them at once
   * and still re-reads the purchase source; a purchase of an unconfigured
   * product is ignored.
   */
  readonly purchases?: readonly Verse8RecordedPurchase[];
}

export type Verse8PurchasesChangeListener = (change?: Verse8PurchasesChange) => void;

export interface CreateVerse8CommerceProviderInput {
  readonly products: readonly Verse8CommerceProviderProduct[];
  readonly client: Verse8CommerceShopClient;
  readonly purchases: Verse8PurchaseSource;
  /** Defaults to `verse8`; conformance vectors name their fixture store. */
  readonly store?: StoreId;
  readonly init?: {
    readonly verseId?: string;
    readonly account?: string;
    readonly autoRefresh?: boolean;
  };
  /** VXShop opens inside the Verse8 iframe only; defaults to the iframe check. */
  readonly canOpenShop?: () => boolean;
  /**
   * Signals that the recorded purchases may have changed. The provider
   * reports the purchases the signal carries at once, then re-reads the
   * purchase source and emits `purchaseUpdated` for purchases it has not
   * reported yet. Defaults to the VXShop dialog closing after a purchase
   * (`client.onClose`, which carries no purchase). Observed from creation
   * until `dispose()`, with or without a listener: VXShop lists nothing the
   * reconciler could re-read, so a purchase signalled while nobody listens
   * is buffered for the next listener instead of being lost. A signal that
   * reports nothing new is followed by re-reads at
   * `verse8PurchaseFollowUpDelaysMs`, since the Agent8 event may land after
   * the dialog closed; the first listener also triggers a re-read.
   */
  readonly onPurchasesChanged?: (listener: Verse8PurchasesChangeListener) => () => void;
}

export interface Verse8CommerceProvider extends CommerceProvider {
  restorePurchases(): Promise<void>;
  /** Stops observing the purchase signal; the provider answers no further events. */
  dispose(): void;
}

/**
 * Commerce v2 provider for Verse8 (RFC profile `verse8`, see
 * `createVerse8CommerceCapabilities`). The Agent8 server settles a VXShop
 * purchase: the reserved `$onItemPurchased` event writes the grant, and the
 * client learns of it through the backend's server-push lookup verifier,
 * which answers `pending` until that record exists. The provider therefore
 * never grants and has nothing to finish.
 *
 * - `fetchProducts` lists the configured products VXShop currently offers,
 *   priced in VX.
 * - `requestPurchase` refreshes the shop, checks the live item, and opens the
 *   VXShop dialog with `buyItem`; the answer is always `launched` because the
 *   dialog reports no result the client could trust. A shop that cannot open
 *   (outside the Verse8 iframe), an unlisted or unpurchasable item, or a
 *   reached purchase limit is `failed` with a `VERSE8_*` store code; a failed
 *   refresh is a retryable `STORE_UNAVAILABLE`.
 * - `getAvailablePurchases` is empty: VXShop lists nothing a client could
 *   finish, and the recorded purchases reach the reconciler as events.
 * - `restorePurchases` re-reads the purchase source and emits
 *   `purchaseUpdated` once per recorded purchase not reported before (the
 *   purchase id as `transactionId` and `token`, `verse8.agent8-event.v1`
 *   evidence); the dialog-closed signal does the same. Events before the
 *   first `subscribe` are buffered.
 * - The provider emits no `purchaseError`: VXShop reports no checkout error
 *   to the iframe.
 */
export function createVerse8CommerceProvider(
  input: CreateVerse8CommerceProviderInput,
): Verse8CommerceProvider {
  const store: StoreId = input.store ?? verse8CommerceStoreId;
  if (store.length === 0) {
    throw new TypeError('A Verse8 commerce provider requires a non-empty store id.');
  }
  const products = normalizeProducts(input.products);
  const productsById = new Map(products.map((product) => [product.id, product]));
  const productsByPlatformId = new Map(
    products.map((product) => [product.platformProductId, product]),
  );
  const { client } = input;
  const canOpenShop = input.canOpenShop ?? canOpenDefaultVerse8Shop;
  const buffer = createCommerceEventBuffer();
  const listeners = new Set<(event: CommerceEvent) => void>();
  /** Purchases already reported as `purchaseUpdated`. */
  const reportedPurchases = new Set<string>();
  let initialized = false;

  const ensureInitialized = (): void => {
    if (initialized) {
      return;
    }
    client.init({ ...input.init, autoRefresh: false });
    initialized = true;
  };

  const bound = (collection: Set<string>): void => {
    for (const oldest of collection) {
      if (collection.size <= maximumVerse8ReportedPurchases) {
        break;
      }
      collection.delete(oldest);
    }
  };

  const emit = (event: CommerceEvent): void => {
    if (listeners.size === 0) {
      buffer.push(event);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One listener must not stop the others from receiving the event.
        console.warn('Verse8 commerce listener failed.', errorMessage(error));
      }
    }
  };

  const readRecordedPurchases = async (): Promise<readonly Verse8RecordedPurchase[]> => {
    let purchases: readonly Verse8RecordedPurchase[];
    try {
      purchases = await input.purchases.listPurchases();
    } catch (error) {
      throw toPurchasesError(error);
    }
    if (purchases.length > maximumVerse8ReportedPurchases) {
      console.warn('Verse8 recorded-purchase list exceeds the reporting bound.', {
        limit: maximumVerse8ReportedPurchases,
        ignoredPurchaseCount: purchases.length - maximumVerse8ReportedPurchases,
      });
    }
    // The source lists oldest first (`listPurchases`); the newest purchases
    // are the ones a reconciler has not seen yet.
    return purchases
      .slice(-maximumVerse8ReportedPurchases)
      .filter((purchase) =>
        readVerse8Identifier(purchase.purchaseId) !== undefined
        && readVerse8Identifier(purchase.productId) !== undefined);
  };

  /**
   * Reports a recorded purchase once. The purchase is built before any
   * bookkeeping, so a record the contract rejects is neither marked reported
   * nor emitted.
   */
  const reportPurchase = (recorded: Verse8RecordedPurchase): void => {
    if (reportedPurchases.has(recorded.purchaseId)) {
      return;
    }
    const product = productsByPlatformId.get(recorded.productId);
    if (product === undefined) {
      // A purchase of a product this build does not sell is not this game's.
      return;
    }
    let purchase: StorePurchase;
    try {
      purchase = createVerse8StorePurchase({ store, purchase: recorded, logicalId: product.id });
    } catch (error) {
      // One invalid record must not hide the others.
      console.warn('Verse8 recorded purchase was not reported.', errorMessage(error));
      return;
    }
    reportedPurchases.add(recorded.purchaseId);
    bound(reportedPurchases);
    emit({ type: 'purchaseUpdated', purchase });
  };

  /** Re-reads the recorded purchases and reports the ones not reported yet. */
  const refreshPurchases = async (): Promise<void> => {
    for (const recorded of await readRecordedPurchases()) {
      reportPurchase(recorded);
    }
  };

  /** Reports the purchases a signal carries; the read that follows confirms the rest. */
  const reportSignalledPurchases = (purchases: readonly Verse8RecordedPurchase[]): void => {
    for (const recorded of purchases.slice(0, maximumVerse8ReportedPurchases)) {
      if (
        readVerse8Identifier(recorded.purchaseId) === undefined
        || readVerse8Identifier(recorded.productId) === undefined
      ) {
        continue;
      }
      reportPurchase(recorded);
    }
  };
  /** Re-reads in the background; resolves with the number of purchases newly reported. */
  const refreshInBackground = async (): Promise<number> => {
    const before = reportedPurchases.size;
    try {
      await refreshPurchases();
    } catch (error) {
      console.warn('Verse8 recorded-purchase refresh failed.', errorMessage(error));
      return 0;
    }
    return reportedPurchases.size - before;
  };
  /**
   * The Agent8 event may land after the dialog closed: a signal that reported
   * nothing new is followed by a few spaced re-reads until a record appears.
   */
  const followUpTimers = new Set<ReturnType<typeof setTimeout>>();
  const refreshWithFollowUps = (change: Verse8PurchasesChange | undefined): void => {
    void refreshInBackground().then((reported) => {
      if (reported > 0 || change?.purchases !== undefined || disposed) {
        return;
      }
      for (const delay of verse8PurchaseFollowUpDelaysMs) {
        const timer = setTimeout(() => {
          followUpTimers.delete(timer);
          if (!disposed) {
            void refreshInBackground();
          }
        }, delay);
        followUpTimers.add(timer);
      }
    });
  };
  let disposed = false;

  const subscribeToPurchaseChanges = input.onPurchasesChanged
    ?? ((listener: Verse8PurchasesChangeListener) => subscribeToDialogClose(client, listener));
  // Observed for the provider's lifetime: a purchase signalled while nobody
  // listens is buffered, since no list read could find it later.
  let detachPurchaseSignal: (() => void) | undefined = subscribeToPurchaseChanges((change) => {
    if (change?.purchases !== undefined && Array.isArray(change.purchases)) {
      reportSignalledPurchases(change.purchases);
    }
    refreshWithFollowUps(change);
  });

  const failed = (
    code: 'ITEM_UNAVAILABLE' | 'CONFIGURATION_REQUIRED' | 'STORE_UNAVAILABLE',
    storeCode: string,
    message: string,
    retryable?: boolean,
  ): RequestPurchaseResult => ({
    outcome: 'failed',
    error: new CommerceError(code, {
      message,
      storeCode,
      ...(retryable === undefined ? {} : { retryable }),
    }).toCommerceErrorInfo(),
  });

  const provider: Verse8CommerceProvider = {
    store,
    async getCapabilities(): Promise<CommerceCapabilities> {
      const availability: PlatformProviderAvailability = products.length === 0
        ? 'configuration-required'
        : 'available';
      return createVerse8CommerceCapabilities(availability);
    },
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      if ((request.type ?? 'all') === 'subscription' || products.length === 0) {
        return [];
      }
      let items: ReadonlyMap<string, Verse8CommerceShopItem>;
      try {
        ensureInitialized();
        await client.refresh();
        items = new Map(client.getItems().map((item) => [item.productId, item]));
      } catch (error) {
        throw new CommerceError('STORE_UNAVAILABLE', {
          message: `VXShop could not be refreshed: ${errorMessage(error)}`,
          storeCode: readStoreCode(error) ?? verse8CommerceStoreCodes.shopRefreshFailed,
          retryable: true,
          cause: error,
        });
      }
      const listed: StoreProduct[] = [];
      for (const product of products) {
        if (request.logicalIds !== undefined && !request.logicalIds.includes(product.id)) {
          continue;
        }
        const item = items.get(product.platformProductId);
        if (item === undefined) {
          continue;
        }
        const storeProduct = toStoreProduct(store, product, item);
        if (storeProduct !== undefined) {
          listed.push(storeProduct);
        }
      }
      return listed;
    },
    async requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      const product = productsById.get(request.logicalId);
      if (product === undefined) {
        return failed(
          'ITEM_UNAVAILABLE',
          verse8CommerceStoreCodes.productNotConfigured,
          `Verse8 product ${request.logicalId} is not configured.`,
        );
      }
      // Both one-time kinds are sold; a subscription-typed product and a
      // quantity above one are rejected before the dialog opens.
      assertRequestPurchaseSupported(
        createVerse8CommerceCapabilities('available'),
        request,
        purchaseKindOf(product.type),
      );
      if (!canOpenShop()) {
        return failed(
          'CONFIGURATION_REQUIRED',
          verse8CommerceStoreCodes.shopUnavailable,
          'VXShop opens inside the Verse8 iframe only.',
        );
      }
      let item: Verse8CommerceShopItem | undefined;
      try {
        ensureInitialized();
        await client.refresh();
        item = client.getItem(product.platformProductId);
      } catch (error) {
        return failed(
          'STORE_UNAVAILABLE',
          readStoreCode(error) ?? verse8CommerceStoreCodes.shopRefreshFailed,
          `VXShop could not be refreshed: ${errorMessage(error)}`,
          true,
        );
      }
      if (item === undefined) {
        return failed(
          'ITEM_UNAVAILABLE',
          verse8CommerceStoreCodes.productNotListed,
          `VXShop does not list ${product.platformProductId}.`,
        );
      }
      if (item.purchaseLimitReached) {
        return failed(
          'ITEM_UNAVAILABLE',
          verse8CommerceStoreCodes.purchaseLimitReached,
          `VXShop purchase limit reached for ${product.platformProductId}.`,
        );
      }
      if (!item.purchasable) {
        return failed(
          'ITEM_UNAVAILABLE',
          verse8CommerceStoreCodes.productNotPurchasable,
          item.purchaseBlockReason === undefined
            ? `VXShop item ${product.platformProductId} is not purchasable.`
            : `VXShop item ${product.platformProductId} is not purchasable: ${item.purchaseBlockReason}`,
        );
      }
      // The dialog reports no result the client could trust: the Agent8
      // event is the record, and the reconciler learns of it as an event.
      try {
        client.buyItem(product.platformProductId);
      } catch (error) {
        return failed(
          'STORE_UNAVAILABLE',
          readStoreCode(error) ?? verse8CommerceStoreCodes.shopDialogFailed,
          `VXShop dialog could not be opened: ${errorMessage(error)}`,
          true,
        );
      }
      return { outcome: 'launched' };
    },
    async getAvailablePurchases(): Promise<readonly StorePurchase[]> {
      return [];
    },
    async restorePurchases(): Promise<void> {
      await refreshPurchases();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        buffer.drain((event) => {
          try {
            listener(event);
          } catch (error) {
            console.warn('Verse8 commerce listener failed.', errorMessage(error));
          }
        });
        // A fresh listener (a new session, or a restart) learns of the
        // purchases recorded while nobody listened; the reconciler matches
        // them to its records by store and transaction id.
        void refreshInBackground();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      detachPurchaseSignal?.();
      detachPurchaseSignal = undefined;
      for (const timer of followUpTimers) {
        clearTimeout(timer);
      }
      followUpTimers.clear();
    },
  };
  return provider;
}

/** Delays of the re-reads that follow a purchase signal nothing was recorded for yet. */
export const verse8PurchaseFollowUpDelaysMs: readonly number[] = Object.freeze([
  1_000, 3_000, 7_000,
]);

function purchaseKindOf(type: ProductType): PurchaseKind {
  switch (type) {
    case 'consumable':
      return 'consumable';
    case 'non_consumable':
      return 'durable';
    case 'subscription':
      return 'subscription';
  }
}

/** The default purchase signal: the VXShop dialog closing after a purchase. */
function subscribeToDialogClose(
  client: Verse8CommerceShopClient,
  listener: Verse8PurchasesChangeListener,
): () => void {
  if (client.onClose === undefined) {
    return () => {};
  }
  try {
    return client.onClose((payload) => {
      if (payload.purchased) {
        listener();
      }
    });
  } catch (error) {
    console.debug(
      'VXShop dialog signal is unavailable; purchases are read on demand only.',
      errorMessage(error),
    );
    return () => {};
  }
}

function toStoreProduct(
  store: StoreId,
  product: Verse8CommerceProviderProduct,
  item: Verse8CommerceShopItem,
): StoreProduct | undefined {
  const kind = product.type === 'consumable'
    ? 'consumable'
    : product.type === 'non_consumable'
      ? 'durable'
      : undefined;
  if (kind === undefined) {
    return undefined;
  }
  try {
    return assertStoreProduct({
      logicalId: product.id,
      store,
      storeSku: product.platformProductId,
      kind,
      title: item.name,
      description: item.description,
      price: { formatted: `${String(item.price)} VX`, currencyCode: 'VX' },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: `VXShop reported an invalid item for ${product.platformProductId}.`,
      cause: error,
    });
  }
}

function normalizeProducts(
  products: readonly Verse8CommerceProviderProduct[],
): readonly Verse8CommerceProviderProduct[] {
  const logicalIds = new Set<string>();
  const platformIds = new Set<string>();
  return products.map((product) => {
    const platformProductId = product.platformProductId.trim();
    if (product.id.trim().length === 0 || platformProductId.length === 0) {
      throw new TypeError('Verse8 commerce product IDs must be non-empty.');
    }
    if (logicalIds.has(product.id) || platformIds.has(platformProductId)) {
      throw new TypeError('Verse8 commerce product IDs must be unique.');
    }
    logicalIds.add(product.id);
    platformIds.add(platformProductId);
    return { id: product.id, type: product.type, platformProductId };
  });
}

function canOpenDefaultVerse8Shop(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/** A thrown purchase-source failure as a retryable `STORE_UNAVAILABLE`, unless it already is a commerce error. */
function toPurchasesError(error: unknown): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  return new CommerceError('STORE_UNAVAILABLE', {
    message: `Verse8 recorded purchases are unavailable: ${errorMessage(error)}`,
    storeCode: verse8CommerceStoreCodes.purchasesUnavailable,
    retryable: true,
    cause: error,
  });
}

function readStoreCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { readonly code?: unknown };
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

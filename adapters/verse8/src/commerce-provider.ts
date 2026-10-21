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
   * (`client.onClose`, which carries no purchase). Observed while a listener
   * exists; the first listener triggers a re-read of the purchase source, so
   * purchases recorded while nobody listened (or before a restart) are found
   * then. A signal that reports no new purchase id — no list, an empty list,
   * or only ids already reported, including that id-less default — increments
   * a count of outstanding unsettled signals and opens or extends re-reads at
   * `verse8PurchaseFollowUpDelaysMs`. Each purchase id newly reported by the
   * immediate re-read or a follow-up read settles one outstanding signal. A
   * signal that names a new purchase id settles that signal: it does not join
   * the count, so it does not consume an earlier slot or schedule re-reads.
   * Timers cancel only when the count reaches 0, the window's attempts
   * elapse, or the last listener unsubscribes. An id the bounded set has
   * already emitted is not a new record. The provider does not grant; it only
   * re-reads the purchase source.
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
  const oneTimeProductCount = products.filter((product) => product.type !== 'subscription').length;
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
  /**
   * Ids already emitted, then dropped to keep `reportedPurchases` bounded.
   * A later read must not emit them again: that duplicate would look like a
   * newly settled purchase and settle an outstanding signal for a different one.
   */
  const forgottenPurchases = new Set<string>();
  let initialized = false;

  const ensureInitialized = (): void => {
    if (initialized) {
      return;
    }
    client.init({ ...input.init, autoRefresh: false });
    initialized = true;
  };

  const trimToBound = (collection: Set<string>): string[] => {
    const removed: string[] = [];
    for (const oldest of collection) {
      if (collection.size <= maximumVerse8ReportedPurchases) {
        break;
      }
      collection.delete(oldest);
      removed.push(oldest);
    }
    return removed;
  };
  const rememberEvicted = (evicted: readonly string[]): void => {
    for (const id of evicted) {
      forgottenPurchases.add(id);
    }
    trimToBound(forgottenPurchases);
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
   * nor emitted. Returns whether this call emitted the purchase. The reported
   * set is bounded, so a size comparison cannot answer that.
   */
  const reportPurchase = (recorded: Verse8RecordedPurchase): boolean => {
    if (reportedPurchases.has(recorded.purchaseId) || forgottenPurchases.has(recorded.purchaseId)) {
      return false;
    }
    const product = productsByPlatformId.get(recorded.productId);
    if (product === undefined) {
      // A purchase of a product this build does not sell is not this game's.
      return false;
    }
    let purchase: StorePurchase;
    try {
      purchase = createVerse8StorePurchase({ store, purchase: recorded, logicalId: product.id });
    } catch (error) {
      // One invalid record must not hide the others.
      console.warn('Verse8 recorded purchase was not reported.', errorMessage(error));
      return false;
    }
    reportedPurchases.add(recorded.purchaseId);
    rememberEvicted(trimToBound(reportedPurchases));
    emit({ type: 'purchaseUpdated', purchase });
    return true;
  };

  /** Re-reads the recorded purchases and reports the ones not reported yet. */
  const refreshPurchases = async (): Promise<number> => {
    let reported = 0;
    for (const recorded of await readRecordedPurchases()) {
      if (reportPurchase(recorded)) {
        reported += 1;
      }
    }
    return reported;
  };

  /** Reports the purchases a signal carries; the read that follows confirms the rest. */
  const reportSignalledPurchases = (purchases: readonly Verse8RecordedPurchase[]): number => {
    let reported = 0;
    for (const recorded of purchases.slice(0, maximumVerse8ReportedPurchases)) {
      if (
        readVerse8Identifier(recorded.purchaseId) === undefined
        || readVerse8Identifier(recorded.productId) === undefined
      ) {
        continue;
      }
      if (reportPurchase(recorded)) {
        reported += 1;
      }
    }
    return reported;
  };
  /** Re-reads in the background; resolves with the number of purchases newly reported. */
  const refreshInBackground = async (): Promise<number> => {
    try {
      return await refreshPurchases();
    } catch (error) {
      console.warn('Verse8 recorded-purchase refresh failed.', errorMessage(error));
      return 0;
    }
  };
  /**
   * Signals that reported no new purchase id and have not been settled by a
   * later read. A purchase id the signal itself names settles that signal and
   * is not added here, so it cannot cancel a window opened for a different
   * purchase. Timers cancel only when this reaches 0, the window's attempts
   * elapse, or the last listener unsubscribes.
   */
  let outstandingUnsettledSignals = 0;
  /**
   * Id-less signals whose immediate re-read has not finished. A window that
   * elapses meanwhile gives up on the signals it was covering, not on these.
   */
  let pendingUnsettledReads = 0;
  let observationEpoch = 0;
  /**
   * The Agent8 event may land after the dialog closed. One window of
   * follow-ups at a time; a new unsettled signal restarts it so that signal
   * gets a full delay schedule. The schedule is the existing
   * `verse8PurchaseFollowUpDelaysMs` bound (about nine minutes).
   */
  const followUpTimers = new Set<ReturnType<typeof setTimeout>>();
  let followUpGeneration = 0;
  const clearFollowUpTimers = (): void => {
    for (const timer of followUpTimers) {
      clearTimeout(timer);
    }
    followUpTimers.clear();
  };
  const cancelFollowUps = (): void => {
    followUpGeneration += 1;
    clearFollowUpTimers();
  };
  const endObservation = (): void => {
    observationEpoch += 1;
    cancelFollowUps();
    outstandingUnsettledSignals = 0;
    pendingUnsettledReads = 0;
  };
  const settleOutstanding = (newlyReported: number): void => {
    if (newlyReported <= 0) {
      return;
    }
    outstandingUnsettledSignals = Math.max(0, outstandingUnsettledSignals - newlyReported);
  };
  const scheduleFollowUps = (): void => {
    cancelFollowUps();
    const generation = followUpGeneration;
    const epoch = observationEpoch;
    for (const delay of verse8PurchaseFollowUpDelaysMs) {
      const timer = setTimeout(() => {
        followUpTimers.delete(timer);
        if (disposed || generation !== followUpGeneration) {
          return;
        }
        void refreshInBackground().then((late) => {
          if (disposed || listeners.size === 0 || epoch !== observationEpoch) {
            return;
          }
          // A read started by an older window can still report a purchase.
          // That id settles one outstanding signal even if a newer window
          // has since been scheduled.
          settleOutstanding(late);
          if (outstandingUnsettledSignals === 0) {
            cancelFollowUps();
            return;
          }
          if (generation !== followUpGeneration || followUpTimers.size > 0) {
            return;
          }
          // This window's attempts elapsed. Keep only signals whose immediate
          // re-read is still in flight; restorePurchases and the next signal
          // read the rest.
          outstandingUnsettledSignals = pendingUnsettledReads;
          if (outstandingUnsettledSignals === 0) {
            cancelFollowUps();
          }
        });
      }, delay);
      // A Node host (tests, tooling) must not stay alive for a follow-up read.
      unrefTimer(timer);
      followUpTimers.add(timer);
    }
  };
  const refreshWithFollowUps = (signalReportedNew: boolean): void => {
    const epoch = observationEpoch;
    // A signal that names a new purchase id settles itself. It does not open
    // a slot, and that id is not charged against an earlier outstanding signal.
    const openedSlot = !signalReportedNew;
    if (openedSlot) {
      outstandingUnsettledSignals += 1;
      pendingUnsettledReads += 1;
    }
    void refreshInBackground().then((reported) => {
      // A stale read from a previous observation must not touch the new
      // epoch's pending count. endObservation already zeroed the old one.
      if (disposed || epoch !== observationEpoch) {
        return;
      }
      if (openedSlot) {
        pendingUnsettledReads = Math.max(0, pendingUnsettledReads - 1);
      }
      if (listeners.size === 0) {
        return;
      }
      settleOutstanding(reported);
      if (outstandingUnsettledSignals === 0) {
        cancelFollowUps();
        return;
      }
      if (!openedSlot) {
        // This signal's purchase is already visible. Leave a window that may
        // belong to an earlier unsettled purchase running.
        return;
      }
      scheduleFollowUps();
    });
  };
  let disposed = false;

  const subscribeToPurchaseChanges = input.onPurchasesChanged
    ?? ((listener: Verse8PurchasesChangeListener) => subscribeToDialogClose(client, listener));
  // Observed while a listener exists: the first listener's own re-read finds
  // the purchases recorded meanwhile, so an abandoned provider (a gateway
  // rebuilt without disposal) holds no VXShop listener.
  let detachPurchaseSignal: (() => void) | undefined;
  const attachPurchaseSignal = (): void => {
    if (detachPurchaseSignal !== undefined || disposed) {
      return;
    }
    detachPurchaseSignal = subscribeToPurchaseChanges((change) => {
      const signalReportedNew = change?.purchases !== undefined && Array.isArray(change.purchases)
        ? reportSignalledPurchases(change.purchases) > 0
        : false;
      refreshWithFollowUps(signalReportedNew);
    });
  };
  const detachPurchaseSignalIfIdle = (): void => {
    if (listeners.size > 0 || detachPurchaseSignal === undefined) {
      return;
    }
    const detach = detachPurchaseSignal;
    detachPurchaseSignal = undefined;
    detach();
    endObservation();
  };

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
      // A catalog without a consumable or durable product sells nothing here.
      const availability: PlatformProviderAvailability = oneTimeProductCount === 0
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
      attachPurchaseSignal();
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
        detachPurchaseSignalIfIdle();
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      detachPurchaseSignal?.();
      detachPurchaseSignal = undefined;
      endObservation();
    },
  };
  return provider;
}

/**
 * Delays of the one follow-up window for purchase signals that reported no
 * new purchase id. Each such signal, including the id-less default dialog
 * close, increments the outstanding unsettled count and opens or restarts
 * this window: the Agent8 event may land seconds after the dialog closed.
 * A purchase id the signal itself names settles that signal and leaves an
 * earlier window running. A purchase id newly reported by a re-read or a
 * follow-up settles one outstanding signal. The window ends when that count
 * reaches 0, when these attempts elapse, or when the last listener leaves.
 * An id the bounded set has already emitted is not a new record. After the
 * window, `restorePurchases` and the next signal are the readers. The
 * provider does not grant; these reads only re-read the purchase source.
 */
export const verse8PurchaseFollowUpDelaysMs: readonly number[] = Object.freeze([
  1_000, 3_000, 7_000, 15_000, 30_000, 60_000, 120_000, 300_000,
]);

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as { readonly unref?: () => unknown };
  if (typeof handle.unref === 'function') {
    handle.unref();
  }
}

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

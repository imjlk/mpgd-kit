import type {
  CommerceDiagnostic,
  PlatformProviderAvailability,
  ProductInfo,
  PurchaseResult,
} from '@mpgd/platform';
import {
  assertRequestPurchaseSupported,
  assertStoreProduct,
  assertStorePurchase,
  CommerceError,
  createCommerceEventBuffer,
  type CommerceCapabilities,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceProvider,
  type FetchProductsInput,
  type FinishTransactionInput,
  type FinishTransactionResult,
  type GetAvailablePurchasesInput,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseState,
} from '@mpgd/platform/commerce';

import { aitIapDiagnosticCodes, type AitIapDiagnosticCode } from './iap-diagnostics.js';
import {
  createAitIapController,
  createAitIapEvidence,
  errorMessage,
  isAitIapOrderId,
  type AitIapController,
  type AitIapControllerOptions,
  type AitIapGrantSource,
  type AitIapPendingOrderReconciliation,
  type NormalizedAitIapProduct,
} from './iap.js';
import { createAitLifecycleAdapter } from './lifecycle.js';

/** The open store id of the Apps in Toss provider (RFC "Capabilities"). */
export const aitCommerceStoreId = 'apps-in-toss' as const;

/** Bounds what one untrusted pending-order list can turn into available purchases. */
const maximumAvailableAitIapOrders = 64;

/**
 * RFC "Errors" class of every Apps in Toss IAP diagnostic code. The code
 * itself travels as `storeCode`. `OUTCOME_UNKNOWN` and `ALREADY_OWNED`
 * classes never end an attempt: `requestPurchase` answers `launched` for
 * them, and the reconciler resolves the attempt from the pending orders.
 */
export const aitIapCommerceErrorCodeMap: Readonly<Record<AitIapDiagnosticCode, CommerceErrorCode>> =
  Object.freeze({
    AIT_IAP_UNAVAILABLE: 'CONFIGURATION_REQUIRED',
    AIT_IAP_PRODUCT_NOT_CONFIGURED: 'ITEM_UNAVAILABLE',
    AIT_IAP_UNSUPPORTED_APP_VERSION: 'STORE_UNAVAILABLE',
    AIT_IAP_CATALOG_UNAVAILABLE: 'STORE_UNAVAILABLE',
    AIT_IAP_CATALOG_EMPTY: 'ITEM_UNAVAILABLE',
    AIT_IAP_CONFIGURED_SKUS_NOT_VISIBLE: 'ITEM_UNAVAILABLE',
    AIT_IAP_PRODUCT_TYPE_UNSUPPORTED: 'ITEM_UNAVAILABLE',
    AIT_IAP_PREPARATION_FAILED: 'NOT_PREPARED',
    AIT_IAP_PENDING_ORDER_CHECK_FAILED: 'STORE_UNAVAILABLE',
    AIT_IAP_PENDING_ORDER_RECOVERED: 'ALREADY_OWNED',
    AIT_IAP_PENDING_ORDER_UNRESOLVED: 'ALREADY_OWNED',
    AIT_IAP_ATTEMPT_STORAGE_UNAVAILABLE: 'OUTCOME_UNKNOWN',
    AIT_IAP_ATTEMPT_PENDING: 'IN_PROGRESS',
    AIT_IAP_CHECKOUT_IN_PROGRESS: 'IN_PROGRESS',
    AIT_IAP_CHECKOUT_START_FAILED: 'STORE_UNAVAILABLE',
    AIT_IAP_CHECKOUT_TIMEOUT: 'OUTCOME_UNKNOWN',
    AIT_IAP_NATIVE_PURCHASE_FAILED: 'OUTCOME_UNKNOWN',
    AIT_IAP_GRANT_PENDING: 'OUTCOME_UNKNOWN',
    AIT_IAP_GRANT_COMPLETION_FAILED: 'OUTCOME_UNKNOWN',
    AIT_IAP_RESTORE_TIMEOUT: 'STORE_UNAVAILABLE',
  });

/** A paid order the host already knows about when it signals a pending-order change. */
export interface AitKnownPendingOrder {
  readonly orderId: string;
  readonly sku: string;
  readonly paymentCompletedDate?: string;
}

export interface AitPendingOrdersChange {
  /**
   * Paid, ungranted orders the host knows at signal time, for example from
   * its own checkout callback. The provider reports them at once and still
   * re-reads `getPendingOrders()`; an order for an unconfigured SKU is ignored.
   */
  readonly orders?: readonly AitKnownPendingOrder[];
}

export type AitPendingOrdersChangeListener = (change?: AitPendingOrdersChange) => void;

export interface CreateAitCommerceProviderInput extends AitIapControllerOptions {
  /**
   * Signals that the provider's pending-order list may have changed, for
   * example because the app resumed from the Toss checkout page. The provider
   * then re-reads `getPendingOrders()` and emits `purchaseUpdated` for paid
   * orders it has not reported yet; orders the signal carries are reported
   * before the read. Defaults to the Apps in Toss lifecycle resume signal
   * (`createAitLifecycleAdapter().onResume`).
   */
  readonly onPendingOrdersChanged?: (listener: AitPendingOrdersChangeListener) => () => void;
}

export interface AitCommerceProvider extends CommerceProvider {
  readonly store: typeof aitCommerceStoreId;
  finishTransaction(input: FinishTransactionInput): Promise<FinishTransactionResult>;
  restorePurchases(): Promise<void>;
  /** Stops listening for pending-order changes; the provider answers no further events. */
  dispose(): void;
}

/**
 * Commerce provider for Apps in Toss (RFC profile `apps-in-toss`):
 * consumable and durable one-time products, no subscription, no quantity,
 * `lifecycle.finish: 'host'`, `authority.evidence: 'host-callback'`, and
 * `accountBinding: 'host'`. It runs the host bridge's IAP machinery (one IAP
 * lock, durable attempt markers, the pre-checkout pending-order barrier and
 * the acknowledgement barriers).
 *
 * - `requestPurchase` opens `createOneTimePurchaseOrder()`. The game-owned
 *   `verifyIapProductGrant` hook inside the SDK's grant callback is the only
 *   server confirmation; a `purchased` result is produced only after that
 *   hook confirmed the grant, with the order id as `transactionId` and
 *   `token` and the `apps-in-toss.iap.callback.v1` envelope as evidence.
 *   Every other non-terminal outcome (grant pending, acknowledgement
 *   unconfirmed, checkout timeout) is `launched`: the attempt stays open and
 *   the reconciler resolves it from `getAvailablePurchases`.
 * - `getAvailablePurchases` lists the provider's paid, ungranted orders
 *   (`getPendingOrders()`) as `purchased`, orders whose server grant exists
 *   but whose `completeProductGrant()` was not confirmed as `purchased`, and,
 *   with `includePending`, orders this session observed in a checkout that
 *   the provider does not list yet as `pending`.
 * - `finishTransaction` is the host finish: with the reconciler's ledger
 *   entry id in hand it confirms the grant through `verifyIapProductGrant`
 *   (the game side of the bridge is not trusted to hold a grant; the hook
 *   must be idempotent per order and reachable for v2 finishes), then
 *   acknowledges a listed order with `completeProductGrant()`, and settles
 *   the barrier of an order the host already finished. It never grants.
 * - `restorePurchases` runs the pending-order recovery pass (prepare,
 *   verify through `verifyIapProductGrant`, acknowledge) and reports what it
 *   settled and what stayed paid-but-ungranted as `purchaseUpdated` events.
 *
 * The provider emits no `purchaseError`: every Apps in Toss checkout outcome
 * arrives through the terminal callback of the purchase call, so a failure
 * is a synchronous `cancelled` or `failed` result.
 */
export function createAitCommerceProvider(
  input: CreateAitCommerceProviderInput,
): AitCommerceProvider {
  return createAitCommerceProviderFromController(createAitIapController(input), input);
}

/**
 * Builds the provider over an existing controller so the host bridge owns the
 * controller its provider runs on. Internal to the package.
 */
export function createAitCommerceProviderFromController(
  controller: AitIapController,
  input: Pick<CreateAitCommerceProviderInput, 'onPendingOrdersChanged'> = {},
): AitCommerceProvider {
  const store = aitCommerceStoreId;
  const buffer = createCommerceEventBuffer();
  const listeners = new Set<(event: CommerceEvent) => void>();
  /**
   * Orders the host finished this session and the reconciler has not finished
   * yet: the SDK completed them after a confirmed grant callback, or a
   * recovery pass acknowledged them. Listed as available until then, so a
   * dropped buffered event for one of them is still recoverable.
   */
  const hostFinishedOrders = new Map<string, NormalizedAitIapProduct>();
  /**
   * Orders already reported as `purchaseUpdated`, with how the provider
   * learned of them. A `listed` entry is pruned once the provider stops
   * listing the order; a `signalled` entry (handed over by the host, not read
   * from the list yet) stays until the list confirms or the order finishes.
   */
  const reportedOrders = new Map<string, 'listed' | 'signalled'>();
  /** Orders a checkout of this session observed whose grant is still unconfirmed, until the provider lists them. */
  const openAttempts = new Map<string, NormalizedAitIapProduct>();
  /** Product per order id this session reported, so a finish needs no second list read. */
  const knownOrders = new Map<string, NormalizedAitIapProduct>();
  /**
   * Orders the reconciler finished through this provider. The provider may
   * still list one for a while after `completeProductGrant()`; such an order
   * is neither reported again nor available, and it is forgotten once a read
   * no longer lists it.
   */
  const finishedOrders = new Set<string>();

  /** Every per-session collection is bounded like the available-purchase list; the oldest entry goes first. */
  const bound = (collection: Set<string> | Map<string, unknown>): void => {
    for (const oldest of collection.keys()) {
      if (collection.size <= maximumAvailableAitIapOrders) {
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
        console.warn('AIT IAP commerce listener failed.', errorMessage(error));
      }
    }
  };

  const toStorePurchase = (
    product: NormalizedAitIapProduct,
    orderId: string,
    state: StorePurchaseState,
    source: AitIapGrantSource,
    purchasedAt?: string,
  ): StorePurchase => {
    let purchase: StorePurchase;
    try {
      purchase = assertStorePurchase({
        store,
        transactionId: orderId,
        storeSku: product.sku,
        logicalId: product.productId,
        quantity: 1,
        state,
        ...(purchasedAt === undefined ? {} : { purchasedAt }),
        token: orderId,
        evidence: createAitIapEvidence(orderId, product.sku, source),
        accountBinding: { kind: 'host-identity' },
      });
    } catch (error) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: 'Apps in Toss reported an invalid order.',
        cause: error,
      });
    }
    knownOrders.set(orderId, product);
    bound(knownOrders);
    return purchase;
  };

  /**
   * Reports a paid order once. The purchase is built before any bookkeeping,
   * so an order the contract rejects is neither marked reported nor emitted.
   */
  const reportPurchased = (
    product: NormalizedAitIapProduct,
    orderId: string,
    how: 'listed' | 'signalled',
    purchasedAt?: string,
  ): void => {
    if (finishedOrders.has(orderId)) {
      // Finished through this provider; the host has not caught up yet.
      return;
    }
    if (reportedOrders.has(orderId)) {
      if (how === 'listed') {
        reportedOrders.set(orderId, 'listed');
      }
      openAttempts.delete(orderId);
      return;
    }
    const purchase = toStorePurchase(
      product,
      orderId,
      'purchased',
      'pending-order-restore',
      purchasedAt,
    );
    reportedOrders.set(orderId, how);
    bound(reportedOrders);
    openAttempts.delete(orderId);
    emit({ type: 'purchaseUpdated', purchase });
  };

  /**
   * The reconciler finished the order. An order this provider acknowledged
   * is neither reported nor available again while the host still lists it;
   * one the host had finished on its own is merely dropped from the session
   * bookkeeping, since nothing of it is left to suppress.
   */
  const forgetOrder = (orderId: string, acknowledgedHere: boolean): void => {
    hostFinishedOrders.delete(orderId);
    reportedOrders.delete(orderId);
    openAttempts.delete(orderId);
    knownOrders.delete(orderId);
    if (acknowledgedHere) {
      finishedOrders.add(orderId);
      bound(finishedOrders);
    }
  };

  /** Drops finished orders the provider no longer lists; the rest are still catching up. */
  const pruneFinishedOrders = (listed: ReadonlySet<string>): void => {
    for (const orderId of [...finishedOrders]) {
      if (!listed.has(orderId)) {
        finishedOrders.delete(orderId);
      }
    }
  };

  const rememberOpenAttempt = (orderId: string, product: NormalizedAitIapProduct): void => {
    if (reportedOrders.has(orderId) || hostFinishedOrders.has(orderId) || finishedOrders.has(orderId)) {
      return;
    }
    openAttempts.delete(orderId);
    openAttempts.set(orderId, product);
    // Bounded: a checkout whose order the provider never lists is forgotten
    // once newer ones need the room.
    bound(openAttempts);
  };

  /** Reports the orders a recovery pass settled (host-finished) and the paid orders it left ungranted. */
  const reportReconciliation = (reconciliation: AitIapPendingOrderReconciliation): void => {
    if (reconciliation.status !== 'reconciled') {
      return;
    }
    reconciliation.settledPurchases.forEach((settled, index) => {
      const product = controller.products.byProductId.get(settled.productId);
      if (product === undefined || finishedOrders.has(settled.transactionId)) {
        return;
      }
      hostFinishedOrders.set(settled.transactionId, product);
      bound(hostFinishedOrders);
      reportPurchased(
        product,
        settled.transactionId,
        'listed',
        reconciliation.restoredEntitlements[index]?.grantedAt,
      );
    });
    for (const unresolved of reconciliation.unresolvedOrders) {
      const product = controller.products.bySku.get(unresolved.sku);
      if (product !== undefined) {
        reportPurchased(product, unresolved.orderId, 'listed');
      }
    }
  };

  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  /** Re-reads the pending orders and reports the paid orders not reported yet. */
  const refreshPendingOrders = async (): Promise<void> => {
    if (refreshing !== undefined) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        if (!controller.isSupported()) {
          return;
        }
        const listing = await controller.readPendingOrders();
        if (listing.status !== 'ok') {
          console.debug('AIT IAP pending-order refresh skipped.', listing.diagnostic);
          continue;
        }
        const listed = new Set<string>();
        for (const order of listing.orders.slice(0, maximumAvailableAitIapOrders)) {
          listed.add(order.orderId);
          try {
            reportPurchased(
              order.product,
              order.orderId,
              'listed',
              readAitIapPaymentTime(order.paymentCompletedDate),
            );
          } catch (error) {
            // One invalid order must not hide the others.
            console.warn('AIT IAP pending order was not reported.', errorMessage(error));
          }
        }
        for (const [orderId, how] of [...reportedOrders]) {
          if (how === 'listed' && !listed.has(orderId) && !hostFinishedOrders.has(orderId)) {
            reportedOrders.delete(orderId);
          }
        }
        // Pruned against the whole list: an order past the bound is still listed.
        pruneFinishedOrders(new Set(listing.orders.map((order) => order.orderId)));
      } while (refreshAgain);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const refreshInBackground = (): void => {
    void refreshPendingOrders().catch((error: unknown) => {
      console.warn('AIT IAP pending-order refresh failed.', errorMessage(error));
    });
  };

  /** Reports orders the host handed over with its signal; the native read that follows confirms them. */
  const reportKnownOrders = (orders: readonly AitKnownPendingOrder[]): void => {
    if (!controller.isSupported()) {
      return;
    }
    for (const order of orders.slice(0, maximumAvailableAitIapOrders)) {
      const product = typeof order.sku === 'string'
        ? controller.products.bySku.get(order.sku)
        : undefined;
      if (
        product === undefined
        || typeof order.orderId !== 'string'
        || !isAitIapOrderId(order.orderId)
      ) {
        continue;
      }
      try {
        reportPurchased(
          product,
          order.orderId,
          'signalled',
          readAitIapPaymentTime(
            typeof order.paymentCompletedDate === 'string' ? order.paymentCompletedDate : '',
          ),
        );
      } catch (error) {
        console.warn('AIT IAP signalled order was not reported.', errorMessage(error));
      }
    }
  };

  // The pending-order signal is observed only while a listener exists: with
  // nobody to deliver to, the reconciler's own reads find every paid order,
  // and a host with no game listening does not read pending orders on every resume.
  const subscribeToPendingOrderChanges = input.onPendingOrdersChanged
    ?? subscribeToAitLifecycleResume;
  let detachPendingOrderChanges: (() => void) | undefined;
  const attachPendingOrderChanges = (): void => {
    if (detachPendingOrderChanges !== undefined) {
      return;
    }
    detachPendingOrderChanges = subscribeToPendingOrderChanges((change) => {
      if (change?.orders !== undefined && Array.isArray(change.orders)) {
        reportKnownOrders(change.orders);
      }
      refreshInBackground();
    });
  };
  const detachPendingOrderChangesIfIdle = (): void => {
    if (listeners.size > 0 || detachPendingOrderChanges === undefined) {
      return;
    }
    const detach = detachPendingOrderChanges;
    detachPendingOrderChanges = undefined;
    detach();
  };

  const toRequestPurchaseResult = (
    logicalId: RequestPurchaseInput['logicalId'],
    result: PurchaseResult,
  ): RequestPurchaseResult => {
    switch (result.status) {
      case 'completed': {
        // The completed purchase must be the requested product's, not merely
        // some configured product's.
        const product = controller.products.byProductId.get(logicalId);
        if (
          product === undefined
          || result.transactionId === undefined
          || !result.entitlementIds.includes(logicalId)
        ) {
          throw new CommerceError('INVALID_RESPONSE', {
            message: `Apps in Toss completed a purchase that is not an order for ${logicalId}.`,
          });
        }
        const source: AitIapGrantSource = result.evidence?.payload.source === 'pending-order-restore'
          ? 'pending-order-restore'
          : 'process-product-grant';
        const purchase = toStorePurchase(product, result.transactionId, 'purchased', source);
        if (finishedOrders.has(result.transactionId)) {
          // A replay of a finished attempt's key: answer it, track nothing.
          knownOrders.delete(result.transactionId);
          return { outcome: 'purchased', purchase };
        }
        if (source === 'process-product-grant') {
          // The SDK completed the order after the confirmed grant callback. A
          // recovery-path completion may still be unacknowledged (its marker
          // is written before the acknowledgement), so the finish checks the
          // provider's list for it.
          hostFinishedOrders.set(result.transactionId, product);
          bound(hostFinishedOrders);
        }
        reportedOrders.set(result.transactionId, 'listed');
        bound(reportedOrders);
        openAttempts.delete(result.transactionId);
        return { outcome: 'purchased', purchase };
      }
      case 'pending':
        // The outcome is not known yet (grant pending, acknowledgement
        // unconfirmed, checkout timeout): the attempt stays open.
        return { outcome: 'launched' };
      case 'cancelled':
        return {
          outcome: 'cancelled',
          error: toCommerceErrorInfo('USER_CANCELLED', result.diagnostic),
        };
      case 'failed': {
        const error = toCommerceErrorInfo(undefined, result.diagnostic);
        if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'ALREADY_OWNED') {
          // RFC "Errors": an unfinished purchase may exist, so the attempt
          // stays open for the reconciler instead of becoming terminal.
          return { outcome: 'launched' };
        }
        return { outcome: 'failed', error };
      }
    }
  };

  const provider: AitCommerceProvider = {
    store,
    async getCapabilities(): Promise<CommerceCapabilities> {
      return createAitCommerceCapabilities(
        controller.isSupported()
          ? 'available'
          : controller.areNativeMethodsSupported()
            ? 'configuration-required'
            : 'unsupported',
      );
    },
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      if ((request.type ?? 'all') === 'subscription' || !controller.isSupported()) {
        // Subscriptions never list here; an unconfigured store lists nothing.
        return [];
      }
      const catalog = await controller.listProducts();
      if (catalog.status !== 'ok') {
        throw toCommerceError(catalog.diagnostic);
      }
      const products: StoreProduct[] = [];
      for (const info of catalog.products) {
        const product = controller.products.byProductId.get(info.id);
        if (product === undefined) {
          continue;
        }
        if (request.logicalIds !== undefined && !request.logicalIds.includes(info.id)) {
          continue;
        }
        const storeProduct = toStoreProduct(product, info);
        if (storeProduct !== undefined) {
          products.push(storeProduct);
        }
      }
      return products;
    },
    async requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      // Both one-time kinds are sold; this rejects a quantity above one before
      // any checkout opens.
      assertRequestPurchaseSupported(createAitCommerceCapabilities('available'), request, 'consumable');
      const result = await controller.purchase(request.logicalId, request.idempotencyKey, {
        onPendingOrdersReconciled: reportReconciliation,
      });
      const outcome = toRequestPurchaseResult(request.logicalId, result);
      if (outcome.outcome === 'launched' && result.transactionId !== undefined) {
        const product = controller.products.byProductId.get(request.logicalId);
        if (product !== undefined) {
          rememberOpenAttempt(result.transactionId, product);
        }
        // The order was paid and the host could not settle it: the provider
        // probably lists it already, so report it without waiting for a resume.
        refreshInBackground();
      }
      return outcome;
    },
    async getAvailablePurchases(
      request: GetAvailablePurchasesInput = {},
    ): Promise<readonly StorePurchase[]> {
      if (!controller.isSupported()) {
        return [];
      }
      const listing = await controller.readPendingOrders();
      if (listing.status !== 'ok') {
        throw toCommerceError(listing.diagnostic);
      }
      if (listing.orders.length > maximumAvailableAitIapOrders) {
        console.warn('AIT IAP pending-order list exceeds the available-purchase bound.', {
          limit: maximumAvailableAitIapOrders,
          ignoredOrderCount: listing.orders.length - maximumAvailableAitIapOrders,
        });
      }
      const purchases: StorePurchase[] = [];
      const listed = new Set<string>();
      // Pruned against the whole list: an order past the bound is still listed.
      const stillListed = new Set(listing.orders.map((order) => order.orderId));
      for (const order of listing.orders.slice(0, maximumAvailableAitIapOrders)) {
        openAttempts.delete(order.orderId);
        if (finishedOrders.has(order.orderId)) {
          // Finished through this provider; the host lists it a little longer.
          continue;
        }
        listed.add(order.orderId);
        try {
          purchases.push(toStorePurchase(
            order.product,
            order.orderId,
            'purchased',
            'pending-order-restore',
            readAitIapPaymentTime(order.paymentCompletedDate),
          ));
        } catch (error) {
          // One invalid order must not hide the others, as on a refresh.
          console.warn('AIT IAP pending order was not listed.', errorMessage(error));
        }
      }
      pruneFinishedOrders(stillListed);
      // A server-granted order whose acknowledgement was not confirmed is
      // unfinished from the host's point of view until a ledger grant settles it.
      const acknowledgements = await controller.readAcknowledgementsInFlight();
      if (acknowledgements === undefined) {
        console.warn('AIT IAP acknowledgement barriers are unreadable; listing provider orders only.');
      } else {
        for (const entry of acknowledgements) {
          const product = controller.products.bySku.get(entry.sku);
          if (
            product === undefined
            || listed.has(entry.orderId)
            || finishedOrders.has(entry.orderId)
          ) {
            continue;
          }
          listed.add(entry.orderId);
          purchases.push(toStorePurchase(product, entry.orderId, 'purchased', 'pending-order-restore'));
        }
      }
      // An order the host finished stays available until the reconciler
      // finishes its record, so its event is recoverable even when buffered
      // events were dropped.
      for (const [orderId, product] of hostFinishedOrders) {
        if (listed.has(orderId) || finishedOrders.has(orderId)) {
          continue;
        }
        listed.add(orderId);
        purchases.push(toStorePurchase(product, orderId, 'purchased', 'pending-order-restore'));
      }
      if (request.includePending === true) {
        for (const [orderId, product] of openAttempts) {
          if (!listed.has(orderId) && !hostFinishedOrders.has(orderId)) {
            purchases.push(toStorePurchase(product, orderId, 'pending', 'process-product-grant'));
          }
        }
      }
      return purchases;
    },
    async finishTransaction(request: FinishTransactionInput): Promise<FinishTransactionResult> {
      if (typeof request.ledgerEntryId !== 'string' || request.ledgerEntryId.length === 0) {
        // The reconciler is the finish gate: without its ledger grant nothing is acknowledged.
        throw new CommerceError('INVALID_RESPONSE', {
          message: 'Apps in Toss finishes an order only with the ledger entry id of its grant.',
        });
      }
      const orderId = request.transactionId;
      if (finishedOrders.has(orderId)) {
        // Finished through this provider already; a repeated finish is a no-op
        // even while the host still lists the order. Anything a replayed
        // attempt re-tracked meanwhile is dropped again.
        forgetOrder(orderId, true);
        return { finished: true };
      }
      if (hostFinishedOrders.has(orderId)) {
        // The SDK completed the order after the confirmed grant callback, or
        // a recovery pass acknowledged it: nothing is left to finish.
        forgetOrder(orderId, false);
        return { finished: true };
      }
      const product = knownOrders.get(orderId);
      const outcome = await controller.finishOrder({
        orderId,
        ...(product === undefined ? {} : { product }),
      });
      if (outcome.status !== 'finished') {
        console.warn('AIT IAP order finish is still pending.', outcome.diagnostic);
        return { finished: false };
      }
      if (outcome.how === 'already-finished' && reportedOrders.get(orderId) === 'signalled') {
        // The host handed this order over before listing it, and nothing
        // durable says it was finished: the paid order is still ahead of the
        // list. Keep the record finishing until the list catches up, so the
        // acknowledgement is not skipped.
        console.warn('AIT IAP order finish is waiting for the host to list the order.', { orderId });
        return { finished: false };
      }
      // Only an order acknowledged here needs suppressing while the host
      // catches up; one the host had not listed at all stays reportable.
      forgetOrder(orderId, outcome.how === 'acknowledged');
      return { finished: true };
    },
    async restorePurchases(): Promise<void> {
      const outcome = await controller.recoverPendingOrders();
      if (outcome.status === 'failed') {
        throw toCommerceError(outcome.diagnostic);
      }
      reportReconciliation(outcome.reconciliation);
    },
    subscribe(listener) {
      listeners.add(listener);
      attachPendingOrderChanges();
      if (listeners.size === 1) {
        buffer.drain((event) => {
          try {
            listener(event);
          } catch (error) {
            console.warn('AIT IAP commerce listener failed.', errorMessage(error));
          }
        });
      }
      return () => {
        listeners.delete(listener);
        detachPendingOrderChangesIfIdle();
      };
    },
    dispose() {
      listeners.clear();
      detachPendingOrderChangesIfIdle();
    },
  };
  return provider;
}

/**
 * The default pending-order signal: the app resuming (the Toss checkout page
 * closing, the page becoming visible again). A host without the page
 * lifecycle surface keeps working; it then learns about new orders from the
 * reconciler's reads and `restorePurchases` only.
 */
function subscribeToAitLifecycleResume(listener: AitPendingOrdersChangeListener): () => void {
  try {
    return createAitLifecycleAdapter().onResume(() => listener());
  } catch (error) {
    console.debug(
      'AIT IAP pending-order signal is unavailable; orders are read on demand only.',
      errorMessage(error),
    );
    return () => {};
  }
}

export function createAitCommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'host',
    },
    authority: { evidence: 'host-callback', accountBinding: 'host' },
    availability,
  };
}

function toStoreProduct(
  product: NormalizedAitIapProduct,
  info: ProductInfo,
): StoreProduct | undefined {
  const kind = info.type === 'consumable'
    ? 'consumable'
    : info.type === 'non_consumable'
      ? 'durable'
      : undefined;
  if (kind === undefined) {
    return undefined;
  }
  try {
    return assertStoreProduct({
      logicalId: product.productId,
      store: aitCommerceStoreId,
      storeSku: product.sku,
      kind,
      title: info.title,
      description: info.description,
      price: { formatted: info.price.formatted, currencyCode: info.price.currencyCode },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: `Apps in Toss reported an invalid product for ${product.sku}.`,
      storeCode: aitIapDiagnosticCodes.catalogUnavailable,
      cause: error,
    });
  }
}

/** The provider's payment time as an ISO timestamp, or nothing when it is absent or unparseable. */
function readAitIapPaymentTime(value: string): string | undefined {
  if (value.length === 0 || value.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function toCommerceErrorInfo(
  code: CommerceErrorCode | undefined,
  diagnostic: CommerceDiagnostic | undefined,
): CommerceErrorInfo {
  const storeCode = diagnostic?.code;
  const normalized = code
    ?? (storeCode !== undefined && isAitIapDiagnosticCode(storeCode)
      ? aitIapCommerceErrorCodeMap[storeCode]
      : 'UNKNOWN');
  const providerDetail = diagnostic?.providerCode === undefined
    ? ''
    : ` (provider code ${diagnostic.providerCode})`;
  return new CommerceError(normalized, {
    message: storeCode === undefined
      ? `Apps in Toss purchase ${normalized === 'USER_CANCELLED' ? 'was cancelled' : 'failed'}.`
      : `Apps in Toss purchase failed: ${storeCode}${providerDetail}.`,
    ...(storeCode === undefined ? {} : { storeCode }),
    ...(diagnostic === undefined ? {} : { retryable: diagnostic.retryable }),
  }).toCommerceErrorInfo();
}

function toCommerceError(diagnostic: CommerceDiagnostic): CommerceError {
  const info = toCommerceErrorInfo(undefined, diagnostic);
  return new CommerceError(info.code, {
    retryable: info.retryable,
    ...(info.storeCode === undefined ? {} : { storeCode: info.storeCode }),
    ...(info.message === undefined ? {} : { message: info.message }),
  });
}

function isAitIapDiagnosticCode(value: string): value is AitIapDiagnosticCode {
  return Object.values(aitIapDiagnosticCodes).includes(value as AitIapDiagnosticCode);
}

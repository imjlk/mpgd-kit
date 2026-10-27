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
  type StoreSdkGetAvailablePurchasesInput,
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
import { appStoreStoreId, storeKitStoreSdkCapabilities } from './commerce-profile.js';
import { CapacitorStoreKit } from './plugin.js';

/** The plugin surface the commerce v2 SDK drives; `CapacitorStoreKit` by default. */
export type CapacitorStoreKitStoreSdkPlugin = Pick<
  CapacitorStoreKitPlugin,
  'getProducts' | 'purchase' | 'getTransactions' | 'sync' | 'finishTransaction' | 'addListener'
>;

/** One-time kinds the App Store sells; `durable` is a StoreKit non-consumable. */
export type StoreKitOneTimeKind = 'consumable' | 'durable';

/** A store SKU the SDK is configured to sell and the kind the catalog declares for it. */
export interface CapacitorStoreKitStoreSdkProduct {
  readonly sku: string;
  readonly kind: StoreKitOneTimeKind;
}

/**
 * A transaction the SDK saw and deliberately kept away from the reconciler:
 * one for a SKU outside the configured catalog, one bound to another app
 * account token (shared device or in-game account switch), or one whose
 * StoreKit type disagrees with the catalog kind. Diagnostics only; nothing
 * here is a purchase the game may act on.
 */
export type CapacitorStoreKitDiagnostic =
  | { readonly type: 'unmapped-sku'; readonly sku: string; readonly transactionId: string }
  | {
      readonly type: 'account-mismatch';
      readonly sku: string;
      readonly transactionId: string;
      readonly appAccountToken?: string;
    }
  | {
      readonly type: 'kind-mismatch';
      readonly sku: string;
      readonly transactionId: string;
      readonly expected: StoreKitOneTimeKind;
      readonly reported: StoreKitOneTimeKind;
    };

export interface CreateCapacitorStoreKitStoreSdkInput {
  /** The SKUs the catalog sells through the App Store, with their declared kinds. */
  readonly products: readonly CapacitorStoreKitStoreSdkProduct[];
  /**
   * The active player's app account token (a UUID). Transactions bound to any
   * other token are never emitted and never listed, except a durable on the
   * player's Restore Purchases read; the backend binds the same value.
   */
  readonly getAppAccountToken: () => string | Promise<string>;
  readonly sdk?: CapacitorStoreKitStoreSdkPlugin;
  readonly isIos?: () => boolean;
  /** Observes transactions the SDK excludes; never a grant signal. */
  readonly onDiagnostic?: (diagnostic: CapacitorStoreKitDiagnostic) => void;
}

/**
 * Capacitor StoreKit `StoreSdk`: the commerce v2 surface over the native
 * StoreKit 2 collector (RFC B3). The App Store profile is consumable plus
 * durable, no subscriptions, no quantity, `pending` (Ask to Buy), `restore`
 * (`AppStore.sync`), and `finish: 'client'` after the ledger grant. Every
 * purchase carries the StoreKit-verified `signedTransaction` JWS as its
 * `token`; the backend verifies that JWS itself and nothing here grants.
 *
 * The SDK answers only for the configured catalog and the active account: a
 * transaction for an unmapped SKU, for another app account token, or whose
 * StoreKit type disagrees with the catalog kind is reported through
 * `onDiagnostic` and never reaches `getAvailablePurchases` or an event, so
 * the reconciler never journals a purchase it cannot resolve or that belongs
 * to another player. One exception: the player's Restore Purchases read
 * (`getAvailablePurchases({ restore: true })`) also lists durables bound to
 * another or no token, the state of every earlier purchase after a reinstall
 * or on a new device; the reconciler sends them with `intent: 'restore'` and
 * the backend's restore sharing decides (RFC "Restore sharing").
 */
export function createCapacitorStoreKitStoreSdk(
  input: CreateCapacitorStoreKitStoreSdkInput,
): StoreSdk {
  const sdk = input.sdk ?? CapacitorStoreKit;
  const isIos = input.isIos ?? (() => Capacitor.getPlatform() === 'ios');
  const onDiagnostic = input.onDiagnostic ?? (() => undefined);
  if (typeof input.getAppAccountToken !== 'function') {
    throw new TypeError('StoreKit requires getAppAccountToken.');
  }
  const kinds = new Map<string, StoreKitOneTimeKind>();
  for (const product of input.products) {
    if (!isRecord(product) || !productPattern.test(String(product.sku))) {
      throw new TypeError(`StoreKit product id ${String(product?.sku)} is invalid.`);
    }
    if (product.kind !== 'consumable' && product.kind !== 'durable') {
      throw new TypeError(`StoreKit product ${product.sku} must be consumable or durable.`);
    }
    if (kinds.has(product.sku)) {
      throw new TypeError(`StoreKit product ${product.sku} is configured twice.`);
    }
    kinds.set(product.sku, product.kind);
  }
  const productIds = [...kinds.keys()];
  // Store products seen by `fetchProducts` or the availability probe; the
  // pre-purchase kind check reads them instead of a second lookup.
  const knownProducts = new Map<string, StoreKitProduct>();

  const unresolvedAccountToken = (error: unknown): StoreSdkError & Error =>
    Object.assign(
      storeKitError(
        'ACCOUNT_BINDING_REQUIRED',
        'The StoreKit app account token could not be resolved.',
        false,
      ),
      { cause: error },
    );
  const normalizeAccountToken = (value: unknown): string =>
    readAppAccountToken({
      kind: 'app-account-token',
      ...(typeof value === 'string' ? { value } : {}),
    });
  /**
   * The active account token; a synchronous resolver answers synchronously so
   * native events are admitted in the same tick they arrive, an asynchronous
   * one defers the admission.
   */
  const resolveAppAccountToken = (): string | Promise<string> => {
    let value: unknown;
    try {
      value = input.getAppAccountToken();
    } catch (error) {
      throw unresolvedAccountToken(error);
    }
    if (isPromiseLike(value)) {
      return Promise.resolve(value).then(normalizeAccountToken, (error: unknown) => {
        throw unresolvedAccountToken(error);
      });
    }
    return normalizeAccountToken(value);
  };

  /**
   * Keeps a verified transaction only when it is sellable to the active
   * player: configured SKU, declared kind, and the active account token.
   * `restore` (the player's Restore Purchases read) also keeps a durable
   * bound to another or no token: after a reinstall or on a new device every
   * earlier purchase carries the earlier guest's token, and the backend's
   * restore sharing decides whether this player may hold it. A consumable
   * bound to another token is never kept.
   */
  const admit = (
    transaction: StoreKitTransaction,
    appAccountToken: string,
    restore = false,
  ): boolean => {
    const expected = kinds.get(transaction.productId);
    if (expected === undefined) {
      onDiagnostic({
        type: 'unmapped-sku',
        sku: transaction.productId,
        transactionId: transaction.transactionId,
      });
      return false;
    }
    const restorable = restore
      && expected === 'durable'
      && kindOf(transaction.type) === 'durable';
    if (transaction.appAccountToken?.toLowerCase() !== appAccountToken && !restorable) {
      onDiagnostic({
        type: 'account-mismatch',
        sku: transaction.productId,
        transactionId: transaction.transactionId,
        ...(transaction.appAccountToken === undefined
          ? {}
          : { appAccountToken: transaction.appAccountToken.toLowerCase() }),
      });
      return false;
    }
    const reported = kindOf(transaction.type);
    if (reported !== expected) {
      onDiagnostic({
        type: 'kind-mismatch',
        sku: transaction.productId,
        transactionId: transaction.transactionId,
        expected,
        reported,
      });
      return false;
    }
    return true;
  };

  const listeners = new Map<StoreSdkEventName, Set<(event: never) => void>>();
  let nativeHandle: Promise<PluginListenerHandle> | undefined;
  const emit = (event: StoreSdkEvent): void => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) {
      (listener as (value: StoreSdkEvent) => void)(event);
    }
  };
  const malformed = (transaction: unknown): void => {
    emit({
      type: 'purchaseError',
      ...(isRecord(transaction) && typeof transaction.productId === 'string'
        ? { sku: transaction.productId }
        : {}),
      error: evidenceInvalid(),
    });
  };
  // Native events are filtered against the active account token. A deferred
  // admission (asynchronous resolver) queues later events behind it so the
  // delivery order is kept.
  let pendingAdmissions: Promise<void> = Promise.resolve();
  let pendingAdmissionCount = 0;
  const admitEvent = (transaction: StoreKitTransaction, appAccountToken: string): void => {
    if (admit(transaction, appAccountToken)) {
      emit({ type: 'purchaseUpdated', purchase: toSdkPurchase(transaction) });
    }
  };
  const reportUnresolved = (transaction: StoreKitTransaction, error: unknown): void => {
    emit({ type: 'purchaseError', sku: transaction.productId, error: error as StoreSdkError });
  };
  const onTransactionUpdated = (transaction: unknown): void => {
    if (!isValidStoreKitTransaction(transaction)) {
      malformed(transaction);
      return;
    }
    if (kinds.get(transaction.productId) === undefined) {
      // Unmapped before the token is read: no account lookup for a SKU the
      // catalog does not sell.
      admit(transaction, '');
      return;
    }
    let token: string | Promise<string>;
    try {
      token = resolveAppAccountToken();
    } catch (error) {
      reportUnresolved(transaction, error);
      return;
    }
    if (typeof token === 'string' && pendingAdmissionCount === 0) {
      admitEvent(transaction, token);
      return;
    }
    pendingAdmissionCount += 1;
    pendingAdmissions = pendingAdmissions
      .then(() => token)
      .then(
        (resolved) => {
          admitEvent(transaction, resolved);
        },
        (error: unknown) => {
          reportUnresolved(transaction, error);
        },
      )
      .finally(() => {
        pendingAdmissionCount -= 1;
      });
  };
  const transactionSubscribers = (): number =>
    (listeners.get('purchaseUpdated')?.size ?? 0) + (listeners.get('purchaseError')?.size ?? 0);
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

  const lookupProducts = async (skus: readonly string[]): Promise<StoreKitProduct[]> => {
    const products: StoreKitProduct[] = [];
    for (let index = 0; index < skus.length; index += maxProductIdsPerLookup) {
      const response: unknown = await sdk.getProducts({
        productIds: skus.slice(index, index + maxProductIdsPerLookup),
      });
      if (!isRecord(response) || !Array.isArray(response.products)) {
        throw evidenceInvalid('StoreKit returned an invalid product list.');
      }
      for (const product of response.products as readonly unknown[]) {
        if (!isValidStoreKitProduct(product)) {
          throw evidenceInvalid('StoreKit returned an invalid product.');
        }
        knownProducts.set(product.productId, product);
        products.push(product);
      }
    }
    return products;
  };

  /**
   * The store product for a configured SKU, checked against the declared
   * kind before any purchase sheet opens: a catalog that declares the wrong
   * one-time kind fails here instead of charging the player for a purchase
   * the backend would reject with `APP_STORE_PRODUCT_TYPE_MISMATCH`.
   */
  const assertSellable = async (sku: string): Promise<StoreKitOneTimeKind> => {
    const expected = kinds.get(sku);
    if (expected === undefined) {
      throw storeKitError(
        'STOREKIT_PRODUCT_UNKNOWN',
        `StoreKit product ${sku} is not in the configured catalog.`,
        false,
      );
    }
    const product = knownProducts.get(sku)
      ?? (await lookupProducts([sku])).find((candidate) => candidate.productId === sku);
    if (product === undefined) {
      throw storeKitError(
        'STOREKIT_PRODUCT_UNAVAILABLE',
        `StoreKit product ${sku} is not available in the store.`,
        false,
      );
    }
    const reported = kindOf(product.type);
    if (reported !== expected) {
      throw storeKitError(
        'STOREKIT_CONFIGURATION_ERROR',
        `StoreKit product ${sku} is ${product.type}; the catalog declares ${expected}.`,
        false,
      );
    }
    return expected;
  };

  // Overlapping finishes for the same transaction and ledger entry share one
  // native call; the v2 reconciler is the gate that authorizes the call.
  const inFlightFinishes = new Map<
    string,
    { readonly ledgerEntryId: string; readonly promise: Promise<StoreSdkFinishTransactionResult> }
  >();

  /**
   * Mirrors the native finish gate: the transaction must be listed, not
   * revoked, and bound to the session app account token. A missing list is
   * an invalid response, not a quiet "not finished".
   *
   * A consumable the list no longer carries is already finished: StoreKit
   * keeps a transaction in `Transaction.unfinished` until `finish()`, and a
   * finished consumable is in neither that list nor `currentEntitlements`.
   * That is the lost acknowledgement: an earlier finish reached StoreKit but
   * its answer never reached the journal (the app was closed between the two),
   * and the record would otherwise stay `finishing` forever. The caller holds
   * the ledger grant (the reconciler finishes only `granted` or `finishing`
   * records, and a `finished` consumable listed again), nothing native is
   * called, and an entry of that id the native side reports in any shape
   * keeps it refused. If the transaction is listed again later (an
   * unverifiable entry the native read skipped, or a list read before
   * StoreKit carried it), the reconciler finishes it again without a second
   * verify. A durable missing from the list is refused: a durable
   * stays in `currentEntitlements` after its finish, so a missing one is
   * revoked or unverifiable, never a lost acknowledgement.
   *
   * Two exceptions for a listed, non-revoked durable, the only kind the
   * restore read admits from another token:
   *
   * - StoreKit already finished it (`unfinished: false`): nothing is left to
   *   finish whatever its token, so a restore shared to this player ends
   *   there without a native call.
   * - It is unfinished (or the build omits the flag), the catalog declares
   *   its SKU durable, and it is bound to another token: an earlier guest
   *   crashed between its grant and its finish, then the app was
   *   reinstalled. The caller holds this player's ledger grant
   *   (the reconciler finishes only `granted` or `finishing` records), and a
   *   durable stays in `Transaction.currentEntitlements` after its finish, so
   *   finishing it takes nothing from any player: the earlier guest's next
   *   read still lists it (`unfinished: false`) for its own verification. It
   *   is finished with its own token, which the native gate matches.
   *
   * A consumable of another token, or a transaction bound to no token, is
   * never finished here.
   */
  const finishPermitted = async (
    transactionId: string,
    appAccountToken: string,
    isConsumable: boolean,
  ): Promise<
    | { readonly verdict: 'finish'; readonly appAccountToken: string }
    | { readonly verdict: 'finished' | 'refused' }
  > => {
    const response: unknown = await sdk.getTransactions();
    if (!isRecord(response) || !Array.isArray(response.transactions)) {
      throw evidenceInvalid('StoreKit returned an invalid transaction list.');
    }
    const entries = (response.transactions as readonly unknown[]).filter(
      (candidate) => isRecord(candidate) && candidate.transactionId === transactionId,
    );
    const transaction = entries.find(isValidStoreKitTransaction);
    if (transaction === undefined) {
      return { verdict: entries.length === 0 && isConsumable ? 'finished' : 'refused' };
    }
    if (transaction.revokedAt !== undefined) {
      return { verdict: 'refused' };
    }
    if (transaction.type === 'non_consumable' && transaction.unfinished === false) {
      return { verdict: 'finished' };
    }
    const bound = transaction.appAccountToken?.toLowerCase();
    if (bound === appAccountToken) {
      return { verdict: 'finish', appAccountToken };
    }
    if (
      bound !== undefined
      && transaction.type === 'non_consumable'
      && kinds.get(transaction.productId) === 'durable'
    ) {
      return { verdict: 'finish', appAccountToken: bound };
    }
    return { verdict: 'refused' };
  };

  return {
    store: appStoreStoreId,
    capabilities: storeKitStoreSdkCapabilities,
    async fetchProducts(request: StoreSdkFetchProductsInput): Promise<readonly StoreSdkProduct[]> {
      requireIos();
      if (request.type === 'subscription' || request.skus.length === 0) {
        return [];
      }
      const products: StoreSdkProduct[] = [];
      for (const product of await lookupProducts(request.skus)) {
        products.push({
          sku: product.productId,
          kind: kindOf(product.type),
          title: product.title,
          description: product.description,
          price: { formatted: product.formattedPrice, currencyCode: product.currencyCode },
        });
      }
      return products;
    },
    async requestPurchase(
      request: StoreSdkRequestPurchaseInput,
    ): Promise<StoreSdkRequestPurchaseResult> {
      requireIos();
      const appAccountToken = readAppAccountToken(request.accountBinding);
      const expected = await assertSellable(request.sku);
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
            || kindOf(transaction.type) !== expected
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
    async getAvailablePurchases(
      request?: StoreSdkGetAvailablePurchasesInput,
    ): Promise<readonly StoreSdkPurchase[]> {
      // Pending (Ask to Buy) transactions never appear in `Transaction.unfinished`
      // before approval, so `includePending` has nothing to filter here.
      requireIos();
      const restore = request?.restore === true;
      const appAccountToken = await resolveAppAccountToken();
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
          malformed(transaction);
          continue;
        }
        // A finished durable stays in currentEntitlements with
        // `unfinished: false`. Listing it lets the reconciler verify a finish
        // that raced the ledger grant; the server ledger dedupes. A finished
        // consumable is not an entitlement and is not listed. A build that
        // omits the flag lists every transaction, which the backend answers
        // idempotently.
        if (seen.has(transaction.transactionId)) {
          continue;
        }
        if (transaction.unfinished === false && transaction.type !== 'non_consumable') {
          continue;
        }
        seen.add(transaction.transactionId);
        if (admit(transaction, appAccountToken, restore)) {
          purchases.push(toSdkPurchase(transaction));
        }
      }
      return purchases;
    },
    async finishTransaction(
      request: StoreSdkFinishTransactionInput,
    ): Promise<StoreSdkFinishTransactionResult> {
      requireIos();
      // The session token is the binding. A bridge or plugin caller cannot
      // substitute another account's token on this path: the only other
      // token used is a durable's own, read from the native list.
      const appAccountToken = await Promise.resolve(resolveAppAccountToken());
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
        // Same match the native plugin applies: missing, revoked, unbound, or
        // another account never reaches `transaction.finish()`, except a
        // durable of another token (see `finishPermitted`). A consumable that
        // left the unfinished list is already finished (a lost acknowledgement).
        const permitted = await finishPermitted(
          transactionId,
          appAccountToken,
          request.isConsumable === true,
        );
        if (permitted.verdict !== 'finish') {
          return { finished: permitted.verdict === 'finished' };
        }
        const reported: unknown = await sdk.finishTransaction({
          transactionId,
          ledgerEntryId,
          appAccountToken: permitted.appAccountToken,
        });
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
      // Both events derive from native transaction updates (a malformed update
      // is a purchaseError), so either subscriber needs the native listener.
      if (transactionSubscribers() > 0) {
        attachNative();
      }
      return () => {
        set.delete(listener as (event: never) => void);
        if (transactionSubscribers() === 0) {
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
        // Probe batch by batch until one configured product is sold; only a
        // catalog with no sellable product at all is a configuration problem.
        for (let index = 0; index < productIds.length; index += maxProductIdsPerLookup) {
          const products = await lookupProducts(
            productIds.slice(index, index + maxProductIdsPerLookup),
          );
          if (products.some((product) => kinds.has(product.productId))) {
            return 'available';
          }
        }
        return 'configuration-required';
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        // Capacitor's `UNIMPLEMENTED` means the native plugin is not installed in the shell.
        return code === 'STOREKIT_INVALID_PRODUCTS'
          || code === 'STOREKIT_PRODUCT_UNAVAILABLE'
          || code === 'UNIMPLEMENTED'
          ? 'configuration-required'
          : 'temporarily-unavailable';
      }
    },
  };
}

// The App Store profile (RFC "Capabilities") lives in the SDK-free
// `commerce-profile.ts` so a tools project can read it without loading
// Capacitor; it stays exported here.
export { storeKitStoreSdkCapabilities };

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

function kindOf(type: StoreKitProduct['type']): StoreKitOneTimeKind {
  return type === 'consumable' ? 'consumable' : 'durable';
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

function evidenceInvalid(
  message = 'StoreKit transaction evidence is invalid.',
): StoreSdkError & Error {
  return storeKitError('STOREKIT_EVIDENCE_INVALID', message, false);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { readonly then?: unknown }).then === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

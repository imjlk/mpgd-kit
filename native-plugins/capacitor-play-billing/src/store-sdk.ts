import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import type { PlatformProviderAvailability } from '@mpgd/platform';
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
  type StoreSdkGetAvailablePurchasesInput,
  type StoreSdkProduct,
  type StoreSdkPurchase,
  type StoreSdkRequestPurchaseInput,
  type StoreSdkRequestPurchaseResult,
} from '@mpgd/adapter-capacitor';
import { createGooglePlayTokenPurchaseKey, type StoreOffer } from '@mpgd/platform/commerce';

import type {
  CapacitorPlayBillingPlugin,
  PlayOneTimeOffer,
  PlayPurchase,
  PlayPurchaseOutcome,
} from './definitions.js';
import { googlePlayStoreId, playBillingStoreSdkCapabilities } from './commerce-profile.js';
import { CapacitorPlayBilling } from './plugin.js';

// The profile constants live in the SDK-free `commerce-profile.ts` so a tools
// project can read them without loading Capacitor; they stay exported here.
export { googlePlayStoreId, playBillingStoreSdkCapabilities };

/**
 * `defaultStoreSdkErrorCodeMap` plus every `PLAY_BILLING_*` code the plugin or
 * this SDK emits that the default map does not already normalize.
 */
export const playBillingStoreSdkErrorCodeMap: StoreSdkErrorCodeMap = Object.freeze({
  ...defaultStoreSdkErrorCodeMap,
  PLAY_BILLING_BUSY: 'IN_PROGRESS',
  PLAY_BILLING_OFFER_REQUIRED: 'CONFIGURATION_REQUIRED',
  PLAY_BILLING_INVALID_PRODUCTS: 'CONFIGURATION_REQUIRED',
  PLAY_BILLING_INVALID_PRODUCT: 'CONFIGURATION_REQUIRED',
  PLAY_BILLING_INVALID_REQUEST: 'CONFIGURATION_REQUIRED',
  PLAY_BILLING_ACTIVITY_REQUIRED: 'NOT_PREPARED',
  PLAY_BILLING_ANDROID_REQUIRED: 'STORE_UNAVAILABLE',
  PLAY_BILLING_ERROR: 'UNKNOWN',
});

/** One Play product the SDK sells; the provider maps it to a logical id. */
export interface PlayBillingStoreSdkProduct {
  /** The Play product id (SKU). */
  readonly sku: string;
  readonly kind: 'consumable' | 'durable';
  /**
   * Default one-time offer (`offerToken`) when Play lists more than one
   * eligible offer; a request may name another through `offerId`.
   */
  readonly offerToken?: string;
}

export interface CreateCapacitorPlayBillingStoreSdkInput {
  readonly products: readonly PlayBillingStoreSdkProduct[];
  /** Defaults to the registered `CapacitorPlayBilling` plugin. */
  readonly plugin?: CapacitorPlayBillingPlugin;
  /** Defaults to `Capacitor.getPlatform() === 'android'`. */
  readonly isAndroid?: () => boolean;
  /**
   * Diagnostics hook for a plugin purchase the SDK leaves out of
   * `getAvailablePurchases` and events: a SKU not in `products` (for example
   * a retired product) or a multi-line purchase. Such a purchase has no
   * logical id for the reconciler; the backend finalizer still sees it
   * through the Play Developer API.
   */
  readonly onUnmappedPurchase?: (purchase: PlayPurchase) => void;
}

export interface CapacitorPlayBillingStoreSdk extends StoreSdk {
  readonly store: typeof googlePlayStoreId;
  getAvailability(): Promise<PlatformProviderAvailability>;
}

const productIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const obfuscatedAccountIdPattern = /^[A-Za-z0-9._-]{1,64}$/u;
const maximumProducts = 100;
const maximumPurchaseTimeMillis = 8_640_000_000_000_000;
const configurationErrorCodes: ReadonlySet<string> = new Set([
  // Capacitor's `UNIMPLEMENTED`: the native plugin is not installed in the shell.
  'UNIMPLEMENTED',
  'PLAY_BILLING_CONFIGURATION_ERROR',
  'PLAY_BILLING_PRODUCT_UNAVAILABLE',
  'PLAY_BILLING_OFFER_REQUIRED',
  'PLAY_BILLING_INVALID_PRODUCTS',
  'PLAY_BILLING_INVALID_PRODUCT',
]);

interface PlayBillingStoreSdkErrorOptions {
  readonly retryable?: boolean;
  readonly storeCode?: string;
  readonly cause?: unknown;
}

/** A plugin rejection or an SDK integrity failure, carrying the plugin code. */
export class PlayBillingStoreSdkError extends Error implements StoreSdkError {
  readonly code: string;
  readonly retryable?: boolean;
  readonly storeCode?: string;

  constructor(code: string, message: string, options: PlayBillingStoreSdkErrorOptions = {}) {
    super(message);
    this.name = 'PlayBillingStoreSdkError';
    this.code = code;
    if (options.retryable !== undefined) {
      this.retryable = options.retryable;
    }
    if (options.storeCode !== undefined) {
      this.storeCode = options.storeCode;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * `StoreSdk` over `@mpgd/capacitor-play-billing`'s plugin for
 * `createStoreCommerceProvider`. It speaks Play product ids and plugin codes
 * only: `fetchProducts` is `getProducts`, `requestPurchase` is `purchase` with
 * the obfuscated account id from the request's account binding and the offer
 * token from `offerId`, `getAvailablePurchases` is `getPurchases` filtered to
 * unfinished entries (purchased and not acknowledged, plus pending on
 * request), and `purchaseUpdated` events are the plugin's. A purchased plugin
 * outcome is `purchased`; a pending one is `launched`, because Play resolves
 * it later through `purchaseUpdated` or `getPurchases`; a cancelled one is
 * `cancelled`; a plugin rejection is `failed` with the plugin code, which the
 * provider normalizes (`PLAY_BILLING_TIMEOUT`, `PLAY_BILLING_INTERRUPTED`, and
 * `PLAY_BILLING_EMPTY_PURCHASE` become `OUTCOME_UNKNOWN` and stay recoverable).
 * `transactionId` is the order id or, until Play assigns one, the token key
 * `play-token-sha256:<hex>` existing ledgers already use. Nothing here grants, and
 * nothing here acknowledges or consumes: the backend finalizer owns both.
 */
export function createCapacitorPlayBillingStoreSdk(
  input: CreateCapacitorPlayBillingStoreSdkInput,
): CapacitorPlayBillingStoreSdk {
  const plugin = input.plugin ?? CapacitorPlayBilling;
  const isAndroid = input.isAndroid ?? (() => Capacitor.getPlatform() === 'android');
  const products = new Map<string, PlayBillingStoreSdkProduct>();
  for (const product of input.products) {
    if (
      !isRecord(product)
      || typeof product.sku !== 'string' || !productIdPattern.test(product.sku)
      || products.has(product.sku)
      || (product.kind !== 'consumable' && product.kind !== 'durable')
      || (product.offerToken !== undefined
        && (typeof product.offerToken !== 'string' || product.offerToken.length === 0))
    ) {
      throw new TypeError('Play Billing products must be unique, valid one-time product ids.');
    }
    products.set(product.sku, product);
  }
  if (products.size === 0) {
    throw new TypeError('Play Billing requires at least one one-time product.');
  }
  if (products.size > maximumProducts) {
    throw new TypeError(`Play Billing supports at most ${maximumProducts} products per SDK.`);
  }

  // One plugin listener serves every SDK listener; it attaches with the first
  // and detaches with the last, so an idle SDK holds no native subscription.
  const listeners = new Map<StoreSdkEventName, Set<(event: never) => void>>();
  let pluginListener: Promise<PluginListenerHandle> | undefined;
  let pluginListenerGeneration = 0;

  const emit = (event: StoreSdkEvent): void => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) {
      (listener as (value: StoreSdkEvent) => void)(event);
    }
  };
  const listenerCount = (): number => {
    let count = 0;
    for (const set of listeners.values()) {
      count += set.size;
    }
    return count;
  };
  const reportUnmapped = (purchase: unknown): void => {
    try {
      input.onUnmappedPurchase?.(purchase as PlayPurchase);
    } catch {
      // Diagnostics never break delivery.
    }
  };
  /** Whether a plugin purchase maps to one configured SKU; anything else is diagnostics only. */
  const isMapped = (purchase: Readonly<Record<string, unknown>>): boolean => {
    const sku = skuOf(purchase);
    if (sku !== undefined && products.has(sku)) {
      return true;
    }
    reportUnmapped(purchase);
    return false;
  };
  // Deliveries leave in the order the plugin reported them: a purchase with
  // an order id converts and emits synchronously, one without awaits the token
  // digest, and while such a conversion is in flight every later delivery
  // queues behind it instead of overtaking it.
  let deliveries: Promise<void> | undefined;
  const enqueue = (task: () => void | Promise<void>): void => {
    const settle = (result: void | Promise<void>, previous: Promise<void> | undefined): void => {
      if (result === undefined) {
        return;
      }
      const chained: Promise<void> = (previous ?? Promise.resolve())
        .then(() => result)
        .catch(() => undefined)
        .then(() => {
          if (deliveries === chained) {
            deliveries = undefined;
          }
        });
      deliveries = chained;
    };
    if (deliveries === undefined) {
      settle(task(), undefined);
      return;
    }
    const pending = deliveries;
    settle(pending.then(task), pending);
  };
  const emitConverted = (purchase: Readonly<Record<string, unknown>>): void | Promise<void> => {
    const deliver = (converted: StoreSdkPurchase): void => {
      emit({ type: 'purchaseUpdated', purchase: converted });
    };
    const fail = (error: unknown): void => {
      const sku = skuOf(purchase);
      emit({
        type: 'purchaseError',
        ...(sku === undefined ? {} : { sku }),
        error: toSdkError(error),
      });
    };
    let converted: StoreSdkPurchase | Promise<StoreSdkPurchase>;
    try {
      converted = convertPurchase(purchase);
    } catch (error) {
      fail(error);
      return;
    }
    if (!(converted instanceof Promise)) {
      deliver(converted);
      return;
    }
    return converted.then(deliver, fail);
  };
  const onPurchaseUpdated = (outcome: unknown): void => {
    if (!isRecord(outcome)) {
      return;
    }
    const purchase = outcome.purchase;
    if (purchase === undefined) {
      emitLateTerminalResult(outcome);
      return;
    }
    if (!isRecord(purchase) || !isMapped(purchase)) {
      return;
    }
    enqueue(() => emitConverted(purchase));
  };
  /**
   * A `cancelled` or `failed` update without a purchase is the plugin's late
   * terminal result for a purchase call that already timed out (the provider
   * answered `launched` for `PLAY_BILLING_TIMEOUT`); it closes that attempt.
   */
  const emitLateTerminalResult = (outcome: Readonly<Record<string, unknown>>): void => {
    const sku = typeof outcome.productId === 'string' && products.has(outcome.productId)
      ? outcome.productId
      : undefined;
    if (sku === undefined || (outcome.status !== 'cancelled' && outcome.status !== 'failed')) {
      // Without a product the result cannot be correlated to an attempt.
      return;
    }
    const error: StoreSdkError = outcome.status === 'cancelled'
      ? { code: 'USER_CANCELLED', retryable: false, message: 'Purchase cancelled.' }
      : {
          code: typeof outcome.code === 'string' && outcome.code.length > 0
            ? outcome.code
            : 'PLAY_BILLING_ERROR',
          message: 'Purchase failed after the purchase call timed out.',
        };
    enqueue(() => {
      emit({ type: 'purchaseError', sku, error });
    });
  };
  const attachPluginListener = (): void => {
    if (pluginListener !== undefined) {
      return;
    }
    const generation = pluginListenerGeneration;
    const handle = (async () => plugin.addListener('purchaseUpdated', (outcome) => {
      if (generation === pluginListenerGeneration) {
        onPurchaseUpdated(outcome);
      }
    }))();
    pluginListener = handle;
    handle.catch(() => {
      // A plugin without the event surface (for example off Android) has
      // nothing to deliver; getAvailablePurchases still serves the reconciler.
      if (pluginListener === handle) {
        pluginListener = undefined;
      }
    });
  };
  const detachPluginListener = (): void => {
    const handle = pluginListener;
    if (handle === undefined) {
      return;
    }
    pluginListener = undefined;
    pluginListenerGeneration += 1;
    handle.then((resolved) => resolved.remove()).catch(() => undefined);
  };

  const sdk: CapacitorPlayBillingStoreSdk = {
    store: googlePlayStoreId,
    capabilities: playBillingStoreSdkCapabilities,
    async fetchProducts(request: StoreSdkFetchProductsInput): Promise<readonly StoreSdkProduct[]> {
      assertAndroid(isAndroid);
      if (request.type === 'subscription') {
        return [];
      }
      const skus = request.skus.filter((sku) => products.has(sku));
      if (skus.length === 0) {
        return [];
      }
      const response = await callPlugin(() => plugin.getProducts({ productIds: skus }));
      const reported: StoreSdkProduct[] = [];
      for (const found of readArray(response, 'products')) {
        if (!isRecord(found) || typeof found.productId !== 'string') {
          throw invalidResponse('Play reported a product without an id.');
        }
        const { productId } = found;
        const product = products.get(productId);
        if (product === undefined || !skus.includes(productId)) {
          continue;
        }
        const offers = readOffers(found);
        const selected = selectOffer(offers, product.offerToken);
        if (selected === undefined) {
          // Several eligible offers and no default: a price for the wrong
          // offer is worse than no product, so the catalog must pick one.
          throw new PlayBillingStoreSdkError(
            'PLAY_BILLING_OFFER_REQUIRED',
            `Play lists ${offers.length} eligible offers for ${productId}; configure an offerToken.`,
          );
        }
        reported.push({
          sku: productId,
          kind: product.kind,
          title: readString(found.title),
          description: readString(found.description),
          price: toPrice(selected),
          offers: offers.map((offer): StoreOffer => ({
            offerId: offer.offerToken,
            price: toPrice(offer),
          })),
        });
      }
      return reported;
    },
    async requestPurchase(
      request: StoreSdkRequestPurchaseInput,
    ): Promise<StoreSdkRequestPurchaseResult> {
      assertAndroid(isAndroid);
      const product = products.get(request.sku);
      if (product === undefined) {
        throw new PlayBillingStoreSdkError(
          'PLAY_BILLING_PRODUCT_UNKNOWN',
          `Play Billing does not sell ${request.sku}.`,
        );
      }
      if (request.quantity !== undefined && request.quantity !== 1) {
        throw new PlayBillingStoreSdkError(
          'PLAY_BILLING_INVALID_REQUEST',
          'Play Billing purchases one unit per flow.',
        );
      }
      const binding = request.accountBinding;
      if (
        binding === undefined
        || binding.kind !== 'obfuscated-account-id'
        || typeof binding.value !== 'string'
        || !obfuscatedAccountIdPattern.test(binding.value)
      ) {
        throw new PlayBillingStoreSdkError(
          'PLAY_BILLING_ACCOUNT_REQUIRED',
          'Play Billing requires an obfuscated account id that agrees with the backend resolver.',
        );
      }
      const offerToken = request.offerId ?? product.offerToken;
      let outcome: PlayPurchaseOutcome;
      try {
        outcome = await plugin.purchase({
          productId: product.sku,
          obfuscatedAccountId: binding.value,
          ...(offerToken === undefined ? {} : { offerToken }),
        });
      } catch (error) {
        return { outcome: 'failed', error: toSdkError(error) };
      }
      if (!isRecord(outcome)) {
        throw invalidResponse('Play returned an invalid purchase outcome.');
      }
      switch (outcome.status) {
        case 'cancelled':
          return {
            outcome: 'cancelled',
            error: { code: 'USER_CANCELLED', retryable: false, message: 'Purchase cancelled.' },
          };
        case 'pending':
          // The purchase exists in the store and completes later;
          // purchaseUpdated or getAvailablePurchases resolves it.
          assertOutcomePurchase(outcome, product.sku, 'pending');
          return { outcome: 'launched' };
        case 'purchased': {
          const purchase = assertOutcomePurchase(outcome, product.sku, 'purchased');
          return { outcome: 'purchased', purchase: await toSdkPurchase(purchase) };
        }
        default:
          throw invalidResponse('Play returned an unknown purchase status.');
      }
    },
    async getAvailablePurchases(
      request: StoreSdkGetAvailablePurchasesInput,
    ): Promise<readonly StoreSdkPurchase[]> {
      assertAndroid(isAndroid);
      const includePending = request.includePending ?? false;
      const response = await callPlugin(() => plugin.getPurchases());
      const available: StoreSdkPurchase[] = [];
      for (const purchase of readArray(response, 'purchases')) {
        if (!isRecord(purchase)) {
          throw invalidResponse('Play reported an invalid purchase.');
        }
        if (!isUnfinished(purchase, includePending)) {
          continue;
        }
        if (!isMapped(purchase)) {
          // A retired SKU or a multi-line purchase has no logical id for the
          // reconciler; onUnmappedPurchase sees it.
          continue;
        }
        available.push(await toSdkPurchase(purchase));
      }
      return available;
    },
    addListener<TEvent extends StoreSdkEventName>(
      eventName: TEvent,
      listener: (event: StoreSdkEventOf<TEvent>) => void,
    ): () => void {
      const set = listeners.get(eventName) ?? new Set();
      listeners.set(eventName, set);
      set.add(listener as (event: never) => void);
      attachPluginListener();
      return () => {
        if (!set.delete(listener as (event: never) => void)) {
          return;
        }
        if (listenerCount() === 0) {
          detachPluginListener();
        }
      };
    },
    async getAvailability(): Promise<PlatformProviderAvailability> {
      if (!isAndroid()) {
        return 'unsupported';
      }
      try {
        const response = await plugin.getProducts({ productIds: [...products.keys()] });
        const purchasable = readArray(response, 'products').some((found) => {
          const product = isRecord(found) && typeof found.productId === 'string'
            ? products.get(found.productId)
            : undefined;
          return product !== undefined
            && selectOffer(readOffers(found), product.offerToken) !== undefined;
        });
        return purchasable ? 'available' : 'configuration-required';
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        return typeof code === 'string' && configurationErrorCodes.has(code)
          ? 'configuration-required'
          : 'temporarily-unavailable';
      }
    },
  };
  return sdk;
}

/** Validates a Play purchase token: non-empty, at most 4096 characters, no padding or control characters. */
export function isValidPlayPurchaseToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * `StoreSdkPurchase` of one plugin purchase: `token` is the purchase token,
 * `transactionId` is the order id or the token key when Play has not assigned
 * one yet (so a purchase deduplicates in the ledger before and after Play assigns an order), `purchasedAt`
 * is `purchaseTime` as ISO 8601 when it is a valid instant, and the account
 * binding is the obfuscated account id the purchase flow recorded. Throws
 * `PLAY_BILLING_EVIDENCE_INVALID` for a shape the plugin never produces.
 */
export async function toPlayBillingSdkPurchase(purchase: PlayPurchase): Promise<StoreSdkPurchase> {
  return toSdkPurchase(purchase);
}

async function toSdkPurchase(purchase: unknown): Promise<StoreSdkPurchase> {
  return convertPurchase(purchase);
}

/**
 * Synchronous when Play already assigned an order id; a promise only while
 * the token key is derived, so event delivery is immediate in the common case.
 */
function convertPurchase(purchase: unknown): StoreSdkPurchase | Promise<StoreSdkPurchase> {
  if (!isRecord(purchase)) {
    throw evidenceInvalid('Play purchase is not an object.');
  }
  const state = purchaseStateOf(purchase);
  if (state !== 'pending' && state !== 'purchased') {
    throw evidenceInvalid('Play purchase state is invalid.');
  }
  const sku = skuOf(purchase);
  if (sku === undefined) {
    throw evidenceInvalid('Play purchase must name exactly one product.');
  }
  const token = purchase.purchaseToken;
  if (!isValidPlayPurchaseToken(token)) {
    throw evidenceInvalid('Play purchase token is invalid.');
  }
  const orderId = typeof purchase.orderId === 'string' ? purchase.orderId.trim() : '';
  const build = (transactionId: string): StoreSdkPurchase =>
    buildSdkPurchase(purchase, { sku, state, token, transactionId });
  if (orderId.length > 0) {
    return build(orderId);
  }
  return createGooglePlayTokenPurchaseKey(token).then(build);
}

function buildSdkPurchase(
  purchase: Readonly<Record<string, unknown>>,
  parsed: {
    readonly sku: string;
    readonly state: 'pending' | 'purchased';
    readonly token: string;
    readonly transactionId: string;
  },
): StoreSdkPurchase {
  const { sku, state, token, transactionId } = parsed;
  const purchaseTime = typeof purchase.purchaseTime === 'number'
    ? purchase.purchaseTime
    : purchase.purchaseTimeMillis;
  const purchasedAt = typeof purchaseTime === 'number'
    && Number.isSafeInteger(purchaseTime)
    && purchaseTime > 0
    && purchaseTime <= maximumPurchaseTimeMillis
      ? new Date(purchaseTime).toISOString()
      : undefined;
  const quantity = typeof purchase.quantity === 'number'
    && Number.isSafeInteger(purchase.quantity)
    && purchase.quantity > 0
    ? purchase.quantity
    : 1;
  const accountId = purchase.obfuscatedAccountId;
  return {
    sku,
    transactionId,
    state,
    ...(purchasedAt === undefined ? {} : { purchasedAt }),
    token,
    quantity,
    ...(typeof accountId === 'string' && accountId.length > 0
      ? { accountBinding: { kind: 'obfuscated-account-id', value: accountId } }
      : {}),
  };
}

function skuOf(purchase: unknown): string | undefined {
  if (!isRecord(purchase)) {
    return undefined;
  }
  const products = purchase.products ?? purchase.productIds;
  const sku = Array.isArray(products) && products.length === 1 ? products[0] : undefined;
  return typeof sku === 'string' && productIdPattern.test(sku) ? sku : undefined;
}

/**
 * The purchase state under its Billing 9.1.0 name, or under the 0.1 name
 * (`state`). The plugin's own native code sends only the current names; the
 * 0.1 names (`state`, `productIds`, `purchaseTimeMillis`) are still read so a
 * web bundle shipped ahead of its native binary, for example by a live
 * update onto a 0.1 build, keeps every paid purchase readable and
 * recoverable instead of rejecting it as invalid evidence.
 */
function purchaseStateOf(purchase: Readonly<Record<string, unknown>>): unknown {
  return purchase.purchaseState ?? purchase.state;
}

function isUnfinished(purchase: Readonly<Record<string, unknown>>, includePending: boolean): boolean {
  const state = purchaseStateOf(purchase);
  if (state === 'purchased') {
    // A 0.1 native build reports no flag; an absent flag is unfinished so a
    // paid purchase is never dropped from recovery.
    return purchase.isAcknowledged !== true;
  }
  return state === 'pending' && includePending;
}

function assertOutcomePurchase(
  outcome: Readonly<Record<string, unknown>>,
  expectedSku: string,
  expectedState: 'purchased' | 'pending',
): Readonly<Record<string, unknown>> {
  const purchase = outcome.purchase;
  if (!isRecord(purchase)) {
    throw evidenceInvalid('Play purchase outcome carries no purchase.');
  }
  if (skuOf(purchase) !== expectedSku) {
    throw evidenceInvalid('Play purchase did not match the requested product.');
  }
  if (purchaseStateOf(purchase) !== expectedState) {
    throw evidenceInvalid('Play purchase state is inconsistent.');
  }
  return purchase;
}

function selectOffer(
  offers: readonly PlayOneTimeOffer[],
  offerToken: string | undefined,
): PlayOneTimeOffer | undefined {
  if (offerToken === undefined) {
    return offers.length === 1 ? offers[0] : undefined;
  }
  return offers.find((offer) => offer.offerToken === offerToken);
}

function readOffers(found: unknown): readonly PlayOneTimeOffer[] {
  const offers = isRecord(found) ? found.offers : undefined;
  if (!Array.isArray(offers)) {
    throw invalidResponse('Play reported a product without offers.');
  }
  return offers.map((offer: unknown): PlayOneTimeOffer => {
    if (
      !isRecord(offer)
      || typeof offer.offerToken !== 'string' || offer.offerToken.length === 0
      || typeof offer.formattedPrice !== 'string'
      || typeof offer.currencyCode !== 'string' || offer.currencyCode.length === 0
    ) {
      throw invalidResponse('Play reported an invalid offer.');
    }
    const micros = offer.priceAmountMicros;
    return {
      offerToken: offer.offerToken,
      formattedPrice: offer.formattedPrice,
      currencyCode: offer.currencyCode,
      ...(typeof micros === 'number' && Number.isSafeInteger(micros) && micros >= 0
        ? { priceAmountMicros: micros }
        : {}),
    };
  });
}

function toPrice(offer: PlayOneTimeOffer): StoreSdkProduct['price'] {
  return {
    formatted: offer.formattedPrice,
    currencyCode: offer.currencyCode,
    ...(offer.priceAmountMicros === undefined ? {} : { amountMicros: offer.priceAmountMicros }),
  };
}

function readArray(response: unknown, field: string): readonly unknown[] {
  const value = isRecord(response) ? response[field] : undefined;
  if (!Array.isArray(value)) {
    throw invalidResponse(`Play returned no ${field} list.`);
  }
  return value;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function callPlugin<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSdkError(error);
  }
}

function assertAndroid(isAndroid: () => boolean): void {
  if (!isAndroid()) {
    throw new PlayBillingStoreSdkError(
      'PLAY_BILLING_ANDROID_REQUIRED',
      'Play Billing is only available on Android.',
      { retryable: false },
    );
  }
}

/**
 * A plugin rejection as a `StoreSdkError`: the Capacitor `code` is kept for
 * the provider's error map, with `retryable` and `storeCode` passed through
 * when the rejection carries them; a rejection without a code is
 * `PLAY_BILLING_UNAVAILABLE`.
 */
function toSdkError(error: unknown): StoreSdkError {
  if (error instanceof PlayBillingStoreSdkError) {
    return error;
  }
  if (isRecord(error) && typeof error.code === 'string' && error.code.length > 0) {
    return new PlayBillingStoreSdkError(
      error.code,
      typeof error.message === 'string' && error.message.length > 0 ? error.message : error.code,
      {
        ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
        ...(typeof error.storeCode === 'string' ? { storeCode: error.storeCode } : {}),
        cause: error,
      },
    );
  }
  return new PlayBillingStoreSdkError(
    'PLAY_BILLING_UNAVAILABLE',
    error instanceof Error ? error.message : 'Play Billing is unavailable.',
    { retryable: true, cause: error },
  );
}

function evidenceInvalid(message: string): PlayBillingStoreSdkError {
  return new PlayBillingStoreSdkError('PLAY_BILLING_EVIDENCE_INVALID', message, {
    retryable: false,
  });
}

function invalidResponse(message: string): PlayBillingStoreSdkError {
  return evidenceInvalid(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

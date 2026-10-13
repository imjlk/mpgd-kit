import type { PlatformGateway, PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertRequestPurchaseSupported,
  assertStoreProduct,
  assertStorePurchase,
  CommerceError,
  commerceErrorInfoOf,
  createCommerceEventBuffer,
  isCommerceErrorCode,
  type CommerceCapabilities,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceProvider,
  type FetchProductsInput,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
  type StorePurchaseAccountBinding,
} from '@mpgd/platform/commerce';

import {
  createMicrosoftStoreCommerceEngine,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type CreateMicrosoftStoreCommerceEngineInput,
  type MicrosoftStoreCatalogEntry,
  type MicrosoftStoreCheckoutReport,
  type MicrosoftStoreCommerceAvailability,
  type MicrosoftStoreCommerceGatewayOptions,
  type MicrosoftStoreCommerceOutcomeCode,
  type MicrosoftStoreCommerceProduct,
  type MicrosoftStoreDigitalGoodsPurchase,
} from './microsoft-store-core.js';
import { createUnavailableAdAdapter } from './unavailable-ads.js';

export const microsoftStoreCommerceStoreId = 'microsoft-store' as const;

export interface CreateMicrosoftStoreCommerceProviderInput
  extends CreateMicrosoftStoreCommerceEngineInput {
  /** Defaults to `microsoft-store`; conformance vectors name their fixture store. */
  readonly store?: StoreId;
}

export interface MicrosoftStoreCommerceProvider extends CommerceProvider {
  getAvailability(): Promise<MicrosoftStoreCommerceAvailability>;
}

/**
 * RFC "Errors" class of every client-side Digital Goods outcome code. The
 * code itself travels as `storeCode`.
 */
export const microsoftStoreCommerceErrorCodeMap: Readonly<
  Record<MicrosoftStoreCommerceOutcomeCode, CommerceErrorCode>
> = Object.freeze({
  MICROSOFT_STORE_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
  MICROSOFT_STORE_CATALOG_NOT_PREPARED: 'NOT_PREPARED',
  MICROSOFT_STORE_RECOVERY_SCOPE_CHANGED: 'ACCOUNT_BINDING_REQUIRED',
  MICROSOFT_STORE_USER_CANCELLED: 'USER_CANCELLED',
  MICROSOFT_STORE_PAYMENT_REQUEST_FAILED: 'UNKNOWN',
  MICROSOFT_STORE_CHECKOUT_INTERRUPTED: 'OUTCOME_UNKNOWN',
  MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED: 'OUTCOME_UNKNOWN',
  MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED: 'ACCOUNT_BINDING_REQUIRED',
  MICROSOFT_STORE_RECOVERY_OWNERSHIP_UNAVAILABLE: 'NETWORK',
  MICROSOFT_STORE_CHECKOUT_IDENTITY_CHANGED: 'OUTCOME_UNKNOWN',
  MICROSOFT_STORE_GRANT_PENDING: 'OUTCOME_UNKNOWN',
  MICROSOFT_STORE_GRANT_REJECTED: 'UNKNOWN',
  MICROSOFT_STORE_AUTHORITY_UNAVAILABLE: 'NETWORK',
  MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE: 'STORE_UNAVAILABLE',
});

/** Native bridge payment failures carry their own code; map the known ones. */
const nativePaymentErrorCodeMap: Readonly<Record<string, CommerceErrorCode>> = Object.freeze({
  NATIVE_PURCHASE_NETWORK_ERROR: 'NETWORK',
  NATIVE_PURCHASE_SERVER_ERROR: 'STORE_UNAVAILABLE',
});

interface RememberedSettlement {
  readonly ledgerEntryId: string;
  readonly idempotencyKey: string;
  readonly itemId: string;
  /** The player scope whose checkout the authority settled. */
  readonly recoveryScope: string;
}

/**
 * Commerce v2 provider over the Microsoft Store Digital Goods path.
 * `requestPurchase` opens Payment Request and asks the game-owned authority,
 * which is why the profile is
 * `authority.evidence: 'adapter-settled'`. A `purchased` outcome carries the
 * authority's ledger entry as `settlement`; the reconciler still confirms it
 * through the backend. The provider never grants on its own, and the backend
 * consume finalizer finishes (`lifecycle.finish: 'server'`), so there is no
 * `finishTransaction`.
 *
 * `lifecycle.pending` is false: Microsoft has no store-side pending state.
 * Scoped recovery records are paid, unconsumed purchases the authority has
 * not answered yet, so `getAvailablePurchases` lists them as `purchased`.
 */
export function createMicrosoftStoreCommerceProvider(
  input: CreateMicrosoftStoreCommerceProviderInput,
): MicrosoftStoreCommerceProvider {
  const store: StoreId = input.store ?? microsoftStoreCommerceStoreId;
  if (store.length === 0) {
    throw new TypeError('A Microsoft Store commerce provider requires a non-empty store id.');
  }
  const engine = createMicrosoftStoreCommerceEngine(input);
  const productsById = new Map(engine.products.map((product) => [product.info.id, product]));
  /**
   * Ledger pointers the authority reported this session, by Store purchase
   * identity. Microsoft reuses the purchase token across purchases of one
   * add-on, so a pointer is bound to the checkout key it settled and is
   * forgotten when a new checkout of the add-on starts, the Store stops
   * listing the purchase (the finalizer consumed it), or the authenticated
   * player scope changes.
   */
  const settlements = new Map<string, RememberedSettlement>();

  const buffer = createCommerceEventBuffer();
  const listeners = new Set<(event: CommerceEvent) => void>();
  const emit = (event: CommerceEvent): void => {
    if (listeners.size === 0) {
      buffer.push(event);
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const readRecoveryScope = (): string | undefined => {
    try {
      const scope = input.getRecoveryScope();
      return typeof scope === 'string' && scope.trim().length > 0 ? scope.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  const toStorePurchase = (
    product: MicrosoftStoreCommerceProduct,
    purchase: MicrosoftStoreDigitalGoodsPurchase,
    /** The player scope that claimed the purchase; a globally listed item nobody claimed has none. */
    claimedScope: string | undefined,
    settlement: Pick<RememberedSettlement, 'ledgerEntryId'> | undefined,
  ): StorePurchase => {
    const accountBinding: StorePurchaseAccountBinding | undefined = claimedScope === undefined
      ? undefined
      : { kind: 'obfuscated-account-id', value: claimedScope };
    try {
      // Microsoft issues no transaction-unique token: `purchaseToken` is the
      // add-on product id, unique among unconsumed purchases only, and the
      // server boundary matches `platformTransactionId` against it.
      return assertStorePurchase({
        store,
        transactionId: purchase.purchaseToken,
        storeSku: purchase.itemId,
        logicalId: product.info.id,
        quantity: 1,
        state: 'purchased',
        token: purchase.purchaseToken,
        evidence: {
          schema: microsoftStoreDigitalGoodsEvidenceSchema,
          payload: { itemId: purchase.itemId, purchaseToken: purchase.purchaseToken },
        },
        ...(accountBinding === undefined ? {} : { accountBinding }),
        ...(settlement === undefined ? {} : { settlement: { ledgerEntryId: settlement.ledgerEntryId } }),
      });
    } catch (error) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: 'Microsoft Store reported an invalid purchase.',
        storeCode: 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE',
        cause: error,
      });
    }
  };

  const rememberSettlement = (
    purchase: MicrosoftStoreDigitalGoodsPurchase,
    idempotencyKey: string,
    ledgerEntryId: string,
    recoveryScope: string,
  ): RememberedSettlement => {
    const settlement = Object.freeze({
      ledgerEntryId,
      idempotencyKey,
      itemId: purchase.itemId,
      recoveryScope,
    });
    settlements.set(purchaseIdentity(purchase), settlement);
    return settlement;
  };
  const forgetSettlements = (product: MicrosoftStoreCommerceProduct): void => {
    for (const [identity, settlement] of settlements) {
      if (settlement.itemId === product.inAppOfferToken
        || product.historicalInAppOfferTokens?.includes(settlement.itemId) === true) {
        settlements.delete(identity);
      }
    }
  };

  /**
   * The engine catches Digital Goods and authority failures itself; the one
   * thing that can still throw out of it is the availability probe. Keep that
   * normalized at the provider boundary, like `getCapabilities` does.
   */
  const probed = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new CommerceError('STORE_UNAVAILABLE', {
        message: 'Microsoft Store purchase authority availability could not be read.',
        storeCode: 'MICROSOFT_STORE_AUTHORITY_UNAVAILABLE',
        retryable: true,
        cause: error,
      });
    }
  };

  const getCapabilities = async (): Promise<CommerceCapabilities> => {
    let availability: PlatformProviderAvailability;
    try {
      availability = await engine.getAvailability();
    } catch {
      // A throwing authority probe degrades the snapshot instead of rejecting it.
      availability = 'temporarily-unavailable';
    }
    return createMicrosoftStoreCommerceCapabilities(availability);
  };

  const provider: MicrosoftStoreCommerceProvider = {
    store,
    getAvailability: engine.getAvailability,
    getCapabilities,
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      const type = request.type ?? 'all';
      if (type === 'subscription') {
        return [];
      }
      const catalog = await probed(() => engine.loadCatalog());
      if (catalog.status === 'unavailable') {
        // The capability block already explains an unconfigured or unsupported store.
        return [];
      }
      if (catalog.status === 'failed') {
        throw digitalGoodsUnavailable(catalog.cause);
      }
      return catalog.entries
        .filter((entry) => (
          request.logicalIds === undefined || request.logicalIds.includes(entry.product.info.id)
        ))
        .map((entry) => toStoreProduct(store, entry));
    },
    async requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      const product = productsById.get(request.logicalId);
      if (product === undefined) {
        throw new CommerceError('ITEM_UNAVAILABLE', {
          message: `Microsoft Store does not sell ${request.logicalId}.`,
          storeCode: 'MICROSOFT_STORE_PRODUCT_UNKNOWN',
        });
      }
      // The kind and quantity checks need no store call, so Payment Request
      // still opens inside the caller's user activation.
      assertRequestPurchaseSupported(
        createMicrosoftStoreCommerceCapabilities('available'),
        request,
        'consumable',
      );
      if (!engine.isPrepared(request.logicalId)) {
        // A game normally calls fetchProducts first; preparing here keeps the
        // request valid but spends the user activation on the catalog read.
        const catalog = await probed(() => engine.loadCatalog());
        if (catalog.status === 'unavailable') {
          throw availabilityError(catalog.availability);
        }
        if (catalog.status === 'failed') {
          throw digitalGoodsUnavailable(catalog.cause);
        }
      }
      // A new checkout of this add-on reuses its purchase token: an earlier
      // settlement must not be attached to the purchase this checkout creates.
      forgetSettlements(product);
      const report = await engine.checkout({
        productId: request.logicalId,
        idempotencyKey: request.idempotencyKey,
        source: request.source,
      });
      return toRequestPurchaseResult(report, product);
    },
    /**
     * Store-listed purchases plus scoped recovery records, each `purchased`.
     * `includePending` is ignored: Microsoft has no store-side pending state,
     * so the list is the same with or without it.
     */
    async getAvailablePurchases(): Promise<readonly StorePurchase[]> {
      const report = await probed(() => engine.listUnsettledPurchases());
      if (report.status === 'unavailable') {
        return [];
      }
      if (report.status === 'failed') {
        throw digitalGoodsUnavailable(report.cause);
      }
      const listed = new Set(report.purchases.map((entry) => purchaseIdentity(entry.purchase)));
      for (const [identity, settlement] of settlements) {
        if (!listed.has(identity) || settlement.recoveryScope !== report.recoveryScope) {
          // The finalizer consumed it, or another player signed in: the next
          // purchase of the add-on (and the other player) starts unsettled.
          settlements.delete(identity);
        }
      }
      return report.purchases.map((entry) => {
        const settlement = settlements.get(purchaseIdentity(entry.purchase));
        // A recovery record proves this player claimed the purchase; a pointer
        // settled under another checkout key belongs to an earlier purchase.
        const settled = settlement !== undefined
          && (entry.idempotencyKey === undefined || entry.idempotencyKey === settlement.idempotencyKey);
        const claimed = entry.idempotencyKey !== undefined || settled;
        return toStorePurchase(
          entry.product,
          entry.purchase,
          claimed ? report.recoveryScope : undefined,
          settled ? settlement : undefined,
        );
      });
    },
    async restorePurchases(): Promise<void> {
      // Entitlements come from the backend ledger, never from this provider,
      // so a replay reads nothing but the Store and the authority.
      const report = await probed(() => engine.restore());
      const recoveryScope = report.recoveryScope;
      for (const fulfillment of report.fulfillments) {
        if (fulfillment.outcome.kind === 'granted') {
          // The engine resolves the scope before any replay, so a grant always
          // has one; without it the event still carries the ledger pointer.
          const settlement = recoveryScope === undefined
            ? { ledgerEntryId: fulfillment.outcome.ledgerEntryId }
            : rememberSettlement(
                fulfillment.purchase,
                fulfillment.outcome.idempotencyKey,
                fulfillment.outcome.ledgerEntryId,
                recoveryScope,
              );
          emit({
            type: 'purchaseUpdated',
            purchase: toStorePurchase(
              fulfillment.product,
              fulfillment.purchase,
              recoveryScope,
              settlement,
            ),
          });
        } else if (fulfillment.outcome.kind === 'failed') {
          emit({
            type: 'purchaseError',
            logicalId: fulfillment.product.info.id,
            error: outcomeError(fulfillment.outcome.code),
          });
        }
        // A pending authority answer is not an event: the reconciler re-reads
        // getAvailablePurchases and the next restore replays the record.
      }
      if (report.failure !== undefined) {
        throw digitalGoodsUnavailable(report.failure.cause);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // A buffered settlement belongs to the player who restored it; another
        // player signing in before the first subscriber must not receive it.
        const scope = readRecoveryScope();
        const kept: CommerceEvent[] = [];
        buffer.drain((event) => {
          kept.push(event);
        });
        for (const event of kept) {
          const boundTo = event.type === 'purchaseUpdated'
            ? event.purchase.accountBinding?.value
            : undefined;
          if (boundTo === undefined || boundTo === scope) {
            buffer.push(event);
          }
        }
        buffer.drain(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };

  function toRequestPurchaseResult(
    report: MicrosoftStoreCheckoutReport,
    product: MicrosoftStoreCommerceProduct,
  ): RequestPurchaseResult {
    const { outcome } = report;
    switch (outcome.kind) {
      case 'granted': {
        // The engine refuses to settle without a resolved scope, so a granted
        // outcome always carries the scope the authority bound the grant to.
        const recoveryScope = report.recoveryScope ?? readRecoveryScope();
        const settlement = recoveryScope === undefined
          ? { ledgerEntryId: outcome.ledgerEntryId }
          : rememberSettlement(
              outcome.purchase,
              outcome.idempotencyKey,
              outcome.ledgerEntryId,
              recoveryScope,
            );
        return {
          outcome: 'purchased',
          purchase: toStorePurchase(product, outcome.purchase, recoveryScope, settlement),
        };
      }
      case 'cancelled':
        return { outcome: 'cancelled', error: outcomeError('MICROSOFT_STORE_USER_CANCELLED') };
      case 'pending':
        if (outcome.code === 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED') {
          // The Store identity is bound to another player; it cannot settle for this one.
          return { outcome: 'failed', error: outcomeError(outcome.code) };
        }
        // The payment resolved and the authority answer is open: the attempt
        // stays launched and the reconciler resolves it from the listed purchases.
        return { outcome: 'launched' };
      case 'failed': {
        const error = failureError(outcome.code, outcome.cause);
        if (error.code === 'USER_CANCELLED') {
          return { outcome: 'cancelled', error };
        }
        if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'ALREADY_OWNED') {
          // RFC "Errors": an unfinished purchase may exist, so the attempt stays
          // open for the reconciler instead of becoming terminal.
          return { outcome: 'launched' };
        }
        return { outcome: 'failed', error };
      }
    }
  }

  return provider;
}

/**
 * Installs the commerce v2 provider on a `microsoft-store` gateway: the
 * provider as `commerce`, the `commerce` capability block (a fresh copy per
 * read), and the ads surface replaced wholesale with the unavailable adapter.
 * Microsoft Store builds reuse the browser gateway as a base. That base has no
 * ad SDK, and the Store build must never expose a mock reward that looks like
 * a ledger grant.
 */
export function withMicrosoftStoreCommerceProvider(
  gateway: PlatformGateway,
  provider: MicrosoftStoreCommerceProvider,
  options: MicrosoftStoreCommerceGatewayOptions = {},
): PlatformGateway {
  if (gateway.target !== 'microsoft-store') {
    throw new TypeError(
      'Microsoft Store commerce can only be installed on a microsoft-store gateway.',
    );
  }
  if ('getTargetRuntime' in gateway && typeof gateway.getTargetRuntime === 'function') {
    throw new TypeError(
      'Microsoft Store commerce must be installed before target availability is applied.',
    );
  }

  return {
    ...gateway,
    async getCapabilities() {
      const [commerce, capabilities] = await Promise.all([
        provider.getCapabilities(),
        gateway.getCapabilities(),
      ]);
      return {
        ...capabilities,
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
        remoteLeaderboard:
          capabilities.remoteLeaderboard || options.remoteLeaderboard === true,
        commerce,
      };
    },
    commerce: provider,
    ads: createUnavailableAdAdapter(),
  };
}

/**
 * The Digital Goods capability declaration (RFC "Capabilities" row
 * `microsoft-store`): developer-managed consumables, no store-side pending
 * state, the backend consume finalizer finishes, and the game-owned authority
 * settles before `requestPurchase` returns. Pure: a fresh object on every
 * call, no SDK, no construction.
 */
export function createMicrosoftStoreCommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: false,
      restore: true,
      events: true,
      finish: 'server',
    },
    authority: { evidence: 'adapter-settled', accountBinding: 'required' },
    availability,
  };
}

function toStoreProduct(store: StoreId, entry: MicrosoftStoreCatalogEntry): StoreProduct {
  const amountMicros = readAmountMicros(entry.detail.price.value);
  try {
    return assertStoreProduct({
      logicalId: entry.product.info.id,
      store,
      storeSku: entry.product.inAppOfferToken,
      kind: 'consumable',
      title: entry.info.title,
      description: entry.info.description,
      price: {
        formatted: entry.info.price.formatted,
        currencyCode: entry.info.price.currencyCode,
        ...(amountMicros === undefined ? {} : { amountMicros }),
      },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: `Microsoft Store reported an invalid product for ${entry.product.inAppOfferToken}.`,
      storeCode: 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE',
      cause: error,
    });
  }
}

function readAmountMicros(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  const micros = Math.round(numeric * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : undefined;
}

function purchaseIdentity(purchase: MicrosoftStoreDigitalGoodsPurchase): string {
  return JSON.stringify([purchase.itemId, purchase.purchaseToken]);
}

function outcomeError(code: MicrosoftStoreCommerceOutcomeCode): CommerceErrorInfo {
  return new CommerceError(microsoftStoreCommerceErrorCodeMap[code], {
    message: outcomeMessage(code),
    storeCode: code,
  }).toCommerceErrorInfo();
}

function failureError(code: MicrosoftStoreCommerceOutcomeCode, cause: unknown): CommerceErrorInfo {
  if (code === 'MICROSOFT_STORE_PAYMENT_REQUEST_FAILED') {
    const causeCode = readErrorCode(cause);
    const mapped = causeCode === undefined ? undefined : nativePaymentErrorCodeMap[causeCode];
    if (causeCode !== undefined && mapped !== undefined) {
      return new CommerceError(mapped, {
        message: cause instanceof Error ? cause.message : outcomeMessage(code),
        storeCode: causeCode,
        cause,
      }).toCommerceErrorInfo();
    }
    if (causeCode !== undefined && isCommerceErrorCode(causeCode)) {
      // A Payment Request wrapper that already speaks the v2 contract keeps its class.
      return commerceErrorInfoOf(cause);
    }
  }
  return new CommerceError(microsoftStoreCommerceErrorCodeMap[code], {
    message: outcomeMessage(code),
    storeCode: code,
    ...(cause === undefined ? {} : { cause }),
  }).toCommerceErrorInfo();
}

function availabilityError(availability: MicrosoftStoreCommerceAvailability): CommerceError {
  if (availability === 'configuration-required') {
    return new CommerceError('CONFIGURATION_REQUIRED', {
      message: 'Microsoft Store commerce is not configured.',
    });
  }
  return new CommerceError('STORE_UNAVAILABLE', {
    message: `Microsoft Store commerce is ${availability}.`,
    retryable: false,
  });
}

function digitalGoodsUnavailable(cause: unknown): CommerceError {
  return new CommerceError('STORE_UNAVAILABLE', {
    message: 'Microsoft Store Digital Goods is unavailable.',
    storeCode: 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE',
    retryable: true,
    cause,
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(code) ? code : undefined;
}

function outcomeMessage(code: MicrosoftStoreCommerceOutcomeCode): string {
  switch (code) {
    case 'MICROSOFT_STORE_PRODUCT_UNKNOWN':
      return 'Microsoft Store does not sell this product.';
    case 'MICROSOFT_STORE_CATALOG_NOT_PREPARED':
      return 'Microsoft Store catalog is not prepared; fetch products first.';
    case 'MICROSOFT_STORE_RECOVERY_SCOPE_CHANGED':
      return 'Microsoft Store player scope changed; refresh the catalog for the signed-in player.';
    case 'MICROSOFT_STORE_USER_CANCELLED':
      return 'The Microsoft Store purchase was cancelled.';
    case 'MICROSOFT_STORE_PAYMENT_REQUEST_FAILED':
      return 'Microsoft Store Payment Request failed before a payment resolved.';
    case 'MICROSOFT_STORE_CHECKOUT_INTERRUPTED':
      return 'Microsoft Store checkout was interrupted after the payment resolved.';
    case 'MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED':
      return 'Microsoft Store has not listed the purchase yet.';
    case 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED':
      return 'Microsoft Store purchase is reserved for another authenticated player.';
    case 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_UNAVAILABLE':
      return 'Microsoft Store purchase authority is unavailable for the ownership claim.';
    case 'MICROSOFT_STORE_CHECKOUT_IDENTITY_CHANGED':
      return 'Microsoft Store authority changed the checkout idempotency identity.';
    case 'MICROSOFT_STORE_GRANT_PENDING':
      return 'Microsoft Store purchase authority has not settled the grant yet.';
    case 'MICROSOFT_STORE_GRANT_REJECTED':
      return 'Microsoft Store purchase authority rejected the grant.';
    case 'MICROSOFT_STORE_AUTHORITY_UNAVAILABLE':
      return 'Microsoft Store purchase authority is unavailable.';
    case 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE':
      return 'Microsoft Store Digital Goods is unavailable.';
  }
}

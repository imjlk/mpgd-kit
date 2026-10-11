import type {
  CommerceAdapter,
  Entitlement,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  ProductInfo,
  PurchaseRestoreResult,
  PurchaseResult,
} from '@mpgd/platform';

export const microsoftStoreBillingMethod = 'https://store.microsoft.com/billing' as const;
export const microsoftStoreDigitalGoodsEvidenceSchema =
  'mpgd.microsoft-store.digital-goods.v1' as const;

export type MicrosoftStoreCommerceAvailability =
  | 'available'
  | 'configuration-required'
  | 'unsupported';

export interface MicrosoftStoreDigitalGoodsPrice {
  readonly currency: string;
  /** Numeric provider value when the provider exposes one, as Digital Goods does. */
  readonly value?: string;
  /** Provider-formatted value when the native StoreContext API exposes no numeric price. */
  readonly formatted?: string;
}

export interface MicrosoftStoreDigitalGoodsItem {
  readonly itemId: string;
  readonly title: string;
  readonly description?: string;
  readonly price: MicrosoftStoreDigitalGoodsPrice;
}

export interface MicrosoftStoreDigitalGoodsPurchase {
  readonly itemId: string;
  readonly purchaseToken: string;
}

export interface MicrosoftStoreDigitalGoodsService {
  getDetails(itemIds: readonly string[]): Promise<readonly MicrosoftStoreDigitalGoodsItem[]>;
  listPurchases(): Promise<readonly MicrosoftStoreDigitalGoodsPurchase[]>;
}

export interface MicrosoftStorePaymentResponse {
  readonly details: unknown;
  complete?(result?: 'success' | 'fail' | 'unknown'): Promise<void>;
}

export interface MicrosoftStorePaymentRequest {
  show(): Promise<MicrosoftStorePaymentResponse>;
}

export interface MicrosoftStoreCommerceProduct {
  readonly info: ProductInfo;
  /** Partner Center add-on Product ID used by the browser Digital Goods API. */
  readonly inAppOfferToken: string;
  /** Old Product IDs retained while their unconsumed purchases can still be restored. */
  readonly historicalInAppOfferTokens?: readonly string[];
}

export interface MicrosoftStorePurchaseAuthorityInput {
  readonly productId: LogicalProductId;
  /** Digital Goods item ID. This is not the Store collections product ID. */
  readonly inAppOfferToken: string;
  readonly purchaseToken: string;
  readonly idempotencyKey: string;
  readonly source: 'shop' | 'stage_fail' | 'result' | 'event' | 'recovery';
  readonly evidence: PlatformEvidenceEnvelope;
}

export interface MicrosoftStoreRecoveryAuthorityInput {
  readonly productId: LogicalProductId;
  /** Current catalog token; historical purchased identity remains in evidence. */
  readonly inAppOfferToken: string;
  readonly purchaseToken: string;
  /** Stable checkout identity used as an opaque ownership generation. */
  readonly idempotencyKey?: string;
  readonly evidence: PlatformEvidenceEnvelope;
}

export type MicrosoftStoreRecoveryAuthorityResult =
  | { readonly status: 'granted'; readonly idempotencyKey: string }
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' };

export type MicrosoftStorePurchaseAuthorityResult =
  | {
      readonly status: 'completed';
      /** Authoritative ledger or provider transaction identity. */
      readonly transactionId: string;
      readonly alreadyProcessed?: boolean;
    }
  | {
      readonly status: 'pending' | 'failed';
      readonly transactionId?: string;
    };

export interface MicrosoftStorePurchaseAuthority {
  getAvailability(): Promise<MicrosoftStoreCommerceAvailability>;
  /**
   * Persists the authenticated player's ownership of a checkout result outside browser storage.
   * The server must derive the player from its authenticated session. Deny a Store identity bound
   * to another player or generation, and distinguish that durable denial from an outage.
   */
  claimRecoveryOwnership(
    input: MicrosoftStoreRecoveryAuthorityInput,
  ): Promise<MicrosoftStoreRecoveryAuthorityResult>;
  /**
   * Checks the authenticated authority's durable ownership binding before recovery.
   * A grant returns the original idempotency key. Recovery removes a denied local record, but
   * retains it while the authority is unavailable.
   */
  hasRecoveryOwnership(
    input: MicrosoftStoreRecoveryAuthorityInput,
  ): Promise<MicrosoftStoreRecoveryAuthorityResult>;
  verifyAndGrant(
    input: MicrosoftStorePurchaseAuthorityInput,
  ): Promise<MicrosoftStorePurchaseAuthorityResult>;
  getEntitlements(): Promise<readonly Entitlement[]>;
}

export interface MicrosoftStoreCommerceAdapter extends CommerceAdapter {
  getAvailability(): Promise<MicrosoftStoreCommerceAvailability>;
}

export interface MicrosoftStoreCommerceGatewayOptions {
  /** Set only when the game installs a real server-backed leaderboard adapter. */
  readonly remoteLeaderboard?: boolean;
}

export interface MicrosoftStoreRecoveryIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface MicrosoftStorePendingRecovery {
  readonly version: 1;
  readonly idempotencyKey: string;
  readonly inAppOfferToken: string;
  readonly purchaseToken: string;
}

export interface CreateMicrosoftStoreCommerceAdapterInput {
  readonly products: readonly MicrosoftStoreCommerceProduct[];
  readonly authority: MicrosoftStorePurchaseAuthority;
  readonly getDigitalGoodsService?: () => Promise<MicrosoftStoreDigitalGoodsService>;
  readonly createPaymentRequest?: (
    methodData: readonly {
      readonly supportedMethods: typeof microsoftStoreBillingMethod;
      readonly data: { readonly sku: string };
    }[],
  ) => MicrosoftStorePaymentRequest;
  readonly locale?: string;
  /**
   * Returns a stable, non-secret scope for the currently authenticated player.
   * Recreate or refresh the adapter catalog after this value changes.
   */
  readonly getRecoveryScope: () => string;
  readonly createRecoveryId?: () => string;
  /** Defaults to localStorage when available so scoped pending grants survive a PWA restart. */
  readonly recoveryIdStorage?: MicrosoftStoreRecoveryIdStorage;
  readonly onError?: (error: unknown) => void;
}

export type MicrosoftStoreCheckoutRequest = Parameters<CommerceAdapter['purchase']>[0];

/**
 * Client-side outcome codes of the Digital Goods path. They are the
 * `storeCode` the commerce v2 provider reports and name the branch the v1
 * adapter took; the server-side `MICROSOFT_STORE_*` codes of
 * `@mpgd/game-services` stay separate.
 */
export type MicrosoftStoreCommerceOutcomeCode =
  | 'MICROSOFT_STORE_PRODUCT_UNKNOWN'
  | 'MICROSOFT_STORE_CATALOG_NOT_PREPARED'
  | 'MICROSOFT_STORE_RECOVERY_SCOPE_CHANGED'
  | 'MICROSOFT_STORE_USER_CANCELLED'
  | 'MICROSOFT_STORE_PAYMENT_REQUEST_FAILED'
  | 'MICROSOFT_STORE_CHECKOUT_INTERRUPTED'
  | 'MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED'
  | 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED'
  | 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_UNAVAILABLE'
  | 'MICROSOFT_STORE_CHECKOUT_IDENTITY_CHANGED'
  | 'MICROSOFT_STORE_GRANT_PENDING'
  | 'MICROSOFT_STORE_GRANT_REJECTED'
  | 'MICROSOFT_STORE_AUTHORITY_UNAVAILABLE'
  | 'MICROSOFT_STORE_DIGITAL_GOODS_UNAVAILABLE';

/** What the authority answered for one Store purchase; `granted` is the only settled outcome. */
export type MicrosoftStoreFulfillmentOutcome =
  | {
      readonly kind: 'granted';
      readonly idempotencyKey: string;
      readonly ledgerEntryId: string;
      readonly alreadyProcessed?: boolean;
    }
  | {
      readonly kind: 'pending';
      readonly code: MicrosoftStoreCommerceOutcomeCode;
      readonly transactionId?: string;
    }
  | {
      readonly kind: 'failed';
      readonly code: MicrosoftStoreCommerceOutcomeCode;
      readonly transactionId?: string;
    };

export interface MicrosoftStoreFulfillmentReport {
  readonly product: MicrosoftStoreCommerceProduct;
  readonly purchase: MicrosoftStoreDigitalGoodsPurchase;
  readonly source: MicrosoftStorePurchaseAuthorityInput['source'];
  /** The v1 `PurchaseResult`, unchanged. */
  readonly result: PurchaseResult;
  readonly outcome: MicrosoftStoreFulfillmentOutcome;
}

export type MicrosoftStoreCheckoutOutcome =
  | {
      readonly kind: 'granted';
      readonly purchase: MicrosoftStoreDigitalGoodsPurchase;
      readonly idempotencyKey: string;
      readonly ledgerEntryId: string;
      readonly alreadyProcessed?: boolean;
    }
  | {
      /** The Store payment resolved (or may have); the authority answer is still open. */
      readonly kind: 'pending';
      readonly code: MicrosoftStoreCommerceOutcomeCode;
      readonly purchase?: MicrosoftStoreDigitalGoodsPurchase;
    }
  | {
      readonly kind: 'failed';
      readonly code: MicrosoftStoreCommerceOutcomeCode;
      readonly purchase?: MicrosoftStoreDigitalGoodsPurchase;
      readonly cause?: unknown;
    }
  | { readonly kind: 'cancelled' };

export interface MicrosoftStoreCheckoutReport {
  /** The v1 `PurchaseResult`, unchanged. */
  readonly result: PurchaseResult;
  readonly outcome: MicrosoftStoreCheckoutOutcome;
  /** The player scope the checkout ran under; absent when it failed before resolving one. */
  readonly recoveryScope?: string;
}

export interface MicrosoftStoreCatalogEntry {
  readonly product: MicrosoftStoreCommerceProduct;
  /** The v1 `ProductInfo` with the localized Store title, description, and price. */
  readonly info: ProductInfo;
  readonly detail: MicrosoftStoreDigitalGoodsItem;
}

export type MicrosoftStoreCatalogReport =
  | { readonly status: 'unavailable'; readonly availability: MicrosoftStoreCommerceAvailability }
  | { readonly status: 'loaded'; readonly entries: readonly MicrosoftStoreCatalogEntry[] }
  | { readonly status: 'failed'; readonly cause: unknown };

export interface MicrosoftStoreRestoreOptions {
  /**
   * Whether to finish with the v1 `authority.getEntitlements()` read. The v1
   * adapter needs it for `restoredEntitlements`; the commerce v2 provider
   * reports entitlements from the ledger and skips it, so an entitlement
   * outage cannot fail a restore that already settled purchases.
   * Defaults to true.
   */
  readonly readEntitlements?: boolean;
}

export interface MicrosoftStoreRestoreReport {
  /** The v1 `PurchaseRestoreResult`, unchanged. */
  readonly result: PurchaseRestoreResult;
  readonly fulfillments: readonly MicrosoftStoreFulfillmentReport[];
  /** The player scope the replay ran under; absent when it failed before resolving one. */
  readonly recoveryScope?: string;
  readonly failure?: { readonly cause: unknown };
}

export interface MicrosoftStoreUnsettledPurchase {
  readonly product: MicrosoftStoreCommerceProduct;
  readonly purchase: MicrosoftStoreDigitalGoodsPurchase;
  /** Whether the Store lists it now or only a scoped recovery record remembers it. */
  readonly source: 'store' | 'recovery';
  /** The checkout identity a scoped recovery record holds for it. */
  readonly idempotencyKey?: string;
}

export type MicrosoftStoreUnsettledReport =
  | { readonly status: 'unavailable'; readonly availability: MicrosoftStoreCommerceAvailability }
  | {
      readonly status: 'listed';
      readonly recoveryScope: string;
      readonly purchases: readonly MicrosoftStoreUnsettledPurchase[];
    }
  | { readonly status: 'failed'; readonly cause: unknown };

/**
 * The Digital Goods checkout, recovery, and authority flow shared by the v1
 * `createMicrosoftStoreCommerceAdapter` and the commerce v2
 * `createMicrosoftStoreCommerceProvider`. Every method returns the v1 result
 * unchanged next to a structured outcome. Nothing here grants: the authority
 * decides, and this engine only reports its answer.
 */
export interface MicrosoftStoreCommerceEngine {
  readonly products: readonly MicrosoftStoreCommerceProduct[];
  getAvailability(): Promise<MicrosoftStoreCommerceAvailability>;
  /** Loads localized Store details and prepares checkout for every listed product. */
  loadCatalog(): Promise<MicrosoftStoreCatalogReport>;
  /** Whether `loadCatalog` prepared checkout for the product under the current player scope. */
  isPrepared(productId: LogicalProductId): boolean;
  /** Opens Payment Request synchronously and runs the authority flow on its result. */
  checkout(request: MicrosoftStoreCheckoutRequest): Promise<MicrosoftStoreCheckoutReport>;
  /** Replays scoped recovery records and globally listed purchases through the authority. */
  restore(options?: MicrosoftStoreRestoreOptions): Promise<MicrosoftStoreRestoreReport>;
  /** Store-listed purchases plus scoped recovery records, without calling the authority. */
  listUnsettledPurchases(): Promise<MicrosoftStoreUnsettledReport>;
  getEntitlements(): Promise<readonly Entitlement[]>;
}

export function createMicrosoftStoreCommerceEngine(
  input: CreateMicrosoftStoreCommerceAdapterInput,
): MicrosoftStoreCommerceEngine {
  const products = normalizeProducts(input.products);
  const productsById = new Map(products.map((product) => [product.info.id, product]));
  const productsByStoreId = new Map(products.flatMap((product) => (
    [product.inAppOfferToken, ...(product.historicalInAppOfferTokens ?? [])]
      .map((inAppOfferToken) => [inAppOfferToken, product] as const)
  )));
  const getService = input.getDigitalGoodsService ?? getGlobalDigitalGoodsService;
  const createPaymentRequest = input.createPaymentRequest ?? createGlobalPaymentRequest;
  const createRecoveryId = input.createRecoveryId
    ?? (() => `microsoft-store-recovery-${crypto.randomUUID()}`);
  const recoveryIdStorage = input.recoveryIdStorage ?? getGlobalRecoveryIdStorage();
  const pendingRecoveries = new Map<string, readonly MicrosoftStorePendingRecovery[]>();
  const priceFormatters = new Map<string, Intl.NumberFormat>();
  const preparedCheckouts = new Map<LogicalProductId, {
    readonly recoveryScope: string;
    readonly service: MicrosoftStoreDigitalGoodsService;
  }>();

  function resolveRecoveryId(preferredId?: string): string {
    const recoveryId = nonEmptyValue(preferredId) ?? nonEmptyValue(createRecoveryId());
    if (recoveryId === undefined) {
      throw new TypeError('Microsoft Store recovery ID must be a non-empty string.');
    }
    return recoveryId;
  }

  function reserveRecovery(
    product: MicrosoftStoreCommerceProduct,
    recoveryScope: string,
    preferredId?: string,
    purchase?: MicrosoftStoreDigitalGoodsPurchase,
    reuseExisting = false,
  ): MicrosoftStorePendingRecovery {
    const storageKey = createRecoveryStorageKey(recoveryScope, product);
    const storedRecoveries = getReservedRecoveries(product, recoveryScope);
    const inAppOfferToken = purchase?.itemId ?? product.inAppOfferToken;
    const purchaseToken = purchase?.purchaseToken ?? inAppOfferToken;
    const storedRecovery = storedRecoveries.find((candidate) => (
      candidate.inAppOfferToken === inAppOfferToken
      && candidate.purchaseToken === purchaseToken
      && (preferredId === undefined || candidate.idempotencyKey === preferredId)
    ));
    if (reuseExisting && storedRecovery !== undefined) {
      return storedRecovery;
    }

    const recovery = Object.freeze({
      version: 1,
      idempotencyKey: resolveRecoveryId(preferredId),
      inAppOfferToken,
      purchaseToken,
    }) satisfies MicrosoftStorePendingRecovery;
    // A fresh checkout must replace a stale completed identity even though Microsoft reuses the
    // product token for later consumable purchases. Recovery retries alone reuse the old key.
    const next = Object.freeze([
      ...storedRecoveries.filter((candidate) => (
        candidate.inAppOfferToken !== inAppOfferToken
        || candidate.purchaseToken !== purchaseToken
      )),
      recovery,
    ]);
    pendingRecoveries.set(storageKey, next);
    writeRecoveries(recoveryIdStorage, storageKey, next);
    return recovery;
  }

  function getReservedRecoveries(
    product: MicrosoftStoreCommerceProduct,
    recoveryScope: string,
  ): readonly MicrosoftStorePendingRecovery[] {
    const storageKey = createRecoveryStorageKey(recoveryScope, product);
    if (pendingRecoveries.has(storageKey)) {
      return pendingRecoveries.get(storageKey) ?? [];
    }
    const recoveries = readRecoveries(recoveryIdStorage, storageKey);
    pendingRecoveries.set(storageKey, recoveries);
    return recoveries;
  }

  function releaseRecovery(
    product: MicrosoftStoreCommerceProduct,
    recoveryScope: string,
    recovery: MicrosoftStorePendingRecovery,
  ): void {
    const storageKey = createRecoveryStorageKey(recoveryScope, product);
    const next = getReservedRecoveries(product, recoveryScope).filter((candidate) => (
      candidate.inAppOfferToken !== recovery.inAppOfferToken
      || candidate.purchaseToken !== recovery.purchaseToken
      || candidate.idempotencyKey !== recovery.idempotencyKey
    ));
    pendingRecoveries.set(storageKey, next);
    if (next.length === 0) {
      removeRecoveries(recoveryIdStorage, storageKey);
    } else {
      writeRecoveries(recoveryIdStorage, storageKey, next);
    }
  }

  async function authorizeRecovery(
    product: MicrosoftStoreCommerceProduct,
    purchase: MicrosoftStoreDigitalGoodsPurchase,
    request: {
      readonly idempotencyKey?: string;
      readonly source: MicrosoftStorePurchaseAuthorityInput['source'];
    },
  ): Promise<MicrosoftStoreRecoveryAuthorityResult> {
    const evidence = createPurchaseEvidence(purchase);
    const authorityInput = {
      productId: product.info.id,
      inAppOfferToken: product.inAppOfferToken,
      purchaseToken: purchase.purchaseToken,
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }),
      evidence,
    } as const;
    try {
      return request.source === 'recovery'
        ? await input.authority.hasRecoveryOwnership(authorityInput)
        : await input.authority.claimRecoveryOwnership(authorityInput);
    } catch {
      return { status: 'unavailable' };
    }
  }

  async function getAvailability(): Promise<MicrosoftStoreCommerceAvailability> {
    const authorityAvailability = await input.authority.getAvailability();
    if (authorityAvailability !== 'available') {
      preparedCheckouts.clear();
      return authorityAvailability;
    }

    try {
      await getService();
      return 'available';
    } catch {
      preparedCheckouts.clear();
      return 'unsupported';
    }
  }

  async function fulfill(
    product: MicrosoftStoreCommerceProduct,
    purchase: MicrosoftStoreDigitalGoodsPurchase,
    request: {
      readonly idempotencyKey?: string;
      readonly source: MicrosoftStorePurchaseAuthorityInput['source'];
    },
    recoveryScope: string,
  ): Promise<MicrosoftStoreFulfillmentReport> {
    // Microsoft purchaseToken is the add-on Product ID rather than a purchase-unique token.
    // Retain both the first request identity and the purchased Store identity. A later recovery
    // must not assign a new player's key or fabricate evidence from a changed catalog mapping.
    if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
      throw new Error('Microsoft Store player scope changed before fulfillment.');
    }
    const evidence = createPurchaseEvidence(purchase);
    const report = (
      result: PurchaseResult,
      outcome: MicrosoftStoreFulfillmentOutcome,
    ): MicrosoftStoreFulfillmentReport => ({
      product,
      purchase,
      source: request.source,
      result,
      outcome,
    });

    try {
      const authorization = await authorizeRecovery(product, purchase, request);
      if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
        throw new Error('Microsoft Store player scope changed during recovery authorization.');
      }
      if (authorization.status === 'denied') {
        const recovery = getReservedRecoveries(product, recoveryScope).find((candidate) => (
          candidate.idempotencyKey === request.idempotencyKey
          && candidate.inAppOfferToken === purchase.itemId
          && candidate.purchaseToken === purchase.purchaseToken
        ));
        if (request.source === 'recovery' && recovery !== undefined) {
          releaseRecovery(product, recoveryScope, recovery);
        }
        const denialMessage = request.source === 'recovery'
          ? 'Microsoft Store recovery is not bound to the authenticated player.'
          : 'Microsoft Store purchase is reserved for another authenticated player.';
        input.onError?.(new Error(denialMessage));
        const status = request.source === 'recovery' ? 'failed' : 'pending';
        return report(
          { status, entitlementIds: [], evidence },
          { kind: status, code: 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED' },
        );
      }
      if (authorization.status === 'unavailable') {
        if (request.idempotencyKey !== undefined) {
          reserveRecovery(
            product,
            recoveryScope,
            request.idempotencyKey,
            purchase,
            request.source === 'recovery',
          );
        }
        return report(
          { status: 'pending', entitlementIds: [], evidence },
          { kind: 'pending', code: 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_UNAVAILABLE' },
        );
      }
      if (
        request.source !== 'recovery'
        && authorization.idempotencyKey !== request.idempotencyKey
      ) {
        const message = 'Microsoft Store authority changed the checkout idempotency identity.';
        input.onError?.(new Error(message));
        return report(
          { status: 'pending', entitlementIds: [], evidence },
          { kind: 'pending', code: 'MICROSOFT_STORE_CHECKOUT_IDENTITY_CHANGED' },
        );
      }
      const recovery = reserveRecovery(
        product,
        recoveryScope,
        authorization.idempotencyKey,
        purchase,
        request.source === 'recovery',
      );
      const result = await input.authority.verifyAndGrant({
        productId: product.info.id,
        inAppOfferToken: recovery.inAppOfferToken,
        purchaseToken: recovery.purchaseToken,
        idempotencyKey: recovery.idempotencyKey,
        source: request.source,
        evidence,
      });

      if (result.status !== 'pending') {
        releaseRecovery(product, recoveryScope, recovery);
      }

      const purchaseResult: PurchaseResult = {
        status: result.status,
        ...(result.transactionId === undefined ? {} : { transactionId: result.transactionId }),
        ...(result.status === 'completed'
          ? {
              authoritativeGrant: {
                ledgerEntryId: result.transactionId,
                ...(result.alreadyProcessed === undefined
                  ? {}
                  : { alreadyProcessed: result.alreadyProcessed }),
              },
            }
          : {}),
        entitlementIds: [],
        evidence,
      };
      if (result.status === 'completed') {
        return report(purchaseResult, {
          kind: 'granted',
          idempotencyKey: recovery.idempotencyKey,
          ledgerEntryId: result.transactionId,
          ...(result.alreadyProcessed === undefined
            ? {}
            : { alreadyProcessed: result.alreadyProcessed }),
        });
      }
      return report(purchaseResult, {
        kind: result.status,
        code: result.status === 'pending'
          ? 'MICROSOFT_STORE_GRANT_PENDING'
          : 'MICROSOFT_STORE_GRANT_REJECTED',
        ...(result.transactionId === undefined ? {} : { transactionId: result.transactionId }),
      });
    } catch (error) {
      input.onError?.(error);
      // Preserve evidence as pending. The authority is idempotent and restore() retries the same
      // unconsumed Store ownership after transient transport or authorization failures.
      return report(
        { status: 'pending', entitlementIds: [], evidence },
        { kind: 'pending', code: 'MICROSOFT_STORE_AUTHORITY_UNAVAILABLE' },
      );
    }
  }

  return {
    products,
    getAvailability,
    isPrepared(productId) {
      const preparedCheckout = preparedCheckouts.get(productId);
      if (preparedCheckout === undefined) {
        return false;
      }
      try {
        return resolveRecoveryScope(input.getRecoveryScope) === preparedCheckout.recoveryScope;
      } catch {
        return false;
      }
    },
    async loadCatalog() {
      const availability = await getAvailability();
      if (availability !== 'available') {
        preparedCheckouts.clear();
        return { status: 'unavailable', availability };
      }

      try {
        const recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
        const service = await getService();
        const details = await service.getDetails(products.map((product) => product.inAppOfferToken));
        const detailsById = new Map(details.map((detail) => [detail.itemId, detail]));
        const nextPreparedCheckouts = new Map<
          LogicalProductId,
          { readonly recoveryScope: string; readonly service: MicrosoftStoreDigitalGoodsService }
        >();

        const entries = products.flatMap((product): MicrosoftStoreCatalogEntry[] => {
          const detail = detailsById.get(product.inAppOfferToken);
          if (detail === undefined) {
            return [];
          }

          const price = formatPrice(detail.price, input.locale, priceFormatters);
          if (price === undefined) {
            return [];
          }

          nextPreparedCheckouts.set(product.info.id, { recoveryScope, service });
          return [{
            product,
            info: {
              ...product.info,
              title: nonEmptyString(detail.title) ?? product.info.title,
              description: nonEmptyString(detail.description) ?? product.info.description,
              price,
            },
            detail,
          }];
        });
        preparedCheckouts.clear();
        for (const [productId, preparedCheckout] of nextPreparedCheckouts) {
          preparedCheckouts.set(productId, preparedCheckout);
        }
        return { status: 'loaded', entries };
      } catch (error) {
        preparedCheckouts.clear();
        input.onError?.(error);
        return { status: 'failed', cause: error };
      }
    },
    async checkout(request) {
      const product = productsById.get(request.productId);
      const preparedCheckout = preparedCheckouts.get(request.productId);
      if (product === undefined) {
        return {
          result: failedPurchase(),
          outcome: { kind: 'failed', code: 'MICROSOFT_STORE_PRODUCT_UNKNOWN' },
        };
      }
      if (preparedCheckout === undefined) {
        return {
          result: failedPurchase(),
          outcome: { kind: 'failed', code: 'MICROSOFT_STORE_CATALOG_NOT_PREPARED' },
        };
      }
      let recoveryScope: string;
      try {
        recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
      } catch (error) {
        preparedCheckouts.delete(request.productId);
        input.onError?.(error);
        return {
          result: failedPurchase(),
          outcome: { kind: 'failed', code: 'MICROSOFT_STORE_RECOVERY_SCOPE_CHANGED', cause: error },
        };
      }
      if (recoveryScope !== preparedCheckout.recoveryScope) {
        preparedCheckouts.delete(request.productId);
        input.onError?.(new Error('Microsoft Store player scope changed after catalog preparation.'));
        return {
          result: failedPurchase(),
          outcome: { kind: 'failed', code: 'MICROSOFT_STORE_RECOVERY_SCOPE_CHANGED' },
        };
      }
      const { service } = preparedCheckout;

      let response: MicrosoftStorePaymentResponse | undefined;
      let purchaseToken: string | undefined;
      try {
        // loadCatalog() prepares the authoritative Store service and validates this SKU. Keep
        // checkout free of pre-show awaits so PaymentRequest retains the caller's user activation.
        // The prepared catalog remains reusable for cancellation retries and later products; an
        // explicit catalog refresh or availability failure replaces or clears it.
        response = await createPaymentRequest([
          {
            supportedMethods: microsoftStoreBillingMethod,
            data: { sku: product.inAppOfferToken },
          },
        ]).show();
        purchaseToken = readPurchaseToken(response.details);
        if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
          throw new Error('Microsoft Store player scope changed during checkout.');
        }
        // A Store consumable must be consumed before the same item can be bought again, so an
        // item has at most one recoverable unconsumed purchase at this boundary.
        const purchase = (await service.listPurchases()).find((candidate) => {
          return candidate.itemId === product.inAppOfferToken
            && (purchaseToken === undefined || candidate.purchaseToken === purchaseToken);
        });
        if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
          throw new Error('Microsoft Store player scope changed during ownership lookup.');
        }
        let checkoutReport: MicrosoftStoreCheckoutReport;
        if (purchase === undefined) {
          const unidentifiedPurchase = {
            itemId: product.inAppOfferToken,
            purchaseToken: purchaseToken ?? product.inAppOfferToken,
          } as const;
          const authorization = await authorizeRecovery(product, unidentifiedPurchase, request);
          if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
            throw new Error('Microsoft Store player scope changed during recovery authorization.');
          }
          const changedCheckoutIdentity = authorization.status === 'granted'
            && authorization.idempotencyKey !== request.idempotencyKey;
          const pendingResult = purchaseToken === undefined
            ? pendingUnidentifiedPurchase()
            : pendingPurchase(product.inAppOfferToken, purchaseToken);
          const pendingOutcome = (
            code: MicrosoftStoreCommerceOutcomeCode,
          ): MicrosoftStoreCheckoutOutcome => ({
            kind: 'pending',
            code,
            ...(purchaseToken === undefined
              ? {}
              : { purchase: { itemId: product.inAppOfferToken, purchaseToken } }),
          });
          if (authorization.status === 'denied') {
            input.onError?.(new Error(
              'Microsoft Store purchase is reserved for another authenticated player.',
            ));
            checkoutReport = {
              result: pendingResult,
              outcome: pendingOutcome('MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED'),
            };
          } else if (changedCheckoutIdentity) {
            input.onError?.(new Error(
              'Microsoft Store authority changed the checkout idempotency identity.',
            ));
            checkoutReport = {
              result: pendingResult,
              outcome: pendingOutcome('MICROSOFT_STORE_CHECKOUT_IDENTITY_CHANGED'),
            };
          } else {
            const recoveryId = authorization.status === 'granted'
              ? authorization.idempotencyKey
              : request.idempotencyKey;
            reserveRecovery(
              product,
              recoveryScope,
              recoveryId,
              unidentifiedPurchase,
            );
            checkoutReport = {
              result: pendingResult,
              outcome: pendingOutcome('MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED'),
            };
          }
        } else {
          const fulfillment = await fulfill(product, purchase, request, recoveryScope);
          checkoutReport = {
            result: fulfillment.result,
            outcome: fulfillment.outcome.kind === 'granted'
              ? { ...fulfillment.outcome, purchase }
              : { kind: fulfillment.outcome.kind, code: fulfillment.outcome.code, purchase },
          };
        }

        await completePayment(response, paymentCompletionStatus(checkoutReport.result));
        return { ...checkoutReport, recoveryScope };
      } catch (error) {
        if (isAbortError(error) && response === undefined) {
          return { result: cancelledPurchase(), outcome: { kind: 'cancelled' }, recoveryScope };
        }
        if (response !== undefined) {
          await completePayment(response, 'unknown');
        }
        input.onError?.(error);
        if (purchaseToken !== undefined) {
          return {
            result: pendingPurchase(product.inAppOfferToken, purchaseToken),
            outcome: {
              kind: 'pending',
              code: 'MICROSOFT_STORE_CHECKOUT_INTERRUPTED',
              purchase: { itemId: product.inAppOfferToken, purchaseToken },
            },
            recoveryScope,
          };
        }
        return response === undefined
          ? {
              result: failedPurchase(),
              outcome: {
                kind: 'failed',
                code: 'MICROSOFT_STORE_PAYMENT_REQUEST_FAILED',
                cause: error,
              },
              recoveryScope,
            }
          : {
              result: pendingUnidentifiedPurchase(),
              outcome: { kind: 'pending', code: 'MICROSOFT_STORE_CHECKOUT_INTERRUPTED' },
              recoveryScope,
            };
      }
    },
    async restore(options = {}) {
      if (await getAvailability() !== 'available') {
        return { result: { restoredEntitlements: [] }, fulfillments: [] };
      }

      const fulfillments: MicrosoftStoreFulfillmentReport[] = [];
      let resolvedScope: string | undefined;
      try {
        const recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
        resolvedScope = recoveryScope;
        const service = await getService();
        if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
          throw new Error('Microsoft Store player scope changed before recovery.');
        }
        const resumedPurchases = new Set<string>();
        await Promise.all(products.flatMap((product) => {
          return getReservedRecoveries(product, recoveryScope).map((recovery) => {
            const purchase = {
              itemId: recovery.inAppOfferToken,
              purchaseToken: recovery.purchaseToken,
            } as const;
            return fulfill(product, purchase, {
              idempotencyKey: recovery.idempotencyKey,
              source: 'recovery',
            }, recoveryScope).then((fulfillment) => {
              fulfillments.push(fulfillment);
              // A durable denial removes the stale browser generation. Do not let that stale
              // record suppress a newly listed purchase with the Store's reused product token.
              if (fulfillment.result.status !== 'failed') {
                resumedPurchases.add(createPurchaseIdentity(purchase));
              }
            });
          });
        }));
        const purchases = await service.listPurchases();
        if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
          throw new Error('Microsoft Store player scope changed during recovery lookup.');
        }
        await Promise.all(purchases.flatMap((purchase) => {
          if (resumedPurchases.has(createPurchaseIdentity(purchase))) {
            return [];
          }
          const product = productsByStoreId.get(purchase.itemId);
          if (product === undefined) {
            return [];
          }
          return [
            fulfill(product, purchase, {
              source: 'recovery',
            }, recoveryScope).then((fulfillment) => {
              fulfillments.push(fulfillment);
            }),
          ];
        }));
        const restoredEntitlements = options.readEntitlements === false
          ? []
          : await input.authority.getEntitlements();
        return { result: { restoredEntitlements }, fulfillments, recoveryScope };
      } catch (error) {
        input.onError?.(error);
        return {
          result: { restoredEntitlements: [] },
          fulfillments,
          ...(resolvedScope === undefined ? {} : { recoveryScope: resolvedScope }),
          failure: { cause: error },
        };
      }
    },
    async listUnsettledPurchases() {
      const availability = await getAvailability();
      if (availability !== 'available') {
        return { status: 'unavailable', availability };
      }
      try {
        const recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
        const service = await getService();
        const listed = await service.listPurchases();
        if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
          throw new Error('Microsoft Store player scope changed during ownership lookup.');
        }
        const unsettled: MicrosoftStoreUnsettledPurchase[] = [];
        const seen = new Set<string>();
        for (const purchase of listed) {
          const product = productsByStoreId.get(purchase.itemId);
          if (product === undefined) {
            continue;
          }
          const identity = createPurchaseIdentity(purchase);
          if (seen.has(identity)) {
            continue;
          }
          seen.add(identity);
          const recovery = getReservedRecoveries(product, recoveryScope).find((candidate) => (
            candidate.inAppOfferToken === purchase.itemId
            && candidate.purchaseToken === purchase.purchaseToken
          ));
          unsettled.push({
            product,
            purchase: Object.freeze({ itemId: purchase.itemId, purchaseToken: purchase.purchaseToken }),
            source: 'store',
            ...(recovery === undefined ? {} : { idempotencyKey: recovery.idempotencyKey }),
          });
        }
        for (const product of products) {
          for (const recovery of getReservedRecoveries(product, recoveryScope)) {
            const purchase = Object.freeze({
              itemId: recovery.inAppOfferToken,
              purchaseToken: recovery.purchaseToken,
            });
            const identity = createPurchaseIdentity(purchase);
            if (seen.has(identity)) {
              continue;
            }
            seen.add(identity);
            unsettled.push({
              product,
              purchase,
              source: 'recovery',
              idempotencyKey: recovery.idempotencyKey,
            });
          }
        }
        return { status: 'listed', recoveryScope, purchases: unsettled };
      } catch (error) {
        input.onError?.(error);
        return { status: 'failed', cause: error };
      }
    },
    async getEntitlements() {
      return input.authority.getEntitlements();
    },
  };
}

function normalizeProducts(
  input: readonly MicrosoftStoreCommerceProduct[],
): readonly MicrosoftStoreCommerceProduct[] {
  const productIds = new Set<string>();
  const inAppOfferTokens = new Set<string>();

  return Object.freeze(input.map((product) => {
    if (product.info.type !== 'consumable') {
      throw new TypeError('Microsoft Store Digital Goods currently requires consumable products.');
    }
    if (productIds.has(product.info.id)) {
      throw new TypeError(`Duplicate Microsoft Store logical product ID: ${product.info.id}`);
    }
    const inAppOfferToken = requireIdentifier(
      product.inAppOfferToken,
      'Microsoft Store InAppOfferToken',
    );
    const historicalInAppOfferTokens = Object.freeze(
      (product.historicalInAppOfferTokens ?? []).map((token) => (
        requireIdentifier(token, 'historical Microsoft Store InAppOfferToken')
      )),
    );
    for (const token of [inAppOfferToken, ...historicalInAppOfferTokens]) {
      if (inAppOfferTokens.has(token)) {
        throw new TypeError(`Duplicate Microsoft Store InAppOfferToken: ${token}`);
      }
      inAppOfferTokens.add(token);
    }

    productIds.add(product.info.id);
    return Object.freeze({
      info: Object.freeze({ ...product.info }),
      inAppOfferToken,
      ...(historicalInAppOfferTokens.length === 0 ? {} : { historicalInAppOfferTokens }),
    });
  }));
}

function createPurchaseEvidence(
  purchase: MicrosoftStoreDigitalGoodsPurchase,
): PlatformEvidenceEnvelope {
  return Object.freeze({
    schema: microsoftStoreDigitalGoodsEvidenceSchema,
    payload: Object.freeze({
      itemId: purchase.itemId,
      purchaseToken: purchase.purchaseToken,
    }),
  });
}

function readPurchaseToken(input: unknown): string | undefined {
  if (typeof input === 'string') {
    return nonEmptyString(input);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return nonEmptyString(Reflect.get(input, 'purchaseToken'));
}

function createRecoveryStorageKey(
  recoveryScope: string,
  product: MicrosoftStoreCommerceProduct,
): string {
  return [
    'mpgd',
    'microsoft-store',
    'pending-grant',
    'v3',
    encodeURIComponent(recoveryScope),
    encodeURIComponent(product.info.id),
  ].join(':');
}

function resolveRecoveryScope(getRecoveryScope: () => string): string {
  return requireIdentifier(getRecoveryScope(), 'Microsoft Store recovery scope');
}

function createPurchaseIdentity(purchase: MicrosoftStoreDigitalGoodsPurchase): string {
  return JSON.stringify([purchase.itemId, purchase.purchaseToken]);
}

function getGlobalRecoveryIdStorage(): MicrosoftStoreRecoveryIdStorage | undefined {
  try {
    const storage = Reflect.get(globalThis, 'localStorage');
    return isRecoveryIdStorage(storage) ? storage : undefined;
  } catch {
    return undefined;
  }
}

function isRecoveryIdStorage(input: unknown): input is MicrosoftStoreRecoveryIdStorage {
  return typeof input === 'object'
    && input !== null
    && typeof Reflect.get(input, 'getItem') === 'function'
    && typeof Reflect.get(input, 'setItem') === 'function'
    && typeof Reflect.get(input, 'removeItem') === 'function';
}

function readRecoveries(
  storage: MicrosoftStoreRecoveryIdStorage | undefined,
  key: string,
): readonly MicrosoftStorePendingRecovery[] {
  try {
    const serialized = storage?.getItem(key);
    if (serialized === undefined || serialized === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const recoveries: MicrosoftStorePendingRecovery[] = [];
    const identities = new Set<string>();
    for (const candidate of parsed) {
      const recovery = readRecovery(candidate);
      if (recovery === undefined) {
        continue;
      }
      const identity = createPurchaseIdentity({
        itemId: recovery.inAppOfferToken,
        purchaseToken: recovery.purchaseToken,
      });
      if (!identities.has(identity)) {
        identities.add(identity);
        recoveries.push(recovery);
      }
    }
    return Object.freeze(recoveries);
  } catch {
    return [];
  }
}

function readRecovery(candidate: unknown): MicrosoftStorePendingRecovery | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const idempotencyKey = nonEmptyValue(Reflect.get(candidate, 'idempotencyKey'));
  const inAppOfferToken = readIdentifier(Reflect.get(candidate, 'inAppOfferToken'));
  const purchaseToken = readIdentifier(Reflect.get(candidate, 'purchaseToken'));
  if (
    Reflect.get(candidate, 'version') !== 1
    || idempotencyKey === undefined
    || inAppOfferToken === undefined
    || purchaseToken === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ version: 1, idempotencyKey, inAppOfferToken, purchaseToken });
}

function writeRecoveries(
  storage: MicrosoftStoreRecoveryIdStorage | undefined,
  key: string,
  recoveries: readonly MicrosoftStorePendingRecovery[],
): void {
  try {
    storage?.setItem(key, JSON.stringify(recoveries));
  } catch {
    // In-memory recovery remains available when browser storage is denied or full.
  }
}

function removeRecoveries(
  storage: MicrosoftStoreRecoveryIdStorage | undefined,
  key: string,
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A stale browser value is fail-closed: the backend still validates player and Store binding.
  }
}

function formatPrice(
  price: MicrosoftStoreDigitalGoodsPrice,
  locale: string | undefined,
  formatters: Map<string, Intl.NumberFormat>,
): ProductInfo['price'] | undefined {
  const currencyCode = nonEmptyString(price.currency)?.toUpperCase();
  const providerFormatted = nonEmptyString(price.formatted);
  const currencyValid = currencyCode !== undefined && /^[A-Z]{3}$/u.test(currencyCode);
  if (currencyValid && providerFormatted !== undefined) {
    return {
      formatted: providerFormatted,
      currencyCode,
    };
  }
  const rawValue = nonEmptyString(price.value);
  if (rawValue === undefined) {
    return undefined;
  }
  const numericValue = Number(rawValue);
  if (
    !currencyValid
    || !Number.isFinite(numericValue)
    || numericValue < 0
  ) {
    return undefined;
  }

  try {
    const formatterKey = `${locale ?? ''}\u0000${currencyCode}`;
    let formatter = formatters.get(formatterKey);
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
      });
      formatters.set(formatterKey, formatter);
    }
    return {
      formatted: formatter.format(numericValue),
      currencyCode,
    };
  } catch {
    return undefined;
  }
}

async function getGlobalDigitalGoodsService(): Promise<MicrosoftStoreDigitalGoodsService> {
  const candidate = Reflect.get(globalThis, 'getDigitalGoodsService');
  if (typeof candidate !== 'function') {
    throw new Error('Microsoft Store Digital Goods service is unavailable.');
  }
  const args = [microsoftStoreBillingMethod];
  const service: unknown = await Reflect.apply(candidate, globalThis, args);
  if (!isDigitalGoodsService(service)) {
    throw new Error('Microsoft Store Digital Goods service returned an invalid interface.');
  }
  return service;
}

function createGlobalPaymentRequest(
  methodData: readonly {
    readonly supportedMethods: typeof microsoftStoreBillingMethod;
    readonly data: { readonly sku: string };
  }[],
): MicrosoftStorePaymentRequest {
  const Constructor = Reflect.get(globalThis, 'PaymentRequest');
  if (typeof Constructor !== 'function') {
    throw new Error('Payment Request API is unavailable.');
  }
  const request = Reflect.construct(Constructor, [methodData]) as unknown;
  if (!isPaymentRequest(request)) {
    throw new Error('Payment Request API returned an invalid interface.');
  }
  return request;
}

function isDigitalGoodsService(input: unknown): input is MicrosoftStoreDigitalGoodsService {
  return typeof input === 'object'
    && input !== null
    && typeof Reflect.get(input, 'getDetails') === 'function'
    && typeof Reflect.get(input, 'listPurchases') === 'function';
}

function isPaymentRequest(input: unknown): input is MicrosoftStorePaymentRequest {
  return typeof input === 'object'
    && input !== null
    && typeof Reflect.get(input, 'show') === 'function';
}

async function completePayment(
  response: MicrosoftStorePaymentResponse,
  status: 'success' | 'fail' | 'unknown',
): Promise<void> {
  try {
    await response.complete?.(status);
  } catch {
    // Completion only dismisses the provider UI. Store ownership is reconciled separately.
  }
}

function paymentCompletionStatus(result: PurchaseResult): 'success' | 'fail' | 'unknown' {
  if (result.status === 'completed') {
    return 'success';
  }
  return result.status === 'failed' ? 'fail' : 'unknown';
}

function nonEmptyString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : undefined;
}

function nonEmptyValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}

function requireIdentifier(input: unknown, label: string): string {
  const value = nonEmptyString(input);
  if (value === undefined || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
  return value;
}

function readIdentifier(input: unknown): string | undefined {
  const value = nonEmptyString(input);
  return value === undefined || /[\p{Cc}\p{Cf}]/u.test(value) ? undefined : value;
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object'
      && error !== null
      && Reflect.get(error, 'name') === 'AbortError';
}

function failedPurchase(): PurchaseResult {
  return Object.freeze({ status: 'failed', entitlementIds: [] });
}

function cancelledPurchase(): PurchaseResult {
  return Object.freeze({ status: 'cancelled', entitlementIds: [] });
}

function pendingPurchase(itemId: string, purchaseToken: string): PurchaseResult {
  // Microsoft currently returns the add-on product ID as purchaseToken, not a
  // transaction-unique identifier. Keep it in evidence and never publish it as transactionId.
  return Object.freeze({
    status: 'pending',
    entitlementIds: [],
    evidence: createPurchaseEvidence({ itemId, purchaseToken }),
  });
}

function pendingUnidentifiedPurchase(): PurchaseResult {
  // A resolved Store payment is authoritative even if a malformed client response omitted its
  // token. Leave it pending so a later listPurchases() recovery can verify and grant it safely.
  return Object.freeze({ status: 'pending', entitlementIds: [] });
}

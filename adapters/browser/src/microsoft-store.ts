import type {
  CommerceAdapter,
  Entitlement,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  PlatformGateway,
  ProductInfo,
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
  readonly value: string;
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

export function createMicrosoftStoreCommerceAdapter(
  input: CreateMicrosoftStoreCommerceAdapterInput,
): MicrosoftStoreCommerceAdapter {
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
  ): Promise<PurchaseResult> {
    // Microsoft purchaseToken is the add-on Product ID rather than a purchase-unique token.
    // Retain both the first request identity and the purchased Store identity. A later recovery
    // must not assign a new player's key or fabricate evidence from a changed catalog mapping.
    if (resolveRecoveryScope(input.getRecoveryScope) !== recoveryScope) {
      throw new Error('Microsoft Store player scope changed before fulfillment.');
    }
    const evidence = createPurchaseEvidence(purchase);

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
        return {
          status: request.source === 'recovery' ? 'failed' : 'pending',
          entitlementIds: [],
          evidence,
        };
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
        return { status: 'pending', entitlementIds: [], evidence };
      }
      if (
        request.source !== 'recovery'
        && authorization.idempotencyKey !== request.idempotencyKey
      ) {
        const message = 'Microsoft Store authority changed the checkout idempotency identity.';
        input.onError?.(new Error(message));
        return { status: 'pending', entitlementIds: [], evidence };
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

      return {
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
    } catch (error) {
      input.onError?.(error);
      // Preserve evidence as pending. The authority is idempotent and restore() retries the same
      // unconsumed Store ownership after transient transport or authorization failures.
      return {
        status: 'pending',
        entitlementIds: [],
        evidence,
      };
    }
  }

  return {
    getAvailability,
    async getProducts() {
      if (await getAvailability() !== 'available') {
        preparedCheckouts.clear();
        return [];
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

        const availableProducts = products.flatMap((product) => {
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
            ...product.info,
            title: nonEmptyString(detail.title) ?? product.info.title,
            description: nonEmptyString(detail.description) ?? product.info.description,
            price,
          }];
        });
        preparedCheckouts.clear();
        for (const [productId, preparedCheckout] of nextPreparedCheckouts) {
          preparedCheckouts.set(productId, preparedCheckout);
        }
        return availableProducts;
      } catch (error) {
        preparedCheckouts.clear();
        input.onError?.(error);
        return [];
      }
    },
    async purchase(request) {
      const product = productsById.get(request.productId);
      const preparedCheckout = preparedCheckouts.get(request.productId);
      if (product === undefined || preparedCheckout === undefined) {
        return failedPurchase();
      }
      let recoveryScope: string;
      try {
        recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
      } catch (error) {
        preparedCheckouts.delete(request.productId);
        input.onError?.(error);
        return failedPurchase();
      }
      if (recoveryScope !== preparedCheckout.recoveryScope) {
        preparedCheckouts.delete(request.productId);
        input.onError?.(new Error('Microsoft Store player scope changed after catalog preparation.'));
        return failedPurchase();
      }
      const { service } = preparedCheckout;

      let response: MicrosoftStorePaymentResponse | undefined;
      let purchaseToken: string | undefined;
      try {
        // getProducts() prepares the authoritative Store service and validates this SKU. Keep
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
        let result: PurchaseResult;
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
          if (authorization.status === 'denied') {
            input.onError?.(new Error(
              'Microsoft Store purchase is reserved for another authenticated player.',
            ));
            result = purchaseToken === undefined
              ? pendingUnidentifiedPurchase()
              : pendingPurchase(product.inAppOfferToken, purchaseToken);
          } else if (changedCheckoutIdentity) {
            input.onError?.(new Error(
              'Microsoft Store authority changed the checkout idempotency identity.',
            ));
            result = purchaseToken === undefined
              ? pendingUnidentifiedPurchase()
              : pendingPurchase(product.inAppOfferToken, purchaseToken);
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
            result = purchaseToken === undefined
              ? pendingUnidentifiedPurchase()
              : pendingPurchase(product.inAppOfferToken, purchaseToken);
          }
        } else {
          result = await fulfill(product, purchase, request, recoveryScope);
        }

        await completePayment(response, paymentCompletionStatus(result));
        return result;
      } catch (error) {
        if (isAbortError(error) && response === undefined) {
          return cancelledPurchase();
        }
        if (response !== undefined) {
          await completePayment(response, 'unknown');
        }
        input.onError?.(error);
        if (purchaseToken !== undefined) {
          return pendingPurchase(product.inAppOfferToken, purchaseToken);
        }
        return response === undefined ? failedPurchase() : pendingUnidentifiedPurchase();
      }
    },
    async restore() {
      if (await getAvailability() !== 'available') {
        return { restoredEntitlements: [] };
      }

      try {
        const recoveryScope = resolveRecoveryScope(input.getRecoveryScope);
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
            }, recoveryScope).then((result) => {
              // A durable denial removes the stale browser generation. Do not let that stale
              // record suppress a newly listed purchase with the Store's reused product token.
              if (result.status !== 'failed') {
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
            }, recoveryScope),
          ];
        }));
        return { restoredEntitlements: await input.authority.getEntitlements() };
      } catch (error) {
        input.onError?.(error);
        return { restoredEntitlements: [] };
      }
    },
    async getEntitlements() {
      return input.authority.getEntitlements();
    },
  };
}

export function withMicrosoftStoreCommerceAdapter(
  gateway: PlatformGateway,
  commerce: MicrosoftStoreCommerceAdapter,
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
      const [availability, capabilities] = await Promise.all([
        commerce.getAvailability(),
        gateway.getCapabilities(),
      ]);
      return {
        ...capabilities,
        nativeIap: availability === 'available',
        remoteLeaderboard:
          capabilities.remoteLeaderboard || options.remoteLeaderboard === true,
      };
    },
    commerce,
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
  const rawValue = nonEmptyString(price.value);
  if (rawValue === undefined) {
    return undefined;
  }
  const numericValue = Number(rawValue);
  if (
    currencyCode === undefined
    || !/^[A-Z]{3}$/u.test(currencyCode)
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

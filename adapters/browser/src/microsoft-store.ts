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
  verifyAndGrant(
    input: MicrosoftStorePurchaseAuthorityInput,
  ): Promise<MicrosoftStorePurchaseAuthorityResult>;
  getEntitlements(): Promise<readonly Entitlement[]>;
}

export interface MicrosoftStoreCommerceAdapter extends CommerceAdapter {
  getAvailability(): Promise<MicrosoftStoreCommerceAvailability>;
}

export interface MicrosoftStoreRecoveryIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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
  readonly createRecoveryId?: () => string;
  /** Defaults to localStorage when available so pending grants survive a PWA restart. */
  readonly recoveryIdStorage?: MicrosoftStoreRecoveryIdStorage;
  readonly onError?: (error: unknown) => void;
}

export function createMicrosoftStoreCommerceAdapter(
  input: CreateMicrosoftStoreCommerceAdapterInput,
): MicrosoftStoreCommerceAdapter {
  const products = normalizeProducts(input.products);
  const productsById = new Map(products.map((product) => [product.info.id, product]));
  const productsByStoreId = new Map(products.map((product) => [product.inAppOfferToken, product]));
  const getService = input.getDigitalGoodsService ?? getGlobalDigitalGoodsService;
  const createPaymentRequest = input.createPaymentRequest ?? createGlobalPaymentRequest;
  const createRecoveryId = input.createRecoveryId
    ?? (() => `microsoft-store-recovery-${crypto.randomUUID()}`);
  const recoveryIdStorage = input.recoveryIdStorage ?? getGlobalRecoveryIdStorage();
  const pendingRecoveryIds = new Map<string, string>();
  const priceFormatters = new Map<string, Intl.NumberFormat>();
  const preparedCheckoutServices = new Map<LogicalProductId, MicrosoftStoreDigitalGoodsService>();

  function reserveRecoveryId(
    product: MicrosoftStoreCommerceProduct,
    preferredId?: string,
  ): string {
    const storageKey = createRecoveryStorageKey(product);
    const storedId = getReservedRecoveryId(product);
    if (storedId !== undefined) {
      return storedId;
    }

    const recoveryId = nonEmptyValue(preferredId) ?? nonEmptyValue(createRecoveryId());
    if (recoveryId === undefined) {
      throw new TypeError('Microsoft Store recovery ID must be a non-empty string.');
    }
    pendingRecoveryIds.set(storageKey, recoveryId);
    writeRecoveryId(recoveryIdStorage, storageKey, recoveryId);
    return recoveryId;
  }

  function getReservedRecoveryId(
    product: MicrosoftStoreCommerceProduct,
  ): string | undefined {
    const storageKey = createRecoveryStorageKey(product);
    const recoveryId = pendingRecoveryIds.get(storageKey)
      ?? readRecoveryId(recoveryIdStorage, storageKey);
    if (recoveryId !== undefined) {
      pendingRecoveryIds.set(storageKey, recoveryId);
    }
    return recoveryId;
  }

  function releaseRecoveryId(product: MicrosoftStoreCommerceProduct): void {
    const storageKey = createRecoveryStorageKey(product);
    pendingRecoveryIds.delete(storageKey);
    removeRecoveryId(recoveryIdStorage, storageKey);
  }

  async function getAvailability(): Promise<MicrosoftStoreCommerceAvailability> {
    const authorityAvailability = await input.authority.getAvailability();
    if (authorityAvailability !== 'available') {
      preparedCheckoutServices.clear();
      return authorityAvailability;
    }

    try {
      await getService();
      return 'available';
    } catch {
      preparedCheckoutServices.clear();
      return 'unsupported';
    }
  }

  async function fulfill(
    product: MicrosoftStoreCommerceProduct,
    purchase: MicrosoftStoreDigitalGoodsPurchase,
    request: {
      readonly idempotencyKey: string;
      readonly source: MicrosoftStorePurchaseAuthorityInput['source'];
    },
  ): Promise<PurchaseResult> {
    const evidence = createPurchaseEvidence(purchase);
    // Microsoft purchaseToken is the add-on Product ID rather than a purchase-unique token.
    // Retain the first request identity while this one unconsumed item is pending so a later
    // recovery can resume the durable ledger grant without re-verifying a changed Store mapping.
    const idempotencyKey = reserveRecoveryId(product, request.idempotencyKey);

    try {
      const result = await input.authority.verifyAndGrant({
        productId: product.info.id,
        inAppOfferToken: product.inAppOfferToken,
        purchaseToken: purchase.purchaseToken,
        idempotencyKey,
        source: request.source,
        evidence,
      });

      if (result.status !== 'pending') {
        releaseRecoveryId(product);
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
        preparedCheckoutServices.clear();
        return [];
      }

      try {
        const service = await getService();
        const details = await service.getDetails(products.map((product) => product.inAppOfferToken));
        const detailsById = new Map(details.map((detail) => [detail.itemId, detail]));
        const nextPreparedCheckoutServices = new Map<
          LogicalProductId,
          MicrosoftStoreDigitalGoodsService
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

          nextPreparedCheckoutServices.set(product.info.id, service);
          return [{
            ...product.info,
            title: nonEmptyString(detail.title) ?? product.info.title,
            description: nonEmptyString(detail.description) ?? product.info.description,
            price,
          }];
        });
        preparedCheckoutServices.clear();
        for (const [productId, preparedService] of nextPreparedCheckoutServices) {
          preparedCheckoutServices.set(productId, preparedService);
        }
        return availableProducts;
      } catch (error) {
        preparedCheckoutServices.clear();
        input.onError?.(error);
        return [];
      }
    },
    async purchase(request) {
      const product = productsById.get(request.productId);
      const service = preparedCheckoutServices.get(request.productId);
      if (product === undefined || service === undefined) {
        return failedPurchase();
      }

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
        // A Store consumable must be consumed before the same item can be bought again, so an
        // item has at most one recoverable unconsumed purchase at this boundary.
        const purchase = (await service.listPurchases()).find((candidate) => {
          return candidate.itemId === product.inAppOfferToken
            && (purchaseToken === undefined || candidate.purchaseToken === purchaseToken);
        });
        let result: PurchaseResult;
        if (purchase === undefined) {
          reserveRecoveryId(product, request.idempotencyKey);
          if (purchaseToken === undefined) {
            result = pendingUnidentifiedPurchase();
          } else {
            result = pendingPurchase(product.inAppOfferToken, purchaseToken);
          }
        } else {
          result = await fulfill(product, purchase, request);
        }

        await completePayment(response, paymentCompletionStatus(result));
        return result;
      } catch (error) {
        if (isAbortError(error) && response === undefined) {
          return cancelledPurchase();
        }
        if (response !== undefined) {
          await completePayment(response, 'unknown');
          reserveRecoveryId(product, request.idempotencyKey);
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
        const service = await getService();
        const resumedItems = new Set<string>();
        await Promise.all(products.flatMap((product) => {
          const recoveryId = getReservedRecoveryId(product);
          if (recoveryId === undefined) {
            return [];
          }

          resumedItems.add(product.inAppOfferToken);
          return [
            fulfill(product, {
              itemId: product.inAppOfferToken,
              purchaseToken: product.inAppOfferToken,
            }, {
              idempotencyKey: recoveryId,
              source: 'recovery',
            }),
          ];
        }));
        const purchases = await service.listPurchases();
        await Promise.all(purchases.flatMap((purchase) => {
          if (resumedItems.has(purchase.itemId)) {
            return [];
          }
          const product = productsByStoreId.get(purchase.itemId);
          if (product === undefined) {
            return [];
          }
          return [
            fulfill(product, purchase, {
              idempotencyKey: reserveRecoveryId(product),
              source: 'recovery',
            }),
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
      return {
        ...await gateway.getCapabilities(),
        nativeIap: await commerce.getAvailability() === 'available',
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
    if (inAppOfferTokens.has(inAppOfferToken)) {
      throw new TypeError(`Duplicate Microsoft Store InAppOfferToken: ${inAppOfferToken}`);
    }

    productIds.add(product.info.id);
    inAppOfferTokens.add(inAppOfferToken);
    return Object.freeze({
      info: Object.freeze({ ...product.info }),
      inAppOfferToken,
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

function createRecoveryStorageKey(product: MicrosoftStoreCommerceProduct): string {
  return [
    'mpgd',
    'microsoft-store',
    'pending-grant',
    'v2',
    encodeURIComponent(product.info.id),
  ].join(':');
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

function readRecoveryId(
  storage: MicrosoftStoreRecoveryIdStorage | undefined,
  key: string,
): string | undefined {
  try {
    return storage === undefined ? undefined : nonEmptyValue(storage.getItem(key));
  } catch {
    return undefined;
  }
}

function writeRecoveryId(
  storage: MicrosoftStoreRecoveryIdStorage | undefined,
  key: string,
  recoveryId: string,
): void {
  try {
    storage?.setItem(key, recoveryId);
  } catch {
    // In-memory recovery remains available when browser storage is denied or full.
  }
}

function removeRecoveryId(
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

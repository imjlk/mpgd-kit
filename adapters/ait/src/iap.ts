import type { IAP, IapProductListItem, Storage } from '@apps-in-toss/web-framework';

import { createBridgeError, type BridgeResponse } from '@mpgd/bridge';
import type {
  CommerceDiagnostic,
  Entitlement,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  ProductInfo,
  PurchaseRestoreResult,
  PurchaseResult,
  PurchaseSettlement,
} from '@mpgd/platform';

import {
  aitIapDiagnosticCodes,
  aitIapProductNotGrantedByPartnerCode,
  type AitIapDiagnosticCode,
} from './iap-diagnostics.js';

/**
 * Apps in Toss one-time in-app purchase machinery shared by the v1 host bridge
 * (`./host`, the `commerce.*` bridge methods) and the commerce v2 provider
 * (`./commerce-provider`). This module imports only types from the Apps in
 * Toss SDK: the native `IAP` and `Storage` objects are injected through
 * `AitIapHostDependencies`, so the provider can be exported from the package
 * entry without loading the optional SDK peer dependency.
 *
 * Everything here is server-authoritative. The game-owned
 * `verifyIapProductGrant` hook is the only path that grants an order, and the
 * durable attempt markers, order links, acknowledgement barriers and the
 * single IAP lock exist so a paid order is never charged twice and never
 * granted without the server confirming it. The module is internal to
 * `@mpgd/adapter-ait`; it is not a package export.
 */

/** Leaves five seconds of headroom inside the native IAP 30-second grant callback. */
export const defaultIapProductGrantTimeoutMs = 25_000;
/** Bounds abandoned checkout UI while still allowing the user to finish an interactive purchase. */
const defaultIapPurchaseSessionTimeoutMs = 30 * 60_000;
/** A provider response is untrusted input; keep restore work bounded per launch. */
const maximumPendingIapOrders = 20;
export const iapEvidenceSchema = 'apps-in-toss.iap.callback.v1';

/**
 * A client idempotency key must survive a bridge reload. The authoritative
 * backend still owns entitlements; this marker only prevents a second native
 * checkout while the first checkout is known to be terminal or ambiguous.
 */
const iapPurchaseAttemptStoragePrefix = 'mpgd:ait:iap-purchase-attempt:v1:';
const iapCompletedPurchaseAttemptIndexStorageKey = 'mpgd:ait:iap-completed-purchase-index:v1';
const maximumIndexedCompletedIapPurchaseAttempts = 64;
/** A crashed pre-checkout attempt can be retried only after provider recovery finds no order. */
const pendingIapPurchaseAttemptRecoveryAgeMs = defaultIapPurchaseSessionTimeoutMs;
/** Rotates bounded pending-order recovery so an early rejected order cannot starve later work. */
const iapPendingOrderCursorStorageKey = 'mpgd:ait:pending-order-cursor:v1';
/**
 * Links a provider order id to the client purchase attempt that opened it, so
 * recovery paths can pass the game's own purchase key to the verifier and
 * finish that attempt's retry barrier.
 */
const iapOrderAttemptLinkStoragePrefix = 'mpgd:ait:iap-order-attempt:v1:';
/**
 * Orders whose provider acknowledgement was started after a server grant but
 * not confirmed. A timed-out `completeProductGrant()` may still succeed later
 * and remove the order from the pending list, so this list keeps the
 * same-product checkout barrier until a later pass sees the order gone.
 */
const iapAcknowledgementsInFlightStorageKey = 'mpgd:ait:iap-ack-in-flight:v1';
const maximumIapAcknowledgementsInFlight = 32;
/**
 * Barriers whose SKU is no longer configured are kept apart from the active
 * capacity. That product is no longer sold, so once more than this many
 * accumulate, the oldest is dropped; it only served diagnostics by then.
 */
const maximumRetiredIapAcknowledgements = 32;

/**
 * The AIT SDK adds support-version metadata to native functions over time.
 * The host only depends on the callable surface and an optional support probe
 * so adapter tests remain compatible with older wrappers and newer SDKs.
 */
export type AitOptionalCapabilityMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => ReturnType<T>;

export interface AitCapabilityProbe {
  readonly isSupported?: () => boolean;
}

export type AitNativeMethod<T extends (...args: never[]) => unknown> =
  AitOptionalCapabilityMethod<T> & AitCapabilityProbe;

export interface AitIapDependencies {
  readonly createOneTimePurchaseOrder: AitNativeMethod<typeof IAP.createOneTimePurchaseOrder>;
  readonly getProductItemList: AitNativeMethod<typeof IAP.getProductItemList>;
  readonly getPendingOrders: AitNativeMethod<typeof IAP.getPendingOrders>;
  readonly completeProductGrant: AitNativeMethod<typeof IAP.completeProductGrant>;
}

/** Game-owned logical product mapped to a console-issued Apps in Toss SKU. */
export interface AitIapProductConfig {
  readonly productId: LogicalProductId;
  readonly sku: string;
  /** Apps in Toss currently displays KRW prices; override only for a supported future catalog. */
  readonly currencyCode?: string;
}

export interface AitIapPreparationInput {
  readonly intent: 'purchase' | 'restore';
  readonly productId?: LogicalProductId;
  readonly platformSku?: string;
}

/**
 * Game-owned server gate that ensures the anonymous game key is linked to a
 * Toss login user before a purchase or pending-order recovery can proceed.
 */
export type AitIapPreparer = (input: AitIapPreparationInput) => Promise<boolean>;

export interface AitIapProductGrantVerificationInput {
  readonly orderId: string;
  readonly productId: LogicalProductId;
  readonly platformSku: string;
  /** Order-scoped server idempotency key: `apps-in-toss:purchase:<encoded order id>`. */
  readonly idempotencyKey: string;
  /**
   * The game's own `commerce.purchase` idempotency key for the attempt that
   * opened this order. It is present on every path where the bridge can link
   * the order to a client attempt (the grant callback, a direct re-verify, and
   * restore or pre-checkout recovery of an order this device started), and
   * absent when no link survives (for example after native storage loss).
   * Use it to associate the order with a game operation; keep `idempotencyKey`
   * as the grant authority identity.
   */
  readonly clientIdempotencyKey?: string;
  readonly source: 'process-product-grant' | 'pending-order-restore';
  /** Client callback time only; the game authority must use the order status time. */
  readonly purchasedAt: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * A server-backed verifier. Returning false keeps the provider-side grant
 * pending; the bridge never manufactures a client-side entitlement.
 */
export type AitIapProductGrantVerifier = (
  input: AitIapProductGrantVerificationInput,
) => Promise<boolean>;

/**
 * Reads durable purchase entitlements from the game authority. Native product
 * callbacks are intentionally not treated as a source of ownership state.
 */
export type AitIapEntitlementReader = () => Promise<readonly Entitlement[]>;

export interface NormalizedAitIapProduct {
  readonly productId: LogicalProductId;
  readonly sku: string;
  readonly currencyCode: string;
}

export interface NormalizedAitIapProducts {
  readonly byProductId: ReadonlyMap<LogicalProductId, NormalizedAitIapProduct>;
  readonly bySku: ReadonlyMap<string, NormalizedAitIapProduct>;
}

interface AitIapSupportInput {
  readonly dependencies: AitIapHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly prepare: AitIapPreparer | undefined;
  readonly verifier: AitIapProductGrantVerifier | undefined;
  readonly entitlementReader: AitIapEntitlementReader | undefined;
  readonly timeoutMs: number;
}

interface AitIapPurchaseInput {
  readonly dependencies: AitIapHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly prepare: AitIapPreparer;
  readonly verifier: AitIapProductGrantVerifier;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  /** Checks provider orders for configured SKUs before a new checkout can charge again. */
  readonly reconcilePendingOrders: (
    timeoutMs: number,
  ) => Promise<AitIapPendingOrderReconciliation>;
  readonly timeoutMs: number;
}

type AitIapCompletedAttemptRetention = (
  storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
  storageKey: string,
) => Promise<void>;

interface AitIapRestoreInput extends AitIapSupportInput {
  readonly reconcilePendingOrders: (
    verifier: AitIapProductGrantVerifier,
    timeoutMs: number,
  ) => Promise<AitIapPendingOrderReconciliation>;
  readonly timeoutMs: number;
}

export type AitIapGrantSource = 'process-product-grant' | 'pending-order-restore';

export interface AitIapUnresolvedOrder {
  readonly orderId: string;
  readonly sku: string;
}

export type AitIapPendingOrderReconciliation =
  | {
      readonly status: 'unavailable';
      readonly diagnostic: CommerceDiagnostic;
    }
  | {
      readonly status: 'reconciled';
      readonly settledPurchases: readonly PurchaseSettlement[];
      readonly restoredEntitlements: readonly Entitlement[];
      /** Eligible configured orders still awaiting a server grant after this pass. */
      readonly unresolvedOrders: readonly AitIapUnresolvedOrder[];
      /** First per-order reason when an order stayed unresolved. */
      readonly diagnostic?: CommerceDiagnostic;
    };

export type AitIapRestoreOutcome =
  | { readonly status: 'ok'; readonly result: PurchaseRestoreResult }
  | { readonly status: 'failed'; readonly diagnostic: CommerceDiagnostic };

export type AitIapCatalogOutcome<T> =
  | { readonly status: 'ok'; readonly products: T }
  | { readonly status: 'failed'; readonly diagnostic: CommerceDiagnostic };

type AitIapNativeOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'timeout' }
  | { readonly status: 'error'; readonly providerCode?: string };

interface AitIapPurchaseAttemptStorageInput {
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

interface PersistAitIapServerGrantInput extends AitIapPurchaseAttemptStorageInput {
  readonly orderId: string;
}

const aitIapPurchaseAttemptStatus = {
  pending: 'pending',
  serverGranted: 'server-granted',
  completed: 'completed',
} as const;

type AitIapPurchaseAttemptStatus = typeof aitIapPurchaseAttemptStatus[
  keyof typeof aitIapPurchaseAttemptStatus
];

interface PersistAitIapPurchaseAttemptInput extends AitIapPurchaseAttemptStorageInput {
  readonly status: AitIapPurchaseAttemptStatus;
  readonly orderId?: string;
  /** Recorded on a completed marker so a replay reports the path that granted it. */
  readonly source?: AitIapGrantSource;
}

interface ResolvePersistedAitIapPurchaseAttemptInput extends AitIapPurchaseAttemptStorageInput {
  readonly dependencies: Pick<AitIapHostDependencies, 'iap'>;
}

interface VerifyAndPersistAitIapProductGrantInput extends PersistAitIapServerGrantInput {
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderIdempotencyKey: string;
  readonly source: AitIapGrantSource;
  /** Receives the best-effort link write so the caller can settle it before releasing the lock. */
  readonly trackWrite: (write: Promise<unknown>) => void;
}

function isAitIapSupported(input: AitIapSupportInput): boolean {
  if (
    input.products.byProductId.size === 0
    || input.prepare === undefined
    || input.verifier === undefined
    || input.entitlementReader === undefined
  ) {
    return false;
  }

  return isAitNativeMethodSupported(input.dependencies.iap.createOneTimePurchaseOrder)
    && isAitNativeMethodSupported(input.dependencies.iap.getProductItemList)
    && isAitNativeMethodSupported(input.dependencies.iap.getPendingOrders)
    && isAitNativeMethodSupported(input.dependencies.iap.completeProductGrant);
}

/**
 * Product metadata is not authoritative, so a catalog that cannot be read is
 * never replaced with stale game-owned prices. Unconfigured or unsupported IAP
 * still lists no products; a configured catalog that fails reports a stable
 * diagnostic code instead of an indistinguishable empty list.
 */
async function listAitIapProducts(
  input: AitIapSupportInput,
): Promise<AitIapCatalogOutcome<readonly ProductInfo[]>> {
  if (!isAitIapSupported(input)) {
    return { status: 'ok', products: [] };
  }

  const catalog = await readAitIapCatalog(input.dependencies, input.timeoutMs);
  if (catalog.status !== 'ok') {
    return catalog;
  }
  const products: ProductInfo[] = [];
  for (const nativeProduct of catalog.products) {
    const configured = input.products.bySku.get(nativeProduct.sku);
    if (configured === undefined) {
      continue;
    }
    const product = toAitIapProductInfo(nativeProduct, configured);
    if (product !== undefined) {
      products.push(product);
    }
  }
  if (products.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.configuredSkusNotVisible, false),
    };
  }
  if (products.length < input.products.byProductId.size) {
    console.warn('AIT IAP catalog is missing configured products.', {
      configuredCount: input.products.byProductId.size,
      visibleCount: products.length,
    });
  }
  return { status: 'ok', products };
}

async function readAitIapCatalog(
  dependencies: Pick<AitIapHostDependencies, 'iap'>,
  timeoutMs: number,
): Promise<AitIapCatalogOutcome<readonly IapProductListItem[]>> {
  const outcome = await callAitIapNative(
    () =>
      joinAitIapNativeRead(dependencies.iap, 'getProductItemList', () =>
        dependencies.iap.getProductItemList(),
      ),
    timeoutMs,
  );
  if (outcome.status === 'timeout') {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.catalogUnavailable, true),
    };
  }
  if (outcome.status === 'error') {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(
        aitIapDiagnosticCodes.catalogUnavailable,
        true,
        outcome.providerCode,
      ),
    };
  }
  // The SDK resolves without a value when the Toss app is too old.
  const result: unknown = outcome.value;
  if (!isRecord(result)) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unsupportedAppVersion, false),
    };
  }
  const products = Array.isArray(result.products)
    ? (result.products as readonly unknown[]).filter(
        (product): product is IapProductListItem =>
          isRecord(product) && typeof product.sku === 'string',
      )
    : [];
  if (products.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.catalogEmpty, true),
    };
  }
  return { status: 'ok', products };
}

/** Returns undefined when the game authority could not be read in time. */
async function readAitIapEntitlementsIfAvailable(
  reader: AitIapEntitlementReader | undefined,
  timeoutMs: number,
): Promise<readonly Entitlement[] | undefined> {
  if (reader === undefined || timeoutMs <= 0) {
    return undefined;
  }

  try {
    const entitlements = await waitForAitIapNativeCall(reader, timeoutMs);
    return entitlements === undefined ? undefined : [...entitlements];
  } catch (error) {
    // The game authority owns durable purchase state. A read failure must not
    // turn stale local data into a visible entitlement.
    console.warn(
      'AIT IAP entitlement read failed; reporting no entitlements.',
      errorMessage(error),
    );
    return undefined;
  }
}

/**
 * Return a durable result before consulting the provider catalog. This makes a
 * repeated client idempotency key safe after a reload or after the in-memory
 * coalescing map has been cleared.
 */
async function resolvePersistedAitIapPurchaseAttempt(
  input: ResolvePersistedAitIapPurchaseAttemptInput,
): Promise<PurchaseResult | undefined> {
  const storageUnavailable = aitIapDiagnostic(
    aitIapDiagnosticCodes.attemptStorageUnavailable,
    true,
  );
  const attemptPending = aitIapDiagnostic(aitIapDiagnosticCodes.attemptPending, true);
  const storageKey = aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey);
  const read = await readAitIapStorage(input.storage, storageKey, input.timeoutMs);
  if (read.status !== 'ok') {
    console.warn('AIT IAP purchase attempt storage read failed; treating the attempt as pending.');
    return pendingPurchase(undefined, storageUnavailable);
  }
  const serialized = read.value;
  if (serialized === null) {
    return undefined;
  }

  let state: unknown;
  try {
    state = JSON.parse(serialized);
  } catch (error) {
    console.warn(
      'AIT IAP purchase attempt marker is invalid; treating the attempt as pending.',
      errorMessage(error),
    );
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (!isAitIapMarkerForAttempt(state, input.product, input.idempotencyKey)) {
    return pendingPurchase(undefined, storageUnavailable);
  }
  if (state.status === aitIapPurchaseAttemptStatus.pending) {
    if (typeof state.orderId === 'string' && isAitIapOrderId(state.orderId)) {
      return pendingPurchase(
        state.orderId,
        aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true),
      );
    }
    const pendingSince = normalizePendingSince(state.pendingSince);
    if (
      pendingSince === undefined
      || !isAitIapPendingAttemptPastRecoveryWindow(pendingSince)
    ) {
      return pendingPurchase(undefined, attemptPending);
    }
    const hasPendingProviderOrder = await hasAitIapPendingOrderForSku(
      input.dependencies,
      input.product.sku,
      input.timeoutMs,
    );
    if (hasPendingProviderOrder !== false) {
      return pendingPurchase(undefined, attemptPending);
    }
    const cleared = await clearAitIapPurchaseAttempt(input);
    return cleared ? undefined : pendingPurchase(undefined, storageUnavailable);
  }
  if (
    state.status === aitIapPurchaseAttemptStatus.serverGranted
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return pendingPurchase(
      state.orderId,
      aitIapDiagnostic(aitIapDiagnosticCodes.grantCompletionFailed, true),
    );
  }
  if (
    state.status === aitIapPurchaseAttemptStatus.completed
    && typeof state.orderId === 'string'
    && isAitIapOrderId(state.orderId)
  ) {
    return completedAitIapPurchase(
      input.product,
      state.orderId,
      state.source === 'pending-order-restore' ? 'pending-order-restore' : 'process-product-grant',
    );
  }
  return pendingPurchase(undefined, storageUnavailable);
}

const completedAitIapAttemptTombstoneVersion = 1;

/**
 * Whether a parsed marker belongs to this product and client key. Completed
 * tombstones omit the client key (their storage key carries it); full-form
 * markers, including completed ones written before tombstones, must match it.
 */
function isAitIapMarkerForAttempt(
  state: unknown,
  product: NormalizedAitIapProduct,
  idempotencyKey: string,
): state is Readonly<Record<string, unknown>> {
  if (!isRecord(state) || state.productId !== product.productId) {
    return false;
  }
  if (state.v === completedAitIapAttemptTombstoneVersion) {
    return state.status === aitIapPurchaseAttemptStatus.completed
      && state.idempotencyKey === undefined;
  }
  return state.v === undefined && state.idempotencyKey === idempotencyKey;
}

async function persistAitIapPurchaseAttempt(
  input: PersistAitIapPurchaseAttemptInput,
): Promise<boolean> {
  // A completed marker is kept forever as the idempotency record of its
  // client key, so it is a compact tombstone: the storage key already names
  // the product and client key, and replay needs only the order and source.
  const marker = input.status === aitIapPurchaseAttemptStatus.completed
    ? {
        v: completedAitIapAttemptTombstoneVersion,
        status: input.status,
        productId: input.product.productId,
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
        ...(input.source === 'pending-order-restore' ? { source: input.source } : {}),
      }
    : {
        status: input.status,
        productId: input.product.productId,
        idempotencyKey: input.idempotencyKey,
        ...(input.status === aitIapPurchaseAttemptStatus.pending
          ? { pendingSince: new Date().toISOString() }
          : {}),
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      };
  return await writeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    JSON.stringify(marker),
    input.timeoutMs,
  );
}

async function clearAitIapPurchaseAttempt(
  input: AitIapPurchaseAttemptStorageInput,
): Promise<boolean> {
  return await removeAitIapStorage(
    input.storage,
    aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
    input.timeoutMs,
  );
}

async function verifyAndPersistAitIapProductGrant(
  input: VerifyAndPersistAitIapProductGrantInput,
): Promise<boolean> {
  const startedAt = Date.now();
  // Best effort and not awaited here: the link only lets recovery pass the
  // client key for this order, so a slow write must never consume the grant
  // deadline. The purchase still settles it before releasing the IAP lock, so
  // restore never reads an absence that races this write.
  input.trackWrite(
    writeAitIapOrderAttemptLink({
      storage: input.storage,
      product: input.product,
      idempotencyKey: input.idempotencyKey,
      orderId: input.orderId,
      timeoutMs: input.timeoutMs,
    }),
  );
  const correlated = await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.pending,
    timeoutMs: input.timeoutMs,
  });
  if (!correlated) {
    // Never let the backend commit a grant unless the provider order is first
    // durably tied to the client attempt. Otherwise a lost response could let
    // the same client idempotency key open a second checkout after restore.
    return false;
  }
  const verificationTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (verificationTimeoutMs === 0) {
    return false;
  }
  const granted = await verifyAitIapProductGrant({
    verifier: input.verifier,
    orderId: input.orderId,
    product: input.product,
    idempotencyKey: input.orderIdempotencyKey,
    clientIdempotencyKey: input.idempotencyKey,
    source: input.source,
    timeoutMs: verificationTimeoutMs,
  });
  if (!granted) {
    return false;
  }
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (remainingTimeoutMs === 0) {
    return false;
  }
  return await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.serverGranted,
    timeoutMs: remainingTimeoutMs,
  });
}

function remainingAitIapOperationTimeout(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - Math.max(0, Date.now() - startedAt));
}

async function writeAitIapStorage(
  storage: Pick<typeof Storage, 'setItem'>,
  key: string,
  value: string,
  timeoutMs: number,
): Promise<boolean> {
  return (await runAitIapStorageOperation(
    storage,
    key,
    () => storage.setItem(key, value),
    timeoutMs,
  )).status === 'ok';
}

async function removeAitIapStorage(
  storage: Pick<typeof Storage, 'removeItem'>,
  key: string,
  timeoutMs: number,
): Promise<boolean> {
  return (await runAitIapStorageOperation(
    storage,
    key,
    () => storage.removeItem(key),
    timeoutMs,
  )).status === 'ok';
}

function aitIapPurchaseAttemptStorageKey(
  productId: LogicalProductId,
  idempotencyKey: string,
): string {
  return `${iapPurchaseAttemptStoragePrefix}${encodeURIComponent(productId)}:${encodeURIComponent(idempotencyKey)}`;
}

function isAitIapPendingAttemptPastRecoveryWindow(pendingSince: string): boolean {
  const startedAt = Date.parse(pendingSince);
  return Number.isFinite(startedAt)
    && Date.now() - startedAt >= pendingIapPurchaseAttemptRecoveryAgeMs;
}

async function hasAitIapPendingOrderForSku(
  dependencies: Pick<AitIapHostDependencies, 'iap'>,
  sku: string,
  timeoutMs: number,
): Promise<boolean | undefined> {
  try {
    const result = await waitForAitIapNativeCall(
      () =>
        joinAitIapNativeRead(dependencies.iap, 'getPendingOrders', () =>
          dependencies.iap.getPendingOrders(),
        ),
      timeoutMs,
    );
    const orders: unknown = isRecord(result) ? result.orders : undefined;
    if (!Array.isArray(orders)) {
      return undefined;
    }
    let found = false;
    for (const order of orders as readonly unknown[]) {
      if (!isRecord(order) || typeof order.sku !== 'string') {
        // An entry that may be this SKU's order is not proof of absence.
        return undefined;
      }
      if (order.sku !== sku) {
        continue;
      }
      if (typeof order.orderId !== 'string' || !isAitIapOrderId(order.orderId)) {
        return undefined;
      }
      found = true;
    }
    return found;
  } catch (error) {
    console.warn(
      'AIT IAP pending-order lookup failed; preserving the client retry barrier.',
      errorMessage(error),
    );
    return undefined;
  }
}

/**
 * Keep the completed-attempt index bounded without deleting terminal retry
 * markers. A client idempotency key may be replayed indefinitely, so removing
 * its durable result could open a second native checkout. Completed markers
 * are compact tombstones instead. The index is only bookkeeping for recent
 * entries; all storage failures leave markers intact.
 */
async function retainCompletedAitIapPurchaseAttempt(
  storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const read = await readAitIapStorage(
      storage,
      iapCompletedPurchaseAttemptIndexStorageKey,
      timeoutMs,
    );
    if (read.status !== 'ok') {
      return;
    }
    const knownKeys = parseAitIapCompletedPurchaseAttemptIndex(read.value);
    const keys = [...knownKeys.filter((knownKey) => knownKey !== storageKey), storageKey];
    const retainedKeys = keys.slice(-maximumIndexedCompletedIapPurchaseAttempts);
    const retentionTimeoutMs = remainingAitIapOperationTimeout(startedAt, timeoutMs);
    if (retentionTimeoutMs === 0) {
      return;
    }
    await writeAitIapStorage(
      storage,
      iapCompletedPurchaseAttemptIndexStorageKey,
      JSON.stringify(retainedKeys),
      retentionTimeoutMs,
    );
  } catch {
    // Index maintenance is best effort. The terminal marker remains the
    // durable retry barrier even when its recent-entry index cannot be written.
  }
}

function parseAitIapCompletedPurchaseAttemptIndex(
  serialized: string | null | undefined,
): readonly string[] {
  if (serialized === null || serialized === undefined) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) {
      return [];
    }
    const keys = value.filter((key): key is string => (
      typeof key === 'string'
      && key.startsWith(iapPurchaseAttemptStoragePrefix)
      && key.length <= 4_096
    ));
    return [...new Set(keys)].slice(-maximumIndexedCompletedIapPurchaseAttempts);
  } catch {
    return [];
  }
}

async function readAitIapPendingOrderCursor(
  storage: Pick<typeof Storage, 'getItem'>,
  timeoutMs: number,
): Promise<string | undefined> {
  const read = await readAitIapStorage(storage, iapPendingOrderCursorStorageKey, timeoutMs);
  if (read.status !== 'ok') {
    console.warn(
      'AIT IAP pending-order cursor read failed; starting from the first eligible order.',
    );
    return undefined;
  }
  const cursor = read.value;
  return typeof cursor === 'string' && isAitIapOrderId(cursor) ? cursor : undefined;
}

async function writeAitIapPendingOrderCursor(
  storage: Pick<typeof Storage, 'setItem'>,
  orderId: string,
  timeoutMs: number,
): Promise<boolean> {
  return await writeAitIapStorage(storage, iapPendingOrderCursorStorageKey, orderId, timeoutMs);
}

function rotateAitIapPendingOrders<T extends { readonly order: { readonly orderId: string } }>(
  orders: readonly T[],
  cursor: string | undefined,
  limit: number,
): readonly T[] {
  if (orders.length === 0) {
    return [];
  }
  const cursorIndex = cursor === undefined
    ? -1
    : orders.findIndex(({ order }) => order.orderId === cursor);
  const startIndex = cursorIndex < 0 ? 0 : (cursorIndex + 1) % orders.length;
  const selected: T[] = [];
  const count = Math.min(limit, orders.length);
  for (let offset = 0; offset < count; offset += 1) {
    const next = orders[(startIndex + offset) % orders.length];
    if (next !== undefined) {
      selected.push(next);
    }
  }
  return selected;
}

async function purchaseAitIapProduct(input: AitIapPurchaseInput): Promise<PurchaseResult> {
  const prepared = await prepareAitIap(
    input.prepare,
    {
      intent: 'purchase',
      productId: input.product.productId,
      platformSku: input.product.sku,
    },
    input.timeoutMs,
  );
  if (!prepared) {
    return failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.preparationFailed, true));
  }

  // A paid order whose grant failed stays pending at the provider. Resolve it
  // before opening another checkout so the player is never charged twice for
  // a product they already paid for.
  const checkoutBarrier = resolveAitIapCheckoutBarrier(
    await input.reconcilePendingOrders(input.timeoutMs),
    input.product,
  );
  if (checkoutBarrier !== undefined) {
    return failedPurchase(checkoutBarrier);
  }

  const started = await persistAitIapPurchaseAttempt({
    storage: input.dependencies.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    status: aitIapPurchaseAttemptStatus.pending,
    timeoutMs: input.timeoutMs,
  });
  if (!started) {
    // We cannot tell whether a delayed native-storage write eventually
    // succeeded. Do not open a checkout without a durable retry barrier.
    return pendingPurchase(
      undefined,
      aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
    );
  }

  return new Promise<PurchaseResult>((resolve) => {
    const grantAttempts = new Map<string, Promise<boolean>>();
    /**
     * Grant attempts, link writes and direct recovery that may outlive the
     * terminal callback. The result (and with it the IAP lock) is released
     * only after all of them settle; each is bounded by its own deadline.
     */
    const inFlightWork = new Set<Promise<unknown>>();
    const trackWrite = (work: Promise<unknown>): void => {
      inFlightWork.add(work);
      const forget = (): void => {
        inFlightWork.delete(work);
      };
      void work.then(forget, forget);
    };
    /** Waits until no tracked work remains, including work added while waiting. */
    const drainInFlightWork = async (): Promise<void> => {
      while (inFlightWork.size > 0) {
        await Promise.allSettled([...inFlightWork]);
      }
    };
    let settled = false;
    let cleanup: (() => void) | undefined;
    let cleanupRequested = false;
    let sessionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let providerOrderId: string | undefined;
    let grantedOrderId: string | undefined;
    let markerDeletionStarted = false;

    const finish = (result: PurchaseResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (sessionTimeout !== undefined) {
        globalThis.clearTimeout(sessionTimeout);
        sessionTimeout = undefined;
      }
      if (cleanup === undefined) {
        cleanupRequested = true;
      } else {
        safelyCleanupAitIapPurchase(cleanup);
      }
      void drainInFlightWork().then(() => {
        resolve(result);
      });
    };

    const startMarkerDeletion = (clearedResult: PurchaseResult): void => {
      markerDeletionStarted = true;
      void clearAitIapPurchaseAttempt({
        storage: input.dependencies.storage,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
      }).then((cleared) => {
        finish(cleared
          ? clearedResult
          : pendingPurchase(
              undefined,
              aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
            ));
      });
    };

    const processProductGrant = (orderId: string): Promise<boolean> => {
      if (settled) {
        // The terminal result is already decided; never start a grant whose
        // writes could land after the IAP lock is released.
        return Promise.resolve(false);
      }
      if (markerDeletionStarted) {
        // Cancellation won the serialization race. Do not let a later queued
        // grant callback commit after its retry barrier starts disappearing.
        return Promise.resolve(false);
      }
      const existing = grantAttempts.get(orderId);
      if (existing !== undefined) {
        return existing;
      }
      if (
        !isAitIapOrderId(orderId)
        || (providerOrderId !== undefined && providerOrderId !== orderId)
      ) {
        return Promise.resolve(false);
      }
      providerOrderId = orderId;
      const attempt = verifyAndPersistAitIapProductGrant({
        verifier: input.verifier,
        storage: input.dependencies.storage,
        orderId,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        orderIdempotencyKey: createAitIapOrderIdempotencyKey(orderId),
        source: 'process-product-grant',
        trackWrite,
        timeoutMs: input.timeoutMs,
      }).then((granted) => {
        if (granted) {
          grantedOrderId = orderId;
        }
        return granted;
      });
      grantAttempts.set(orderId, attempt);
      trackWrite(attempt);
      return attempt;
    };

    const completeAttempt = async (
      orderId: string,
      source: AitIapGrantSource,
    ): Promise<PurchaseResult> => {
      const persisted = await persistAitIapPurchaseAttempt({
        storage: input.dependencies.storage,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        orderId,
        status: aitIapPurchaseAttemptStatus.completed,
        source,
        timeoutMs: input.timeoutMs,
      });
      if (!persisted) {
        return pendingPurchase(
          orderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
        );
      }
      void input.retainCompletedAttempt(
        input.dependencies.storage,
        aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey),
      );
      return completedAitIapPurchase(input.product, orderId, source);
    };

    /**
     * The SDK reports PRODUCT_NOT_GRANTED_BY_PARTNER after a real payment whose
     * grant callback returned false or ran out of time. The pending-order list
     * can lag right after checkout, so verify this exact order once more and
     * acknowledge it directly instead of waiting for a later restore.
     */
    const recoverNotGrantedOrder = async (
      orderId: string,
      providerCode: string,
    ): Promise<PurchaseResult> => {
      const startedAt = Date.now();
      const priorAttempt = grantAttempts.get(orderId);
      let granted = priorAttempt === undefined ? false : await priorAttempt;
      if (!granted) {
        granted = await verifyAndPersistAitIapProductGrant({
          verifier: input.verifier,
          storage: input.dependencies.storage,
          orderId,
          product: input.product,
          idempotencyKey: input.idempotencyKey,
          orderIdempotencyKey: createAitIapOrderIdempotencyKey(orderId),
          source: 'pending-order-restore',
          trackWrite,
          timeoutMs: input.timeoutMs,
        });
      }
      if (!granted) {
        return pendingPurchase(
          orderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
        );
      }
      grantedOrderId = orderId;
      // Durably finish this client attempt before acknowledging: once
      // acknowledged, the order leaves the pending list and recovery could no
      // longer finish the marker. Without the marker, do not acknowledge.
      const completed = await completeAttempt(orderId, 'pending-order-restore');
      if (completed.status !== 'completed') {
        return completed;
      }
      const acknowledgement = await acknowledgeAitIapOrder({
        dependencies: input.dependencies,
        configuredSkus: input.products.bySku,
        orderId,
        product: input.product,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: remainingAitIapOperationTimeout(startedAt, input.timeoutMs),
      });
      if (acknowledgement.status !== 'acknowledged') {
        // The server grant and the client marker are durable; restore will
        // acknowledge the still-pending provider order later.
        return pendingPurchase(orderId, acknowledgement.diagnostic);
      }
      await removeAitIapOrderAttemptLink(
        input.dependencies.storage,
        orderId,
        remainingAitIapOperationTimeout(startedAt, input.timeoutMs),
      );
      return completed;
    };

    sessionTimeout = globalThis.setTimeout(() => {
      // The native SDK may have dispatched an order even when it fails to
      // deliver a terminal callback. Preserve the marker and let retry or
      // restore reconcile it instead of opening a second checkout.
      finish(pendingPurchase(
        grantedOrderId,
        aitIapDiagnostic(aitIapDiagnosticCodes.checkoutTimeout, true),
      ));
    }, defaultIapPurchaseSessionTimeoutMs);

    try {
      cleanup = input.dependencies.iap.createOneTimePurchaseOrder({
        options: {
          sku: input.product.sku,
          processProductGrant: ({ orderId }) => processProductGrant(orderId),
        },
        onEvent: async ({ data }) => {
          if (settled) {
            // A late terminal callback must not write after the result is decided.
            return;
          }
          const granted = await (
            grantAttempts.get(data.orderId) ?? processProductGrant(data.orderId)
          );
          if (settled) {
            return;
          }
          if (!granted) {
            finish(pendingPurchase(
              providerOrderId,
              aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true),
            ));
            return;
          }
          // Tracked before awaiting, so another terminal path that finishes
          // meanwhile still waits for these writes before releasing the lock.
          const completion = (async (): Promise<PurchaseResult> => {
            const completed = await completeAttempt(data.orderId, 'process-product-grant');
            if (completed.status === 'completed') {
              // The SDK acknowledged the order after the grant callback, and
              // the attempt marker is completed: the link is no longer needed.
              await removeAitIapOrderAttemptLink(
                input.dependencies.storage,
                data.orderId,
                input.timeoutMs,
              );
            }
            return completed;
          })();
          trackWrite(completion);
          finish(await completion);
        },
        onError: (error) => {
          if (settled) {
            // A late native error must not start recovery after the result
            // (and the IAP lock) is released.
            return;
          }
          const providerCode = readAitIapProviderCode(error);
          const knownOrderId = providerOrderId;
          if (
            providerCode === aitIapProductNotGrantedByPartnerCode
            && knownOrderId !== undefined
            && !markerDeletionStarted
          ) {
            const recovery = recoverNotGrantedOrder(knownOrderId, providerCode);
            trackWrite(recovery);
            void recovery.then(finish, () => {
              finish(pendingPurchase(
                knownOrderId,
                aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
              ));
            });
            return;
          }
          if (
            grantedOrderId !== undefined
            || providerOrderId !== undefined
            || grantAttempts.size > 0
            || !isAitIapCancellation(error)
          ) {
            // A cancellation racing an authoritative grant is ambiguous. Keep
            // the durable client retry barrier until retry/restore observes
            // the verifier's eventual result.
            const orderObserved = providerOrderId !== undefined || grantAttempts.size > 0;
            finish(pendingPurchase(
              grantedOrderId ?? providerOrderId,
              aitIapDiagnostic(
                orderObserved
                  ? aitIapDiagnosticCodes.grantPending
                  : aitIapDiagnosticCodes.nativePurchaseFailed,
                true,
                providerCode,
              ),
            ));
            return;
          }
          startMarkerDeletion(cancelledPurchase());
        },
      });
      if (cleanupRequested) {
        safelyCleanupAitIapPurchase(cleanup);
      }
    } catch (error) {
      // A malformed SDK can invoke a grant callback and then throw during
      // registration. Preserve that active order; only a throw with no grant
      // startup proves there is no authoritative commit racing deletion.
      const providerCode = readAitIapProviderCode(error);
      if (providerOrderId !== undefined || grantAttempts.size > 0) {
        finish(pendingPurchase(
          providerOrderId,
          aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true, providerCode),
        ));
        return;
      }
      startMarkerDeletion(failedPurchase(
        aitIapDiagnostic(aitIapDiagnosticCodes.checkoutStartFailed, true, providerCode),
      ));
    }
  });
}

/**
 * Decides whether recovery found a reason not to open a new checkout for this
 * product. Orders for other configured products are still reconciled, but only
 * a same-product order can turn this purchase into a duplicate charge.
 */
function resolveAitIapCheckoutBarrier(
  reconciliation: AitIapPendingOrderReconciliation,
  product: NormalizedAitIapProduct,
): CommerceDiagnostic | undefined {
  if (reconciliation.status === 'unavailable') {
    return reconciliation.diagnostic.code === aitIapDiagnosticCodes.unsupportedAppVersion
      ? reconciliation.diagnostic
      : aitIapDiagnostic(
          aitIapDiagnosticCodes.pendingOrderCheckFailed,
          true,
          reconciliation.diagnostic.providerCode,
        );
  }
  if (reconciliation.unresolvedOrders.some((order) => order.sku === product.sku)) {
    return aitIapDiagnostic(
      aitIapDiagnosticCodes.pendingOrderUnresolved,
      true,
      reconciliation.diagnostic?.providerCode,
    );
  }
  if (
    reconciliation.settledPurchases.some((settlement) => settlement.productId === product.productId)
  ) {
    return aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderRecovered, true);
  }
  return undefined;
}

async function restoreAitIapProducts(
  input: AitIapRestoreInput,
): Promise<AitIapRestoreOutcome> {
  const prepare = input.prepare;
  const verifier = input.verifier;
  if (!isAitIapSupported(input) || prepare === undefined || verifier === undefined) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false),
    };
  }
  const restoreStartedAt = Date.now();
  const getRemainingRestoreTimeout = (): number => {
    return remainingAitIapOperationTimeout(restoreStartedAt, input.timeoutMs);
  };
  const prepared = await prepareAitIap(
    prepare,
    { intent: 'restore' },
    getRemainingRestoreTimeout(),
  );
  if (!prepared) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.preparationFailed, true),
    };
  }
  const postPrepareTimeoutMs = getRemainingRestoreTimeout();
  const reservedEntitlementReadTimeoutMs = Math.max(1, Math.ceil(postPrepareTimeoutMs / 3));
  const reconciliationTimeoutMs = Math.max(
    0,
    postPrepareTimeoutMs - reservedEntitlementReadTimeoutMs,
  );
  if (reconciliationTimeoutMs === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.restoreTimeout, true),
    };
  }

  const reconciliation = await input.reconcilePendingOrders(
    verifier,
    Math.min(reconciliationTimeoutMs, getRemainingRestoreTimeout()),
  );
  if (reconciliation.status === 'unavailable') {
    // Restore exists to settle paid orders. If the provider list cannot be
    // read, report that instead of an empty success the game cannot tell
    // apart from "nothing to restore".
    return { status: 'failed', diagnostic: reconciliation.diagnostic };
  }

  const authoritativeEntitlements = await readAitIapEntitlementsIfAvailable(
    input.entitlementReader,
    getRemainingRestoreTimeout(),
  );
  const { settledPurchases } = reconciliation;
  if (authoritativeEntitlements === undefined && settledPurchases.length === 0) {
    return {
      status: 'failed',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.entitlementReadFailed, true),
    };
  }
  let diagnostic: CommerceDiagnostic | undefined;
  if (authoritativeEntitlements === undefined) {
    diagnostic = aitIapDiagnostic(aitIapDiagnosticCodes.entitlementReadFailed, true);
  } else if (reconciliation.unresolvedOrders.length > 0) {
    diagnostic = aitIapDiagnostic(
      aitIapDiagnosticCodes.pendingOrderUnresolved,
      true,
      reconciliation.diagnostic?.providerCode,
    );
  }
  return {
    status: 'ok',
    result: {
      restoredEntitlements: mergeAitIapRestoredEntitlements(
        reconciliation.restoredEntitlements,
        authoritativeEntitlements ?? [],
        input.products,
      ),
      ...(settledPurchases.length === 0 ? {} : { settledPurchases }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

interface AitIapPendingOrderReconciliationInput {
  readonly dependencies: AitIapHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly verifier: AitIapProductGrantVerifier;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  readonly timeoutMs: number;
}

/**
 * Reads the provider's pending-order list and keeps the well-formed entries
 * for configured SKUs. An entry that might be a configured product's paid
 * order is never proof of absence: a malformed entry, an order id reported
 * under two SKUs, or an unreadable list fails closed as `unavailable`. Only
 * well-formed entries for other SKUs are ignored.
 */
async function readConfiguredAitIapPendingOrders(input: {
  readonly dependencies: Pick<AitIapHostDependencies, 'iap'>;
  readonly products: NormalizedAitIapProducts;
  readonly timeoutMs: number;
}): Promise<AitIapPendingOrderListing> {
  const pendingOrderTimeoutMs = input.timeoutMs;
  if (pendingOrderTimeoutMs === 0) {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
    };
  }
  const pendingOrders = await callAitIapNative(
    () =>
      joinAitIapNativeRead(input.dependencies.iap, 'getPendingOrders', () =>
        input.dependencies.iap.getPendingOrders(),
      ),
    pendingOrderTimeoutMs,
  );
  if (pendingOrders.status !== 'ok') {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(
        aitIapDiagnosticCodes.pendingOrderCheckFailed,
        true,
        pendingOrders.status === 'error' ? pendingOrders.providerCode : undefined,
      ),
    };
  }
  const pendingOrderResult: unknown = pendingOrders.value;
  if (!isRecord(pendingOrderResult)) {
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unsupportedAppVersion, false),
    };
  }
  if (!Array.isArray(pendingOrderResult.orders)) {
    // A malformed list is not proof that no paid order exists.
    return {
      status: 'unavailable',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
    };
  }
  const nativeOrders = pendingOrderResult.orders as readonly unknown[];

  const orders: AitIapConfiguredPendingOrder[] = [];
  const seenOrderIds = new Set<string>();
  const malformedPendingOrders: AitIapPendingOrderListing = {
    status: 'unavailable',
    diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
  };
  /** Provider-reported SKU per pending order id. */
  const providerSkus = new Map<string, string>();
  for (const order of nativeOrders) {
    // An entry that might be a configured product's paid order is never
    // proof of absence. Only well-formed entries for other SKUs are ignored.
    if (!isRecord(order) || typeof order.sku !== 'string') {
      return malformedPendingOrders;
    }
    if (typeof order.orderId === 'string') {
      const knownSku = providerSkus.get(order.orderId);
      if (knownSku !== undefined && knownSku !== order.sku) {
        // One order id reported with two SKUs cannot be attributed safely.
        return malformedPendingOrders;
      }
      providerSkus.set(order.orderId, order.sku);
    }
    const product = input.products.bySku.get(order.sku);
    if (product === undefined) {
      continue;
    }
    if (typeof order.orderId !== 'string' || !isAitIapOrderId(order.orderId)) {
      return malformedPendingOrders;
    }
    if (seenOrderIds.has(order.orderId)) {
      continue;
    }
    seenOrderIds.add(order.orderId);
    orders.push({
      orderId: order.orderId,
      sku: order.sku,
      paymentCompletedDate: typeof order.paymentCompletedDate === 'string'
        ? order.paymentCompletedDate
        : '',
      product,
    });
  }
  return { status: 'ok', orders, providerSkus };
}

/**
 * Verifies and acknowledges provider orders for configured SKUs that are paid
 * but not yet granted. Work is bounded per call and rotated across calls so a
 * permanently rejected order cannot starve later ones.
 */
async function reconcileAitIapPendingOrders(
  input: AitIapPendingOrderReconciliationInput,
): Promise<AitIapPendingOrderReconciliation> {
  const startedAt = Date.now();
  const getRemainingTimeout = (): number => {
    return remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  };
  const listing = await readConfiguredAitIapPendingOrders({
    dependencies: input.dependencies,
    products: input.products,
    timeoutMs: getRemainingTimeout(),
  });
  if (listing.status !== 'ok') {
    return listing;
  }
  const eligibleOrders = listing.orders.map((order) => ({
    order: {
      orderId: order.orderId,
      sku: order.sku,
      paymentCompletedDate: order.paymentCompletedDate,
    },
    product: order.product,
  }));
  const malformedPendingOrders: AitIapPendingOrderReconciliation = {
    status: 'unavailable',
    diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true),
  };
  /** Provider-reported SKU per pending order id. */
  const providerPendingOrderSkus = listing.providerSkus;

  const settledPurchases: PurchaseSettlement[] = [];
  const restoredEntitlements: Entitlement[] = [];
  const unresolvedOrders: AitIapUnresolvedOrder[] = [];
  let diagnostic: CommerceDiagnostic | undefined;

  // A barrier whose order the provider no longer lists is settled only when
  // the server confirms the grant again; otherwise it stays an unresolved
  // same-product barrier. A settled barrier is reported (keeping the
  // same-product checkout barrier for this pass) and only then dropped,
  // together with its order link. Barriers for SKUs that are no longer
  // configured are kept but not resolved here.
  const acknowledgementReadTimeoutMs = getRemainingTimeout();
  const acknowledgements = acknowledgementReadTimeoutMs === 0
    ? undefined
    : await readAitIapAcknowledgementsInFlight(
        input.dependencies.storage,
        acknowledgementReadTimeoutMs,
      );
  if (acknowledgements === undefined) {
    return malformedPendingOrders;
  }
  const confirmedAcknowledgements: AitIapAcknowledgementInFlight[] = [];
  for (const entry of acknowledgements) {
    const pendingSku = providerPendingOrderSkus.get(entry.orderId);
    if (pendingSku !== undefined) {
      if (pendingSku !== entry.sku) {
        // The provider lists this barrier's order under another product. Do
        // not let it stop guarding its own product: fail closed instead.
        return malformedPendingOrders;
      }
      continue;
    }
    const product = input.products.bySku.get(entry.sku);
    if (product === undefined) {
      continue;
    }
    // Absence alone never settles a barrier, whatever its phase: a phase
    // write can land late without a dispatch, and the list can lag. Only the
    // server confirming the grant for this order settles it.
    const verificationTimeoutMs = getRemainingTimeout();
    const confirmed = verificationTimeoutMs > 0 && await verifyAitIapProductGrant({
      verifier: input.verifier,
      orderId: entry.orderId,
      product,
      idempotencyKey: createAitIapOrderIdempotencyKey(entry.orderId),
      ...(entry.idempotencyKey === undefined
        ? {}
        : { clientIdempotencyKey: entry.idempotencyKey }),
      source: 'pending-order-restore',
      timeoutMs: verificationTimeoutMs,
    });
    if (!confirmed) {
      unresolvedOrders.push({ orderId: entry.orderId, sku: entry.sku });
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true);
      continue;
    }
    confirmedAcknowledgements.push(entry);
    settledPurchases.push({
      transactionId: entry.orderId,
      productId: product.productId,
      status: 'granted',
      ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
    });
    restoredEntitlements.push({
      id: product.productId,
      source: 'purchase',
      grantedAt: new Date().toISOString(),
    });
  }
  if (confirmedAcknowledgements.length > 0) {
    const clearTimeoutMs = getRemainingTimeout();
    if (clearTimeoutMs > 0) {
      // A failed clear only reports the same settled order again next time.
      const cleared = await removeAitIapAcknowledgementsInFlight(
        input.dependencies.storage,
        confirmedAcknowledgements.map(({ orderId }) => orderId),
        clearTimeoutMs,
      );
      if (cleared) {
        for (const { orderId } of confirmedAcknowledgements) {
          await removeAitIapOrderAttemptLink(
            input.dependencies.storage,
            orderId,
            getRemainingTimeout(),
          );
        }
      }
    }
  }

  const cursorTimeoutMs = getRemainingTimeout();
  const cursor = cursorTimeoutMs === 0
    ? undefined
    : await readAitIapPendingOrderCursor(input.dependencies.storage, cursorTimeoutMs);
  const orders = rotateAitIapPendingOrders(eligibleOrders, cursor, maximumPendingIapOrders);
  if (eligibleOrders.length > orders.length) {
    console.warn('AIT IAP pending-order restore reached its per-launch limit.', {
      limit: maximumPendingIapOrders,
      ignoredOrderCount: eligibleOrders.length - orders.length,
    });
    const selectedOrderIds = new Set(orders.map(({ order }) => order.orderId));
    for (const { order } of eligibleOrders) {
      if (!selectedOrderIds.has(order.orderId)) {
        unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      }
    }
  }

  for (const [index, selectedOrder] of orders.entries()) {
    const { order, product } = selectedOrder;
    const deferRemaining = (): void => {
      for (const deferred of orders.slice(index)) {
        unresolvedOrders.push({ orderId: deferred.order.orderId, sku: deferred.order.sku });
      }
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.restoreTimeout, true);
    };
    const cursorWriteTimeoutMs = getRemainingTimeout();
    if (cursorWriteTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const cursorAdvanced = await writeAitIapPendingOrderCursor(
      input.dependencies.storage,
      order.orderId,
      cursorWriteTimeoutMs,
    );
    if (!cursorAdvanced) {
      deferRemaining();
      break;
    }
    const linkTimeoutMs = getRemainingTimeout();
    if (linkTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const link = await readAitIapOrderAttemptLink({
      storage: input.dependencies.storage,
      product,
      orderId: order.orderId,
      timeoutMs: linkTimeoutMs,
    });
    if (link.status === 'unavailable') {
      unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true);
      continue;
    }
    const clientIdempotencyKey = link.status === 'linked' ? link.idempotencyKey : undefined;
    const verificationTimeoutMs = getRemainingTimeout();
    if (verificationTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const granted = await verifyAitIapProductGrant({
      verifier: input.verifier,
      orderId: order.orderId,
      product,
      idempotencyKey: createAitIapOrderIdempotencyKey(order.orderId),
      ...(clientIdempotencyKey === undefined ? {} : { clientIdempotencyKey }),
      source: 'pending-order-restore',
      timeoutMs: verificationTimeoutMs,
    });
    if (!granted) {
      unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true);
      continue;
    }

    if (clientIdempotencyKey !== undefined) {
      // Secure the client attempt before acknowledging: once acknowledged, the
      // order leaves the pending list and could no longer finish this marker.
      const markerTimeoutMs = getRemainingTimeout();
      const marker = markerTimeoutMs === 0
        ? 'failed'
        : await completeLinkedAitIapPurchaseAttempt({
            storage: input.dependencies.storage,
            product,
            idempotencyKey: clientIdempotencyKey,
            orderId: order.orderId,
            retainCompletedAttempt: input.retainCompletedAttempt,
            timeoutMs: markerTimeoutMs,
          });
      if (marker === 'failed') {
        unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
        diagnostic ??= aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true);
        continue;
      }
    }

    const completionTimeoutMs = getRemainingTimeout();
    if (completionTimeoutMs === 0) {
      deferRemaining();
      break;
    }
    const acknowledgement = await acknowledgeAitIapOrder({
      dependencies: input.dependencies,
      configuredSkus: input.products.bySku,
      orderId: order.orderId,
      product,
      ...(clientIdempotencyKey === undefined ? {} : { idempotencyKey: clientIdempotencyKey }),
      timeoutMs: completionTimeoutMs,
    });
    if (acknowledgement.status !== 'acknowledged') {
      // Keep provider state pending when its completion acknowledgement fails.
      unresolvedOrders.push({ orderId: order.orderId, sku: order.sku });
      diagnostic ??= acknowledgement.diagnostic;
      continue;
    }
    if (link.status === 'linked') {
      await removeAitIapOrderAttemptLink(
        input.dependencies.storage,
        order.orderId,
        getRemainingTimeout(),
      );
    }
    settledPurchases.push({
      transactionId: order.orderId,
      productId: product.productId,
      status: 'granted',
      ...(clientIdempotencyKey === undefined ? {} : { idempotencyKey: clientIdempotencyKey }),
    });
    restoredEntitlements.push({
      id: product.productId,
      source: 'purchase',
      grantedAt: normalizeAitIapGrantTime(order.paymentCompletedDate),
    });
  }

  return {
    status: 'reconciled',
    settledPurchases,
    restoredEntitlements,
    unresolvedOrders,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

/**
 * Finishes the retry barrier of the client attempt that opened a recovered
 * order, so replaying that client key reports the completed purchase instead
 * of staying pending or reopening a checkout. It runs after the server grant
 * and before the provider acknowledgement. `failed` means the marker could not
 * be read or written and the order must stay unacknowledged; `not-applicable`
 * means no marker for this order needs finishing.
 */
async function completeLinkedAitIapPurchaseAttempt(input: {
  readonly storage: AitIapHostDependencies['storage'];
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  readonly timeoutMs: number;
}): Promise<'completed' | 'not-applicable' | 'failed'> {
  const startedAt = Date.now();
  const storageKey = aitIapPurchaseAttemptStorageKey(input.product.productId, input.idempotencyKey);
  const read = await readAitIapStorage(input.storage, storageKey, input.timeoutMs);
  if (read.status !== 'ok') {
    return 'failed';
  }
  // A linked attempt without a marker would let a replay of its key open a
  // new checkout for an order that is about to be acknowledged, so write the
  // completed marker in that case too.
  if (read.value !== null) {
    let state: unknown;
    try {
      state = JSON.parse(read.value);
    } catch {
      return 'failed';
    }
    if (!isAitIapMarkerForAttempt(state, input.product, input.idempotencyKey)) {
      // A corrupted linked marker cannot be finished; keep the order pending.
      return 'failed';
    }
    if (!isLinkedAitIapAttemptMarker(state, input.orderId)) {
      return 'not-applicable';
    }
  }
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  if (remainingTimeoutMs === 0) {
    return 'failed';
  }
  const persisted = await persistAitIapPurchaseAttempt({
    storage: input.storage,
    product: input.product,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    status: aitIapPurchaseAttemptStatus.completed,
    source: 'pending-order-restore',
    timeoutMs: remainingTimeoutMs,
  });
  if (!persisted) {
    return 'failed';
  }
  void input.retainCompletedAttempt(input.storage, storageKey);
  return 'completed';
}

export interface AitIapAcknowledgementInFlight {
  readonly orderId: string;
  readonly sku: string;
  readonly idempotencyKey?: string;
  /**
   * Diagnostic only: `recorded` is written before the acknowledgement and
   * `started` right before it is dispatched. Neither phase lets the order's
   * absence settle the barrier; only a server-confirmed grant does.
   */
  readonly phase: 'recorded' | 'started';
}

type AitIapAcknowledgement =
  | { readonly status: 'acknowledged' }
  | { readonly status: 'not-acknowledged'; readonly diagnostic: CommerceDiagnostic };

/**
 * Acknowledges a server-granted order with `completeProductGrant()`. The
 * order is first recorded as in flight, so a timed-out acknowledgement that
 * succeeds later still leaves a same-product checkout barrier. The record is
 * removed after a confirmed success or a definitive rejection; after a
 * timeout it stays until reconciliation sees the order leave the provider
 * list. Without the record, the order is not acknowledged.
 */
/**
 * Native `completeProductGrant()` calls that have not settled yet, per IAP
 * dependency object and order. A retry for the same order joins the running
 * call instead of dispatching a second acknowledgement.
 */
const aitIapAcknowledgementsRunning = new WeakMap<
  object,
  Map<string, Promise<AitIapNativeOutcome<boolean>>>
>();

function dispatchAitIapAcknowledgement(
  iap: Pick<AitIapHostDependencies['iap'], 'completeProductGrant'>,
  orderId: string,
): Promise<AitIapNativeOutcome<boolean>> {
  let running = aitIapAcknowledgementsRunning.get(iap);
  if (running === undefined) {
    running = new Map();
    aitIapAcknowledgementsRunning.set(iap, running);
  }
  const existing = running.get(orderId);
  if (existing !== undefined) {
    return existing;
  }
  const calls = running;
  const call: Promise<AitIapNativeOutcome<boolean>> = Promise.resolve()
    .then(() => iap.completeProductGrant({ params: { orderId } }))
    .then(
      (value): AitIapNativeOutcome<boolean> => ({ status: 'ok', value: value === true }),
      (error: unknown): AitIapNativeOutcome<boolean> => {
        const providerCode = readAitIapProviderCode(error);
        return providerCode === undefined ? { status: 'error' } : { status: 'error', providerCode };
      },
    )
    .finally(() => {
      if (calls.get(orderId) === call) {
        calls.delete(orderId);
      }
    });
  calls.set(orderId, call);
  return call;
}

function isAitIapAcknowledgementRunning(
  iap: object,
  orderId: string,
): boolean {
  return aitIapAcknowledgementsRunning.get(iap)?.has(orderId) === true;
}

async function acknowledgeAitIapOrder(input: {
  readonly dependencies: Pick<AitIapHostDependencies, 'iap' | 'storage'>;
  /** Currently configured SKUs; other barriers do not use active capacity. */
  readonly configuredSkus: { has(sku: string): boolean };
  readonly orderId: string;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey?: string;
  readonly timeoutMs: number;
}): Promise<AitIapAcknowledgement> {
  const startedAt = Date.now();
  const remaining = (): number => remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  const barrierUnavailable: AitIapAcknowledgement = {
    status: 'not-acknowledged',
    diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true),
  };
  const storage = input.dependencies.storage;
  const entries = remaining() === 0
    ? undefined
    : await readAitIapAcknowledgementsInFlight(storage, remaining());
  if (entries === undefined) {
    return barrierUnavailable;
  }
  const iap = input.dependencies.iap;
  const existing = entries.find((entry) => entry.orderId === input.orderId);
  const otherEntries = entries.filter((entry) => entry.orderId !== input.orderId);
  const activeCount = otherEntries
    .filter((entry) => input.configuredSkus.has(entry.sku)).length;
  if (activeCount >= maximumIapAcknowledgementsInFlight) {
    return barrierUnavailable;
  }
  const retired = otherEntries.filter((entry) => !input.configuredSkus.has(entry.sku));
  const droppedRetiredOrderIds = new Set(retired
    .slice(0, Math.max(0, retired.length - maximumRetiredIapAcknowledgements))
    .map((entry) => entry.orderId));
  const others = otherEntries.filter((entry) => !droppedRetiredOrderIds.has(entry.orderId));
  // A `started` barrier stays as written: a running acknowledgement is
  // joined, and a fresh dispatch (only possible once no call is running, for
  // example after a reload) reuses the existing barrier.
  const barrierStarted = existing?.phase === 'started';
  if (!barrierStarted && isAitIapAcknowledgementRunning(iap, input.orderId)) {
    // A call is running without a durable `started` barrier; never touch it.
    return barrierUnavailable;
  }
  const withPhase = (phase: AitIapAcknowledgementInFlight['phase']): string => JSON.stringify([
    ...others,
    {
      orderId: input.orderId,
      sku: input.product.sku,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      phase,
    },
  ]);
  if (!barrierStarted) {
    // Two durable steps: the barrier first, then the dispatch mark. Only a
    // record marked `started` may later be confirmed by the order's absence.
    const recorded = remaining() > 0 && await writeAitIapStorage(
      storage,
      iapAcknowledgementsInFlightStorageKey,
      withPhase('recorded'),
      remaining(),
    );
    if (!recorded) {
      return barrierUnavailable;
    }
    const dispatchMarked = remaining() > 0 && await writeAitIapStorage(
      storage,
      iapAcknowledgementsInFlightStorageKey,
      withPhase('started'),
      remaining(),
    );
    if (!dispatchMarked) {
      return barrierUnavailable;
    }
  }
  const completionTimeoutMs = remaining();
  const completion = completionTimeoutMs === 0
    ? { status: 'timeout' as const }
    : await callAitIapNative(
        () => dispatchAitIapAcknowledgement(iap, input.orderId),
        completionTimeoutMs,
      ).then((outcome) => (outcome.status === 'ok' ? outcome.value : outcome));
  if (completion.status === 'ok' && completion.value) {
    // Only a confirmed acknowledgement clears a `started` barrier here.
    await removeAitIapAcknowledgementsInFlight(storage, [input.orderId], Math.max(1, remaining()));
    return { status: 'acknowledged' };
  }
  // A timeout, `false` or an error leaves the barrier `started`: an earlier
  // or still-running dispatch may yet succeed. The order stays unresolved
  // until a confirmed acknowledgement or the order leaving the provider list.
  if (completion.status === 'timeout') {
    return {
      status: 'not-acknowledged',
      diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.grantCompletionFailed, true),
    };
  }
  return {
    status: 'not-acknowledged',
    diagnostic: aitIapDiagnostic(
      aitIapDiagnosticCodes.grantCompletionFailed,
      true,
      completion.status === 'error' ? completion.providerCode : undefined,
    ),
  };
}

/** Returns undefined when the list cannot be read or is malformed. */
async function readAitIapAcknowledgementsInFlight(
  storage: Pick<typeof Storage, 'getItem'>,
  timeoutMs: number,
): Promise<readonly AitIapAcknowledgementInFlight[] | undefined> {
  const read = await readAitIapStorage(storage, iapAcknowledgementsInFlightStorageKey, timeoutMs);
  if (read.status !== 'ok') {
    return undefined;
  }
  if (read.value === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(read.value);
    if (!Array.isArray(value)) {
      return undefined;
    }
    const entries: AitIapAcknowledgementInFlight[] = [];
    for (const entry of value as readonly unknown[]) {
      if (
        !isRecord(entry)
        || typeof entry.orderId !== 'string'
        || !isAitIapOrderId(entry.orderId)
        || typeof entry.sku !== 'string'
        || (entry.idempotencyKey !== undefined
          && !isAitIapClientIdempotencyKey(entry.idempotencyKey))
        || (entry.phase !== 'recorded' && entry.phase !== 'started')
      ) {
        return undefined;
      }
      entries.push({
        orderId: entry.orderId,
        sku: entry.sku,
        ...(typeof entry.idempotencyKey === 'string'
          ? { idempotencyKey: entry.idempotencyKey }
          : {}),
        phase: entry.phase,
      });
    }
    return entries;
  } catch {
    return undefined;
  }
}

async function removeAitIapAcknowledgementsInFlight(
  storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
  orderIds: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  const entries = await readAitIapAcknowledgementsInFlight(storage, timeoutMs);
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, timeoutMs);
  if (entries === undefined || remainingTimeoutMs === 0) {
    return false;
  }
  const removed = new Set(orderIds);
  return await writeAitIapStorage(
    storage,
    iapAcknowledgementsInFlightStorageKey,
    JSON.stringify(entries.filter((entry) => !removed.has(entry.orderId))),
    remainingTimeoutMs,
  );
}

interface AitIapStorageKeyQueue {
  tail: Promise<void>;
  active: number;
  /**
   * Set once an operation on this key outlives a caller's deadline. Later
   * callers then fail closed immediately instead of queueing behind it, so a
   * native call that never settles cannot retain one node per retry. The
   * queue is forgotten, and the flag with it, once the stuck work settles.
   */
  hung: boolean;
}

/**
 * Per native storage object and adapter-reserved key, operations run strictly
 * one after another. Each starts only after every earlier operation on that
 * key has actually settled, not merely timed out, so a late-landing write can
 * never overwrite a newer one and a read never observes an absence that races
 * an in-flight write. A caller whose turn does not come within its deadline
 * gets `timeout` and its operation is never started. Idle keys are forgotten.
 */
const aitIapStorageQueues = new WeakMap<object, Map<string, AitIapStorageKeyQueue>>();

async function runAitIapStorageOperation<T>(
  storage: object,
  key: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<AitIapNativeOutcome<T>> {
  const startedAt = Date.now();
  let queues = aitIapStorageQueues.get(storage);
  if (queues === undefined) {
    queues = new Map();
    aitIapStorageQueues.set(storage, queues);
  }
  const keyQueues = queues;
  let queue = keyQueues.get(key);
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), active: 0, hung: false };
    keyQueues.set(key, queue);
  }
  const current = queue;
  if (current.hung) {
    return { status: 'timeout' };
  }
  const previous = current.tail;
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    let released = false;
    release = () => {
      if (released) {
        return;
      }
      released = true;
      current.active -= 1;
      if (current.active === 0 && keyQueues.get(key) === current) {
        keyQueues.delete(key);
      }
      resolve();
    };
  });
  current.active += 1;
  current.tail = previous.then(() => turn);
  const ready = await callAitIapNative(() => previous, timeoutMs);
  const remainingTimeoutMs = remainingAitIapOperationTimeout(startedAt, timeoutMs);
  if (ready.status !== 'ok' || remainingTimeoutMs === 0) {
    // Give up this turn without starting the operation. Later operations
    // still wait for the earlier ones through the tail chain.
    if (ready.status !== 'ok') {
      current.hung = true;
    }
    void previous.then(release);
    return { status: 'timeout' };
  }
  let started: Promise<T>;
  try {
    started = Promise.resolve(operation());
  } catch (error) {
    release();
    const providerCode = readAitIapProviderCode(error);
    return providerCode === undefined ? { status: 'error' } : { status: 'error', providerCode };
  }
  void started.then(release, release);
  const outcome = await callAitIapNative(() => started, remainingTimeoutMs);
  if (outcome.status === 'timeout') {
    current.hung = true;
  }
  return outcome;
}

async function readAitIapStorage(
  storage: Pick<typeof Storage, 'getItem'>,
  key: string,
  timeoutMs: number,
): Promise<AitIapNativeOutcome<string | null>> {
  const read = await runAitIapStorageOperation(storage, key, () => storage.getItem(key), timeoutMs);
  if (read.status !== 'ok') {
    return read;
  }
  const value: unknown = read.value;
  return value === null || typeof value === 'string'
    ? { status: 'ok', value }
    : { status: 'error' };
}

/**
 * The caller already validated the order link for this client key and
 * product. A pending marker without an order id is the same attempt whose
 * order-correlation write failed while the link write succeeded.
 */
function isLinkedAitIapAttemptMarker(
  state: Readonly<Record<string, unknown>>,
  orderId: string,
): boolean {
  if (state.status === aitIapPurchaseAttemptStatus.serverGranted) {
    return state.orderId === orderId;
  }
  return state.status === aitIapPurchaseAttemptStatus.pending
    && (state.orderId === orderId || state.orderId === undefined);
}

async function writeAitIapOrderAttemptLink(input: {
  readonly storage: Pick<typeof Storage, 'setItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly timeoutMs: number;
}): Promise<boolean> {
  return await writeAitIapStorage(
    input.storage,
    aitIapOrderAttemptLinkStorageKey(input.orderId),
    JSON.stringify({
      productId: input.product.productId,
      idempotencyKey: input.idempotencyKey,
    }),
    input.timeoutMs,
  );
}

type AitIapOrderAttemptLink =
  | { readonly status: 'linked'; readonly idempotencyKey: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' };

/** Best effort: a link has no recovery role once its order is terminal. */
async function removeAitIapOrderAttemptLink(
  storage: Pick<typeof Storage, 'removeItem'>,
  orderId: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs > 0) {
    await removeAitIapStorage(storage, aitIapOrderAttemptLinkStorageKey(orderId), timeoutMs);
  }
}

/**
 * Only a successful read that returns no value proves the order has no client
 * attempt link. A read also waits for any in-flight write of the same link. A failed, timed-out or unreadable link must keep the order
 * unacknowledged, or its attempt marker could later be cleared and reopen a
 * checkout for an order that was already granted.
 */
async function readAitIapOrderAttemptLink(input: {
  readonly storage: Pick<typeof Storage, 'getItem'>;
  readonly product: NormalizedAitIapProduct;
  readonly orderId: string;
  readonly timeoutMs: number;
}): Promise<AitIapOrderAttemptLink> {
  const read = await readAitIapStorage(
    input.storage,
    aitIapOrderAttemptLinkStorageKey(input.orderId),
    input.timeoutMs,
  );
  if (read.status !== 'ok') {
    return { status: 'unavailable' };
  }
  if (read.value === null) {
    return { status: 'absent' };
  }
  try {
    const link: unknown = JSON.parse(read.value);
    return isRecord(link)
      && link.productId === input.product.productId
      && isAitIapClientIdempotencyKey(link.idempotencyKey)
      ? { status: 'linked', idempotencyKey: link.idempotencyKey }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

function aitIapOrderAttemptLinkStorageKey(orderId: string): string {
  return `${iapOrderAttemptLinkStoragePrefix}${encodeURIComponent(orderId)}`;
}

function isAitIapClientIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function mergeAitIapRestoredEntitlements(
  restoredEntitlements: readonly Entitlement[],
  authoritativeEntitlements: readonly Entitlement[],
  products: NormalizedAitIapProducts,
): readonly Entitlement[] {
  const entitlementsById = new Map<string, Entitlement>();
  for (const entitlement of restoredEntitlements) {
    entitlementsById.set(entitlement.id, entitlement);
  }
  for (const entitlement of authoritativeEntitlements) {
    if (
      entitlement.source !== 'purchase'
      || !products.byProductId.has(entitlement.id as LogicalProductId)
    ) {
      continue;
    }
    entitlementsById.set(entitlement.id, entitlement);
  }
  return [...entitlementsById.values()];
}

async function prepareAitIap(
  prepare: AitIapPreparer | undefined,
  input: AitIapPreparationInput,
  timeoutMs: number,
): Promise<boolean> {
  if (prepare === undefined) {
    return false;
  }
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(false), timeoutMs);
  });
  const preparationResult = Promise.resolve()
    .then(async () => prepare(input))
    .then((result) => result === true, () => false);
  try {
    return await Promise.race([preparationResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

/**
 * The provider catalog is the authoritative source for the purchase flow. Do
 * not route an unknown or unavailable SKU into a one-time order; return why.
 */
async function checkAitOneTimeIapProduct(
  dependencies: AitIapHostDependencies,
  configured: NormalizedAitIapProduct,
  timeoutMs: number,
): Promise<CommerceDiagnostic | undefined> {
  const catalog = await readAitIapCatalog(dependencies, timeoutMs);
  if (catalog.status !== 'ok') {
    return catalog.diagnostic;
  }
  const nativeProduct = catalog.products.find(({ sku }) => sku === configured.sku);
  if (nativeProduct === undefined) {
    return aitIapDiagnostic(aitIapDiagnosticCodes.configuredSkusNotVisible, false);
  }
  return nativeProduct.type === 'CONSUMABLE' || nativeProduct.type === 'NON_CONSUMABLE'
    ? undefined
    : aitIapDiagnostic(aitIapDiagnosticCodes.productTypeUnsupported, false);
}

/**
 * Native IAP reads that have not settled yet, per IAP dependency object and
 * method. A retry while an earlier read is still running (for example a hung
 * native call) joins it instead of starting another native request, so
 * retries cannot pile up uncancelled native calls.
 */
const aitIapNativeReadsRunning = new WeakMap<object, Map<string, Promise<unknown>>>();

function joinAitIapNativeRead<T>(
  owner: object,
  method: string,
  read: () => Promise<T>,
): Promise<T> {
  let running = aitIapNativeReadsRunning.get(owner);
  if (running === undefined) {
    running = new Map();
    aitIapNativeReadsRunning.set(owner, running);
  }
  const existing = running.get(method);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }
  const reads = running;
  const call = Promise.resolve().then(read);
  const forget = (): void => {
    if (reads.get(method) === call) {
      reads.delete(method);
    }
  };
  void call.then(forget, forget);
  reads.set(method, call);
  return call;
}

/**
 * Like waitForAitIapNativeCall, but keeps a timeout, a thrown provider error
 * and a resolved `undefined` (an unsupported Toss app) distinguishable.
 */
async function callAitIapNative<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<AitIapNativeOutcome<T>> {
  const timedOut = Symbol('timed-out');
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<typeof timedOut>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    const value = await Promise.race([operation(), timeoutResult]);
    return value === timedOut ? { status: 'timeout' } : { status: 'ok', value: value as T };
  } catch (error) {
    const providerCode = readAitIapProviderCode(error);
    return providerCode === undefined ? { status: 'error' } : { status: 'error', providerCode };
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function waitForAitIapNativeCall<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<undefined>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const operationResult = operation();
    return await Promise.race([operationResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function verifyAitIapProductGrant(input: {
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderId: string;
  readonly product: NormalizedAitIapProduct;
  readonly idempotencyKey: string;
  readonly clientIdempotencyKey?: string;
  readonly source: AitIapGrantSource;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort();
      resolve(false);
    }, input.timeoutMs);
  });
  const verifierResult = Promise.resolve()
    .then(async () => input.verifier({
      orderId: input.orderId,
      productId: input.product.productId,
      platformSku: input.product.sku,
      idempotencyKey: input.idempotencyKey,
      ...(input.clientIdempotencyKey === undefined
        ? {}
        : { clientIdempotencyKey: input.clientIdempotencyKey }),
      source: input.source,
      purchasedAt: new Date().toISOString(),
      signal: controller.signal,
      timeoutMs: input.timeoutMs,
    }))
    .then((result) => result === true, () => false);
  try {
    return await Promise.race([verifierResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

function completedAitIapPurchase(
  product: NormalizedAitIapProduct,
  orderId: string,
  source: AitIapGrantSource = 'process-product-grant',
): PurchaseResult {
  return {
    status: 'completed',
    transactionId: orderId,
    entitlementIds: [product.productId],
    evidence: createAitIapEvidence(orderId, product.sku, source),
  };
}

function failedPurchase(diagnostic?: CommerceDiagnostic): PurchaseResult {
  return {
    status: 'failed',
    entitlementIds: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function cancelledPurchase(): PurchaseResult {
  return { status: 'cancelled', entitlementIds: [] };
}

function pendingPurchase(
  transactionId?: string,
  diagnostic?: CommerceDiagnostic,
): PurchaseResult {
  return {
    status: 'pending',
    ...(transactionId === undefined ? {} : { transactionId }),
    entitlementIds: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function aitIapDiagnostic(
  code: AitIapDiagnosticCode,
  retryable: boolean,
  providerCode?: string,
): CommerceDiagnostic {
  return {
    code,
    retryable,
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}

export function createAitIapDiagnosticError(
  id: string,
  diagnostic: CommerceDiagnostic,
  summary: string,
): BridgeResponse {
  const providerDetail = diagnostic.providerCode === undefined
    ? ''
    : `; provider code ${diagnostic.providerCode}`;
  return createBridgeError(
    id,
    diagnostic.code,
    `${summary} (${diagnostic.code}${providerDetail}).`,
    diagnostic.retryable,
  );
}

/**
 * Native SDK codes that may be recognized in error text when the SDK does not
 * attach a structured code. Nothing else is ever read from a message.
 */
const aitIapKnownMessageProviderCodes: readonly string[] = [aitIapProductNotGrantedByPartnerCode];

/**
 * Reads a native SDK error code from structured `code`/`errorCode` fields.
 * Free-form error text can contain order or account identifiers, so it is
 * only checked for an exact, allowlisted SDK code.
 */
function readAitIapProviderCode(error: unknown): string | undefined {
  if (isRecord(error)) {
    for (const candidate of [error.code, error.errorCode]) {
      if (isAitIapProviderCode(candidate)) {
        return candidate;
      }
    }
  }
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  const tokens = new Set(message.split(/[^A-Z0-9_]+/u));
  return aitIapKnownMessageProviderCodes.find((code) => tokens.has(code));
}

function isAitIapProviderCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(value);
}

export function createAitIapEvidence(
  orderId: string,
  sku: string,
  source: AitIapGrantSource,
): PlatformEvidenceEnvelope {
  return {
    schema: iapEvidenceSchema,
    payload: { orderId, sku, source },
  };
}

export function createAitIapOrderIdempotencyKey(orderId: string): string {
  return `apps-in-toss:purchase:${encodeURIComponent(orderId)}`;
}

function createAitIapPurchaseRequestKey(
  productId: LogicalProductId,
  idempotencyKey: string,
): string {
  return `${encodeURIComponent(productId)}:${encodeURIComponent(idempotencyKey)}`;
}

function safelyCleanupAitIapPurchase(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // The bridge has already reached a terminal result; cleanup failures must
    // not turn a completed server grant into a client-visible failure.
  }
}

export function isAitIapOrderId(value: string): boolean {
  return value.length > 0 && value.length <= 2_048 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isAitIapCancellation(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (!isRecord(error)) {
    return false;
  }
  const code = typeof error.code === 'string' ? error.code : '';
  return /CANCEL|ABORT/u.test(code);
}

export function normalizeAitIapGrantTime(value: string): string {
  if (value.length === 0 || value.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function toAitIapProductInfo(
  nativeProduct: IapProductListItem,
  configured: NormalizedAitIapProduct,
): ProductInfo | undefined {
  const title = normalizeAitIapDisplayText(nativeProduct.displayName);
  const description = normalizeAitIapDisplayText(nativeProduct.description);
  const formattedPrice = normalizeAitIapDisplayText(nativeProduct.displayAmount);
  if (title === undefined || description === undefined || formattedPrice === undefined) {
    return undefined;
  }

  if (nativeProduct.type === 'SUBSCRIPTION') {
    // Subscription creation, renewal, and expiry need a different native and
    // server-authority lifecycle. This bridge only owns one-time orders.
    console.warn('AIT subscription IAP is unavailable through the one-time order bridge.', {
      productId: configured.productId,
      sku: nativeProduct.sku,
    });
    return undefined;
  }

  let type: ProductInfo['type'] | undefined;
  if (nativeProduct.type === 'CONSUMABLE') {
    type = 'consumable';
  } else if (nativeProduct.type === 'NON_CONSUMABLE') {
    type = 'non_consumable';
  }
  if (type === undefined) {
    console.warn('AIT native IAP product has an unsupported type; hiding product.', {
      productId: configured.productId,
      sku: nativeProduct.sku,
      nativeType: nativeProduct.type,
    });
    return undefined;
  }
  return {
    id: configured.productId,
    type,
    title,
    description,
    price: {
      formatted: formattedPrice,
      currencyCode: configured.currencyCode,
    },
  };
}

function normalizeAitIapDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 2_048 && !/[\p{Cc}\p{Cf}]/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizeIapProducts(
  input: readonly AitIapProductConfig[] | undefined,
): NormalizedAitIapProducts {
  const byProductId = new Map<LogicalProductId, NormalizedAitIapProduct>();
  const bySku = new Map<string, NormalizedAitIapProduct>();
  for (const rawProduct of input ?? []) {
    const productId = typeof rawProduct.productId === 'string'
      ? normalizeAitIapConfigIdentifier(rawProduct.productId, 'productId', 128)
      : undefined;
    const sku = typeof rawProduct.sku === 'string'
      ? normalizeAitIapConfigIdentifier(rawProduct.sku, 'sku', 2_048)
      : undefined;
    const currencyCode = normalizeAitIapCurrencyCode(rawProduct.currencyCode);
    if (productId === undefined || sku === undefined || currencyCode === undefined) {
      console.warn('AIT IAP product configuration is invalid; disabling one product.', {
        productId: rawProduct.productId,
        sku: rawProduct.sku,
      });
      continue;
    }
    if (byProductId.has(productId) || bySku.has(sku)) {
      console.warn(
        'AIT IAP product configuration has a duplicate product id or SKU; disabling one product.',
        { productId, sku },
      );
      continue;
    }
    const product: NormalizedAitIapProduct = {
      productId: productId as LogicalProductId,
      sku,
      currencyCode,
    };
    byProductId.set(product.productId, product);
    bySku.set(product.sku, product);
  }
  return { byProductId, bySku };
}

function normalizeAitIapConfigIdentifier(
  value: string,
  field: string,
  maximumLength: number,
): string | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maximumLength
    || /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeAitIapCurrencyCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase() ?? 'KRW';
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

export function isAitNativeMethodSupported(method: AitCapabilityProbe): boolean {
  return isCapabilitySupported(() => method.isSupported?.() === true);
}

export function isCapabilitySupported(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch (error) {
    // Older hosts and local wrappers may not expose a native support constant yet.
    // Missing capability metadata must disable the feature instead of blocking startup.
    console.debug('AIT capability support check failed; disabling the feature.', error);
    return false;
  }
}

function normalizeIapProductGrantTimeout(value: number | undefined): number {
  const timeout = normalizePositiveTimeout(
    value,
    defaultIapProductGrantTimeoutMs,
    'AIT IAP product-grant timeout must be a positive finite number.',
  );
  if (timeout > defaultIapProductGrantTimeoutMs) {
    throw new Error(
      `AIT IAP product-grant timeout cannot exceed ${defaultIapProductGrantTimeoutMs}ms.`,
    );
  }
  return timeout;
}

export function normalizePositiveTimeout(
  value: number | undefined,
  defaultValue: number,
  message: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizePendingSince(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

// IAP controller: the per-bridge orchestration the v1 host bridge and the v2
// provider share. One controller owns the in-flight purchase coalescing map and
// the completed-attempt retention queue; the single IAP lock is module scoped
// (see `aitIapExclusiveOperations`) so every controller built on the same
// native IAP dependency shares it.

/**
 * Native IAP dependency objects whose single IAP lock is held. Module scoped
 * so that two bridges on the same native SDK, for example after the host
 * bridge is reinstalled while an old request is still active, share it.
 */
const aitIapExclusiveOperations = new WeakSet<object>();

/** The native IAP and storage objects the purchase machinery runs on. */
export interface AitIapHostDependencies {
  readonly storage: Pick<typeof Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly iap: AitIapDependencies;
}

export interface AitIapControllerOptions {
  readonly dependencies: AitIapHostDependencies;
  /** Enable IAP only with logical-to-native SKU mappings and both server hooks. */
  readonly iapProducts?: readonly AitIapProductConfig[] | undefined;
  readonly prepareIap?: AitIapPreparer | undefined;
  readonly verifyIapProductGrant?: AitIapProductGrantVerifier | undefined;
  /** Required to expose native IAP so ownership survives a wrapper restart. */
  readonly readIapEntitlements?: AitIapEntitlementReader | undefined;
  /** May be shortened, but never extended beyond the native callback-safe default. */
  readonly iapProductGrantTimeoutMs?: number | undefined;
}

export interface AitIapPurchaseOptions {
  /**
   * Observes the pre-checkout pending-order reconciliation of this attempt,
   * whether or not a checkout opens afterwards. Orders it settled were
   * granted by the server and acknowledged to the provider.
   */
  readonly onPendingOrdersReconciled?: (
    reconciliation: AitIapPendingOrderReconciliation,
  ) => void;
}

export type AitIapReconciledPendingOrders = Extract<
  AitIapPendingOrderReconciliation,
  { readonly status: 'reconciled' }
>;

export type AitIapRecoveryOutcome =
  | { readonly status: 'reconciled'; readonly reconciliation: AitIapReconciledPendingOrders }
  | { readonly status: 'failed'; readonly diagnostic: CommerceDiagnostic };

export type AitIapEntitlementReadOutcome =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'ok'; readonly entitlements: readonly Entitlement[] }
  | { readonly status: 'failed' };

export interface AitIapConfiguredPendingOrder {
  readonly orderId: string;
  readonly sku: string;
  readonly paymentCompletedDate: string;
  readonly product: NormalizedAitIapProduct;
}

export type AitIapPendingOrderListing =
  | {
      readonly status: 'ok';
      /** Well-formed, de-duplicated orders for configured SKUs, in provider order. */
      readonly orders: readonly AitIapConfiguredPendingOrder[];
      /** Provider-reported SKU per pending order id, configured or not. */
      readonly providerSkus: ReadonlyMap<string, string>;
    }
  | { readonly status: 'unavailable'; readonly diagnostic: CommerceDiagnostic };

export type AitIapOrderFinishOutcome =
  | {
      readonly status: 'finished';
      /** `acknowledged`: `completeProductGrant()` confirmed; `already-finished`: the host no longer lists the order. */
      readonly how: 'acknowledged' | 'already-finished';
    }
  | { readonly status: 'unfinished'; readonly diagnostic: CommerceDiagnostic };

export interface AitIapFinishOrderInput {
  readonly orderId: string;
  /** The product the caller reported the order for; resolved from the provider's list when absent. */
  readonly product?: NormalizedAitIapProduct | undefined;
}

export interface AitIapController {
  readonly dependencies: AitIapHostDependencies;
  readonly products: NormalizedAitIapProducts;
  /** The native callback-safe deadline every IAP operation is bounded by. */
  readonly timeoutMs: number;
  /** Products, both server hooks, the entitlement reader and the four native methods are present. */
  isSupported(): boolean;
  /** The running Toss app exposes the four native IAP methods. */
  areNativeMethodsSupported(): boolean;
  listProducts(): Promise<AitIapCatalogOutcome<readonly ProductInfo[]>>;
  /** The v1 `commerce.purchase` flow: markers, the IAP lock, the checkout barrier and the grant callback. */
  purchase(
    productId: LogicalProductId,
    idempotencyKey: string,
    options?: AitIapPurchaseOptions,
  ): Promise<PurchaseResult>;
  /** The v1 `commerce.restore` flow, including the entitlement read. */
  restore(): Promise<AitIapRestoreOutcome>;
  /** The v1 `commerce.getEntitlements` read. */
  readEntitlements(): Promise<AitIapEntitlementReadOutcome>;
  /** Pending-order recovery alone: prepare, then verify and acknowledge paid orders under the IAP lock. */
  recoverPendingOrders(): Promise<AitIapRecoveryOutcome>;
  /** Reads the provider's pending-order list without taking the IAP lock. */
  readPendingOrders(): Promise<AitIapPendingOrderListing>;
  /** Orders whose server grant exists but whose acknowledgement was not confirmed; `undefined` when unreadable. */
  readAcknowledgementsInFlight(): Promise<readonly AitIapAcknowledgementInFlight[] | undefined>;
  /**
   * Finishes a server-granted order on the host: acknowledges it with
   * `completeProductGrant()` while the provider still lists it, and settles
   * its barrier and link once the provider no longer does. Callers hold a
   * ledger grant for the order; this never verifies or grants anything.
   */
  finishOrder(input: AitIapFinishOrderInput): Promise<AitIapOrderFinishOutcome>;
}

export function createAitIapController(options: AitIapControllerOptions): AitIapController {
  const { dependencies } = options;
  const iapProducts = normalizeIapProducts(options.iapProducts);
  const iapProductGrantTimeoutMs = normalizeIapProductGrantTimeout(
    options.iapProductGrantTimeoutMs,
  );
  const iapPurchasesInFlight = new Map<string, Promise<PurchaseResult>>();
  /**
   * The single IAP lock, shared by every bridge built on the same native IAP
   * dependency (see `aitIapExclusiveOperations`). A purchase holds it from
   * its attempt-marker check until its checkout reaches a terminal result,
   * and a restore holds it from before preparation until reconciliation and
   * the entitlement read finish. Only one of them may read, verify or
   * acknowledge provider orders or change attempt markers at a time; the
   * other gets `AIT_IAP_CHECKOUT_IN_PROGRESS` and nothing is charged.
   */
  const iapLockOwner: object = dependencies.iap;
  let completedIapAttemptRetention = Promise.resolve();

  const supportInput = (): AitIapSupportInput => ({
    dependencies,
    products: iapProducts,
    prepare: options.prepareIap,
    verifier: options.verifyIapProductGrant,
    entitlementReader: options.readIapEntitlements,
    timeoutMs: iapProductGrantTimeoutMs,
  });

  const enqueueCompletedIapAttemptRetention = (
    storage: Pick<typeof Storage, 'getItem' | 'setItem'>,
    storageKey: string,
  ): Promise<void> => {
    const scheduled = completedIapAttemptRetention.then(async () => {
      await retainCompletedAitIapPurchaseAttempt(storage, storageKey, iapProductGrantTimeoutMs);
    });
    const next = scheduled.then(
      () => undefined,
      () => undefined,
    );
    void next;
    void (completedIapAttemptRetention = next);
    return next;
  };

  /** Callers must hold the single IAP lock for the whole pass. */
  const reconcilePendingIapOrders = async (
    verifier: AitIapProductGrantVerifier,
    timeoutMs: number,
  ): Promise<AitIapPendingOrderReconciliation> => {
    return await reconcileAitIapPendingOrders({
      dependencies,
      products: iapProducts,
      verifier,
      retainCompletedAttempt: enqueueCompletedIapAttemptRetention,
      timeoutMs,
    });
  };

  return {
    dependencies,
    products: iapProducts,
    timeoutMs: iapProductGrantTimeoutMs,
    isSupported: () => isAitIapSupported(supportInput()),
    areNativeMethodsSupported: () => areAitIapNativeMethodsSupported(dependencies),
    listProducts: () => listAitIapProducts(supportInput()),

    async purchase(productId, idempotencyKey, purchaseOptions = {}) {
      const product = iapProducts.byProductId.get(productId);
      const prepareIap = options.prepareIap;
      const verifyIapProductGrant = options.verifyIapProductGrant;
      const iapSupported = isAitIapSupported(supportInput());
      if (
        !iapSupported
        || prepareIap === undefined
        || verifyIapProductGrant === undefined
      ) {
        return failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false));
      }
      if (product === undefined) {
        return failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.productNotConfigured, false));
      }

      const purchaseRequestKey = createAitIapPurchaseRequestKey(productId, idempotencyKey);
      const existing = iapPurchasesInFlight.get(purchaseRequestKey);
      if (existing !== undefined) {
        return await existing;
      }
      // Check and claim the single IAP lock synchronously, before reading
      // the attempt marker: a restore or another key must not reconcile,
      // acknowledge or clear markers while this attempt decides whether to
      // open a checkout or while its grant callback is active.
      if (aitIapExclusiveOperations.has(iapLockOwner)) {
        return failedPurchase(aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true));
      }
      aitIapExclusiveOperations.add(iapLockOwner);
      const observeReconciliation = purchaseOptions.onPendingOrdersReconciled;
      const pending = (async (): Promise<PurchaseResult> => {
        const persisted = await resolvePersistedAitIapPurchaseAttempt({
          dependencies,
          storage: dependencies.storage,
          product,
          idempotencyKey,
          timeoutMs: iapProductGrantTimeoutMs,
        });
        if (persisted !== undefined) {
          return persisted;
        }
        const productUnavailable = await checkAitOneTimeIapProduct(
          dependencies,
          product,
          iapProductGrantTimeoutMs,
        );
        if (productUnavailable !== undefined) {
          return failedPurchase(productUnavailable);
        }
        return await purchaseAitIapProduct({
          dependencies,
          products: iapProducts,
          product,
          idempotencyKey,
          prepare: prepareIap,
          verifier: verifyIapProductGrant,
          retainCompletedAttempt: enqueueCompletedIapAttemptRetention,
          reconcilePendingOrders: async (timeoutMs) => {
            const reconciliation = await reconcilePendingIapOrders(
              verifyIapProductGrant,
              timeoutMs,
            );
            if (observeReconciliation !== undefined) {
              try {
                observeReconciliation(reconciliation);
              } catch (error) {
                // An observer is a listener; its failure must not change the purchase.
                console.warn('AIT IAP reconciliation observer failed.', errorMessage(error));
              }
            }
            return reconciliation;
          },
          timeoutMs: iapProductGrantTimeoutMs,
        });
      })();
      iapPurchasesInFlight.set(purchaseRequestKey, pending);
      try {
        return await pending;
      } finally {
        aitIapExclusiveOperations.delete(iapLockOwner);
        if (iapPurchasesInFlight.get(purchaseRequestKey) === pending) {
          iapPurchasesInFlight.delete(purchaseRequestKey);
        }
      }
    },

    async restore() {
      // Claimed before preparation and held until restore finishes, so a
      // purchase cannot start a checkout while restore is still preparing.
      if (aitIapExclusiveOperations.has(iapLockOwner)) {
        return {
          status: 'failed',
          diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true),
        };
      }
      aitIapExclusiveOperations.add(iapLockOwner);
      try {
        return await restoreAitIapProducts({
          ...supportInput(),
          reconcilePendingOrders: reconcilePendingIapOrders,
        });
      } finally {
        aitIapExclusiveOperations.delete(iapLockOwner);
      }
    },

    async readEntitlements() {
      if (options.readIapEntitlements === undefined) {
        return { status: 'unconfigured' };
      }
      // A failed or timed-out authority read is not proof of no ownership.
      const entitlements = await readAitIapEntitlementsIfAvailable(
        options.readIapEntitlements,
        iapProductGrantTimeoutMs,
      );
      return entitlements === undefined ? { status: 'failed' } : { status: 'ok', entitlements };
    },

    async recoverPendingOrders() {
      const prepare = options.prepareIap;
      const verifier = options.verifyIapProductGrant;
      if (!isAitIapSupported(supportInput()) || prepare === undefined || verifier === undefined) {
        return {
          status: 'failed',
          diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false),
        };
      }
      if (aitIapExclusiveOperations.has(iapLockOwner)) {
        return {
          status: 'failed',
          diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true),
        };
      }
      aitIapExclusiveOperations.add(iapLockOwner);
      try {
        const startedAt = Date.now();
        const prepared = await prepareAitIap(prepare, { intent: 'restore' }, iapProductGrantTimeoutMs);
        if (!prepared) {
          return {
            status: 'failed',
            diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.preparationFailed, true),
          };
        }
        const reconciliationTimeoutMs = remainingAitIapOperationTimeout(
          startedAt,
          iapProductGrantTimeoutMs,
        );
        if (reconciliationTimeoutMs === 0) {
          return {
            status: 'failed',
            diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.restoreTimeout, true),
          };
        }
        const reconciliation = await reconcilePendingIapOrders(verifier, reconciliationTimeoutMs);
        return reconciliation.status === 'unavailable'
          ? { status: 'failed', diagnostic: reconciliation.diagnostic }
          : { status: 'reconciled', reconciliation };
      } finally {
        aitIapExclusiveOperations.delete(iapLockOwner);
      }
    },

    readPendingOrders: () =>
      readConfiguredAitIapPendingOrders({
        dependencies,
        products: iapProducts,
        timeoutMs: iapProductGrantTimeoutMs,
      }),

    readAcknowledgementsInFlight: () =>
      readAitIapAcknowledgementsInFlight(dependencies.storage, iapProductGrantTimeoutMs),

    async finishOrder(input) {
      const verifier = options.verifyIapProductGrant;
      if (!isAitIapSupported(supportInput()) || verifier === undefined) {
        return {
          status: 'unfinished',
          diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.unavailable, false),
        };
      }
      // Acknowledging and settling barriers are IAP operations like any other:
      // they wait for a running purchase or restore instead of racing it.
      if (aitIapExclusiveOperations.has(iapLockOwner)) {
        return {
          status: 'unfinished',
          diagnostic: aitIapDiagnostic(aitIapDiagnosticCodes.checkoutInProgress, true),
        };
      }
      aitIapExclusiveOperations.add(iapLockOwner);
      try {
        return await finishAitIapOrder({
          dependencies,
          products: iapProducts,
          verifier,
          orderId: input.orderId,
          product: input.product,
          retainCompletedAttempt: enqueueCompletedIapAttemptRetention,
          timeoutMs: iapProductGrantTimeoutMs,
        });
      } finally {
        aitIapExclusiveOperations.delete(iapLockOwner);
      }
    },
  };
}

function areAitIapNativeMethodsSupported(dependencies: Pick<AitIapHostDependencies, 'iap'>): boolean {
  return isAitNativeMethodSupported(dependencies.iap.createOneTimePurchaseOrder)
    && isAitNativeMethodSupported(dependencies.iap.getProductItemList)
    && isAitNativeMethodSupported(dependencies.iap.getPendingOrders)
    && isAitNativeMethodSupported(dependencies.iap.completeProductGrant);
}

/**
 * Host-side finish of a server-granted order (commerce v2
 * `lifecycle.finish: 'host'`). The caller holds a ledger grant, but the game
 * side of the bridge is not trusted to say so: like the restore pass, this
 * confirms the grant for the order through `verifyIapProductGrant` before
 * anything is acknowledged or settled. That hook must therefore be idempotent
 * per order (`apps-in-toss:purchase:<orderId>` is its grant identity, as the
 * v1 restore pass already requires) and reachable from a v2-only integration;
 * a hook that refuses a grant the backend already holds leaves the order
 * unfinished and the reconciler record in `finishing`. While the
 * provider lists the order, the linked client attempt is marked completed
 * first, so a replay of its key cannot reopen a checkout for an order that is
 * about to leave the pending list, and only then is `completeProductGrant()`
 * dispatched through the acknowledgement barrier. An order the provider no
 * longer lists was finished by the host already (the SDK completes an order
 * itself after a successful grant callback, and an earlier acknowledgement may
 * have landed after its deadline): a barrier such an acknowledgement left
 * behind is settled by the confirmed grant, never by absence alone, and an
 * order without a barrier leaves storage untouched. An order the provider
 * lists under another product is never acknowledged for this one.
 */
async function finishAitIapOrder(input: {
  readonly dependencies: AitIapHostDependencies;
  readonly products: NormalizedAitIapProducts;
  readonly verifier: AitIapProductGrantVerifier;
  readonly orderId: string;
  readonly product?: NormalizedAitIapProduct | undefined;
  readonly retainCompletedAttempt: AitIapCompletedAttemptRetention;
  readonly timeoutMs: number;
}): Promise<AitIapOrderFinishOutcome> {
  const startedAt = Date.now();
  const remaining = (): number => remainingAitIapOperationTimeout(startedAt, input.timeoutMs);
  const storage = input.dependencies.storage;
  const unfinished = (diagnostic: CommerceDiagnostic): AitIapOrderFinishOutcome => ({
    status: 'unfinished',
    diagnostic,
  });
  const storageUnavailable = (): AitIapOrderFinishOutcome =>
    unfinished(aitIapDiagnostic(aitIapDiagnosticCodes.attemptStorageUnavailable, true));
  const confirmGrant = async (
    product: NormalizedAitIapProduct,
    clientIdempotencyKey: string | undefined,
  ): Promise<boolean> => {
    const verificationTimeoutMs = remaining();
    return verificationTimeoutMs > 0 && await verifyAitIapProductGrant({
      verifier: input.verifier,
      orderId: input.orderId,
      product,
      idempotencyKey: createAitIapOrderIdempotencyKey(input.orderId),
      ...(clientIdempotencyKey === undefined ? {} : { clientIdempotencyKey }),
      source: 'pending-order-restore',
      timeoutMs: verificationTimeoutMs,
    });
  };

  const listing = await readConfiguredAitIapPendingOrders({
    dependencies: input.dependencies,
    products: input.products,
    timeoutMs: remaining(),
  });
  if (listing.status !== 'ok') {
    return unfinished(listing.diagnostic);
  }
  const listed = listing.orders.find((order) => order.orderId === input.orderId);
  const listedSku = listing.providerSkus.get(input.orderId);
  if (
    (listedSku !== undefined && input.product !== undefined && listedSku !== input.product.sku)
    || (listedSku !== undefined && listed === undefined)
  ) {
    // The provider lists this order under another product, configured or
    // not: never acknowledge it for this one, and never call it finished.
    return unfinished(aitIapDiagnostic(aitIapDiagnosticCodes.pendingOrderCheckFailed, true));
  }

  if (listed === undefined) {
    const acknowledgements = remaining() === 0
      ? undefined
      : await readAitIapAcknowledgementsInFlight(storage, remaining());
    if (acknowledgements === undefined) {
      return storageUnavailable();
    }
    const barrier = acknowledgements.find((entry) => entry.orderId === input.orderId);
    if (barrier === undefined) {
      // Nothing to acknowledge and nothing to settle: the host finished it.
      return { status: 'finished', how: 'already-finished' };
    }
    const product = input.products.bySku.get(barrier.sku) ?? input.product;
    if (product === undefined || !await confirmGrant(product, barrier.idempotencyKey)) {
      // Absence alone never settles a barrier: only the server confirming
      // the grant for this order does.
      return unfinished(aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true));
    }
    const cleared = remaining() > 0
      && await removeAitIapAcknowledgementsInFlight(storage, [input.orderId], remaining());
    if (!cleared) {
      return storageUnavailable();
    }
    await removeAitIapOrderAttemptLink(storage, input.orderId, remaining());
    return { status: 'finished', how: 'already-finished' };
  }

  // The provider's own listing names the product the order is paid for.
  const product = listed.product;
  const link = remaining() === 0
    ? { status: 'unavailable' as const }
    : await readAitIapOrderAttemptLink({
        storage,
        product,
        orderId: input.orderId,
        timeoutMs: remaining(),
      });
  if (link.status === 'unavailable') {
    return storageUnavailable();
  }
  const clientIdempotencyKey = link.status === 'linked' ? link.idempotencyKey : undefined;
  if (!await confirmGrant(product, clientIdempotencyKey)) {
    // The server has not confirmed this order's grant: keep it pending and
    // unacknowledged, whatever the caller claims.
    return unfinished(aitIapDiagnostic(aitIapDiagnosticCodes.grantPending, true));
  }
  if (clientIdempotencyKey !== undefined) {
    // Secure the client attempt before acknowledging: once acknowledged, the
    // order leaves the pending list and could no longer finish this marker.
    const markerTimeoutMs = remaining();
    const marker = markerTimeoutMs === 0
      ? 'failed'
      : await completeLinkedAitIapPurchaseAttempt({
          storage,
          product,
          idempotencyKey: clientIdempotencyKey,
          orderId: input.orderId,
          retainCompletedAttempt: input.retainCompletedAttempt,
          timeoutMs: markerTimeoutMs,
        });
    if (marker === 'failed') {
      return storageUnavailable();
    }
  }
  const completionTimeoutMs = remaining();
  if (completionTimeoutMs === 0) {
    return unfinished(aitIapDiagnostic(aitIapDiagnosticCodes.grantCompletionFailed, true));
  }
  const acknowledgement = await acknowledgeAitIapOrder({
    dependencies: input.dependencies,
    configuredSkus: input.products.bySku,
    orderId: input.orderId,
    product,
    ...(clientIdempotencyKey === undefined ? {} : { idempotencyKey: clientIdempotencyKey }),
    timeoutMs: completionTimeoutMs,
  });
  if (acknowledgement.status !== 'acknowledged') {
    return unfinished(acknowledgement.diagnostic);
  }
  if (link.status === 'linked') {
    await removeAitIapOrderAttemptLink(storage, input.orderId, remaining());
  }
  return { status: 'finished', how: 'acknowledged' };
}

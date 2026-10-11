import typia, { type tags } from 'typia';

import {
  PlatformOperationError,
  readPlatformOperationFailure,
  type CommerceAdapter,
  type CommerceCapabilities,
  type CommerceDiagnostic,
  type LogicalProductId,
  type PlatformEvidenceEnvelope,
  type ProductInfo,
  type ProductType,
  type PurchaseRestoreResult,
  type PurchaseResult,
  type PurchaseSettlement,
} from './index.js';

export type {
  CommerceAccountBindingPolicy,
  CommerceAuthorityCapabilities,
  CommerceCapabilities,
  CommerceCatalogCapabilities,
  CommerceEvidenceAuthority,
  CommerceFinishOwner,
  CommerceLifecycleCapabilities,
  CommercePurchaseCapabilities,
} from './index.js';

/**
 * Commerce v2 client contract. Pure types, validators, and helpers only: no
 * provider lives here, and nothing in this module grants a purchase. The
 * contract is described by docs/specs/commerce/commerce-v2-rfc.md and is a
 * draft until the protocol version is released as 2.0.0.
 */
export const commerceProtocolVersion = '2.0.0-draft.1' as const;
export const commerceProtocol = 'mpgd.commerce.v2' as const;

type NonEmptyString = string & tags.MinLength<1>;
type IsoTimestamp = string & tags.Format<'date-time'>;
type PositiveQuantity = number & tags.Type<'uint32'> & tags.Minimum<1>;
type NonNegativeInteger = number & tags.Type<'uint32'>;

/**
 * Open store identifier. Reference providers use 'google-play', 'app-store',
 * 'microsoft-store', 'apps-in-toss', 'devvit', and 'verse8'; a consuming
 * project adds its own, for example a credit wallet id.
 */
export type StoreId = NonEmptyString;

export type PurchaseKind = 'consumable' | 'durable' | 'subscription';

export interface StorePrice {
  readonly formatted: string;
  /** ISO 4217 code or a project-declared code such as a wallet currency. */
  readonly currencyCode: NonEmptyString;
  readonly amountMicros?: number & tags.Type<'int64'>;
}

export interface StoreOffer {
  readonly offerId: NonEmptyString;
  readonly price: StorePrice;
  readonly title?: string;
  readonly description?: string;
}

export interface StoreProduct {
  readonly logicalId: LogicalProductId;
  readonly store: StoreId;
  readonly storeSku: NonEmptyString;
  readonly kind: PurchaseKind;
  readonly title: string;
  readonly description: string;
  readonly price: StorePrice;
  readonly offers?: readonly StoreOffer[];
}

export type StorePurchaseState = 'pending' | 'purchased' | 'revoked';

export interface StorePurchaseAccountBinding {
  readonly kind: 'obfuscated-account-id' | 'app-account-token' | 'host-identity';
  readonly value?: string;
}

export interface StorePurchase {
  readonly store: StoreId;
  /** Store transaction id; a provider derives one when the store has none. */
  readonly transactionId: NonEmptyString;
  readonly originalTransactionId?: NonEmptyString;
  readonly storeSku: NonEmptyString;
  readonly logicalId?: LogicalProductId;
  readonly quantity: PositiveQuantity;
  readonly state: StorePurchaseState;
  readonly purchasedAt?: IsoTimestamp;
  /** Play purchase token, App Store signed transaction (JWS), or host order id. */
  readonly token: NonEmptyString;
  readonly evidence: PlatformEvidenceEnvelope;
  readonly accountBinding?: StorePurchaseAccountBinding;
  /** Present only for `authority.evidence: 'adapter-settled'`; a reconciler pointer, not a grant. */
  readonly settlement?: { readonly ledgerEntryId: NonEmptyString };
}

export type PurchaseSource = 'shop' | 'stage_fail' | 'result' | 'event';

export interface RequestPurchaseInput {
  readonly logicalId: LogicalProductId;
  readonly idempotencyKey: NonEmptyString;
  readonly source: PurchaseSource;
  readonly offerId?: NonEmptyString;
  /** Integer >= 1. Rejected with ITEM_UNAVAILABLE when the provider does not declare `purchase.quantity`. */
  readonly quantity?: PositiveQuantity;
}

export type RequestPurchaseResult =
  | { readonly outcome: 'launched' }
  | { readonly outcome: 'purchased'; readonly purchase: StorePurchase }
  | { readonly outcome: 'cancelled' | 'failed'; readonly error: CommerceErrorInfo };

export type CommerceErrorCode =
  | 'USER_CANCELLED'
  | 'OUTCOME_UNKNOWN'
  | 'ALREADY_OWNED'
  | 'IN_PROGRESS'
  | 'ITEM_UNAVAILABLE'
  | 'NOT_PREPARED'
  | 'NETWORK'
  | 'STORE_UNAVAILABLE'
  | 'CONFIGURATION_REQUIRED'
  | 'ACTION_REQUIRED'
  | 'ACCOUNT_BINDING_REQUIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export const commerceErrorCodes = Object.freeze([
  'USER_CANCELLED',
  'OUTCOME_UNKNOWN',
  'ALREADY_OWNED',
  'IN_PROGRESS',
  'ITEM_UNAVAILABLE',
  'NOT_PREPARED',
  'NETWORK',
  'STORE_UNAVAILABLE',
  'CONFIGURATION_REQUIRED',
  'ACTION_REQUIRED',
  'ACCOUNT_BINDING_REQUIRED',
  'INSUFFICIENT_BALANCE',
  'INVALID_RESPONSE',
  'UNKNOWN',
] as const satisfies readonly CommerceErrorCode[]);

export interface CommerceErrorInfo {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  /** The store's original code, for example PLAY_BILLING_SERVICE_UNAVAILABLE. */
  readonly storeCode?: string;
  readonly message?: string;
}

export type CommerceEvent =
  | { readonly type: 'purchaseUpdated'; readonly purchase: StorePurchase }
  | {
      readonly type: 'purchaseError';
      readonly logicalId?: LogicalProductId;
      readonly error: CommerceErrorInfo;
    }
  | { readonly type: 'subscriptionUpdated'; readonly subscription: ActiveSubscription };

/** Bridge event envelope; `sequence` is per session and starts at 0. */
export interface CommerceEventEnvelope {
  readonly protocol: typeof commerceProtocol;
  readonly sequence: NonNegativeInteger;
  readonly event: CommerceEvent;
}

export type FetchProductsType = 'in-app' | 'subscription' | 'all';

export interface FetchProductsInput {
  readonly logicalIds?: readonly LogicalProductId[];
  readonly type?: FetchProductsType;
}

export interface GetAvailablePurchasesInput {
  readonly includePending?: boolean;
}

export interface FinishTransactionInput {
  readonly transactionId: NonEmptyString;
  readonly ledgerEntryId: NonEmptyString;
  readonly isConsumable: boolean;
}

export interface FinishTransactionResult {
  readonly finished: boolean;
}

export interface CommerceProvider {
  readonly store: StoreId;
  getCapabilities(): Promise<CommerceCapabilities>;
  fetchProducts(input: FetchProductsInput): Promise<readonly StoreProduct[]>;
  /** Returns `launched` when the result arrives later as a `purchaseUpdated` event. */
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  /** Purchases the store still reports as unfinished. */
  getAvailablePurchases(input?: GetAvailablePurchasesInput): Promise<readonly StorePurchase[]>;
  /** Required when `lifecycle.finish` is 'client' or 'host'. */
  finishTransaction?(input: FinishTransactionInput): Promise<FinishTransactionResult>;
  /** Asks the store to resynchronize, for example `AppStore.sync`. */
  restorePurchases?(): Promise<void>;
  /** Designed, not implemented by any reference store provider. */
  getActiveSubscriptions?(): Promise<readonly ActiveSubscription[]>;
  /** Events emitted before the first listener are delivered to that listener. */
  subscribe(listener: (event: CommerceEvent) => void): () => void;
}

export type ActiveSubscriptionState = 'active' | 'lapsed' | 'revoked';

export interface ActiveSubscription {
  readonly store: StoreId;
  readonly logicalId: LogicalProductId;
  readonly subscriptionId: NonEmptyString;
  readonly periodIndex: NonNegativeInteger;
  readonly state: ActiveSubscriptionState;
  readonly startedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly autoRenew: boolean;
}

// Credit wallet types. The wallet rules, `createCreditCommerceProvider`, and a
// reference in-memory wallet arrive with B7; A2 only fixes the shapes.

export type CommerceBillingAuthority = 'store' | 'host';

export type CreditMembershipScope = 'title' | 'platform';

export interface CreditPrice {
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
}

export interface CreditMembershipTerms {
  readonly scope: CreditMembershipScope;
  readonly price: CreditPrice;
  /** ISO 8601 duration, for example P30D. */
  readonly period: NonEmptyString;
}

export interface CreditOffer {
  readonly logicalId: LogicalProductId;
  readonly storeSku: NonEmptyString;
  readonly kind: PurchaseKind;
  readonly title: string;
  readonly description: string;
  readonly price: CreditPrice;
  /** Present only for credit-funded memberships. */
  readonly membership?: CreditMembershipTerms;
}

export interface CreditSpendInput {
  readonly titleId: NonEmptyString;
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
  readonly idempotencyKey: NonEmptyString;
  readonly logicalId?: LogicalProductId;
}

export interface CreditDebit {
  readonly lotId: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
}

export type CreditSpendResult =
  | {
      readonly status: 'debited';
      readonly entitlementId: NonEmptyString;
      readonly debits: readonly CreditDebit[];
      /** A repeated idempotency key returns the original debits. */
      readonly alreadyProcessed?: boolean;
    }
  | { readonly status: 'rejected'; readonly error: CommerceErrorInfo };

export interface CreditEntitlement {
  readonly entitlementId: NonEmptyString;
  readonly titleId: NonEmptyString;
  readonly logicalId: LogicalProductId;
  readonly idempotencyKey: NonEmptyString;
  readonly createdAt: IsoTimestamp;
  readonly debits: readonly CreditDebit[];
}

export interface CreditBalance {
  readonly titleId: NonEmptyString;
  /** Spendable amount per currency, including eligible cross-title lots. */
  readonly balances: Readonly<Record<string, number>>;
}

export type CreditLotChannel = 'store' | 'off-store' | 'promotion';

export interface CreditLotOrigin {
  readonly channel: CreditLotChannel;
  readonly store: StoreId;
  readonly titleId: NonEmptyString;
}

export type CreditLotSpendScope =
  | { readonly kind: 'title'; readonly titleId: NonEmptyString }
  | { readonly kind: 'cross-title' };

export interface CreditLot {
  /** Equals the ledgerEntryId of the granting purchase, so a replayed grant cannot create a second lot. */
  readonly lotId: NonEmptyString;
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
  readonly remaining: number & tags.Minimum<0>;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly origin: CreditLotOrigin;
  /** Derived from the origin, never supplied by the caller. */
  readonly spendScope: CreditLotSpendScope;
}

export interface CreditWalletClient {
  readonly store: StoreId;
  listOffers(input: { readonly titleId: string }): Promise<readonly CreditOffer[]>;
  spend(input: CreditSpendInput): Promise<CreditSpendResult>;
  listUnredeemed(input: { readonly titleId: string }): Promise<readonly CreditEntitlement[]>;
  redeem(input: {
    readonly entitlementId: string;
    readonly ledgerEntryId: string;
  }): Promise<{ readonly redeemed: boolean }>;
  getBalance(input: { readonly titleId: string }): Promise<CreditBalance>;
  subscribe?(listener: (event: CommerceEvent) => void): () => void;
}

// Bridge v2 method shapes. The bridge wiring is A4; A2 fixes and validates the
// payloads so both sides of the bridge compile against the same schemas.

export interface CommerceBridgeGetCapabilitiesPayload {
  readonly protocol: typeof commerceProtocol;
}

export interface CommerceBridgeGetCapabilitiesResult {
  readonly protocolVersion: NonEmptyString;
  readonly store: StoreId;
  readonly capabilities: CommerceCapabilities;
}

export type CommerceBridgeFetchProductsPayload = FetchProductsInput;

export interface CommerceBridgeFetchProductsResult {
  readonly products: readonly StoreProduct[];
}

export type CommerceBridgeRequestPurchasePayload = RequestPurchaseInput;

export type CommerceBridgeRequestPurchaseResult = RequestPurchaseResult;

export type CommerceBridgeGetAvailablePurchasesPayload = GetAvailablePurchasesInput;

export interface CommerceBridgeGetAvailablePurchasesResult {
  readonly purchases: readonly StorePurchase[];
}

export type CommerceBridgeFinishTransactionPayload = FinishTransactionInput;

export type CommerceBridgeFinishTransactionResult = FinishTransactionResult;

export interface CommerceBridgeRestorePurchasesPayload {
  readonly protocol: typeof commerceProtocol;
}

export interface CommerceBridgeRestorePurchasesResult {
  readonly restored: boolean;
}

export interface CommerceBridgeMethods {
  readonly 'commerce.v2.getCapabilities': {
    readonly payload: CommerceBridgeGetCapabilitiesPayload;
    readonly result: CommerceBridgeGetCapabilitiesResult;
  };
  readonly 'commerce.v2.fetchProducts': {
    readonly payload: CommerceBridgeFetchProductsPayload;
    readonly result: CommerceBridgeFetchProductsResult;
  };
  readonly 'commerce.v2.requestPurchase': {
    readonly payload: CommerceBridgeRequestPurchasePayload;
    readonly result: CommerceBridgeRequestPurchaseResult;
  };
  readonly 'commerce.v2.getAvailablePurchases': {
    readonly payload: CommerceBridgeGetAvailablePurchasesPayload;
    readonly result: CommerceBridgeGetAvailablePurchasesResult;
  };
  readonly 'commerce.v2.finishTransaction': {
    readonly payload: CommerceBridgeFinishTransactionPayload;
    readonly result: CommerceBridgeFinishTransactionResult;
  };
  readonly 'commerce.v2.restorePurchases': {
    readonly payload: CommerceBridgeRestorePurchasesPayload;
    readonly result: CommerceBridgeRestorePurchasesResult;
  };
}

export type CommerceBridgeMethod = keyof CommerceBridgeMethods;

export const commerceBridgeMethods = Object.freeze([
  'commerce.v2.getCapabilities',
  'commerce.v2.fetchProducts',
  'commerce.v2.requestPurchase',
  'commerce.v2.getAvailablePurchases',
  'commerce.v2.finishTransaction',
  'commerce.v2.restorePurchases',
] as const satisfies readonly CommerceBridgeMethod[]);

// Errors.

const retryableCommerceErrorCodes: ReadonlySet<CommerceErrorCode> = new Set<CommerceErrorCode>([
  'NETWORK',
  'STORE_UNAVAILABLE',
]);

/** Only NETWORK and STORE_UNAVAILABLE are retryable without reconciling first. */
export function defaultCommerceErrorRetryable(code: CommerceErrorCode): boolean {
  return retryableCommerceErrorCodes.has(code);
}

export function isCommerceErrorCode(value: unknown): value is CommerceErrorCode {
  return typeof value === 'string' && (commerceErrorCodes as readonly string[]).includes(value);
}

export interface CommerceErrorOptions {
  readonly message?: string;
  readonly storeCode?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Normalized commerce failure. `code` is one of the v2 codes, `storeCode`
 * keeps the store's own code verbatim, and `retryable` defaults from the code.
 */
export class CommerceError extends PlatformOperationError {
  override readonly code: CommerceErrorCode;
  readonly storeCode: string | undefined;

  constructor(code: CommerceErrorCode, options: CommerceErrorOptions = {}) {
    super({
      code,
      message: options.message ?? `Commerce operation failed: ${code}.`,
      retryable: options.retryable ?? defaultCommerceErrorRetryable(code),
    });
    this.code = code;
    this.storeCode = options.storeCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toCommerceErrorInfo(): CommerceErrorInfo {
    return {
      code: this.code,
      retryable: this.retryable,
      ...(this.storeCode === undefined ? {} : { storeCode: this.storeCode }),
      message: this.message,
    };
  }
}

/**
 * Reads a normalized error info from any thrown value. A `CommerceError` keeps
 * its code; a plain object with a v2 `code` is accepted; any other platform
 * failure or error maps to UNKNOWN with the original code kept as `storeCode`.
 */
export function commerceErrorInfoOf(error: unknown): CommerceErrorInfo {
  if (error instanceof CommerceError) {
    return error.toCommerceErrorInfo();
  }
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const record = error as Readonly<Record<string, unknown>>;
    if (isCommerceErrorCode(record.code)) {
      return {
        code: record.code,
        retryable: typeof record.retryable === 'boolean'
          ? record.retryable
          : defaultCommerceErrorRetryable(record.code),
        ...(typeof record.storeCode === 'string' ? { storeCode: record.storeCode } : {}),
        ...(typeof record.message === 'string' ? { message: record.message } : {}),
      };
    }
  }
  const failure = readPlatformOperationFailure(error);
  if (failure !== null) {
    return {
      code: 'UNKNOWN',
      retryable: failure.retryable,
      storeCode: failure.code,
      ...(error instanceof Error ? { message: error.message } : {}),
    };
  }
  return {
    code: 'UNKNOWN',
    retryable: false,
    ...(error instanceof Error ? { message: error.message } : {}),
  };
}

// Purchase lifecycle state machine.

export type CommercePurchaseState =
  | 'requested'
  | 'launched'
  | 'pending'
  | 'purchased'
  | 'verifying'
  | 'granted'
  | 'finishing'
  | 'finished'
  | 'cancelled'
  | 'failed'
  | 'rejected'
  | 'revoked';

export const commercePurchaseStates = Object.freeze([
  'requested',
  'launched',
  'pending',
  'purchased',
  'verifying',
  'granted',
  'finishing',
  'finished',
  'cancelled',
  'failed',
  'rejected',
  'revoked',
] as const satisfies readonly CommercePurchaseState[]);

/** Allowed transitions, from the RFC lifecycle table. `pending` covers both store-side and server-side waits. */
export const commercePurchaseTransitions: Readonly<
  Record<CommercePurchaseState, readonly CommercePurchaseState[]>
> = Object.freeze({
  requested: Object.freeze(['launched', 'cancelled', 'failed'] as const),
  launched: Object.freeze(['pending', 'purchased', 'cancelled', 'failed'] as const),
  pending: Object.freeze(['purchased', 'verifying', 'cancelled', 'failed'] as const),
  purchased: Object.freeze(['verifying'] as const),
  verifying: Object.freeze(['granted', 'pending', 'rejected'] as const),
  granted: Object.freeze(['finishing', 'finished', 'revoked'] as const),
  finishing: Object.freeze(['finished', 'revoked'] as const),
  finished: Object.freeze(['revoked'] as const),
  cancelled: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
  revoked: Object.freeze([] as const),
});

export const terminalCommercePurchaseStates = Object.freeze([
  'finished',
  'cancelled',
  'failed',
  'rejected',
  'revoked',
] as const satisfies readonly CommercePurchaseState[]);

export function canTransitionCommercePurchase(
  from: CommercePurchaseState,
  to: CommercePurchaseState,
): boolean {
  return commercePurchaseTransitions[from].includes(to);
}

export function assertCommercePurchaseTransition(
  from: CommercePurchaseState,
  to: CommercePurchaseState,
): void {
  if (!canTransitionCommercePurchase(from, to)) {
    throw new Error(`Commerce purchase state cannot move from ${from} to ${to}.`);
  }
}

export function isTerminalCommercePurchaseState(state: CommercePurchaseState): boolean {
  return (terminalCommercePurchaseStates as readonly CommercePurchaseState[]).includes(state);
}

/** Only `granted` may unlock content, and only because the ledger says so. */
export type CommercePurchaseSummaryStatus =
  | 'pending'
  | 'granted'
  | 'cancelled'
  | 'failed'
  | 'rejected'
  | 'revoked';

export function summarizeCommercePurchaseState(
  state: CommercePurchaseState,
): CommercePurchaseSummaryStatus {
  switch (state) {
    case 'granted':
    case 'finishing':
    case 'finished':
      return 'granted';
    case 'requested':
    case 'launched':
    case 'pending':
    case 'purchased':
    case 'verifying':
      return 'pending';
    case 'cancelled':
    case 'failed':
    case 'rejected':
    case 'revoked':
      return state;
  }
}

// Capabilities.

export interface LegacyCommerceCapabilities {
  readonly nativeIap: boolean;
  readonly subscriptionIap: boolean;
}

/** Transition rule for the boolean `PlatformCapabilities` flags. */
export function deriveLegacyCommerceCapabilities(
  capabilities: CommerceCapabilities,
): LegacyCommerceCapabilities {
  return {
    nativeIap: capabilities.availability === 'available'
      && (capabilities.purchase.consumable || capabilities.purchase.durable),
    subscriptionIap: capabilities.purchase.subscription,
  };
}

/** A fresh all-false snapshot; callers must not share or mutate a returned object. */
export function createUnsupportedCommerceCapabilities(): CommerceCapabilities {
  return {
    purchase: { consumable: false, durable: false, subscription: false, quantity: false },
    catalog: { products: false, offers: false, localizedPrice: false },
    lifecycle: {
      availablePurchases: false,
      pending: false,
      restore: false,
      events: false,
      finish: 'none',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: 'unsupported',
  };
}

/**
 * Rejects a purchase the provider cannot serve before any store UI opens.
 * `kind` is the catalog kind of `input.logicalId`; the caller resolves it.
 */
export function assertRequestPurchaseSupported(
  capabilities: CommerceCapabilities,
  input: RequestPurchaseInput,
  kind: PurchaseKind,
): void {
  if (!capabilities.purchase[kind]) {
    throw new CommerceError('ITEM_UNAVAILABLE', {
      message: `The provider does not sell ${kind} products.`,
    });
  }
  if (input.quantity !== undefined && input.quantity > 1 && !capabilities.purchase.quantity) {
    throw new CommerceError('ITEM_UNAVAILABLE', {
      message: 'The provider does not support purchase quantities above 1.',
    });
  }
}

// Idempotency keys.

export interface DerivedPurchaseIdempotencyKeyInput {
  readonly store: StoreId;
  readonly transactionId: string;
  readonly token: string;
}

/**
 * Key for a purchase discovered without a journal record. Every runtime derives
 * the same key: `store:<storeId>:<transactionId>` by default, and the forms v1
 * ledgers already use for Google Play (`play-token-sha256:<hex>`) and Apps in
 * Toss (`apps-in-toss:purchase:<orderId>`).
 */
export async function createDerivedPurchaseIdempotencyKey(
  input: DerivedPurchaseIdempotencyKeyInput,
): Promise<string> {
  const store = readIdentifier(input.store, 128);
  if (store === undefined) {
    throw new TypeError('Derived purchase keys require a store id.');
  }
  if (store === 'google-play') {
    return createGooglePlayTokenPurchaseKey(input.token);
  }
  const transactionId = readIdentifier(input.transactionId, 512);
  if (transactionId === undefined) {
    throw new TypeError('Derived purchase keys require a transaction id.');
  }
  if (store === 'apps-in-toss') {
    return `apps-in-toss:purchase:${transactionId}`;
  }
  return `store:${store}:${transactionId}`;
}

/** Byte-for-byte the v1 `createGooglePlayTokenTransactionId` form; A4 replaces the two copies with this helper. */
export async function createGooglePlayTokenPurchaseKey(purchaseToken: string): Promise<string> {
  if (readIdentifier(purchaseToken, 4096) === undefined) {
    throw new TypeError('Google Play purchase token is invalid.');
  }
  const { subtle, encoder } = readWebCrypto();
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(purchaseToken)));
  return `play-token-sha256:${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

// Resolved through globalThis so this module compiles without the DOM lib;
// Node, browsers, and WebViews all expose both globals.
interface WebCryptoSubtle {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

function readWebCrypto(): { readonly subtle: WebCryptoSubtle; readonly encoder: Utf8Encoder } {
  const globals = globalThis as {
    readonly crypto?: { readonly subtle?: WebCryptoSubtle };
    readonly TextEncoder?: new () => Utf8Encoder;
  };
  const subtle = globals.crypto?.subtle;
  if (subtle === undefined || globals.TextEncoder === undefined) {
    throw new Error('Web Crypto is required to hash Google Play purchase tokens.');
  }
  return { subtle, encoder: new globals.TextEncoder() };
}

function readIdentifier(input: unknown, maxLength: number): string | undefined {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > maxLength
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    return undefined;
  }
  return input;
}

// Pre-listener event buffer.

export const commerceEventBufferLimit = 64;

export interface CommerceEventBuffer {
  readonly size: number;
  /** Keeps the event for the first subscriber; drops the oldest `purchaseUpdated` when full. */
  push(event: CommerceEvent): void;
  /** Delivers and clears every buffered event in order. */
  drain(listener: (event: CommerceEvent) => void): number;
}

/**
 * Buffer for events emitted before the first `subscribe` call. Over the limit
 * it drops the oldest `purchaseUpdated` first because those are recoverable
 * from `getAvailablePurchases`; `purchaseError` and `subscriptionUpdated` are
 * dropped only when no `purchaseUpdated` remains.
 */
export function createCommerceEventBuffer(
  options: { readonly limit?: number } = {},
): CommerceEventBuffer {
  const limit = options.limit ?? commerceEventBufferLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Commerce event buffer limit must be a positive integer.');
  }
  const events: CommerceEvent[] = [];
  return {
    get size() {
      return events.length;
    },
    push(event) {
      events.push(event);
      if (events.length <= limit) {
        return;
      }
      const recoverable = events.findIndex((buffered) => buffered.type === 'purchaseUpdated');
      events.splice(recoverable === -1 ? 0 : recoverable, 1);
    },
    drain(listener) {
      const drained = events.splice(0, events.length);
      for (const event of drained) {
        listener(event);
      }
      return drained.length;
    },
  };
}

// Validators. typia checks the shape, the tags, and rejects unknown keys;
// logical ids are post-checked because `LogicalProductId` is a branded string
// union typia reads as `string`.

const assertStoreProductShape = typia.createAssertEquals<StoreProduct>();
const assertStorePurchaseShape = typia.createAssertEquals<StorePurchase>();
const assertRequestPurchaseInputShape = typia.createAssertEquals<RequestPurchaseInput>();
const assertRequestPurchaseResultShape = typia.createAssertEquals<RequestPurchaseResult>();
const assertCommerceEventShape = typia.createAssertEquals<CommerceEvent>();
const assertCommerceEventEnvelopeShape = typia.createAssertEquals<CommerceEventEnvelope>();
const assertActiveSubscriptionShape = typia.createAssertEquals<ActiveSubscription>();
const assertFetchProductsInputShape = typia.createAssertEquals<FetchProductsInput>();
const assertCreditOfferShape = typia.createAssertEquals<CreditOffer>();
const assertCreditSpendInputShape = typia.createAssertEquals<CreditSpendInput>();
const assertCreditEntitlementShape = typia.createAssertEquals<CreditEntitlement>();

export const assertCommerceCapabilities = typia.createAssertEquals<CommerceCapabilities>();
export const isCommerceCapabilities = typia.createEquals<CommerceCapabilities>();
export const assertCommerceErrorInfo = typia.createAssertEquals<CommerceErrorInfo>();
export const assertCreditLot = typia.createAssertEquals<CreditLot>();
export const assertCreditSpendResult = typia.createAssertEquals<CreditSpendResult>();
export const assertCreditBalance = typia.createAssertEquals<CreditBalance>();
export const assertFinishTransactionInput = typia.createAssertEquals<FinishTransactionInput>();
export const assertFinishTransactionResult = typia.createAssertEquals<FinishTransactionResult>();
export const assertGetAvailablePurchasesInput = typia.createAssertEquals<GetAvailablePurchasesInput>();
export const assertCommerceBridgeGetCapabilitiesPayload =
  typia.createAssertEquals<CommerceBridgeGetCapabilitiesPayload>();
export const assertCommerceBridgeGetCapabilitiesResult =
  typia.createAssertEquals<CommerceBridgeGetCapabilitiesResult>();
export const assertCommerceBridgeRestorePurchasesPayload =
  typia.createAssertEquals<CommerceBridgeRestorePurchasesPayload>();
export const assertCommerceBridgeRestorePurchasesResult =
  typia.createAssertEquals<CommerceBridgeRestorePurchasesResult>();
const assertCommerceBridgeFetchProductsResultShape =
  typia.createAssertEquals<CommerceBridgeFetchProductsResult>();
const assertCommerceBridgeGetAvailablePurchasesResultShape =
  typia.createAssertEquals<CommerceBridgeGetAvailablePurchasesResult>();

export function assertStoreProduct(input: unknown): StoreProduct {
  const product = assertStoreProductShape(input);
  assertLogicalId(product.logicalId, '$input.logicalId');
  return product;
}

export function isStoreProduct(input: unknown): input is StoreProduct {
  return tryAssert(() => assertStoreProduct(input));
}

export function assertStorePurchase(input: unknown): StorePurchase {
  const purchase = assertStorePurchaseShape(input);
  if (purchase.logicalId !== undefined) {
    assertLogicalId(purchase.logicalId, '$input.logicalId');
  }
  return purchase;
}

export function isStorePurchase(input: unknown): input is StorePurchase {
  return tryAssert(() => assertStorePurchase(input));
}

export function assertRequestPurchaseInput(input: unknown): RequestPurchaseInput {
  const request = assertRequestPurchaseInputShape(input);
  assertLogicalId(request.logicalId, '$input.logicalId');
  return request;
}

export function isRequestPurchaseInput(input: unknown): input is RequestPurchaseInput {
  return tryAssert(() => assertRequestPurchaseInput(input));
}

export function assertRequestPurchaseResult(input: unknown): RequestPurchaseResult {
  const result = assertRequestPurchaseResultShape(input);
  if (result.outcome === 'purchased' && result.purchase.logicalId !== undefined) {
    assertLogicalId(result.purchase.logicalId, '$input.purchase.logicalId');
  }
  return result;
}

export function isRequestPurchaseResult(input: unknown): input is RequestPurchaseResult {
  return tryAssert(() => assertRequestPurchaseResult(input));
}

export function assertCommerceEvent(input: unknown): CommerceEvent {
  const event = assertCommerceEventShape(input);
  assertCommerceEventLogicalIds(event, '$input');
  return event;
}

export function isCommerceEvent(input: unknown): input is CommerceEvent {
  return tryAssert(() => assertCommerceEvent(input));
}

export function assertCommerceEventEnvelope(input: unknown): CommerceEventEnvelope {
  const envelope = assertCommerceEventEnvelopeShape(input);
  assertCommerceEventLogicalIds(envelope.event, '$input.event');
  return envelope;
}

export function isCommerceEventEnvelope(input: unknown): input is CommerceEventEnvelope {
  return tryAssert(() => assertCommerceEventEnvelope(input));
}

export function assertActiveSubscription(input: unknown): ActiveSubscription {
  const subscription = assertActiveSubscriptionShape(input);
  assertLogicalId(subscription.logicalId, '$input.logicalId');
  return subscription;
}

export function isActiveSubscription(input: unknown): input is ActiveSubscription {
  return tryAssert(() => assertActiveSubscription(input));
}

export function assertFetchProductsInput(input: unknown): FetchProductsInput {
  const request = assertFetchProductsInputShape(input);
  request.logicalIds?.forEach((logicalId, index) => {
    assertLogicalId(logicalId, `$input.logicalIds[${index}]`);
  });
  return request;
}

export function assertCreditOffer(input: unknown): CreditOffer {
  const offer = assertCreditOfferShape(input);
  assertLogicalId(offer.logicalId, '$input.logicalId');
  return offer;
}

export function assertCreditSpendInput(input: unknown): CreditSpendInput {
  const spend = assertCreditSpendInputShape(input);
  if (spend.logicalId !== undefined) {
    assertLogicalId(spend.logicalId, '$input.logicalId');
  }
  return spend;
}

export function assertCreditEntitlement(input: unknown): CreditEntitlement {
  const entitlement = assertCreditEntitlementShape(input);
  assertLogicalId(entitlement.logicalId, '$input.logicalId');
  return entitlement;
}

export const assertCommerceBridgeFetchProductsPayload = assertFetchProductsInput;

export function assertCommerceBridgeFetchProductsResult(
  input: unknown,
): CommerceBridgeFetchProductsResult {
  const result = assertCommerceBridgeFetchProductsResultShape(input);
  result.products.forEach((product, index) => {
    assertLogicalId(product.logicalId, `$input.products[${index}].logicalId`);
  });
  return result;
}

export const assertCommerceBridgeRequestPurchasePayload = assertRequestPurchaseInput;
export const assertCommerceBridgeRequestPurchaseResult = assertRequestPurchaseResult;
export const assertCommerceBridgeGetAvailablePurchasesPayload = assertGetAvailablePurchasesInput;

export function assertCommerceBridgeGetAvailablePurchasesResult(
  input: unknown,
): CommerceBridgeGetAvailablePurchasesResult {
  const result = assertCommerceBridgeGetAvailablePurchasesResultShape(input);
  result.purchases.forEach((purchase, index) => {
    if (purchase.logicalId !== undefined) {
      assertLogicalId(purchase.logicalId, `$input.purchases[${index}].logicalId`);
    }
  });
  return result;
}

export const assertCommerceBridgeFinishTransactionPayload = assertFinishTransactionInput;
export const assertCommerceBridgeFinishTransactionResult = assertFinishTransactionResult;

function assertCommerceEventLogicalIds(event: CommerceEvent, path: string): void {
  if (event.type === 'purchaseUpdated' && event.purchase.logicalId !== undefined) {
    assertLogicalId(event.purchase.logicalId, `${path}.purchase.logicalId`);
  } else if (event.type === 'purchaseError' && event.logicalId !== undefined) {
    assertLogicalId(event.logicalId, `${path}.logicalId`);
  } else if (event.type === 'subscriptionUpdated') {
    assertLogicalId(event.subscription.logicalId, `${path}.subscription.logicalId`);
  }
}

function assertLogicalId(value: string, path: string): void {
  if (value.length === 0) {
    throw new TypeError(`Logical product id at ${path} must not be empty.`);
  }
}

function tryAssert(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

// v1 compatibility wrapper.

export interface ToCommerceAdapterOptions {
  /** Forwarded to `getAvailablePurchases` during `restore`. Defaults to false. */
  readonly includePending?: boolean;
}

const purchaseKindToProductType: Readonly<Record<PurchaseKind, ProductType>> = Object.freeze({
  consumable: 'consumable',
  durable: 'non_consumable',
  subscription: 'subscription',
});

/**
 * Serves v1 `CommerceAdapter` callers from a v2 provider. The wrapper never
 * grants: a `purchased` outcome becomes a `completed` result with no
 * entitlements, and `authoritativeGrant` appears only when the provider reports
 * an adapter settlement that already points at a ledger entry. `restore`
 * returns settled purchases from `getAvailablePurchases` and no entitlements;
 * entitlements come from the ledger, not from the provider.
 */
export function toCommerceAdapter(
  provider: CommerceProvider,
  options: ToCommerceAdapterOptions = {},
): CommerceAdapter {
  const includePending = options.includePending ?? false;
  return {
    async getProducts(): Promise<readonly ProductInfo[]> {
      const products = await provider.fetchProducts({ type: 'all' });
      return products.map((product) => ({
        id: product.logicalId,
        type: purchaseKindToProductType[product.kind],
        title: product.title,
        description: product.description,
        price: { formatted: product.price.formatted, currencyCode: product.price.currencyCode },
      }));
    },
    async purchase(input): Promise<PurchaseResult> {
      const result = await provider.requestPurchase({
        logicalId: input.productId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
      });
      return toPurchaseResult(result);
    },
    async restore(): Promise<PurchaseRestoreResult> {
      await provider.restorePurchases?.();
      const purchases = await provider.getAvailablePurchases({ includePending });
      const settledPurchases: PurchaseSettlement[] = [];
      for (const purchase of purchases) {
        if (purchase.settlement === undefined || purchase.logicalId === undefined) {
          continue;
        }
        settledPurchases.push({
          transactionId: purchase.transactionId,
          productId: purchase.logicalId,
          status: purchase.state === 'revoked' ? 'refunded' : 'granted',
          ledgerEntryId: purchase.settlement.ledgerEntryId,
        });
      }
      return { restoredEntitlements: [], settledPurchases };
    },
    async getEntitlements() {
      return [];
    },
  };
}

function toPurchaseResult(result: RequestPurchaseResult): PurchaseResult {
  if (result.outcome === 'launched') {
    return { status: 'pending', entitlementIds: [] };
  }
  if (result.outcome === 'purchased') {
    const { purchase } = result;
    return {
      status: purchase.state === 'purchased' ? 'completed' : 'pending',
      transactionId: purchase.transactionId,
      entitlementIds: [],
      evidence: purchase.evidence,
      ...(purchase.settlement === undefined || purchase.state !== 'purchased'
        ? {}
        : { authoritativeGrant: { ledgerEntryId: purchase.settlement.ledgerEntryId } }),
    };
  }
  return {
    status: result.outcome,
    entitlementIds: [],
    diagnostic: toCommerceDiagnostic(result.error),
  };
}

function toCommerceDiagnostic(error: CommerceErrorInfo): CommerceDiagnostic {
  const providerCode = error.storeCode;
  return {
    code: error.code,
    retryable: error.retryable,
    ...(providerCode !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/u.test(providerCode)
      ? { providerCode }
      : {}),
  };
}

import typia, { type tags } from 'typia';

import {
  PlatformOperationError,
  readPlatformOperationFailure,
  type CommerceCapabilities,
  type LogicalProductId,
  type PlatformEvidenceEnvelope,
  type StarterLogicalProductId,
} from './index.js';

import type {
  ActiveSubscription,
  CommerceErrorCode,
  CommerceErrorInfo,
  CommerceEvent,
  CommerceLogicalProductId,
  CommerceProvider,
  CommerceServiceCapabilities,
  FetchProductsInput,
  FinishTransactionInput,
  FinishTransactionResult,
  GetAvailablePurchasesInput,
  IsoTimestamp,
  NonEmptyString,
  NonNegativeInteger,
  PositiveQuantity,
  PurchaseKind,
  RequestPurchaseInput,
  RequestPurchaseResult,
  StoreId,
  StoreProduct,
  StorePurchase,
} from './commerce-contract.js';

export { createUnsupportedCommerceCapabilities } from './commerce-capabilities.js';
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

// The client contract types live in the typia-free `./commerce-contract` so
// `./index` can reference `CommerceProvider` without loading typia; they are
// re-exported here so `@mpgd/platform/commerce` stays the one import site.
export type {
  ActiveSubscription,
  ActiveSubscriptionState,
  CommerceErrorCode,
  CommerceErrorInfo,
  CommerceEvent,
  CommerceLogicalProductId,
  CommerceProvider,
  CommerceServiceCapabilities,
  CommerceServiceStoreCapabilities,
  FetchProductsInput,
  FetchProductsType,
  FinishTransactionInput,
  FinishTransactionResult,
  GetAvailablePurchasesInput,
  PurchaseKind,
  PurchaseSource,
  RequestPurchaseInput,
  RequestPurchaseResult,
  StoreId,
  StoreOffer,
  StorePrice,
  StoreProduct,
  StorePurchase,
  StorePurchaseAccountBinding,
  StorePurchaseState,
} from './commerce-contract.js';

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

/** Bridge event envelope; `sequence` is per session and starts at 0. */
export interface CommerceEventEnvelope {
  readonly protocol: typeof commerceProtocol;
  readonly sequence: NonNegativeInteger;
  readonly event: CommerceEvent;
}

// Credit wallet types (RFC "Credit wallet"). The wallet rules,
// `createCreditCommerceProvider`, and the reference in-memory wallet live in
// `@mpgd/platform/commerce-wallet`; this module fixes the shapes and validators.

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
  readonly logicalId: CommerceLogicalProductId;
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
  /**
   * The offer being bought; the wallet prices the spend against it and issues
   * an entitlement. Without it the spend is a plain debit of `amount` with no
   * entitlement, an owner-side form the conformance vectors use; a wallet
   * service should require it from game clients.
   */
  readonly logicalId?: CommerceLogicalProductId;
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
      /** When the wallet settled the spend; a replay repeats the original time. */
      readonly createdAt?: IsoTimestamp;
      /** A repeated idempotency key returns the original debits. */
      readonly alreadyProcessed?: boolean;
    }
  | { readonly status: 'rejected'; readonly error: CommerceErrorInfo };

export interface CreditEntitlement {
  readonly entitlementId: NonEmptyString;
  readonly titleId: NonEmptyString;
  readonly logicalId: CommerceLogicalProductId;
  readonly idempotencyKey: NonEmptyString;
  readonly createdAt: IsoTimestamp;
  readonly debits: readonly CreditDebit[];
  /** Units bought at spend time; the provider reports it rather than deriving one from today's price. */
  readonly quantity?: PositiveQuantity;
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

/**
 * The client a consuming project implements against its wallet service.
 * `createCreditCommerceProvider` (`@mpgd/platform/commerce-wallet`) turns it
 * into a `CommerceProvider`. A `spend` of a membership offer starts the
 * membership under the spend's idempotency key as its subscription id; the
 * wallet service alone renews, lapses, and expires it.
 */
export interface CreditWalletClient {
  readonly store: StoreId;
  listOffers(input: { readonly titleId: string }): Promise<readonly CreditOffer[]>;
  spend(input: CreditSpendInput): Promise<CreditSpendResult>;
  listUnredeemed(input: { readonly titleId: string }): Promise<readonly CreditEntitlement[]>;
  /** Redeems an entitlement for the ledger entry that granted it; the wallet service verifies the pair. */
  redeem(input: {
    readonly entitlementId: string;
    readonly ledgerEntryId: string;
  }): Promise<{ readonly redeemed: boolean }>;
  getBalance(input: { readonly titleId: string }): Promise<CreditBalance>;
  /** Memberships the wallet service reports as active for the title; absent when the wallet sells none. */
  getActiveSubscriptions?(input: { readonly titleId: string }): Promise<readonly ActiveSubscription[]>;
  /** With `input.titleId`, only events that concern that title (platform memberships concern every title). */
  subscribe?(
    listener: (event: CommerceEvent) => void,
    input?: CreditWalletSubscribeInput,
  ): () => void;
}

export interface CreditWalletSubscribeInput {
  readonly titleId?: string;
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

// `satisfies` only rejects an unknown name; this rejects a missing one, so a
// method added to `CommerceBridgeMethods` cannot be left out of the list.
const commerceBridgeMethodListIsExhaustive: [CommerceBridgeMethod] extends
  [(typeof commerceBridgeMethods)[number]] ? true : never = true;
void commerceBridgeMethodListIsExhaustive;

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
 * the same key: `store:<storeId>:<transactionId>` by default, with each
 * component percent-encoded (`encodeURIComponent`) so ids containing `:`
 * cannot collide, and the forms v1 ledgers already use for Google Play
 * (`play-token-sha256:<hex>`) and Apps in Toss
 * (`apps-in-toss:purchase:<encodeURIComponent(orderId)>`), which stay
 * byte-identical.
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
    // Byte for byte the v1 `createAppsInTossPurchaseIdempotencyKey` form.
    return `apps-in-toss:purchase:${encodeURIComponent(transactionId)}`;
  }
  return `store:${encodeURIComponent(store)}:${encodeURIComponent(transactionId)}`;
}

/**
 * The `play-token-sha256:<hex>` idempotency key of a Google Play purchase
 * token. The one shared helper: the plugin and `@mpgd/game-services` use it,
 * and ledgers written by v1 releases keep deduplicating against it.
 */
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
  /** Keeps the event for the first subscriber; drops the oldest recoverable `purchaseUpdated` when full. */
  push(event: CommerceEvent): void;
  /** Delivers and clears every buffered event in order. */
  drain(listener: (event: CommerceEvent) => void): number;
}

/**
 * Buffer for events emitted before the first `subscribe` call. Over the limit
 * it drops the oldest recoverable `purchaseUpdated` first: a pending or
 * purchased purchase is still returned by `getAvailablePurchases`. A revoked
 * purchase is not, so revoked `purchaseUpdated`, `purchaseError`, and
 * `subscriptionUpdated` events are dropped oldest-first only when no
 * recoverable `purchaseUpdated` remains.
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
      const recoverable = events.findIndex(
        (buffered) => buffered.type === 'purchaseUpdated' && buffered.purchase.state !== 'revoked',
      );
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

// Validators. typia checks the shape and the tags and rejects unknown keys.

export const assertStoreProduct = typia.createAssertEquals<StoreProduct>();
export const isStoreProduct = typia.createEquals<StoreProduct>();
export const assertStorePurchase = typia.createAssertEquals<StorePurchase>();
export const isStorePurchase = typia.createEquals<StorePurchase>();
export const assertRequestPurchaseInput = typia.createAssertEquals<RequestPurchaseInput>();
export const isRequestPurchaseInput = typia.createEquals<RequestPurchaseInput>();
export const assertRequestPurchaseResult = typia.createAssertEquals<RequestPurchaseResult>();
export const isRequestPurchaseResult = typia.createEquals<RequestPurchaseResult>();
export const assertCommerceEvent = typia.createAssertEquals<CommerceEvent>();
export const isCommerceEvent = typia.createEquals<CommerceEvent>();
export const assertCommerceEventEnvelope = typia.createAssertEquals<CommerceEventEnvelope>();
export const isCommerceEventEnvelope = typia.createEquals<CommerceEventEnvelope>();
export const assertActiveSubscription = typia.createAssertEquals<ActiveSubscription>();
export const isActiveSubscription = typia.createEquals<ActiveSubscription>();
export const assertFetchProductsInput = typia.createAssertEquals<FetchProductsInput>();
export const assertCommerceCapabilities = typia.createAssertEquals<CommerceCapabilities>();
export const isCommerceCapabilities = typia.createEquals<CommerceCapabilities>();
export const assertCommerceServiceCapabilities =
  typia.createAssertEquals<CommerceServiceCapabilities>();
export const isCommerceServiceCapabilities = typia.createEquals<CommerceServiceCapabilities>();
export const assertCommerceErrorInfo = typia.createAssertEquals<CommerceErrorInfo>();
export const assertCreditOffer = typia.createAssertEquals<CreditOffer>();
export const assertCreditSpendInput = typia.createAssertEquals<CreditSpendInput>();
export const assertCreditSpendResult = typia.createAssertEquals<CreditSpendResult>();
export const assertCreditEntitlement = typia.createAssertEquals<CreditEntitlement>();
export const assertCreditBalance = typia.createAssertEquals<CreditBalance>();
export const assertCreditLot = typia.createAssertEquals<CreditLot>();
export const assertFinishTransactionInput = typia.createAssertEquals<FinishTransactionInput>();
export const assertFinishTransactionResult = typia.createAssertEquals<FinishTransactionResult>();
export const assertGetAvailablePurchasesInput =
  typia.createAssertEquals<GetAvailablePurchasesInput>();
export const assertCommerceBridgeGetCapabilitiesPayload =
  typia.createAssertEquals<CommerceBridgeGetCapabilitiesPayload>();
export const assertCommerceBridgeGetCapabilitiesResult =
  typia.createAssertEquals<CommerceBridgeGetCapabilitiesResult>();
export const assertCommerceBridgeFetchProductsPayload = assertFetchProductsInput;
export const assertCommerceBridgeFetchProductsResult =
  typia.createAssertEquals<CommerceBridgeFetchProductsResult>();
export const assertCommerceBridgeRequestPurchasePayload = assertRequestPurchaseInput;
export const assertCommerceBridgeRequestPurchaseResult = assertRequestPurchaseResult;
export const assertCommerceBridgeGetAvailablePurchasesPayload = assertGetAvailablePurchasesInput;
export const assertCommerceBridgeGetAvailablePurchasesResult =
  typia.createAssertEquals<CommerceBridgeGetAvailablePurchasesResult>();
export const assertCommerceBridgeFinishTransactionPayload = assertFinishTransactionInput;
export const assertCommerceBridgeFinishTransactionResult = assertFinishTransactionResult;
export const assertCommerceBridgeRestorePurchasesPayload =
  typia.createAssertEquals<CommerceBridgeRestorePurchasesPayload>();
export const assertCommerceBridgeRestorePurchasesResult =
  typia.createAssertEquals<CommerceBridgeRestorePurchasesResult>();

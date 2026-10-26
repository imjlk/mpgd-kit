import type {
  CommerceCapabilities,
  CommerceFinishOwner,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  PlatformPurchasePresentationEvent,
  StarterLogicalProductId,
} from './index.js';

/**
 * Commerce v2 client contract types (RFC "Client contract"). This module is
 * typia-free on purpose: `./index` references `CommerceProvider` for
 * `PlatformGateway.commerce`, and headless consumers type-check
 * `@mpgd/platform` with `skipLibCheck: false` and no DOM lib, where typia's
 * root declarations do not compile. `./commerce` re-exports everything here
 * and builds the validators and JSON Schemas from these same types.
 *
 * The validation tags below are the structural phantom form typia reads
 * (`'typia.tag'`), mirrored field for field from `@typia/interface` so the
 * generated validators and schemas are identical to the typia aliases;
 * `commerce-contract.test.ts` proves that parity and the schema alignment
 * validator compares the committed files byte for byte.
 */

type CommerceTag<Props extends object> = { 'typia.tag'?: Props };

/** `tags.MinLength<Value>` */
export type CommerceMinLength<Value extends number> = CommerceTag<{
  target: 'string';
  kind: 'minLength';
  value: Value;
  validate: `${Value} <= $input.length`;
  exclusive: true;
  schema: { minLength: Value };
}>;

/** `tags.Format<'date-time'>` */
export type CommerceDateTimeFormat = CommerceTag<{
  target: 'string';
  kind: 'format';
  value: 'date-time';
  validate: '$importInternal("isFormatDateTime")($input)';
  exclusive: ['format', 'pattern'];
  schema: { format: 'date-time' };
}>;

/** `tags.Type<'uint32'>` */
export type CommerceUint32 = CommerceTag<{
  target: 'number';
  kind: 'type';
  value: 'uint32';
  validate: '$importInternal("isTypeUint32")($input)';
  exclusive: true;
  schema: { type: 'integer'; minimum: 0 };
}>;

/** `tags.Type<'int64'>` */
export type CommerceInt64 = CommerceTag<{
  target: 'bigint' | 'number';
  kind: 'type';
  value: 'int64';
  validate: { number: '$importInternal("isTypeInt64")($input)'; bigint: 'true' };
  exclusive: true;
  schema: { type: 'integer' };
}>;

/** `tags.Minimum<Value>` for a number literal */
export type CommerceMinimum<Value extends number> = CommerceTag<{
  target: 'number';
  kind: 'minimum';
  value: Value;
  validate: `${Value} <= $input`;
  exclusive: ['minimum', 'exclusiveMinimum'];
  schema: { minimum: Value };
}>;

export type NonEmptyString = string & CommerceMinLength<1>;
export type IsoTimestamp = string & CommerceDateTimeFormat;
export type PositiveQuantity = number & CommerceUint32 & CommerceMinimum<1>;
export type NonNegativeInteger = number & CommerceUint32;

/**
 * Open store identifier. Reference providers use 'google-play', 'app-store',
 * 'microsoft-store', 'apps-in-toss', 'devvit', and 'verse8'; a consuming
 * project adds its own, for example a credit wallet id.
 */
export type StoreId = NonEmptyString;

export type PurchaseKind = 'consumable' | 'durable' | 'subscription';

/**
 * `LogicalProductId` narrowed to its open string branch and tagged non-empty,
 * so validators and the generated schemas carry `minLength: 1`. Starter ids and
 * plain `LogicalProductId` values remain assignable.
 */
export type CommerceLogicalProductId = Exclude<LogicalProductId, StarterLogicalProductId>
  & CommerceMinLength<1>;

export interface StorePrice {
  readonly formatted: string;
  /** ISO 4217 code or a project-declared code such as a wallet currency. */
  readonly currencyCode: NonEmptyString;
  readonly amountMicros?: number & CommerceInt64;
}

export interface StoreOffer {
  readonly offerId: NonEmptyString;
  readonly price: StorePrice;
  readonly title?: string;
  readonly description?: string;
}

export interface StoreProduct {
  readonly logicalId: CommerceLogicalProductId;
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
  readonly logicalId?: CommerceLogicalProductId;
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
  readonly logicalId: CommerceLogicalProductId;
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
      readonly logicalId?: CommerceLogicalProductId;
      readonly error: CommerceErrorInfo;
    }
  | { readonly type: 'subscriptionUpdated'; readonly subscription: ActiveSubscription };

export type FetchProductsType = 'in-app' | 'subscription' | 'all';

export interface FetchProductsInput {
  readonly logicalIds?: readonly CommerceLogicalProductId[];
  readonly type?: FetchProductsType;
}

export interface GetAvailablePurchasesInput {
  readonly includePending?: boolean;
  /**
   * The player's explicit Restore Purchases read, never a startup or resume
   * recovery pass. A store whose recovery list hides owned non-consumables
   * lists them too: Google Play's already acknowledged items, and StoreKit
   * entitlements bound to another (or no) app account token. After a
   * reinstall or on a new device every earlier purchase is in that state, and
   * the reconciler sends them with `intent: 'restore'` so the backend's
   * restore sharing can grant them to this player (RFC "Restore sharing").
   * Consumables, unmapped SKUs, and kind mismatches stay filtered. A store
   * without such a filter ignores it.
   */
  readonly restore?: boolean;
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
  /**
   * Trusted native presentation facts for the purchase UI (opened, closed,
   * never started), independent of the purchase result. A provider whose host
   * can prove when its payment surface closes (ONE play) offers it; the game
   * runtime's presentation gate subscribes when present and treats a result
   * alone as unknown.
   */
  readonly presentation?: {
    subscribe(listener: (event: PlatformPurchasePresentationEvent) => void): () => void;
  };
  getCapabilities(): Promise<CommerceCapabilities>;
  fetchProducts(input: FetchProductsInput): Promise<readonly StoreProduct[]>;
  /** Returns `launched` when the result arrives later as a `purchaseUpdated` event. */
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  /** Purchases the store still reports as unfinished. */
  getAvailablePurchases(input?: GetAvailablePurchasesInput): Promise<readonly StorePurchase[]>;
  /**
   * Required when `lifecycle.finish` is 'client' or 'host'. Idempotent per
   * transaction: the reconciler calls it again after a crash between a
   * successful finish and its journal write, and on every pass while a
   * finish keeps failing, so finishing an already finished transaction
   * answers `{ finished: true }` rather than failing.
   */
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
  readonly logicalId: CommerceLogicalProductId;
  readonly subscriptionId: NonEmptyString;
  readonly periodIndex: NonNegativeInteger;
  readonly state: ActiveSubscriptionState;
  readonly startedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly autoRenew: boolean;
}

/** What the backend accepts for one store (RFC "Provider capabilities endpoint"). */
export interface CommerceServiceStoreCapabilities {
  readonly store: StoreId;
  /** Evidence schemas the backend routes for this store. */
  readonly schemas: readonly NonEmptyString[];
  /** Who finishes a granted purchase of this store, as the backend expects it. */
  readonly finish: CommerceFinishOwner;
  readonly purchase: {
    readonly consumable: boolean;
    readonly durable: boolean;
    readonly subscription: boolean;
  };
}

/**
 * The backend's published commerce capabilities (RFC "Provider capabilities
 * endpoint"): the protocol version it speaks and one row per store its
 * evidence registry accepts. The client runtime compares it with its
 * provider's capability block at start.
 */
export interface CommerceServiceCapabilities {
  readonly commerceProtocolVersion: NonEmptyString;
  readonly stores: readonly CommerceServiceStoreCapabilities[];
}

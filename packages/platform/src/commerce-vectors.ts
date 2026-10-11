import typia, { type tags } from 'typia';

import type {
  ActiveSubscriptionState,
  CommerceAuthorityCapabilities,
  CommerceBillingAuthority,
  CommerceErrorCode,
  CommerceLifecycleCapabilities,
  CommerceLogicalProductId,
  CommercePurchaseCapabilities,
  CommercePurchaseState,
  CreditLotOrigin,
  CreditLotSpendScope,
  CreditMembershipTerms,
  PurchaseKind,
  PurchaseSource,
  StorePurchaseState,
} from './commerce.js';

/**
 * Conformance vector format for docs/specs/commerce/vectors/*.json. A3 adds
 * the runner; A2 fixes the file shape so every provider and the reference
 * runtime read the same fixtures. Step inputs are fixture shorthand: the
 * runner fills the profile's store, quantity 1, request source `shop`, and
 * fake evidence before calling the typed provider.
 */

type NonEmptyString = string & tags.MinLength<1>;
type IsoTimestamp = string & tags.Format<'date-time'>;
type NonNegativeInteger = number & tags.Type<'uint32'>;

export interface CommerceConformanceProfile {
  readonly store: NonEmptyString;
  /** Omitted blocks default to all supported. */
  readonly purchase?: CommercePurchaseCapabilities;
  readonly lifecycle?: CommerceLifecycleCapabilities;
  readonly authority?: CommerceAuthorityCapabilities;
}

export interface CommerceConformanceCatalogEntry {
  readonly logicalId: CommerceLogicalProductId;
  readonly kind: PurchaseKind;
  readonly storeSku: NonEmptyString;
  /** Membership terms for credit-funded subscription products. */
  readonly membership?: CreditMembershipTerms;
}

export interface CommerceConformanceWallet {
  readonly currencies: readonly NonEmptyString[] & tags.MinItems<1>;
  readonly billingAuthority: CommerceBillingAuthority;
}

/** Fixture purchase; `store`, `quantity`, and `evidence` come from the profile. */
export interface CommerceConformancePurchaseFixture {
  readonly transactionId: NonEmptyString;
  readonly storeSku: NonEmptyString;
  readonly token: NonEmptyString;
  readonly state: StorePurchaseState;
  readonly originalTransactionId?: NonEmptyString;
  readonly purchasedAt?: IsoTimestamp;
  readonly settlement?: { readonly ledgerEntryId: NonEmptyString };
}

/** Explicit normalized class; the runner never guesses it from `storeCode`. */
export interface CommerceConformanceErrorFixture {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  readonly storeCode?: string;
}

/** Partial expectation; omitted fields are not assertions. */
export interface CommerceConformanceErrorExpectation {
  readonly code: CommerceErrorCode;
  readonly retryable?: boolean;
  readonly storeCode?: string;
}

export type CommerceConformanceRequestResultFixture =
  | { readonly outcome: 'launched' }
  | { readonly outcome: 'purchased'; readonly purchase: CommerceConformancePurchaseFixture }
  | { readonly outcome: 'cancelled' | 'failed'; readonly error: CommerceConformanceErrorFixture };

export type CommerceConformanceFinishResultFixture =
  | { readonly finished: boolean }
  | { readonly error: CommerceErrorCode };

export interface CommerceConformanceVerifyDecision {
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly ledgerEntryId?: NonEmptyString;
  readonly finalization?: 'pending' | 'completed';
  readonly alreadyProcessed?: boolean;
}

export interface CommerceConformanceLotFixture {
  readonly ledgerEntryId: NonEmptyString;
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
  readonly origin: CreditLotOrigin;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export interface CommerceConformanceSpendInput {
  readonly titleId: NonEmptyString;
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
  readonly idempotencyKey: NonEmptyString;
}

export interface CommerceConformanceDebitExpectation {
  readonly lotId: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
}

export interface CommerceConformanceSpendExpectation {
  readonly status: 'debited' | 'rejected';
  readonly debits?: readonly CommerceConformanceDebitExpectation[];
  readonly alreadyProcessed?: boolean;
  readonly error?: CommerceConformanceErrorExpectation;
}

export interface CommerceConformanceRequestPurchaseExpectation {
  readonly outcome: 'launched' | 'purchased' | 'cancelled' | 'failed';
  readonly error?: CommerceConformanceErrorExpectation;
}

export interface CommerceConformanceFetchProductsExpectation {
  readonly logicalIds: readonly CommerceLogicalProductId[];
}

export type CommerceConformanceStep =
  | { readonly actor: 'runtime'; readonly action: 'start' | 'stop' | 'reconcile' }
  | {
      readonly actor: 'game';
      readonly action: 'requestPurchase';
      readonly input: {
        readonly logicalId: CommerceLogicalProductId;
        readonly idempotencyKey: NonEmptyString;
        readonly source?: PurchaseSource;
        readonly offerId?: NonEmptyString;
        readonly quantity?: number & tags.Type<'uint32'> & tags.Minimum<1>;
      };
      readonly returns?: CommerceConformanceRequestPurchaseExpectation;
    }
  | {
      readonly actor: 'game';
      readonly action: 'fetchProducts';
      readonly input?: {
        readonly logicalIds?: readonly CommerceLogicalProductId[];
        readonly type?: 'in-app' | 'subscription' | 'all';
      };
      readonly returns?: CommerceConformanceFetchProductsExpectation;
    }
  | {
      readonly actor: 'store';
      readonly action: 'complete' | 'update';
      readonly purchase: CommerceConformancePurchaseFixture;
    }
  | {
      readonly actor: 'store';
      readonly action: 'error';
      readonly logicalId?: CommerceLogicalProductId;
      readonly error: CommerceConformanceErrorFixture;
    }
  | {
      readonly actor: 'store';
      readonly action: 'queueRequest';
      readonly result: CommerceConformanceRequestResultFixture;
    }
  | {
      readonly actor: 'store';
      readonly action: 'queueFinish';
      readonly result: CommerceConformanceFinishResultFixture;
    }
  | {
      readonly actor: 'backend';
      readonly action: 'queueVerify';
      readonly decision: CommerceConformanceVerifyDecision;
    }
  | {
      readonly actor: 'backend';
      readonly action: 'push';
      readonly transactionId: NonEmptyString;
      readonly entryId: NonEmptyString;
      readonly logicalId: CommerceLogicalProductId;
    }
  | {
      readonly actor: 'backend';
      readonly action: 'revoke';
      readonly ledgerEntryId: NonEmptyString;
      readonly entryId: NonEmptyString;
      readonly reason: NonEmptyString;
    }
  | {
      readonly actor: 'wallet';
      readonly action: 'creditFromGrant';
      readonly lot: CommerceConformanceLotFixture;
    }
  | {
      readonly actor: 'wallet';
      readonly action: 'spend';
      readonly input: CommerceConformanceSpendInput;
      readonly returns?: CommerceConformanceSpendExpectation;
    }
  | { readonly actor: 'wallet'; readonly action: 'renewDue' }
  | { readonly actor: 'clock'; readonly action: 'set'; readonly at: IsoTimestamp };

export type CommerceConformanceActor = CommerceConformanceStep['actor'];
export type CommerceConformanceAction = CommerceConformanceStep['action'];

export interface CommerceConformanceVerifyRequestExpectation {
  readonly idempotencyKey: NonEmptyString;
  readonly store: NonEmptyString;
  readonly transactionId: NonEmptyString;
  readonly token: NonEmptyString;
}

export interface CommerceConformanceLedgerEntryExpectation {
  readonly entryId: NonEmptyString;
  readonly type: 'grant' | 'revoke' | 'period';
  readonly logicalId: CommerceLogicalProductId;
  /** The grant a `revoke` entry reverses. */
  readonly reverses?: NonEmptyString;
  readonly reason?: NonEmptyString;
}

export interface CommerceConformanceFinishCallExpectation {
  readonly by: 'client' | 'host';
  readonly transactionId: NonEmptyString;
  readonly ledgerEntryId: NonEmptyString;
  readonly isConsumable: boolean;
  readonly result: 'finished' | CommerceErrorCode;
}

export interface CommerceConformanceAvailableExpectation {
  readonly transactionId: NonEmptyString;
  readonly storeSku?: NonEmptyString;
  readonly state?: StorePurchaseState;
}

export interface CommerceConformanceEntitlementExpectation {
  readonly id: NonEmptyString;
  readonly logicalId?: CommerceLogicalProductId;
}

export interface CommerceConformanceLotExpectation {
  readonly lotId: NonEmptyString;
  readonly currency?: NonEmptyString;
  readonly amount?: number & tags.ExclusiveMinimum<0>;
  readonly remaining: number & tags.Minimum<0>;
  readonly origin?: CreditLotOrigin;
  readonly spendScope?: CreditLotSpendScope;
}

export interface CommerceConformanceScheduledDebitExpectation {
  readonly idempotencyKey: NonEmptyString;
  readonly lotId: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
}

export type CommerceConformanceSubscriptionEventType =
  | 'subscriptionStarted'
  | 'subscriptionRenewed'
  | 'subscriptionLapsed'
  | 'subscriptionRevoked';

export interface CommerceConformanceSubscriptionEventExpectation {
  readonly type: CommerceConformanceSubscriptionEventType;
  readonly logicalId: CommerceLogicalProductId;
  readonly periodIndex: NonNegativeInteger;
  readonly expiresAt: IsoTimestamp;
  readonly reason?: CommerceErrorCode;
}

export interface CommerceConformanceActiveSubscriptionExpectation {
  readonly logicalId: CommerceLogicalProductId;
  readonly periodIndex?: NonNegativeInteger;
  readonly state?: ActiveSubscriptionState;
  readonly expiresAt?: IsoTimestamp;
}

export interface CommerceConformanceExpectation {
  /** Full state sequence per journal key. */
  readonly journal?: Readonly<Record<string, readonly CommercePurchaseState[]>>;
  readonly verifyRequests?: readonly CommerceConformanceVerifyRequestExpectation[];
  readonly ledger?: readonly CommerceConformanceLedgerEntryExpectation[];
  readonly finishCalls?: readonly CommerceConformanceFinishCallExpectation[];
  readonly available?: readonly CommerceConformanceAvailableExpectation[];
  readonly entitlements?: readonly CommerceConformanceEntitlementExpectation[];
  readonly lots?: readonly CommerceConformanceLotExpectation[];
  /** Spendable balance per title and currency. */
  readonly balances?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly debits?: readonly CommerceConformanceScheduledDebitExpectation[];
  readonly events?: readonly CommerceConformanceSubscriptionEventExpectation[];
  readonly activeSubscriptions?: readonly CommerceConformanceActiveSubscriptionExpectation[];
  readonly purchaseUiOpened?: NonNegativeInteger;
}

export interface CommerceConformanceVector {
  /** Equals the file name without `.json`. */
  readonly vector: string & tags.Pattern<'^[a-z0-9]+(?:-[a-z0-9]+)*$'>;
  readonly protocol: NonEmptyString;
  readonly summary: NonEmptyString;
  readonly profile: CommerceConformanceProfile;
  readonly catalog?: readonly CommerceConformanceCatalogEntry[];
  readonly wallet?: CommerceConformanceWallet;
  readonly steps: readonly CommerceConformanceStep[] & tags.MinItems<1>;
  readonly expect: CommerceConformanceExpectation;
}

const assertCommerceConformanceVectorShape = typia.createAssertEquals<CommerceConformanceVector>();

/** Validates one vector file. Catalog logical ids must be unique. */
export function assertCommerceConformanceVector(input: unknown): CommerceConformanceVector {
  const vector = assertCommerceConformanceVectorShape(input);
  const logicalIds = new Set<string>();
  for (const entry of vector.catalog ?? []) {
    if (logicalIds.has(entry.logicalId)) {
      throw new TypeError(`Vector ${vector.vector} declares ${entry.logicalId} twice.`);
    }
    logicalIds.add(entry.logicalId);
  }
  return vector;
}

export function isCommerceConformanceVector(input: unknown): input is CommerceConformanceVector {
  try {
    assertCommerceConformanceVector(input);
    return true;
  } catch {
    return false;
  }
}

/** The vector name a file at `path` must declare. */
export function commerceConformanceVectorNameOf(path: string): string {
  const fileName = path.split(/[\\/]/u).pop() ?? path;
  return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
}

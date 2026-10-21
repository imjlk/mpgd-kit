import typia, { type tags } from 'typia';

import {
  assertActiveSubscription,
  assertCreditEntitlement,
  assertCreditOffer,
  assertCreditSpendResult,
  assertRequestPurchaseSupported,
  CommerceError,
  commerceErrorInfoOf,
  createCommerceEventBuffer,
  type ActiveSubscription,
  type CommerceAuthorityCapabilities,
  type CommerceBillingAuthority,
  type CommerceCapabilities,
  type CommerceCatalogCapabilities,
  type CommerceErrorCode,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceLifecycleCapabilities,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseCapabilities,
  type CreditDebit,
  type CreditEntitlement,
  type CreditLot,
  type CreditLotOrigin,
  type CreditLotSpendScope,
  type CreditMembershipScope,
  type CreditMembershipTerms,
  type CreditOffer,
  type CreditSpendInput,
  type CreditSpendResult,
  type CreditWalletClient,
  type CreditWalletSubscribeInput,
  type FetchProductsInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
} from './commerce.js';
import type { IsoTimestamp, NonEmptyString, NonNegativeInteger } from './commerce-contract.js';
import type { PlatformEvidenceEnvelope, PlatformProviderAvailability } from './index.js';

/**
 * Commerce v2 credit wallet contract (RFC "Credit wallet", "Credit lots",
 * "Billing authority and memberships", "Subscriptions"). The consuming
 * project implements `CreditWalletClient` against its own wallet service;
 * this module supplies the rules both sides share, the provider that turns a
 * client into a `CommerceProvider`, and a reference in-memory wallet that the
 * conformance runner and consumer tests can run the wallet vectors against.
 * Pure in-process code: no Phaser, DOM, network, or SDK imports. Nothing here
 * grants: a spend debits the wallet's own lots, the entitlement it creates is
 * a pointer the reconciler still verifies with the ledger, and a lot is
 * credited only from a ledger grant keyed by its entry id.
 */

// The wallet shapes were fixed by A2 in `./commerce`; they are re-exported so
// `@mpgd/platform/commerce-wallet` is the one import site for wallet work.
export type {
  CommerceBillingAuthority,
  CreditBalance,
  CreditDebit,
  CreditEntitlement,
  CreditLot,
  CreditLotChannel,
  CreditLotOrigin,
  CreditLotSpendScope,
  CreditMembershipScope,
  CreditMembershipTerms,
  CreditOffer,
  CreditPrice,
  CreditSpendInput,
  CreditSpendResult,
  CreditWalletClient,
  CreditWalletSubscribeInput,
} from './commerce.js';
export {
  assertCreditBalance,
  assertCreditEntitlement,
  assertCreditLot,
  assertCreditOffer,
  assertCreditSpendInput,
  assertCreditSpendResult,
} from './commerce.js';

// Timestamps and periods.

/** Canonical `YYYY-MM-DDTHH:mm:ssZ`; milliseconds are kept only when non-zero. */
export function normalizeIsoTimestamp(input: string): string {
  const millis = Date.parse(input);
  if (Number.isNaN(millis)) {
    throw new TypeError(`Invalid ISO-8601 timestamp: ${input}`);
  }
  return formatIsoTimestamp(millis);
}

function formatIsoTimestamp(millis: number): string {
  const iso = new Date(millis).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

const isoDurationPattern =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;

/** The integer components of an ISO-8601 duration (`P1Y2M3W4DT5H6M7S`). */
export interface IsoDurationParts {
  readonly years: number;
  readonly months: number;
  readonly weeks: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

/**
 * Parses a positive ISO-8601 duration a membership period accepts (`P30D`,
 * `P1M`, `PT12H`, ...). Zero-length durations (`P0D`, `PT0S`), a bare `P` or
 * `PT`, and a `T` with no time components are rejected, so a period can
 * never renew without time passing.
 */
export function parseIsoDuration(duration: string): IsoDurationParts | undefined {
  if (typeof duration !== 'string' || duration.endsWith('T')) {
    return undefined;
  }
  const match = isoDurationPattern.exec(duration);
  if (match === null) {
    return undefined;
  }
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const parts: IsoDurationParts = {
    years: Number(years ?? 0),
    months: Number(months ?? 0),
    weeks: Number(weeks ?? 0),
    days: Number(days ?? 0),
    hours: Number(hours ?? 0),
    minutes: Number(minutes ?? 0),
    seconds: Number(seconds ?? 0),
  };
  const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return total > 0 && Number.isFinite(total) ? parts : undefined;
}

export function isIsoDuration(duration: string): boolean {
  return parseIsoDuration(duration) !== undefined;
}

/**
 * Adds `times` ISO-8601 durations to a timestamp in UTC. Years and months are
 * calendar months with the day clamped to the target month's length
 * (`2026-01-31` + `P1M` is `2026-02-28`), so a membership's periods are
 * anchored on its start date: period `n` ends at `startedAt + (n + 1) × period`
 * rather than drifting from the previous period's end.
 */
export function addIsoDuration(at: string, duration: string, times = 1): string {
  const parts = parseIsoDuration(duration);
  if (parts === undefined) {
    throw new TypeError(`Invalid ISO-8601 duration: ${duration}`);
  }
  if (!Number.isInteger(times) || times < 0) {
    throw new TypeError(`Duration multiplier ${String(times)} must be a non-negative integer.`);
  }
  const date = new Date(normalizeIsoTimestamp(at));
  const months = times * (parts.years * 12 + parts.months);
  if (months > 0) {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
      .getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  const millis = times * (
    (parts.weeks * 7 + parts.days) * 86_400_000
    + parts.hours * 3_600_000
    + parts.minutes * 60_000
    + parts.seconds * 1_000
  );
  return formatIsoTimestamp(date.getTime() + millis);
}

// Billing authority.

/** Profiles whose distribution requires store billing for digital goods; their authority is always `store`. */
export const storeBillingAuthorityProfiles = Object.freeze(['google-play', 'app-store'] as const);

/** Profiles whose authority defaults to `host`; every other profile defaults to `store`. */
export const hostBillingAuthorityProfiles = Object.freeze(['web', 'web-preview'] as const);

export function isCommerceBillingAuthority(value: unknown): value is CommerceBillingAuthority {
  return value === 'store' || value === 'host';
}

/** The RFC default for a release profile before any project override. */
export function defaultCommerceBillingAuthority(profile: string): CommerceBillingAuthority {
  return (hostBillingAuthorityProfiles as readonly string[]).includes(profile) ? 'host' : 'store';
}

/**
 * Resolves a target's billing authority from its release profile. `google-play`
 * and `app-store` are always `store` and reject a `host` override (D-02: both
 * stores require their own billing for digital entitlements). `web` and
 * `web-preview` default to `host`, every other profile to `store`, and a
 * project may override those after its own policy review.
 */
export function resolveCommerceBillingAuthority(
  profile: string,
  override?: CommerceBillingAuthority,
): CommerceBillingAuthority {
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError('A release profile is required to resolve the billing authority.');
  }
  if (override !== undefined && !isCommerceBillingAuthority(override)) {
    throw new TypeError(`Billing authority override ${String(override)} must be store or host.`);
  }
  if ((storeBillingAuthorityProfiles as readonly string[]).includes(profile)) {
    if (override === 'host') {
      throw new RangeError(
        `Release profile ${profile} requires store billing; billing authority host is not allowed.`,
      );
    }
    return 'store';
  }
  return override ?? defaultCommerceBillingAuthority(profile);
}

// Credit scope registry and lot spend scope.

export type CreditScope = 'title' | 'cross-title';

/**
 * `creditScope` per store id: which stores count as off-store, so their lots
 * are spendable across titles. Absent entries are `title`; the kit's reference
 * stores keep that default.
 */
export type CreditScopeRegistry = Readonly<Record<string, CreditScope>>;

/** Stores whose lots are always title-scoped; neither a registry nor a promotion can make them `cross-title`. */
export const titleScopedCreditStores = Object.freeze(['google-play', 'app-store'] as const);

export function isTitleScopedCreditStore(store: string): boolean {
  return (titleScopedCreditStores as readonly string[]).includes(store);
}

/** Rejects a registry that marks Google Play or the App Store `cross-title`, or holds an unknown scope. */
export function assertCreditScopeRegistry(registry: CreditScopeRegistry): CreditScopeRegistry {
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    throw new TypeError('A credit scope registry must be an object keyed by store id.');
  }
  for (const [store, scope] of Object.entries(registry)) {
    if (scope !== 'title' && scope !== 'cross-title') {
      throw new TypeError(`Credit scope for store ${store} must be title or cross-title.`);
    }
    if (scope === 'cross-title' && isTitleScopedCreditStore(store)) {
      throw new RangeError(
        `Store ${store} cannot be marked cross-title; its lots stay title-scoped.`,
      );
    }
  }
  return registry;
}

export const assertCreditLotSpendScope = typia.createAssertEquals<CreditLotSpendScope>();

export interface DeriveCreditLotSpendScopeOptions {
  /** Scope a promotion lot was issued with; rejected for store and off-store lots, whose scope is derived. */
  readonly explicit?: CreditLotSpendScope;
  readonly creditScope?: CreditScopeRegistry;
}

/**
 * Derives a lot's `spendScope` from its origin (RFC "Credit lots"): a lot
 * bought through a store is `title`-scoped to its purchasing title, an
 * off-store lot is `cross-title`, and a promotion lot carries the scope it was
 * issued with (`title` by default). A registry entry overrides the channel for
 * store and off-store lots. A lot attributed to Google Play or the App Store is
 * always `title`, whatever the channel, registry, or issued scope says.
 */
export function deriveCreditLotSpendScope(
  origin: CreditLotOrigin,
  options: DeriveCreditLotSpendScopeOptions = {},
): CreditLotSpendScope {
  const title: CreditLotSpendScope = { kind: 'title', titleId: origin.titleId };
  const registry = options.creditScope === undefined
    ? undefined
    : assertCreditScopeRegistry(options.creditScope);
  if (origin.channel === 'promotion') {
    if (options.explicit === undefined) {
      return title;
    }
    const explicit = assertCreditLotSpendScope(options.explicit);
    if (explicit.kind === 'cross-title' && isTitleScopedCreditStore(origin.store)) {
      throw new RangeError(`A promotion lot attributed to ${origin.store} cannot be cross-title.`);
    }
    return { ...explicit };
  }
  if (options.explicit !== undefined) {
    throw new TypeError(
      `A ${origin.channel} lot derives its spend scope; only promotion lots declare one.`,
    );
  }
  if (isTitleScopedCreditStore(origin.store)) {
    return title;
  }
  const registered = registry !== undefined
    && Object.prototype.hasOwnProperty.call(registry, origin.store)
    ? registry[origin.store]
    : undefined;
  const scope = registered ?? (origin.channel === 'off-store' ? 'cross-title' : 'title');
  return scope === 'cross-title' ? { kind: 'cross-title' } : title;
}

// Lot selection and spend order.

/** RFC spend order: earliest `expiresAt` (none last), `title` before `cross-title`, oldest `createdAt`, then `lotId`. */
export function compareCreditLotSpendOrder(left: CreditLot, right: CreditLot): number {
  const leftExpiry = left.expiresAt === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(left.expiresAt);
  const rightExpiry = right.expiresAt === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(right.expiresAt);
  if (leftExpiry !== rightExpiry) {
    return leftExpiry < rightExpiry ? -1 : 1;
  }
  if (left.spendScope.kind !== right.spendScope.kind) {
    return left.spendScope.kind === 'title' ? -1 : 1;
  }
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta < 0 ? -1 : 1;
  }
  return left.lotId < right.lotId ? -1 : left.lotId > right.lotId ? 1 : 0;
}

export interface CreditLotEligibility {
  readonly titleId: string;
  readonly currency: string;
  /**
   * `title` (the default) spends that title's lots and `cross-title` lots;
   * `platform` spends `cross-title` lots only, as a platform-scoped membership
   * does.
   */
  readonly scope?: CreditMembershipScope;
  /** ISO-8601 timestamp or epoch milliseconds; a lot whose `expiresAt` is not after it is excluded. */
  readonly now: string | number;
  /**
   * When set, a lot created after this instant is excluded. A catch-up
   * renewal passes the boundary of the period it pays for, so credits granted
   * after that period ended cannot fund it retroactively.
   */
  readonly createdBy?: string | number;
}

/** Whether a lot may fund a spend: same currency, credit left, not expired, and in scope. */
export function isCreditLotEligible(lot: CreditLot, criteria: CreditLotEligibility): boolean {
  const now = typeof criteria.now === 'number' ? criteria.now : Date.parse(criteria.now);
  if (Number.isNaN(now)) {
    throw new TypeError(`Invalid ISO-8601 timestamp: ${String(criteria.now)}`);
  }
  if (lot.currency !== criteria.currency || !(lot.remaining > 0)) {
    return false;
  }
  if (lot.expiresAt !== undefined && !(Date.parse(lot.expiresAt) > now)) {
    return false;
  }
  if (criteria.createdBy !== undefined) {
    const createdBy = typeof criteria.createdBy === 'number'
      ? criteria.createdBy
      : Date.parse(criteria.createdBy);
    if (Number.isNaN(createdBy)) {
      throw new TypeError(`Invalid ISO-8601 timestamp: ${String(criteria.createdBy)}`);
    }
    if (!(Date.parse(lot.createdAt) <= createdBy)) {
      return false;
    }
  }
  if (lot.spendScope.kind === 'cross-title') {
    return true;
  }
  return (criteria.scope ?? 'title') === 'title' && lot.spendScope.titleId === criteria.titleId;
}

/** The eligible lots of a spend in the order they are consumed; the input is not mutated. */
export function selectEligibleCreditLots(
  lots: readonly CreditLot[],
  criteria: CreditLotEligibility,
): readonly CreditLot[] {
  return lots.filter((lot) => isCreditLotEligible(lot, criteria)).sort(compareCreditLotSpendOrder);
}

export function sumCreditLotRemaining(lots: readonly CreditLot[]): number {
  return lots.reduce((sum, lot) => sum + lot.remaining, 0);
}

export function sumCreditDebits(debits: readonly CreditDebit[]): number {
  return debits.reduce((sum, debit) => sum + debit.amount, 0);
}

/**
 * Relative scale for credit-amount comparisons. Amounts may be fractional, so
 * equality allows float noise, but the noise is a fraction of the amount. An
 * absolute 1e-9 would treat a price of 1e-9 as already paid (`sameCreditAmount(0, 1e-9)`).
 */
const creditAmountEpsilon = 1e-9;

/**
 * True when two credit amounts differ only by relative float noise.
 * The gap cannot be the whole amount, so a zero and a positive price are not equal.
 */
export function sameCreditAmount(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  const difference = Math.abs(left - right);
  const scale = Math.max(Math.abs(left), Math.abs(right));
  if (scale === 0) {
    return true;
  }
  return difference <= creditAmountEpsilon * scale;
}

/**
 * True when `paid` meets `price`. A shortfall of the whole price is never met.
 * Float noise may leave `paid` above `price`, or a relative sliver under it
 * that cannot be the price itself. Zero does not meet a positive price, so an
 * empty debit list is not a spend.
 */
function creditAmountCovers(paid: number, price: number): boolean {
  if (!Number.isFinite(paid) || !Number.isFinite(price) || !(paid > 0) || !(price > 0)) {
    return false;
  }
  if (paid >= price) {
    return true;
  }
  const shortfall = price - paid;
  return shortfall < price && shortfall <= creditAmountEpsilon * price;
}

/** The whole number of `unit` prices in `amount`, or `undefined` when `amount` does not cover a positive multiple. */
export function creditPriceMultiple(amount: number, unit: number): number | undefined {
  if (!(unit > 0) || !(amount > 0) || !Number.isFinite(amount) || !Number.isFinite(unit)) {
    return undefined;
  }
  const multiple = Math.round(amount / unit);
  if (!Number.isFinite(multiple) || multiple < 1) {
    return undefined;
  }
  const product = multiple * unit;
  // `amount` must cover the units. Relative noise may put `product` slightly
  // above `amount`; an absolute gap is not a whole number of units.
  if (!creditAmountCovers(amount, product) || !sameCreditAmount(product, amount)) {
    return undefined;
  }
  return multiple;
}

export type CreditDebitPlan =
  | { readonly status: 'debited'; readonly debits: readonly CreditDebit[] }
  | { readonly status: 'rejected'; readonly error: CommerceErrorInfo };

/**
 * Plans the debits of `amount` across eligible lots in spend order without
 * mutating them. A spend the lots cannot cover is rejected with
 * `INSUFFICIENT_BALANCE` and plans nothing. A shortfall is never a debit,
 * including one within an absolute 1e-9, and an empty debit list is not a
 * debit of a positive amount.
 */
export function planCreditDebits(eligible: readonly CreditLot[], amount: number): CreditDebitPlan {
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      status: 'rejected',
      error: {
        code: 'INVALID_RESPONSE',
        retryable: false,
        message: 'Spend amount must be a positive number.',
      },
    };
  }
  const insufficient = (available: number): CreditDebitPlan => ({
    status: 'rejected',
    error: {
      code: 'INSUFFICIENT_BALANCE',
      retryable: false,
      message: `Eligible balance ${available} cannot cover ${amount}.`,
    },
  });
  const ordered = [...eligible].sort(compareCreditLotSpendOrder);
  const available = sumCreditLotRemaining(ordered);
  if (!creditAmountCovers(available, amount)) {
    return insufficient(available);
  }
  const debits: CreditDebit[] = [];
  let remaining = amount;
  for (const lot of ordered) {
    if (!(remaining > 0)) {
      break;
    }
    const debit = Math.min(lot.remaining, remaining);
    if (!(debit > 0)) {
      continue;
    }
    debits.push({ lotId: lot.lotId, amount: debit });
    remaining -= debit;
  }
  const paid = sumCreditDebits(debits);
  // The loop must not report a debit it did not take. A positive price with
  // an empty list, or a sum that does not cover, is still insufficient.
  if (debits.length === 0 || !creditAmountCovers(paid, amount)) {
    return insufficient(paid);
  }
  return { status: 'debited', debits };
}

// Membership keys and subscription events.

/** Prefix of every scheduled membership debit key; a client spend cannot use it. */
export const membershipDebitKeyPrefix = 'membership:';

/** `membership:<subscriptionId>:<periodIndex>`, so a repeated scheduler tick cannot charge a period twice. */
export function createMembershipRenewalKey(subscriptionId: string, periodIndex: number): string {
  assertSubscriptionId(subscriptionId);
  assertPeriodIndex(periodIndex);
  return `${membershipDebitKeyPrefix}${subscriptionId}:${periodIndex}`;
}

export type CreditSubscriptionEventType =
  | 'subscriptionStarted'
  | 'subscriptionRenewed'
  | 'subscriptionLapsed'
  | 'subscriptionRevoked';

export const creditSubscriptionEventTypes = Object.freeze([
  'subscriptionStarted',
  'subscriptionRenewed',
  'subscriptionLapsed',
  'subscriptionRevoked',
] as const satisfies readonly CreditSubscriptionEventType[]);

/** `<subscriptionId>:<periodIndex>:<type>`, so redelivery of a lifecycle event is idempotent. */
export function createCreditSubscriptionEventId(
  subscriptionId: string,
  periodIndex: number,
  type: CreditSubscriptionEventType,
): string {
  assertSubscriptionId(subscriptionId);
  assertPeriodIndex(periodIndex);
  if (!(creditSubscriptionEventTypes as readonly string[]).includes(type)) {
    throw new TypeError(`Unknown subscription event type ${String(type)}.`);
  }
  return `${subscriptionId}:${periodIndex}:${type}`;
}

/** A membership lifecycle event as the wallet service records and pushes it. */
export interface CreditSubscriptionEvent {
  readonly eventId: NonEmptyString;
  readonly type: CreditSubscriptionEventType;
  readonly subscriptionId: NonEmptyString;
  readonly logicalId: CommerceLogicalProductId;
  readonly periodIndex: NonNegativeInteger;
  readonly expiresAt: IsoTimestamp;
  /** Why a membership lapsed, for example INSUFFICIENT_BALANCE. */
  readonly reason?: CommerceErrorCode;
}

function assertSubscriptionId(subscriptionId: string): void {
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    throw new TypeError('A subscription id is required.');
  }
}

function assertPeriodIndex(periodIndex: number): void {
  if (!Number.isInteger(periodIndex) || periodIndex < 0) {
    throw new TypeError(`Period index ${String(periodIndex)} must be a non-negative integer.`);
  }
}

// Wallet-side shapes shared by the reference wallet and consumer wallet services.

/** A ledger grant the wallet owner credits as a lot; `ledgerEntryId` becomes the `lotId`. */
export interface CreditLotGrant {
  readonly ledgerEntryId: NonEmptyString;
  readonly currency: NonEmptyString;
  readonly amount: number & tags.ExclusiveMinimum<0>;
  readonly origin: CreditLotOrigin;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

/** A debit with the idempotency key of the spend that made it. */
export interface CreditScheduledDebit extends CreditDebit {
  readonly idempotencyKey: NonEmptyString;
}

export interface CreditRedeemInput {
  readonly entitlementId: NonEmptyString;
  /** The ledger entry that granted the entitlement; a redeem without one is refused. */
  readonly ledgerEntryId: NonEmptyString;
}

export interface CreditMembershipStartInput {
  readonly subscriptionId: NonEmptyString;
  readonly titleId: NonEmptyString;
  readonly logicalId: CommerceLogicalProductId;
  readonly terms: CreditMembershipTerms;
}

export type CreditMembershipStartResult =
  | {
      readonly status: 'started';
      readonly subscription: ActiveSubscription;
      /** The period-0 entitlement, `membership:<subscriptionId>:0`. */
      readonly entitlementId: NonEmptyString;
      readonly debits: readonly CreditDebit[];
      readonly createdAt: IsoTimestamp;
      /** The id was already started with these terms; the original period-0 debits are returned. */
      readonly alreadyProcessed?: boolean;
    }
  | { readonly status: 'rejected'; readonly error: CommerceErrorInfo };

/** The `CreditSpendResult` a membership start answers a `spend` with. */
export function creditSpendResultOfMembershipStart(
  result: CreditMembershipStartResult,
): CreditSpendResult {
  if (result.status === 'rejected') {
    return result;
  }
  return {
    status: 'debited',
    entitlementId: result.entitlementId,
    debits: [...result.debits],
    createdAt: result.createdAt,
    ...(result.alreadyProcessed === true ? { alreadyProcessed: true } : {}),
  };
}

export const assertCreditLotGrant = typia.createAssertEquals<CreditLotGrant>();
export const assertCreditMembershipTerms = typia.createAssertEquals<CreditMembershipTerms>();
export const assertCreditRedeemInput = typia.createAssertEquals<CreditRedeemInput>();
export const assertCreditSubscriptionEvent = typia.createAssertEquals<CreditSubscriptionEvent>();
export const assertCreditMembershipStartInput =
  typia.createAssertEquals<CreditMembershipStartInput>();

/**
 * `assertCreditOffer` plus the wallet rules an offer must satisfy: membership
 * terms only on a `subscription` offer, every `subscription` offer with terms,
 * a valid positive period, and a membership priced as its terms say.
 */
export function assertCreditWalletOffer(input: unknown): CreditOffer {
  const offer = assertCreditOffer(input);
  if (offer.membership !== undefined && offer.kind !== 'subscription') {
    throw new TypeError(`Offer ${offer.logicalId} carries membership terms but is ${offer.kind}.`);
  }
  if (offer.membership === undefined && offer.kind === 'subscription') {
    throw new TypeError(`Subscription offer ${offer.logicalId} has no membership terms.`);
  }
  if (offer.membership !== undefined) {
    if (!isIsoDuration(offer.membership.period)) {
      throw new TypeError(
        `Offer ${offer.logicalId} period ${offer.membership.period} is not a positive ISO-8601 duration.`,
      );
    }
    if (
      offer.membership.price.currency !== offer.price.currency
      || !sameCreditAmount(offer.membership.price.amount, offer.price.amount)
    ) {
      throw new TypeError(`Offer ${offer.logicalId} is not priced as its membership terms say.`);
    }
  }
  return offer;
}

function copyOffer(offer: CreditOffer): CreditOffer {
  return {
    ...offer,
    price: { ...offer.price },
    ...(offer.membership === undefined
      ? {}
      : {
          membership: {
            scope: offer.membership.scope,
            price: { ...offer.membership.price },
            period: offer.membership.period,
          },
        }),
  };
}

// Spend evidence.

export const creditWalletSpendEvidenceSchema = 'credit-wallet.spend.v1' as const;

export interface CreditWalletSpendEvidence {
  readonly store: StoreId;
  readonly titleId: string;
  /** The wallet's own id for the settled spend (its entitlement id); not a backend ledger entry. */
  readonly entitlementId: string;
  readonly amount: number;
  readonly debits: readonly CreditDebit[];
}

/** The `adapter-settled` evidence of a wallet spend; `debits` is JSON because envelope payloads are flat. */
export function createCreditWalletSpendEvidence(
  evidence: CreditWalletSpendEvidence,
): PlatformEvidenceEnvelope {
  return {
    schema: creditWalletSpendEvidenceSchema,
    payload: {
      store: evidence.store,
      titleId: evidence.titleId,
      entitlementId: evidence.entitlementId,
      amount: evidence.amount,
      debits: JSON.stringify(
        evidence.debits.map((debit) => ({ lotId: debit.lotId, amount: debit.amount })),
      ),
    },
  };
}

const isCreditDebitList = typia.createEquals<CreditDebit[]>();

/** Reads a `credit-wallet.spend.v1` envelope; any other schema or a malformed payload is `undefined`. */
export function readCreditWalletSpendEvidence(
  envelope: PlatformEvidenceEnvelope,
): CreditWalletSpendEvidence | undefined {
  if (envelope.schema !== creditWalletSpendEvidenceSchema) {
    return undefined;
  }
  const { store, titleId, entitlementId, amount, debits } = envelope.payload;
  if (
    typeof store !== 'string'
    || typeof titleId !== 'string'
    || typeof entitlementId !== 'string'
    || typeof amount !== 'number'
    || typeof debits !== 'string'
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(debits);
  } catch {
    return undefined;
  }
  if (!isCreditDebitList(parsed)) {
    return undefined;
  }
  return { store, titleId, entitlementId, amount, debits: parsed };
}

// Provider.

export interface CreditCommerceCapabilityOverrides {
  readonly purchase?: Partial<CommercePurchaseCapabilities>;
  readonly catalog?: Partial<CommerceCatalogCapabilities>;
  readonly lifecycle?: Partial<CommerceLifecycleCapabilities>;
  readonly authority?: Partial<CommerceAuthorityCapabilities>;
  readonly availability?: PlatformProviderAvailability;
}

export interface CreateCreditCommerceProviderOptions {
  readonly titleId: string;
  readonly billingAuthority: CommerceBillingAuthority;
  /**
   * The catalog's declared currencies. An offer priced in another currency is
   * a configuration error (RFC "Catalog currencies"); omitted, no check runs.
   */
  readonly currencies?: readonly string[];
  /**
   * Overrides on the RFC wallet profile. `purchase.subscription` is forced
   * `false` where the billing authority is `store` or the client cannot
   * report active subscriptions, whatever the override.
   */
  readonly capabilities?: CreditCommerceCapabilityOverrides;
  /** Clock for `purchasedAt` when the wallet reports no settlement time; defaults to the system clock. */
  readonly now?: () => string;
}

/** A `CommerceProvider` over a wallet client that also releases its client subscription. */
export interface CreditCommerceProvider extends CommerceProvider {
  /** Unsubscribes from the client; events after this are no longer forwarded. */
  dispose(): void;
}

/**
 * The RFC profile row of a project-owned wallet, before overrides.
 * `purchase.subscription` is true only where the billing authority is `host`
 * and the caller states that the client reports active subscriptions
 * (`client.subscriptions: true`); with no client description it is `false`.
 */
export function createCreditCommerceCapabilities(
  billingAuthority: CommerceBillingAuthority,
  overrides: CreditCommerceCapabilityOverrides = {},
  client: { readonly subscriptions?: boolean } = {},
): CommerceCapabilities {
  if (!isCommerceBillingAuthority(billingAuthority)) {
    throw new TypeError(`Billing authority ${String(billingAuthority)} must be store or host.`);
  }
  const purchase: CommercePurchaseCapabilities = {
    consumable: true,
    durable: true,
    subscription: true,
    quantity: false,
    ...overrides.purchase,
  };
  return {
    purchase: {
      ...purchase,
      subscription:
        purchase.subscription && billingAuthority === 'host' && client.subscriptions === true,
    },
    catalog: { products: true, offers: false, localizedPrice: false, ...overrides.catalog },
    lifecycle: {
      availablePurchases: true,
      pending: false,
      restore: true,
      // The provider itself emits (restore re-reads), so events are on whatever the client does.
      events: true,
      finish: 'server',
      ...overrides.lifecycle,
    },
    authority: { evidence: 'adapter-settled', accountBinding: 'host', ...overrides.authority },
    availability: overrides.availability ?? 'available',
  };
}

/**
 * `CommerceProvider` over a project-owned `CreditWalletClient` (RFC "Credit
 * wallet"): `fetchProducts` lists the wallet's offers (memberships omitted
 * where the billing authority is `store`), `requestPurchase` spends the offer
 * price times the quantity under the game's idempotency key and answers
 * `purchased` with `adapter-settled` evidence (`credit-wallet.spend.v1`)
 * once the wallet's debits add up to that price, without a `settlement`
 * pointer: the backend ledger entry exists only after the reconciler verifies
 * that evidence, so there is nothing to point at yet,
 * `getAvailablePurchases` lists the title's unredeemed entitlements,
 * `finishTransaction` redeems one with the ledger entry id of its grant and
 * refuses to run without it, `restorePurchases` re-reads the unredeemed
 * entitlements as `purchaseUpdated` events, and the client's own events pass
 * through the standard pre-listener buffer. Every client answer is
 * validated; a malformed one is `INVALID_RESPONSE`. The provider never
 * grants and never credits: lots are credited by the wallet owner from
 * ledger grants, and memberships renew, lapse, and expire on the wallet
 * service alone.
 */
export function createCreditCommerceProvider(
  client: CreditWalletClient,
  options: CreateCreditCommerceProviderOptions,
): CreditCommerceProvider {
  const declaredStore = (client as Partial<CreditWalletClient> | undefined)?.store;
  if (typeof declaredStore !== 'string' || declaredStore.length === 0) {
    throw new TypeError('A credit wallet client must declare its store id.');
  }
  const declaredTitleId = (options as Partial<CreateCreditCommerceProviderOptions> | undefined)
    ?.titleId;
  if (typeof declaredTitleId !== 'string' || declaredTitleId.length === 0) {
    throw new TypeError('A credit commerce provider requires a title id.');
  }
  if (!isCommerceBillingAuthority(options.billingAuthority)) {
    throw new TypeError(
      `Billing authority ${String(options.billingAuthority)} must be store or host.`,
    );
  }
  const { store } = client;
  const { titleId, billingAuthority } = options;
  const currencies = options.currencies === undefined ? undefined : new Set(options.currencies);
  const membershipsOffered = billingAuthority === 'host';
  const subscriptionsServable = client.getActiveSubscriptions !== undefined;
  const now = (): string => normalizeIsoTimestamp(options.now?.() ?? new Date().toISOString());
  const capabilities = (): CommerceCapabilities =>
    createCreditCommerceCapabilities(billingAuthority, options.capabilities, {
      subscriptions: subscriptionsServable,
    });

  const listeners = new Set<(event: CommerceEvent) => void>();
  const buffer = createCommerceEventBuffer();
  /** Transaction ids of restore events held in the buffer, so repeated restores do not duplicate them. */
  const bufferedRestores = new Set<string>();
  /** First fallback `purchasedAt` per entitlement, for wallets that report no settlement time. */
  const fallbackPurchasedAt = new Map<string, string>();
  const purchasedAtOf = (entitlementId: string, createdAt: string | undefined): string => {
    if (createdAt !== undefined) {
      return normalizeIsoTimestamp(createdAt);
    }
    const remembered = fallbackPurchasedAt.get(entitlementId);
    if (remembered !== undefined) {
      return remembered;
    }
    const stamped = now();
    fallbackPurchasedAt.set(entitlementId, stamped);
    return stamped;
  };
  /** One listener must not stop the others, the client's callback, a restore, or a buffer drain. */
  const deliver = (listener: (event: CommerceEvent) => void, event: CommerceEvent): void => {
    try {
      listener(event);
    } catch (error) {
      console.warn('Credit wallet commerce listener failed.', describeError(error));
    }
  };
  const emit = (event: CommerceEvent): void => {
    if (listeners.size === 0) {
      buffer.push(event);
      return;
    }
    for (const listener of [...listeners]) {
      deliver(listener, event);
    }
  };
  // The client is subscribed once, up front, so wallet events emitted before the
  // provider's first listener reach that listener through the buffer.
  const unsubscribeClient = client.subscribe?.(emit, { titleId });

  const invalidResponse = (what: string, cause: unknown): CommerceError =>
    new CommerceError('INVALID_RESPONSE', {
      message: `The credit wallet client answered ${what} with an invalid value.`,
      cause,
    });
  const toCommerceError = (error: unknown): CommerceError => {
    if (error instanceof CommerceError) {
      return error;
    }
    const info = commerceErrorInfoOf(error);
    return new CommerceError(info.code, {
      retryable: info.retryable,
      ...(info.storeCode === undefined ? {} : { storeCode: info.storeCode }),
      ...(info.message === undefined ? {} : { message: info.message }),
      cause: error,
    });
  };

  /** Every offer the wallet lists, validated; memberships are not filtered here. */
  const listAllOffers = async (): Promise<readonly CreditOffer[]> => {
    let offers: readonly CreditOffer[];
    try {
      offers = await client.listOffers({ titleId });
    } catch (error) {
      throw toCommerceError(error);
    }
    if (!Array.isArray(offers)) {
      throw invalidResponse('listOffers', offers);
    }
    const validated = offers.map((offer) => {
      try {
        return assertCreditWalletOffer(offer);
      } catch (error) {
        throw invalidResponse('listOffers', error);
      }
    });
    for (const offer of validated) {
      if (currencies !== undefined && !currencies.has(offer.price.currency)) {
        throw new CommerceError('CONFIGURATION_REQUIRED', {
          message:
            `Offer ${offer.logicalId} is priced in ${offer.price.currency}, `
            + 'which the catalog does not declare.',
        });
      }
    }
    return validated;
  };
  /** Offers the provider sells: memberships only while `purchase.subscription` is declared. */
  const listOffers = async (): Promise<readonly CreditOffer[]> => {
    const sellsMemberships = capabilities().purchase.subscription;
    return (await listAllOffers()).filter(
      (offer) => offer.membership === undefined || sellsMemberships,
    );
  };

  const toProduct = (offer: CreditOffer): StoreProduct => ({
    logicalId: offer.logicalId,
    store,
    storeSku: offer.storeSku,
    kind: offer.kind,
    title: offer.title,
    description: offer.description,
    price: {
      formatted: `${offer.price.amount} ${offer.price.currency}`,
      currencyCode: offer.price.currency,
    },
  });
  const toPurchase = (input: {
    readonly offer: CreditOffer | undefined;
    readonly logicalId: CommerceLogicalProductId;
    readonly entitlementId: string;
    readonly debits: readonly CreditDebit[];
    readonly purchasedAt: string;
    readonly quantity: number;
  }): StorePurchase => ({
    store,
    transactionId: input.entitlementId,
    storeSku: input.offer?.storeSku ?? input.logicalId,
    logicalId: input.logicalId,
    quantity: input.quantity,
    state: 'purchased',
    purchasedAt: input.purchasedAt,
    token: input.entitlementId,
    evidence: createCreditWalletSpendEvidence({
      store,
      titleId,
      entitlementId: input.entitlementId,
      amount: sumCreditDebits(input.debits),
      debits: input.debits,
    }),
    accountBinding: { kind: 'host-identity' },
  });
  /**
   * The quantity recorded at spend time; the price-based derivation is a
   * fallback for wallets that record none. Either way it is advisory: the
   * backend prices a wallet purchase from the evidence's `amount` and
   * `debits`, never from this number.
   */
  const quantityOf = (entitlement: CreditEntitlement, offer: CreditOffer | undefined): number => {
    if (entitlement.quantity !== undefined) {
      return entitlement.quantity;
    }
    if (offer === undefined || offer.membership !== undefined) {
      return 1;
    }
    return creditPriceMultiple(sumCreditDebits(entitlement.debits), offer.price.amount) ?? 1;
  };
  /**
   * Offers for recovery reads. They only supply `storeSku` and the quantity
   * fallback, so a recovery read never fails because of them: a `listOffers`
   * failure counts as no offers, and a malformed or undeclared-currency offer
   * is skipped. A purchase without a valid offer is listed under its logical
   * id.
   */
  const listRecoveryOffers = async (): Promise<readonly CreditOffer[]> => {
    let offers: unknown;
    try {
      offers = await client.listOffers({ titleId });
    } catch (error) {
      console.warn('Credit wallet offers unavailable during recovery.', describeError(error));
      return [];
    }
    if (!Array.isArray(offers)) {
      console.warn('Credit wallet offers unreadable during recovery.');
      return [];
    }
    return (offers as readonly unknown[]).flatMap((candidate) => {
      try {
        const offer = assertCreditWalletOffer(candidate);
        return currencies === undefined || currencies.has(offer.price.currency) ? [offer] : [];
      } catch {
        return [];
      }
    });
  };
  /**
   * The title's unredeemed entitlements. One listed for another title, or one
   * the wallet reports malformed, is the wallet's mistake and is dropped with
   * a warning so the others still recover.
   */
  const unredeemedPurchases = async (): Promise<readonly StorePurchase[]> => {
    const offers = await listRecoveryOffers();
    let entitlements: readonly CreditEntitlement[];
    try {
      entitlements = await client.listUnredeemed({ titleId });
    } catch (error) {
      throw toCommerceError(error);
    }
    if (!Array.isArray(entitlements)) {
      throw invalidResponse('listUnredeemed', entitlements);
    }
    return entitlements.flatMap((candidate) => {
      let entitlement: CreditEntitlement;
      try {
        entitlement = assertCreditEntitlement(candidate);
      } catch (error) {
        console.warn('Credit wallet entitlement skipped during recovery.', describeError(error));
        return [];
      }
      if (entitlement.titleId !== titleId) {
        return [];
      }
      const offer = offers.find((item) => item.logicalId === entitlement.logicalId);
      return [
        toPurchase({
          offer,
          logicalId: entitlement.logicalId,
          entitlementId: entitlement.entitlementId,
          debits: entitlement.debits,
          purchasedAt: normalizeIsoTimestamp(entitlement.createdAt),
          quantity: quantityOf(entitlement, offer),
        }),
      ];
    });
  };
  const failed = (error: CommerceErrorInfo): RequestPurchaseResult => ({
    outcome: error.code === 'USER_CANCELLED' ? 'cancelled' : 'failed',
    error,
  });
  const unavailable = (message: string): RequestPurchaseResult =>
    failed(new CommerceError('ITEM_UNAVAILABLE', { message }).toCommerceErrorInfo());

  const provider: CreditCommerceProvider = {
    store,
    async getCapabilities() {
      return capabilities();
    },
    async fetchProducts(request: FetchProductsInput = {}) {
      return (await listOffers())
        .filter((offer) => matchesFetchProducts(offer, request))
        .map(toProduct);
    },
    async requestPurchase(request) {
      const offers = await listAllOffers();
      const offer = offers.find((candidate) => candidate.logicalId === request.logicalId);
      if (offer === undefined) {
        return unavailable(`The wallet offers no product ${request.logicalId}.`);
      }
      if (offer.membership !== undefined && !membershipsOffered) {
        return unavailable(
          `Membership ${offer.logicalId} is sold only where the billing authority is host.`,
        );
      }
      try {
        assertRequestPurchaseSupported(capabilities(), request, offer.kind);
      } catch (error) {
        return failed(commerceErrorInfoOf(error));
      }
      const quantity = request.quantity ?? 1;
      if (offer.membership !== undefined && quantity !== 1) {
        return unavailable('A membership is purchased one period at a time.');
      }
      const spendInput: CreditSpendInput = {
        titleId,
        currency: offer.price.currency,
        amount: offer.price.amount * quantity,
        idempotencyKey: request.idempotencyKey,
        logicalId: offer.logicalId,
      };
      let spend: CreditSpendResult;
      try {
        const answer = await client.spend(spendInput);
        try {
          spend = assertCreditSpendResult(answer);
        } catch (error) {
          throw invalidResponse('spend', error);
        }
      } catch (error) {
        return failed(toCommerceError(error).toCommerceErrorInfo());
      }
      if (spend.status === 'rejected') {
        return failed(spend.error);
      }
      // A debited answer that does not cover the price is not a purchase.
      // An empty debit list never covers a positive price, and a shortfall
      // within an absolute epsilon is still a shortfall.
      const paid = sumCreditDebits(spend.debits);
      if (
        spend.debits.length === 0
        || !creditAmountCovers(paid, spendInput.amount)
        || !sameCreditAmount(paid, spendInput.amount)
      ) {
        return failed(
          invalidResponse(
            'spend',
            new RangeError(
              `Debits for ${offer.logicalId} sum to ${paid}, not ${spendInput.amount}.`,
            ),
          ).toCommerceErrorInfo(),
        );
      }
      return {
        outcome: 'purchased',
        purchase: toPurchase({
          offer,
          logicalId: offer.logicalId,
          entitlementId: spend.entitlementId,
          debits: spend.debits,
          purchasedAt: purchasedAtOf(spend.entitlementId, spend.createdAt),
          quantity,
        }),
      };
    },
    async getAvailablePurchases() {
      return unredeemedPurchases();
    },
    async finishTransaction(request) {
      if (typeof request.ledgerEntryId !== 'string' || request.ledgerEntryId.length === 0) {
        // The reconciler's ledger grant is the finish gate: nothing is redeemed without it.
        throw new CommerceError('INVALID_RESPONSE', {
          message: 'A wallet entitlement is redeemed only with the ledger entry id of its grant.',
        });
      }
      if (typeof request.transactionId !== 'string' || request.transactionId.length === 0) {
        throw new CommerceError('INVALID_RESPONSE', {
          message: 'A wallet entitlement is redeemed by its entitlement id.',
        });
      }
      let result: { readonly redeemed: boolean };
      try {
        result = await client.redeem({
          entitlementId: request.transactionId,
          ledgerEntryId: request.ledgerEntryId,
        });
      } catch (error) {
        throw toCommerceError(error);
      }
      if (typeof result?.redeemed !== 'boolean') {
        throw invalidResponse('redeem', result);
      }
      return { finished: result.redeemed };
    },
    async restorePurchases() {
      for (const purchase of await unredeemedPurchases()) {
        if (listeners.size === 0) {
          if (bufferedRestores.has(purchase.transactionId)) {
            continue;
          }
          bufferedRestores.add(purchase.transactionId);
        }
        emit({ type: 'purchaseUpdated', purchase });
      }
    },
    subscribe(listener) {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) {
        bufferedRestores.clear();
        buffer.drain((event) => deliver(listener, event));
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      unsubscribeClient?.();
      listeners.clear();
    },
  };
  if (client.getActiveSubscriptions !== undefined) {
    const getActiveSubscriptions = client.getActiveSubscriptions.bind(client);
    return {
      ...provider,
      async getActiveSubscriptions() {
        let subscriptions: readonly ActiveSubscription[];
        try {
          subscriptions = await getActiveSubscriptions({ titleId });
        } catch (error) {
          throw toCommerceError(error);
        }
        if (!Array.isArray(subscriptions)) {
          throw invalidResponse('getActiveSubscriptions', subscriptions);
        }
        return subscriptions.map((subscription) => {
          try {
            return { ...assertActiveSubscription(subscription) };
          } catch (error) {
            throw invalidResponse('getActiveSubscriptions', error);
          }
        });
      },
    };
  }
  return provider;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesFetchProducts(offer: CreditOffer, request: FetchProductsInput): boolean {
  const type = request.type ?? 'all';
  if (type === 'in-app' && offer.kind === 'subscription') {
    return false;
  }
  if (type === 'subscription' && offer.kind !== 'subscription') {
    return false;
  }
  return request.logicalIds === undefined || request.logicalIds.includes(offer.logicalId);
}

// Reference in-memory wallet.

/** Periods one `renewDue` tick charges per membership before it yields to the next tick. */
export const defaultMaxRenewalsPerTick = 12;

export interface CreateInMemoryCreditWalletInput {
  readonly store: StoreId;
  /** Currencies the wallet keeps balances in; a lot or spend in another currency is refused. */
  readonly currencies: readonly string[];
  /** Clock for lot eligibility, entitlements, and periods; defaults to the system clock. */
  readonly now?: () => string;
  /** Offers the wallet prices spends against; a `spend` of a membership offer starts the membership. */
  readonly offers?: readonly CreditOffer[];
  readonly creditScope?: CreditScopeRegistry;
  /** Cap on the periods a single `renewDue` tick charges per membership; defaults to 12. */
  readonly maxRenewalsPerTick?: number;
}

/**
 * The reference wallet: the client surface plus the owner-side operations a
 * wallet service runs (credit a lot from a ledger grant, register offers,
 * start a membership, run the renewal scheduler) and the observations the
 * conformance vectors assert. The owner-side operations are not on
 * `CreditWalletClient`; a game client gets only that interface.
 */
export interface InMemoryCreditWallet extends CreditWalletClient {
  readonly lots: readonly CreditLot[];
  /** Every debit of every processed spend, in order; replays add nothing. */
  readonly debits: readonly CreditScheduledDebit[];
  readonly entitlements: readonly CreditEntitlement[];
  readonly subscriptionEvents: readonly CreditSubscriptionEvent[];
  readonly offers: readonly CreditOffer[];
  /** Registers or replaces offers by logical id. */
  addOffers(offers: readonly CreditOffer[]): void;
  /** Credits a lot whose id is the ledger entry id; a replayed grant returns the existing lot. */
  creditFromGrant(grant: CreditLotGrant, options?: DeriveCreditLotSpendScopeOptions): CreditLot;
  /** Starts a membership by debiting period 0; an id already started with the same terms answers with its original debits. */
  startMembership(input: CreditMembershipStartInput): Promise<CreditMembershipStartResult>;
  /** Runs the renewal scheduler for memberships whose paid period has ended at `now` (default: the wallet clock). */
  renewDue(now?: string): Promise<void>;
  getActiveSubscriptions(
    input?: { readonly titleId?: string },
  ): Promise<readonly ActiveSubscription[]>;
  /** With `input.titleId`, a title-scoped membership's events reach only that title's listeners. */
  subscribe(
    listener: (event: CommerceEvent) => void,
    input?: CreditWalletSubscribeInput,
  ): () => void;
}

interface WalletLot extends CreditLot {
  remaining: number;
}

interface WalletSpend {
  readonly request: CreditSpendInput;
  readonly entitlementId: string;
  readonly debits: readonly CreditDebit[];
  readonly createdAt: string;
}

interface WalletEntitlement extends CreditEntitlement {
  redeemedBy: string | undefined;
}

interface WalletSubscription {
  readonly subscriptionId: string;
  readonly titleId: string;
  readonly logicalId: CommerceLogicalProductId;
  readonly terms: CreditMembershipTerms;
  periodIndex: number;
  readonly startedAt: string;
  expiresAt: string;
  state: ActiveSubscription['state'];
}

interface WalletListener {
  readonly listener: (event: CommerceEvent) => void;
  readonly titleId: string | undefined;
}

interface BufferedWalletEvent {
  readonly event: CommerceEvent;
  /** Set for a title-scoped membership's events; `undefined` reaches every title. */
  readonly titleId: string | undefined;
}

const walletEventBufferLimit = 64;

/**
 * Reference in-memory wallet implementing the RFC "Credit lots" and "Billing
 * authority and memberships" rules on the pure rule functions above: lot ids
 * equal ledger entry ids, spend scope derives from the lot origin, spends
 * consume eligible lots in the fixed order, are idempotent by key, are priced
 * by the wallet's own offers, and debit nothing on `INSUFFICIENT_BALANCE`;
 * memberships debit `membership:<subscriptionId>:<periodIndex>` per paid
 * period with lot eligibility judged at the period boundary, a
 * platform-scoped membership debits `cross-title` lots only, and a membership
 * lapses at period end when the eligible balance runs out.
 */
export function createInMemoryCreditWallet(
  input: CreateInMemoryCreditWalletInput,
): InMemoryCreditWallet {
  const declaredStore = (input as Partial<CreateInMemoryCreditWalletInput> | undefined)?.store;
  if (typeof declaredStore !== 'string' || declaredStore.length === 0) {
    throw new TypeError('An in-memory credit wallet requires a store id.');
  }
  const { store } = input;
  const currencies = new Set<string>();
  for (const currency of input.currencies ?? []) {
    if (typeof currency !== 'string' || currency.trim() !== currency || currency.length === 0) {
      throw new TypeError(
        `Wallet currency ${JSON.stringify(currency)} must be a trimmed non-empty code.`,
      );
    }
    currencies.add(currency);
  }
  if (input.creditScope !== undefined) {
    assertCreditScopeRegistry(input.creditScope);
  }
  const maxRenewalsPerTick = input.maxRenewalsPerTick ?? defaultMaxRenewalsPerTick;
  if (!Number.isInteger(maxRenewalsPerTick) || maxRenewalsPerTick < 1) {
    throw new TypeError('maxRenewalsPerTick must be a positive integer.');
  }
  const now = (): string => normalizeIsoTimestamp(input.now?.() ?? new Date().toISOString());

  const offers = new Map<string, CreditOffer>();
  const addOffers = (candidates: readonly CreditOffer[]): void => {
    const validated = candidates.map((candidate) => assertCreditWalletOffer(candidate));
    for (const offer of validated) {
      if (!currencies.has(offer.price.currency)) {
        throw new TypeError(
          `Offer ${offer.logicalId} is priced in ${offer.price.currency}, `
            + 'which the wallet does not declare.',
        );
      }
    }
    for (const offer of validated) {
      offers.set(offer.logicalId, copyOffer(offer));
    }
  };
  addOffers(input.offers ?? []);

  const lots: WalletLot[] = [];
  const spends = new Map<string, WalletSpend>();
  const debits: CreditScheduledDebit[] = [];
  const entitlements: WalletEntitlement[] = [];
  const subscriptions = new Map<string, WalletSubscription>();
  const subscriptionEvents: CreditSubscriptionEvent[] = [];
  const listeners = new Set<WalletListener>();
  const buffered: BufferedWalletEvent[] = [];

  const snapshotLot = (lot: WalletLot): CreditLot => ({
    ...lot,
    origin: { ...lot.origin },
    spendScope: { ...lot.spendScope },
  });
  const toEntitlement = (entitlement: WalletEntitlement): CreditEntitlement => ({
    entitlementId: entitlement.entitlementId,
    titleId: entitlement.titleId,
    logicalId: entitlement.logicalId,
    idempotencyKey: entitlement.idempotencyKey,
    createdAt: entitlement.createdAt,
    debits: entitlement.debits.map((debit) => ({ ...debit })),
    ...(entitlement.quantity === undefined ? {} : { quantity: entitlement.quantity }),
  });
  const toActiveSubscription = (subscription: WalletSubscription): ActiveSubscription => ({
    store,
    logicalId: subscription.logicalId,
    subscriptionId: subscription.subscriptionId,
    periodIndex: subscription.periodIndex,
    state: subscription.state,
    startedAt: subscription.startedAt,
    expiresAt: subscription.expiresAt,
    autoRenew: subscription.state === 'active',
  });
  const deliverTo = (target: WalletListener, event: CommerceEvent): void => {
    try {
      target.listener(event);
    } catch (error) {
      console.warn('Credit wallet listener failed.', describeError(error));
    }
  };
  const reaches = (entry: BufferedWalletEvent, target: WalletListener): boolean =>
    entry.titleId === undefined || target.titleId === undefined || entry.titleId === target.titleId;
  const emit = (entry: BufferedWalletEvent): void => {
    const audience = [...listeners].filter((target) => reaches(entry, target));
    if (audience.length === 0) {
      buffered.push(entry);
      if (buffered.length > walletEventBufferLimit) {
        buffered.shift();
      }
      return;
    }
    for (const target of audience) {
      deliverTo(target, entry.event);
    }
  };
  const emitSubscription = (
    subscription: WalletSubscription,
    type: CreditSubscriptionEventType,
    periodIndex: number,
    reason?: CommerceErrorCode,
  ): void => {
    const eventId = createCreditSubscriptionEventId(subscription.subscriptionId, periodIndex, type);
    if (subscriptionEvents.some((event) => event.eventId === eventId)) {
      return;
    }
    subscriptionEvents.push({
      eventId,
      type,
      subscriptionId: subscription.subscriptionId,
      logicalId: subscription.logicalId,
      periodIndex,
      expiresAt: subscription.expiresAt,
      ...(reason === undefined ? {} : { reason }),
    });
    emit({
      event: { type: 'subscriptionUpdated', subscription: toActiveSubscription(subscription) },
      titleId: subscription.terms.scope === 'platform' ? undefined : subscription.titleId,
    });
  };

  const rejected = (code: CommerceErrorCode, message: string): CreditSpendResult => ({
    status: 'rejected',
    error: { code, retryable: false, message },
  });
  const sameSpend = (left: CreditSpendInput, right: CreditSpendInput): boolean =>
    left.titleId === right.titleId
    && left.currency === right.currency
    && sameCreditAmount(left.amount, right.amount)
    && left.logicalId === right.logicalId;
  const replayOf = (key: string, request: CreditSpendInput): CreditSpendResult | undefined => {
    const replay = spends.get(key);
    if (replay === undefined) {
      return undefined;
    }
    if (!sameSpend(replay.request, request)) {
      return rejected(
        'INVALID_RESPONSE',
        `Idempotency key ${key} was already used for a different spend.`,
      );
    }
    return {
      status: 'debited',
      entitlementId: replay.entitlementId,
      debits: replay.debits.map((debit) => ({ ...debit })),
      createdAt: replay.createdAt,
      alreadyProcessed: true,
    };
  };

  /**
   * The one debit path. `scope` is `platform` for platform memberships and
   * `title` otherwise; `at` is when the spend takes effect, which decides lot
   * expiry and the entitlement's `createdAt` (a renewal uses the boundary of
   * the period it pays for and, through `createdBy`, ignores lots granted
   * after it); `quantity` is recorded on the entitlement.
   */
  const spendScoped = (
    request: CreditSpendInput,
    options: {
      readonly scope: CreditMembershipScope;
      readonly at: string;
      readonly quantity?: number;
      readonly createdBy?: string;
    },
  ): CreditSpendResult => {
    const { scope, at, quantity } = options;
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
      return rejected('INVALID_RESPONSE', 'A spend requires an idempotency key.');
    }
    const replay = replayOf(request.idempotencyKey, request);
    if (replay !== undefined) {
      return replay;
    }
    if (typeof request.titleId !== 'string' || request.titleId.length === 0) {
      return rejected('INVALID_RESPONSE', 'A spend requires a title id.');
    }
    if (!currencies.has(request.currency)) {
      return rejected(
        'ITEM_UNAVAILABLE',
        `Currency ${String(request.currency)} is not declared by the wallet.`,
      );
    }
    const plan = planCreditDebits(
      selectEligibleCreditLots(lots, {
        titleId: request.titleId,
        currency: request.currency,
        scope,
        now: at,
        ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      }),
      request.amount,
    );
    if (plan.status === 'rejected') {
      return plan;
    }
    for (const debit of plan.debits) {
      const lot = lots.find((candidate) => candidate.lotId === debit.lotId);
      if (lot === undefined) {
        throw new Error(`Planned debit names unknown lot ${debit.lotId}.`);
      }
      lot.remaining = Math.max(0, lot.remaining - debit.amount);
      debits.push({
        idempotencyKey: request.idempotencyKey,
        lotId: debit.lotId,
        amount: debit.amount,
      });
    }
    const entitlementId = request.idempotencyKey;
    spends.set(request.idempotencyKey, {
      request: { ...request },
      entitlementId,
      debits: plan.debits,
      createdAt: at,
    });
    if (request.logicalId !== undefined) {
      entitlements.push({
        entitlementId,
        titleId: request.titleId,
        logicalId: request.logicalId,
        idempotencyKey: request.idempotencyKey,
        createdAt: at,
        debits: plan.debits.map((debit) => ({ ...debit })),
        // Recorded only within the contract's uint32 range; a wider count falls back to the price derivation.
        ...(quantity === undefined || quantity > 0xff_ff_ff_ff ? {} : { quantity }),
        redeemedBy: undefined,
      });
    }
    return {
      status: 'debited',
      entitlementId,
      debits: plan.debits.map((debit) => ({ ...debit })),
      createdAt: at,
    };
  };

  const sameMembership = (
    subscription: WalletSubscription,
    request: CreditMembershipStartInput,
  ): boolean =>
    subscription.titleId === request.titleId
    && subscription.logicalId === request.logicalId
    && subscription.terms.scope === request.terms.scope
    && subscription.terms.period === request.terms.period
    && subscription.terms.price.currency === request.terms.price.currency
    && sameCreditAmount(subscription.terms.price.amount, request.terms.price.amount);
  const rejectedStart = (code: CommerceErrorCode, message: string): CreditMembershipStartResult => ({
    status: 'rejected',
    error: { code, retryable: false, message },
  });

  const startMembership = async (
    request: CreditMembershipStartInput,
  ): Promise<CreditMembershipStartResult> => {
    let validated: CreditMembershipStartInput;
    try {
      validated = assertCreditMembershipStartInput(request);
    } catch (error) {
      return rejectedStart(
        'INVALID_RESPONSE',
        `Membership start is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const periodZeroKey = createMembershipRenewalKey(validated.subscriptionId, 0);
    const current = subscriptions.get(validated.subscriptionId);
    if (current !== undefined) {
      const original = spends.get(periodZeroKey);
      if (!sameMembership(current, validated) || original === undefined) {
        return rejectedStart(
          'INVALID_RESPONSE',
          `Subscription id ${validated.subscriptionId} was already used for a different membership.`,
        );
      }
      // A replay answers with the original period-0 debits whatever the state
      // is now; a lapsed or revoked membership resumes only under a new id.
      return {
        status: 'started',
        subscription: toActiveSubscription(current),
        entitlementId: original.entitlementId,
        debits: original.debits.map((debit) => ({ ...debit })),
        createdAt: original.createdAt,
        alreadyProcessed: true,
      };
    }
    if (spends.has(validated.subscriptionId)) {
      // The id namespace is shared with client spend keys in both directions.
      return rejectedStart(
        'INVALID_RESPONSE',
        `Subscription id ${validated.subscriptionId} was already used as a spend key.`,
      );
    }
    // The terms are validated before any credit moves, so malformed terms never charge.
    if (!isIsoDuration(validated.terms.period)) {
      return rejectedStart(
        'ITEM_UNAVAILABLE',
        `Membership period ${validated.terms.period} is not a positive ISO-8601 duration.`,
      );
    }
    const startedAt = now();
    const expiresAt = addIsoDuration(startedAt, validated.terms.period, 1);
    const result = spendScoped(
      {
        titleId: validated.titleId,
        currency: validated.terms.price.currency,
        amount: validated.terms.price.amount,
        idempotencyKey: periodZeroKey,
        logicalId: validated.logicalId,
      },
      { scope: validated.terms.scope, at: startedAt, quantity: 1 },
    );
    if (result.status === 'rejected') {
      return result;
    }
    const subscription: WalletSubscription = {
      subscriptionId: validated.subscriptionId,
      titleId: validated.titleId,
      logicalId: validated.logicalId,
      terms: {
        scope: validated.terms.scope,
        price: { ...validated.terms.price },
        period: validated.terms.period,
      },
      periodIndex: 0,
      startedAt,
      expiresAt,
      state: 'active',
    };
    subscriptions.set(subscription.subscriptionId, subscription);
    emitSubscription(subscription, 'subscriptionStarted', 0);
    return {
      status: 'started',
      subscription: toActiveSubscription(subscription),
      entitlementId: result.entitlementId,
      debits: result.debits,
      createdAt: startedAt,
    };
  };

  /** Charges every period that ended by `at`, at most `maxRenewalsPerTick` per call, each judged at its own boundary. */
  const renew = (subscription: WalletSubscription, at: number): void => {
    let charged = 0;
    while (
      subscription.state === 'active'
      && Date.parse(subscription.expiresAt) <= at
      && charged < maxRenewalsPerTick
    ) {
      const nextPeriod = subscription.periodIndex + 1;
      const boundary = subscription.expiresAt;
      const result = spendScoped(
        {
          titleId: subscription.titleId,
          currency: subscription.terms.price.currency,
          amount: subscription.terms.price.amount,
          idempotencyKey: createMembershipRenewalKey(subscription.subscriptionId, nextPeriod),
        },
        { scope: subscription.terms.scope, at: boundary, createdBy: boundary },
      );
      if (result.status === 'rejected') {
        // The membership lapses at the end of the paid period; `expiresAt` is unchanged.
        subscription.state = 'lapsed';
        emitSubscription(subscription, 'subscriptionLapsed', nextPeriod, result.error.code);
        return;
      }
      subscription.periodIndex = nextPeriod;
      subscription.expiresAt = addIsoDuration(
        subscription.startedAt,
        subscription.terms.period,
        nextPeriod + 1,
      );
      emitSubscription(subscription, 'subscriptionRenewed', nextPeriod);
      charged += 1;
    }
  };

  return {
    store,
    get lots() {
      return lots.map(snapshotLot);
    },
    get debits() {
      return debits.map((debit) => ({ ...debit }));
    },
    get entitlements() {
      return entitlements.map(toEntitlement);
    },
    get subscriptionEvents() {
      return subscriptionEvents.map((event) => ({ ...event }));
    },
    get offers() {
      return [...offers.values()].map(copyOffer);
    },
    addOffers,
    creditFromGrant(grant, options = {}) {
      const validated = assertCreditLotGrant(grant);
      const spendScope = deriveCreditLotSpendScope(validated.origin, {
        ...options,
        ...(input.creditScope === undefined ? {} : { creditScope: input.creditScope }),
      });
      const createdAt = normalizeIsoTimestamp(validated.createdAt);
      const expiresAt = validated.expiresAt === undefined
        ? undefined
        : normalizeIsoTimestamp(validated.expiresAt);
      const existing = lots.find((lot) => lot.lotId === validated.ledgerEntryId);
      if (existing !== undefined) {
        if (
          existing.currency !== validated.currency
          || !sameCreditAmount(existing.amount, validated.amount)
          || existing.origin.channel !== validated.origin.channel
          || existing.origin.store !== validated.origin.store
          || existing.origin.titleId !== validated.origin.titleId
          || existing.createdAt !== createdAt
          || existing.expiresAt !== expiresAt
          || existing.spendScope.kind !== spendScope.kind
          || (spendScope.kind === 'title'
            && existing.spendScope.kind === 'title'
            && existing.spendScope.titleId !== spendScope.titleId)
        ) {
          throw new Error(
            `Ledger entry ${validated.ledgerEntryId} was already credited as a different lot.`,
          );
        }
        return snapshotLot(existing);
      }
      if (!currencies.has(validated.currency)) {
        throw new TypeError(
          `Lot ${validated.ledgerEntryId} uses currency ${validated.currency}, `
            + 'which the wallet does not declare.',
        );
      }
      const lot: WalletLot = {
        lotId: validated.ledgerEntryId,
        currency: validated.currency,
        amount: validated.amount,
        remaining: validated.amount,
        createdAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        origin: { ...validated.origin },
        spendScope,
      };
      lots.push(lot);
      return snapshotLot(lot);
    },
    startMembership,
    async renewDue(at) {
      const millis = Date.parse(at === undefined ? now() : normalizeIsoTimestamp(at));
      for (const subscription of subscriptions.values()) {
        renew(subscription, millis);
      }
    },
    async listOffers() {
      return [...offers.values()].map(copyOffer);
    },
    async spend(request) {
      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
        return rejected('INVALID_RESPONSE', 'A spend requires an idempotency key.');
      }
      if (request.idempotencyKey.startsWith(membershipDebitKeyPrefix)) {
        return rejected(
          'INVALID_RESPONSE',
          `Idempotency keys starting with ${membershipDebitKeyPrefix} are reserved for scheduled debits.`,
        );
      }
      // A membership start is recorded under the client's key too, so this
      // answers every replay, including one after the membership lapsed.
      const replay = replayOf(request.idempotencyKey, request);
      if (replay !== undefined) {
        return replay;
      }
      const offer = request.logicalId === undefined ? undefined : offers.get(request.logicalId);
      if (offer?.membership === undefined && subscriptions.has(request.idempotencyKey)) {
        // A membership the owner started under this id already consumed the key.
        return rejected(
          'INVALID_RESPONSE',
          `Idempotency key ${request.idempotencyKey} is the id of a started membership.`,
        );
      }
      if (request.logicalId === undefined) {
        return spendScoped(request, { scope: 'title', at: now() });
      }
      if (offer === undefined) {
        return rejected('ITEM_UNAVAILABLE', `The wallet offers no product ${request.logicalId}.`);
      }
      if (request.currency !== offer.price.currency) {
        return rejected(
          'ITEM_UNAVAILABLE',
          `${offer.logicalId} is priced in ${offer.price.currency}, not ${request.currency}.`,
        );
      }
      const multiple = creditPriceMultiple(request.amount, offer.price.amount);
      if (multiple === undefined) {
        return rejected(
          'ITEM_UNAVAILABLE',
          `${offer.logicalId} costs ${offer.price.amount} ${offer.price.currency} per unit; `
            + `${request.amount} is not a whole number of units.`,
        );
      }
      if (offer.membership === undefined) {
        return spendScoped(request, { scope: 'title', at: now(), quantity: multiple });
      }
      if (multiple !== 1) {
        return rejected('ITEM_UNAVAILABLE', 'A membership is purchased one period at a time.');
      }
      const started = await startMembership({
        subscriptionId: request.idempotencyKey,
        titleId: request.titleId,
        logicalId: offer.logicalId,
        terms: offer.membership,
      });
      if (started.status === 'started' && started.alreadyProcessed !== true) {
        spends.set(request.idempotencyKey, {
          request: { ...request },
          entitlementId: started.entitlementId,
          debits: started.debits,
          createdAt: started.createdAt,
        });
      }
      return creditSpendResultOfMembershipStart(started);
    },
    async listUnredeemed(request) {
      return entitlements
        .filter(
          (entitlement) =>
            entitlement.redeemedBy === undefined && entitlement.titleId === request.titleId,
        )
        .map(toEntitlement);
    },
    async redeem(request) {
      if (
        typeof request.ledgerEntryId !== 'string'
        || request.ledgerEntryId.length === 0
        || typeof request.entitlementId !== 'string'
        || request.entitlementId.length === 0
      ) {
        return { redeemed: false };
      }
      const entitlement = entitlements.find(
        (candidate) => candidate.entitlementId === request.entitlementId,
      );
      if (entitlement === undefined) {
        return { redeemed: false };
      }
      if (entitlement.redeemedBy !== undefined) {
        // Redeeming again under the same grant is a no-op; another grant cannot claim it.
        return { redeemed: entitlement.redeemedBy === request.ledgerEntryId };
      }
      entitlement.redeemedBy = request.ledgerEntryId;
      return { redeemed: true };
    },
    async getBalance(request) {
      const balances: Record<string, number> = {};
      for (const currency of currencies) {
        balances[currency] = sumCreditLotRemaining(
          selectEligibleCreditLots(lots, {
            titleId: request.titleId,
            currency,
            scope: 'title',
            now: now(),
          }),
        );
      }
      return { titleId: request.titleId, balances };
    },
    async getActiveSubscriptions(request = {}) {
      return [...subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.state === 'active'
            && (request.titleId === undefined
              || subscription.terms.scope === 'platform'
              || subscription.titleId === request.titleId),
        )
        .map(toActiveSubscription);
    },
    subscribe(listener, input = {}) {
      const target: WalletListener = { listener, titleId: input.titleId };
      listeners.add(target);
      // Buffered events this listener can see are delivered now; the rest wait for their title.
      for (const entry of buffered.splice(0, buffered.length)) {
        if (reaches(entry, target)) {
          deliverTo(target, entry.event);
        } else {
          buffered.push(entry);
        }
      }
      return () => {
        listeners.delete(target);
      };
    },
  };
}

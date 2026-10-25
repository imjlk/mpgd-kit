import type { ProductGrant } from '@mpgd/catalog';
import type {
  LeaderboardScoreInput,
  LogicalAdPlacementId,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  PlatformTarget,
} from '@mpgd/platform';
import type { StoreId } from '@mpgd/platform/commerce';

import type {
  ClaimAdRewardResponse,
  PurchaseGrantFinalization,
  PurchaseGrantFinalizationAction,
  PurchaseLedgerStatusRequest,
  PurchaseLedgerStatusResponse,
  VerifyPurchaseResponse,
} from './operation-results.js';
import {
  assertOwnEnumerablePropertyLimit,
  gameServicesRequestLimits,
  toGameServicesRequestValidationError,
} from './validation.js';

export type {
  ClaimAdRewardResponse,
  PurchaseGrantFinalization,
  PurchaseGrantFinalizationAction,
  PurchaseLedgerStatus,
  PurchaseLedgerStatusRequest,
  PurchaseLedgerStatusResponse,
  VerifyPurchaseResponse,
} from './operation-results.js';

export type { PlatformEvidenceEnvelope } from '@mpgd/platform';

/**
 * An open store or deployment target identifier (RFC "Open store ids"). The
 * request validator bounds its shape; the backend's commerce evidence
 * registry decides which stores it serves.
 */
export type GameServicesStoreTarget = StoreId;
export type GameServicesAdRewardTarget = GameServicesLedgerTarget;
export type GameServicesLeaderboardTarget = Extract<
  PlatformTarget,
  'browser' | 'microsoft-store' | 'android' | 'ios' | 'ait' | 'reddit'
>;
export type GameServicesLedgerTarget = Extract<
  PlatformTarget,
  'browser' | 'microsoft-store' | 'android' | 'ios' | 'ait' | 'reddit' | 'verse8' | 'oneplay'
>;

export type PurchaseIdempotencyKey = string;
export type AdRewardIdempotencyKey = string;
export type EntitlementIdempotencyKey = PurchaseIdempotencyKey | AdRewardIdempotencyKey;

export type EntitlementLedgerSource = 'purchase' | 'ad_reward' | 'admin';
export type EntitlementLedgerPayload = Record<string, string | number | boolean>;

export interface VerifyPurchaseRequest {
  /** The ledger (deployment platform) target; see `store` for the store the purchase was made in. */
  readonly target: GameServicesStoreTarget;
  /**
   * The open store id the purchase was made in (RFC "Open store ids"), for
   * example `google-play` or `credit-wallet`. A v1 request without it names
   * its store through `target`: `android` is `google-play`, `ios` is
   * `app-store`, `ait` is `apps-in-toss`, `reddit` is `devvit`, and every
   * other target (`microsoft-store`, `verse8`, `oneplay`) is its own store id
   * (`resolveLegacyCommerceStoreId`).
   */
  readonly store?: StoreId;
  /** Deployment config key used to resolve game-owned platform product identifiers. */
  readonly deploymentTarget?: string;
  readonly playerId: string;
  readonly productId: LogicalProductId;
  readonly platformTransactionId: string;
  readonly idempotencyKey: PurchaseIdempotencyKey;
  readonly purchasedAt: string;
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface ClaimAdRewardRequest {
  readonly target: GameServicesAdRewardTarget;
  /** Versioned provider identity, independent of build target; checked by server registration. */
  readonly providerId?: string;
  /** Deployment config key used to resolve game-owned platform placement identifiers. */
  readonly deploymentTarget?: string;
  readonly playerId: string;
  readonly placementId: LogicalAdPlacementId;
  /** Platform evidence identity; AIT uses the game-issued reward correlation identifier. */
  readonly platformImpressionId?: string;
  readonly idempotencyKey: AdRewardIdempotencyKey;
  readonly completedAt: string;
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface RecordLeaderboardScoreRequest extends LeaderboardScoreInput {
  readonly target: GameServicesLeaderboardTarget;
  readonly playerId: string;
  readonly platformSubmissionId?: string;
}

export interface RecordLeaderboardScoreResponse {
  readonly submitted: boolean;
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
  readonly rank: number;
}

export interface EntitlementLedgerGrant {
  readonly playerId: string;
  readonly grantId: string;
  readonly source: EntitlementLedgerSource;
  readonly idempotencyKey: EntitlementIdempotencyKey;
  readonly grantedAt: string;
  readonly grant?: ProductGrant;
  readonly payload: EntitlementLedgerPayload;
  readonly evidenceVerificationId?: string;
}

export interface EntitlementLedgerResult {
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
}

/** Why a grant was reversed (RFC "Revocation and expiry entries"). */
export type EntitlementRevocationReason = 'refund' | 'chargeback' | 'voided' | 'admin';

/**
 * A `revoke` ledger entry: it references the grant it reverses and never
 * removes it, so the ledger stays append-only. Store notification handlers
 * (a Play voided purchase, an App Store refund, an Apps in Toss or Devvit
 * refunded order) write one through `revokeEntitlementGrant`; the entry's
 * `idempotencyKey` makes the notification replay-safe.
 */
export interface EntitlementLedgerRevocation {
  readonly playerId: string;
  /** The `ledgerEntryId` of the grant this entry reverses. */
  readonly revokesLedgerEntryId: string;
  readonly idempotencyKey: string;
  readonly reason: EntitlementRevocationReason;
  readonly revokedAt: string;
  readonly payload: EntitlementLedgerPayload;
  /** The notification's own authority identity, when the handler has one. */
  readonly evidenceVerificationId?: string;
}

/**
 * A ledger note: a store event about a grant that changes nothing by itself
 * and grants nothing (today an App Store `REFUND_REVERSED` after the grant
 * was revoked). It is kept so support can act on it; a re-grant is a new,
 * game-owned grant entry.
 */
export interface EntitlementLedgerNote {
  /** Unique per store event, for example `app-store:notification:<notificationUUID>`. */
  readonly noteId: string;
  readonly kind: 'refund_reversed';
  readonly playerId: string;
  /** The grant the event is about. */
  readonly ledgerEntryId: string;
  /** The `revoke` entry the store reversed, when there is one. */
  readonly revocationLedgerEntryId?: string;
  readonly recordedAt: string;
  readonly payload: EntitlementLedgerPayload;
}

export function assertEntitlementLedgerNote(input: EntitlementLedgerNote): EntitlementLedgerNote {
  assertRecord(input, 'EntitlementLedgerNote');
  assertNonEmptyString(input.noteId, 'noteId');
  if (input.kind !== 'refund_reversed') {
    throw new Error('kind must be refund_reversed.');
  }
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertOptionalNonEmptyString(input.revocationLedgerEntryId, 'revocationLedgerEntryId');
  assertNonEmptyString(input.recordedAt, 'recordedAt');
  assertPayload(input.payload);
  return input;
}

export interface EntitlementRevocationTransaction extends EntitlementLedgerRevocation {
  readonly ledgerEntryId: string;
}

/**
 * A subscription `period` ledger entry: it extends an earlier grant with a
 * renewal period and its expiry. This is the shape only; no reference store
 * verifier writes one until a subscription verifier exists.
 */
export interface EntitlementLedgerPeriod {
  readonly playerId: string;
  /** The `ledgerEntryId` of the subscription grant this period extends. */
  readonly extendsLedgerEntryId: string;
  readonly idempotencyKey: string;
  readonly periodIndex: number;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly payload: EntitlementLedgerPayload;
}

export interface ProductGrantTransaction {
  readonly ledgerEntryId: string;
  readonly playerId: string;
  readonly grantId: string;
  readonly source: EntitlementLedgerSource;
  readonly idempotencyKey: EntitlementIdempotencyKey;
  readonly grantedAt: string;
  readonly grant?: ProductGrant;
  readonly payload: EntitlementLedgerPayload;
  readonly evidenceVerificationId?: string;
}

export interface LeaderboardScoreTransaction extends RecordLeaderboardScoreRequest {
  readonly ledgerEntryId: string;
  readonly recordedAt: string;
}

/**
 * Validates an untrusted purchase verification request. Failures throw
 * `GameServicesRequestValidationError` so transports can answer with a stable 400.
 */
export function assertVerifyPurchaseRequest(input: VerifyPurchaseRequest): VerifyPurchaseRequest {
  return validateRequest(() => {
    assertRecord(input, 'VerifyPurchaseRequest');
    assertStoreTarget(input.target);
    if (input.store !== undefined) {
      assertCommerceStoreId(input.store, 'store');
    }
    assertOptionalGameServicesDeploymentTarget(input.deploymentTarget);
    assertRequestString(input.playerId, 'playerId');
    assertRequestString(input.productId, 'productId');
    assertRequestString(input.platformTransactionId, 'platformTransactionId');
    assertRequestString(input.idempotencyKey, 'idempotencyKey');
    assertRequestString(input.purchasedAt, 'purchasedAt');
    assertOptionalEvidenceEnvelope(input.evidence);

    return input;
  });
}

export function assertVerifyPurchaseResponse(
  input: VerifyPurchaseResponse,
): VerifyPurchaseResponse {
  assertRecord(input, 'VerifyPurchaseResponse');
  assertBoolean(input.verified, 'verified');
  assertOptionalNonGrantDisposition(input.disposition, input.verified);
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalNonEmptyString(input.reason, 'reason');
  if (input.finalization !== undefined) {
    assertPurchaseGrantFinalization(input.finalization);
  }

  return input;
}

/** Bounds one ledger status read; a client asks for the grants of one journal window. */
export const maxPurchaseLedgerStatusEntries = 256;

/**
 * Validates an untrusted ledger status read. Failures throw
 * `GameServicesRequestValidationError` so transports can answer with a stable 400.
 */
export function assertPurchaseLedgerStatusRequest(
  input: PurchaseLedgerStatusRequest,
): PurchaseLedgerStatusRequest {
  return validateRequest(() => {
    assertRecord(input, 'PurchaseLedgerStatusRequest');
    if (!Array.isArray(input.ledgerEntryIds)) {
      throw new Error('ledgerEntryIds must be an array.');
    }
    if (input.ledgerEntryIds.length > maxPurchaseLedgerStatusEntries) {
      throw new Error(
        `ledgerEntryIds must not exceed ${String(maxPurchaseLedgerStatusEntries)} entries.`,
      );
    }
    for (const ledgerEntryId of input.ledgerEntryIds) {
      assertRequestString(ledgerEntryId, 'ledgerEntryIds[]');
    }
    assertRequestString(input.playerId, 'playerId');
    return input;
  });
}

export function assertPurchaseLedgerStatusResponse(
  input: PurchaseLedgerStatusResponse,
): PurchaseLedgerStatusResponse {
  assertRecord(input, 'PurchaseLedgerStatusResponse');
  if (!Array.isArray(input.statuses)) {
    throw new Error('statuses must be an array.');
  }
  for (const status of input.statuses) {
    assertRecord(status, 'statuses[]');
    assertNonEmptyString(status.ledgerEntryId, 'statuses[].ledgerEntryId');
    if (status.status !== 'active' && status.status !== 'reversed' && status.status !== 'unknown') {
      throw new Error('statuses[].status must be active, reversed, or unknown.');
    }
    assertOptionalNonEmptyString(status.reversedBy, 'statuses[].reversedBy');
    if (status.status === 'reversed' && status.reversedBy === undefined) {
      throw new Error('a reversed status names the entry that reversed it.');
    }
    if (status.status !== 'reversed' && status.reversedBy !== undefined) {
      throw new Error('only a reversed status names a reversing entry.');
    }
  }
  return input;
}

export function assertPurchaseGrantFinalization(
  input: PurchaseGrantFinalization,
): PurchaseGrantFinalization {
  assertRecord(input, 'PurchaseGrantFinalization');
  if (input.status !== 'completed' && input.status !== 'pending') {
    throw new Error('finalization.status must be completed or pending.');
  }
  if (input.action !== undefined) {
    assertPurchaseGrantFinalizationAction(input.action);
  }
  if (input.status === 'completed' && input.action === undefined) {
    throw new Error('completed finalization requires an action.');
  }
  assertBoolean(input.alreadyCompleted, 'finalization.alreadyCompleted');
  assertOptionalNonEmptyString(input.reason, 'finalization.reason');

  if (input.status === 'pending' && input.alreadyCompleted) {
    throw new Error('pending finalization cannot already be completed.');
  }
  if (input.status === 'pending' && input.reason === undefined) {
    throw new Error('pending finalization requires a reason.');
  }

  return input;
}

/**
 * Validates an untrusted ad reward claim. Failures throw
 * `GameServicesRequestValidationError` so transports can answer with a stable 400.
 */
export function assertClaimAdRewardRequest(
  input: ClaimAdRewardRequest,
): ClaimAdRewardRequest {
  return validateRequest(() => {
    assertRecord(input, 'ClaimAdRewardRequest');
    assertAdRewardTarget(input.target);
    assertOptionalRequestString(input.providerId, 'providerId');
    assertOptionalGameServicesDeploymentTarget(input.deploymentTarget);
    assertRequestString(input.playerId, 'playerId');
    assertRequestString(input.placementId, 'placementId');
    assertOptionalRequestString(input.platformImpressionId, 'platformImpressionId');
    assertRequestString(input.idempotencyKey, 'idempotencyKey');
    assertRequestString(input.completedAt, 'completedAt');
    assertOptionalEvidenceEnvelope(input.evidence);

    return input;
  });
}

export function assertClaimAdRewardResponse(
  input: ClaimAdRewardResponse,
): ClaimAdRewardResponse {
  assertRecord(input, 'ClaimAdRewardResponse');
  assertBoolean(input.granted, 'granted');
  assertOptionalNonGrantDisposition(input.disposition, input.granted);
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalNonEmptyString(input.reason, 'reason');

  return input;
}

/**
 * Validates an untrusted leaderboard score submission. Failures throw
 * `GameServicesRequestValidationError` so transports can answer with a stable 400.
 */
export function assertRecordLeaderboardScoreRequest(
  input: RecordLeaderboardScoreRequest,
): RecordLeaderboardScoreRequest {
  return validateRequest(() => validateRecordLeaderboardScoreRequest(input));
}

function validateRecordLeaderboardScoreRequest(
  input: RecordLeaderboardScoreRequest,
): RecordLeaderboardScoreRequest {
  assertRecord(input, 'RecordLeaderboardScoreRequest');
  assertLeaderboardTarget(input.target);
  assertRequestString(input.playerId, 'playerId');
  assertRequestString(input.leaderboardId, 'leaderboardId');
  assertFiniteNumber(input.score, 'score');
  assertRequestString(input.runId, 'runId');
  assertRequestString(input.submittedAt, 'submittedAt');
  assertOptionalRequestString(input.platformSubmissionId, 'platformSubmissionId');

  return input;
}

export function assertRecordLeaderboardScoreResponse(
  input: RecordLeaderboardScoreResponse,
): RecordLeaderboardScoreResponse {
  assertRecord(input, 'RecordLeaderboardScoreResponse');
  assertBoolean(input.submitted, 'submitted');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertFiniteNumber(input.rank, 'rank');

  return input;
}

export function assertEntitlementLedgerGrant(
  input: EntitlementLedgerGrant,
): EntitlementLedgerGrant {
  assertRecord(input, 'EntitlementLedgerGrant');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.grantId, 'grantId');
  assertLedgerSource(input.source);
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.grantedAt, 'grantedAt');
  if (input.grant !== undefined) {
    assertProductGrant(input.grant);
  }
  assertPayload(input.payload);
  assertOptionalNonEmptyString(input.evidenceVerificationId, 'evidenceVerificationId');

  return input;
}

export function assertEntitlementLedgerResult(
  input: EntitlementLedgerResult,
): EntitlementLedgerResult {
  assertRecord(input, 'EntitlementLedgerResult');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');

  return input;
}

export function assertEntitlementLedgerRevocation(
  input: EntitlementLedgerRevocation,
): EntitlementLedgerRevocation {
  assertRecord(input, 'EntitlementLedgerRevocation');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.revokesLedgerEntryId, 'revokesLedgerEntryId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertRevocationReason(input.reason);
  assertNonEmptyString(input.revokedAt, 'revokedAt');
  assertPayload(input.payload);
  assertOptionalNonEmptyString(input.evidenceVerificationId, 'evidenceVerificationId');

  return input;
}

export function assertEntitlementRevocationTransaction(
  input: EntitlementRevocationTransaction,
): EntitlementRevocationTransaction {
  assertEntitlementLedgerRevocation(input);
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');

  return input;
}

export function assertEntitlementLedgerPeriod(
  input: EntitlementLedgerPeriod,
): EntitlementLedgerPeriod {
  assertRecord(input, 'EntitlementLedgerPeriod');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.extendsLedgerEntryId, 'extendsLedgerEntryId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(input.periodIndex) || input.periodIndex < 0) {
    throw new Error('periodIndex must be a non-negative integer.');
  }
  assertNonEmptyString(input.startedAt, 'startedAt');
  assertNonEmptyString(input.expiresAt, 'expiresAt');
  if (!(Date.parse(input.expiresAt) > Date.parse(input.startedAt))) {
    throw new Error('expiresAt must be a timestamp after startedAt.');
  }
  assertPayload(input.payload);

  return input;
}

export function assertProductGrantTransaction(
  input: ProductGrantTransaction,
): ProductGrantTransaction {
  assertRecord(input, 'ProductGrantTransaction');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.grantId, 'grantId');
  assertLedgerSource(input.source);
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.grantedAt, 'grantedAt');
  if (input.grant !== undefined) {
    assertProductGrant(input.grant);
  }
  assertPayload(input.payload);
  assertOptionalNonEmptyString(input.evidenceVerificationId, 'evidenceVerificationId');

  return input;
}

export function assertLeaderboardScoreTransaction(
  input: LeaderboardScoreTransaction,
): LeaderboardScoreTransaction {
  validateRecordLeaderboardScoreRequest(input);
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertNonEmptyString(input.recordedAt, 'recordedAt');

  return input;
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

/**
 * The purchase target is open (RFC "Open store ids"): any bounded kebab-case
 * identifier passes here, and the backend's commerce evidence registry decides
 * whether the store it names is served.
 */
function assertStoreTarget(input: unknown): asserts input is GameServicesStoreTarget {
  assertCommerceStoreId(input, 'target');
}

/** A store id is a bounded kebab-case identifier such as `google-play` or `credit-wallet`. */
export function assertCommerceStoreId(input: unknown, label = 'store'): asserts input is StoreId {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 64
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input)
  ) {
    throw new Error(`${label} must be a lowercase kebab-case store identifier.`);
  }
}

function assertAdRewardTarget(input: unknown): asserts input is GameServicesAdRewardTarget {
  if (input !== 'browser' && input !== 'microsoft-store' && input !== 'android'
    && input !== 'ios' && input !== 'ait' && input !== 'reddit' && input !== 'verse8' && input !== 'oneplay') {
    throw new Error('target must be a supported platform target.');
  }
}

export function assertGameServicesDeploymentTarget(input: unknown): asserts input is string {
  if (
    typeof input !== 'string'
    || input.length > 64
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input)
    || reservedDeploymentTargetNames.has(input)
  ) {
    throw new Error('deploymentTarget must use lowercase kebab-case and avoid reserved names.');
  }
}

function assertOptionalGameServicesDeploymentTarget(
  input: unknown,
): asserts input is string | undefined {
  if (input === undefined) {
    return;
  }

  assertGameServicesDeploymentTarget(input);
}

const reservedDeploymentTargetNames = new Set([
  'aux',
  'browser',
  'con',
  'devvit',
  'index',
  'msstore',
  'nul',
  'prn',
  'constructor',
  'prototype',
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
]);

function assertLeaderboardTarget(input: unknown): asserts input is GameServicesLeaderboardTarget {
  if (
    input !== 'browser'
    && input !== 'microsoft-store'
    && input !== 'android'
    && input !== 'ios'
    && input !== 'ait'
    && input !== 'reddit'
  ) {
    throw new Error('target must be browser, microsoft-store, android, ios, ait, or reddit.');
  }
}

function validateRequest<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw toGameServicesRequestValidationError(error);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

/** Client-supplied identifiers feed ledger keys, so they are bounded as well as non-empty. */
function assertRequestString(input: unknown, label: string): asserts input is string {
  assertNonEmptyString(input, label);

  if (input.length > gameServicesRequestLimits.maxStringLength) {
    throw new Error(
      `${label} must not exceed ${String(gameServicesRequestLimits.maxStringLength)} characters.`,
    );
  }
}

function assertOptionalRequestString(
  input: unknown,
  label: string,
): asserts input is string | undefined {
  if (input !== undefined) {
    assertRequestString(input, label);
  }
}

function assertOptionalNonEmptyString(
  input: unknown,
  label: string,
): asserts input is string | undefined {
  if (input !== undefined) {
    assertNonEmptyString(input, label);
  }
}

function assertFiniteNumber(input: unknown, label: string): asserts input is number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertOptionalNonGrantDisposition(input: unknown, granted: boolean): void {
  if (input === undefined) {
    return;
  }
  if (input !== 'pending' && input !== 'rejected') {
    throw new Error('disposition must be pending or rejected.');
  }
  if (granted) {
    throw new Error('A granted result cannot have a non-grant disposition.');
  }
}

function assertPurchaseGrantFinalizationAction(
  input: unknown,
): asserts input is PurchaseGrantFinalizationAction {
  if (
    input !== 'acknowledge'
    && input !== 'consume'
    && input !== 'finish'
    && input !== 'complete'
  ) {
    throw new Error('finalization.action must be acknowledge, consume, finish, or complete.');
  }
}

function assertRevocationReason(input: unknown): asserts input is EntitlementRevocationReason {
  if (input !== 'refund' && input !== 'chargeback' && input !== 'voided' && input !== 'admin') {
    throw new Error('reason must be refund, chargeback, voided, or admin.');
  }
}

function assertLedgerSource(input: unknown): asserts input is EntitlementLedgerSource {
  if (input !== 'purchase' && input !== 'ad_reward' && input !== 'admin') {
    throw new Error('source must be purchase, ad_reward, or admin.');
  }
}

function assertProductGrant(input: unknown): asserts input is ProductGrant {
  assertRecord(input, 'grant');

  if (input.type === 'currency') {
    // The currency list is open; the backend checks it against the catalog's
    // declared currencies when it is constructed.
    assertNonEmptyString(input.currency, 'grant.currency');
    if (input.currency.trim() !== input.currency) {
      throw new Error('grant.currency must be a trimmed currency code.');
    }

    assertFiniteNumber(input.amount, 'grant.amount');
    return;
  }

  if (input.type === 'entitlement') {
    assertNonEmptyString(input.entitlement, 'grant.entitlement');
    return;
  }

  if (input.type === 'resource') {
    assertNonEmptyString(input.resource, 'grant.resource');
    assertFiniteNumber(input.amount, 'grant.amount');
    if (input.amount <= 0) {
      throw new Error('grant.amount must be greater than zero for a resource grant.');
    }
    return;
  }

  throw new Error('grant.type must be currency, entitlement, or resource.');
}

function assertPayload(input: unknown): asserts input is EntitlementLedgerPayload {
  assertRecord(input, 'payload');

  for (const [key, value] of Object.entries(input)) {
    const valueType = typeof value;

    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      throw new Error(`payload.${key} must be a string, number, or boolean.`);
    }
  }
}

function assertOptionalEvidenceEnvelope(
  input: unknown,
): asserts input is PlatformEvidenceEnvelope | undefined {
  if (input === undefined) {
    return;
  }

  assertRecord(input, 'evidence');
  assertRequestString(input.schema, 'evidence.schema');
  assertPayload(input.payload);
  assertOwnEnumerablePropertyLimit(
    input.payload,
    gameServicesRequestLimits.maxEvidencePayloadEntries,
    'evidence.payload',
  );
}

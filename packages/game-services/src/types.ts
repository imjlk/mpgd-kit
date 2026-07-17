import type { ProductGrant } from '@mpgd/catalog';
import type {
  LeaderboardScoreInput,
  LogicalAdPlacementId,
  LogicalProductId,
  PlatformEvidenceEnvelope,
  PlatformTarget,
} from '@mpgd/platform';

export type { PlatformEvidenceEnvelope } from '@mpgd/platform';

export type GameServicesStoreTarget = Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;
export type GameServicesAdRewardTarget = Extract<
  PlatformTarget,
  'android' | 'ios' | 'ait' | 'verse8'
>;
export type GameServicesLeaderboardTarget = Extract<
  PlatformTarget,
  'browser' | 'android' | 'ios' | 'ait' | 'reddit'
>;
export type GameServicesLedgerTarget = Extract<
  PlatformTarget,
  'browser' | 'android' | 'ios' | 'ait' | 'reddit' | 'verse8'
>;

export type PurchaseIdempotencyKey = string;
export type AdRewardIdempotencyKey = string;
export type EntitlementIdempotencyKey = PurchaseIdempotencyKey | AdRewardIdempotencyKey;

export type EntitlementLedgerSource = 'purchase' | 'ad_reward' | 'admin';
export type EntitlementLedgerPayload = Record<string, string | number | boolean>;

export interface VerifyPurchaseRequest {
  readonly target: GameServicesStoreTarget;
  readonly playerId: string;
  readonly productId: LogicalProductId;
  readonly platformTransactionId: string;
  readonly idempotencyKey: PurchaseIdempotencyKey;
  readonly purchasedAt: string;
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface VerifyPurchaseResponse {
  readonly verified: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
  readonly finalization?: PurchaseGrantFinalization;
}

export type PurchaseGrantFinalizationAction =
  | 'acknowledge'
  | 'consume'
  | 'finish'
  | 'complete';

export interface PurchaseGrantFinalization {
  readonly status: 'completed' | 'pending';
  readonly action?: PurchaseGrantFinalizationAction;
  readonly alreadyCompleted: boolean;
  readonly reason?: string;
}

export interface ClaimAdRewardRequest {
  readonly target: GameServicesAdRewardTarget;
  readonly playerId: string;
  readonly placementId: LogicalAdPlacementId;
  /** Platform evidence identity; AIT uses the game-issued reward correlation identifier. */
  readonly platformImpressionId?: string;
  readonly idempotencyKey: AdRewardIdempotencyKey;
  readonly completedAt: string;
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
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

export function assertVerifyPurchaseRequest(input: VerifyPurchaseRequest): VerifyPurchaseRequest {
  assertRecord(input, 'VerifyPurchaseRequest');
  assertStoreTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.productId, 'productId');
  assertNonEmptyString(input.platformTransactionId, 'platformTransactionId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.purchasedAt, 'purchasedAt');
  assertOptionalEvidenceEnvelope(input.evidence);

  return input;
}

export function assertVerifyPurchaseResponse(
  input: VerifyPurchaseResponse,
): VerifyPurchaseResponse {
  assertRecord(input, 'VerifyPurchaseResponse');
  assertBoolean(input.verified, 'verified');
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalNonEmptyString(input.reason, 'reason');
  if (input.finalization !== undefined) {
    assertPurchaseGrantFinalization(input.finalization);
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

export function assertClaimAdRewardRequest(
  input: ClaimAdRewardRequest,
): ClaimAdRewardRequest {
  assertRecord(input, 'ClaimAdRewardRequest');
  assertAdRewardTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.placementId, 'placementId');
  assertOptionalNonEmptyString(input.platformImpressionId, 'platformImpressionId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.completedAt, 'completedAt');
  assertOptionalEvidenceEnvelope(input.evidence);

  return input;
}

export function assertClaimAdRewardResponse(
  input: ClaimAdRewardResponse,
): ClaimAdRewardResponse {
  assertRecord(input, 'ClaimAdRewardResponse');
  assertBoolean(input.granted, 'granted');
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalNonEmptyString(input.reason, 'reason');

  return input;
}

export function assertRecordLeaderboardScoreRequest(
  input: RecordLeaderboardScoreRequest,
): RecordLeaderboardScoreRequest {
  assertRecord(input, 'RecordLeaderboardScoreRequest');
  assertLeaderboardTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.leaderboardId, 'leaderboardId');
  assertFiniteNumber(input.score, 'score');
  assertNonEmptyString(input.runId, 'runId');
  assertNonEmptyString(input.submittedAt, 'submittedAt');
  assertOptionalNonEmptyString(input.platformSubmissionId, 'platformSubmissionId');

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
  assertRecordLeaderboardScoreRequest(input);
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertNonEmptyString(input.recordedAt, 'recordedAt');

  return input;
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStoreTarget(input: unknown): asserts input is GameServicesStoreTarget {
  if (input !== 'android' && input !== 'ios' && input !== 'ait') {
    throw new Error('target must be android, ios, or ait.');
  }
}

function assertAdRewardTarget(input: unknown): asserts input is GameServicesAdRewardTarget {
  if (input !== 'android' && input !== 'ios' && input !== 'ait' && input !== 'verse8') {
    throw new Error('target must be android, ios, ait, or verse8.');
  }
}

function assertLeaderboardTarget(input: unknown): asserts input is GameServicesLeaderboardTarget {
  if (
    input !== 'browser'
    && input !== 'android'
    && input !== 'ios'
    && input !== 'ait'
    && input !== 'reddit'
  ) {
    throw new Error('target must be browser, android, ios, ait, or reddit.');
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
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

function assertLedgerSource(input: unknown): asserts input is EntitlementLedgerSource {
  if (input !== 'purchase' && input !== 'ad_reward' && input !== 'admin') {
    throw new Error('source must be purchase, ad_reward, or admin.');
  }
}

function assertProductGrant(input: unknown): asserts input is ProductGrant {
  assertRecord(input, 'grant');

  if (input.type === 'currency') {
    if (input.currency !== 'coin' && input.currency !== 'gem') {
      throw new Error('grant.currency must be coin or gem.');
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
  assertNonEmptyString(input.schema, 'evidence.schema');
  assertPayload(input.payload);
}

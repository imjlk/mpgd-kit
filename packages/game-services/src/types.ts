import type { ProductGrant } from '@mpgd/catalog';
import type {
  LeaderboardScoreInput,
  LogicalAdPlacementId,
  LogicalProductId,
  PlatformTarget,
} from '@mpgd/platform';

export type GameServicesStoreTarget = Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;
export type GameServicesLedgerTarget = Extract<PlatformTarget, 'browser' | 'android' | 'ios' | 'ait'>;

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
}

export interface VerifyPurchaseResponse {
  readonly verified: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
}

export interface ClaimAdRewardRequest {
  readonly target: GameServicesStoreTarget;
  readonly playerId: string;
  readonly placementId: LogicalAdPlacementId;
  readonly platformImpressionId?: string;
  readonly idempotencyKey: AdRewardIdempotencyKey;
  readonly completedAt: string;
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: 'UNKNOWN_PLACEMENT' | 'NOT_REWARDED_PLACEMENT';
}

export interface RecordLeaderboardScoreRequest extends LeaderboardScoreInput {
  readonly target: GameServicesLedgerTarget;
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

  return input;
}

export function assertClaimAdRewardRequest(
  input: ClaimAdRewardRequest,
): ClaimAdRewardRequest {
  assertRecord(input, 'ClaimAdRewardRequest');
  assertStoreTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.placementId, 'placementId');
  assertOptionalNonEmptyString(input.platformImpressionId, 'platformImpressionId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.completedAt, 'completedAt');

  return input;
}

export function assertClaimAdRewardResponse(
  input: ClaimAdRewardResponse,
): ClaimAdRewardResponse {
  assertRecord(input, 'ClaimAdRewardResponse');
  assertBoolean(input.granted, 'granted');
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalAdRewardReason(input.reason, 'reason');

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

function assertLeaderboardTarget(input: unknown): asserts input is GameServicesLedgerTarget {
  if (input !== 'browser' && input !== 'android' && input !== 'ios' && input !== 'ait') {
    throw new Error('target must be browser, android, ios, or ait.');
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

  throw new Error('grant.type must be currency or entitlement.');
}

function assertOptionalAdRewardReason(
  input: unknown,
  label: string,
): asserts input is ClaimAdRewardResponse['reason'] {
  if (
    input !== undefined
    && input !== 'UNKNOWN_PLACEMENT'
    && input !== 'NOT_REWARDED_PLACEMENT'
  ) {
    throw new Error(`${label} must be UNKNOWN_PLACEMENT or NOT_REWARDED_PLACEMENT.`);
  }
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

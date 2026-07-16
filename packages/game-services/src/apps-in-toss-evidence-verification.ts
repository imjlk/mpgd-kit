import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyAdRewardEvidenceInput,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification';

export const appsInTossPurchaseCallbackEvidenceSchema =
  'apps-in-toss.iap.callback.v1';
export const appsInTossRewardCallbackEvidenceSchema =
  'apps-in-toss.rewarded-ad.callback.v1';

export type AppsInTossPurchaseCallbackSource =
  | 'process-product-grant'
  | 'pending-order-restore'
  | 'success-event';

export type AppsInTossPurchaseOrderStatus =
  | 'PURCHASED'
  | 'PAYMENT_COMPLETED'
  | 'FAILED'
  | 'REFUNDED'
  | 'ORDER_IN_PROGRESS'
  | 'NOT_FOUND'
  | 'MINIAPP_MISMATCH'
  | 'ERROR';

export interface AppsInTossPurchaseCallbackEvidenceInput {
  readonly orderId: string;
  readonly platformSku: string;
  readonly source: AppsInTossPurchaseCallbackSource;
}

export interface AppsInTossRewardCallbackEvidenceInput {
  readonly impressionId: string;
  readonly platformPlacementId: string;
}

export interface AppsInTossPurchaseAuthorityInput {
  readonly orderId: string;
  readonly playerId: string;
  readonly platformSku: string;
  readonly signal: AbortSignal;
}

export interface AppsInTossPurchaseOrderRecord {
  readonly orderId: string;
  /**
   * Server-authenticated game player identity associated with the Toss login
   * user used for the order-status lookup.
   */
  readonly playerId: string;
  readonly sku: string;
  readonly status: AppsInTossPurchaseOrderStatus;
  readonly statusDeterminedAt: string;
}

export type AppsInTossPurchaseAuthorityResult =
  | {
      readonly decision: 'resolved';
      readonly order: AppsInTossPurchaseOrderRecord;
    }
  | {
      readonly decision: 'pending';
      readonly reason?: string;
    }
  | {
      readonly decision: 'rejected';
      readonly reason: string;
    };

export interface AppsInTossPurchaseAuthority {
  getOrderStatus(
    input: AppsInTossPurchaseAuthorityInput,
  ): Promise<AppsInTossPurchaseAuthorityResult>;
}

export interface AppsInTossRewardAuthorityInput {
  readonly impressionId: string;
  readonly playerId: string;
  readonly platformPlacementId: string;
  readonly signal: AbortSignal;
}

export type AppsInTossRewardAuthorityResult =
  | {
      readonly decision: 'verified';
      /** Stable, consume-once identity issued by the production authority. */
      readonly authorityEventId: string;
      readonly impressionId: string;
      readonly playerId: string;
      readonly platformPlacementId: string;
      readonly verifiedAt: string;
    }
  | {
      readonly decision: 'pending';
      readonly reason?: string;
    }
  | {
      readonly decision: 'rejected';
      readonly reason: string;
    };

/**
 * Game-owned production verification port. Apps in Toss documents the client
 * `userEarnedReward` event, but this contract deliberately does not prescribe
 * an undocumented Toss server callback endpoint.
 */
export interface AppsInTossRewardAuthority {
  verifyReward(
    input: AppsInTossRewardAuthorityInput,
  ): Promise<AppsInTossRewardAuthorityResult>;
}

export interface CreateAppsInTossProductionEvidenceVerifierInput {
  /**
   * Implement with the partner-server order-status API, authenticated Toss
   * login identity, and runtime-injected mTLS credentials.
   */
  readonly purchaseAuthority?: AppsInTossPurchaseAuthority;
  /**
   * Implement with a game-owned server authority that independently confirms
   * the rewarded event. Client callbacks alone are never sufficient.
   */
  readonly rewardAuthority?: AppsInTossRewardAuthority;
}

export function createAppsInTossPurchaseCallbackEvidence(
  input: AppsInTossPurchaseCallbackEvidenceInput,
): PlatformEvidenceEnvelope {
  requireIdentifier(input.orderId, 'orderId');
  requireIdentifier(input.platformSku, 'platformSku');
  requirePurchaseCallbackSource(input.source);

  return {
    schema: appsInTossPurchaseCallbackEvidenceSchema,
    payload: {
      orderId: input.orderId,
      sku: input.platformSku,
      source: input.source,
    },
  };
}

export function createAppsInTossRewardCallbackEvidence(
  input: AppsInTossRewardCallbackEvidenceInput,
): PlatformEvidenceEnvelope {
  requireIdentifier(input.impressionId, 'impressionId');
  requireIdentifier(input.platformPlacementId, 'platformPlacementId');

  return {
    schema: appsInTossRewardCallbackEvidenceSchema,
    payload: {
      event: 'user-earned-reward',
      impressionId: input.impressionId,
      placementId: input.platformPlacementId,
    },
  };
}

export function createAppsInTossProductionEvidenceVerifier(
  input: CreateAppsInTossProductionEvidenceVerifierInput = {},
): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase(verificationInput) {
      return verifyAppsInTossPurchase(input.purchaseAuthority, verificationInput);
    },
    async verifyAdReward(verificationInput) {
      return verifyAppsInTossReward(input.rewardAuthority, verificationInput);
    },
  };
}

async function verifyAppsInTossPurchase(
  authority: AppsInTossPurchaseAuthority | undefined,
  input: VerifyPurchaseEvidenceInput,
): Promise<EvidenceVerificationDecision> {
  const { request, platformProductId } = input;

  if (request.target !== 'ait') {
    return rejected('AIT_PURCHASE_TARGET_REQUIRED');
  }

  if (request.evidence?.schema !== appsInTossPurchaseCallbackEvidenceSchema) {
    return rejected('AIT_PURCHASE_EVIDENCE_SCHEMA_INVALID');
  }

  const evidenceOrderId = readEvidenceString(request.evidence.payload, 'orderId');
  const evidenceSku = readEvidenceString(request.evidence.payload, 'sku');
  const callbackSource = readEvidenceString(request.evidence.payload, 'source');

  if (evidenceOrderId !== request.platformTransactionId) {
    return rejected('AIT_PURCHASE_ORDER_ID_MISMATCH');
  }

  if (evidenceSku !== platformProductId) {
    return rejected('AIT_PURCHASE_SKU_MISMATCH');
  }

  if (!isPurchaseCallbackSource(callbackSource)) {
    return rejected('AIT_PURCHASE_CALLBACK_SOURCE_INVALID');
  }

  if (authority === undefined) {
    return rejected('AIT_PURCHASE_AUTHORITY_UNAVAILABLE');
  }

  const result = assertPurchaseAuthorityResult(await authority.getOrderStatus({
    orderId: request.platformTransactionId,
    playerId: request.playerId,
    platformSku: platformProductId,
    signal: input.signal,
  }));

  if (result.decision === 'pending') {
    return pending(result.reason ?? 'AIT_PURCHASE_AUTHORITY_PENDING');
  }

  if (result.decision === 'rejected') {
    return rejected(result.reason);
  }

  const { order } = result;

  if (order.orderId !== request.platformTransactionId) {
    return rejected('AIT_PURCHASE_AUTHORITY_ORDER_ID_MISMATCH');
  }

  if (order.playerId !== request.playerId) {
    return rejected('AIT_PURCHASE_AUTHORITY_PLAYER_MISMATCH');
  }

  if (order.sku !== platformProductId) {
    return rejected('AIT_PURCHASE_AUTHORITY_SKU_MISMATCH');
  }

  const verifiedAt = normalizeTimestamp(order.statusDeterminedAt);
  if (verifiedAt === undefined) {
    return rejected('AIT_PURCHASE_AUTHORITY_TIMESTAMP_INVALID');
  }

  if (order.status === 'ORDER_IN_PROGRESS' || order.status === 'ERROR') {
    return pending(`AIT_PURCHASE_ORDER_${order.status}`);
  }

  if (order.status !== 'PURCHASED' && order.status !== 'PAYMENT_COMPLETED') {
    return rejected(`AIT_PURCHASE_ORDER_${order.status}`);
  }

  return {
    status: 'verified',
    verificationId: createVerificationId('purchase', order.orderId),
    verifiedAt,
    payload: {
      appsInTossOrderId: order.orderId,
      appsInTossSku: order.sku,
      appsInTossOrderStatus: order.status,
      appsInTossGrantCompletionRequired: order.status === 'PAYMENT_COMPLETED',
    },
  };
}

async function verifyAppsInTossReward(
  authority: AppsInTossRewardAuthority | undefined,
  input: VerifyAdRewardEvidenceInput,
): Promise<EvidenceVerificationDecision> {
  const { request, platformPlacementId } = input;

  if (request.target !== 'ait') {
    return rejected('AIT_REWARD_TARGET_REQUIRED');
  }

  if (platformPlacementId === undefined || platformPlacementId.length === 0) {
    return rejected('AIT_REWARD_PLACEMENT_UNCONFIGURED');
  }

  const impressionId = request.platformImpressionId;
  if (impressionId === undefined) {
    return rejected('AIT_REWARD_IMPRESSION_ID_REQUIRED');
  }

  if (request.evidence?.schema !== appsInTossRewardCallbackEvidenceSchema) {
    return rejected('AIT_REWARD_EVIDENCE_SCHEMA_INVALID');
  }

  const callbackEvent = readEvidenceString(request.evidence.payload, 'event');
  const evidenceImpressionId = readEvidenceString(request.evidence.payload, 'impressionId');
  const evidencePlacementId = readEvidenceString(request.evidence.payload, 'placementId');

  if (callbackEvent !== 'user-earned-reward') {
    return rejected('AIT_REWARD_CALLBACK_EVENT_INVALID');
  }

  if (evidenceImpressionId !== impressionId) {
    return rejected('AIT_REWARD_IMPRESSION_ID_MISMATCH');
  }

  if (evidencePlacementId !== platformPlacementId) {
    return rejected('AIT_REWARD_PLACEMENT_MISMATCH');
  }

  if (authority === undefined) {
    return rejected('AIT_REWARD_AUTHORITY_UNAVAILABLE');
  }

  const result = assertRewardAuthorityResult(await authority.verifyReward({
    impressionId,
    playerId: request.playerId,
    platformPlacementId,
    signal: input.signal,
  }));

  if (result.decision === 'pending') {
    return pending(result.reason ?? 'AIT_REWARD_AUTHORITY_PENDING');
  }

  if (result.decision === 'rejected') {
    return rejected(result.reason);
  }

  if (result.impressionId !== impressionId) {
    return rejected('AIT_REWARD_AUTHORITY_IMPRESSION_ID_MISMATCH');
  }

  if (result.playerId !== request.playerId) {
    return rejected('AIT_REWARD_AUTHORITY_PLAYER_MISMATCH');
  }

  if (result.platformPlacementId !== platformPlacementId) {
    return rejected('AIT_REWARD_AUTHORITY_PLACEMENT_MISMATCH');
  }

  const verifiedAt = normalizeTimestamp(result.verifiedAt);
  if (verifiedAt === undefined) {
    return rejected('AIT_REWARD_AUTHORITY_TIMESTAMP_INVALID');
  }

  return {
    status: 'verified',
    verificationId: createVerificationId('ad-reward', result.authorityEventId),
    verifiedAt,
    payload: {
      appsInTossRewardAuthorityEventId: result.authorityEventId,
      appsInTossRewardImpressionId: result.impressionId,
      appsInTossRewardPlacementId: result.platformPlacementId,
    },
  };
}

function assertPurchaseAuthorityResult(
  input: AppsInTossPurchaseAuthorityResult,
): AppsInTossPurchaseAuthorityResult {
  requireRecord(input, 'purchase authority result');

  if (input.decision === 'pending') {
    requireOptionalReason(input.reason);
    return input;
  }

  if (input.decision === 'rejected') {
    requireIdentifier(input.reason, 'purchase authority reason');
    return input;
  }

  if (input.decision !== 'resolved') {
    throw new Error('Apps in Toss purchase authority decision is invalid.');
  }

  requireRecord(input.order, 'purchase authority order');
  requireIdentifier(input.order.orderId, 'purchase authority orderId');
  requireIdentifier(input.order.playerId, 'purchase authority playerId');
  requireIdentifier(input.order.sku, 'purchase authority sku');
  requirePurchaseOrderStatus(input.order.status);
  requireIdentifier(input.order.statusDeterminedAt, 'purchase authority statusDeterminedAt');

  return input;
}

function assertRewardAuthorityResult(
  input: AppsInTossRewardAuthorityResult,
): AppsInTossRewardAuthorityResult {
  requireRecord(input, 'reward authority result');

  if (input.decision === 'pending') {
    requireOptionalReason(input.reason);
    return input;
  }

  if (input.decision === 'rejected') {
    requireIdentifier(input.reason, 'reward authority reason');
    return input;
  }

  if (input.decision !== 'verified') {
    throw new Error('Apps in Toss reward authority decision is invalid.');
  }

  requireIdentifier(input.authorityEventId, 'reward authority event id');
  requireIdentifier(input.impressionId, 'reward authority impression id');
  requireIdentifier(input.playerId, 'reward authority player id');
  requireIdentifier(input.platformPlacementId, 'reward authority placement id');
  requireIdentifier(input.verifiedAt, 'reward authority verifiedAt');

  return input;
}

function createVerificationId(kind: 'purchase' | 'ad-reward', value: string): string {
  return `apps-in-toss:${kind}:${encodeURIComponent(value)}`;
}

function readEvidenceString(
  payload: Readonly<Record<string, string | number | boolean>>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeTimestamp(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function pending(reason: string): EvidenceVerificationDecision {
  return { status: 'pending', reason };
}

function rejected(reason: string): EvidenceVerificationDecision {
  return { status: 'rejected', reason };
}

function requireRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requireIdentifier(input: unknown, label: string): asserts input is string {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 512
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
}

function requireOptionalReason(input: unknown): asserts input is string | undefined {
  if (input !== undefined) {
    requireIdentifier(input, 'authority reason');
  }
}

function requirePurchaseCallbackSource(
  input: unknown,
): asserts input is AppsInTossPurchaseCallbackSource {
  if (!isPurchaseCallbackSource(input)) {
    throw new TypeError('source must identify a supported Apps in Toss purchase callback.');
  }
}

function isPurchaseCallbackSource(
  input: unknown,
): input is AppsInTossPurchaseCallbackSource {
  return input === 'process-product-grant'
    || input === 'pending-order-restore'
    || input === 'success-event';
}

function requirePurchaseOrderStatus(
  input: unknown,
): asserts input is AppsInTossPurchaseOrderStatus {
  if (
    input !== 'PURCHASED'
    && input !== 'PAYMENT_COMPLETED'
    && input !== 'FAILED'
    && input !== 'REFUNDED'
    && input !== 'ORDER_IN_PROGRESS'
    && input !== 'NOT_FOUND'
    && input !== 'MINIAPP_MISMATCH'
    && input !== 'ERROR'
  ) {
    throw new TypeError('Apps in Toss purchase order status is invalid.');
  }
}

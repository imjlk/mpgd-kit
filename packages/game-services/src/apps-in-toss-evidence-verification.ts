import type { LogicalProductId, PlatformEvidenceEnvelope } from '@mpgd/platform';

import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyAdRewardEvidenceInput,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification';
import type { VerifyPurchaseRequest, VerifyPurchaseResponse } from './types';

export const appsInTossPurchaseCallbackEvidenceSchema =
  'apps-in-toss.iap.callback.v1';
export const appsInTossRewardCallbackEvidenceSchema =
  'apps-in-toss.rewarded-ad.callback.v1';
/** Leaves five seconds of headroom inside the SDK's documented 30-second window. */
export const appsInTossProductGrantCallbackTimeoutMs = 25_000;

// Offset-free order-status timestamps are documented as KST (UTC+09:00).
const appsInTossKstOffsetMinutes = 9 * 60;
const appsInTossAuthorityReasonMaxLength = 4_096;
const appsInTossTimestampPattern = new RegExp(
  String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})`
    + String.raw`(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))?$`,
  'u',
);

export type AppsInTossPurchaseCallbackSource =
  | 'process-product-grant'
  | 'pending-order-restore';

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
  /** Game-issued correlation id created before showing the rewarded ad. */
  readonly correlationId: string;
  readonly platformPlacementId: string;
}

const appsInTossProductGrantVerificationPortBrand: unique symbol = Symbol(
  'AppsInTossProductGrantVerificationPort',
);

export interface AppsInTossProductGrantVerificationInput {
  readonly request: VerifyPurchaseRequest;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface AppsInTossProductGrantVerificationPort {
  readonly [appsInTossProductGrantVerificationPortBrand]: true;
  /**
   * Must honor `signal` and `timeoutMs` through the transport and authoritative ledger write.
   * Once aborted, the implementation must guarantee that the request cannot
   * later commit a grant after the SDK callback has returned `false`.
   */
  verifyPurchase(
    input: AppsInTossProductGrantVerificationInput,
  ): Promise<VerifyPurchaseResponse>;
}

export type AppsInTossProductGrantVerification = (
  input: AppsInTossProductGrantVerificationInput,
) => Promise<VerifyPurchaseResponse>;

export interface VerifyAppsInTossProductGrantInput {
  readonly purchaseVerification: AppsInTossProductGrantVerificationPort;
  readonly orderId: string;
  readonly playerId: string;
  readonly productId: LogicalProductId;
  readonly platformSku: string;
  readonly idempotencyKey?: string;
  readonly source: AppsInTossPurchaseCallbackSource;
  readonly purchasedAt: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface CreateAppsInTossProductGrantCallbackInput {
  readonly purchaseVerification: AppsInTossProductGrantVerificationPort;
  readonly playerId: string;
  readonly productId: LogicalProductId;
  readonly platformSku: string;
  /** Override only when the same function can be recreated for pending restore. */
  readonly idempotencyKey?: (orderId: string) => string;
  /** May be shortened, but never extended beyond the SDK-safe default. */
  readonly timeoutMs?: number;
  readonly now?: () => string;
  /** Receives backend, transport, and deadline failures before the callback fails closed. */
  readonly onVerificationError?: (error: unknown) => void;
}

export interface AppsInTossProcessProductGrantInput {
  readonly orderId: string;
}

export type AppsInTossProcessProductGrant = (
  input: AppsInTossProcessProductGrantInput,
) => Promise<boolean>;

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
  /** Game-issued id that correlates the show request and reward callback. */
  readonly correlationId: string;
  readonly playerId: string;
  readonly platformPlacementId: string;
  readonly signal: AbortSignal;
}

export type AppsInTossRewardAuthorityResult =
  | {
      readonly decision: 'verified';
      /** Stable, consume-once identity issued by the production authority. */
      readonly authorityEventId: string;
      readonly correlationId: string;
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
  requireIdentifier(input.correlationId, 'correlationId');
  requireIdentifier(input.platformPlacementId, 'platformPlacementId');

  return {
    schema: appsInTossRewardCallbackEvidenceSchema,
    payload: {
      event: 'user-earned-reward',
      correlationId: input.correlationId,
      placementId: input.platformPlacementId,
    },
  };
}

/**
 * Creates a nominal, abort-aware port so the legacy one-argument backend API
 * cannot be passed to the SDK callback accidentally.
 */
export function createAppsInTossProductGrantVerificationPort(
  verifyPurchase: AppsInTossProductGrantVerification,
): AppsInTossProductGrantVerificationPort {
  return {
    [appsInTossProductGrantVerificationPortBrand]: true,
    verifyPurchase,
  };
}

/**
 * Sends an Apps in Toss product-grant callback to the authoritative backend.
 * This is intentionally callable from inside the SDK's `processProductGrant`
 * callback, before `createOneTimePurchaseOrder` emits its success event.
 */
export function verifyAppsInTossProductGrant(
  input: VerifyAppsInTossProductGrantInput,
): Promise<VerifyPurchaseResponse> {
  const evidence = createAppsInTossPurchaseCallbackEvidence({
    orderId: input.orderId,
    platformSku: input.platformSku,
    source: input.source,
  });

  return input.purchaseVerification.verifyPurchase({
    request: {
      target: 'ait',
      playerId: input.playerId,
      productId: input.productId,
      platformTransactionId: input.orderId,
      idempotencyKey: input.idempotencyKey
        ?? createAppsInTossPurchaseIdempotencyKey(input.orderId),
      purchasedAt: input.purchasedAt,
      evidence,
    },
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
}

export function createAppsInTossPurchaseIdempotencyKey(orderId: string): string {
  requireIdentifier(orderId, 'orderId');
  return `apps-in-toss:purchase:${encodeURIComponent(orderId)}`;
}

/**
 * Creates the exact async boolean callback expected by Apps in Toss IAP.
 * Backend rejection and transport failures both return `false` so the SDK can
 * retain the order for later pending-order recovery.
 */
export function createAppsInTossProductGrantCallback(
  input: CreateAppsInTossProductGrantCallbackInput,
): AppsInTossProcessProductGrant {
  const now = input.now ?? (() => new Date().toISOString());
  const timeoutMs = input.timeoutMs ?? appsInTossProductGrantCallbackTimeoutMs;
  requireProductGrantCallbackTimeout(timeoutMs);

  return async ({ orderId }) => {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const verification = await Promise.race([
        verifyAppsInTossProductGrant({
          purchaseVerification: input.purchaseVerification,
          orderId,
          playerId: input.playerId,
          productId: input.productId,
          platformSku: input.platformSku,
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey(orderId) }),
          source: 'process-product-grant',
          purchasedAt: now(),
          signal: abortController.signal,
          timeoutMs,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            abortController.abort();
            reject(new Error('Apps in Toss product-grant verification timed out.'));
          }, timeoutMs);
        }),
      ]);

      if (!verification.verified) {
        const reason = verification.reason ?? 'BACKEND_REJECTED';
        const verificationError = new Error(
          `Apps in Toss product-grant verification failed: ${reason}.`,
        );
        reportProductGrantVerificationError(input.onVerificationError, verificationError);
      }

      return verification.verified;
    } catch (error) {
      abortController.abort();
      reportProductGrantVerificationError(input.onVerificationError, error);
      return false;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
}

function reportProductGrantVerificationError(
  onVerificationError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onVerificationError?.(error);
  } catch {
    // Diagnostics must never break the SDK's required boolean callback contract.
  }
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

  const verifiedAt = normalizeTimestamp(order.statusDeterminedAt, appsInTossKstOffsetMinutes);
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

  if (request.evidence?.schema !== appsInTossRewardCallbackEvidenceSchema) {
    return rejected('AIT_REWARD_EVIDENCE_SCHEMA_INVALID');
  }

  const callbackEvent = readEvidenceString(request.evidence.payload, 'event');
  const correlationId = readEvidenceString(request.evidence.payload, 'correlationId');
  const evidencePlacementId = readEvidenceString(request.evidence.payload, 'placementId');

  if (callbackEvent !== 'user-earned-reward') {
    return rejected('AIT_REWARD_CALLBACK_EVENT_INVALID');
  }

  if (correlationId === undefined) {
    return rejected('AIT_REWARD_CORRELATION_ID_REQUIRED');
  }

  if (evidencePlacementId !== platformPlacementId) {
    return rejected('AIT_REWARD_PLACEMENT_MISMATCH');
  }

  if (authority === undefined) {
    return rejected('AIT_REWARD_AUTHORITY_UNAVAILABLE');
  }

  const result = assertRewardAuthorityResult(await authority.verifyReward({
    correlationId,
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

  if (result.correlationId !== correlationId) {
    return rejected('AIT_REWARD_AUTHORITY_CORRELATION_ID_MISMATCH');
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
      appsInTossRewardCorrelationId: result.correlationId,
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
    requireAuthorityReason(input.reason, 'purchase authority reason');
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
    requireAuthorityReason(input.reason, 'reward authority reason');
    return input;
  }

  if (input.decision !== 'verified') {
    throw new Error('Apps in Toss reward authority decision is invalid.');
  }

  requireIdentifier(input.authorityEventId, 'reward authority event id');
  requireIdentifier(input.correlationId, 'reward authority correlation id');
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

function normalizeTimestamp(
  value: string,
  offsetFreeOffsetMinutes?: number,
): string | undefined {
  const match = appsInTossTimestampPattern.exec(value);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));

  if (
    year < 1000
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return undefined;
  }

  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const wallClockDate = new Date(wallClock);
  if (
    wallClockDate.getUTCFullYear() !== year
    || wallClockDate.getUTCMonth() !== month - 1
    || wallClockDate.getUTCDate() !== day
    || wallClockDate.getUTCHours() !== hour
    || wallClockDate.getUTCMinutes() !== minute
    || wallClockDate.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  let offsetMinutes = offsetFreeOffsetMinutes;
  if (match[8] === 'Z') {
    offsetMinutes = 0;
  } else if (match[9] !== undefined) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return undefined;
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[9] === '+' ? 1 : -1);
  }

  if (offsetMinutes === undefined) {
    return undefined;
  }

  return new Date(wallClock - offsetMinutes * 60_000).toISOString();
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
    requireAuthorityReason(input, 'authority reason');
  }
}

function requireAuthorityReason(input: unknown, label: string): asserts input is string {
  if (
    typeof input !== 'string'
    || input.trim().length === 0
    || input.length > appsInTossAuthorityReasonMaxLength
  ) {
    throw new TypeError(
      `${label} must be a non-empty string no longer than `
      + `${appsInTossAuthorityReasonMaxLength} characters.`,
    );
  }
}

function requireProductGrantCallbackTimeout(input: number): void {
  if (
    !Number.isInteger(input)
    || input < 1
    || input > appsInTossProductGrantCallbackTimeoutMs
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${appsInTossProductGrantCallbackTimeoutMs}.`,
    );
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
    || input === 'pending-order-restore';
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

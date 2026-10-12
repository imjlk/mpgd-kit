import type { ProductCatalog } from '@mpgd/catalog';
import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

import {
  createServerPushLedgerGrant,
  devvitCommerceStoreId,
  findPurchaseGrantByPlatformEvidence,
} from './commerce-evidence-registry.js';
import { revokeEntitlementGrant, type RevokeEntitlementGrantResult } from './commerce-ledger.js';
import type { GameServicesStore } from './server.js';
import type { EntitlementLedgerGrant, VerifyPurchaseRequest } from './types.js';

export type PlatformOrderTarget = 'reddit';

export interface FulfillPlatformOrderInput {
  readonly target: PlatformOrderTarget;
  readonly orderId: string;
  readonly playerId: string;
  readonly platformSku: string;
  readonly paidAt: string;
  readonly evidence: PlatformEvidenceEnvelope;
}

export interface RefundPlatformOrderInput {
  readonly target: PlatformOrderTarget;
  readonly orderId: string;
  readonly playerId: string;
  readonly platformSku: string;
  readonly refundedAt: string;
  readonly evidence: PlatformEvidenceEnvelope;
}

export type PlatformOrderIdempotencyKey = `${PlatformOrderTarget}:${string}`;

export function createPlatformOrderIdempotencyKey(
  input: Pick<FulfillPlatformOrderInput, 'target' | 'orderId'>,
): PlatformOrderIdempotencyKey {
  assertPlatformOrderTarget(input.target);
  assertIdentifier(input.orderId, 'orderId');

  return `${input.target}:${input.orderId}`;
}

export function assertFulfillPlatformOrderInput(
  input: FulfillPlatformOrderInput,
): FulfillPlatformOrderInput {
  assertPlatformOrderBase(input, 'FulfillPlatformOrderInput');
  assertIsoTimestamp(input.paidAt, 'paidAt');

  return input;
}

export function assertRefundPlatformOrderInput(
  input: RefundPlatformOrderInput,
): RefundPlatformOrderInput {
  assertPlatformOrderBase(input, 'RefundPlatformOrderInput');
  assertIsoTimestamp(input.refundedAt, 'refundedAt');

  return input;
}

function assertPlatformOrderBase(
  input: FulfillPlatformOrderInput | RefundPlatformOrderInput,
  label: string,
): void {
  assertRecord(input, label);
  assertPlatformOrderTarget(input.target);
  assertIdentifier(input.orderId, 'orderId');
  assertIdentifier(input.playerId, 'playerId');
  assertIdentifier(input.platformSku, 'platformSku');
  assertEvidenceEnvelope(input.evidence);
}

function assertPlatformOrderTarget(input: unknown): asserts input is PlatformOrderTarget {
  if (input !== 'reddit') {
    throw new TypeError('target must be reddit.');
  }
}

function assertIdentifier(input: unknown, label: string): asserts input is string {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 256
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
}

function assertIsoTimestamp(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input)) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp.`);
  }

  const parsed = new Date(input);
  const canonicalInput = input.includes('.') ? input : `${input.slice(0, -1)}.000Z`;

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonicalInput) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp.`);
  }
}

function assertEvidenceEnvelope(input: unknown): asserts input is PlatformEvidenceEnvelope {
  assertRecord(input, 'evidence');
  assertIdentifier(input.schema, 'evidence.schema');
  assertRecord(input.payload, 'evidence.payload');

  for (const [key, value] of Object.entries(input.payload)) {
    assertIdentifier(key, 'evidence.payload key');
    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
    ) {
      throw new TypeError('evidence.payload values must be strings, numbers, or booleans.');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('evidence.payload numbers must be finite.');
    }
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

export interface CreatePlatformOrderLedgerGrantInput {
  readonly order: FulfillPlatformOrderInput;
  /** The catalog product the order's `platformSku` resolves to for the order target. */
  readonly product: ProductCatalog['products'][number];
  readonly grantedAt: string;
  readonly deploymentTarget?: string;
}

/**
 * The ledger grant a Devvit fulfillment handler writes for a paid order
 * (`normalizeDevvitFulfillmentOrder`), under the platform order key
 * `reddit:<orderId>` and in the shape the `devvit.order.v1` lookup verifier
 * reads (target `reddit`, store `devvit`, the order id as the platform
 * transaction id). Its evidence identity equals the one
 * `createDevvitPaymentOrderEvidenceVerifier` issues, so a fulfillment that
 * went through `verifyPurchase` and one that wrote the ledger directly
 * dedupe on the same order.
 */
export function createPlatformOrderLedgerGrant(
  input: CreatePlatformOrderLedgerGrantInput,
): EntitlementLedgerGrant {
  const order = assertFulfillPlatformOrderInput(input.order);
  return createServerPushLedgerGrant({
    store: devvitCommerceStoreId,
    target: order.target,
    ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
    playerId: order.playerId,
    product: input.product,
    platformProductId: order.platformSku,
    transactionId: order.orderId,
    purchasedAt: order.paidAt,
    grantedAt: input.grantedAt,
    evidence: order.evidence,
    idempotencyKey: createPlatformOrderIdempotencyKey(order),
    evidenceVerificationId: createPlatformOrderEvidenceVerificationId(order),
  });
}

/**
 * The verify request a fulfillment handler sends when the backend verifies
 * the order through the `devvit.payment-order.v1` registry entry instead of
 * writing the ledger directly: the platform order key, the order id as the
 * platform transaction id, and the handler's own envelope as evidence.
 */
export function createPlatformOrderVerifyRequest(input: {
  readonly order: FulfillPlatformOrderInput;
  readonly productId: VerifyPurchaseRequest['productId'];
  readonly deploymentTarget?: string;
}): VerifyPurchaseRequest {
  const order = assertFulfillPlatformOrderInput(input.order);
  return {
    target: order.target,
    store: devvitCommerceStoreId,
    ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
    playerId: order.playerId,
    productId: input.productId,
    platformTransactionId: order.orderId,
    idempotencyKey: createPlatformOrderIdempotencyKey(order),
    purchasedAt: order.paidAt,
    evidence: order.evidence,
  };
}

export type RevokePlatformOrderResult = RevokeEntitlementGrantResult;

/**
 * Writes the `revoke` entry for a refunded order (`normalizeDevvitRefundOrder`):
 * the grant written for the same order id under the order target is
 * reversed once, under the key `reddit:<orderId>:refund`. Answers
 * `grant_not_found` when no grant for that order exists (the refund arrived
 * before, or without, a fulfillment) and `grant_mismatch` when the grant
 * belongs to another player.
 */
export async function revokePlatformOrder(input: {
  readonly store: GameServicesStore;
  readonly order: RefundPlatformOrderInput;
  readonly revokedAt?: string;
}): Promise<RevokePlatformOrderResult> {
  const order = assertRefundPlatformOrderInput(input.order);
  const grant = await findPurchaseGrantByPlatformEvidence(input.store, {
    target: order.target,
    platformEvidenceId: order.orderId,
  });
  if (grant === undefined) {
    return { status: 'grant_not_found' };
  }
  return revokeEntitlementGrant(input.store, {
    playerId: order.playerId,
    revokesLedgerEntryId: grant.ledgerEntryId,
    idempotencyKey: `${createPlatformOrderIdempotencyKey(order)}:refund`,
    reason: 'refund',
    revokedAt: input.revokedAt ?? order.refundedAt,
    evidenceVerificationId: `${createPlatformOrderEvidenceVerificationId(order)}:refund`,
    payload: {
      target: order.target,
      store: devvitCommerceStoreId,
      platformTransactionId: order.orderId,
      platformProductId: order.platformSku,
      refundedAt: order.refundedAt,
      evidenceSchema: order.evidence.schema,
    },
  });
}

function createPlatformOrderEvidenceVerificationId(
  order: Pick<FulfillPlatformOrderInput, 'orderId'>,
): string {
  return `devvit:payment-order:${order.orderId}`;
}

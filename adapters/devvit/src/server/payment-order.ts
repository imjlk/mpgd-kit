import {
  assertFulfillPlatformOrderInput,
  assertRefundPlatformOrderInput,
  type FulfillPlatformOrderInput,
  type RefundPlatformOrderInput,
} from '@mpgd/game-services/platform-order';
import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

const devvitPaymentOrderEvidenceSchema = 'devvit.payment-order.v1';

export function normalizeDevvitFulfillmentOrder(
  input: unknown,
): FulfillPlatformOrderInput {
  const order = normalizeDevvitOrder(input, 'PAID');
  const normalized = Object.freeze({
    target: 'reddit',
    orderId: order.orderId,
    playerId: order.playerId,
    platformSku: order.platformSku,
    paidAt: order.occurredAt,
    evidence: order.evidence,
  }) satisfies FulfillPlatformOrderInput;

  return assertFulfillPlatformOrderInput(normalized);
}

export function normalizeDevvitRefundOrder(input: unknown): RefundPlatformOrderInput {
  const order = normalizeDevvitOrder(input, 'REVERTED');
  const normalized = Object.freeze({
    target: 'reddit',
    orderId: order.orderId,
    playerId: order.playerId,
    platformSku: order.platformSku,
    refundedAt: order.occurredAt,
    evidence: order.evidence,
  }) satisfies RefundPlatformOrderInput;

  return assertRefundPlatformOrderInput(normalized);
}

function normalizeDevvitOrder(
  input: unknown,
  expectedStatus: 'PAID' | 'REVERTED',
): Readonly<{
  orderId: string;
  playerId: string;
  platformSku: string;
  occurredAt: string;
  evidence: PlatformEvidenceEnvelope;
}> {
  const record = requireRecord(input, 'Devvit payment order');
  if (record.status !== expectedStatus) {
    throw new TypeError(`Devvit payment order status must be ${expectedStatus}.`);
  }
  if (!Array.isArray(record.products) || record.products.length !== 1) {
    throw new TypeError('Devvit payment order must contain exactly one product.');
  }

  const product = requireRecord(record.products[0], 'Devvit payment product');
  const orderId = requireString(record.id, 'order.id');
  const playerId = requireString(record.userId, 'order.userId');
  const platformSku = requireString(product.sku, 'order.products[0].sku');
  const occurredAt = requireString(record.updatedAt ?? record.createdAt, 'order.updatedAt');
  const evidencePayload: Record<string, string | number | boolean> = {
    orderId,
    status: expectedStatus,
    occurredAt,
  };

  copyOptionalEvidenceField(record, evidencePayload, 'postId');
  copyOptionalEvidenceField(record, evidencePayload, 'environment');

  return Object.freeze({
    orderId,
    playerId,
    platformSku,
    occurredAt,
    evidence: Object.freeze({
      schema: devvitPaymentOrderEvidenceSchema,
      payload: Object.freeze(evidencePayload),
    }),
  });
}

function copyOptionalEvidenceField(
  source: Readonly<Record<string, unknown>>,
  target: Record<string, string | number | boolean>,
  key: 'postId' | 'environment',
): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = requireString(value, `order.${key}`);
  }
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }

  return input;
}

function requireRecord(
  input: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return input as Readonly<Record<string, unknown>>;
}

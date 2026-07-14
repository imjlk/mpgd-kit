import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

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
  if (
    typeof input !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input)
    || Number.isNaN(Date.parse(input))
  ) {
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

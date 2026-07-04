import type { EntitlementLedger } from '@mpgd/backend-entitlement-ledger';
import type { LogicalProductId } from '@mpgd/monetization-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';

export type PurchaseIdempotencyKey = string;

export interface VerifyPurchaseRequest {
  readonly target: 'android' | 'ios' | 'ait';
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

export interface VerifyPurchaseContext {
  readonly catalog: ProductCatalog;
  readonly ledger: EntitlementLedger;
  readonly now?: () => string;
}

export function assertVerifyPurchaseRequest(
  input: VerifyPurchaseRequest,
): VerifyPurchaseRequest {
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

export function verifyPurchase(
  input: VerifyPurchaseRequest,
  context: VerifyPurchaseContext,
): VerifyPurchaseResponse {
  const request = assertVerifyPurchaseRequest(input);
  const product = context.catalog.products.find((entry) => entry.id === request.productId);

  if (product === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  }

  const platformProductId = product.platformProductIds[request.target];

  if (platformProductId === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'PRODUCT_NOT_AVAILABLE_ON_TARGET',
    });
  }

  const grant = context.ledger.recordGrant({
    playerId: request.playerId,
    grantId: product.id,
    source: 'purchase',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now?.() ?? new Date().toISOString(),
    grant: product.grant,
    payload: {
      target: request.target,
      productId: request.productId,
      platformProductId,
      platformTransactionId: request.platformTransactionId,
      purchasedAt: request.purchasedAt,
    },
  });

  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: grant.ledgerEntryId,
    alreadyProcessed: grant.alreadyProcessed,
  });
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStoreTarget(input: unknown): asserts input is VerifyPurchaseRequest['target'] {
  if (input !== 'android' && input !== 'ios' && input !== 'ait') {
    throw new Error('target must be android, ios, or ait.');
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

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

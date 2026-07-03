import typia from 'typia';

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
  readonly reason?: string;
}

export interface VerifyPurchaseContext {
  readonly catalog: ProductCatalog;
  readonly ledger: EntitlementLedger;
  readonly now?: () => string;
}

export const assertVerifyPurchaseRequest = typia.createAssert<VerifyPurchaseRequest>();
export const assertVerifyPurchaseResponse = typia.createAssert<VerifyPurchaseResponse>();

export function verifyPurchase(
  input: VerifyPurchaseRequest,
  context: VerifyPurchaseContext,
): VerifyPurchaseResponse {
  const request = assertVerifyPurchaseRequest(input);
  const product = context.catalog.products.find((entry) => entry.id === request.productId);

  if (product === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  }

  const platformProductId = product.platformProductIds[request.target];

  if (platformProductId === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
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
  });
}

import type { LogicalProductId } from '@mpgd/monetization-contract';
import typia from 'typia';

export interface VerifyPurchaseRequest {
  readonly target: 'android' | 'ios' | 'ait';
  readonly playerId: string;
  readonly productId: LogicalProductId;
  readonly platformTransactionId: string;
  readonly idempotencyKey: string;
  readonly purchasedAt: string;
}

export interface VerifyPurchaseResponse {
  readonly verified: boolean;
  readonly ledgerEntryId?: string;
  readonly reason?: string;
}

export const assertVerifyPurchaseRequest = typia.createAssert<VerifyPurchaseRequest>();
export const assertVerifyPurchaseResponse = typia.createAssert<VerifyPurchaseResponse>();

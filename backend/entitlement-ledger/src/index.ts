import typia from 'typia';

export interface EntitlementLedgerGrant {
  readonly playerId: string;
  readonly grantId: string;
  readonly source: 'purchase' | 'ad_reward' | 'admin';
  readonly idempotencyKey: string;
  readonly grantedAt: string;
  readonly payload: Record<string, string | number | boolean>;
}

export interface EntitlementLedgerResult {
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
}

export const assertEntitlementLedgerGrant = typia.createAssert<EntitlementLedgerGrant>();
export const assertEntitlementLedgerResult = typia.createAssert<EntitlementLedgerResult>();

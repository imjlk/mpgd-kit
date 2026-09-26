/** Shared response shapes with no schema, DOM or transport dependencies. */
export interface VerifyPurchaseResponse {
  readonly verified: boolean;
  /** Explicit non-grant decision; older servers may omit this field. */
  readonly disposition?: 'pending' | 'rejected';
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
  readonly finalization?: PurchaseGrantFinalization;
}

export type PurchaseGrantFinalizationAction =
  | 'acknowledge'
  | 'consume'
  | 'finish'
  | 'complete';

export interface PurchaseGrantFinalization {
  readonly status: 'completed' | 'pending';
  readonly action?: PurchaseGrantFinalizationAction;
  readonly alreadyCompleted: boolean;
  readonly reason?: string;
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  /** Explicit non-grant decision; older servers may omit this field. */
  readonly disposition?: 'pending' | 'rejected';
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
}

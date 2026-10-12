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

/** Whether a ledger grant is still active, or which entry reversed it (RFC "Revocation and expiry entries"). */
export interface PurchaseLedgerStatus {
  readonly ledgerEntryId: string;
  readonly status: 'active' | 'reversed' | 'unknown';
  readonly reversedBy?: string;
}

export interface PurchaseLedgerStatusRequest {
  readonly ledgerEntryIds: readonly string[];
}

export interface PurchaseLedgerStatusResponse {
  readonly statuses: readonly PurchaseLedgerStatus[];
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  /** Explicit non-grant decision; older servers may omit this field. */
  readonly disposition?: 'pending' | 'rejected';
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
  readonly reason?: string;
}

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import type {
  ClaimAdRewardRequest,
  EntitlementLedgerPayload,
  PurchaseGrantFinalization,
  VerifyPurchaseRequest,
} from './types';

export type EvidenceVerificationDecision =
  | {
      readonly status: 'verified';
      readonly verificationId: string;
      readonly verifiedAt: string;
      readonly payload?: EntitlementLedgerPayload;
      /**
       * An authoritative provider identity for cross-idempotency replay checks.
       * `null` explicitly suppresses the client-reported platform identity.
       */
      readonly platformEvidenceId?: string | null;
    }
  | {
      readonly status: 'pending';
      readonly reason?: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
    };

export interface VerifyPurchaseEvidenceInput {
  readonly request: VerifyPurchaseRequest;
  readonly product: ProductCatalog['products'][number];
  readonly platformProductId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface VerifyAdRewardEvidenceInput {
  readonly request: ClaimAdRewardRequest;
  readonly placement: AdPlacements['placements'][number];
  readonly platformPlacementId?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface FinalizePurchaseGrantInput {
  readonly request: VerifyPurchaseRequest;
  readonly product: ProductCatalog['products'][number];
  readonly platformProductId: string;
  readonly evidenceVerificationId: string;
  readonly evidencePayload?: EntitlementLedgerPayload;
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface GameServicesPurchaseGrantFinalizer {
  supportsPurchaseGrant?(
    input: Omit<FinalizePurchaseGrantInput, 'signal'>,
  ): boolean;
  finalizePurchaseGrant(
    input: FinalizePurchaseGrantInput,
  ): Promise<PurchaseGrantFinalization>;
}

export interface GameServicesEvidenceVerifier {
  verifyPurchase(
    input: VerifyPurchaseEvidenceInput,
  ): Promise<EvidenceVerificationDecision>;
  verifyAdReward(
    input: VerifyAdRewardEvidenceInput,
  ): Promise<EvidenceVerificationDecision>;
}

export function createDevelopmentGameServicesEvidenceVerifier(
  now: () => string = () => new Date().toISOString(),
): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase({ request }) {
      return {
        status: 'verified',
        verificationId: `development:purchase:${request.target}:${request.platformTransactionId}`,
        verifiedAt: now(),
      };
    },
    async verifyAdReward({ request }) {
      return {
        status: 'verified',
        verificationId: `development:ad-reward:${request.target}:${request.platformImpressionId ?? request.idempotencyKey}`,
        verifiedAt: now(),
      };
    },
  };
}

export function createRejectingGameServicesEvidenceVerifier(): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase() {
      return {
        status: 'rejected',
        reason: 'EVIDENCE_VERIFIER_UNAVAILABLE',
      };
    },
    async verifyAdReward() {
      return {
        status: 'rejected',
        reason: 'EVIDENCE_VERIFIER_UNAVAILABLE',
      };
    },
  };
}

import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import type {
  ClaimAdRewardRequest,
  EntitlementLedgerPayload,
  PurchaseGrantFinalization,
  VerifyPurchaseRequest,
} from './types.js';

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
      /**
       * An earlier ledger entry already grants this purchase: a server-push
       * store's lookup verifier (RFC "Evidence registry") found the grant the
       * host's fulfillment path wrote. The backend answers `verified` with
       * that entry (`alreadyProcessed: true`) after checking it belongs to the
       * requesting player, product, and target, and writes nothing new. Only
       * purchase verification understands it; a rewarded-ad verifier that
       * answers it is treated as a verifier error.
       */
      readonly status: 'settled';
      readonly ledgerEntryId: string;
      /** The ledger target the entry was written under when it is not the request's target. */
      readonly ledgerTarget?: string;
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

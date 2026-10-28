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
      /**
       * The store verified a restored non-consumable, but its account
       * binding (Google Play `obfuscatedAccountId` / `obfuscatedProfileId`,
       * StoreKit `appAccountToken`) names another account than the
       * requesting player's, or none: the player reinstalled or moved to a
       * new device and is a new guest (RFC "Restore sharing"). Every other
       * check passed. The reference verifiers answer it only for a request
       * with `intent: 'restore'` of a non-consumable; the backend then grants
       * the player its own share under its `restoreSharing` policy, or
       * answers `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` with `reason` (the
       * binding mismatch) when the policy refuses, as for a `rejected`
       * decision with `anotherAccount`. Fields are those of `verified`.
       */
      readonly status: 'restorable';
      readonly reason: string;
      readonly verificationId: string;
      readonly verifiedAt: string;
      readonly payload?: EntitlementLedgerPayload;
      readonly platformEvidenceId?: string | null;
    }
  | {
      readonly status: 'pending';
      readonly reason?: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      /**
       * The store binds the purchase to another account than the requesting
       * player's (`reason` is the binding mismatch, for example
       * `GOOGLE_PLAY_ACCOUNT_MISMATCH`), and every other check passed: the
       * purchase is valid, only not this player's (RFC "Another account's
       * purchase"). The backend grants nothing, records nothing, and answers
       * the retryable `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` error instead of a
       * `rejected` receipt, so the purchase stays recoverable by its account.
       * A caller that reads only `status` still refuses it.
       */
      readonly anotherAccount?: true;
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

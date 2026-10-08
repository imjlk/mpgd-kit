import type {
  EvidenceVerificationDecision,
  VerifyAdRewardEvidenceInput,
} from './evidence-verification.js';
import { assertGameServicesDeploymentTarget, type GameServicesAdRewardTarget } from './types.js';

export interface AdRewardVerifierBinding {
  readonly target: GameServicesAdRewardTarget;
  /** Omit only for the deployment whose key equals its platform target. */
  readonly deploymentTarget?: string;
}

export interface AdRewardVerifierDescriptor {
  readonly providerId: string;
  readonly schema: string;
  readonly bindings: readonly AdRewardVerifierBinding[];
}

export interface AdRewardVerifierRegistration extends AdRewardVerifierDescriptor {
  /** Explicit server proof lookup without a client envelope (for example signed SSV recovery). */
  readonly acceptsMissingEvidence?: boolean;
  /** Authenticate proof and all request bindings; registration itself proves no reward. */
  verify(input: VerifyAdRewardEvidenceInput): Promise<EvidenceVerificationDecision>;
}

export interface AdRewardEvidenceVerifierRegistry {
  verifyAdReward(input: VerifyAdRewardEvidenceInput): Promise<EvidenceVerificationDecision>;
}

/** A deployment-owned allow-list. Client decoder registration never reaches this registry. */
export function createAdRewardEvidenceVerifierRegistry(
  entries: readonly AdRewardVerifierRegistration[],
): AdRewardEvidenceVerifierRegistry {
  const registered = new Map<string, Pick<AdRewardVerifierRegistration, 'providerId' | 'verify'>>();
  const providerSchemas = new Map<string, string>();
  for (const entry of entries) {
    assertIdentity(entry.providerId);
    assertIdentity(entry.schema);
    if (!Array.isArray(entry.bindings) || entry.bindings.length === 0 || typeof entry.verify !== 'function'
      || entry.acceptsMissingEvidence !== undefined && typeof entry.acceptsMissingEvidence !== 'boolean') {
      throw new TypeError('Invalid advertising verifier registration.');
    }
    const owner = providerSchemas.get(entry.schema);
    if (owner !== undefined && owner !== entry.providerId) {
      throw new TypeError('Advertising evidence schema belongs to another provider.');
    }
    providerSchemas.set(entry.schema, entry.providerId);
    for (const binding of entry.bindings) {
      if (!rewardTargets.has(binding.target)) {
        throw new TypeError('Invalid advertising verifier target.');
      }
      const deploymentTarget = binding.deploymentTarget ?? binding.target;
      assertGameServicesDeploymentTarget(deploymentTarget);
      const key = bindingKey(entry.schema, binding.target, deploymentTarget);
      if (registered.has(key)) {
        throw new TypeError('Duplicate advertising verifier binding.');
      }
      const verifier = Object.freeze({ providerId: entry.providerId, verify: entry.verify });
      registered.set(key, verifier);
      if (entry.acceptsMissingEvidence === true) {
        const missingKey = bindingKey(null, binding.target, deploymentTarget);
        if (registered.has(missingKey)) {
          throw new TypeError('Duplicate missing-evidence advertising verifier binding.');
        }
        registered.set(missingKey, verifier);
      }
    }
  }
  return Object.freeze({
    async verifyAdReward(input: VerifyAdRewardEvidenceInput): Promise<EvidenceVerificationDecision> {
      const request = input.request;
      const schema = request.evidence === undefined ? null : request.evidence?.schema;
      const selected = schema === undefined || schema === '' ? undefined : registered.get(bindingKey(
        schema, request.target, request.deploymentTarget ?? request.target,
      ));
      if (selected === undefined) {
        return { status: 'rejected', reason: 'AD_REWARD_VERIFIER_UNREGISTERED' };
      }
      const { providerId, verify } = selected;
      if (request.providerId !== undefined && request.providerId !== providerId) {
        return { status: 'rejected', reason: 'AD_REWARD_PROVIDER_MISMATCH' };
      }
      // Proof verification stays abortable and server-owned. Preserve its authoritative
      // identity so ledger replay checks remain stable across registry migration.
      const decision = await verify(input);
      if (decision?.status !== 'verified') {
        return decision;
      }
      const payload = decision.payload;
      if (payload !== undefined && (typeof payload !== 'object' || payload === null
        || Array.isArray(payload) || Object.values(payload).some((value) =>
          typeof value !== 'string' && typeof value !== 'boolean'
          && (typeof value !== 'number' || !Number.isFinite(value))))) {
        return { status: 'rejected', reason: 'EVIDENCE_VERIFIER_ERROR' };
      }
      return { ...decision, payload: { ...payload, adProviderId: providerId } };
    },
  });
}

const rewardTargets = new Set<GameServicesAdRewardTarget>([
  'browser',
  'microsoft-store',
  'android',
  'ios',
  'ait',
  'reddit',
  'verse8',
]);

function bindingKey(schema: string | null, target: string, deploymentTarget: string): string {
  return JSON.stringify([schema, target, deploymentTarget]);
}

function assertIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError('Invalid advertising verifier identity.');
  }
}

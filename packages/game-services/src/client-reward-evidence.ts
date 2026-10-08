import type { PlatformEvidenceEnvelope, RewardedAdResult } from '@mpgd/platform';

export interface ClientRewardClaimCandidate {
  readonly evidence?: PlatformEvidenceEnvelope;
  readonly platformImpressionId?: string;
}

export interface ClientRewardEvidenceNormalizer {
  readonly schema: string;
  /** Decode a claim candidate only. This cannot authorize a server grant. */
  normalize(reward: RewardedAdResult): { readonly platformImpressionId?: string } | undefined;
}

export interface ClientRewardEvidenceRegistry {
  resolve(reward: RewardedAdResult): ClientRewardClaimCandidate | undefined;
  recognizes(schema: string): boolean;
}

/** An immutable, explicitly registered client decoder set, independent of server verification. */
export function createClientRewardEvidenceRegistry(
  entries: readonly ClientRewardEvidenceNormalizer[],
): ClientRewardEvidenceRegistry {
  const normalizers = new Map<string, ClientRewardEvidenceNormalizer['normalize']>();
  for (const entry of entries) {
    if (typeof entry.schema !== 'string' || entry.schema.trim() === '' || entry.schema.length > 512
      || typeof entry.normalize !== 'function' || normalizers.has(entry.schema)) {
      throw new TypeError('Invalid or duplicate client reward evidence registration.');
    }
    normalizers.set(entry.schema, entry.normalize);
  }
  return Object.freeze({
    recognizes: (schema: string) => normalizers.has(schema),
    resolve(reward: RewardedAdResult): ClientRewardClaimCandidate | undefined {
      if ((reward.status !== 'completed' && reward.status !== 'pending')
        || typeof reward.rewardGranted !== 'boolean'
        || (reward.ledgerEntryId !== undefined && (typeof reward.ledgerEntryId !== 'string' || reward.ledgerEntryId.trim() === '' || reward.ledgerEntryId.length > 512))) {
        return undefined;
      }
      const evidence = cloneEvidence(reward.evidence);
      if (evidence === undefined) {
        return undefined;
      }
      const normalize = normalizers.get(evidence.schema);
      if (normalize === undefined) {
        return undefined;
      }
      try {
        const normalized = normalize(Object.freeze({
          status: reward.status, rewardGranted: reward.rewardGranted, evidence,
          ...(reward.ledgerEntryId === undefined ? {} : { ledgerEntryId: reward.ledgerEntryId }),
        }));
        if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
          return undefined;
        }
        const impressionId = normalized.platformImpressionId;
        if (impressionId !== undefined && (typeof impressionId !== 'string' || impressionId.trim() === '' || impressionId.length > 512)) {
          return undefined;
        }
        return Object.freeze({
          evidence,
          ...(impressionId === undefined ? {} : { platformImpressionId: impressionId }),
        });
      } catch {
        // Decoder failures cannot turn untrusted evidence into a claim or leak its contents.
        return undefined;
      }
    },
  });
}

/** Preserve the old SDK-flag claim path only for consumers without a versioned/registered provider. */
export function resolveClientRewardClaim(
  reward: RewardedAdResult,
  registry: ClientRewardEvidenceRegistry,
  options: { readonly allowLegacyCompletion: boolean },
): ClientRewardClaimCandidate | undefined {
  const candidate = registry.resolve(reward);
  if (candidate !== undefined) {
    return candidate;
  }
  if (!options.allowLegacyCompletion || reward.status !== 'completed' || reward.rewardGranted !== true
  ) {
    return undefined;
  }
  const evidence = reward.evidence === undefined ? undefined : cloneEvidence(reward.evidence);
  if ((reward.evidence !== undefined && evidence === undefined)
    || (evidence !== undefined && registry.recognizes(evidence.schema))
    || (reward.ledgerEntryId !== undefined && (typeof reward.ledgerEntryId !== 'string'
      || reward.ledgerEntryId.trim() === '' || reward.ledgerEntryId.length > 512))) {
    return undefined;
  }
  return Object.freeze({
    ...(evidence === undefined ? {} : { evidence }),
    ...(reward.ledgerEntryId === undefined ? {} : { platformImpressionId: reward.ledgerEntryId }),
  });
}

function cloneEvidence(value: unknown): PlatformEvidenceEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  const payload = envelope.payload;
  if (typeof envelope.schema !== 'string' || envelope.schema.trim() === '' || envelope.schema.length > 512
    || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const entries = Object.entries(payload);
  if (entries.length > 64 || entries.some(([key, field]) => key.length > 128
    || (typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean')
    || (typeof field === 'string' && field.length > 8192)
    || (typeof field === 'number' && !Number.isFinite(field)))) {
    return undefined;
  }
  return Object.freeze({
    schema: envelope.schema,
    payload: Object.freeze(Object.fromEntries(entries) as Record<string, string | number | boolean>),
  });
}

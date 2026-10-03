import type { RewardedAdResult } from '@mpgd/platform';

/** This schema records SDK callback evidence, never an authoritative grant. */
export const admobClientRewardEvidenceSchema = 'mpgd.admob.client-reward.v1';

export function isAdMobClientRewardEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const reward = value as Record<string, unknown>;
  const evidence = reward.evidence;
  if ((reward.status !== 'completed' && reward.status !== 'pending')
    || reward.rewardGranted !== false
    || reward.ledgerEntryId !== undefined
    || typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return false;
  }
  const envelope = evidence as Record<string, unknown>;
  const payload = envelope.payload;
  return envelope.schema === admobClientRewardEvidenceSchema
    && typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    && typeof (payload as Record<string, unknown>).adUnitId === 'string'
    && ((payload as Record<string, unknown>).adUnitId as string).length > 0;
}

/**
 * Verse8 Ads SDK callback evidence. Mirrors `verse8AdsRewardEvidenceSchema`
 * from `@mpgd/adapter-verse8`; the adapter owns the schema and the backend
 * verifier consumes it, so the value must stay byte-identical on both sides.
 */
export const verse8ClientRewardEvidenceSchema = 'verse8.ads.reward.v1';

/**
 * Evidence schemas that a client adapter may return with
 * `status: 'completed' | 'pending'`, `rewardGranted: false`, and no
 * `ledgerEntryId`. They are claim candidates only: the backend ledger decides
 * whether a reward is granted.
 */
export const clientRewardEvidenceSchemas = Object.freeze([
  admobClientRewardEvidenceSchema,
  verse8ClientRewardEvidenceSchema,
] as const);

export type ClientRewardEvidenceSchema = (typeof clientRewardEvidenceSchemas)[number];

/** True when a rewarded-ad result carries ungranted evidence from an allow-listed schema. */
export function isClientRewardEvidence(value: unknown): boolean {
  return isAdMobClientRewardEvidence(value) || isVerse8ClientRewardEvidence(value);
}

export function isVerse8ClientRewardEvidence(value: unknown): boolean {
  const payload = readUngrantedEvidencePayload(value, verse8ClientRewardEvidenceSchema);
  return payload !== undefined
    && isNonEmptyString(payload.requestId)
    && isNonEmptyString(payload.placementId);
}

/**
 * Resolve the platform impression identifier to forward with a backend claim.
 * Authoritative adapters return `ledgerEntryId`; client-evidence adapters
 * expose the impression identifier inside the evidence payload instead.
 */
export function resolveRewardPlatformImpressionId(
  reward: RewardedAdResult,
): string | undefined {
  if (reward.ledgerEntryId !== undefined) {
    return reward.ledgerEntryId;
  }
  if (isVerse8ClientRewardEvidence(reward)) {
    return reward.evidence?.payload.requestId as string;
  }
  return undefined;
}

function readUngrantedEvidencePayload(
  value: unknown,
  schema: ClientRewardEvidenceSchema,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const reward = value as Record<string, unknown>;
  const evidence = reward.evidence;
  if ((reward.status !== 'completed' && reward.status !== 'pending')
    || reward.rewardGranted !== false
    || reward.ledgerEntryId !== undefined
    || typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return undefined;
  }
  const envelope = evidence as Record<string, unknown>;
  const payload = envelope.payload;
  if (envelope.schema !== schema
    || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

import {
  admobClientRewardEvidenceSchema,
  isAdMobClientRewardEvidence,
  isVerse8ClientRewardEvidence,
  verse8ClientRewardEvidenceSchema,
} from './admob-client-reward.js';
import {
  createClientRewardEvidenceRegistry,
  type ClientRewardEvidenceNormalizer,
  type ClientRewardEvidenceRegistry,
} from './client-reward-evidence.js';
import { onePlayClientRewardEvidenceNormalizer } from './oneplay-client-reward.js';

/** Registered decoder data. Common claim and recovery code never inspects these provider payloads. */
export const defaultClientRewardEvidenceNormalizers: readonly ClientRewardEvidenceNormalizer[] = Object.freeze([
  onePlayClientRewardEvidenceNormalizer,
  Object.freeze({
    schema: admobClientRewardEvidenceSchema,
    normalize: (reward) => isAdMobClientRewardEvidence(reward) ? {} : undefined,
  } satisfies ClientRewardEvidenceNormalizer),
  Object.freeze({
    schema: verse8ClientRewardEvidenceSchema,
    normalize: (reward) => {
      if (!isVerse8ClientRewardEvidence(reward)) {
        return undefined;
      }
      const requestId = reward.evidence?.payload.requestId;
      return typeof requestId === 'string' ? { platformImpressionId: requestId } : undefined;
    },
  } satisfies ClientRewardEvidenceNormalizer),
  Object.freeze({
    schema: 'apps-in-toss.rewarded-ad.callback.v1',
    normalize: (reward) => {
      const payload = reward.evidence?.payload;
      const correlationId = payload?.correlationId;
      if (payload?.event !== 'user-earned-reward' || typeof correlationId !== 'string' || correlationId.trim() === ''
        || typeof payload.placementId !== 'string' || payload.placementId.trim() === ''
        || (reward.ledgerEntryId !== undefined && reward.ledgerEntryId !== correlationId)) {
        return undefined;
      }
      return { platformImpressionId: correlationId };
    },
  } satisfies ClientRewardEvidenceNormalizer),
]);

export function createDefaultClientRewardEvidenceRegistry(
  additional: readonly ClientRewardEvidenceNormalizer[] = [],
): ClientRewardEvidenceRegistry {
  return createClientRewardEvidenceRegistry([
    ...defaultClientRewardEvidenceNormalizers,
    ...additional,
  ]);
}

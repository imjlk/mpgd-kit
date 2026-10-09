import type { RewardedAdResult } from '@mpgd/platform';

import type { ClientRewardEvidenceNormalizer } from './client-reward-evidence.js';

export const onePlayClientRewardEvidenceSchema = 'oneplay.rewarded-ad.callback.v1';
/** Correlation only: a matching SDK envelope can request verification, never authorize a grant. */
export const onePlayClientRewardEvidenceNormalizer: ClientRewardEvidenceNormalizer = Object.freeze({
  schema: onePlayClientRewardEvidenceSchema,
  normalize(reward: RewardedAdResult) {
    const payload = reward.evidence?.payload;
    if (reward.rewardGranted !== false || reward.ledgerEntryId !== undefined || payload?.rewardGranted !== false
      || payload.event !== 'rewarded' && payload.event !== 'outcome-unknown'
      || !identifier(payload.requestId) || !identifier(payload.placementId) || !identifier(payload.platformPlacementId)) {
      return undefined;
    }
    return { platformImpressionId: payload.requestId };
  },
});
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
}

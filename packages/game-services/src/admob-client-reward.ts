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

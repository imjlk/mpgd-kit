ALTER TABLE entitlement_transactions
  ADD COLUMN evidence_verification_id TEXT;

UPDATE entitlement_transactions
SET evidence_verification_id = json_extract(payload_json, '$.evidenceVerificationId')
WHERE evidence_verification_id IS NULL
  AND json_type(payload_json, '$.evidenceVerificationId') = 'text'
  AND length(json_extract(payload_json, '$.evidenceVerificationId')) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_evidence_verification
  ON entitlement_transactions (source, evidence_verification_id)
  WHERE evidence_verification_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_purchase_platform_evidence
  ON entitlement_transactions (
    source,
    json_extract(payload_json, '$.target'),
    json_extract(payload_json, '$.platformTransactionId')
  )
  WHERE source = 'purchase'
    AND json_type(payload_json, '$.target') = 'text'
    AND json_type(payload_json, '$.platformTransactionId') = 'text';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_reward_platform_evidence
  ON entitlement_transactions (
    source,
    json_extract(payload_json, '$.target'),
    json_extract(payload_json, '$.platformImpressionId')
  )
  WHERE source = 'ad_reward'
    AND json_type(payload_json, '$.target') = 'text'
    AND json_type(payload_json, '$.platformImpressionId') = 'text';

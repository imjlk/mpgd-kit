ALTER TABLE entitlement_transactions
  ADD COLUMN evidence_verification_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_evidence_verification
  ON entitlement_transactions (source, evidence_verification_id)
  WHERE evidence_verification_id IS NOT NULL;

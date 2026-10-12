CREATE TABLE IF NOT EXISTS entitlement_revocations (
  ledger_entry_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  revokes_ledger_entry_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('refund', 'chargeback', 'voided', 'admin')),
  revoked_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_verification_id TEXT,
  UNIQUE (player_id, idempotency_key),
  UNIQUE (revokes_ledger_entry_id),
  FOREIGN KEY (revokes_ledger_entry_id)
    REFERENCES entitlement_transactions (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_revocation_evidence
  ON entitlement_revocations (evidence_verification_id)
  WHERE evidence_verification_id IS NOT NULL;

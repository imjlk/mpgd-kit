-- Restore transfers (L3c, docs/specs/commerce/commerce-v2-rfc.md#restore-transfers):
-- the `revoke` entries with reason `transfer` that move a purchase grant to
-- another player on a verified restore (a reinstall or a new device). Kept
-- apart from entitlement_revocations, whose reason CHECK predates them; the
-- store reads both as one revoke list, and each table's writes refuse a
-- grant the other already reversed, so a grant is reversed once.
-- Additive: no existing table changes.
CREATE TABLE IF NOT EXISTS entitlement_transfers (
  ledger_entry_id TEXT PRIMARY KEY,
  -- The player the grant moved from.
  player_id TEXT NOT NULL,
  revokes_ledger_entry_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- The receiving player's grant, written in the same batch.
  to_ledger_entry_id TEXT NOT NULL,
  UNIQUE (player_id, idempotency_key),
  UNIQUE (revokes_ledger_entry_id),
  UNIQUE (to_ledger_entry_id),
  -- Audit records, like the revoke entries (0006): deleting either grant is
  -- refused until the transfer row is handled first.
  FOREIGN KEY (revokes_ledger_entry_id)
    REFERENCES entitlement_transactions (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (to_ledger_entry_id)
    REFERENCES entitlement_transactions (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_entitlement_transfers_player
  ON entitlement_transfers (player_id);

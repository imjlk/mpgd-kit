-- Store server upkeep (L2): Play grants whose acknowledge or consume has not
-- completed yet, kept with the raw purchase token the ledger never stores so
-- the cron can retry within Play's three-day window, the cursors of the
-- scheduled store sweeps, and ledger notes (store events that grant nothing,
-- such as an App Store REFUND_REVERSED). Additive: no existing table changes.
CREATE TABLE IF NOT EXISTS google_play_pending_finalizations (
  ledger_entry_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  purchase_token TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  FOREIGN KEY (ledger_entry_id)
    REFERENCES entitlement_transactions (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_google_play_pending_finalizations_due
  ON google_play_pending_finalizations (next_attempt_at_ms);
-- For a player's data deletion: the rows hold raw purchase tokens.
CREATE INDEX IF NOT EXISTS idx_google_play_pending_finalizations_player
  ON google_play_pending_finalizations (player_id);

CREATE TABLE IF NOT EXISTS store_server_cursors (
  name TEXT PRIMARY KEY,
  value_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlement_notes (
  note_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refund_reversed')),
  player_id TEXT NOT NULL,
  ledger_entry_id TEXT NOT NULL,
  revocation_ledger_entry_id TEXT,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- An audit record support re-grants from: like the revoke entries (0006),
  -- deleting the grant or revoke row it names is refused until its notes are
  -- deleted first.
  FOREIGN KEY (ledger_entry_id)
    REFERENCES entitlement_transactions (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (revocation_ledger_entry_id)
    REFERENCES entitlement_revocations (ledger_entry_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_entitlement_notes_grant
  ON entitlement_notes (ledger_entry_id);
CREATE INDEX IF NOT EXISTS idx_entitlement_notes_player
  ON entitlement_notes (player_id);

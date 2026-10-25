-- Store server upkeep (L2): Play grants whose acknowledge or consume has not
-- completed yet, kept with the raw purchase token the ledger never stores so
-- the cron can retry within Play's three-day window, and the cursors of the
-- scheduled store sweeps. Additive: no existing table changes.
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
CREATE INDEX IF NOT EXISTS idx_google_play_pending_finalizations_player
  ON google_play_pending_finalizations (player_id);

CREATE TABLE IF NOT EXISTS store_server_cursors (
  name TEXT PRIMARY KEY,
  value_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

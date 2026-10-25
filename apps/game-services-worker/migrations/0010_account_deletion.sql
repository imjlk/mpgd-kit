-- Account deletion (L3b, docs/GAME_SERVICES_BACKEND.md#account-deletion).
-- Additive: two new tables and the player indexes the erasure reads by.

-- One row per deletion, with no player id or other personal data.
CREATE TABLE IF NOT EXISTS account_deletion_audit (
  deletion_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('deleted', 'not-configured')),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  deleted_rows INTEGER NOT NULL,
  retained_rows INTEGER NOT NULL
);

-- An erasure kept across the identity deletion; it holds the player id, so a
-- row lives only until the erasure completes (or, while `erasing`, an hour).
CREATE TABLE IF NOT EXISTS account_deletion_pending (
  deletion_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  retained_player_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('erasing', 'identity-deleted')),
  recorded_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT
);

-- The erasure finds a player's rows by these; the other player-keyed tables
-- already lead an index or key with the player id.
CREATE INDEX IF NOT EXISTS idx_entitlement_transactions_player
  ON entitlement_transactions (player_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_transactions_player
  ON leaderboard_transactions (player_id);
CREATE INDEX IF NOT EXISTS idx_admob_ssv_callbacks_player
  ON admob_ssv_callbacks (player_id);
CREATE INDEX IF NOT EXISTS idx_verified_leaderboard_attempts_participant
  ON verified_leaderboard_attempts (participant_id);
CREATE INDEX IF NOT EXISTS idx_verified_leaderboard_entries_participant
  ON verified_leaderboard_entries (participant_id);
CREATE INDEX IF NOT EXISTS idx_notification_sends_player
  ON notification_sends (player_id);

CREATE TABLE IF NOT EXISTS entitlement_transactions (
  ledger_entry_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  grant_json TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (source, player_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS leaderboard_transactions (
  ledger_entry_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  leaderboard_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score REAL NOT NULL,
  run_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  platform_submission_id TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (target, leaderboard_id, player_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_rank
  ON leaderboard_transactions (leaderboard_id, score DESC, submitted_at ASC);

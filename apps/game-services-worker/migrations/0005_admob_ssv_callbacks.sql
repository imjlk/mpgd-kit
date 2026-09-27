CREATE TABLE IF NOT EXISTS admob_ssv_callbacks (
  transaction_id TEXT PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('android', 'ios')),
  player_id TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  accepted_ad_unit TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (target, player_id, placement_id, idempotency_key)
);

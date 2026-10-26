-- Account deletion (L3b): the confirmations the game-services deletion route
-- requires besides an access token. Issued to the holder of a live family's
-- refresh token, single use, short-lived, one per family, stored only as a
-- SHA-256 hash. Keyed by player_id like every other table, so deleting a
-- player removes them too.
CREATE TABLE IF NOT EXISTS identity_deletion_confirmations (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_deletion_confirmations_player
  ON identity_deletion_confirmations (player_id);
CREATE INDEX IF NOT EXISTS idx_identity_deletion_confirmations_expires
  ON identity_deletion_confirmations (expires_at_ms);

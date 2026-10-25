-- Reference guest identity service (L3a). Every table carries player_id, so a
-- player is deleted with one key across all of them. Tokens are stored only as
-- SHA-256 hashes; times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS identity_players (
  player_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL
);

-- One row per session family: stable across refreshes, ended by logout, a
-- refresh token replay, or inactivity (expires_at_ms slides on each refresh).
CREATE TABLE IF NOT EXISTS identity_session_families (
  family_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  revoke_reason TEXT,
  current_refresh_hash TEXT NOT NULL,
  previous_refresh_hash TEXT,
  rotated_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_identity_session_families_player
  ON identity_session_families (player_id);
CREATE INDEX IF NOT EXISTS idx_identity_session_families_installation
  ON identity_session_families (installation_id, created_at_ms);
-- The purge's two scans: revoked families, and live ones past their window.
-- Partial: only revoked families, so the revoked scan skips every live one.
CREATE INDEX IF NOT EXISTS idx_identity_session_families_revoked
  ON identity_session_families (revoked_at_ms) WHERE revoked_at_ms IS NOT NULL;
-- Partial: only live families, so the inactivity scan reads no revoked row.
CREATE INDEX IF NOT EXISTS idx_identity_session_families_live_expires
  ON identity_session_families (expires_at_ms) WHERE revoked_at_ms IS NULL;

-- Every refresh token a family was ever issued, so a replayed old one is
-- recognized (and revokes its family) instead of being merely unknown.
CREATE TABLE IF NOT EXISTS identity_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_refresh_tokens_family
  ON identity_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_identity_refresh_tokens_issued
  ON identity_refresh_tokens (issued_at_ms);
CREATE INDEX IF NOT EXISTS idx_identity_refresh_tokens_player
  ON identity_refresh_tokens (player_id);

CREATE TABLE IF NOT EXISTS identity_access_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_access_tokens_family
  ON identity_access_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_identity_access_tokens_expires
  ON identity_access_tokens (expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_identity_access_tokens_player
  ON identity_access_tokens (player_id);

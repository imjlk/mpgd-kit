-- Account deletion (L3b, docs/GAME_SERVICES_BACKEND.md#account-deletion).
-- Additive: new tables, a retention column on the ledger tables (with the
-- triggers that set it), and the indexes the erasure reads by.

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

-- The erasure finds a player's rows by these player indexes; the other
-- player-keyed tables already lead an index or key with the player id.
-- Also the retention purge's range over deleted:<id> players by grant date.
CREATE INDEX IF NOT EXISTS idx_entitlement_transactions_player
  ON entitlement_transactions (player_id, granted_at);
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
-- Notes are found (and their RESTRICT key checked) by the revocation they name.
CREATE INDEX IF NOT EXISTS idx_entitlement_notes_revocation
  ON entitlement_notes (revocation_ledger_entry_id);

-- Deletion tombstones: an HMAC-SHA-256 of a deleted player's id under the
-- deployment key (GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY), never the id.
-- Player-keyed writes check it and refuse; the cron purges it when it expires.
CREATE TABLE IF NOT EXISTS account_deletion_tombstones (
  player_key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_deletion_tombstones_expires
  ON account_deletion_tombstones (expires_at);

-- When a ledger row kept for a deleted player (player id deleted:<id>) may be
-- purged: five years (retainedPurchaseRecordYears; a fork that changes it
-- changes these triggers too) from its own time. A kept grant carries its
-- group's latest expiry: a revocation or note about it, written with the
-- erasure or later (a refund the store reports after the deletion), extends
-- it. The purge removes a group once the grant's expiry passed.
ALTER TABLE entitlement_transactions ADD COLUMN retained_until TEXT;
ALTER TABLE entitlement_revocations ADD COLUMN retained_until TEXT;
ALTER TABLE entitlement_notes ADD COLUMN retained_until TEXT;
CREATE INDEX IF NOT EXISTS idx_entitlement_notes_retained
  ON entitlement_notes (retained_until) WHERE retained_until IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS retained_grant_until
AFTER INSERT ON entitlement_transactions
WHEN NEW.retained_until IS NULL AND NEW.player_id >= 'deleted:' AND NEW.player_id < 'deleted;'
BEGIN
  UPDATE entitlement_transactions
    SET retained_until = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.granted_at, '+5 years')
    WHERE ledger_entry_id = NEW.ledger_entry_id;
END;

CREATE TRIGGER IF NOT EXISTS retained_revocation_until
AFTER INSERT ON entitlement_revocations
WHEN NEW.retained_until IS NULL AND (NEW.player_id >= 'deleted:' AND NEW.player_id < 'deleted;'
  OR EXISTS (SELECT 1 FROM entitlement_transactions g
    WHERE g.ledger_entry_id = NEW.revokes_ledger_entry_id AND g.player_id >= 'deleted:' AND g.player_id < 'deleted;'))
BEGIN
  UPDATE entitlement_revocations
    SET retained_until = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at, '+5 years')
    WHERE ledger_entry_id = NEW.ledger_entry_id;
  UPDATE entitlement_transactions
    SET retained_until = max(COALESCE(retained_until, ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at, '+5 years'))
    WHERE ledger_entry_id = NEW.revokes_ledger_entry_id AND player_id >= 'deleted:' AND player_id < 'deleted;';
END;

CREATE TRIGGER IF NOT EXISTS retained_note_until
AFTER INSERT ON entitlement_notes
WHEN NEW.retained_until IS NULL AND (NEW.player_id >= 'deleted:' AND NEW.player_id < 'deleted;'
  OR EXISTS (SELECT 1 FROM entitlement_transactions g
    WHERE g.ledger_entry_id = NEW.ledger_entry_id AND g.player_id >= 'deleted:' AND g.player_id < 'deleted;'))
BEGIN
  UPDATE entitlement_notes
    SET retained_until = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.recorded_at, '+5 years')
    WHERE note_id = NEW.note_id;
  UPDATE entitlement_transactions
    SET retained_until = max(COALESCE(retained_until, ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.recorded_at, '+5 years'))
    WHERE ledger_entry_id = NEW.ledger_entry_id AND player_id >= 'deleted:' AND player_id < 'deleted;';
END;

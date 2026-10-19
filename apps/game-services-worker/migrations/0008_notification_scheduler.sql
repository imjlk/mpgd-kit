-- Notifications v2 scheduler (docs/specs/notifications/notifications-v2-rfc.md,
-- "Reminder scheduler"): server reminders and each player's consent notice
-- check, the provider-wide history count the scheduler paces by, and the
-- consent compaction that deletes records by player and time.

-- One scheduler item per player and id (`reminder:<key>`, `notices`).
-- `version` changes on every write; writers compare-and-set on it.
CREATE TABLE IF NOT EXISTS notification_schedule (
  player_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  version TEXT NOT NULL,
  due_at_ms INTEGER,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (player_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_schedule_due
  ON notification_schedule (due_at_ms, player_id, entry_id)
  WHERE due_at_ms IS NOT NULL;

-- Pacing counts a provider's deliveries in its rate window.
CREATE INDEX IF NOT EXISTS idx_notification_delivery_history_provider
  ON notification_delivery_history (provider, at_ms);

-- Compaction deletes a player's records by time, and the notices given about them.
CREATE INDEX IF NOT EXISTS idx_notification_consent_records_at
  ON notification_consent_records (player_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_notification_notices_given_record
  ON notification_notices_given (player_id, record_at_ms);

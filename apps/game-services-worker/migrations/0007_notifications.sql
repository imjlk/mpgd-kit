-- Notifications v2 server (docs/specs/notifications/notifications-v2-rfc.md, "Server").
-- Times are stored twice: *_ms as epoch milliseconds for comparisons, and
-- the canonical RFC 3339 text inside the JSON a row carries.

-- Append-only consent history per player; `sequence` orders it and the
-- backend dates each record at least 1 ms after the player's previous one.
CREATE TABLE IF NOT EXISTS notification_consent_records (
  player_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delivery-permission', 'host-agreement', 'topic-preference', 'advertising', 'night')),
  topic TEXT,
  at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (player_id, sequence)
);

-- Device endpoints, keyed by provider and the registering session's installation.
CREATE TABLE IF NOT EXISTS notification_endpoints (
  provider TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  address_kind TEXT NOT NULL CHECK (address_kind IN ('fcm-token', 'fcm-installation')),
  address_value TEXT NOT NULL,
  environment TEXT CHECK (environment IS NULL OR environment IN ('production', 'sandbox')),
  permission TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  locale TEXT,
  time_zone TEXT,
  target TEXT,
  session_id TEXT NOT NULL,
  session_expires_at_ms INTEGER,
  last_registered_at_ms INTEGER NOT NULL,
  invalidated_at_ms INTEGER,
  endpoint_json TEXT NOT NULL,
  PRIMARY KEY (provider, installation_id),
  UNIQUE (provider, address_value)
);

CREATE INDEX IF NOT EXISTS idx_notification_endpoints_player
  ON notification_endpoints (player_id, provider);
CREATE INDEX IF NOT EXISTS idx_notification_endpoints_session
  ON notification_endpoints (session_id);

-- Platform-user registrations keep only the locale and zone.
CREATE TABLE IF NOT EXISTS notification_platform_registrations (
  player_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  registration_json TEXT NOT NULL,
  PRIMARY KEY (player_id, provider)
);

-- Notices given, named by kind, record kind and time, and dueBy.
CREATE TABLE IF NOT EXISTS notification_notices_given (
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('consent-result', 'reconfirmation')),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('advertising', 'night')),
  record_at_ms INTEGER NOT NULL,
  due_by TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in-game', 'push', 'other')),
  given_at_ms INTEGER NOT NULL,
  notice_json TEXT NOT NULL,
  PRIMARY KEY (player_id, kind, record_kind, record_at_ms, due_by)
);

-- The send ledger: one row per send key with its per-recipient rows as JSON.
-- `version` changes on every write; writers compare-and-set on it.
CREATE TABLE IF NOT EXISTS notification_sends (
  send_key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  player_id TEXT NOT NULL,
  -- 1 while any row is in flight: the gate counts such sends for limits.
  in_flight INTEGER NOT NULL CHECK (in_flight IN (0, 1)),
  due_at_ms INTEGER,
  changed_at_ms INTEGER NOT NULL,
  send_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_sends_due
  ON notification_sends (due_at_ms)
  WHERE due_at_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_sends_player_in_flight
  ON notification_sends (player_id)
  WHERE in_flight = 1;
CREATE INDEX IF NOT EXISTS idx_notification_sends_changed
  ON notification_sends (changed_at_ms);

-- Delivered sends the gate's frequency caps and provider limits count.
CREATE TABLE IF NOT EXISTS notification_delivery_history (
  send_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  player_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (send_key, provider)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_history_player
  ON notification_delivery_history (player_id, at_ms);

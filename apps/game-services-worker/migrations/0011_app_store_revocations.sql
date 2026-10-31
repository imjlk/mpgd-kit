-- App Store revocation registry: every REFUND and REVOKE of a one-time
-- purchase the App Store Server Notifications route verified, granted or not,
-- kept per environment and grant verification id (the id the purchase
-- verifier records: original transaction id of a non-consumable, transaction
-- id otherwise). A production deployment that grants sandbox purchases
-- records both environments, so the environment is part of the key. An
-- offline-only App Store purchase verifier reads it through the
-- GameServicesAppStoreRevocations entrypoint and refuses a JWS signed at or
-- before revoked_at (plus its clockSkewMs). Written only with
-- GAME_SERVICES_APP_STORE_REVOCATION_REGISTRY = "true". Additive: no existing
-- table changes.
CREATE TABLE IF NOT EXISTS app_store_revocations (
  environment TEXT NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
  verification_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('refund', 'voided')),
  -- Apple's signed time as recorded (revocationDate, else the notification's
  -- signedDate); revoked_at_ms is its instant, NULL when it does not parse.
  -- The latest instant per row wins; a NULL refuses every JWS and is kept.
  revoked_at TEXT NOT NULL,
  revoked_at_ms INTEGER,
  notification_type TEXT NOT NULL,
  notification_uuid TEXT NOT NULL,
  -- When this Worker last replaced the row (its own clock, for operators).
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (environment, verification_id)
);

-- No player id is kept. A row may be deleted once revoked_at_ms is older than
-- the verifier's maxSignedAgeMs plus clockSkewMs: every JWS it refuses is
-- then stale anyway (GAME_SERVICES_APP_STORE_REVOCATION_RETENTION_MS has the
-- cron do it).
CREATE INDEX IF NOT EXISTS idx_app_store_revocations_revoked_at
  ON app_store_revocations (revoked_at_ms);

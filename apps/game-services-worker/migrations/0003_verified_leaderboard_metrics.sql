ALTER TABLE verified_leaderboard_attempts
  ADD COLUMN metrics_json TEXT;

ALTER TABLE verified_leaderboard_attempts
  ADD COLUMN response_entry_metrics_json TEXT;

ALTER TABLE verified_leaderboard_entries
  ADD COLUMN metrics_json TEXT;

DROP TRIGGER IF EXISTS verified_leaderboard_attempt_conflict;

CREATE TRIGGER verified_leaderboard_attempt_conflict
BEFORE INSERT ON verified_leaderboard_attempts
/* Labels are presentation metadata; metrics are immutable attempt identity. */
WHEN EXISTS (
  SELECT 1
  FROM verified_leaderboard_attempts
  WHERE leaderboard_id = NEW.leaderboard_id
    AND attempt_id = NEW.attempt_id
    AND (
      participant_id <> NEW.participant_id
      OR score <> NEW.score
      OR metrics_json IS NOT NEW.metrics_json
      OR completed_at_ms <> NEW.completed_at_ms
      OR authority_id <> NEW.authority_id
      OR evidence_id <> NEW.evidence_id
      OR verified_at_ms <> NEW.verified_at_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verified leaderboard attempt id conflict');
END;

CREATE TRIGGER IF NOT EXISTS verified_leaderboard_attempt_metrics_immutable
BEFORE UPDATE OF metrics_json ON verified_leaderboard_attempts
WHEN OLD.metrics_json IS NOT NEW.metrics_json
BEGIN
  SELECT RAISE(ABORT, 'verified leaderboard attempt metrics are immutable');
END;

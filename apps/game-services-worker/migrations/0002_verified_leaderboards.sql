CREATE TABLE IF NOT EXISTS verified_leaderboard_definitions (
  leaderboard_id TEXT PRIMARY KEY,
  score_order TEXT NOT NULL CHECK (score_order IN ('ascending', 'descending')),
  attempt_selection TEXT NOT NULL CHECK (attempt_selection IN ('first', 'best'))
);

CREATE TABLE IF NOT EXISTS verified_leaderboard_attempts (
  leaderboard_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_label TEXT,
  score REAL NOT NULL,
  completed_at TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  authority_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  response_retained INTEGER,
  response_entry_rank INTEGER,
  response_entry_participant_id TEXT,
  response_entry_participant_label TEXT,
  response_entry_attempt_id TEXT,
  response_entry_score REAL,
  response_entry_completed_at TEXT,
  response_reason TEXT,
  PRIMARY KEY (leaderboard_id, attempt_id),
  FOREIGN KEY (leaderboard_id)
    REFERENCES verified_leaderboard_definitions (leaderboard_id)
);

CREATE TABLE IF NOT EXISTS verified_leaderboard_entries (
  leaderboard_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_label TEXT,
  attempt_id TEXT NOT NULL,
  score REAL NOT NULL,
  completed_at TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  attempt_ordinal TEXT NOT NULL,
  PRIMARY KEY (leaderboard_id, participant_id),
  UNIQUE (leaderboard_id, attempt_id),
  FOREIGN KEY (leaderboard_id)
    REFERENCES verified_leaderboard_definitions (leaderboard_id)
);

CREATE INDEX IF NOT EXISTS idx_verified_leaderboard_entries_rank
  ON verified_leaderboard_entries (
    leaderboard_id,
    score,
    completed_at_ms,
    attempt_ordinal
  );

CREATE TRIGGER IF NOT EXISTS verified_leaderboard_definition_conflict
BEFORE INSERT ON verified_leaderboard_definitions
WHEN EXISTS (
  SELECT 1
  FROM verified_leaderboard_definitions
  WHERE leaderboard_id = NEW.leaderboard_id
    AND (
      score_order <> NEW.score_order
      OR attempt_selection <> NEW.attempt_selection
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verified leaderboard definition conflict');
END;

CREATE TRIGGER IF NOT EXISTS verified_leaderboard_attempt_conflict
BEFORE INSERT ON verified_leaderboard_attempts
WHEN EXISTS (
  SELECT 1
  FROM verified_leaderboard_attempts
  WHERE leaderboard_id = NEW.leaderboard_id
    AND attempt_id = NEW.attempt_id
    AND (
      participant_id <> NEW.participant_id
      OR score <> NEW.score
      OR completed_at_ms <> NEW.completed_at_ms
      OR authority_id <> NEW.authority_id
      OR evidence_id <> NEW.evidence_id
      OR verified_at_ms <> NEW.verified_at_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verified leaderboard attempt id conflict');
END;

import {
  assertGetVerifiedLeaderboardSnapshotRequest,
  assertRecordVerifiedLeaderboardAttemptRequest,
  assertRecordVerifiedLeaderboardAttemptResponse,
  assertVerifiedLeaderboardSnapshot,
  createVerifiedLeaderboardCursor,
  normalizeVerifiedLeaderboardMetrics,
  parseVerifiedLeaderboardCursor,
  type GetVerifiedLeaderboardSnapshotRequest,
  type LeaderboardRankedEntry,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardDefinition,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshot,
} from '@mpgd/game-services';

type DefinitionRow = {
  leaderboard_id: string;
  score_order: VerifiedLeaderboardDefinition['scoreOrder'];
  attempt_selection: VerifiedLeaderboardDefinition['attemptSelection'];
};

type AttemptResponseRow = {
  response_retained: number;
  response_entry_rank: number;
  response_entry_participant_id: string;
  response_entry_participant_label: string | null;
  response_entry_attempt_id: string;
  response_entry_score: number;
  response_entry_metrics_json: string | null;
  response_entry_completed_at: string;
  response_reason: 'ATTEMPT_NOT_RETAINED' | null;
};

type RankedEntryRow = {
  rank: number;
  participant_id: string;
  participant_label: string | null;
  attempt_id: string;
  score: number;
  metrics_json: string | null;
  completed_at: string;
  completed_at_ms: number;
  attempt_ordinal: string;
};

export interface CreateD1VerifiedLeaderboardServiceInput {
  readonly now?: () => string;
}

export function createD1VerifiedLeaderboardService(
  db: D1Database,
  input: CreateD1VerifiedLeaderboardServiceInput = {},
): VerifiedLeaderboardService {
  return new D1VerifiedLeaderboardService(
    db,
    input.now ?? (() => new Date().toISOString()),
  );
}

class D1VerifiedLeaderboardService implements VerifiedLeaderboardService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => string,
  ) {}

  async recordVerifiedAttempt(
    input: RecordVerifiedLeaderboardAttemptRequest,
  ): Promise<RecordVerifiedLeaderboardAttemptResponse> {
    assertRecordVerifiedLeaderboardAttemptRequest(input);
    const { definition, attempt } = input;
    const completedAtMs = Date.parse(attempt.completedAt);
    const verifiedAtMs = Date.parse(attempt.verification.verifiedAt);
    const metricsJson = serializeMetrics(attempt.metrics);
    const session = this.db.withSession('first-primary');
    const statements = [
      session.prepare(
        `INSERT OR IGNORE INTO verified_leaderboard_definitions (
          leaderboard_id,
          score_order,
          attempt_selection
        ) VALUES (?, ?, ?)`,
      ).bind(
        definition.leaderboardId,
        definition.scoreOrder,
        definition.attemptSelection,
      ),
      session.prepare(
        `INSERT OR IGNORE INTO verified_leaderboard_attempts (
          leaderboard_id,
          attempt_id,
          participant_id,
          participant_label,
          score,
          metrics_json,
          completed_at,
          completed_at_ms,
          authority_id,
          evidence_id,
          verified_at,
          verified_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        definition.leaderboardId,
        attempt.attemptId,
        attempt.participantId,
        attempt.participantLabel ?? null,
        attempt.score,
        metricsJson,
        attempt.completedAt,
        completedAtMs,
        attempt.verification.authorityId,
        attempt.verification.evidenceId,
        attempt.verification.verifiedAt,
        verifiedAtMs,
      ),
      session.prepare(
        `INSERT INTO verified_leaderboard_entries (
          leaderboard_id,
          participant_id,
          participant_label,
          attempt_id,
          score,
          metrics_json,
          completed_at,
          completed_at_ms,
          attempt_ordinal
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM verified_leaderboard_attempts
          WHERE leaderboard_id = ?
            AND attempt_id = ?
            AND response_retained IS NULL
        )
        ON CONFLICT (leaderboard_id, participant_id) DO UPDATE SET
          participant_label = excluded.participant_label,
          attempt_id = excluded.attempt_id,
          score = excluded.score,
          metrics_json = excluded.metrics_json,
          completed_at = excluded.completed_at,
          completed_at_ms = excluded.completed_at_ms,
          attempt_ordinal = excluded.attempt_ordinal
        WHERE (
          (
            (SELECT attempt_selection
             FROM verified_leaderboard_definitions
             WHERE leaderboard_id = excluded.leaderboard_id) = 'first'
            AND (
              excluded.completed_at_ms < verified_leaderboard_entries.completed_at_ms
              OR (
                excluded.completed_at_ms = verified_leaderboard_entries.completed_at_ms
                AND excluded.attempt_ordinal < verified_leaderboard_entries.attempt_ordinal
              )
            )
          )
          OR (
            (SELECT attempt_selection
             FROM verified_leaderboard_definitions
             WHERE leaderboard_id = excluded.leaderboard_id) = 'best'
            AND (
              (
                (SELECT score_order
                 FROM verified_leaderboard_definitions
                 WHERE leaderboard_id = excluded.leaderboard_id) = 'ascending'
                AND excluded.score < verified_leaderboard_entries.score
              )
              OR (
                (SELECT score_order
                 FROM verified_leaderboard_definitions
                 WHERE leaderboard_id = excluded.leaderboard_id) = 'descending'
                AND excluded.score > verified_leaderboard_entries.score
              )
              OR (
                excluded.score = verified_leaderboard_entries.score
                AND (
                  excluded.completed_at_ms < verified_leaderboard_entries.completed_at_ms
                  OR (
                    excluded.completed_at_ms = verified_leaderboard_entries.completed_at_ms
                    AND excluded.attempt_ordinal < verified_leaderboard_entries.attempt_ordinal
                  )
                )
              )
            )
          )
        )`,
      ).bind(
        definition.leaderboardId,
        attempt.participantId,
        attempt.participantLabel ?? null,
        attempt.attemptId,
        attempt.score,
        metricsJson,
        attempt.completedAt,
        completedAtMs,
        toUtf16OrdinalKey(attempt.attemptId),
        definition.leaderboardId,
        attempt.attemptId,
      ),
      session.prepare(
        `UPDATE verified_leaderboard_attempts
        SET
          response_retained = CASE
            WHEN (
              SELECT attempt_id
              FROM verified_leaderboard_entries
              WHERE leaderboard_id = ? AND participant_id = ?
            ) = attempt_id THEN 1
            ELSE 0
          END,
          response_entry_participant_id = (
            SELECT participant_id
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_entry_participant_label = (
            SELECT participant_label
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_entry_attempt_id = (
            SELECT attempt_id
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_entry_score = (
            SELECT score
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_entry_metrics_json = (
            SELECT metrics_json
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_entry_completed_at = (
            SELECT completed_at
            FROM verified_leaderboard_entries
            WHERE leaderboard_id = ? AND participant_id = ?
          ),
          response_reason = CASE
            WHEN (
              SELECT attempt_id
              FROM verified_leaderboard_entries
              WHERE leaderboard_id = ? AND participant_id = ?
            ) = attempt_id THEN NULL
            ELSE 'ATTEMPT_NOT_RETAINED'
          END
        WHERE leaderboard_id = ?
          AND attempt_id = ?
          AND response_retained IS NULL`,
      ).bind(
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.participantId,
        definition.leaderboardId,
        attempt.attemptId,
      ),
      session.prepare(
        `UPDATE verified_leaderboard_attempts
        SET response_entry_rank = (
          SELECT COUNT(*) + 1
          FROM verified_leaderboard_entries AS candidate
          JOIN verified_leaderboard_definitions AS definition
            ON definition.leaderboard_id = candidate.leaderboard_id
          WHERE candidate.leaderboard_id = verified_leaderboard_attempts.leaderboard_id
            AND (
              (
                definition.score_order = 'ascending'
                AND candidate.score < response_entry_score
              )
              OR (
                definition.score_order = 'descending'
                AND candidate.score > response_entry_score
              )
              OR (
                candidate.score = response_entry_score
                AND (
                  candidate.completed_at_ms < (
                    SELECT completed_at_ms
                    FROM verified_leaderboard_entries
                    WHERE leaderboard_id = verified_leaderboard_attempts.leaderboard_id
                      AND attempt_id = response_entry_attempt_id
                  )
                  OR (
                    candidate.completed_at_ms = (
                      SELECT completed_at_ms
                      FROM verified_leaderboard_entries
                      WHERE leaderboard_id = verified_leaderboard_attempts.leaderboard_id
                        AND attempt_id = response_entry_attempt_id
                    )
                    AND candidate.attempt_ordinal < (
                      SELECT attempt_ordinal
                      FROM verified_leaderboard_entries
                      WHERE leaderboard_id = verified_leaderboard_attempts.leaderboard_id
                        AND attempt_id = response_entry_attempt_id
                    )
                  )
                )
              )
            )
        )
        WHERE leaderboard_id = ?
          AND attempt_id = ?
          AND response_entry_rank IS NULL`,
      ).bind(definition.leaderboardId, attempt.attemptId),
    ];
    const results = await session.batch(statements);
    const insertedAttempt = results[1]?.meta.changes === 1;
    const row = await session.prepare(
      `SELECT
        response_retained,
        response_entry_rank,
        response_entry_participant_id,
        response_entry_participant_label,
        response_entry_attempt_id,
        response_entry_score,
        response_entry_metrics_json,
        response_entry_completed_at,
        response_reason
      FROM verified_leaderboard_attempts
      WHERE leaderboard_id = ? AND attempt_id = ?`,
    ).bind(definition.leaderboardId, attempt.attemptId).first<AttemptResponseRow>();

    if (row === null) {
      throw new Error('Failed to read verified leaderboard response after recording.');
    }

    const response: RecordVerifiedLeaderboardAttemptResponse = {
      recorded: true,
      alreadyProcessed: !insertedAttempt,
      retained: row.response_retained === 1,
      entry: rankedEntryFromResponseRow(row),
      ...(row.response_reason === null ? {} : { reason: row.response_reason }),
    };
    assertRecordVerifiedLeaderboardAttemptResponse(response);
    return response;
  }

  async getSnapshot(
    input: GetVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined> {
    assertGetVerifiedLeaderboardSnapshotRequest(input);
    const session = this.db.withSession('first-primary');
    const definitionRow = await session.prepare(
      `SELECT leaderboard_id, score_order, attempt_selection
       FROM verified_leaderboard_definitions
       WHERE leaderboard_id = ?`,
    ).bind(input.leaderboardId).first<DefinitionRow>();

    if (definitionRow === null) {
      return undefined;
    }

    const definition = definitionFromRow(definitionRow);
    const orderBy = createRankOrderBy(definition.scoreOrder);
    const limit = input.limit ?? 10;
    const cursorPosition = input.cursor === undefined
      ? undefined
      : parseVerifiedLeaderboardCursor(input.cursor, definition);
    // Rank is intentionally computed across the full board before keyset filtering.
    // This preserves current global ranks; very large boards should materialize ranks.
    const rankedEntriesQuery = `SELECT
      ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rank,
      participant_id,
      participant_label,
      attempt_id,
      score,
      metrics_json,
      completed_at,
      completed_at_ms,
      attempt_ordinal
    FROM verified_leaderboard_entries
    WHERE leaderboard_id = ?`;
    const pageStatement = cursorPosition === undefined
      ? session.prepare(
          `SELECT * FROM (${rankedEntriesQuery})
           ORDER BY rank
           LIMIT ?`,
        ).bind(input.leaderboardId, limit + 1)
      : session.prepare(
          `SELECT ranked.*
           FROM (${rankedEntriesQuery}) AS ranked
           CROSS JOIN (
             SELECT
               ? AS cursor_score,
               ? AS cursor_completed_at_ms,
               ? AS cursor_attempt_ordinal
           ) AS cursor
           WHERE (
             ranked.score ${definition.scoreOrder === 'ascending' ? '>' : '<'} cursor.cursor_score
             OR (
               ranked.score = cursor.cursor_score
               AND (
                 ranked.completed_at_ms > cursor.cursor_completed_at_ms
                 OR (
                   ranked.completed_at_ms = cursor.cursor_completed_at_ms
                   AND ranked.attempt_ordinal > cursor.cursor_attempt_ordinal
                 )
               )
             )
           )
           ORDER BY ranked.rank
           LIMIT ?`,
        ).bind(
          input.leaderboardId,
          cursorPosition.score,
          cursorPosition.completedAtMs,
          toUtf16OrdinalKey(cursorPosition.attemptId),
          limit + 1,
        );
    const countStatement = session.prepare(
      `SELECT COUNT(*) AS total
       FROM verified_leaderboard_entries
       WHERE leaderboard_id = ?`,
    ).bind(input.leaderboardId);
    const statements = input.participantId === undefined
      ? [pageStatement, countStatement]
      : [
          pageStatement,
          countStatement,
          session.prepare(
            `SELECT *
             FROM (
               SELECT
                 ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rank,
                 participant_id,
                 participant_label,
                 attempt_id,
                 score,
                 metrics_json,
                 completed_at,
                 completed_at_ms,
                 attempt_ordinal
               FROM verified_leaderboard_entries
               WHERE leaderboard_id = ?
             )
             WHERE participant_id = ?`,
          ).bind(input.leaderboardId, input.participantId),
        ];
    const results = await session.batch(statements);
    const pageRows = (results[0]?.results ?? []) as unknown as RankedEntryRow[];
    const entries = pageRows.slice(0, limit).map(rankedEntryFromRow);
    const lastEntry = entries.at(-1);
    const nextCursor = pageRows.length > limit && lastEntry !== undefined
      ? createVerifiedLeaderboardCursor(definition, lastEntry)
      : undefined;
    const totalRow = results[1]?.results[0] as { total?: number } | undefined;
    const participantRow = results[2]?.results[0] as RankedEntryRow | undefined;
    const snapshot: VerifiedLeaderboardSnapshot = {
      definition,
      entries,
      ...(participantRow === undefined
        ? {}
        : { participantEntry: rankedEntryFromRow(participantRow) }),
      totalParticipants: totalRow?.total ?? 0,
      generatedAt: this.now(),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    assertVerifiedLeaderboardSnapshot(snapshot);
    return snapshot;
  }
}

function definitionFromRow(row: DefinitionRow): VerifiedLeaderboardDefinition {
  return {
    leaderboardId: row.leaderboard_id,
    scoreOrder: row.score_order,
    attemptSelection: row.attempt_selection,
  };
}

function rankedEntryFromResponseRow(row: AttemptResponseRow): LeaderboardRankedEntry {
  return {
    rank: row.response_entry_rank,
    participantId: row.response_entry_participant_id,
    ...(row.response_entry_participant_label === null
      ? {}
      : { participantLabel: row.response_entry_participant_label }),
    attemptId: row.response_entry_attempt_id,
    score: row.response_entry_score,
    ...metricsPropertyFromJson(row.response_entry_metrics_json),
    completedAt: row.response_entry_completed_at,
  };
}

function rankedEntryFromRow(row: RankedEntryRow): LeaderboardRankedEntry {
  return {
    rank: row.rank,
    participantId: row.participant_id,
    ...(row.participant_label === null ? {} : { participantLabel: row.participant_label }),
    attemptId: row.attempt_id,
    score: row.score,
    ...metricsPropertyFromJson(row.metrics_json),
    completedAt: row.completed_at,
  };
}

function createRankOrderBy(scoreOrder: VerifiedLeaderboardDefinition['scoreOrder']): string {
  const scoreDirection = scoreOrder === 'ascending' ? 'ASC' : 'DESC';
  return `score ${scoreDirection}, completed_at_ms ASC, attempt_ordinal ASC`;
}

function serializeMetrics(
  metrics: Readonly<Record<string, number>> | undefined,
): string | null {
  return metrics === undefined
    ? null
    : JSON.stringify(normalizeVerifiedLeaderboardMetrics(metrics));
}

function metricsPropertyFromJson(
  metricsJson: string | null,
): { readonly metrics?: Readonly<Record<string, number>> } {
  if (metricsJson === null) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(metricsJson);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Stored verified leaderboard metrics must be an object.');
    }

    return {
      metrics: normalizeVerifiedLeaderboardMetrics(parsed as Readonly<Record<string, number>>),
    };
  } catch (error) {
    console.warn(
      'Ignoring invalid stored verified leaderboard metrics.',
      error,
    );
    return {};
  }
}

function toUtf16OrdinalKey(input: string): string {
  let key = '';

  for (let index = 0; index < input.length; index += 1) {
    key += input.charCodeAt(index).toString(16).padStart(4, '0');
  }

  return key;
}

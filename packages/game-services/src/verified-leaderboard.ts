export type VerifiedLeaderboardScoreOrder = 'ascending' | 'descending';
export type VerifiedLeaderboardAttemptSelection = 'first' | 'best';

export interface VerifiedLeaderboardDefinition {
  readonly leaderboardId: string;
  readonly scoreOrder: VerifiedLeaderboardScoreOrder;
  readonly attemptSelection: VerifiedLeaderboardAttemptSelection;
}

export interface LeaderboardVerificationEvidence {
  readonly authorityId: string;
  readonly evidenceId: string;
  readonly verifiedAt: string;
}

export interface VerifiedLeaderboardAttempt {
  readonly participantId: string;
  readonly participantLabel?: string;
  readonly attemptId: string;
  readonly score: number;
  readonly completedAt: string;
  readonly verification: LeaderboardVerificationEvidence;
}

export interface RecordVerifiedLeaderboardAttemptRequest {
  readonly definition: VerifiedLeaderboardDefinition;
  readonly attempt: VerifiedLeaderboardAttempt;
}

export interface LeaderboardRankedEntry {
  readonly rank: number;
  readonly participantId: string;
  readonly participantLabel?: string;
  readonly attemptId: string;
  readonly score: number;
  readonly completedAt: string;
}

export interface RecordVerifiedLeaderboardAttemptResponse {
  readonly recorded: true;
  readonly alreadyProcessed: boolean;
  readonly retained: boolean;
  readonly entry: LeaderboardRankedEntry;
  readonly reason?: 'ATTEMPT_NOT_RETAINED';
}

export interface GetVerifiedLeaderboardSnapshotRequest {
  readonly leaderboardId: string;
  readonly participantId?: string;
  readonly limit?: number;
}

export interface VerifiedLeaderboardSnapshot {
  readonly definition: VerifiedLeaderboardDefinition;
  readonly entries: readonly LeaderboardRankedEntry[];
  readonly participantEntry?: LeaderboardRankedEntry;
  readonly totalParticipants: number;
  readonly generatedAt: string;
}

/**
 * Safe to expose through a game-facing read transport after the caller supplies
 * any required authentication and participant scoping.
 */
export interface VerifiedLeaderboardReader {
  getSnapshot(
    input: GetVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined>;
}

/**
 * Server-only write boundary. Call this only after an authoritative attempt
 * coordinator has verified the completion. Never expose it as a client score
 * submission endpoint.
 */
export interface TrustedLeaderboardRecorder {
  recordVerifiedAttempt(
    input: RecordVerifiedLeaderboardAttemptRequest,
  ): Promise<RecordVerifiedLeaderboardAttemptResponse>;
}

export interface VerifiedLeaderboardService
  extends VerifiedLeaderboardReader, TrustedLeaderboardRecorder {}

export interface CreateInMemoryVerifiedLeaderboardServiceInput {
  readonly now?: () => string;
}

interface StoredVerifiedLeaderboardAttempt {
  readonly attempt: VerifiedLeaderboardAttempt;
  readonly response: RecordVerifiedLeaderboardAttemptResponse;
}

export function createInMemoryVerifiedLeaderboardService(
  input: CreateInMemoryVerifiedLeaderboardServiceInput = {},
): VerifiedLeaderboardService {
  return new InMemoryVerifiedLeaderboardService(input.now ?? (() => new Date().toISOString()));
}

/**
 * Process-local reference adapter for tests and development. It keeps every
 * definition and processed attempt for its full lifetime and fully sorts the
 * retained attempts for each write and read. Use a durable adapter with
 * eviction and an indexed ranking strategy for long-lived or large boards.
 */
export class InMemoryVerifiedLeaderboardService implements VerifiedLeaderboardService {
  private readonly definitions = new Map<string, VerifiedLeaderboardDefinition>();
  private readonly attemptsById = new Map<string, StoredVerifiedLeaderboardAttempt>();
  private readonly retainedByLeaderboard = new Map<
    string,
    Map<string, VerifiedLeaderboardAttempt>
  >();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async recordVerifiedAttempt(
    input: RecordVerifiedLeaderboardAttemptRequest,
  ): Promise<RecordVerifiedLeaderboardAttemptResponse> {
    assertRecordVerifiedLeaderboardAttemptRequest(input);
    const definition = this.ensureDefinition(input.definition);
    const attempt = cloneVerifiedLeaderboardAttempt(input.attempt);
    const attemptKey = createCompositeKey([definition.leaderboardId, attempt.attemptId]);
    const existingAttempt = this.attemptsById.get(attemptKey);

    if (existingAttempt !== undefined) {
      assertSameAttempt(existingAttempt.attempt, attempt);
      return cloneRecordResponse(existingAttempt.response, true);
    }

    const retainedByParticipant = this.getRetainedAttempts(definition.leaderboardId);
    const retainedAttempt = retainedByParticipant.get(attempt.participantId);

    if (
      retainedAttempt === undefined
      || shouldReplaceRetainedAttempt(definition, retainedAttempt, attempt)
    ) {
      retainedByParticipant.set(attempt.participantId, attempt);
    }

    const response = this.createRecordResponse(definition, attempt, false);
    this.attemptsById.set(attemptKey, {
      attempt,
      response: cloneRecordResponse(response, false),
    });
    return response;
  }

  async getSnapshot(
    input: GetVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined> {
    assertGetVerifiedLeaderboardSnapshotRequest(input);
    const definition = this.definitions.get(input.leaderboardId);

    if (definition === undefined) {
      return undefined;
    }

    const rankedEntries = this.createRankedEntries(definition);
    const participantEntry = input.participantId === undefined
      ? undefined
      : rankedEntries.find((entry) => entry.participantId === input.participantId);

    const snapshot: VerifiedLeaderboardSnapshot = {
      definition: cloneVerifiedLeaderboardDefinition(definition),
      entries: rankedEntries.slice(0, input.limit ?? 10),
      ...(participantEntry === undefined ? {} : { participantEntry }),
      totalParticipants: rankedEntries.length,
      generatedAt: this.now(),
    };
    assertVerifiedLeaderboardSnapshot(snapshot);
    return snapshot;
  }

  private createRecordResponse(
    definition: VerifiedLeaderboardDefinition,
    attempted: VerifiedLeaderboardAttempt,
    alreadyProcessed: boolean,
  ): RecordVerifiedLeaderboardAttemptResponse {
    const rankedEntries = this.createRankedEntries(definition);
    const entry = rankedEntries.find(
      (candidate) => candidate.participantId === attempted.participantId,
    );

    if (entry === undefined) {
      throw new Error('Retained leaderboard entry was not found after recording an attempt.');
    }

    const retained = entry.attemptId === attempted.attemptId;

    const response: RecordVerifiedLeaderboardAttemptResponse = {
      recorded: true,
      alreadyProcessed,
      retained,
      entry,
      ...(retained ? {} : { reason: 'ATTEMPT_NOT_RETAINED' }),
    };
    assertRecordVerifiedLeaderboardAttemptResponse(response);
    return response;
  }

  private ensureDefinition(
    input: VerifiedLeaderboardDefinition,
  ): VerifiedLeaderboardDefinition {
    assertVerifiedLeaderboardDefinition(input);
    const definition = cloneVerifiedLeaderboardDefinition(input);
    const existing = this.definitions.get(definition.leaderboardId);

    if (existing === undefined) {
      this.definitions.set(definition.leaderboardId, definition);
      return definition;
    }

    if (
      existing.scoreOrder !== definition.scoreOrder
      || existing.attemptSelection !== definition.attemptSelection
    ) {
      throw new Error(
        `Leaderboard definition conflict for ${JSON.stringify(definition.leaderboardId)}.`,
      );
    }

    return existing;
  }

  private getRetainedAttempts(
    leaderboardId: string,
  ): Map<string, VerifiedLeaderboardAttempt> {
    const existing = this.retainedByLeaderboard.get(leaderboardId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, VerifiedLeaderboardAttempt>();
    this.retainedByLeaderboard.set(leaderboardId, created);
    return created;
  }

  private createRankedEntries(
    definition: VerifiedLeaderboardDefinition,
  ): readonly LeaderboardRankedEntry[] {
    return [...this.getRetainedAttempts(definition.leaderboardId).values()]
      .sort((left, right) => compareAttempts(definition.scoreOrder, left, right))
      .map((attempt, index) => toRankedEntry(attempt, index + 1));
  }
}

export function assertVerifiedLeaderboardDefinition(
  input: unknown,
): asserts input is VerifiedLeaderboardDefinition {
  assertRecord(input, 'VerifiedLeaderboardDefinition');
  assertNonEmptyString(input.leaderboardId, 'leaderboardId');
  assertScoreOrder(input.scoreOrder);
  assertAttemptSelection(input.attemptSelection);
}

export function assertLeaderboardVerificationEvidence(
  input: unknown,
): asserts input is LeaderboardVerificationEvidence {
  assertRecord(input, 'LeaderboardVerificationEvidence');
  assertNonEmptyString(input.authorityId, 'authorityId');
  assertNonEmptyString(input.evidenceId, 'evidenceId');
  assertTimestamp(input.verifiedAt, 'verifiedAt');
}

export function assertVerifiedLeaderboardAttempt(
  input: unknown,
): asserts input is VerifiedLeaderboardAttempt {
  assertRecord(input, 'VerifiedLeaderboardAttempt');
  assertNonEmptyString(input.participantId, 'participantId');
  assertOptionalNonEmptyString(input.participantLabel, 'participantLabel');
  assertNonEmptyString(input.attemptId, 'attemptId');
  assertFiniteNumber(input.score, 'score');
  assertTimestamp(input.completedAt, 'completedAt');
  assertLeaderboardVerificationEvidence(input.verification);
}

export function assertRecordVerifiedLeaderboardAttemptRequest(
  input: unknown,
): asserts input is RecordVerifiedLeaderboardAttemptRequest {
  assertRecord(input, 'RecordVerifiedLeaderboardAttemptRequest');
  assertVerifiedLeaderboardDefinition(input.definition);
  assertVerifiedLeaderboardAttempt(input.attempt);
}

export function assertRecordVerifiedLeaderboardAttemptResponse(
  input: unknown,
): asserts input is RecordVerifiedLeaderboardAttemptResponse {
  assertRecord(input, 'RecordVerifiedLeaderboardAttemptResponse');

  if (input.recorded !== true) {
    throw new Error('recorded must be true.');
  }

  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertBoolean(input.retained, 'retained');
  assertLeaderboardRankedEntry(input.entry);

  if (input.reason !== undefined && input.reason !== 'ATTEMPT_NOT_RETAINED') {
    throw new Error('reason must be ATTEMPT_NOT_RETAINED when provided.');
  }

  if (input.retained === (input.reason !== undefined)) {
    throw new Error('reason must be present exactly when the attempt is not retained.');
  }
}

export function assertGetVerifiedLeaderboardSnapshotRequest(
  input: unknown,
): asserts input is GetVerifiedLeaderboardSnapshotRequest {
  assertRecord(input, 'GetVerifiedLeaderboardSnapshotRequest');
  assertNonEmptyString(input.leaderboardId, 'leaderboardId');
  assertOptionalNonEmptyString(input.participantId, 'participantId');

  if (
    input.limit !== undefined
    && (
      typeof input.limit !== 'number'
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 100
    )
  ) {
    throw new Error('limit must be an integer from 1 through 100.');
  }
}

export function assertLeaderboardRankedEntry(
  input: unknown,
): asserts input is LeaderboardRankedEntry {
  assertRecord(input, 'LeaderboardRankedEntry');

  if (typeof input.rank !== 'number' || !Number.isInteger(input.rank) || input.rank < 1) {
    throw new Error('rank must be a positive integer.');
  }

  assertNonEmptyString(input.participantId, 'participantId');
  assertOptionalNonEmptyString(input.participantLabel, 'participantLabel');
  assertNonEmptyString(input.attemptId, 'attemptId');
  assertFiniteNumber(input.score, 'score');
  assertTimestamp(input.completedAt, 'completedAt');
}

export function assertVerifiedLeaderboardSnapshot(
  input: unknown,
): asserts input is VerifiedLeaderboardSnapshot {
  assertRecord(input, 'VerifiedLeaderboardSnapshot');
  assertVerifiedLeaderboardDefinition(input.definition);

  if (!Array.isArray(input.entries)) {
    throw new Error('entries must be an array.');
  }

  for (const entry of input.entries) {
    assertLeaderboardRankedEntry(entry);
  }

  if (input.participantEntry !== undefined) {
    assertLeaderboardRankedEntry(input.participantEntry);
  }

  if (
    typeof input.totalParticipants !== 'number'
    || !Number.isInteger(input.totalParticipants)
    || input.totalParticipants < 0
  ) {
    throw new Error('totalParticipants must be a non-negative integer.');
  }

  assertTimestamp(input.generatedAt, 'generatedAt');
}

function shouldReplaceRetainedAttempt(
  definition: VerifiedLeaderboardDefinition,
  retained: VerifiedLeaderboardAttempt,
  candidate: VerifiedLeaderboardAttempt,
): boolean {
  if (definition.attemptSelection === 'first') {
    return compareAttemptChronology(candidate, retained) < 0;
  }

  return compareAttempts(definition.scoreOrder, candidate, retained) < 0;
}

function compareAttemptChronology(
  left: VerifiedLeaderboardAttempt,
  right: VerifiedLeaderboardAttempt,
): number {
  const completedAtComparison = Date.parse(left.completedAt) - Date.parse(right.completedAt);

  if (completedAtComparison !== 0) {
    return completedAtComparison;
  }

  return left.attemptId.localeCompare(right.attemptId);
}

function compareAttempts(
  scoreOrder: VerifiedLeaderboardScoreOrder,
  left: VerifiedLeaderboardAttempt,
  right: VerifiedLeaderboardAttempt,
): number {
  if (left.score !== right.score) {
    return scoreOrder === 'ascending' ? left.score - right.score : right.score - left.score;
  }

  const completedAtComparison = Date.parse(left.completedAt) - Date.parse(right.completedAt);

  if (completedAtComparison !== 0) {
    return completedAtComparison;
  }

  return left.attemptId.localeCompare(right.attemptId);
}

function toRankedEntry(
  attempt: VerifiedLeaderboardAttempt,
  rank: number,
): LeaderboardRankedEntry {
  const entry: LeaderboardRankedEntry = {
    rank,
    participantId: attempt.participantId,
    ...(attempt.participantLabel === undefined
      ? {}
      : { participantLabel: attempt.participantLabel }),
    attemptId: attempt.attemptId,
    score: attempt.score,
    completedAt: attempt.completedAt,
  };
  assertLeaderboardRankedEntry(entry);
  return entry;
}

function assertSameAttempt(
  existing: VerifiedLeaderboardAttempt,
  candidate: VerifiedLeaderboardAttempt,
): void {
  if (
    existing.participantId !== candidate.participantId
    || existing.attemptId !== candidate.attemptId
    || existing.score !== candidate.score
    || existing.completedAt !== candidate.completedAt
    || existing.verification.authorityId !== candidate.verification.authorityId
    || existing.verification.evidenceId !== candidate.verification.evidenceId
    || existing.verification.verifiedAt !== candidate.verification.verifiedAt
  ) {
    throw new Error(`Attempt id conflict for ${JSON.stringify(candidate.attemptId)}.`);
  }
}

function cloneVerifiedLeaderboardDefinition(
  input: VerifiedLeaderboardDefinition,
): VerifiedLeaderboardDefinition {
  return {
    leaderboardId: input.leaderboardId,
    scoreOrder: input.scoreOrder,
    attemptSelection: input.attemptSelection,
  };
}

function cloneVerifiedLeaderboardAttempt(
  input: VerifiedLeaderboardAttempt,
): VerifiedLeaderboardAttempt {
  return {
    participantId: input.participantId,
    ...(input.participantLabel === undefined
      ? {}
      : { participantLabel: input.participantLabel }),
    attemptId: input.attemptId,
    score: input.score,
    completedAt: input.completedAt,
    verification: {
      authorityId: input.verification.authorityId,
      evidenceId: input.verification.evidenceId,
      verifiedAt: input.verification.verifiedAt,
    },
  };
}

function cloneRecordResponse(
  input: RecordVerifiedLeaderboardAttemptResponse,
  alreadyProcessed: boolean,
): RecordVerifiedLeaderboardAttemptResponse {
  const response: RecordVerifiedLeaderboardAttemptResponse = {
    recorded: true,
    alreadyProcessed,
    retained: input.retained,
    entry: {
      rank: input.entry.rank,
      participantId: input.entry.participantId,
      ...(input.entry.participantLabel === undefined
        ? {}
        : { participantLabel: input.entry.participantLabel }),
      attemptId: input.entry.attemptId,
      score: input.entry.score,
      completedAt: input.entry.completedAt,
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  assertRecordVerifiedLeaderboardAttemptResponse(response);
  return response;
}

function createCompositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertOptionalNonEmptyString(
  input: unknown,
  label: string,
): asserts input is string | undefined {
  if (input !== undefined) {
    assertNonEmptyString(input, label);
  }
}

function assertFiniteNumber(input: unknown, label: string): asserts input is number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertTimestamp(input: unknown, label: string): asserts input is string {
  assertNonEmptyString(input, label);

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
    || !Number.isFinite(Date.parse(input))
  ) {
    throw new Error(`${label} must be a valid timezone-qualified timestamp.`);
  }
}

function assertScoreOrder(input: unknown): asserts input is VerifiedLeaderboardScoreOrder {
  if (input !== 'ascending' && input !== 'descending') {
    throw new Error('scoreOrder must be ascending or descending.');
  }
}

function assertAttemptSelection(
  input: unknown,
): asserts input is VerifiedLeaderboardAttemptSelection {
  if (input !== 'first' && input !== 'best') {
    throw new Error('attemptSelection must be first or best.');
  }
}

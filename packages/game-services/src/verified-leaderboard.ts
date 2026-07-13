export type VerifiedLeaderboardScoreOrder = 'ascending' | 'descending';
export type VerifiedLeaderboardAttemptSelection = 'first' | 'best';

export const verifiedLeaderboardIdentifierMaximumLength = 2_048;

const timestampPattern = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})'
    + 'T(\\d{2}):(\\d{2}):(\\d{2})'
    + '(?:\\.(\\d{1,3}))?(Z|([+-])(\\d{2}):(\\d{2}))$',
);

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
  readonly cursor?: string;
}

export interface VerifiedLeaderboardSnapshot {
  readonly definition: VerifiedLeaderboardDefinition;
  readonly entries: readonly LeaderboardRankedEntry[];
  readonly participantEntry?: LeaderboardRankedEntry;
  readonly totalParticipants: number;
  readonly generatedAt: string;
  readonly nextCursor?: string;
}

export interface VerifiedLeaderboardCursorPosition {
  readonly score: number;
  readonly completedAtMs: number;
  readonly attemptId: string;
}

export class VerifiedLeaderboardCursorError extends Error {
  override readonly name = 'VerifiedLeaderboardCursorError';
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
    const cursorPosition = input.cursor === undefined
      ? undefined
      : parseVerifiedLeaderboardCursor(input.cursor, definition);
    const firstPageIndex = cursorPosition === undefined
      ? 0
      : rankedEntries.findIndex(
          (entry) => compareRankedEntryToCursor(definition, entry, cursorPosition) > 0,
        );
    const pageStart = firstPageIndex < 0 ? rankedEntries.length : firstPageIndex;
    const pageEnd = pageStart + (input.limit ?? 10);
    const entries = rankedEntries.slice(pageStart, pageEnd);
    const participantEntry = input.participantId === undefined
      ? undefined
      : rankedEntries.find((entry) => entry.participantId === input.participantId);
    const lastEntry = entries.at(-1);
    const nextCursor = lastEntry !== undefined && pageEnd < rankedEntries.length
      ? createVerifiedLeaderboardCursor(definition, lastEntry)
      : undefined;

    const snapshot: VerifiedLeaderboardSnapshot = {
      definition: cloneVerifiedLeaderboardDefinition(definition),
      entries,
      ...(participantEntry === undefined ? {} : { participantEntry }),
      totalParticipants: rankedEntries.length,
      generatedAt: this.now(),
      ...(nextCursor === undefined ? {} : { nextCursor }),
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
  assertVerifiedLeaderboardIdentifier(input.leaderboardId, 'leaderboardId');
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
  assertVerifiedLeaderboardIdentifier(input.attemptId, 'attemptId');
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
  assertVerifiedLeaderboardIdentifier(input.leaderboardId, 'leaderboardId');
  assertOptionalNonEmptyString(input.participantId, 'participantId');
  assertOptionalCursor(input.cursor);

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
  assertVerifiedLeaderboardIdentifier(input.attemptId, 'attemptId');
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
  assertOptionalCursor(input.nextCursor);
}

export function createVerifiedLeaderboardCursor(
  definition: VerifiedLeaderboardDefinition,
  entry: LeaderboardRankedEntry,
): string {
  assertVerifiedLeaderboardDefinition(definition);
  assertLeaderboardRankedEntry(entry);

  const cursor = encodeBase64Url(
    JSON.stringify({
      version: 1,
      leaderboardId: definition.leaderboardId,
      scoreOrder: definition.scoreOrder,
      attemptSelection: definition.attemptSelection,
      score: entry.score,
      completedAt: entry.completedAt,
      attemptId: entry.attemptId,
    }),
  );
  assertOptionalCursor(cursor);
  return cursor;
}

export function parseVerifiedLeaderboardCursor(
  cursor: string,
  definition: VerifiedLeaderboardDefinition,
): VerifiedLeaderboardCursorPosition {
  assertVerifiedLeaderboardDefinition(definition);

  try {
    assertOptionalCursor(cursor);
    const payload: unknown = JSON.parse(decodeBase64Url(cursor));
    assertRecord(payload, 'VerifiedLeaderboardCursor');

    if (payload.version !== 1) {
      throw new Error('cursor version must be 1.');
    }

    assertVerifiedLeaderboardIdentifier(payload.leaderboardId, 'cursor leaderboardId');
    assertScoreOrder(payload.scoreOrder);
    assertAttemptSelection(payload.attemptSelection);
    assertFiniteNumber(payload.score, 'cursor score');
    assertTimestamp(payload.completedAt, 'cursor completedAt');
    assertVerifiedLeaderboardIdentifier(payload.attemptId, 'cursor attemptId');

    if (
      payload.leaderboardId !== definition.leaderboardId
      || payload.scoreOrder !== definition.scoreOrder
      || payload.attemptSelection !== definition.attemptSelection
    ) {
      throw new Error('cursor does not match the leaderboard definition.');
    }

    return {
      score: payload.score,
      completedAtMs: parseTimestamp(payload.completedAt),
      attemptId: payload.attemptId,
    };
  } catch (error) {
    if (error instanceof VerifiedLeaderboardCursorError) {
      throw error;
    }

    throw new VerifiedLeaderboardCursorError('Invalid verified leaderboard cursor.', {
      cause: error,
    });
  }
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
  const completedAtComparison =
    parseTimestamp(left.completedAt) - parseTimestamp(right.completedAt);

  if (completedAtComparison !== 0) {
    return completedAtComparison;
  }

  return compareOrdinal(left.attemptId, right.attemptId);
}

function compareAttempts(
  scoreOrder: VerifiedLeaderboardScoreOrder,
  left: VerifiedLeaderboardAttempt,
  right: VerifiedLeaderboardAttempt,
): number {
  if (left.score !== right.score) {
    return scoreOrder === 'ascending' ? left.score - right.score : right.score - left.score;
  }

  const completedAtComparison =
    parseTimestamp(left.completedAt) - parseTimestamp(right.completedAt);

  if (completedAtComparison !== 0) {
    return completedAtComparison;
  }

  return compareOrdinal(left.attemptId, right.attemptId);
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
    || parseTimestamp(existing.completedAt) !== parseTimestamp(candidate.completedAt)
    || existing.verification.authorityId !== candidate.verification.authorityId
    || existing.verification.evidenceId !== candidate.verification.evidenceId
    || parseTimestamp(existing.verification.verifiedAt)
      !== parseTimestamp(candidate.verification.verifiedAt)
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

function assertVerifiedLeaderboardIdentifier(
  input: unknown,
  label: string,
): asserts input is string {
  assertNonEmptyString(input, label);

  if (input.length > verifiedLeaderboardIdentifierMaximumLength) {
    throw new Error(
      `${label} must contain at most ${String(verifiedLeaderboardIdentifierMaximumLength)} characters.`,
    );
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

  if (!Number.isFinite(parseTimestamp(input))) {
    throw new Error(`${label} must be a valid timezone-qualified timestamp.`);
  }
}

function parseTimestamp(input: string): number {
  const match = timestampPattern.exec(input);

  if (match === null) {
    return Number.NaN;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHour = Number(match[10] ?? '0');
  const offsetMinute = Number(match[11] ?? '0');

  if (offsetHour > 23 || offsetMinute > 59) {
    return Number.NaN;
  }

  const localTime = new Date(0);
  localTime.setUTCFullYear(year, month - 1, day);
  localTime.setUTCHours(hour, minute, second, millisecond);

  if (
    localTime.getUTCFullYear() !== year
    || localTime.getUTCMonth() !== month - 1
    || localTime.getUTCDate() !== day
    || localTime.getUTCHours() !== hour
    || localTime.getUTCMinutes() !== minute
    || localTime.getUTCSeconds() !== second
    || localTime.getUTCMilliseconds() !== millisecond
  ) {
    return Number.NaN;
  }

  const offsetDirection = match[9] === '-' ? -1 : 1;
  const offsetMilliseconds = offsetDirection
    * (offsetHour * 60 + offsetMinute)
    * 60_000;

  return localTime.getTime() - offsetMilliseconds;
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function compareRankedEntryToCursor(
  definition: VerifiedLeaderboardDefinition,
  entry: LeaderboardRankedEntry,
  cursor: VerifiedLeaderboardCursorPosition,
): number {
  if (entry.score !== cursor.score) {
    const comparison = entry.score < cursor.score ? -1 : 1;
    return definition.scoreOrder === 'ascending' ? comparison : -comparison;
  }

  const completedAtMs = parseTimestamp(entry.completedAt);

  if (completedAtMs !== cursor.completedAtMs) {
    return completedAtMs < cursor.completedAtMs ? -1 : 1;
  }

  return compareOrdinal(entry.attemptId, cursor.attemptId);
}

function assertOptionalCursor(input: unknown): asserts input is string | undefined {
  if (input === undefined) {
    return;
  }

  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 65_536
    || !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new VerifiedLeaderboardCursorError(
      'cursor must be a base64url string no longer than 65536 characters.',
    );
  }
}

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += base64UrlAlphabet.charAt((bits >>> 18) & 63);
    encoded += base64UrlAlphabet.charAt((bits >>> 12) & 63);

    if (second !== undefined) {
      encoded += base64UrlAlphabet.charAt((bits >>> 6) & 63);
    }

    if (third !== undefined) {
      encoded += base64UrlAlphabet.charAt(bits & 63);
    }
  }

  return encoded;
}

function decodeBase64Url(input: string): string {
  if (input.length % 4 === 1) {
    throw new Error('cursor has invalid base64url length.');
  }

  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 4) {
    const first = decodeBase64UrlCharacter(input[index]);
    const second = decodeBase64UrlCharacter(input[index + 1]);
    const third = decodeBase64UrlCharacter(input[index + 2]);
    const fourth = decodeBase64UrlCharacter(input[index + 3]);
    const bits = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes.push((bits >>> 16) & 255);

    if (input[index + 2] !== undefined) {
      bytes.push((bits >>> 8) & 255);
    }

    if (input[index + 3] !== undefined) {
      bytes.push(bits & 255);
    }
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

function decodeBase64UrlCharacter(input: string | undefined): number {
  if (input === undefined) {
    return 0;
  }

  const value = base64UrlAlphabet.indexOf(input);

  if (value < 0) {
    throw new Error('cursor contains invalid base64url characters.');
  }

  return value;
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

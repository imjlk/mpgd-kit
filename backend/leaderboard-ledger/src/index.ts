import type { LeaderboardScoreInput } from '@mpgd/platform';

export type LeaderboardLedgerTarget =
  | 'browser'
  | 'android'
  | 'ios'
  | 'ait'
  | 'reddit'
  | 'verse8';

export interface RecordLeaderboardScoreRequest extends LeaderboardScoreInput {
  readonly target: LeaderboardLedgerTarget;
  readonly playerId: string;
  readonly platformSubmissionId?: string;
}

export interface RecordLeaderboardScoreResponse {
  readonly submitted: boolean;
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
  readonly rank: number;
}

export interface LeaderboardScoreTransaction extends RecordLeaderboardScoreRequest {
  readonly ledgerEntryId: string;
  readonly recordedAt: string;
}

export interface LeaderboardLedger {
  recordScore(input: RecordLeaderboardScoreRequest): RecordLeaderboardScoreResponse;
  getTransaction(ledgerEntryId: string): LeaderboardScoreTransaction | undefined;
  listTransactions(): readonly LeaderboardScoreTransaction[];
}

export function assertRecordLeaderboardScoreRequest(
  input: RecordLeaderboardScoreRequest,
): RecordLeaderboardScoreRequest {
  assertRecord(input, 'RecordLeaderboardScoreRequest');
  assertLedgerTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.leaderboardId, 'leaderboardId');
  assertFiniteNumber(input.score, 'score');
  assertNonEmptyString(input.runId, 'runId');
  assertNonEmptyString(input.submittedAt, 'submittedAt');
  assertOptionalNonEmptyString(input.platformSubmissionId, 'platformSubmissionId');

  return input;
}

export function assertRecordLeaderboardScoreResponse(
  input: RecordLeaderboardScoreResponse,
): RecordLeaderboardScoreResponse {
  assertRecord(input, 'RecordLeaderboardScoreResponse');
  assertBoolean(input.submitted, 'submitted');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertFiniteNumber(input.rank, 'rank');

  return input;
}

export function assertLeaderboardScoreTransaction(
  input: LeaderboardScoreTransaction,
): LeaderboardScoreTransaction {
  assertRecordLeaderboardScoreRequest(input);
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertNonEmptyString(input.recordedAt, 'recordedAt');

  return input;
}

export class InMemoryLeaderboardLedger implements LeaderboardLedger {
  private readonly transactionsByRun = new Map<string, LeaderboardScoreTransaction>();
  private readonly transactionsById = new Map<string, LeaderboardScoreTransaction>();

  recordScore(input: RecordLeaderboardScoreRequest): RecordLeaderboardScoreResponse {
    const request = assertRecordLeaderboardScoreRequest(input);
    const runKey = createRunKey(request);
    const existing = this.transactionsByRun.get(runKey);

    if (existing !== undefined) {
      return assertRecordLeaderboardScoreResponse({
        submitted: true,
        ledgerEntryId: existing.ledgerEntryId,
        alreadyProcessed: true,
        rank: this.rankFor(existing),
      });
    }

    const transaction = assertLeaderboardScoreTransaction({
      ...request,
      ledgerEntryId: createLedgerEntryId(request),
      recordedAt: new Date().toISOString(),
    });

    this.transactionsByRun.set(runKey, transaction);
    this.transactionsById.set(transaction.ledgerEntryId, transaction);

    return assertRecordLeaderboardScoreResponse({
      submitted: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
      rank: this.rankFor(transaction),
    });
  }

  getTransaction(ledgerEntryId: string): LeaderboardScoreTransaction | undefined {
    return this.transactionsById.get(ledgerEntryId);
  }

  listTransactions(): readonly LeaderboardScoreTransaction[] {
    return [...this.transactionsById.values()].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.submittedAt.localeCompare(right.submittedAt);
    });
  }

  private rankFor(transaction: LeaderboardScoreTransaction): number {
    return (
      this.listTransactions()
        .filter((candidate) => candidate.leaderboardId === transaction.leaderboardId)
        .findIndex((candidate) => candidate.ledgerEntryId === transaction.ledgerEntryId) + 1
    );
  }
}

export function createInMemoryLeaderboardLedger(): InMemoryLeaderboardLedger {
  return new InMemoryLeaderboardLedger();
}

function createRunKey(request: RecordLeaderboardScoreRequest): string {
  return createCompositeKey([
    request.target,
    request.leaderboardId,
    request.playerId,
    request.runId,
  ]);
}

function createLedgerEntryId(request: RecordLeaderboardScoreRequest): string {
  return [
    'leaderboard',
    encodeIdSegment(request.target),
    encodeIdSegment(request.leaderboardId),
    encodeIdSegment(request.playerId),
    encodeIdSegment(request.runId),
  ].join('_');
}

function createCompositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function encodeIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertLedgerTarget(input: unknown): asserts input is LeaderboardLedgerTarget {
  if (
    input !== 'browser'
    && input !== 'android'
    && input !== 'ios'
    && input !== 'ait'
    && input !== 'reddit'
    && input !== 'verse8'
  ) {
    throw new Error('target must be browser, android, ios, ait, reddit, or verse8.');
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

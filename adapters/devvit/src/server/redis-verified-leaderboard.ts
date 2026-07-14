import {
  areVerifiedLeaderboardMetricsEqual,
  assertGetVerifiedLeaderboardSnapshotRequest,
  assertRecordVerifiedLeaderboardAttemptRequest,
  assertRecordVerifiedLeaderboardAttemptResponse,
  assertVerifiedLeaderboardAttempt,
  assertVerifiedLeaderboardDefinition,
  assertVerifiedLeaderboardSnapshot,
  createVerifiedLeaderboardCursor,
  normalizeVerifiedLeaderboardMetrics,
  parseVerifiedLeaderboardCursor,
  type GetVerifiedLeaderboardSnapshotRequest,
  type LeaderboardRankedEntry,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardAttempt,
  type VerifiedLeaderboardDefinition,
  type VerifiedLeaderboardScoreOrder,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshot,
} from '@mpgd/game-services/verified-leaderboard';

const defaultKeyPrefix = 'mpgd:verified-leaderboard:v1';
const defaultSnapshotLimit = 10;
const defaultTransactionAttempts = 3;
const maximumTransactionAttempts = 32;
const keyPrefixPattern = /^[A-Za-z0-9:_-]{1,128}$/;

export interface DevvitVerifiedLeaderboardRedisMember {
  readonly member: string;
  readonly score: number;
}

export interface DevvitVerifiedLeaderboardRedisTransactionLike {
  multi(): Promise<void>;
  discard(): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<unknown>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  zAdd(
    key: string,
    ...members: DevvitVerifiedLeaderboardRedisMember[]
  ): Promise<unknown>;
  zRem(key: string, members: string[]): Promise<unknown>;
  exec(): Promise<readonly unknown[] | null>;
  unwatch(): Promise<unknown>;
}

export interface DevvitVerifiedLeaderboardRedisLike {
  get(key: string): Promise<string | undefined>;
  hGet(key: string, field: string): Promise<string | undefined>;
  zRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<DevvitVerifiedLeaderboardRedisMember[]>;
  watch(...keys: string[]): Promise<DevvitVerifiedLeaderboardRedisTransactionLike>;
}

export interface DevvitRedisVerifiedLeaderboardServiceOptions {
  /** Redis-safe namespace shared by every board created by this provider. */
  readonly keyPrefix?: string;
  /** Maximum optimistic transaction attempts after WATCH contention. */
  readonly transactionAttempts?: number;
  /** Clock used for snapshot generation timestamps. */
  readonly now?: () => string;
}

interface BoardKeys {
  readonly definition: string;
  readonly attempts: string;
  readonly entries: string;
  readonly ranking: string;
  readonly watched: string[];
}

interface RankedAttempt {
  readonly member: string;
  readonly attempt: VerifiedLeaderboardAttempt;
}

interface StoredAttemptDecision {
  readonly version: 1;
  readonly attempt: VerifiedLeaderboardAttempt;
  readonly response: RecordVerifiedLeaderboardAttemptResponse;
}

interface StoredRetainedAttempt {
  readonly version: 1;
  readonly attempt: VerifiedLeaderboardAttempt;
}

/**
 * Durable Devvit Redis provider for modest verified leaderboards. Writes are
 * fenced with WATCH/MULTI/EXEC and keep the original idempotency response.
 * Reads and writes load retained entries to reproduce the contract's exact
 * JavaScript ordering, including UTF-16 tie breakers and cursor traversal.
 */
export function createDevvitRedisVerifiedLeaderboardService(
  redis: DevvitVerifiedLeaderboardRedisLike,
  options: DevvitRedisVerifiedLeaderboardServiceOptions = {},
): VerifiedLeaderboardService {
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix);
  const transactionAttempts = normalizeTransactionAttempts(options.transactionAttempts);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async recordVerifiedAttempt(input) {
      assertRecordVerifiedLeaderboardAttemptRequest(input);
      const request = cloneRecordRequest(input);
      const keys = await createBoardKeys(keyPrefix, request.definition.leaderboardId);
      const attemptMember = await createDigest(request.attempt.attemptId);

      for (let transactionAttempt = 0;
        transactionAttempt < transactionAttempts;
        transactionAttempt += 1) {
        const transaction = await redis.watch(...keys.watched);
        let multiStarted = false;

        try {
          const storedDefinition = await readDefinition(redis, keys);
          const definition = ensureDefinition(storedDefinition, request.definition);
          const existingRaw = await redis.hGet(keys.attempts, attemptMember);

          if (existingRaw !== undefined) {
            const existing = parseStoredAttemptDecision(existingRaw, keys.attempts);
            assertSameAttempt(existing.attempt, request.attempt);
            await transaction.unwatch();
            return cloneRecordResponse(existing.response, true);
          }

          const rankedAttempts = await readRankedAttempts(
            redis,
            keys,
            definition,
            transactionAttempts,
          );
          assertAvailableAttemptMember(rankedAttempts, attemptMember, request.attempt);
          const retainedAttempt = rankedAttempts.find(
            (candidate) => candidate.attempt.participantId === request.attempt.participantId,
          );
          const shouldRetain = retainedAttempt === undefined
            || shouldReplaceRetainedAttempt(
              definition,
              retainedAttempt.attempt,
              request.attempt,
            );
          const nextRankedAttempts = shouldRetain
            ? replaceRetainedAttempt(rankedAttempts, retainedAttempt, {
              member: attemptMember,
              attempt: request.attempt,
            })
            : rankedAttempts;
          const response = createRecordResponse(
            definition,
            request.attempt,
            nextRankedAttempts,
          );

          await transaction.multi();
          multiStarted = true;

          if (storedDefinition === undefined) {
            await transaction.set(keys.definition, JSON.stringify(definition));
          }

          if (shouldRetain) {
            if (retainedAttempt !== undefined) {
              await transaction.zRem(keys.ranking, [retainedAttempt.member]);
              await transaction.hDel(keys.entries, [retainedAttempt.member]);
            }

            await transaction.zAdd(keys.ranking, {
              member: attemptMember,
              score: redisRankingScore(definition.scoreOrder, request.attempt.score),
            });
            await transaction.hSet(keys.entries, {
              [attemptMember]: serializeRetainedAttempt(request.attempt),
            });
          }

          await transaction.hSet(keys.attempts, {
            [attemptMember]: serializeAttemptDecision(request.attempt, response),
          });
          const results = await transaction.exec();

          if (results === null || (Array.isArray(results) && results.length === 0)) {
            continue;
          }

          if (!Array.isArray(results)) {
            throw new Error('Devvit Redis transaction returned an unsupported response.');
          }

          return response;
        } catch (error) {
          await bestEffortReset(transaction, multiStarted);
          throw error;
        }
      }

      throw new Error(
        'Devvit Redis verified leaderboard transaction contention exceeded '
          + `${String(transactionAttempts)} attempts for board: `
          + request.definition.leaderboardId,
      );
    },

    async getSnapshot(input) {
      assertGetVerifiedLeaderboardSnapshotRequest(input);
      const request: GetVerifiedLeaderboardSnapshotRequest = {
        leaderboardId: input.leaderboardId,
        ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      };
      const keys = await createBoardKeys(keyPrefix, request.leaderboardId);
      const definition = await readDefinition(redis, keys);

      if (definition === undefined) {
        return undefined;
      }

      const rankedAttempts = await readRankedAttempts(
        redis,
        keys,
        definition,
        transactionAttempts,
      );
      const rankedEntries = toRankedEntries(rankedAttempts);
      const cursorPosition = request.cursor === undefined
        ? undefined
        : parseVerifiedLeaderboardCursor(request.cursor, definition);
      const firstPageIndex = cursorPosition === undefined
        ? 0
        : rankedEntries.findIndex(
          (entry) => compareEntryToCursor(definition.scoreOrder, entry, cursorPosition) > 0,
        );
      const pageStart = firstPageIndex < 0 ? rankedEntries.length : firstPageIndex;
      const pageEnd = pageStart + (request.limit ?? defaultSnapshotLimit);
      const entries = rankedEntries.slice(pageStart, pageEnd);
      const participantEntry = request.participantId === undefined
        ? undefined
        : rankedEntries.find((entry) => entry.participantId === request.participantId);
      const lastEntry = entries.at(-1);
      const nextCursor = lastEntry !== undefined && pageEnd < rankedEntries.length
        ? createVerifiedLeaderboardCursor(definition, lastEntry)
        : undefined;
      const snapshot: VerifiedLeaderboardSnapshot = {
        definition: cloneDefinition(definition),
        entries,
        ...(participantEntry === undefined ? {} : { participantEntry }),
        totalParticipants: rankedEntries.length,
        generatedAt: now(),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      assertVerifiedLeaderboardSnapshot(snapshot);
      return snapshot;
    },
  };
}

async function createBoardKeys(keyPrefix: string, leaderboardId: string): Promise<BoardKeys> {
  const boardDigest = await createDigest(leaderboardId);
  const base = `${keyPrefix}:${boardDigest}`;
  const keys = {
    definition: `${base}:definition`,
    attempts: `${base}:attempts`,
    entries: `${base}:entries`,
    ranking: `${base}:ranking`,
  };

  return {
    ...keys,
    watched: [keys.definition, keys.attempts, keys.entries, keys.ranking],
  };
}

async function createDigest(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  if (subtle === undefined) {
    throw new Error('Web Crypto is required for Devvit Redis leaderboard keys.');
  }

  const bytes = new Uint8Array(input.length * 2);

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }

  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function readDefinition(
  redis: DevvitVerifiedLeaderboardRedisLike,
  keys: BoardKeys,
): Promise<VerifiedLeaderboardDefinition | undefined> {
  const raw = await redis.get(keys.definition);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = parseJson(raw, keys.definition);
  assertVerifiedLeaderboardDefinition(parsed);
  return cloneDefinition(parsed);
}

async function readRankedAttempts(
  redis: DevvitVerifiedLeaderboardRedisLike,
  keys: BoardKeys,
  definition: VerifiedLeaderboardDefinition,
  readAttempts: number,
): Promise<RankedAttempt[]> {
  for (let attempt = 0; attempt < readAttempts; attempt += 1) {
    const rankedAttempts = await tryReadRankedAttempts(redis, keys, definition);

    if (rankedAttempts !== undefined) {
      return rankedAttempts;
    }
  }

  throw new Error(
    'Devvit Redis retained entries changed during '
      + `${String(readAttempts)} consecutive reads for ${keys.ranking}.`,
  );
}

async function tryReadRankedAttempts(
  redis: DevvitVerifiedLeaderboardRedisLike,
  keys: BoardKeys,
  definition: VerifiedLeaderboardDefinition,
): Promise<RankedAttempt[] | undefined> {
  const members = await redis.zRange(keys.ranking, 0, -1);

  if (members.length === 0) {
    return [];
  }

  const values = await Promise.all(members.map(({ member }) => redis.hGet(keys.entries, member)));

  const rankedAttempts: RankedAttempt[] = [];

  for (const [index, member] of members.entries()) {
    const raw = values[index];

    if (raw === undefined) {
      return undefined;
    }

    const stored = parseStoredRetainedAttempt(raw, keys.entries);
    const expectedScore = redisRankingScore(definition.scoreOrder, stored.attempt.score);

    if (member.score !== expectedScore) {
      throw new Error(`Devvit Redis retained entry score is inconsistent for ${keys.ranking}.`);
    }

    rankedAttempts.push({ member: member.member, attempt: stored.attempt });
  }

  assertUniqueRetainedParticipants(rankedAttempts, keys.entries);
  return rankedAttempts.sort(
    (left, right) => compareAttempts(definition.scoreOrder, left.attempt, right.attempt),
  );
}

function ensureDefinition(
  existing: VerifiedLeaderboardDefinition | undefined,
  input: VerifiedLeaderboardDefinition,
): VerifiedLeaderboardDefinition {
  if (existing === undefined) {
    return cloneDefinition(input);
  }

  if (existing.leaderboardId !== input.leaderboardId) {
    throw new Error('Devvit Redis leaderboard key digest collision detected.');
  }

  if (
    existing.scoreOrder !== input.scoreOrder
    || existing.attemptSelection !== input.attemptSelection
  ) {
    throw new Error(`Leaderboard definition conflict for ${JSON.stringify(input.leaderboardId)}.`);
  }

  return existing;
}

function assertAvailableAttemptMember(
  rankedAttempts: readonly RankedAttempt[],
  member: string,
  attempt: VerifiedLeaderboardAttempt,
): void {
  const existing = rankedAttempts.find((candidate) => candidate.member === member);

  if (existing !== undefined && existing.attempt.attemptId !== attempt.attemptId) {
    throw new Error('Devvit Redis attempt key digest collision detected.');
  }
}

function assertUniqueRetainedParticipants(
  rankedAttempts: readonly RankedAttempt[],
  entriesKey: string,
): void {
  const participantIds = new Set<string>();

  for (const { attempt } of rankedAttempts) {
    if (participantIds.has(attempt.participantId)) {
      throw new Error(`Devvit Redis contains duplicate retained participants for ${entriesKey}.`);
    }

    participantIds.add(attempt.participantId);
  }
}

function replaceRetainedAttempt(
  rankedAttempts: readonly RankedAttempt[],
  retainedAttempt: RankedAttempt | undefined,
  candidate: RankedAttempt,
): RankedAttempt[] {
  const remainingAttempts = rankedAttempts.filter((item) => item !== retainedAttempt);
  return [...remainingAttempts, candidate];
}

function createRecordResponse(
  definition: VerifiedLeaderboardDefinition,
  attempted: VerifiedLeaderboardAttempt,
  rankedAttempts: readonly RankedAttempt[],
): RecordVerifiedLeaderboardAttemptResponse {
  const entry = toRankedEntries(
    [...rankedAttempts].sort(
      (left, right) => compareAttempts(definition.scoreOrder, left.attempt, right.attempt),
    ),
  ).find((candidate) => candidate.participantId === attempted.participantId);

  if (entry === undefined) {
    throw new Error('Retained leaderboard entry was not found after recording an attempt.');
  }

  const retained = entry.attemptId === attempted.attemptId;
  const response: RecordVerifiedLeaderboardAttemptResponse = {
    recorded: true,
    alreadyProcessed: false,
    retained,
    entry,
    ...(retained ? {} : { reason: 'ATTEMPT_NOT_RETAINED' }),
  };
  assertRecordVerifiedLeaderboardAttemptResponse(response);
  return response;
}

function toRankedEntries(
  rankedAttempts: readonly RankedAttempt[],
): LeaderboardRankedEntry[] {
  return rankedAttempts.map(({ attempt }, index) => ({
    rank: index + 1,
    participantId: attempt.participantId,
    ...(attempt.participantLabel === undefined
      ? {}
      : { participantLabel: attempt.participantLabel }),
    attemptId: attempt.attemptId,
    score: attempt.score,
    ...(attempt.metrics === undefined
      ? {}
      : { metrics: normalizeVerifiedLeaderboardMetrics(attempt.metrics) }),
    completedAt: attempt.completedAt,
  }));
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

  return compareAttemptChronology(left, right);
}

function compareEntryToCursor(
  scoreOrder: VerifiedLeaderboardScoreOrder,
  entry: LeaderboardRankedEntry,
  cursor: ReturnType<typeof parseVerifiedLeaderboardCursor>,
): number {
  if (entry.score !== cursor.score) {
    const comparison = entry.score - cursor.score;
    return scoreOrder === 'ascending' ? comparison : -comparison;
  }

  const completedAtComparison = Date.parse(entry.completedAt) - cursor.completedAtMs;

  if (completedAtComparison !== 0) {
    return completedAtComparison;
  }

  return compareOrdinal(entry.attemptId, cursor.attemptId);
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function redisRankingScore(scoreOrder: VerifiedLeaderboardScoreOrder, score: number): number {
  return scoreOrder === 'ascending' ? score : -score;
}

function assertSameAttempt(
  existing: VerifiedLeaderboardAttempt,
  candidate: VerifiedLeaderboardAttempt,
): void {
  if (
    existing.participantId !== candidate.participantId
    || existing.attemptId !== candidate.attemptId
    || existing.score !== candidate.score
    || !areVerifiedLeaderboardMetricsEqual(existing.metrics, candidate.metrics)
    || Date.parse(existing.completedAt) !== Date.parse(candidate.completedAt)
    || existing.verification.authorityId !== candidate.verification.authorityId
    || existing.verification.evidenceId !== candidate.verification.evidenceId
    || Date.parse(existing.verification.verifiedAt)
      !== Date.parse(candidate.verification.verifiedAt)
  ) {
    throw new Error(`Attempt id conflict for ${JSON.stringify(candidate.attemptId)}.`);
  }
}

function serializeAttemptDecision(
  attempt: VerifiedLeaderboardAttempt,
  response: RecordVerifiedLeaderboardAttemptResponse,
): string {
  return JSON.stringify({ version: 1, attempt, response } satisfies StoredAttemptDecision);
}

function serializeRetainedAttempt(attempt: VerifiedLeaderboardAttempt): string {
  return JSON.stringify({ version: 1, attempt } satisfies StoredRetainedAttempt);
}

function parseStoredAttemptDecision(raw: string, key: string): StoredAttemptDecision {
  const parsed = parseJson(raw, key);
  assertStoredRecord(parsed, key);

  if (parsed.version !== 1) {
    throw new Error(`Unsupported Devvit Redis record version for ${key}.`);
  }

  assertVerifiedLeaderboardAttempt(parsed.attempt);
  assertRecordVerifiedLeaderboardAttemptResponse(parsed.response);
  return {
    version: 1,
    attempt: cloneAttempt(parsed.attempt),
    response: cloneRecordResponse(parsed.response, parsed.response.alreadyProcessed),
  };
}

function parseStoredRetainedAttempt(raw: string, key: string): StoredRetainedAttempt {
  const parsed = parseJson(raw, key);
  assertStoredRecord(parsed, key);

  if (parsed.version !== 1) {
    throw new Error(`Unsupported Devvit Redis record version for ${key}.`);
  }

  assertVerifiedLeaderboardAttempt(parsed.attempt);
  return { version: 1, attempt: cloneAttempt(parsed.attempt) };
}

function parseJson(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Devvit Redis JSON record for ${key}.`, { cause: error });
  }
}

function assertStoredRecord(
  input: unknown,
  key: string,
): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Invalid Devvit Redis record for ${key}.`);
  }
}

function cloneRecordRequest(
  input: RecordVerifiedLeaderboardAttemptRequest,
): RecordVerifiedLeaderboardAttemptRequest {
  return {
    definition: cloneDefinition(input.definition),
    attempt: cloneAttempt(input.attempt),
  };
}

function cloneDefinition(
  input: VerifiedLeaderboardDefinition,
): VerifiedLeaderboardDefinition {
  return {
    leaderboardId: input.leaderboardId,
    scoreOrder: input.scoreOrder,
    attemptSelection: input.attemptSelection,
  };
}

function cloneAttempt(input: VerifiedLeaderboardAttempt): VerifiedLeaderboardAttempt {
  return {
    participantId: input.participantId,
    ...(input.participantLabel === undefined
      ? {}
      : { participantLabel: input.participantLabel }),
    attemptId: input.attemptId,
    score: input.score,
    ...(input.metrics === undefined
      ? {}
      : { metrics: normalizeVerifiedLeaderboardMetrics(input.metrics) }),
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
      ...(input.entry.metrics === undefined
        ? {}
        : { metrics: normalizeVerifiedLeaderboardMetrics(input.entry.metrics) }),
      completedAt: input.entry.completedAt,
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  assertRecordVerifiedLeaderboardAttemptResponse(response);
  return response;
}

async function bestEffortReset(
  transaction: DevvitVerifiedLeaderboardRedisTransactionLike,
  multiStarted: boolean,
): Promise<void> {
  try {
    if (multiStarted) {
      await transaction.discard();
    } else {
      await transaction.unwatch();
    }
  } catch {
    // Preserve the original Redis failure; this cleanup is best-effort.
  }
}

function normalizeKeyPrefix(value: string | undefined): string {
  const keyPrefix = value ?? defaultKeyPrefix;

  if (!keyPrefixPattern.test(keyPrefix)) {
    throw new TypeError(
      'keyPrefix must contain 1 to 128 ASCII letters, digits, colons, underscores, or hyphens.',
    );
  }

  return keyPrefix;
}

function normalizeTransactionAttempts(value: number | undefined): number {
  const transactionAttempts = value ?? defaultTransactionAttempts;

  if (
    !Number.isSafeInteger(transactionAttempts)
    || transactionAttempts < 1
    || transactionAttempts > maximumTransactionAttempts
  ) {
    throw new TypeError(
      `transactionAttempts must be a safe integer from 1 to ${String(maximumTransactionAttempts)}.`,
    );
  }

  return transactionAttempts;
}

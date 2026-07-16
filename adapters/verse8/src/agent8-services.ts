import {
  areVerifiedLeaderboardMetricsEqual,
  assertGetVerifiedLeaderboardSnapshotRequest,
  assertRecordVerifiedLeaderboardAttemptRequest,
  assertRecordVerifiedLeaderboardAttemptResponse,
  assertVerifiedLeaderboardAttempt,
  assertVerifiedLeaderboardDefinition,
  assertVerifiedLeaderboardSnapshot,
  createVerifiedLeaderboardCursor,
  parseVerifiedLeaderboardCursor,
  type GetVerifiedLeaderboardSnapshotRequest,
  type LeaderboardRankedEntry,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardAttempt,
  type VerifiedLeaderboardDefinition,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshot,
} from '@mpgd/game-services/verified-leaderboard';
import type { StorageLoadResult } from '@mpgd/platform';

const defaultStorageStateNamespace = 'mpgdVerse8Storage';
const defaultLeaderboardCollectionNamespace = 'mpgdVerse8Leaderboard';
const defaultMaximumStorageEntries = 128;
const defaultMaximumStorageValueBytes = 64 * 1024;
const defaultMaximumStorageStateBytes = 512 * 1024;

export interface Verse8Agent8StateContext {
  getUserState(account: string): Promise<Readonly<Record<string, unknown>>>;
  updateUserState(
    account: string,
    state: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  lock<T>(key: string, callback: () => T | Promise<T>): Promise<T>;
}

export type Verse8Agent8QueryOperator =
  | '<'
  | '<='
  | '=='
  | '!='
  | '>='
  | '>'
  | 'array-contains'
  | 'in'
  | 'not-in'
  | 'array-contains-any';

export interface Verse8Agent8QueryFilter {
  readonly field: string;
  readonly operator: Verse8Agent8QueryOperator;
  readonly value: unknown;
}

export interface Verse8Agent8CollectionOptions {
  filters?: Verse8Agent8QueryFilter[];
  orderBy?: Array<{
    readonly field: string;
    readonly direction: 'asc' | 'desc';
  }>;
  limit?: number;
}

export interface Verse8Agent8CollectionItem extends Readonly<Record<string, unknown>> {
  readonly __id: string;
}

export interface Verse8Agent8ServiceContext extends Verse8Agent8StateContext {
  getCollectionItems(
    collectionId: string,
    options?: Verse8Agent8CollectionOptions,
  ): Promise<readonly Verse8Agent8CollectionItem[]>;
  addCollectionItem(
    collectionId: string,
    item: Readonly<Record<string, unknown>>,
  ): Promise<Verse8Agent8CollectionItem>;
  updateCollectionItem(
    collectionId: string,
    item: Readonly<Record<string, unknown>> & { readonly __id: string },
  ): Promise<Verse8Agent8CollectionItem>;
  countCollectionItems(
    collectionId: string,
    options?: Verse8Agent8CollectionOptions,
  ): Promise<number>;
}

export interface Verse8Agent8StorageOptions {
  readonly stateNamespace?: string;
  readonly maximumEntries?: number;
  readonly maximumValueBytes?: number;
  readonly maximumStateBytes?: number;
}

export interface Verse8Agent8StorageService {
  load(
    account: string,
    input: { readonly key: string },
    context: Pick<Verse8Agent8StateContext, 'getUserState'>,
  ): Promise<StorageLoadResult | null>;
  save(
    account: string,
    input: { readonly key: string; readonly value: unknown },
    context: Verse8Agent8StateContext,
  ): Promise<void>;
}

interface StoredStorageState {
  readonly version: 1;
  readonly values: Readonly<Record<string, unknown>>;
}

export function createVerse8Agent8StorageService(
  options: Verse8Agent8StorageOptions = {},
): Verse8Agent8StorageService {
  const namespace = normalizeNamespace(
    options.stateNamespace ?? defaultStorageStateNamespace,
    'stateNamespace',
  );
  const maximumEntries = positiveSafeInteger(
    options.maximumEntries ?? defaultMaximumStorageEntries,
    'maximumEntries',
  );
  const maximumValueBytes = positiveSafeInteger(
    options.maximumValueBytes ?? defaultMaximumStorageValueBytes,
    'maximumValueBytes',
  );
  const maximumStateBytes = positiveSafeInteger(
    options.maximumStateBytes ?? defaultMaximumStorageStateBytes,
    'maximumStateBytes',
  );

  if (maximumValueBytes > maximumStateBytes) {
    throw new Error('maximumValueBytes must not exceed maximumStateBytes.');
  }

  return {
    async load(account, input, context) {
      assertAccount(account);
      assertStorageKey(input.key);
      const userState = await context.getUserState(account);
      const state = readStorageState(userState[namespace]);
      const value = state.values[input.key];

      return value === undefined ? null : { value: cloneJsonValue(value) };
    },
    async save(account, input, context) {
      assertAccount(account);
      assertStorageKey(input.key);
      const value = cloneJsonValue(input.value);

      if (utf8ByteLength(JSON.stringify(value)) > maximumValueBytes) {
        throw new Error('Verse8 cloud save value exceeds maximumValueBytes.');
      }

      await context.lock(storageLockKey(account), async () => {
        const userState = await context.getUserState(account);
        const state = readStorageState(userState[namespace]);
        const isNewKey = state.values[input.key] === undefined;

        if (isNewKey && Object.keys(state.values).length >= maximumEntries) {
          throw new Error('Verse8 cloud save exceeds maximumEntries.');
        }

        const next = {
          version: 1,
          values: {
            ...state.values,
            [input.key]: value,
          },
        } satisfies StoredStorageState;

        if (utf8ByteLength(JSON.stringify(next)) > maximumStateBytes) {
          throw new Error('Verse8 cloud save state exceeds maximumStateBytes.');
        }

        await context.updateUserState(account, { [namespace]: next });
      });
    },
  };
}

export interface Verse8Agent8VerifiedLeaderboardOptions {
  readonly collectionNamespace?: string;
  readonly now?: () => string;
}

export type Verse8Agent8LeaderboardPageRequest = Omit<
  GetVerifiedLeaderboardSnapshotRequest,
  'participantId'
>;

export interface Verse8Agent8LeaderboardVerificationInput<TSubmission> {
  readonly account: string;
  readonly submission: TSubmission;
}

export type Verse8Agent8LeaderboardBoundaryOptions<TSubmission> =
  Verse8Agent8VerifiedLeaderboardOptions & {
  readonly context: Verse8Agent8ServiceContext;
  readonly verifySubmission: (
    input: Verse8Agent8LeaderboardVerificationInput<TSubmission>,
  ) => Promise<RecordVerifiedLeaderboardAttemptRequest | null>;
};

export type Verse8Agent8LeaderboardSubmissionResult =
  | {
      readonly accepted: true;
      readonly record: RecordVerifiedLeaderboardAttemptResponse;
    }
  | {
      readonly accepted: false;
      readonly reason: 'VERIFICATION_REJECTED';
    };

export interface Verse8Agent8LeaderboardBoundary<TSubmission> {
  submit(
    account: string,
    submission: TSubmission,
  ): Promise<Verse8Agent8LeaderboardSubmissionResult>;
  getSnapshot(
    account: string,
    input: Verse8Agent8LeaderboardPageRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined>;
}

export function createVerse8Agent8LeaderboardBoundary<TSubmission>(
  options: Verse8Agent8LeaderboardBoundaryOptions<TSubmission>,
): Verse8Agent8LeaderboardBoundary<TSubmission> {
  const provider = createVerse8Agent8VerifiedLeaderboardProvider(options.context, options);

  return {
    async submit(account, submission) {
      assertAccount(account);
      const verified = await options.verifySubmission({ account, submission });

      if (verified === null) {
        return {
          accepted: false,
          reason: 'VERIFICATION_REJECTED',
        };
      }

      assertRecordVerifiedLeaderboardAttemptRequest(verified);

      if (verified.attempt.participantId !== account) {
        throw new Error('Verified leaderboard participant must match the authenticated account.');
      }

      return {
        accepted: true,
        record: await provider.recordVerifiedAttempt(verified),
      };
    },
    getSnapshot(account, input) {
      assertAccount(account);

      return provider.getSnapshot({
        ...input,
        participantId: account,
      });
    },
  };
}

interface LeaderboardCollections {
  readonly definitions: string;
  readonly attempts: string;
  readonly entries: string;
}

interface StoredDefinition {
  readonly itemId: string;
  readonly definition: VerifiedLeaderboardDefinition;
}

interface StoredEntry {
  readonly itemId: string;
  readonly leaderboardId: string;
  readonly sortKey: string;
  readonly attempt: VerifiedLeaderboardAttempt;
}

interface StoredAttemptDecision {
  readonly attempt: VerifiedLeaderboardAttempt;
  readonly response: RecordVerifiedLeaderboardAttemptResponse;
}

export function createVerse8Agent8VerifiedLeaderboardProvider(
  context: Verse8Agent8ServiceContext,
  options: Verse8Agent8VerifiedLeaderboardOptions = {},
): VerifiedLeaderboardService {
  const namespace = normalizeNamespace(
    options.collectionNamespace ?? defaultLeaderboardCollectionNamespace,
    'collectionNamespace',
  );
  const collections = createLeaderboardCollections(namespace);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async recordVerifiedAttempt(input) {
      assertRecordVerifiedLeaderboardAttemptRequest(input);
      const definition = cloneDefinition(input.definition);
      const attempt = cloneAttempt(input.attempt);

      return context.lock(leaderboardLockKey(definition.leaderboardId), async () => {
        await ensureDefinition(context, collections, definition);
        const existingDecision = await loadAttemptDecision(
          context,
          collections,
          definition.leaderboardId,
          attempt.attemptId,
        );

        if (existingDecision !== undefined) {
          assertSameAttempt(existingDecision.attempt, attempt);
          return cloneRecordResponse(existingDecision.response, true);
        }

        const orphanedAttemptEntry = await loadUniqueEntry(
          context,
          collections,
          definition,
          'attemptId',
          attempt.attemptId,
        );

        if (orphanedAttemptEntry !== undefined) {
          assertSameAttempt(orphanedAttemptEntry.attempt, attempt);
        }

        const retained = await loadUniqueEntry(
          context,
          collections,
          definition,
          'participantId',
          attempt.participantId,
        );

        if (retained === undefined) {
          await context.addCollectionItem(
            collections.entries,
            createEntryItem(definition, attempt),
          );
        } else if (shouldReplaceRetainedAttempt(definition, retained.attempt, attempt)) {
          await context.updateCollectionItem(collections.entries, {
            __id: retained.itemId,
            ...createEntryItem(definition, attempt),
          });
        }

        const current = await loadUniqueEntry(
          context,
          collections,
          definition,
          'participantId',
          attempt.participantId,
        );

        if (current === undefined) {
          throw new Error('Retained Verse8 leaderboard entry was not found after recording.');
        }

        const entry = await createRankedEntry(context, collections, definition, current);
        const attemptRetained = current.attempt.attemptId === attempt.attemptId;
        const response = {
          recorded: true,
          alreadyProcessed: false,
          retained: attemptRetained,
          entry,
          ...(attemptRetained ? {} : { reason: 'ATTEMPT_NOT_RETAINED' as const }),
        } satisfies RecordVerifiedLeaderboardAttemptResponse;
        assertRecordVerifiedLeaderboardAttemptResponse(response);

        await context.addCollectionItem(collections.attempts, {
          leaderboardId: definition.leaderboardId,
          attemptId: attempt.attemptId,
          attempt,
          response,
        });

        return cloneRecordResponse(response, false);
      });
    },
    async getSnapshot(input) {
      assertGetVerifiedLeaderboardSnapshotRequest(input);

      return context.lock(leaderboardLockKey(input.leaderboardId), async () => {
        const storedDefinition = await loadDefinition(
          context,
          collections,
          input.leaderboardId,
        );

        if (storedDefinition === undefined) {
          return undefined;
        }

        const definition = storedDefinition.definition;
        const limit = input.limit ?? 10;
        const cursorPosition = input.cursor === undefined
          ? undefined
          : parseVerifiedLeaderboardCursor(input.cursor, definition);
        const cursorSortKey = cursorPosition === undefined
          ? undefined
          : createLeaderboardSortKey(
              definition,
              cursorPosition.score,
              cursorPosition.completedAtMs,
              cursorPosition.attemptId,
            );
        const pageItems = await context.getCollectionItems(collections.entries, {
          filters: [
            equalityFilter('leaderboardId', definition.leaderboardId),
            ...(cursorSortKey === undefined
              ? []
              : [{ field: 'sortKey', operator: '>' as const, value: cursorSortKey }]),
          ],
          orderBy: [{ field: 'sortKey', direction: 'asc' }],
          limit: limit + 1,
        });
        const parsedPage = pageItems.map((item) => readEntry(item, definition));
        const retainedPage = parsedPage.slice(0, limit);
        const totalParticipants = await countEntries(context, collections, definition);
        const pageOffset = retainedPage[0] === undefined
          ? totalParticipants
          : await countEntriesBefore(
              context,
              collections,
              definition,
              retainedPage[0].sortKey,
            );
        const entries = retainedPage.map((entry, index) =>
          toRankedEntry(entry.attempt, pageOffset + index + 1),
        );
        const participantEntry = input.participantId === undefined
          ? undefined
          : await loadParticipantRankedEntry(
              context,
              collections,
              definition,
              input.participantId,
            );
        const lastEntry = entries.at(-1);
        const nextCursor = parsedPage.length > limit && lastEntry !== undefined
          ? createVerifiedLeaderboardCursor(definition, lastEntry)
          : undefined;
        const snapshot = {
          definition: cloneDefinition(definition),
          entries,
          ...(participantEntry === undefined ? {} : { participantEntry }),
          totalParticipants,
          generatedAt: now(),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        } satisfies VerifiedLeaderboardSnapshot;
        assertVerifiedLeaderboardSnapshot(snapshot);
        return snapshot;
      });
    },
  };
}

function createLeaderboardCollections(namespace: string): LeaderboardCollections {
  return {
    definitions: `${namespace}Definitions`,
    attempts: `${namespace}Attempts`,
    entries: `${namespace}Entries`,
  };
}

async function ensureDefinition(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
): Promise<void> {
  const existing = await loadDefinition(context, collections, definition.leaderboardId);

  if (existing === undefined) {
    await context.addCollectionItem(collections.definitions, { ...definition });
    return;
  }

  if (
    existing.definition.scoreOrder !== definition.scoreOrder
    || existing.definition.attemptSelection !== definition.attemptSelection
  ) {
    throw new Error(
      `Leaderboard definition conflict for ${JSON.stringify(definition.leaderboardId)}.`,
    );
  }
}

async function loadDefinition(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  leaderboardId: string,
): Promise<StoredDefinition | undefined> {
  const item = await loadUniqueCollectionItem(
    context,
    collections.definitions,
    [equalityFilter('leaderboardId', leaderboardId)],
    'Verse8 leaderboard definition',
  );

  if (item === undefined) {
    return undefined;
  }

  const definition: unknown = {
    leaderboardId: item.leaderboardId,
    scoreOrder: item.scoreOrder,
    attemptSelection: item.attemptSelection,
  };
  assertVerifiedLeaderboardDefinition(definition);

  return {
    itemId: item.__id,
    definition: cloneDefinition(definition),
  };
}

async function loadAttemptDecision(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  leaderboardId: string,
  attemptId: string,
): Promise<StoredAttemptDecision | undefined> {
  const filters = [
    equalityFilter('leaderboardId', leaderboardId),
    equalityFilter('attemptId', attemptId),
  ];
  const item = await loadUniqueCollectionItem(
    context,
    collections.attempts,
    filters,
    'Verse8 leaderboard attempt decision',
  );

  if (item === undefined) {
    return undefined;
  }

  if (item.leaderboardId !== leaderboardId || item.attemptId !== attemptId) {
    throw new Error('Stored Verse8 leaderboard attempt decision is invalid.');
  }

  const attempt = cloneAttempt(item.attempt);
  assertRecordVerifiedLeaderboardAttemptResponse(item.response);
  assertStoredAttemptDecision(attempt, item.response);

  return {
    attempt,
    response: cloneRecordResponse(item.response, item.response.alreadyProcessed),
  };
}

async function loadUniqueEntry(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  field: 'attemptId' | 'participantId',
  value: string,
): Promise<StoredEntry | undefined> {
  const filters = [
    equalityFilter('leaderboardId', definition.leaderboardId),
    equalityFilter(field, value),
  ];
  const item = await loadUniqueCollectionItem(
    context,
    collections.entries,
    filters,
    'Verse8 retained leaderboard entry',
  );

  return item === undefined ? undefined : readEntry(item, definition);
}

async function loadUniqueCollectionItem(
  context: Verse8Agent8ServiceContext,
  collectionId: string,
  filters: readonly Verse8Agent8QueryFilter[],
  label: string,
): Promise<Verse8Agent8CollectionItem | undefined> {
  const items = await context.getCollectionItems(collectionId, {
    filters: [...filters],
    limit: 2,
  });

  if (items.length > 1) {
    throw new Error(`${label} is duplicated.`);
  }

  if (items[0] !== undefined && (typeof items[0].__id !== 'string' || items[0].__id.length === 0)) {
    throw new Error(`${label} has an invalid item ID.`);
  }

  return items[0];
}

function readEntry(
  item: Verse8Agent8CollectionItem,
  definition: VerifiedLeaderboardDefinition,
): StoredEntry {
  if (
    typeof item.leaderboardId !== 'string'
    || typeof item.sortKey !== 'string'
    || item.sortKey.length === 0
  ) {
    throw new Error('Stored Verse8 leaderboard entry is invalid.');
  }

  const attempt = cloneAttempt(item.attempt);

  if (attempt.participantId !== item.participantId || attempt.attemptId !== item.attemptId) {
    throw new Error('Stored Verse8 leaderboard entry is invalid.');
  }

  const expectedSortKey = createLeaderboardSortKey(
    definition,
    attempt.score,
    Date.parse(attempt.completedAt),
    attempt.attemptId,
  );

  if (item.leaderboardId !== definition.leaderboardId || item.sortKey !== expectedSortKey) {
    throw new Error('Stored Verse8 leaderboard entry is invalid.');
  }

  return {
    itemId: item.__id,
    leaderboardId: item.leaderboardId,
    sortKey: item.sortKey,
    attempt,
  };
}

function createEntryItem(
  definition: VerifiedLeaderboardDefinition,
  attempt: VerifiedLeaderboardAttempt,
): Readonly<Record<string, unknown>> {
  return {
    leaderboardId: definition.leaderboardId,
    participantId: attempt.participantId,
    attemptId: attempt.attemptId,
    sortKey: createLeaderboardSortKey(
      definition,
      attempt.score,
      Date.parse(attempt.completedAt),
      attempt.attemptId,
    ),
    attempt: cloneAttempt(attempt),
  };
}

async function createRankedEntry(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  entry: StoredEntry,
): Promise<LeaderboardRankedEntry> {
  const rank = (await countEntriesBefore(context, collections, definition, entry.sortKey)) + 1;

  return toRankedEntry(entry.attempt, rank);
}

async function loadParticipantRankedEntry(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  participantId: string,
): Promise<LeaderboardRankedEntry | undefined> {
  const entry = await loadUniqueEntry(
    context,
    collections,
    definition,
    'participantId',
    participantId,
  );

  if (entry === undefined) {
    return undefined;
  }

  const rank = (await countEntriesBefore(context, collections, definition, entry.sortKey)) + 1;
  return toRankedEntry(entry.attempt, rank);
}

function countEntries(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
): Promise<number> {
  return context.countCollectionItems(collections.entries, {
    filters: [equalityFilter('leaderboardId', definition.leaderboardId)],
  });
}

function countEntriesBefore(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  sortKey: string,
): Promise<number> {
  return context.countCollectionItems(collections.entries, {
    filters: [
      equalityFilter('leaderboardId', definition.leaderboardId),
      { field: 'sortKey', operator: '<', value: sortKey },
    ],
  });
}

function equalityFilter(field: string, value: unknown): Verse8Agent8QueryFilter {
  return { field, operator: '==', value };
}

function createLeaderboardSortKey(
  definition: VerifiedLeaderboardDefinition,
  score: number,
  completedAtMs: number,
  attemptId: string,
): string {
  return [
    sortableNumber(score, definition.scoreOrder === 'descending'),
    sortableNumber(completedAtMs, false),
    sortableOrdinal(attemptId),
  ].join(':');
}

function sortableNumber(value: number, descending: boolean): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  const bytes = new Uint8Array(buffer);

  if ((bytes[0] as number) >= 0x80) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = 0xff - (bytes[index] as number);
    }
  } else {
    bytes[0] = (bytes[0] as number) ^ 0x80;
  }

  if (descending) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = 0xff - (bytes[index] as number);
    }
  }

  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sortableOrdinal(value: string): string {
  let encoded = '';

  for (let index = 0; index < value.length; index += 1) {
    encoded += (value.charCodeAt(index) + 1).toString(16).padStart(5, '0');
  }

  return `${encoded}00000`;
}

function shouldReplaceRetainedAttempt(
  definition: VerifiedLeaderboardDefinition,
  retained: VerifiedLeaderboardAttempt,
  candidate: VerifiedLeaderboardAttempt,
): boolean {
  if (definition.attemptSelection === 'first') {
    return compareAttemptChronology(candidate, retained) < 0;
  }

  return compareLeaderboardOrder(definition.scoreOrder, candidate, retained) < 0;
}

function compareAttemptChronology(
  left: VerifiedLeaderboardAttempt,
  right: VerifiedLeaderboardAttempt,
): number {
  const timestampDifference = Date.parse(left.completedAt) - Date.parse(right.completedAt);
  return timestampDifference === 0
    ? compareOrdinal(left.attemptId, right.attemptId)
    : timestampDifference;
}

function compareLeaderboardOrder(
  scoreOrder: VerifiedLeaderboardDefinition['scoreOrder'],
  left: VerifiedLeaderboardAttempt,
  right: VerifiedLeaderboardAttempt,
): number {
  if (left.score !== right.score) {
    return scoreOrder === 'ascending' ? left.score - right.score : right.score - left.score;
  }

  return compareAttemptChronology(left, right);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRankedEntry(
  attempt: VerifiedLeaderboardAttempt,
  rank: number,
): LeaderboardRankedEntry {
  return {
    rank,
    participantId: attempt.participantId,
    ...(attempt.participantLabel === undefined
      ? {}
      : { participantLabel: attempt.participantLabel }),
    attemptId: attempt.attemptId,
    score: attempt.score,
    ...(attempt.metrics === undefined ? {} : { metrics: { ...attempt.metrics } }),
    completedAt: attempt.completedAt,
  };
}

function cloneDefinition(input: VerifiedLeaderboardDefinition): VerifiedLeaderboardDefinition {
  return {
    leaderboardId: input.leaderboardId,
    scoreOrder: input.scoreOrder,
    attemptSelection: input.attemptSelection,
  };
}

function cloneAttempt(input: unknown): VerifiedLeaderboardAttempt {
  assertVerifiedLeaderboardAttempt(input);
  const attempt = input;

  return {
    participantId: attempt.participantId,
    ...(attempt.participantLabel === undefined
      ? {}
      : { participantLabel: attempt.participantLabel }),
    attemptId: attempt.attemptId,
    score: attempt.score,
    ...(attempt.metrics === undefined ? {} : { metrics: { ...attempt.metrics } }),
    completedAt: attempt.completedAt,
    verification: { ...attempt.verification },
  };
}

function cloneRecordResponse(
  input: RecordVerifiedLeaderboardAttemptResponse,
  alreadyProcessed: boolean,
): RecordVerifiedLeaderboardAttemptResponse {
  const response = {
    recorded: true,
    alreadyProcessed,
    retained: input.retained,
    entry: {
      ...input.entry,
      ...(input.entry.metrics === undefined ? {} : { metrics: { ...input.entry.metrics } }),
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  } satisfies RecordVerifiedLeaderboardAttemptResponse;
  assertRecordVerifiedLeaderboardAttemptResponse(response);
  return response;
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

function assertStoredAttemptDecision(
  attempt: VerifiedLeaderboardAttempt,
  response: RecordVerifiedLeaderboardAttemptResponse,
): void {
  if (
    response.alreadyProcessed
    || response.entry.participantId !== attempt.participantId
    || (response.retained && (
      response.entry.attemptId !== attempt.attemptId
      || response.entry.score !== attempt.score
      || !areVerifiedLeaderboardMetricsEqual(response.entry.metrics, attempt.metrics)
      || Date.parse(response.entry.completedAt) !== Date.parse(attempt.completedAt)
    ))
    || (!response.retained && response.entry.attemptId === attempt.attemptId)
  ) {
    throw new Error('Stored Verse8 leaderboard attempt decision is invalid.');
  }
}

function readStorageState(value: unknown): StoredStorageState {
  if (value === undefined) {
    return { version: 1, values: {} };
  }

  if (!isRecord(value) || value.version !== 1 || !isRecord(value.values)) {
    throw new Error('Stored Verse8 cloud save state is invalid.');
  }

  const values: Record<string, unknown> = {};

  for (const [key, storedValue] of Object.entries(value.values)) {
    assertStorageKey(key);
    values[key] = cloneJsonValue(storedValue);
  }

  return { version: 1, values };
}

function cloneJsonValue(input: unknown): unknown {
  assertJsonValue(input, new Set<object>(), 0);
  const serialized = JSON.stringify(input);

  if (serialized === undefined) {
    throw new Error('Verse8 cloud save values must be JSON-compatible.');
  }

  return JSON.parse(serialized) as unknown;
}

function assertJsonValue(input: unknown, seen: Set<object>, depth: number): void {
  if (depth > 64) {
    throw new Error('Verse8 cloud save value exceeds the maximum nesting depth.');
  }

  if (
    input === null
    || typeof input === 'boolean'
    || (typeof input === 'number' && Number.isFinite(input))
  ) {
    return;
  }

  if (typeof input === 'string') {
    if (!isWellFormedUnicode(input)) {
      throw new Error('Verse8 cloud save strings must contain well-formed Unicode.');
    }

    return;
  }

  if (typeof input !== 'object' || seen.has(input)) {
    throw new Error('Verse8 cloud save values must be acyclic JSON data.');
  }

  seen.add(input);

  if (Array.isArray(input)) {
    for (const value of input) {
      assertJsonValue(value, seen, depth + 1);
    }
  } else {
    const prototype = Object.getPrototypeOf(input) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Verse8 cloud save values must use plain JSON objects.');
    }

    for (const [key, value] of Object.entries(input)) {
      if (!isWellFormedUnicode(key)) {
        throw new Error('Verse8 cloud save object keys must contain well-formed Unicode.');
      }

      assertJsonValue(value, seen, depth + 1);
    }
  }

  seen.delete(input);
}

function utf8ByteLength(input: string): number {
  let bytes = 0;

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function normalizeNamespace(value: string, label: string): string {
  const normalized = value.trim();

  if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(normalized)) {
    throw new Error(`${label} must be a safe non-empty Agent8 identifier.`);
  }

  return normalized;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}

function assertAccount(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new Error('account must be a canonical bounded string.');
  }
}

function assertStorageKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || !isWellFormedUnicode(value)
    || value === '__proto__'
    || value === 'constructor'
    || value === 'prototype'
  ) {
    throw new Error('Verse8 cloud save key must be bounded well-formed Unicode.');
  }
}

function isWellFormedUnicode(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);

      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }

      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function storageLockKey(account: string): string {
  return `mpgd:verse8:storage:${stableLockDigest(account)}`;
}

function leaderboardLockKey(leaderboardId: string): string {
  return `mpgd:verse8:leaderboard:${stableLockDigest(leaderboardId)}`;
}

function stableLockDigest(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    first = Math.imul(first ^ codeUnit, 0x01000193);
    second = Math.imul(second ^ codeUnit, 0x85ebca6b);
  }

  return [first, second]
    .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

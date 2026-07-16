import {
  assertGetVerifiedLeaderboardSnapshotRequest,
  assertLeaderboardRankedEntry,
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
  type VerifiedLeaderboardCursorPosition,
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
const defaultMaximumLeaderboardParticipants = 1_000;
const maximumLeaderboardParticipantsLimit = 10_000;
const minimumPersistenceSecretBytes = 32;
const maximumPersistenceSecretBytes = 1_024;
const sha256DigestPattern = /^[0-9a-f]{64}$/;
const sha256RoundConstants = Uint32Array.from(
  (
    '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 '
    + 'd807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 '
    + 'e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da '
    + '983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 '
    + '27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 '
    + 'a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 '
    + '19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 '
    + '748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'
  ).split(' '),
  (value) => Number.parseInt(value, 16),
);

export interface Verse8Agent8StateContext {
  getUserState(account: string): Promise<Readonly<Record<string, unknown>>>;
  updateUserState(
    account: string,
    state: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  lock<T>(key: string, callback: () => T | Promise<T>): Promise<T>;
}

export interface Verse8Agent8CollectionOptions {
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
}

export interface Verse8Agent8StorageOptions {
  readonly persistenceSecret: string;
  readonly codec: Verse8Agent8PrivateStorageCodec;
  readonly stateNamespace?: string;
  readonly maximumEntries?: number;
  readonly maximumValueBytes?: number;
  readonly maximumStateBytes?: number;
}

export interface Verse8Agent8PrivateStorageEnvelope {
  readonly keyId: string;
  readonly ciphertext: string;
}

export interface Verse8Agent8PrivateStorageCodec {
  readonly security: 'authenticated-encryption';
  seal(input: {
    readonly account: string;
    readonly key: string;
    readonly value: unknown;
  }): Promise<Verse8Agent8PrivateStorageEnvelope>;
  open(input: {
    readonly account: string;
    readonly key: string;
    readonly envelope: Verse8Agent8PrivateStorageEnvelope;
  }): Promise<unknown>;
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
  readonly version: 2;
  readonly values: Readonly<Record<string, Verse8Agent8PrivateStorageEnvelope>>;
}

export function createVerse8Agent8StorageService(
  options: Verse8Agent8StorageOptions,
): Verse8Agent8StorageService {
  if (!isRecord(options)) {
    throw new Error('Verse8 Agent8 storage options are required.');
  }

  assertPrivateStorageCodec(options.codec);
  const persistenceKey = readPersistenceSecret(options.persistenceSecret, 'persistenceSecret');
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
      assertStorageStateSize(state, maximumStateBytes);
      assertStorageEntryCount(state, maximumEntries);
      const storageKey = createPrivateStorageKey(persistenceKey, account, input.key);

      if (!Object.hasOwn(state.values, storageKey)) {
        return null;
      }

      const envelope = state.values[storageKey];

      if (envelope === undefined) {
        throw new Error('Stored Verse8 cloud save state is invalid.');
      }

      const value = cloneJsonValue(await options.codec.open({
        account,
        key: input.key,
        envelope: cloneStorageEnvelope(envelope),
      }));

      if (utf8Bytes(JSON.stringify(value)).length > maximumValueBytes) {
        throw new Error('Decrypted Verse8 cloud save value exceeds maximumValueBytes.');
      }

      return { value };
    },
    async save(account, input, context) {
      assertAccount(account);
      assertStorageKey(input.key);
      const value = cloneJsonValue(input.value);

      if (utf8Bytes(JSON.stringify(value)).length > maximumValueBytes) {
        throw new Error('Verse8 cloud save value exceeds maximumValueBytes.');
      }

      const storageKey = createPrivateStorageKey(persistenceKey, account, input.key);
      const envelope = readStorageEnvelope(await options.codec.seal({
        account,
        key: input.key,
        value: cloneJsonValue(value),
      }));

      if (utf8Bytes(JSON.stringify(envelope)).length > maximumStateBytes) {
        throw new Error('Encrypted Verse8 cloud save value exceeds maximumStateBytes.');
      }

      await context.lock(storageLockKey(account), async () => {
        const userState = await context.getUserState(account);
        const state = readStorageState(userState[namespace]);
        assertStorageStateSize(state, maximumStateBytes);
        assertStorageEntryCount(state, maximumEntries);
        const isNewKey = !Object.hasOwn(state.values, storageKey);

        if (isNewKey && Object.keys(state.values).length >= maximumEntries) {
          throw new Error('Verse8 cloud save exceeds maximumEntries.');
        }

        const next = {
          version: 2,
          values: {
            ...state.values,
            [storageKey]: envelope,
          },
        } satisfies StoredStorageState;

        if (utf8Bytes(JSON.stringify(next)).length > maximumStateBytes) {
          throw new Error('Verse8 cloud save state exceeds maximumStateBytes.');
        }

        await context.updateUserState(account, { [namespace]: next });
      });
    },
  };
}

export interface Verse8Agent8VerifiedLeaderboardOptions {
  readonly persistenceSecret: string;
  readonly collectionNamespace?: string;
  readonly maximumParticipants?: number;
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
  readonly leaderboardId: string;
  readonly definitions: string;
  readonly entries: string;
}

type StoredLeaderboardAttempt = Omit<VerifiedLeaderboardAttempt, 'verification'>;

interface StoredEntry {
  readonly itemId: string;
  readonly attemptDigest: string;
  readonly attempt: StoredLeaderboardAttempt;
  readonly pendingDecision?: StoredAttemptDecision;
}

interface StoredAttemptDecision {
  readonly attemptDigest: string;
  readonly response: RecordVerifiedLeaderboardAttemptResponse;
}

export function createVerse8Agent8VerifiedLeaderboardProvider(
  context: Verse8Agent8ServiceContext,
  options: Verse8Agent8VerifiedLeaderboardOptions,
): VerifiedLeaderboardService {
  if (!isRecord(options)) {
    throw new Error('Verse8 Agent8 leaderboard options are required.');
  }

  const persistenceKey = readPersistenceSecret(options.persistenceSecret, 'persistenceSecret');
  const namespace = normalizeNamespace(
    options.collectionNamespace ?? defaultLeaderboardCollectionNamespace,
    'collectionNamespace',
  );
  const maximumParticipants = positiveSafeInteger(
    options.maximumParticipants ?? defaultMaximumLeaderboardParticipants,
    'maximumParticipants',
  );

  if (maximumParticipants > maximumLeaderboardParticipantsLimit) {
    throw new Error(
      `maximumParticipants must not exceed ${String(maximumLeaderboardParticipantsLimit)}.`,
    );
  }

  const now = options.now ?? (() => new Date().toISOString());

  return {
    async recordVerifiedAttempt(input) {
      assertRecordVerifiedLeaderboardAttemptRequest(input);
      const definition = cloneDefinition(input.definition);
      const attempt = cloneAttempt(input.attempt);
      const attemptDigest = createAttemptDigest(persistenceKey, attempt);
      const collections = createLeaderboardCollections(namespace, definition.leaderboardId);
      const decisionCollection = createAttemptDecisionCollection(
        namespace,
        definition.leaderboardId,
        attempt.attemptId,
        persistenceKey,
      );

      return context.lock(leaderboardLockKey(definition.leaderboardId), async () => {
        await ensureDefinition(context, collections, definition);
        const loadedEntries = await loadEntries(
          context,
          collections,
          definition,
          maximumParticipants,
        );
        const entries = await flushPendingEntryDecisions(
          context,
          namespace,
          collections,
          definition,
          loadedEntries,
          persistenceKey,
        );
        const existingDecision = await loadAttemptDecision(
          context,
          decisionCollection,
          attempt,
          attemptDigest,
        );

        if (existingDecision !== undefined) {
          return cloneRecordResponse(existingDecision.response, true);
        }

        const orphanedAttemptEntry = entries.find(
          (entry) => entry.attempt.attemptId === attempt.attemptId,
        );

        if (
          orphanedAttemptEntry !== undefined
          && orphanedAttemptEntry.attemptDigest !== attemptDigest
        ) {
          throw attemptConflict(attempt.attemptId);
        }

        const retained = entries.find(
          (entry) => entry.attempt.participantId === attempt.participantId,
        );
        let nextEntries: readonly StoredEntry[];

        if (retained === undefined) {
          if (entries.length >= maximumParticipants) {
            throw new Error('Verse8 leaderboard exceeds maximumParticipants.');
          }

          nextEntries = [...entries, createStoredEntry('', attempt, attemptDigest)];
        } else if (shouldReplaceRetainedAttempt(definition, retained.attempt, attempt)) {
          const nextEntry = createStoredEntry(retained.itemId, attempt, attemptDigest);
          nextEntries = entries.map((entry) =>
            entry.itemId === retained.itemId ? nextEntry : entry,
          );
        } else {
          nextEntries = entries;
        }

        const rankedEntries = rankEntries(definition, nextEntries);
        const current = rankedEntries.find(
          (entry) => entry.participantId === attempt.participantId,
        );

        if (current === undefined) {
          throw new Error('Retained Verse8 leaderboard entry was not found after recording.');
        }

        const attemptRetained = current.attemptId === attempt.attemptId;
        const response = {
          recorded: true,
          alreadyProcessed: false,
          retained: attemptRetained,
          entry: current,
          ...(attemptRetained ? {} : { reason: 'ATTEMPT_NOT_RETAINED' as const }),
        } satisfies RecordVerifiedLeaderboardAttemptResponse;
        assertRecordVerifiedLeaderboardAttemptResponse(response);

        const pendingDecision = {
          attemptDigest,
          response: cloneRecordResponse(response, false),
        } satisfies StoredAttemptDecision;

        if (attemptRetained) {
          let retainedItemId: string;

          if (retained === undefined) {
            const added = await context.addCollectionItem(
              collections.entries,
              createEntryItem(attempt, attemptDigest, pendingDecision),
            );
            retainedItemId = readItemId(added, 'Verse8 retained leaderboard entry');
          } else {
            retainedItemId = retained.itemId;
            await context.updateCollectionItem(collections.entries, {
              __id: retainedItemId,
              ...createEntryItem(attempt, attemptDigest, pendingDecision),
            });
          }

          await ensureAttemptDecision(
            context,
            decisionCollection,
            attempt,
            pendingDecision,
          );
          await context.updateCollectionItem(collections.entries, {
            __id: retainedItemId,
            ...createEntryItem(attempt, attemptDigest),
          });
        } else {
          await ensureAttemptDecision(
            context,
            decisionCollection,
            attempt,
            pendingDecision,
          );
        }

        return cloneRecordResponse(response, false);
      });
    },
    async getSnapshot(input) {
      assertGetVerifiedLeaderboardSnapshotRequest(input);
      const collections = createLeaderboardCollections(namespace, input.leaderboardId);

      return context.lock(leaderboardLockKey(input.leaderboardId), async () => {
        const definition = await loadDefinition(context, collections);

        if (definition === undefined) {
          return undefined;
        }

        const loadedEntries = await loadEntries(
          context,
          collections,
          definition,
          maximumParticipants,
        );
        const entries = await flushPendingEntryDecisions(
          context,
          namespace,
          collections,
          definition,
          loadedEntries,
          persistenceKey,
        );
        const rankedEntries = rankEntries(definition, entries);
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
        const pageEntries = rankedEntries.slice(pageStart, pageEnd);
        const participantEntry = input.participantId === undefined
          ? undefined
          : rankedEntries.find((entry) => entry.participantId === input.participantId);
        const lastEntry = pageEntries.at(-1);
        const nextCursor = lastEntry !== undefined && pageEnd < rankedEntries.length
          ? createVerifiedLeaderboardCursor(definition, lastEntry)
          : undefined;
        const snapshot = {
          definition: cloneDefinition(definition),
          entries: pageEntries,
          ...(participantEntry === undefined ? {} : { participantEntry }),
          totalParticipants: rankedEntries.length,
          generatedAt: now(),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        } satisfies VerifiedLeaderboardSnapshot;
        assertVerifiedLeaderboardSnapshot(snapshot);
        return snapshot;
      });
    },
  };
}

function createLeaderboardCollections(
  namespace: string,
  leaderboardId: string,
): LeaderboardCollections {
  const boardDigest = sha256(JSON.stringify(['board', leaderboardId]));

  return {
    leaderboardId,
    definitions: `${namespace}D${boardDigest}`,
    entries: `${namespace}E${boardDigest}`,
  };
}

function createAttemptDecisionCollection(
  namespace: string,
  leaderboardId: string,
  attemptId: string,
  persistenceKey: Uint8Array,
): string {
  const decisionDigest = hmacSha256(
    persistenceKey,
    JSON.stringify(['attempt-decision', leaderboardId, attemptId]),
  );
  return `${namespace}A${decisionDigest}`;
}

async function ensureDefinition(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
): Promise<void> {
  const existing = await loadDefinition(context, collections);

  if (existing === undefined) {
    await context.addCollectionItem(collections.definitions, { ...definition });
    return;
  }

  if (
    existing.scoreOrder !== definition.scoreOrder
    || existing.attemptSelection !== definition.attemptSelection
  ) {
    throw new Error(
      `Leaderboard definition conflict for ${JSON.stringify(definition.leaderboardId)}.`,
    );
  }
}

async function loadDefinition(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
): Promise<VerifiedLeaderboardDefinition | undefined> {
  const item = await loadSingleCollectionItem(
    context,
    collections.definitions,
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

  if (definition.leaderboardId !== collections.leaderboardId) {
    throw new Error('Stored Verse8 leaderboard definition is invalid.');
  }

  return cloneDefinition(definition);
}

async function loadAttemptDecision(
  context: Verse8Agent8ServiceContext,
  collectionId: string,
  attempt: StoredLeaderboardAttempt,
  expectedDigest: string,
): Promise<StoredAttemptDecision | undefined> {
  const item = await loadSingleCollectionItem(
    context,
    collectionId,
    'Verse8 leaderboard attempt decision',
  );

  if (item === undefined) {
    return undefined;
  }

  if (item.attemptDigest !== expectedDigest) {
    throw attemptConflict(attempt.attemptId);
  }

  assertRecordVerifiedLeaderboardAttemptResponse(item.response);
  assertStoredAttemptDecision(attempt, item.response);

  return {
    attemptDigest: expectedDigest,
    response: cloneRecordResponse(item.response, false),
  };
}

async function ensureAttemptDecision(
  context: Verse8Agent8ServiceContext,
  collectionId: string,
  attempt: StoredLeaderboardAttempt,
  decision: StoredAttemptDecision,
): Promise<void> {
  const existing = await loadAttemptDecision(
    context,
    collectionId,
    attempt,
    decision.attemptDigest,
  );

  if (existing === undefined) {
    await context.addCollectionItem(collectionId, {
      attemptDigest: decision.attemptDigest,
      response: cloneRecordResponse(decision.response, false),
    });
    return;
  }

  if (!areRecordResponsesEqual(existing.response, decision.response)) {
    throw new Error('Stored Verse8 leaderboard attempt decision is invalid.');
  }
}

async function flushPendingEntryDecisions(
  context: Verse8Agent8ServiceContext,
  namespace: string,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  entries: readonly StoredEntry[],
  persistenceKey: Uint8Array,
): Promise<readonly StoredEntry[]> {
  const nextEntries = [...entries];

  for (const [index, entry] of nextEntries.entries()) {
    if (entry.pendingDecision === undefined) {
      continue;
    }

    const decisionCollection = createAttemptDecisionCollection(
      namespace,
      definition.leaderboardId,
      entry.attempt.attemptId,
      persistenceKey,
    );
    await ensureAttemptDecision(context, decisionCollection, entry.attempt, entry.pendingDecision);
    await context.updateCollectionItem(collections.entries, {
      __id: entry.itemId,
      ...createEntryItem(entry.attempt, entry.attemptDigest),
    });
    nextEntries[index] = createStoredEntry(entry.itemId, entry.attempt, entry.attemptDigest);
  }

  return nextEntries;
}

async function loadEntries(
  context: Verse8Agent8ServiceContext,
  collections: LeaderboardCollections,
  definition: VerifiedLeaderboardDefinition,
  maximumParticipants: number,
): Promise<readonly StoredEntry[]> {
  const items = await context.getCollectionItems(collections.entries, {
    limit: maximumParticipants + 1,
  });

  if (items.length > maximumParticipants) {
    throw new Error('Verse8 leaderboard exceeds maximumParticipants.');
  }

  const entries = items.map((item) => readEntry(item));
  const participantIds = new Set<string>();
  const attemptIds = new Set<string>();

  for (const entry of entries) {
    if (
      participantIds.has(entry.attempt.participantId)
      || attemptIds.has(entry.attempt.attemptId)
    ) {
      throw new Error('Stored Verse8 leaderboard entries are duplicated.');
    }

    participantIds.add(entry.attempt.participantId);
    attemptIds.add(entry.attempt.attemptId);
  }

  return [...entries].sort((left, right) =>
    compareLeaderboardOrder(definition.scoreOrder, left.attempt, right.attempt),
  );
}

async function loadSingleCollectionItem(
  context: Verse8Agent8ServiceContext,
  collectionId: string,
  label: string,
): Promise<Verse8Agent8CollectionItem | undefined> {
  const items = await context.getCollectionItems(collectionId, { limit: 2 });

  if (items.length > 1) {
    throw new Error(`${label} is duplicated.`);
  }

  if (items[0] !== undefined) {
    readItemId(items[0], label);
  }

  return items[0];
}

function readEntry(item: Verse8Agent8CollectionItem): StoredEntry {
  const itemId = readItemId(item, 'Verse8 retained leaderboard entry');

  if (typeof item.attemptDigest !== 'string' || !sha256DigestPattern.test(item.attemptDigest)) {
    throw new Error('Stored Verse8 leaderboard entry is invalid.');
  }

  const attempt = readStoredAttempt(item.attempt);
  const pendingDecision = item.pendingDecision === undefined
    ? undefined
    : readPendingAttemptDecision(item.pendingDecision, attempt, item.attemptDigest);

  return createStoredEntry(itemId, attempt, item.attemptDigest, pendingDecision);
}

function readPendingAttemptDecision(
  input: unknown,
  attempt: StoredLeaderboardAttempt,
  expectedDigest: string,
): StoredAttemptDecision {
  if (
    !isRecord(input)
    || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'attemptDigest')
    || !Object.hasOwn(input, 'response')
    || input.attemptDigest !== expectedDigest
  ) {
    throw new Error('Stored Verse8 leaderboard pending decision is invalid.');
  }

  assertRecordVerifiedLeaderboardAttemptResponse(input.response);
  assertStoredAttemptDecision(attempt, input.response);

  if (!input.response.retained) {
    throw new Error('Stored Verse8 leaderboard pending decision is invalid.');
  }

  return {
    attemptDigest: expectedDigest,
    response: cloneRecordResponse(input.response, false),
  };
}

function readStoredAttempt(input: unknown): StoredLeaderboardAttempt {
  if (!isRecord(input)) {
    throw new Error('Stored Verse8 leaderboard entry is invalid.');
  }

  const rankedEntry: unknown = {
    rank: 1,
    participantId: input.participantId,
    ...(input.participantLabel === undefined
      ? {}
      : { participantLabel: input.participantLabel }),
    attemptId: input.attemptId,
    score: input.score,
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    completedAt: input.completedAt,
  };
  assertLeaderboardRankedEntry(rankedEntry);

  return {
    participantId: rankedEntry.participantId,
    ...(rankedEntry.participantLabel === undefined
      ? {}
      : { participantLabel: rankedEntry.participantLabel }),
    attemptId: rankedEntry.attemptId,
    score: rankedEntry.score,
    ...(rankedEntry.metrics === undefined ? {} : { metrics: { ...rankedEntry.metrics } }),
    completedAt: rankedEntry.completedAt,
  };
}

function createStoredEntry(
  itemId: string,
  attempt: StoredLeaderboardAttempt,
  attemptDigest: string,
  pendingDecision?: StoredAttemptDecision,
): StoredEntry {
  return {
    itemId,
    attemptDigest,
    attempt: cloneStoredAttempt(attempt),
    ...(pendingDecision === undefined
      ? {}
      : {
          pendingDecision: {
            attemptDigest: pendingDecision.attemptDigest,
            response: cloneRecordResponse(pendingDecision.response, false),
          },
        }),
  };
}

function createEntryItem(
  attempt: StoredLeaderboardAttempt,
  attemptDigest: string,
  pendingDecision?: StoredAttemptDecision,
): Readonly<Record<string, unknown>> {
  return {
    attemptDigest,
    attempt: cloneStoredAttempt(attempt),
    ...(pendingDecision === undefined
      ? {}
      : {
          pendingDecision: {
            attemptDigest: pendingDecision.attemptDigest,
            response: cloneRecordResponse(pendingDecision.response, false),
          },
        }),
  };
}

function rankEntries(
  definition: VerifiedLeaderboardDefinition,
  entries: readonly StoredEntry[],
): readonly LeaderboardRankedEntry[] {
  return [...entries]
    .sort((left, right) =>
      compareLeaderboardOrder(definition.scoreOrder, left.attempt, right.attempt),
    )
    .map((entry, index) => toRankedEntry(entry.attempt, index + 1));
}

function shouldReplaceRetainedAttempt(
  definition: VerifiedLeaderboardDefinition,
  retained: StoredLeaderboardAttempt,
  candidate: VerifiedLeaderboardAttempt,
): boolean {
  if (definition.attemptSelection === 'first') {
    return compareAttemptChronology(candidate, retained) < 0;
  }

  return compareLeaderboardOrder(definition.scoreOrder, candidate, retained) < 0;
}

function compareRankedEntryToCursor(
  definition: VerifiedLeaderboardDefinition,
  entry: LeaderboardRankedEntry,
  cursor: VerifiedLeaderboardCursorPosition,
): number {
  if (entry.score !== cursor.score) {
    return definition.scoreOrder === 'ascending'
      ? entry.score - cursor.score
      : cursor.score - entry.score;
  }

  const completedAtDifference = Date.parse(entry.completedAt) - cursor.completedAtMs;
  return completedAtDifference === 0
    ? compareOrdinal(entry.attemptId, cursor.attemptId)
    : completedAtDifference;
}

function compareAttemptChronology(
  left: StoredLeaderboardAttempt,
  right: StoredLeaderboardAttempt,
): number {
  const timestampDifference = Date.parse(left.completedAt) - Date.parse(right.completedAt);
  return timestampDifference === 0
    ? compareOrdinal(left.attemptId, right.attemptId)
    : timestampDifference;
}

function compareLeaderboardOrder(
  scoreOrder: VerifiedLeaderboardDefinition['scoreOrder'],
  left: StoredLeaderboardAttempt,
  right: StoredLeaderboardAttempt,
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
  attempt: StoredLeaderboardAttempt,
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

  return {
    ...cloneStoredAttempt(input),
    verification: { ...input.verification },
  };
}

function cloneStoredAttempt(input: StoredLeaderboardAttempt): StoredLeaderboardAttempt {
  return {
    participantId: input.participantId,
    ...(input.participantLabel === undefined
      ? {}
      : { participantLabel: input.participantLabel }),
    attemptId: input.attemptId,
    score: input.score,
    ...(input.metrics === undefined ? {} : { metrics: { ...input.metrics } }),
    completedAt: input.completedAt,
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

function createAttemptDigest(
  persistenceKey: Uint8Array,
  attempt: VerifiedLeaderboardAttempt,
): string {
  const metrics = attempt.metrics === undefined
    ? null
    : Object.keys(attempt.metrics)
        .sort(compareOrdinal)
        .map((key) => [key, attempt.metrics?.[key]]);

  return hmacSha256(
    persistenceKey,
    JSON.stringify([
      'attempt-integrity-v1',
      attempt.participantId,
      attempt.attemptId,
      Object.is(attempt.score, -0) ? 0 : attempt.score,
      metrics,
      Date.parse(attempt.completedAt),
      attempt.verification.authorityId,
      attempt.verification.evidenceId,
      Date.parse(attempt.verification.verifiedAt),
    ]),
  );
}

function assertStoredAttemptDecision(
  attempt: StoredLeaderboardAttempt,
  response: RecordVerifiedLeaderboardAttemptResponse,
): void {
  if (
    response.alreadyProcessed
    || response.entry.participantId !== attempt.participantId
    || (response.retained && (
      response.entry.attemptId !== attempt.attemptId
      || response.entry.score !== attempt.score
      || !areMetricMapsEqual(response.entry.metrics, attempt.metrics)
      || Date.parse(response.entry.completedAt) !== Date.parse(attempt.completedAt)
    ))
    || (!response.retained && response.entry.attemptId === attempt.attemptId)
  ) {
    throw new Error('Stored Verse8 leaderboard attempt decision is invalid.');
  }
}

function areRecordResponsesEqual(
  left: RecordVerifiedLeaderboardAttemptResponse,
  right: RecordVerifiedLeaderboardAttemptResponse,
): boolean {
  return left.recorded === right.recorded
    && left.alreadyProcessed === right.alreadyProcessed
    && left.retained === right.retained
    && left.reason === right.reason
    && left.entry.rank === right.entry.rank
    && left.entry.participantId === right.entry.participantId
    && left.entry.participantLabel === right.entry.participantLabel
    && left.entry.attemptId === right.entry.attemptId
    && left.entry.score === right.entry.score
    && areMetricMapsEqual(left.entry.metrics, right.entry.metrics)
    && Date.parse(left.entry.completedAt) === Date.parse(right.entry.completedAt);
}

function areMetricMapsEqual(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

function attemptConflict(attemptId: string): Error {
  return new Error(`Attempt id conflict for ${JSON.stringify(attemptId)}.`);
}

function readItemId(item: Verse8Agent8CollectionItem, label: string): string {
  if (typeof item.__id !== 'string' || item.__id.length === 0) {
    throw new Error(`${label} has an invalid item ID.`);
  }

  return item.__id;
}

function readStorageState(value: unknown): StoredStorageState {
  if (value === undefined) {
    return { version: 2, values: {} };
  }

  if (
    !isRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'version')
    || !Object.hasOwn(value, 'values')
    || value.version !== 2
    || !isRecord(value.values)
  ) {
    throw new Error('Stored Verse8 cloud save state is invalid.');
  }

  const values: Record<string, Verse8Agent8PrivateStorageEnvelope> = {};

  for (const [key, storedValue] of Object.entries(value.values)) {
    if (!sha256DigestPattern.test(key)) {
      throw new Error('Stored Verse8 cloud save state is invalid.');
    }

    values[key] = readStorageEnvelope(storedValue);
  }

  return { version: 2, values };
}

function assertStorageStateSize(state: StoredStorageState, maximumStateBytes: number): void {
  if (utf8Bytes(JSON.stringify(state)).length > maximumStateBytes) {
    throw new Error('Stored Verse8 cloud save state exceeds maximumStateBytes.');
  }
}

function assertStorageEntryCount(state: StoredStorageState, maximumEntries: number): void {
  if (Object.keys(state.values).length > maximumEntries) {
    throw new Error('Stored Verse8 cloud save state exceeds maximumEntries.');
  }
}

function assertPrivateStorageCodec(codec: Verse8Agent8PrivateStorageCodec): void {
  if (
    typeof codec !== 'object'
    || codec === null
    || codec.security !== 'authenticated-encryption'
    || typeof codec.seal !== 'function'
    || typeof codec.open !== 'function'
  ) {
    throw new Error('A Verse8 private storage codec is required.');
  }
}

function readStorageEnvelope(input: unknown): Verse8Agent8PrivateStorageEnvelope {
  if (
    !isRecord(input)
    || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'keyId')
    || !Object.hasOwn(input, 'ciphertext')
    || typeof input.keyId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.keyId)
    || typeof input.ciphertext !== 'string'
    || input.ciphertext.length === 0
    || !isWellFormedUnicode(input.ciphertext)
  ) {
    throw new Error('Verse8 private storage envelope is invalid.');
  }

  return {
    keyId: input.keyId,
    ciphertext: input.ciphertext,
  };
}

function cloneStorageEnvelope(
  envelope: Verse8Agent8PrivateStorageEnvelope,
): Verse8Agent8PrivateStorageEnvelope {
  return {
    keyId: envelope.keyId,
    ciphertext: envelope.ciphertext,
  };
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
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > 256
    || !isWellFormedUnicode(value)
  ) {
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
      if (index + 1 >= input.length) {
        return false;
      }

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
  return `mpgd:verse8:storage:${sha256(account)}`;
}

function leaderboardLockKey(leaderboardId: string): string {
  return `mpgd:verse8:leaderboard:${sha256(leaderboardId)}`;
}

function createPrivateStorageKey(
  persistenceKey: Uint8Array,
  account: string,
  storageKey: string,
): string {
  return hmacSha256(persistenceKey, JSON.stringify(['storage-slot', account, storageKey]));
}

function readPersistenceSecret(value: unknown, label: string): Uint8Array {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || !isWellFormedUnicode(value)
  ) {
    throw new Error(`${label} must be a canonical server-only secret.`);
  }

  const bytes = utf8Bytes(value);

  if (
    bytes.length < minimumPersistenceSecretBytes
    || bytes.length > maximumPersistenceSecretBytes
  ) {
    throw new Error(
      `${label} must contain between ${String(minimumPersistenceSecretBytes)}`
        + ` and ${String(maximumPersistenceSecretBytes)} UTF-8 bytes.`,
    );
  }

  return bytes;
}

function sha256(input: string): string {
  return bytesToHex(sha256Bytes(utf8Bytes(input)));
}

function hmacSha256(key: Uint8Array, input: string): string {
  const normalizedKey = key.length > 64 ? sha256Bytes(key) : key.slice();
  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);

  for (let index = 0; index < 64; index += 1) {
    const keyByte = normalizedKey[index] ?? 0;
    innerPad[index] = keyByte ^ 0x36;
    outerPad[index] = keyByte ^ 0x5c;
  }

  const innerDigest = sha256Bytes(concatenateBytes(innerPad, utf8Bytes(input)));
  return bytesToHex(sha256Bytes(concatenateBytes(outerPad, innerDigest)));
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array(8);
  hash[0] = 0x6a09e667;
  hash[1] = 0xbb67ae85;
  hash[2] = 0x3c6ef372;
  hash[3] = 0xa54ff53a;
  hash[4] = 0x510e527f;
  hash[5] = 0x9b05688c;
  hash[6] = 0x1f83d9ab;
  hash[7] = 0x5be0cd19;
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }

    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15] as number;
      const previous2 = schedule[index - 2] as number;
      const sigma0 = rotateRight(previous15, 7)
        ^ rotateRight(previous15, 18)
        ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17)
        ^ rotateRight(previous2, 19)
        ^ (previous2 >>> 10);
      schedule[index] = (
        (schedule[index - 16] as number)
        + sigma0
        + (schedule[index - 7] as number)
        + sigma1
      ) >>> 0;
    }

    let a = hash[0] as number;
    let b = hash[1] as number;
    let c = hash[2] as number;
    let d = hash[3] as number;
    let e = hash[4] as number;
    let f = hash[5] as number;
    let g = hash[6] as number;
    let h = hash[7] as number;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (
        h
        + sum1
        + choice
        + (sha256RoundConstants[index] as number)
        + (schedule[index] as number)
      ) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
    hash[5] = ((hash[5] as number) + f) >>> 0;
    hash[6] = ((hash[6] as number) + g) >>> 0;
    hash[7] = ((hash[7] as number) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);

  for (let index = 0; index < hash.length; index += 1) {
    digestView.setUint32(index * 4, hash[index] as number, false);
  }

  return digest;
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = input.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return Uint8Array.from(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

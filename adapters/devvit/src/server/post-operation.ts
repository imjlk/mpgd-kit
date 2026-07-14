const operationSchemaVersion = 1 as const;
const defaultLeaseTtlMs = 30_000;
const defaultMaxPostDataBytes = 2_048;
const defaultStoreAttempts = 8;
const maximumStoreAttempts = 32;
const defaultPendingPageLimit = 20;
const maximumPendingPageLimit = 100;
const maximumIdentifierLength = 128;
const maximumOperationTypeLength = 64;
const maximumLeaseTtlMs = 60 * 60 * 1_000;
const operationTypePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const entryPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const redditPostIdPattern = /^t3_[A-Za-z0-9]+$/u;
const redditSubredditIdPattern = /^t5_[a-z0-9]+$/u;

export type DevvitJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DevvitJsonValue[]
  | DevvitJsonObject;

export interface DevvitJsonObject {
  readonly [key: string]: DevvitJsonValue;
}

export interface DevvitDurableOperationStore {
  /** Reads one durable value. Missing values return undefined. */
  read(key: string): Promise<string | undefined>;
  /** Atomically creates a value only when the key is absent. */
  create(key: string, value: string): Promise<boolean>;
  /** Atomically replaces a value only when its raw current value matches. */
  compareAndSet(key: string, expectedValue: string, nextValue: string): Promise<boolean>;
  /** Atomically creates an expiring reconciliation lease. */
  createLease(key: string, token: string, expiresAt: Date): Promise<boolean>;
  /** Deletes a lease only when the current token matches. */
  releaseLease(key: string, token: string): Promise<void>;
}

export interface DevvitDurableOperationIndexMutation {
  readonly indexKey: string;
  readonly removeMember?: string;
  readonly addMember?: string;
}

/**
 * Optional durable-store capability used to discover pending operations without
 * scanning the Redis keyspace. Every state and index mutation must commit in the
 * same transaction.
 */
export interface DevvitIndexedDurableOperationStore extends DevvitDurableOperationStore {
  createIndexed(
    key: string,
    value: string,
    index: DevvitDurableOperationIndexMutation,
  ): Promise<boolean>;
  compareAndSetIndexed(
    key: string,
    expectedValue: string,
    nextValue: string,
    index: DevvitDurableOperationIndexMutation,
  ): Promise<boolean>;
  listIndex(
    key: string,
    startExclusive: string | undefined,
    limit: number,
  ): Promise<readonly string[]>;
}

export interface DevvitPostOperationScope {
  readonly appScope: string;
  /** Use the canonical subreddit identifier, not a display name. */
  readonly subredditId: string;
}

export interface DevvitPostLaunch<TParams extends DevvitJsonObject> {
  readonly entry: string;
  readonly params: TParams;
}

export interface DevvitCanonicalPostData<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends DevvitJsonObject {
  readonly mpgd: {
    readonly schemaVersion: typeof operationSchemaVersion;
    readonly appScope: string;
    readonly subredditId: string;
    readonly operationType: string;
    readonly operationId: string;
  };
  readonly launch: {
    readonly schemaVersion: typeof operationSchemaVersion;
    readonly entry: string;
    readonly params: TLaunchParams;
  };
  readonly payload: TPayload;
}

export interface DevvitPostOperationDefinition<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  readonly operationType: string;
  readonly parsePayload: (input: unknown) => TPayload;
  readonly parseLaunchParams: (input: unknown) => TLaunchParams;
  readonly maxPostDataBytes?: number;
}

export interface DevvitPostOperationDescriptorInput<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  readonly scope: DevvitPostOperationScope;
  /** Must be stable across process restarts and retries. */
  readonly operationId: string;
  readonly payload: TPayload;
  readonly launch: DevvitPostLaunch<TLaunchParams>;
}

export interface DevvitPostPublishInput<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  readonly scope: DevvitPostOperationScope;
  readonly operationId: string;
  readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
}

export interface DevvitPostPublishReceipt {
  readonly postId: string;
}

export interface DevvitPostReconciliationCandidate {
  readonly postId: string;
  readonly postData: unknown;
}

export type DevvitPostReconciliationReason =
  | 'submission-attempted'
  | 'submit-outcome-unknown'
  | 'invalid-publish-receipt'
  | 'receipt-write-failed'
  | 'match-not-found'
  | 'invalid-reconciliation-candidate'
  | 'reconciliation-failed';

export type DevvitPostOperationResult<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> =
  | {
      readonly status: 'missing';
      readonly operationId: string;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'prepared';
      readonly operationId: string;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'created' | 'existing' | 'recovered';
      readonly operationId: string;
      readonly postId: string;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'reconciliation-required';
      readonly operationId: string;
      readonly reason: DevvitPostReconciliationReason;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'busy';
      readonly operationId: string;
      readonly reason: 'store-contention' | 'reconciliation-lease-held';
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'conflict';
      readonly operationId: string;
      readonly reason: 'descriptor-mismatch';
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'terminal-unresolved';
      readonly operationId: string;
      readonly reason: 'multiple-exact-matches' | 'published-receipt-conflict';
      readonly postIds: readonly string[];
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    };

export interface ExecuteDevvitPostOperationInput<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends DevvitPostOperationDescriptorInput<TPayload, TLaunchParams> {
  readonly publish: (
    input: DevvitPostPublishInput<TPayload, TLaunchParams>,
  ) => Promise<DevvitPostPublishReceipt>;
}

export interface ReconcileDevvitPostOperationInput<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends DevvitPostOperationDescriptorInput<TPayload, TLaunchParams> {
  readonly findCandidates: (
    input: DevvitPostPublishInput<TPayload, TLaunchParams>,
  ) => Promise<readonly DevvitPostReconciliationCandidate[]>;
}

export interface ListPendingDevvitPostOperationsInput {
  readonly scope: DevvitPostOperationScope;
  /** Opaque continuation returned by the previous page for the same scope. */
  readonly cursor?: string;
  readonly limit?: number;
}

export type DevvitPendingPostOperation<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> =
  | {
      readonly status: 'prepared';
      readonly operationId: string;
      readonly updatedAt: number;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'reconciliation-required';
      readonly operationId: string;
      readonly reason: 'submission-attempted';
      readonly updatedAt: number;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    }
  | {
      readonly status: 'terminal-unresolved';
      readonly operationId: string;
      readonly reason: 'multiple-exact-matches' | 'published-receipt-conflict';
      readonly postIds: readonly string[];
      readonly updatedAt: number;
      readonly postData: DevvitCanonicalPostData<TPayload, TLaunchParams>;
    };

export interface DevvitPendingPostOperationPage<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  readonly operations: readonly DevvitPendingPostOperation<TPayload, TLaunchParams>[];
  readonly nextCursor?: string;
}

export interface DevvitPostOperationCoordinator<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  execute(
    input: ExecuteDevvitPostOperationInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>>;
  read(
    input: DevvitPostOperationDescriptorInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>>;
  reconcile(
    input: ReconcileDevvitPostOperationInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>>;
  /** Lists durable work only; it never invokes a Reddit API or reconciliation callback. */
  listPending(
    input: ListPendingDevvitPostOperationsInput,
  ): Promise<DevvitPendingPostOperationPage<TPayload, TLaunchParams>>;
}

export interface CreateDevvitPostOperationCoordinatorOptions<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> {
  readonly definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>;
  readonly store: DevvitDurableOperationStore;
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly leaseTtlMs?: number;
  readonly storeAttempts?: number;
}

export class DevvitPostOperationValidationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DevvitPostOperationValidationError';
  }
}

export class DevvitPostOperationStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DevvitPostOperationStateError';
  }
}

export function defineDevvitPostOperation<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
): DevvitPostOperationDefinition<TPayload, TLaunchParams> {
  assertOperationType(definition.operationType);
  assertPositiveSafeInteger(
    definition.maxPostDataBytes ?? defaultMaxPostDataBytes,
    'maxPostDataBytes',
  );

  if (typeof definition.parsePayload !== 'function') {
    throw new DevvitPostOperationValidationError('parsePayload must be a function.');
  }
  if (typeof definition.parseLaunchParams !== 'function') {
    throw new DevvitPostOperationValidationError('parseLaunchParams must be a function.');
  }

  return Object.freeze({ ...definition });
}

export function createDevvitPostOperationCoordinator<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  input: CreateDevvitPostOperationCoordinatorOptions<TPayload, TLaunchParams>,
): DevvitPostOperationCoordinator<TPayload, TLaunchParams> {
  const definition = defineDevvitPostOperation(input.definition);
  const now = input.now ?? Date.now;
  const createToken = input.createToken ?? defaultTokenFactory;
  const leaseTtlMs = input.leaseTtlMs ?? defaultLeaseTtlMs;
  const storeAttempts = input.storeAttempts ?? defaultStoreAttempts;
  const indexedStore = readIndexedStore(input.store);

  assertPositiveSafeInteger(leaseTtlMs, 'leaseTtlMs');
  if (leaseTtlMs > maximumLeaseTtlMs) {
    throw new DevvitPostOperationValidationError(
      `leaseTtlMs must not exceed ${String(maximumLeaseTtlMs)}.`,
    );
  }
  assertPositiveSafeInteger(storeAttempts, 'storeAttempts');
  if (storeAttempts > maximumStoreAttempts) {
    throw new DevvitPostOperationValidationError(
      `storeAttempts must not exceed ${String(maximumStoreAttempts)}.`,
    );
  }

  return {
    execute,
    read,
    reconcile,
    listPending,
  };

  async function execute(
    request: ExecuteDevvitPostOperationInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    if (typeof request.publish !== 'function') {
      throw new DevvitPostOperationValidationError('publish must be a function.');
    }

    const descriptor = createDescriptor(definition, request);
    const operationKey = createDevvitPostOperationKey({
      scope: request.scope,
      operationType: definition.operationType,
      operationId: request.operationId,
    });

    for (let attempt = 0; attempt < storeAttempts; attempt += 1) {
      let current = await readOperation(operationKey, descriptor, definition, input.store);

      if (current.kind === 'missing') {
        const timestamp = readTimestamp(now);
        const prepared: PreparedRecord<TPayload, TLaunchParams> = {
          schemaVersion: operationSchemaVersion,
          revision: 0,
          operationKey,
          phase: 'prepared',
          descriptor,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const preparedRaw = serializeRecord(prepared);

        if (!await createStoredRecord(operationKey, preparedRaw, prepared)) {
          continue;
        }

        current = { kind: 'record', raw: preparedRaw, record: prepared };
      }

      if (current.kind === 'conflict') {
        return conflictResult(descriptor);
      }

      switch (current.record.phase) {
        case 'prepared': {
          const timestamp = Math.max(readTimestamp(now), current.record.updatedAt);
          const attempted: AttemptedRecord<TPayload, TLaunchParams> = {
            ...current.record,
            revision: current.record.revision + 1,
            phase: 'attempted',
            attemptId: readToken(createToken, 'submission attempt'),
            attemptedAt: timestamp,
            updatedAt: timestamp,
          };
          const attemptedRaw = serializeRecord(attempted);

          if (!await compareAndSetStoredRecord(
            operationKey,
            current.raw,
            attemptedRaw,
            current.record,
            attempted,
          )) {
            continue;
          }

          return submitOnce(attempted, attemptedRaw, request.publish);
        }
        case 'attempted':
          return reconciliationResult(current.record, 'submission-attempted');
        case 'published':
          return publishedResult(current.record, 'existing');
        case 'terminal-unresolved':
          return terminalResult(current.record);
      }
    }

    return busyResult(descriptor, 'store-contention');
  }

  async function read(
    request: DevvitPostOperationDescriptorInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    const descriptor = createDescriptor(definition, request);
    const operationKey = createDevvitPostOperationKey({
      scope: request.scope,
      operationType: definition.operationType,
      operationId: request.operationId,
    });
    const current = await readOperation(operationKey, descriptor, definition, input.store);

    if (current.kind === 'missing') {
      return missingResult(descriptor);
    }
    if (current.kind === 'conflict') {
      return conflictResult(descriptor);
    }

    switch (current.record.phase) {
      case 'prepared':
        return preparedResult(current.record);
      case 'attempted':
        return reconciliationResult(current.record, 'submission-attempted');
      case 'published':
        return publishedResult(current.record, 'existing');
      case 'terminal-unresolved':
        return terminalResult(current.record);
    }
  }

  async function reconcile(
    request: ReconcileDevvitPostOperationInput<TPayload, TLaunchParams>,
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    if (typeof request.findCandidates !== 'function') {
      throw new DevvitPostOperationValidationError('findCandidates must be a function.');
    }

    const descriptor = createDescriptor(definition, request);
    const operationKey = createDevvitPostOperationKey({
      scope: request.scope,
      operationType: definition.operationType,
      operationId: request.operationId,
    });
    const current = await readOperation(operationKey, descriptor, definition, input.store);

    if (current.kind === 'missing') {
      return missingResult(descriptor);
    }
    if (current.kind === 'conflict') {
      return conflictResult(descriptor);
    }
    if (current.record.phase === 'prepared') {
      return preparedResult(current.record);
    }
    if (current.record.phase === 'published') {
      return publishedResult(current.record, 'existing');
    }
    if (current.record.phase === 'terminal-unresolved') {
      return terminalResult(current.record);
    }

    const leaseKey = `${operationKey}:reconciliation-lease`;
    const leaseToken = readToken(createToken, 'reconciliation lease');
    const leaseExpirationMs = readTimestamp(now) + leaseTtlMs;
    const leaseExpiration = new Date(leaseExpirationMs);

    if (!Number.isSafeInteger(leaseExpirationMs) || Number.isNaN(leaseExpiration.getTime())) {
      throw new DevvitPostOperationValidationError(
        'The reconciliation lease expiration must be a valid timestamp.',
      );
    }

    if (!await input.store.createLease(leaseKey, leaseToken, leaseExpiration)) {
      return busyResult(descriptor, 'reconciliation-lease-held');
    }

    try {
      let candidates: readonly DevvitPostReconciliationCandidate[];

      try {
        candidates = await request.findCandidates(toPublishInput(descriptor));
      } catch {
        return reconciliationResult(current.record, 'reconciliation-failed');
      }

      if (!Array.isArray(candidates)) {
        return reconciliationResult(current.record, 'invalid-reconciliation-candidate');
      }

      let exactMatches: readonly DevvitPostReconciliationCandidate[];

      try {
        exactMatches = exactReconciliationMatches(candidates, descriptor, definition);
      } catch (error) {
        if (error instanceof DevvitPostOperationValidationError) {
          return reconciliationResult(current.record, 'invalid-reconciliation-candidate');
        }
        throw error;
      }

      if (exactMatches.length === 0) {
        return reconciliationResult(current.record, 'match-not-found');
      }

      if (exactMatches.length === 1) {
        const [match] = exactMatches;

        if (match === undefined) {
          throw new DevvitPostOperationStateError('Expected one reconciliation match.');
        }

        return commitPublished(current.record, current.raw, match.postId, true, 'recovered');
      }

      return commitTerminal(
        current.record,
        current.raw,
        'multiple-exact-matches',
        exactMatches.map((candidate) => candidate.postId),
      );
    } finally {
      try {
        await input.store.releaseLease(leaseKey, leaseToken);
      } catch {
        // The fenced lease expires on its own; cleanup must not mask a durable result.
      }
    }
  }

  async function listPending(
    request: ListPendingDevvitPostOperationsInput,
  ): Promise<DevvitPendingPostOperationPage<TPayload, TLaunchParams>> {
    if (indexedStore === undefined) {
      throw new DevvitPostOperationStateError(
        'The durable post operation store does not support pending-operation indexes.',
      );
    }

    const scope = normalizeScope(request.scope);
    const limit = normalizePendingPageLimit(request.limit);
    const indexKey = createDevvitPostOperationIndexKey({
      scope,
      operationType: definition.operationType,
    });
    const cursor = normalizePendingCursor(request.cursor, scope, definition.operationType);
    const members = await indexedStore.listIndex(indexKey, cursor, limit + 1);
    const pageMembers = members.slice(0, limit);
    const indexedOperations = await Promise.all(pageMembers.map(async (member) => {
      const indexed = parsePendingIndexMember(member, scope, definition.operationType);
      const raw = await indexedStore.read(indexed.operationKey);

      if (raw === undefined) {
        throw new DevvitPostOperationStateError(
          `Pending operation index references missing state: ${indexed.operationKey}`,
        );
      }

      const record = parseStoredRecord(raw, indexed.operationKey, definition);
      const expectedOperationKey = createDevvitPostOperationKey({
        scope: record.descriptor.mpgd,
        operationType: record.descriptor.mpgd.operationType,
        operationId: record.descriptor.mpgd.operationId,
      });
      const recordIndexKey = createDevvitPostOperationIndexKey({
        scope: record.descriptor.mpgd,
        operationType: record.descriptor.mpgd.operationType,
      });

      if (expectedOperationKey !== indexed.operationKey || recordIndexKey !== indexKey) {
        throw new DevvitPostOperationStateError(
          `Pending operation index scope is inconsistent for state: ${indexed.operationKey}`,
        );
      }

      const expectedMember = pendingIndexMember(record);

      if (expectedMember === undefined || expectedMember !== member) {
        // A state transition may commit after ZRANGE but before this GET. Its
        // transaction removes the observed member, so this page can safely skip it.
        return undefined;
      }

      return pendingOperationResult(record);
    }));
    const operations = indexedOperations.filter((operation) => operation !== undefined);
    const nextCursor = members.length > limit ? pageMembers.at(-1) : undefined;

    return Object.freeze({
      operations: Object.freeze(operations),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }

  async function submitOnce(
    record: AttemptedRecord<TPayload, TLaunchParams>,
    raw: string,
    publish: ExecuteDevvitPostOperationInput<TPayload, TLaunchParams>['publish'],
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    let receipt: DevvitPostPublishReceipt;

    try {
      receipt = await publish(toPublishInput(record.descriptor));
    } catch {
      return reconciliationResult(record, 'submit-outcome-unknown');
    }

    if (!isRedditPostId(receipt?.postId)) {
      return reconciliationResult(record, 'invalid-publish-receipt');
    }

    try {
      return await commitPublished(record, raw, receipt.postId, false, 'created');
    } catch {
      return reconciliationResult(record, 'receipt-write-failed');
    }
  }

  async function commitPublished(
    source: AttemptedRecord<TPayload, TLaunchParams>,
    sourceRaw: string,
    postId: string,
    recovered: boolean,
    successStatus: 'created' | 'recovered',
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    let expectedRecord: StoredRecord<TPayload, TLaunchParams> = source;
    let expectedRaw = sourceRaw;

    for (let attempt = 0; attempt < storeAttempts; attempt += 1) {
      const timestamp = Math.max(readTimestamp(now), expectedRecord.updatedAt);
      const published: PublishedRecord<TPayload, TLaunchParams> = {
        schemaVersion: operationSchemaVersion,
        revision: expectedRecord.revision + 1,
        operationKey: expectedRecord.operationKey,
        phase: 'published',
        descriptor: expectedRecord.descriptor,
        createdAt: expectedRecord.createdAt,
        updatedAt: timestamp,
        attemptId: source.attemptId,
        attemptedAt: source.attemptedAt,
        postId,
        publishedAt: timestamp,
        recovered,
      };

      if (await compareAndSetStoredRecord(
        source.operationKey,
        expectedRaw,
        serializeRecord(published),
        expectedRecord,
        published,
      )) {
        return publishedResult(published, successStatus);
      }

      const reread = await readOperation(
        source.operationKey,
        source.descriptor,
        definition,
        input.store,
      );

      if (reread.kind === 'missing' || reread.kind === 'conflict') {
        throw new DevvitPostOperationStateError(
          `Durable post operation changed incompatibly while recording post ${postId}.`,
        );
      }

      if (reread.record.phase === 'published') {
        if (reread.record.postId === postId) {
          return publishedResult(reread.record, successStatus);
        }

        const conflictingPostIds = [reread.record.postId, postId];
        return commitTerminal(
          reread.record,
          reread.raw,
          'published-receipt-conflict',
          conflictingPostIds,
        );
      }

      if (reread.record.phase === 'terminal-unresolved') {
        return terminalResult(reread.record);
      }

      if (reread.record.phase !== 'attempted' || reread.record.attemptId !== source.attemptId) {
        throw new DevvitPostOperationStateError(
          `Durable post operation lost its permanent attempt fence for post ${postId}.`,
        );
      }

      expectedRecord = reread.record;
      expectedRaw = reread.raw;
    }

    return busyResult(source.descriptor, 'store-contention');
  }

  async function commitTerminal(
    source: AttemptedRecord<TPayload, TLaunchParams> | PublishedRecord<TPayload, TLaunchParams>,
    sourceRaw: string,
    reason: TerminalRecord<TPayload, TLaunchParams>['reason'],
    postIds: readonly string[],
  ): Promise<DevvitPostOperationResult<TPayload, TLaunchParams>> {
    const normalizedPostIds = [...new Set(postIds)].sort();

    if (normalizedPostIds.length < 2) {
      throw new DevvitPostOperationStateError(
        'A terminal post operation requires at least two distinct post IDs.',
      );
    }

    let expectedRecord = source;
    let expectedRaw = sourceRaw;
    let expectedPostIds = normalizedPostIds;

    // One extra convergence attempt preserves ambiguity evidence when the first
    // CAS loses specifically to an attempted -> published transition.
    for (let attempt = 0; attempt < storeAttempts + 1; attempt += 1) {
      const timestamp = Math.max(readTimestamp(now), expectedRecord.updatedAt);
      const terminal: TerminalRecord<TPayload, TLaunchParams> = {
        schemaVersion: operationSchemaVersion,
        revision: expectedRecord.revision + 1,
        operationKey: expectedRecord.operationKey,
        phase: 'terminal-unresolved',
        descriptor: expectedRecord.descriptor,
        createdAt: expectedRecord.createdAt,
        updatedAt: timestamp,
        attemptId: expectedRecord.attemptId,
        attemptedAt: expectedRecord.attemptedAt,
        reason,
        postIds: expectedPostIds,
        unresolvedAt: timestamp,
      };

      if (await compareAndSetStoredRecord(
        source.operationKey,
        expectedRaw,
        serializeRecord(terminal),
        expectedRecord,
        terminal,
      )) {
        return terminalResult(terminal);
      }

      const current = await readOperation(
        source.operationKey,
        source.descriptor,
        definition,
        input.store,
      );

      if (current.kind !== 'record') {
        throw new DevvitPostOperationStateError(
          'Durable post operation changed incompatibly while recording a terminal outcome.',
        );
      }

      if (current.record.phase === 'terminal-unresolved') {
        return terminalResult(current.record);
      }

      if (current.record.phase === 'prepared'
        || current.record.attemptId !== source.attemptId) {
        throw new DevvitPostOperationStateError(
          'Durable post operation lost its permanent attempt fence while recording a terminal outcome.',
        );
      }

      expectedRecord = current.record;
      expectedRaw = current.raw;

      if (current.record.phase === 'published') {
        expectedPostIds = [...new Set([...expectedPostIds, current.record.postId])].sort();
      }
    }

    return busyResult(source.descriptor, 'store-contention');
  }

  function createStoredRecord(
    operationKey: string,
    raw: string,
    record: StoredRecord<TPayload, TLaunchParams>,
  ): Promise<boolean> {
    if (indexedStore === undefined) {
      return input.store.create(operationKey, raw);
    }

    return indexedStore.createIndexed(
      operationKey,
      raw,
      createPendingIndexMutation(undefined, record),
    );
  }

  function compareAndSetStoredRecord(
    operationKey: string,
    expectedRaw: string,
    nextRaw: string,
    previous: StoredRecord<TPayload, TLaunchParams>,
    next: StoredRecord<TPayload, TLaunchParams>,
  ): Promise<boolean> {
    if (indexedStore === undefined) {
      return input.store.compareAndSet(operationKey, expectedRaw, nextRaw);
    }

    return indexedStore.compareAndSetIndexed(
      operationKey,
      expectedRaw,
      nextRaw,
      createPendingIndexMutation(previous, next),
    );
  }
}

export function createDevvitPostOperationKey(input: {
  readonly scope: DevvitPostOperationScope;
  readonly operationType: string;
  readonly operationId: string;
}): string {
  const appScope = assertIdentifier(input.scope.appScope, 'appScope');
  const subredditId = assertSubredditId(input.scope.subredditId);
  const operationId = assertIdentifier(input.operationId, 'operationId');

  assertOperationType(input.operationType);

  return [
    'mpgd:devvit:post-operation:v1',
    encodeKeyComponent(appScope),
    encodeKeyComponent(subredditId),
    encodeKeyComponent(input.operationType),
    encodeKeyComponent(operationId),
    'state',
  ].join(':');
}

function createDevvitPostOperationIndexKey(input: {
  readonly scope: DevvitPostOperationScope;
  readonly operationType: string;
}): string {
  const scope = normalizeScope(input.scope);

  assertOperationType(input.operationType);

  return [
    'mpgd:devvit:post-operation-index:v1',
    encodeKeyComponent(scope.appScope),
    encodeKeyComponent(scope.subredditId),
    encodeKeyComponent(input.operationType),
    'pending',
  ].join(':');
}

interface StoredBase<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject> {
  readonly schemaVersion: typeof operationSchemaVersion;
  readonly revision: number;
  readonly operationKey: string;
  readonly descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PreparedRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends StoredBase<TPayload, TLaunchParams> {
  readonly phase: 'prepared';
}

interface AttemptedRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends StoredBase<TPayload, TLaunchParams> {
  readonly phase: 'attempted';
  readonly attemptId: string;
  readonly attemptedAt: number;
}

interface PublishedRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends StoredBase<TPayload, TLaunchParams> {
  readonly phase: 'published';
  readonly attemptId: string;
  readonly attemptedAt: number;
  readonly postId: string;
  readonly publishedAt: number;
  readonly recovered: boolean;
}

interface TerminalRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
> extends StoredBase<TPayload, TLaunchParams> {
  readonly phase: 'terminal-unresolved';
  readonly attemptId: string;
  readonly attemptedAt: number;
  readonly reason: 'multiple-exact-matches' | 'published-receipt-conflict';
  readonly postIds: readonly string[];
  readonly unresolvedAt: number;
}

type StoredRecord<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject> =
  | PreparedRecord<TPayload, TLaunchParams>
  | AttemptedRecord<TPayload, TLaunchParams>
  | PublishedRecord<TPayload, TLaunchParams>
  | TerminalRecord<TPayload, TLaunchParams>;

function readIndexedStore(
  store: DevvitDurableOperationStore,
): DevvitIndexedDurableOperationStore | undefined {
  const candidate = store as Partial<DevvitIndexedDurableOperationStore>;
  const capabilities = [
    candidate.createIndexed,
    candidate.compareAndSetIndexed,
    candidate.listIndex,
  ];
  const supportedCapabilities = capabilities.filter((capability) =>
    typeof capability === 'function').length;

  if (supportedCapabilities === 0) {
    return undefined;
  }
  if (supportedCapabilities !== capabilities.length) {
    throw new DevvitPostOperationValidationError(
      'Indexed durable operation stores must implement createIndexed, '
        + 'compareAndSetIndexed, and listIndex together.',
    );
  }

  return candidate as DevvitIndexedDurableOperationStore;
}

function createPendingIndexMutation<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  previous: StoredRecord<TPayload, TLaunchParams> | undefined,
  next: StoredRecord<TPayload, TLaunchParams>,
): DevvitDurableOperationIndexMutation {
  const indexKey = createDevvitPostOperationIndexKey({
    scope: next.descriptor.mpgd,
    operationType: next.descriptor.mpgd.operationType,
  });

  if (previous !== undefined) {
    const previousIndexKey = createDevvitPostOperationIndexKey({
      scope: previous.descriptor.mpgd,
      operationType: previous.descriptor.mpgd.operationType,
    });

    if (previousIndexKey !== indexKey) {
      throw new DevvitPostOperationStateError(
        'A durable post operation cannot move between pending-operation indexes.',
      );
    }
  }

  const removeMember = previous === undefined ? undefined : pendingIndexMember(previous);
  const addMember = pendingIndexMember(next);

  return {
    indexKey,
    ...(removeMember === undefined ? {} : { removeMember }),
    ...(addMember === undefined ? {} : { addMember }),
  };
}

function pendingIndexMember<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(record: StoredRecord<TPayload, TLaunchParams>): string | undefined {
  if (record.phase === 'published') {
    return undefined;
  }

  let phaseMarker = '2';

  if (record.phase === 'prepared') {
    phaseMarker = '0';
  } else if (record.phase === 'attempted') {
    phaseMarker = '1';
  }

  return `${String(record.updatedAt).padStart(16, '0')}:${phaseMarker}:${record.operationKey}`;
}

function parsePendingIndexMember(
  member: string,
  scope: DevvitPostOperationScope,
  operationType: string,
): { readonly operationKey: string } {
  if (typeof member !== 'string' || member.length > 8_192) {
    throw new DevvitPostOperationStateError('Pending operation index member is invalid.');
  }

  const separator = member.indexOf(':', 17);
  const timestamp = member.slice(0, 16);
  const phaseMarker = member.slice(17, separator);
  const operationKey = separator < 0 ? '' : member.slice(separator + 1);
  const operationKeyPrefix = [
    'mpgd:devvit:post-operation:v1',
    encodeKeyComponent(scope.appScope),
    encodeKeyComponent(scope.subredditId),
    encodeKeyComponent(operationType),
    '',
  ].join(':');

  if (
    !/^\d{16}$/u.test(timestamp)
    || !['0', '1', '2'].includes(phaseMarker)
    || !operationKey.startsWith(operationKeyPrefix)
    || !operationKey.endsWith(':state')
  ) {
    throw new DevvitPostOperationStateError('Pending operation index member is invalid.');
  }

  return { operationKey };
}

function normalizePendingCursor(
  cursor: string | undefined,
  scope: DevvitPostOperationScope,
  operationType: string,
): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  parsePendingIndexMember(cursor, scope, operationType);
  return cursor;
}

function normalizePendingPageLimit(limit: number | undefined): number {
  const normalized = limit ?? defaultPendingPageLimit;

  if (
    !Number.isSafeInteger(normalized)
    || normalized < 1
    || normalized > maximumPendingPageLimit
  ) {
    throw new DevvitPostOperationValidationError(
      `limit must be a safe integer from 1 to ${String(maximumPendingPageLimit)}.`,
    );
  }

  return normalized;
}

function normalizeScope(scope: DevvitPostOperationScope): DevvitPostOperationScope {
  return Object.freeze({
    appScope: assertIdentifier(scope.appScope, 'appScope'),
    subredditId: assertSubredditId(scope.subredditId),
  });
}

function pendingOperationResult<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  record: StoredRecord<TPayload, TLaunchParams>,
): DevvitPendingPostOperation<TPayload, TLaunchParams> {
  switch (record.phase) {
    case 'prepared':
      return Object.freeze({
        status: 'prepared',
        operationId: record.descriptor.mpgd.operationId,
        updatedAt: record.updatedAt,
        postData: record.descriptor,
      });
    case 'attempted':
      return Object.freeze({
        status: 'reconciliation-required',
        operationId: record.descriptor.mpgd.operationId,
        reason: 'submission-attempted',
        updatedAt: record.updatedAt,
        postData: record.descriptor,
      });
    case 'terminal-unresolved':
      return Object.freeze({
        status: 'terminal-unresolved',
        operationId: record.descriptor.mpgd.operationId,
        reason: record.reason,
        postIds: record.postIds,
        updatedAt: record.updatedAt,
        postData: record.descriptor,
      });
    case 'published':
      throw new DevvitPostOperationStateError(
        'Published post operation must not remain in the pending-operation index.',
      );
  }
}

type ReadOperation<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'record';
      readonly raw: string;
      readonly record: StoredRecord<TPayload, TLaunchParams>;
    };

function createDescriptor<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
  input: DevvitPostOperationDescriptorInput<TPayload, TLaunchParams>,
): DevvitCanonicalPostData<TPayload, TLaunchParams> {
  const scope = {
    appScope: assertIdentifier(input.scope.appScope, 'appScope'),
    subredditId: assertSubredditId(input.scope.subredditId),
  };
  const operationId = assertIdentifier(input.operationId, 'operationId');
  const entry = assertEntry(input.launch.entry);
  const payload = parseJsonObject(definition.parsePayload, input.payload, 'payload');
  const params = parseJsonObject(
    definition.parseLaunchParams,
    input.launch.params,
    'launch.params',
  );
  const descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams> = {
    mpgd: {
      schemaVersion: operationSchemaVersion,
      appScope: scope.appScope,
      subredditId: scope.subredditId,
      operationType: definition.operationType,
      operationId,
    },
    launch: {
      schemaVersion: operationSchemaVersion,
      entry,
      params,
    },
    payload,
  };

  assertPostDataByteLength(descriptor, definition.maxPostDataBytes ?? defaultMaxPostDataBytes);

  return freezeJsonValue(descriptor) as DevvitCanonicalPostData<TPayload, TLaunchParams>;
}

async function readOperation<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  operationKey: string,
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
  store: DevvitDurableOperationStore,
): Promise<ReadOperation<TPayload, TLaunchParams>> {
  const raw = await store.read(operationKey);

  if (raw === undefined) {
    return { kind: 'missing' };
  }

  const record = parseStoredRecord(raw, operationKey, definition);

  if (canonicalJson(record.descriptor) !== canonicalJson(descriptor)) {
    return { kind: 'conflict' };
  }

  return { kind: 'record', raw, record };
}

function parseStoredRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  raw: string,
  operationKey: string,
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
): StoredRecord<TPayload, TLaunchParams> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DevvitPostOperationStateError('Stored Devvit post operation is not valid JSON.', {
      cause: error,
    });
  }

  try {
    const record = assertObject(parsed, 'stored operation');
    const phase = assertString(record.phase, 'stored operation.phase');
    const commonKeys = [
      'schemaVersion',
      'revision',
      'operationKey',
      'phase',
      'descriptor',
      'createdAt',
      'updatedAt',
    ];
    let phaseKeys: readonly string[];

    switch (phase) {
      case 'prepared':
        phaseKeys = [];
        break;
      case 'attempted':
        phaseKeys = ['attemptId', 'attemptedAt'];
        break;
      case 'published':
        phaseKeys = ['attemptId', 'attemptedAt', 'postId', 'publishedAt', 'recovered'];
        break;
      case 'terminal-unresolved':
        phaseKeys = ['attemptId', 'attemptedAt', 'reason', 'postIds', 'unresolvedAt'];
        break;
      default:
        throw new DevvitPostOperationValidationError(
          `Unsupported stored operation phase: ${phase}`,
        );
    }

    assertExactKeys(record, [...commonKeys, ...phaseKeys], 'stored operation');
    assertEqual(record.schemaVersion, operationSchemaVersion, 'stored operation.schemaVersion');
    const revision = assertNonNegativeSafeInteger(record.revision, 'stored operation.revision');
    assertEqual(record.operationKey, operationKey, 'stored operation.operationKey');
    const descriptor = parseCanonicalPostData(record.descriptor, definition);
    const createdAt = assertTimestamp(record.createdAt, 'stored operation.createdAt');
    const updatedAt = assertTimestamp(record.updatedAt, 'stored operation.updatedAt');

    if (updatedAt < createdAt) {
      throw new DevvitPostOperationValidationError(
        'stored operation.updatedAt must not precede createdAt.',
      );
    }

    if (phase === 'prepared') {
      assertEqual(revision, 0, 'prepared operation revision');

      if (updatedAt !== createdAt) {
        throw new DevvitPostOperationValidationError(
          'Prepared operation timestamps must be equal.',
        );
      }

      return {
        schemaVersion: operationSchemaVersion,
        revision,
        operationKey,
        phase,
        descriptor,
        createdAt,
        updatedAt,
      };
    }

    const attemptId = assertIdentifier(record.attemptId, 'stored operation.attemptId');
    const attemptedAt = assertTimestamp(record.attemptedAt, 'stored operation.attemptedAt');

    if (revision < 1 || attemptedAt < createdAt || updatedAt < attemptedAt) {
      throw new DevvitPostOperationValidationError('Stored attempt metadata is inconsistent.');
    }

    if (phase === 'attempted') {
      assertEqual(revision, 1, 'attempted operation revision');

      if (updatedAt !== attemptedAt) {
        throw new DevvitPostOperationValidationError(
          'Attempted operation timestamps must be equal.',
        );
      }

      return {
        schemaVersion: operationSchemaVersion,
        revision,
        operationKey,
        phase,
        descriptor,
        createdAt,
        updatedAt,
        attemptId,
        attemptedAt,
      };
    }

    if (phase === 'published') {
      assertEqual(revision, 2, 'published operation revision');
      const postId = assertPostId(record.postId, 'stored operation.postId');
      const publishedAt = assertTimestamp(record.publishedAt, 'stored operation.publishedAt');
      const recovered = assertBoolean(record.recovered, 'stored operation.recovered');

      if (publishedAt < attemptedAt || updatedAt !== publishedAt) {
        throw new DevvitPostOperationValidationError(
          'Stored publication timestamps are inconsistent.',
        );
      }

      return {
        schemaVersion: operationSchemaVersion,
        revision,
        operationKey,
        phase,
        descriptor,
        createdAt,
        updatedAt,
        attemptId,
        attemptedAt,
        postId,
        publishedAt,
        recovered,
      };
    }

    const reason = record.reason;

    if (reason !== 'multiple-exact-matches' && reason !== 'published-receipt-conflict') {
      throw new DevvitPostOperationValidationError('Stored terminal reason is not supported.');
    }

    if (revision !== 2 && revision !== 3) {
      throw new DevvitPostOperationValidationError('terminal operation revision must be 2 or 3.');
    }
    if (reason === 'published-receipt-conflict' && revision !== 3) {
      throw new DevvitPostOperationValidationError(
        'A published receipt conflict must follow a published state.',
      );
    }

    if (!Array.isArray(record.postIds) || record.postIds.length < 2) {
      throw new DevvitPostOperationValidationError(
        'Stored terminal operation must contain at least two post IDs.',
      );
    }

    const postIds = record.postIds.map((postId, index) =>
      assertPostId(postId, `stored operation.postIds[${String(index)}]`));

    if (new Set(postIds).size !== postIds.length) {
      throw new DevvitPostOperationValidationError('Stored terminal post IDs must be unique.');
    }

    const unresolvedAt = assertTimestamp(record.unresolvedAt, 'stored operation.unresolvedAt');

    if (unresolvedAt < attemptedAt || updatedAt !== unresolvedAt) {
      throw new DevvitPostOperationValidationError('Stored terminal timestamps are inconsistent.');
    }

    return {
      schemaVersion: operationSchemaVersion,
      revision,
      operationKey,
      phase: 'terminal-unresolved',
      descriptor,
      createdAt,
      updatedAt,
      attemptId,
      attemptedAt,
      reason,
      postIds,
      unresolvedAt,
    };
  } catch (error) {
    if (error instanceof DevvitPostOperationStateError) {
      throw error;
    }

    throw new DevvitPostOperationStateError('Stored Devvit post operation is invalid.', {
      cause: error,
    });
  }
}

function parseCanonicalPostData<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  input: unknown,
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
): DevvitCanonicalPostData<TPayload, TLaunchParams> {
  const postData = assertObject(input, 'postData');
  assertExactKeys(postData, ['mpgd', 'launch', 'payload'], 'postData');
  const marker = assertObject(postData.mpgd, 'postData.mpgd');
  assertExactKeys(
    marker,
    ['schemaVersion', 'appScope', 'subredditId', 'operationType', 'operationId'],
    'postData.mpgd',
  );
  assertEqual(marker.schemaVersion, operationSchemaVersion, 'postData.mpgd.schemaVersion');
  const operationType = assertString(marker.operationType, 'postData.mpgd.operationType');
  assertEqual(operationType, definition.operationType, 'postData.mpgd.operationType');
  const launch = assertObject(postData.launch, 'postData.launch');
  assertExactKeys(launch, ['schemaVersion', 'entry', 'params'], 'postData.launch');
  assertEqual(launch.schemaVersion, operationSchemaVersion, 'postData.launch.schemaVersion');

  const parsed: DevvitCanonicalPostData<TPayload, TLaunchParams> = {
    mpgd: {
      schemaVersion: operationSchemaVersion,
      appScope: assertIdentifier(marker.appScope, 'postData.mpgd.appScope'),
      subredditId: assertSubredditId(marker.subredditId),
      operationType,
      operationId: assertIdentifier(marker.operationId, 'postData.mpgd.operationId'),
    },
    launch: {
      schemaVersion: operationSchemaVersion,
      entry: assertEntry(launch.entry),
      params: parseJsonObject(
        definition.parseLaunchParams,
        launch.params,
        'postData.launch.params',
      ),
    },
    payload: parseJsonObject(definition.parsePayload, postData.payload, 'postData.payload'),
  };

  assertPostDataByteLength(parsed, definition.maxPostDataBytes ?? defaultMaxPostDataBytes);

  return freezeJsonValue(parsed) as DevvitCanonicalPostData<TPayload, TLaunchParams>;
}

function exactReconciliationMatches<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  candidates: readonly DevvitPostReconciliationCandidate[],
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
  definition: DevvitPostOperationDefinition<TPayload, TLaunchParams>,
): readonly DevvitPostReconciliationCandidate[] {
  const expected = canonicalJson(descriptor);
  const exact = new Map<string, DevvitPostReconciliationCandidate>();

  for (const candidate of candidates) {
    const candidateRecord = assertObject(candidate, 'reconciliation candidate');
    assertExactKeys(candidateRecord, ['postId', 'postData'], 'reconciliation candidate');
    const postId = assertPostId(candidateRecord.postId, 'reconciliation candidate.postId');

    if (!targetsDescriptor(candidateRecord.postData, descriptor)) {
      continue;
    }

    const postData = parseCanonicalPostData(candidateRecord.postData, definition);

    if (canonicalJson(postData) === expected) {
      exact.set(postId, { postId, postData });
    }
  }

  return [...exact.values()];
}

function targetsDescriptor<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  input: unknown,
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
): boolean {
  if (!isPlainObject(input) || !isPlainObject(input.mpgd)) {
    return false;
  }

  const marker = input.mpgd;

  return marker.schemaVersion === operationSchemaVersion
    && marker.appScope === descriptor.mpgd.appScope
    && marker.subredditId === descriptor.mpgd.subredditId
    && marker.operationType === descriptor.mpgd.operationType
    && marker.operationId === descriptor.mpgd.operationId;
}

function serializeRecord<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(record: StoredRecord<TPayload, TLaunchParams>): string {
  return canonicalJson(record as unknown as DevvitJsonValue);
}

function canonicalJson(input: DevvitJsonValue): string {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return JSON.stringify(input);
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new DevvitPostOperationValidationError('JSON numbers must be finite.');
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => canonicalJson(value)).join(',')}]`;
  }

  const object = input as DevvitJsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as DevvitJsonValue)}`)
    .join(',')}}`;
}

function parseJsonObject<T extends DevvitJsonObject>(
  parser: (input: unknown) => T,
  input: unknown,
  label: string,
): T {
  let parsed: T;

  try {
    parsed = parser(input);
  } catch (error) {
    throw new DevvitPostOperationValidationError(`${label} did not pass its parser.`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new DevvitPostOperationValidationError(`${label} parser must return a plain object.`);
  }

  normalizeJsonValue(parsed, label, new Set<object>());

  return freezeJsonValue(JSON.parse(canonicalJson(parsed)) as DevvitJsonValue) as T;
}

function freezeJsonValue(input: DevvitJsonValue): DevvitJsonValue {
  if (Array.isArray(input)) {
    for (const value of input) {
      freezeJsonValue(value);
    }

    return Object.freeze(input);
  }

  if (isPlainObject(input)) {
    for (const value of Object.values(input)) {
      freezeJsonValue(value);
    }

    return Object.freeze(input);
  }

  return input;
}

function normalizeJsonValue(input: unknown, label: string, ancestors: Set<object>): DevvitJsonValue {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new DevvitPostOperationValidationError(`${label} contains a non-finite number.`);
    }
    return input;
  }
  if (typeof input !== 'object') {
    throw new DevvitPostOperationValidationError(`${label} must contain only JSON values.`);
  }
  if (ancestors.has(input)) {
    throw new DevvitPostOperationValidationError(`${label} must not contain cycles.`);
  }

  ancestors.add(input);

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      normalizeJsonValue(input[index], `${label}[${String(index)}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(input) as object | null;

    if (prototype !== Object.prototype && prototype !== null) {
      throw new DevvitPostOperationValidationError(`${label} must use plain JSON objects.`);
    }

    for (const [key, value] of Object.entries(input)) {
      normalizeJsonValue(value, `${label}.${key}`, ancestors);
    }
  }

  ancestors.delete(input);

  return input as DevvitJsonValue;
}

function toPublishInput<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
): DevvitPostPublishInput<TPayload, TLaunchParams> {
  return Object.freeze({
    scope: Object.freeze({
      appScope: descriptor.mpgd.appScope,
      subredditId: descriptor.mpgd.subredditId,
    }),
    operationId: descriptor.mpgd.operationId,
    postData: descriptor,
  });
}

function missingResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return { status: 'missing', operationId: descriptor.mpgd.operationId, postData: descriptor };
}

function preparedResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  record: PreparedRecord<TPayload, TLaunchParams>,
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status: 'prepared',
    operationId: record.descriptor.mpgd.operationId,
    postData: record.descriptor,
  };
}

function publishedResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  record: PublishedRecord<TPayload, TLaunchParams>,
  status: 'created' | 'existing' | 'recovered',
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status,
    operationId: record.descriptor.mpgd.operationId,
    postId: record.postId,
    postData: record.descriptor,
  };
}

function reconciliationResult<
  TPayload extends DevvitJsonObject,
  TLaunchParams extends DevvitJsonObject,
>(
  record: AttemptedRecord<TPayload, TLaunchParams>,
  reason: DevvitPostReconciliationReason,
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status: 'reconciliation-required',
    operationId: record.descriptor.mpgd.operationId,
    reason,
    postData: record.descriptor,
  };
}

function busyResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
  reason: 'store-contention' | 'reconciliation-lease-held',
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status: 'busy',
    operationId: descriptor.mpgd.operationId,
    reason,
    postData: descriptor,
  };
}

function conflictResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  descriptor: DevvitCanonicalPostData<TPayload, TLaunchParams>,
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status: 'conflict',
    operationId: descriptor.mpgd.operationId,
    reason: 'descriptor-mismatch',
    postData: descriptor,
  };
}

function terminalResult<TPayload extends DevvitJsonObject, TLaunchParams extends DevvitJsonObject>(
  record: TerminalRecord<TPayload, TLaunchParams>,
): DevvitPostOperationResult<TPayload, TLaunchParams> {
  return {
    status: 'terminal-unresolved',
    operationId: record.descriptor.mpgd.operationId,
    reason: record.reason,
    postIds: record.postIds,
    postData: record.descriptor,
  };
}

function assertObject(input: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new DevvitPostOperationValidationError(`${label} must be an object.`);
  }

  return input;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(input) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  input: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DevvitPostOperationValidationError(`${label} has unexpected or missing fields.`);
  }
}

function assertString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new DevvitPostOperationValidationError(`${label} must be a non-empty string.`);
  }
  return input;
}

function assertIdentifier(input: unknown, label: string): string {
  const value = assertString(input, label);

  if (value !== value.trim() || value.length > maximumIdentifierLength) {
    throw new DevvitPostOperationValidationError(
      `${label} must be trimmed and at most ${String(maximumIdentifierLength)} characters.`,
    );
  }

  return value;
}

function assertOperationType(input: unknown): asserts input is string {
  const value = assertString(input, 'operationType');

  if (value.length > maximumOperationTypeLength || !operationTypePattern.test(value)) {
    throw new DevvitPostOperationValidationError(
      `operationType must match ${String(operationTypePattern)} and be at most ${String(maximumOperationTypeLength)} characters.`,
    );
  }
}

function assertEntry(input: unknown): string {
  const value = assertIdentifier(input, 'launch.entry');
  const hasUnsafeSegment = value
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..');

  if (!entryPattern.test(value) || hasUnsafeSegment) {
    const requirement = `match ${String(entryPattern)} without empty, dot, or dot-dot segments`;
    throw new DevvitPostOperationValidationError(`launch.entry must ${requirement}.`);
  }

  return value;
}

function assertSubredditId(input: unknown): string {
  const value = assertIdentifier(input, 'subredditId');

  if (!redditSubredditIdPattern.test(value)) {
    throw new DevvitPostOperationValidationError(
      'subredditId must be a canonical lowercase Reddit t5 fullname.',
    );
  }

  return value;
}

function assertPostId(input: unknown, label: string): string {
  const value = assertString(input, label);

  if (!isRedditPostId(value)) {
    throw new DevvitPostOperationValidationError(`${label} must be a Reddit t3 post ID.`);
  }

  return value;
}

function isRedditPostId(input: unknown): input is string {
  return typeof input === 'string' && redditPostIdPattern.test(input);
}

function assertBoolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') {
    throw new DevvitPostOperationValidationError(`${label} must be a boolean.`);
  }
  return input;
}

function assertTimestamp(input: unknown, label: string): number {
  return assertNonNegativeSafeInteger(input, label);
}

function assertNonNegativeSafeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new DevvitPostOperationValidationError(`${label} must be a non-negative safe integer.`);
  }
  return input as number;
}

function assertPositiveSafeInteger(input: unknown, label: string): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new DevvitPostOperationValidationError(`${label} must be a positive safe integer.`);
  }
}

function assertEqual(input: unknown, expected: unknown, label: string): void {
  if (input !== expected) {
    throw new DevvitPostOperationValidationError(`${label} does not match the expected value.`);
  }
}

function assertPostDataByteLength(postData: DevvitJsonValue, maximumBytes: number): void {
  const bytes = new TextEncoder().encode(canonicalJson(postData)).byteLength;

  if (bytes > maximumBytes) {
    throw new DevvitPostOperationValidationError(
      `Canonical Devvit post data is ${String(bytes)} bytes; maximum is ${String(maximumBytes)}.`,
    );
  }
}

function encodeKeyComponent(value: string): string {
  const encoded = encodeURIComponent(value);
  const byteLength = new TextEncoder().encode(value).byteLength;
  return `${String(byteLength)}-${encoded}`;
}

function readTimestamp(now: () => number): number {
  const value = now();

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DevvitPostOperationValidationError('now must return a non-negative safe integer.');
  }

  return value;
}

function readToken(createToken: () => string, label: string): string {
  return assertIdentifier(createToken(), label);
}

function defaultTokenFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new DevvitPostOperationValidationError(
      'Web Crypto randomUUID is required unless createToken is provided.',
    );
  }

  return globalThis.crypto.randomUUID();
}

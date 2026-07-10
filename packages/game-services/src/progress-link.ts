export type GameProgressValue =
  | null
  | boolean
  | number
  | string
  | readonly GameProgressValue[]
  | { readonly [key: string]: GameProgressValue };

export interface ActiveGameProgress {
  readonly id: string;
  readonly updatedAt: string;
  readonly payload: { readonly [key: string]: GameProgressValue };
}

export interface GameProgressSnapshot {
  readonly completedIds: readonly string[];
  readonly bestTimesMs: Readonly<Record<string, number>>;
  readonly bestScores: Readonly<Record<string, number>>;
  readonly activeProgress?: ActiveGameProgress;
}

export const gameProgressLimits = {
  maxIdentifierLength: 256,
  maxCompletedIds: 512,
  maxMetricEntries: 512,
  maxPayloadDepth: 16,
  maxPayloadNodes: 2_048,
  maxPayloadStringUnits: 32_768,
} as const;

export interface ServerResolvedPlayerContext {
  readonly authoritativePlayerId: string;
}

export interface GuestProgressHandoffRequest {
  readonly guestId: string;
  readonly handoffNonce: string;
  readonly idempotencyKey: string;
  readonly guestProgress: GameProgressSnapshot;
}

export interface ReconcileGuestProgressRequest extends GuestProgressHandoffRequest {
  readonly authoritativePlayerId: string;
}

export interface ProgressHandoffVerificationRequest {
  readonly handoffNonce: string;
}

export interface VerifiedProgressHandoff {
  readonly handoffNonce: string;
  readonly authoritativePlayerId: string;
  readonly guestId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProgressHandoffVerifier {
  verify(
    request: ProgressHandoffVerificationRequest,
  ): Promise<VerifiedProgressHandoff | undefined>;
}

export interface VerifyGuestProgressRequest {
  readonly authoritativePlayerId: string;
  readonly guestId: string;
  readonly handoffNonce: string;
  readonly progress: GameProgressSnapshot;
}

export interface GuestProgressVerifier {
  /** Validates client metrics and returns only server-accepted, non-authoritative progress. */
  verify(request: VerifyGuestProgressRequest): Promise<GameProgressSnapshot>;
}

export type ProgressLinkDeduplication = 'none' | 'idempotency-key' | 'handoff-nonce';

export interface ReconcileGuestProgressResult {
  readonly authoritativePlayerId: string;
  readonly progress: GameProgressSnapshot;
  readonly alreadyProcessed: boolean;
  readonly deduplicatedBy: ProgressLinkDeduplication;
}

export interface ProgressLinkStore {
  /** Atomically deduplicates by both idempotency key and handoff nonce before merging. */
  reconcile(
    request: ReconcileGuestProgressRequest,
  ): Promise<ReconcileGuestProgressResult>;
}

export interface ProgressLinkService {
  reconcileGuestProgress(
    context: ServerResolvedPlayerContext,
    request: GuestProgressHandoffRequest,
  ): Promise<ReconcileGuestProgressResult>;
}

export interface AuthoritativeProgressRecord {
  readonly authoritativePlayerId: string;
  readonly progress: GameProgressSnapshot;
}

interface StoredProgressReconciliation {
  readonly authoritativePlayerId: string;
  readonly guestId: string;
  readonly progress: GameProgressSnapshot;
}

interface GuestProgressHandoffMetadata {
  readonly guestId: string;
  readonly handoffNonce: string;
  readonly idempotencyKey: string;
}

interface ProgressPayloadBudget {
  nodes: number;
  stringUnits: number;
}

const snapshotFields = new Set(['completedIds', 'bestTimesMs', 'bestScores', 'activeProgress']);
const activeProgressFields = new Set(['id', 'updatedAt', 'payload']);

export class InMemoryProgressLinkStore implements ProgressLinkStore {
  private readonly progressByPlayerId = new Map<string, GameProgressSnapshot>();
  private readonly reconciliationsByIdempotencyKey = new Map<
    string,
    StoredProgressReconciliation
  >();
  private readonly reconciliationsByHandoffNonce = new Map<
    string,
    StoredProgressReconciliation
  >();

  constructor(initialProgress: readonly AuthoritativeProgressRecord[] = []) {
    for (const record of initialProgress) {
      const authoritativePlayerId = normalizeIdentifier(
        record.authoritativePlayerId,
        'authoritativePlayerId',
      );
      this.progressByPlayerId.set(
        authoritativePlayerId,
        normalizeGameProgressSnapshot(record.progress),
      );
    }
  }

  async reconcile(
    input: ReconcileGuestProgressRequest,
  ): Promise<ReconcileGuestProgressResult> {
    const request = normalizeReconcileGuestProgressRequest(input);
    const byIdempotencyKey = this.reconciliationsByIdempotencyKey.get(request.idempotencyKey);
    const byHandoffNonce = this.reconciliationsByHandoffNonce.get(request.handoffNonce);

    if (
      byIdempotencyKey !== undefined
      && byHandoffNonce !== undefined
      && byIdempotencyKey !== byHandoffNonce
    ) {
      throw new Error('idempotencyKey and handoffNonce belong to different reconciliations.');
    }

    const existing = byIdempotencyKey ?? byHandoffNonce;

    if (existing !== undefined) {
      assertMatchingProgressLinkIdentity(existing, request);
      this.reconciliationsByIdempotencyKey.set(request.idempotencyKey, existing);
      this.reconciliationsByHandoffNonce.set(request.handoffNonce, existing);

      return {
        authoritativePlayerId: existing.authoritativePlayerId,
        progress: normalizeGameProgressSnapshot(existing.progress),
        alreadyProcessed: true,
        deduplicatedBy:
          byIdempotencyKey === undefined ? 'handoff-nonce' : 'idempotency-key',
      };
    }

    const serverProgress = this.progressByPlayerId.get(request.authoritativePlayerId)
      ?? createEmptyGameProgressSnapshot();
    const progress = mergeGameProgressSnapshots(serverProgress, request.guestProgress);
    const reconciliation: StoredProgressReconciliation = {
      authoritativePlayerId: request.authoritativePlayerId,
      guestId: request.guestId,
      progress,
    };

    this.progressByPlayerId.set(request.authoritativePlayerId, progress);
    this.reconciliationsByIdempotencyKey.set(request.idempotencyKey, reconciliation);
    this.reconciliationsByHandoffNonce.set(request.handoffNonce, reconciliation);

    return {
      authoritativePlayerId: request.authoritativePlayerId,
      progress: normalizeGameProgressSnapshot(progress),
      alreadyProcessed: false,
      deduplicatedBy: 'none',
    };
  }

  async getProgress(
    authoritativePlayerId: string,
  ): Promise<GameProgressSnapshot | undefined> {
    const progress = this.progressByPlayerId.get(
      normalizeIdentifier(authoritativePlayerId, 'authoritativePlayerId'),
    );

    return progress === undefined ? undefined : normalizeGameProgressSnapshot(progress);
  }
}

export function createInMemoryProgressLinkStore(
  initialProgress: readonly AuthoritativeProgressRecord[] = [],
): InMemoryProgressLinkStore {
  return new InMemoryProgressLinkStore(initialProgress);
}

export function createProgressLinkService(input: {
  readonly store: ProgressLinkStore;
  readonly handoffVerifier: ProgressHandoffVerifier;
  readonly progressVerifier: GuestProgressVerifier;
  readonly now?: () => string;
}): ProgressLinkService {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async reconcileGuestProgress(contextInput, handoffInput) {
      const context = normalizeServerResolvedPlayerContext(contextInput);
      const metadata = normalizeGuestProgressHandoffMetadata(handoffInput);
      await verifyProgressHandoff(input.handoffVerifier, context, metadata, now);
      const guestProgress = normalizeGameProgressSnapshot(handoffInput.guestProgress);
      const verifiedProgress = normalizeGameProgressSnapshot(
        await input.progressVerifier.verify({
          authoritativePlayerId: context.authoritativePlayerId,
          guestId: metadata.guestId,
          handoffNonce: metadata.handoffNonce,
          progress: guestProgress,
        }),
      );

      const result = await input.store.reconcile({
        authoritativePlayerId: context.authoritativePlayerId,
        ...metadata,
        guestProgress: verifiedProgress,
      });

      return normalizeReconcileGuestProgressResult(result, context.authoritativePlayerId);
    },
  };
}

export function createEmptyGameProgressSnapshot(): GameProgressSnapshot {
  return {
    completedIds: [],
    bestTimesMs: {},
    bestScores: {},
  };
}

export function normalizeGameProgressSnapshot(input: unknown): GameProgressSnapshot {
  assertRecord(input, 'GameProgressSnapshot');
  assertOnlyFields(input, snapshotFields, 'GameProgressSnapshot');

  if (!Array.isArray(input.completedIds)) {
    throw new Error('completedIds must be an array.');
  }

  assertCollectionLimit(
    input.completedIds.length,
    gameProgressLimits.maxCompletedIds,
    'completedIds',
  );

  const completedIds = [...new Set(Array.from(input.completedIds, (id, index) => (
    normalizeIdentifier(id, `completedIds[${String(index)}]`)
  )))].sort();
  const bestTimesMs = normalizeMetricMap(input.bestTimesMs, 'bestTimesMs', (value, label) => {
    if (value < 0) {
      throw new Error(`${label} must be greater than or equal to zero.`);
    }
  });
  const bestScores = normalizeMetricMap(input.bestScores, 'bestScores');

  if (input.activeProgress === undefined) {
    return {
      completedIds,
      bestTimesMs,
      bestScores,
    };
  }

  return {
    completedIds,
    bestTimesMs,
    bestScores,
    activeProgress: normalizeActiveProgress(input.activeProgress),
  };
}

export function mergeGameProgressSnapshots(
  serverInput: GameProgressSnapshot,
  guestInput: GameProgressSnapshot,
): GameProgressSnapshot {
  const server = normalizeGameProgressSnapshot(serverInput);
  const guest = normalizeGameProgressSnapshot(guestInput);
  const activeProgress = selectActiveProgress(server.activeProgress, guest.activeProgress);
  const completedIds = [...new Set([...server.completedIds, ...guest.completedIds])].sort();
  assertCollectionLimit(
    completedIds.length,
    gameProgressLimits.maxCompletedIds,
    'merged completedIds',
  );

  return {
    completedIds,
    bestTimesMs: mergeMetricMaps(server.bestTimesMs, guest.bestTimesMs, Math.min),
    bestScores: mergeMetricMaps(server.bestScores, guest.bestScores, Math.max),
    ...(activeProgress === undefined ? {} : { activeProgress }),
  };
}

function normalizeReconcileGuestProgressRequest(
  input: unknown,
): ReconcileGuestProgressRequest {
  assertRecord(input, 'ReconcileGuestProgressRequest');
  const metadata = normalizeGuestProgressHandoffMetadata(input);

  return {
    authoritativePlayerId: normalizeIdentifier(
      input.authoritativePlayerId,
      'authoritativePlayerId',
    ),
    ...metadata,
    guestProgress: normalizeGameProgressSnapshot(input.guestProgress),
  };
}

function normalizeServerResolvedPlayerContext(
  input: unknown,
): ServerResolvedPlayerContext {
  assertRecord(input, 'ServerResolvedPlayerContext');

  return {
    authoritativePlayerId: normalizeIdentifier(
      input.authoritativePlayerId,
      'authoritativePlayerId',
    ),
  };
}

function normalizeGuestProgressHandoffMetadata(
  input: unknown,
): GuestProgressHandoffMetadata {
  assertRecord(input, 'GuestProgressHandoffRequest');

  return {
    guestId: normalizeIdentifier(input.guestId, 'guestId'),
    handoffNonce: normalizeIdentifier(input.handoffNonce, 'handoffNonce'),
    idempotencyKey: normalizeIdentifier(input.idempotencyKey, 'idempotencyKey'),
  };
}

async function verifyProgressHandoff(
  verifier: ProgressHandoffVerifier,
  context: ServerResolvedPlayerContext,
  request: GuestProgressHandoffMetadata,
  now: () => string,
): Promise<void> {
  const handoff = await verifier.verify({ handoffNonce: request.handoffNonce });

  if (handoff === undefined) {
    throw new Error('Progress handoff is invalid or expired.');
  }

  const verified = normalizeVerifiedProgressHandoff(handoff);
  const currentTime = Date.parse(normalizeTimestamp(now(), 'now()'));
  const issuedAt = Date.parse(verified.issuedAt);
  const expiresAt = Date.parse(verified.expiresAt);

  if (
    verified.handoffNonce !== request.handoffNonce
    || verified.authoritativePlayerId !== context.authoritativePlayerId
    || verified.guestId !== request.guestId
    || issuedAt > currentTime
    || expiresAt <= issuedAt
    || expiresAt <= currentTime
  ) {
    throw new Error('Progress handoff is invalid or expired.');
  }
}

function normalizeReconcileGuestProgressResult(
  input: unknown,
  expectedPlayerId: string,
): ReconcileGuestProgressResult {
  assertRecord(input, 'ReconcileGuestProgressResult');
  const authoritativePlayerId = normalizeIdentifier(
    input.authoritativePlayerId,
    'result authoritativePlayerId',
  );

  if (authoritativePlayerId !== expectedPlayerId) {
    throw new Error('Progress link store returned a result for another player.');
  }

  if (typeof input.alreadyProcessed !== 'boolean') {
    throw new Error('Progress link store returned an invalid alreadyProcessed value.');
  }

  if (
    input.deduplicatedBy !== 'none'
    && input.deduplicatedBy !== 'idempotency-key'
    && input.deduplicatedBy !== 'handoff-nonce'
  ) {
    throw new Error('Progress link store returned an invalid deduplicatedBy value.');
  }

  if (input.alreadyProcessed !== (input.deduplicatedBy !== 'none')) {
    throw new Error('Progress link store returned inconsistent deduplication state.');
  }

  return {
    authoritativePlayerId,
    progress: normalizeGameProgressSnapshot(input.progress),
    alreadyProcessed: input.alreadyProcessed,
    deduplicatedBy: input.deduplicatedBy,
  };
}

function normalizeVerifiedProgressHandoff(input: unknown): VerifiedProgressHandoff {
  assertRecord(input, 'VerifiedProgressHandoff');

  return {
    handoffNonce: normalizeIdentifier(input.handoffNonce, 'verified handoffNonce'),
    authoritativePlayerId: normalizeIdentifier(
      input.authoritativePlayerId,
      'verified authoritativePlayerId',
    ),
    guestId: normalizeIdentifier(input.guestId, 'verified guestId'),
    issuedAt: normalizeTimestamp(input.issuedAt, 'verified issuedAt'),
    expiresAt: normalizeTimestamp(input.expiresAt, 'verified expiresAt'),
  };
}

function normalizeActiveProgress(input: unknown): ActiveGameProgress {
  assertRecord(input, 'activeProgress');
  assertOnlyFields(input, activeProgressFields, 'activeProgress');

  return {
    id: normalizeIdentifier(input.id, 'activeProgress.id'),
    updatedAt: normalizeTimestamp(input.updatedAt, 'activeProgress.updatedAt'),
    payload: normalizeProgressPayload(input.payload),
  };
}

function normalizeMetricMap(
  input: unknown,
  label: string,
  validate?: (value: number, fieldLabel: string) => void,
): Readonly<Record<string, number>> {
  assertRecord(input, label);
  const inputEntries = Object.entries(input);
  assertCollectionLimit(inputEntries.length, gameProgressLimits.maxMetricEntries, label);
  const entries = inputEntries.map(([key, value]) => {
    const normalizedKey = normalizeIdentifier(key, `${label} key`);

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be a finite number.`);
    }

    validate?.(value, `${label}.${key}`);
    return [normalizedKey, value] as const;
  });

  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.fromEntries(entries);
}

function mergeMetricMaps(
  server: Readonly<Record<string, number>>,
  guest: Readonly<Record<string, number>>,
  select: (serverValue: number, guestValue: number) => number,
): Readonly<Record<string, number>> {
  const keys = [...new Set([...Object.keys(server), ...Object.keys(guest)])].sort();
  assertCollectionLimit(keys.length, gameProgressLimits.maxMetricEntries, 'merged metric map');
  const mergedEntries: [string, number][] = [];

  for (const key of keys) {
    const serverValue = Object.hasOwn(server, key) ? server[key] : undefined;
    const guestValue = Object.hasOwn(guest, key) ? guest[key] : undefined;

    if (serverValue === undefined) {
      if (guestValue !== undefined) {
        mergedEntries.push([key, guestValue]);
      }

      continue;
    }

    if (guestValue === undefined) {
      mergedEntries.push([key, serverValue]);
      continue;
    }

    mergedEntries.push([key, select(serverValue, guestValue)]);
  }

  return Object.fromEntries(mergedEntries);
}

function selectActiveProgress(
  server: ActiveGameProgress | undefined,
  guest: ActiveGameProgress | undefined,
): ActiveGameProgress | undefined {
  if (server === undefined) {
    return guest;
  }

  if (guest === undefined) {
    return server;
  }

  return Date.parse(guest.updatedAt) > Date.parse(server.updatedAt) ? guest : server;
}

function normalizeProgressPayload(
  input: unknown,
): { readonly [key: string]: GameProgressValue } {
  assertRecord(input, 'activeProgress.payload');
  const normalized = normalizeGameProgressValue(
    input,
    'activeProgress.payload',
    new Set(),
    { nodes: 0, stringUnits: 0 },
    0,
  );

  if (!isGameProgressRecord(normalized)) {
    throw new Error('activeProgress.payload must be an object.');
  }

  return normalized;
}

function normalizeGameProgressValue(
  input: unknown,
  label: string,
  ancestors: Set<object>,
  budget: ProgressPayloadBudget,
  depth: number,
): GameProgressValue {
  if (depth > gameProgressLimits.maxPayloadDepth) {
    throw new Error(
      `activeProgress.payload must not exceed depth ${String(
        gameProgressLimits.maxPayloadDepth,
      )}.`,
    );
  }

  budget.nodes += 1;

  if (budget.nodes > gameProgressLimits.maxPayloadNodes) {
    throw new Error(
      `activeProgress.payload must not exceed ${String(
        gameProgressLimits.maxPayloadNodes,
      )} nodes.`,
    );
  }

  if (
    input === null
    || typeof input === 'boolean'
  ) {
    return input;
  }

  if (typeof input === 'string') {
    consumePayloadStringBudget(budget, input.length);
    return input;
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`${label} must contain only finite numbers.`);
    }

    return input;
  }

  if (typeof input !== 'object') {
    throw new Error(`${label} must be JSON-compatible.`);
  }

  if (ancestors.has(input)) {
    throw new Error(`${label} must not contain circular references.`);
  }

  ancestors.add(input);

  if (Array.isArray(input)) {
    assertCollectionLimit(
      input.length,
      gameProgressLimits.maxPayloadNodes,
      'activeProgress.payload array',
    );
    const output = Array.from(input, (value, index) => {
      return normalizeGameProgressValue(
        value,
        `${label}[${String(index)}]`,
        ancestors,
        budget,
        depth + 1,
      );
    });
    ancestors.delete(input);
    return output;
  }

  assertRecord(input, label);
  assertOwnPropertyLimit(input, gameProgressLimits.maxPayloadNodes, label);
  const entries = Object.entries(input)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => {
      const normalizedKey = normalizeIdentifier(key, `${label} key`);
      consumePayloadStringBudget(budget, normalizedKey.length);

      return [
        normalizedKey,
        normalizeGameProgressValue(value, `${label}.${key}`, ancestors, budget, depth + 1),
      ] as const;
    });
  ancestors.delete(input);
  return Object.fromEntries(entries);
}

function consumePayloadStringBudget(
  budget: ProgressPayloadBudget,
  stringUnits: number,
): void {
  budget.stringUnits += stringUnits;

  if (budget.stringUnits > gameProgressLimits.maxPayloadStringUnits) {
    throw new Error(
      `activeProgress.payload strings must not exceed ${String(
        gameProgressLimits.maxPayloadStringUnits,
      )} total characters.`,
    );
  }
}

function isGameProgressRecord(
  input: GameProgressValue,
): input is { readonly [key: string]: GameProgressValue } {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function assertMatchingProgressLinkIdentity(
  existing: StoredProgressReconciliation,
  request: ReconcileGuestProgressRequest,
): void {
  if (
    existing.authoritativePlayerId !== request.authoritativePlayerId
    || existing.guestId !== request.guestId
  ) {
    throw new Error('A reconciliation key cannot be reused for another player or guest.');
  }
}

function assertOnlyFields(
  input: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${label} contains unsupported field ${key}.`);
    }
  }
}

function assertCollectionLimit(length: number, maximum: number, label: string): void {
  if (length > maximum) {
    throw new Error(`${label} must not contain more than ${String(maximum)} entries.`);
  }
}

function assertOwnPropertyLimit(
  input: Record<string, unknown>,
  maximum: number,
  label: string,
): void {
  let propertyCount = 0;

  for (const key in input) {
    if (Object.hasOwn(input, key)) {
      propertyCount += 1;

      if (propertyCount > maximum) {
        throw new Error(`${label} must not contain more than ${String(maximum)} entries.`);
      }
    }
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function normalizeIdentifier(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty, trimmed string.`);
  }

  if (input.length > gameProgressLimits.maxIdentifierLength) {
    throw new Error(
      `${label} must not exceed ${String(gameProgressLimits.maxIdentifierLength)} characters.`,
    );
  }

  return input;
}

function normalizeTimestamp(input: unknown, label: string): string {
  const value = normalizeIdentifier(input, label);
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }

  return new Date(timestamp).toISOString();
}

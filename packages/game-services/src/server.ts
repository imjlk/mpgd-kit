import { implement, ORPCError } from '@orpc/server';
import { BodyLimitHandlerPlugin, RPCHandler } from '@orpc/server/fetch';

import { createAnalyticsReporter, type AnalyticsSink } from '@mpgd/analytics';
import {
  resolveAdPlacementPlatformId,
  resolveCatalogCurrencies,
  resolveProductPlatformId,
  type AdPlacements,
  type ProductCatalog,
} from '@mpgd/catalog';

import {
  gameServicesBackendEndpoints,
  type GameServicesBackendApi,
  type GameServicesBackendEndpoint,
  type GameServicesBackendTransport,
  type GameServicesBackendTransportRequest,
  type GameServicesBackendTransportResponse,
} from './client.js';
import {
  resolveCommerceStoreId,
  type CommerceEvidenceRegistry,
} from './commerce-evidence-registry.js';
import {
  createPurchaseHolderEvidenceVerificationId,
  findEntitlementRevocationsChunked,
  findPurchaseWideRevocation,
  holderRevocationEvidenceId,
  isEntitlementGrantReversed,
  isRestoredAcrossPlayers,
  listPurchaseHolders,
  readPurchaseLedgerStatuses,
  readPurchaseVerificationId,
  RevocationKeyConflictError,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import {
  assertPlayerDataErasureInput,
  createRetainedLedgerEntryId,
  detachRetainedLedgerPayload,
  isRetainedPlayerId,
  type PlayerDataErasureInput,
  type PlayerDataErasureResult,
} from './account-deletion.js';
import { gameServicesContract, type GameServicesHealthResponse } from './contract.js';
import {
  createRejectingGameServicesEvidenceVerifier,
  type EvidenceVerificationDecision,
  type FinalizePurchaseGrantInput,
  type GameServicesEvidenceVerifier,
  type GameServicesPurchaseGrantFinalizer,
} from './evidence-verification.js';
import {
  assertClaimAdRewardRequest,
  assertClaimAdRewardResponse,
  assertEntitlementLedgerGrant,
  assertEntitlementLedgerNote,
  assertEntitlementLedgerResult,
  assertEntitlementLedgerRevocation,
  assertEntitlementRevocationTransaction,
  assertGameServicesDeploymentTarget,
  assertLeaderboardScoreTransaction,
  assertProductGrantTransaction,
  assertPurchaseGrantFinalization,
  assertRecordLeaderboardScoreRequest,
  assertRecordLeaderboardScoreResponse,
  assertVerifyPurchaseRequest,
  assertVerifyPurchaseResponse,
  type ClaimAdRewardRequest,
  type ClaimAdRewardResponse,
  type EntitlementLedgerGrant,
  type EntitlementLedgerNote,
  type EntitlementLedgerPayload,
  type EntitlementLedgerResult,
  type EntitlementLedgerRevocation,
  type EntitlementRevocationTransaction,
  type GameServicesAdRewardTarget,
  type GameServicesStoreTarget,
  type LeaderboardScoreTransaction,
  type ProductGrantTransaction,
  type PurchaseGrantFinalization,
  type PurchaseLedgerStatusRequest,
  type RecordLeaderboardScoreRequest,
  type RecordLeaderboardScoreResponse,
  type VerifyPurchaseRequest,
  type VerifyPurchaseResponse,
} from './types.js';
import {
  resolvePurchaseRestoreSharingPolicy,
  type PurchaseRestoreSharingPolicy,
  type ResolvedPurchaseRestoreSharingPolicy,
} from './purchase-sharing.js';
import { gameServicesRequestLimits, GameServicesRequestValidationError } from './validation.js';

export { gameServicesRequestLimits, GameServicesRequestValidationError } from './validation.js';
export {
  listActiveEntitlementTransactions,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
  RevocationKeyConflictError,
  type RevokeEntitlementGrantResult,
} from './commerce-ledger.js';

type CorsHeaders = Record<string, string>;

export interface CreateGameServicesBackendInput {
  readonly catalog: ProductCatalog;
  readonly placements: AdPlacements;
  /** Trusted deployment-config bindings keyed by the request's platform target. */
  readonly deploymentTargetBindings?: GameServicesDeploymentTargetBindings;
  readonly store?: GameServicesStore;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
  readonly version?: string;
  readonly evidenceVerifier?: GameServicesEvidenceVerifier;
  readonly evidenceVerificationTimeoutMs?: number;
  readonly purchaseGrantFinalizationTimeoutMs?: number;
  readonly purchaseGrantFinalizer?: GameServicesPurchaseGrantFinalizer;
  /**
   * The commerce v2 evidence registry (RFC "Evidence registry"). With it,
   * purchase evidence is routed by `evidence.schema` to the registered
   * verifier and finalizer, `purchaseGrantFinalizer` is not consulted for
   * purchases, `evidenceVerifier` serves rewarded ads only, and the backend
   * publishes `getCommerceCapabilities`. Without it the backend keeps the v1
   * behaviour: one `evidenceVerifier` and one `purchaseGrantFinalizer` for
   * every purchase, and no capabilities endpoint.
   */
  readonly commerceEvidenceRegistry?: CommerceEvidenceRegistry;
  /**
   * How a restored non-consumable that the store binds to another player is
   * answered (RFC "Restore sharing"). `{ mode: 'share' }` grants the
   * restoring player its own entitlement while earlier holders keep theirs,
   * up to `maxHolders` (5) players per purchase. Defaults to
   * `{ mode: 'refuse' }`, which keeps answering the binding mismatch; the
   * reference Worker shares by default (`GAME_SERVICES_RESTORE_SHARING`).
   */
  readonly restoreSharing?: PurchaseRestoreSharingPolicy;
  /**
   * Receives unexpected (non-validation) failures such as store errors before the
   * transport answers with the generic `INTERNAL_ERROR` code. Defaults to `console.error`.
   * The hook is diagnostics only: if it throws or returns a rejecting promise, the failure
   * is logged and the generic error response is still returned.
   */
  readonly onInternalError?: GameServicesInternalErrorHandler;
}

export type GameServicesInternalErrorHandler = (error: unknown) => void;

export type GameServicesDeploymentTargetBindings = Readonly<
  Partial<Record<GameServicesAdRewardTarget | GameServicesStoreTarget, string>>
>;

export interface GameServicesBackendApiHandler {
  readonly version?: string;
  handle(
    request: GameServicesBackendTransportRequest,
  ): Promise<GameServicesBackendTransportResponse>;
}

/** Stable error codes emitted by the backend API handler and the HTTP fetch handler. */
export type GameServicesBackendErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'METHOD_NOT_ALLOWED'
  | 'UNKNOWN_ENDPOINT'
  | 'INTERNAL_ERROR';

export interface GameServicesBackendErrorResponse {
  readonly error: GameServicesBackendErrorCode;
  /** Present only for `INVALID_REQUEST`; never carries internal failure details. */
  readonly message?: string;
}

export interface GameServicesStore {
  recordEntitlementGrant(input: EntitlementLedgerGrant): Promise<EntitlementLedgerResult>;
  findEntitlementTransactionByIdempotency?(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly playerId: string;
    readonly idempotencyKey: string;
  }): Promise<ProductGrantTransaction | undefined>;
  findEntitlementTransactionByEvidenceVerificationId?(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  }): Promise<ProductGrantTransaction | undefined>;
  findEntitlementTransactionByPlatformEvidence?(input: EntitlementPlatformEvidenceIdentity):
    Promise<ProductGrantTransaction | undefined>;
  getEntitlementTransaction(
    ledgerEntryId: string,
  ): Promise<ProductGrantTransaction | undefined>;
  listEntitlementTransactions(): Promise<readonly ProductGrantTransaction[]>;
  /** The grants with the given ids (at most `ledgerReadChunkSize` per call), any order. */
  getEntitlementTransactions?(
    ledgerEntryIds: readonly string[],
  ): Promise<readonly ProductGrantTransaction[]>;
  /**
   * Appends a `revoke` entry (RFC "Revocation and expiry entries"). A grant is
   * reversed once: a second revocation of the same grant, under any key,
   * answers the first entry with `alreadyProcessed: true`, as does a replay of
   * the same `(playerId, idempotencyKey)`; a key reused for another grant
   * throws `RevocationKeyConflictError`, a reused `evidenceVerificationId`
   * throws `EvidenceAlreadyProcessedError`, and an unknown grant throws.
   * Optional: a store without it answers every ledger status read as
   * `active` and refuses `revokeEntitlementGrant`.
   */
  recordEntitlementRevocation?(
    input: EntitlementLedgerRevocation,
  ): Promise<EntitlementLedgerResult>;
  /**
   * The revocations that reverse any of the given grant entries (at most
   * `ledgerReadChunkSize` per call), oldest first.
   */
  findEntitlementRevocations?(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementRevocationTransaction[]>;
  /**
   * The grants of `source` whose `evidenceVerificationId` starts with
   * `prefix` (at most `limit`), any order: restore sharing lists a purchase's
   * shared grants with it in one indexed read (RFC "Restore sharing").
   * Optional: without it the shares are read slot by slot.
   */
  findEntitlementTransactionsByEvidencePrefix?(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly prefix: string;
    readonly limit: number;
  }): Promise<readonly ProductGrantTransaction[]>;
  /**
   * Keeps a ledger note (a store event that grants nothing), once per
   * `noteId`: a replay answers `alreadyRecorded: true` and keeps the first.
   * Optional: a store without it still answers the event, with a log only.
   */
  recordEntitlementNote?(
    input: EntitlementLedgerNote,
  ): Promise<{ readonly alreadyRecorded: boolean }>;
  /** The notes about the given grants, oldest first. */
  findEntitlementNotes?(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementLedgerNote[]>;
  recordLeaderboardScore(
    input: RecordLeaderboardScoreRequest,
    options?: { readonly recordedAt?: string },
  ): Promise<RecordLeaderboardScoreResponse>;
  getLeaderboardTransaction(
    ledgerEntryId: string,
  ): Promise<LeaderboardScoreTransaction | undefined>;
  listLeaderboardTransactions(): Promise<readonly LeaderboardScoreTransaction[]>;
  /**
   * Account deletion (`./account-deletion`): deletes the player's grants,
   * revocations, notes, and scores, except purchase grants and what reverses
   * or annotates them, which are kept detached from the player (new ids,
   * `retainedPlayerId`, no `playerId` payload key). Idempotent. Optional: the
   * Worker's D1 deployment erases its tables in one batch instead.
   */
  erasePlayerData?(input: PlayerDataErasureInput): Promise<PlayerDataErasureResult>;
}

export interface EntitlementPlatformEvidenceIdentity {
  readonly source: Extract<EntitlementLedgerGrant['source'], 'purchase' | 'ad_reward'>;
  readonly target: string;
  readonly platformEvidenceId: string;
}

export interface CreateGameServicesFetchHandlerOptions {
  readonly corsHeaders?: CorsHeaders;
  readonly healthPath?: string;
  readonly version?: string;
  /** Request bodies above this byte size are rejected with 413. */
  readonly maxBodyBytes?: number;
}

export interface CreateGameServicesRouterOptions {
  readonly onInternalError?: GameServicesInternalErrorHandler;
}

export interface CreateGameServicesRpcFetchHandlerOptions
  extends CreateGameServicesFetchHandlerOptions {
  readonly prefix?: string;
}

export interface GameServicesOrpcContext {
  readonly request?: Request;
}

export class InMemoryGameServicesStore implements GameServicesStore {
  private readonly entitlementTransactionsByKey = new Map<string, ProductGrantTransaction>();
  private readonly entitlementTransactionsByEvidence = new Map<string, ProductGrantTransaction>();
  private readonly entitlementTransactionsByPlatformEvidence = new Map<
    string,
    ProductGrantTransaction
  >();
  private readonly entitlementTransactionsById = new Map<string, ProductGrantTransaction>();
  private readonly revocationsByKey = new Map<string, EntitlementRevocationTransaction>();
  private readonly revocationsByGrant = new Map<string, EntitlementRevocationTransaction>();
  private readonly revocationsByEvidence = new Map<string, EntitlementRevocationTransaction>();
  private readonly notesById = new Map<string, EntitlementLedgerNote>();
  private readonly leaderboardTransactionsByRun = new Map<string, LeaderboardScoreTransaction>();
  private readonly leaderboardTransactionsById = new Map<string, LeaderboardScoreTransaction>();

  async recordEntitlementGrant(
    input: EntitlementLedgerGrant,
  ): Promise<EntitlementLedgerResult> {
    const grant = assertEntitlementLedgerGrant(input);
    const key = createEntitlementIdempotencyKey(grant);
    const existing = this.entitlementTransactionsByKey.get(key);

    if (existing !== undefined) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: existing.ledgerEntryId,
        alreadyProcessed: true,
      });
    }

    if (grant.evidenceVerificationId !== undefined) {
      const evidenceKey = createEntitlementEvidenceKey({
        source: grant.source,
        evidenceVerificationId: grant.evidenceVerificationId,
      });

      if (this.entitlementTransactionsByEvidence.has(evidenceKey)) {
        throw new EvidenceAlreadyProcessedError();
      }
    }

    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
    if (
      platformEvidenceIdentity !== undefined
      && this.entitlementTransactionsByPlatformEvidence.has(
        createEntitlementPlatformEvidenceKey(platformEvidenceIdentity),
      )
    ) {
      throw new EvidenceAlreadyProcessedError();
    }

    const transaction = createEntitlementTransaction(grant);
    // Indexes it by idempotency key, ledger entry id, and evidence identities.
    this.rememberEntitlementTransaction(transaction);

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
    });
  }

  async findEntitlementTransactionByIdempotency(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly playerId: string;
    readonly idempotencyKey: string;
  }): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByKey.get(createEntitlementIdempotencyKey(input));
  }

  async findEntitlementTransactionByEvidenceVerificationId(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  }): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByEvidence.get(createEntitlementEvidenceKey(input));
  }

  async findEntitlementTransactionsByEvidencePrefix(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly prefix: string;
    readonly limit: number;
  }): Promise<readonly ProductGrantTransaction[]> {
    const found: ProductGrantTransaction[] = [];
    for (const transaction of this.entitlementTransactionsById.values()) {
      if (
        transaction.source === input.source
        && transaction.evidenceVerificationId?.startsWith(input.prefix) === true
      ) {
        found.push(transaction);
        if (found.length >= input.limit) {
          break;
        }
      }
    }
    return found;
  }

  async findEntitlementTransactionByPlatformEvidence(
    input: EntitlementPlatformEvidenceIdentity,
  ): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByPlatformEvidence.get(
      createEntitlementPlatformEvidenceKey(input),
    );
  }

  async getEntitlementTransaction(
    ledgerEntryId: string,
  ): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsById.get(ledgerEntryId);
  }

  async listEntitlementTransactions(): Promise<readonly ProductGrantTransaction[]> {
    return [...this.entitlementTransactionsById.values()];
  }

  async getEntitlementTransactions(
    ledgerEntryIds: readonly string[],
  ): Promise<readonly ProductGrantTransaction[]> {
    const found: ProductGrantTransaction[] = [];
    for (const ledgerEntryId of new Set(ledgerEntryIds)) {
      const transaction = this.entitlementTransactionsById.get(ledgerEntryId);
      if (transaction !== undefined) {
        found.push(transaction);
      }
    }
    return found;
  }

  async recordEntitlementRevocation(
    input: EntitlementLedgerRevocation,
  ): Promise<EntitlementLedgerResult> {
    const revocation = assertEntitlementLedgerRevocation(input);
    const key = createRevocationIdempotencyKey(revocation);
    const byKey = this.revocationsByKey.get(key);
    if (byKey !== undefined) {
      if (byKey.revokesLedgerEntryId !== revocation.revokesLedgerEntryId) {
        throw new RevocationKeyConflictError();
      }
      return assertEntitlementLedgerResult({
        ledgerEntryId: byKey.ledgerEntryId,
        alreadyProcessed: true,
      });
    }
    const byGrant = this.revocationsByGrant.get(revocation.revokesLedgerEntryId);
    if (byGrant !== undefined) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: byGrant.ledgerEntryId,
        alreadyProcessed: true,
      });
    }
    if (
      revocation.evidenceVerificationId !== undefined
      && this.revocationsByEvidence.has(revocation.evidenceVerificationId)
    ) {
      throw new EvidenceAlreadyProcessedError();
    }
    if (!this.entitlementTransactionsById.has(revocation.revokesLedgerEntryId)) {
      // The D1 store's foreign key refuses the same write.
      throw new Error('Entitlement revocation references an unknown grant.');
    }

    const transaction = assertEntitlementRevocationTransaction({
      ...revocation,
      ledgerEntryId: createRevocationLedgerEntryId(revocation),
    });
    this.rememberEntitlementRevocation(transaction);

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
    });
  }

  async findEntitlementRevocations(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementRevocationTransaction[]> {
    const wanted = new Set(input.ledgerEntryIds);
    return [...this.revocationsByGrant.values()]
      .filter((revocation) => wanted.has(revocation.revokesLedgerEntryId))
      .sort((left, right) => left.revokedAt.localeCompare(right.revokedAt));
  }

  async recordEntitlementNote(
    input: EntitlementLedgerNote,
  ): Promise<{ readonly alreadyRecorded: boolean }> {
    const note = assertEntitlementLedgerNote(input);
    if (this.notesById.has(note.noteId)) {
      return { alreadyRecorded: true };
    }
    if (!this.entitlementTransactionsById.has(note.ledgerEntryId)) {
      throw new Error('Entitlement note references an unknown grant.');
    }
    this.notesById.set(note.noteId, note);
    return { alreadyRecorded: false };
  }

  async findEntitlementNotes(input: {
    readonly ledgerEntryIds: readonly string[];
  }): Promise<readonly EntitlementLedgerNote[]> {
    const wanted = new Set(input.ledgerEntryIds);
    return [...this.notesById.values()]
      .filter((note) => wanted.has(note.ledgerEntryId))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  async recordLeaderboardScore(
    input: RecordLeaderboardScoreRequest,
    options: { readonly recordedAt?: string } = {},
  ): Promise<RecordLeaderboardScoreResponse> {
    const request = assertRecordLeaderboardScoreRequest(input);
    const runKey = createLeaderboardRunKey(request);
    const existing = this.leaderboardTransactionsByRun.get(runKey);

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
      ledgerEntryId: createLeaderboardLedgerEntryId(request),
      recordedAt: options.recordedAt ?? new Date().toISOString(),
    });

    this.leaderboardTransactionsByRun.set(runKey, transaction);
    this.leaderboardTransactionsById.set(transaction.ledgerEntryId, transaction);

    return assertRecordLeaderboardScoreResponse({
      submitted: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
      rank: this.rankFor(transaction),
    });
  }

  async getLeaderboardTransaction(
    ledgerEntryId: string,
  ): Promise<LeaderboardScoreTransaction | undefined> {
    return this.leaderboardTransactionsById.get(ledgerEntryId);
  }

  async listLeaderboardTransactions(): Promise<readonly LeaderboardScoreTransaction[]> {
    return this.sortedLeaderboardTransactions();
  }

  async erasePlayerData(input: PlayerDataErasureInput): Promise<PlayerDataErasureResult> {
    const { playerId, retainedPlayerId } = assertPlayerDataErasureInput(input);
    let deleted = 0;
    let retained = 0;
    const grants = [...this.entitlementTransactionsById.values()]
      .filter((transaction) => transaction.playerId === playerId);
    const grantIds = new Set(grants.map((grant) => grant.ledgerEntryId));
    const keptGrantIds = new Map<string, string>();
    for (const grant of grants) {
      this.forgetEntitlementTransaction(grant);
      if (grant.source !== 'purchase') {
        deleted += 1;
        continue;
      }
      const ledgerEntryId = createRetainedLedgerEntryId();
      keptGrantIds.set(grant.ledgerEntryId, ledgerEntryId);
      this.rememberEntitlementTransaction(
        assertProductGrantTransaction({
          ...grant,
          ledgerEntryId,
          playerId: retainedPlayerId,
          idempotencyKey: ledgerEntryId,
          payload: detachRetainedLedgerPayload(grant.payload),
        }),
      );
      retained += 1;
    }
    const keptRevocationIds = new Map<string, string>();
    const deletedRevocationIds = new Set<string>();
    for (const revocation of [...this.revocationsByGrant.values()]) {
      if (revocation.playerId !== playerId && !grantIds.has(revocation.revokesLedgerEntryId)) {
        continue;
      }
      this.forgetEntitlementRevocation(revocation);
      // A revocation is kept with the grant it reverses, whoever wrote it.
      const keptGrantId = keptGrantIds.get(revocation.revokesLedgerEntryId)
        ?? (this.entitlementTransactionsById.has(revocation.revokesLedgerEntryId)
          ? revocation.revokesLedgerEntryId
          : undefined);
      if (keptGrantId === undefined) {
        deletedRevocationIds.add(revocation.ledgerEntryId);
        deleted += 1;
        continue;
      }
      const ledgerEntryId = createRetainedLedgerEntryId();
      keptRevocationIds.set(revocation.ledgerEntryId, ledgerEntryId);
      const kept = assertEntitlementRevocationTransaction({
        ...revocation,
        ledgerEntryId,
        playerId: retainedPlayerId,
        revokesLedgerEntryId: keptGrantId,
        idempotencyKey: ledgerEntryId,
        payload: detachRetainedLedgerPayload(revocation.payload),
      });
      this.rememberEntitlementRevocation(kept);
      retained += 1;
    }
    for (const note of [...this.notesById.values()]) {
      // Also a note (of another player) pointing at a revocation rewritten
      // above, as the D1 eraser selects it.
      const aboutKeptRevocation = note.revocationLedgerEntryId !== undefined
        && keptRevocationIds.has(note.revocationLedgerEntryId);
      if (note.revocationLedgerEntryId !== undefined && deletedRevocationIds.has(note.revocationLedgerEntryId)) {
        // It points at a revocation deleted with the player's other grant.
        this.notesById.delete(note.noteId);
        deleted += 1;
        continue;
      }
      if (note.playerId !== playerId && !grantIds.has(note.ledgerEntryId) && !aboutKeptRevocation) {
        continue;
      }
      const keptGrantId = keptGrantIds.get(note.ledgerEntryId)
        ?? (this.entitlementTransactionsById.has(note.ledgerEntryId) ? note.ledgerEntryId : undefined);
      if (keptGrantId === undefined) {
        this.notesById.delete(note.noteId);
        deleted += 1;
        continue;
      }
      const revocationLedgerEntryId = note.revocationLedgerEntryId === undefined
        ? undefined
        : (keptRevocationIds.get(note.revocationLedgerEntryId) ?? note.revocationLedgerEntryId);
      this.notesById.set(
        note.noteId,
        assertEntitlementLedgerNote({
          noteId: note.noteId,
          kind: note.kind,
          playerId: retainedPlayerId,
          ledgerEntryId: keptGrantId,
          ...(revocationLedgerEntryId === undefined ? {} : { revocationLedgerEntryId }),
          recordedAt: note.recordedAt,
          payload: detachRetainedLedgerPayload(note.payload),
        }),
      );
      retained += 1;
    }
    for (const transaction of [...this.leaderboardTransactionsById.values()]) {
      if (transaction.playerId !== playerId) {
        continue;
      }
      this.leaderboardTransactionsById.delete(transaction.ledgerEntryId);
      this.leaderboardTransactionsByRun.delete(createLeaderboardRunKey(transaction));
      deleted += 1;
    }
    return { deleted, retained };
  }

  private rememberEntitlementRevocation(revocation: EntitlementRevocationTransaction): void {
    this.revocationsByKey.set(createRevocationIdempotencyKey(revocation), revocation);
    this.revocationsByGrant.set(revocation.revokesLedgerEntryId, revocation);
    if (revocation.evidenceVerificationId !== undefined) {
      this.revocationsByEvidence.set(revocation.evidenceVerificationId, revocation);
    }
  }

  private forgetEntitlementRevocation(revocation: EntitlementRevocationTransaction): void {
    this.revocationsByKey.delete(createRevocationIdempotencyKey(revocation));
    this.revocationsByGrant.delete(revocation.revokesLedgerEntryId);
    if (revocation.evidenceVerificationId !== undefined) {
      this.revocationsByEvidence.delete(revocation.evidenceVerificationId);
    }
  }

  private forgetEntitlementTransaction(transaction: ProductGrantTransaction): void {
    this.entitlementTransactionsByKey.delete(createEntitlementIdempotencyKey(transaction));
    this.entitlementTransactionsById.delete(transaction.ledgerEntryId);
    if (transaction.evidenceVerificationId !== undefined) {
      this.entitlementTransactionsByEvidence.delete(
        createEntitlementEvidenceKey({
          source: transaction.source,
          evidenceVerificationId: transaction.evidenceVerificationId,
        }),
      );
    }
    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(transaction);
    if (platformEvidenceIdentity !== undefined) {
      this.entitlementTransactionsByPlatformEvidence.delete(
        createEntitlementPlatformEvidenceKey(platformEvidenceIdentity),
      );
    }
  }

  private rememberEntitlementTransaction(transaction: ProductGrantTransaction): void {
    this.entitlementTransactionsByKey.set(
      createEntitlementIdempotencyKey(transaction),
      transaction,
    );
    this.entitlementTransactionsById.set(transaction.ledgerEntryId, transaction);
    if (transaction.evidenceVerificationId !== undefined) {
      this.entitlementTransactionsByEvidence.set(
        createEntitlementEvidenceKey({
          source: transaction.source,
          evidenceVerificationId: transaction.evidenceVerificationId,
        }),
        transaction,
      );
    }
    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(transaction);
    if (platformEvidenceIdentity !== undefined) {
      this.entitlementTransactionsByPlatformEvidence.set(
        createEntitlementPlatformEvidenceKey(platformEvidenceIdentity),
        transaction,
      );
    }
  }

  private rankFor(transaction: LeaderboardScoreTransaction): number {
    return (
      this.sortedLeaderboardTransactions()
        .filter((candidate) => candidate.leaderboardId === transaction.leaderboardId)
        .findIndex((candidate) => candidate.ledgerEntryId === transaction.ledgerEntryId) + 1
    );
  }

  private sortedLeaderboardTransactions(): readonly LeaderboardScoreTransaction[] {
    return [...this.leaderboardTransactionsById.values()].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.submittedAt.localeCompare(right.submittedAt);
    });
  }
}

export class EvidenceAlreadyProcessedError extends Error {
  constructor() {
    super('Evidence verification identity has already been processed.');
    this.name = 'EvidenceAlreadyProcessedError';
  }
}

export function createInMemoryGameServicesStore(): InMemoryGameServicesStore {
  return new InMemoryGameServicesStore();
}

export function createGameServicesBackend(
  input: CreateGameServicesBackendInput,
): GameServicesBackendApi {
  assertDeclaredCatalogCurrencies(input.catalog, input.placements);
  const store = input.store ?? createInMemoryGameServicesStore();
  const now = input.now ?? (() => new Date().toISOString());
  const version = input.version ?? '0.0.0';
  const evidenceVerifier = input.evidenceVerifier ?? createRejectingGameServicesEvidenceVerifier();
  const evidenceVerificationTimeoutMs = resolveEvidenceVerificationTimeout(
    input.evidenceVerificationTimeoutMs,
  );
  const purchaseGrantFinalizationTimeoutMs = resolvePurchaseGrantFinalizationTimeout(
    input.purchaseGrantFinalizationTimeoutMs,
  );
  const deploymentTargetBindings = resolveDeploymentTargetBindings(input.deploymentTargetBindings);
  const restoreSharing = resolvePurchaseRestoreSharingPolicy(input.restoreSharing);
  const analytics = createAnalyticsReporter({
    target: 'server',
    sessionId: input.analyticsSessionId ?? 'game-services',
    now,
    ...(input.analytics === undefined ? {} : { sink: input.analytics }),
  });
  const registry = input.commerceEvidenceRegistry;
  if (registry !== undefined && input.purchaseGrantFinalizer !== undefined) {
    throw new Error(
      'createGameServicesBackend: pass the v1 purchaseGrantFinalizer as the registry '
        + 'unregistered.finalizer instead of next to commerceEvidenceRegistry; with a registry '
        + 'the entries own finalization.',
    );
  }
  // With a registry, purchase evidence is routed by schema and the registry's
  // finalizer owns post-grant finalization; the configured verifier keeps
  // serving rewarded ads. Without one, the v1 single verifier and finalizer
  // serve every purchase unchanged.
  const purchaseEvidenceVerifier: GameServicesEvidenceVerifier = registry === undefined
    ? evidenceVerifier
    : {
        verifyPurchase: (verificationInput) => registry.verifyPurchase(verificationInput),
        verifyAdReward: (verificationInput) => evidenceVerifier.verifyAdReward(verificationInput),
      };
  const purchaseGrantFinalizer = registry === undefined
    ? input.purchaseGrantFinalizer
    : registry.finalizer;

  return {
    version,
    purchases: {
      async verifyPurchase(request) {
        return verifyPurchaseWithStore(request, {
          catalog: input.catalog,
          store,
          now,
          evidenceVerifier: purchaseEvidenceVerifier,
          evidenceVerificationTimeoutMs,
          purchaseGrantFinalizationTimeoutMs,
          deploymentTargetBindings,
          restoreSharing,
          ...(purchaseGrantFinalizer === undefined
            ? {}
            : { purchaseGrantFinalizer }),
          ...(registry === undefined ? {} : { registry }),
        }, async (verification) => {
          await analytics.track({
            name: verification.verified ? 'purchase_granted'
              : verification.disposition === 'pending' ? 'purchase_pending' : 'purchase_rejected',
            properties: {
              target: request.target,
              store: resolveCommerceStoreId(request),
              playerId: request.playerId,
              productId: request.productId,
              ledgerEntryId: verification.ledgerEntryId,
              alreadyProcessed: verification.alreadyProcessed,
              reason: verification.reason,
              finalizationStatus: verification.finalization?.status,
              finalizationAction: verification.finalization?.action,
              finalizationAlreadyCompleted: verification.finalization?.alreadyCompleted,
              finalizationReason: verification.finalization?.reason,
              restoredAcrossPlayers: verification.restoredAcrossPlayers,
            },
          });
        });
      },
      async getPurchaseLedgerStatus(request) {
        return readPurchaseLedgerStatuses(store, request);
      },
      ...(registry === undefined
        ? {}
        : {
            async getCommerceCapabilities() {
              return registry.getCapabilities();
            },
          }),
    },
    adRewards: {
      async claimAdReward(request) {
        return claimAdRewardWithStore(request, {
          placements: input.placements,
          store,
          now,
          evidenceVerifier,
          evidenceVerificationTimeoutMs,
          deploymentTargetBindings,
        }, async (claim) => {
          await analytics.track({
            name: claim.granted ? 'rewarded_ad_granted'
              : claim.disposition === 'pending' ? 'rewarded_ad_pending' : 'rewarded_ad_rejected',
            properties: {
              target: request.target,
              playerId: request.playerId,
              placementId: request.placementId,
              ledgerEntryId: claim.ledgerEntryId,
              alreadyProcessed: claim.alreadyProcessed,
              reason: claim.reason,
            },
          });
        });
      },
    },
    leaderboard: {
      async recordScore(request) {
        const record = await recordLeaderboardScoreWithStore(request, {
          store,
          now,
        });

        await analytics.track({
          name: 'leaderboard_recorded',
          properties: {
            target: request.target,
            playerId: request.playerId,
            leaderboardId: request.leaderboardId,
            score: request.score,
            ledgerEntryId: record.ledgerEntryId,
            alreadyProcessed: record.alreadyProcessed,
            rank: record.rank,
          },
        });

        return record;
      },
    },
  };
}

/**
 * Every grant and reward the backend can write comes from the catalog or the
 * placements, so an undeclared currency is a configuration error at startup
 * rather than a rejected ledger write on the first purchase.
 */
function assertDeclaredCatalogCurrencies(catalog: ProductCatalog, placements: AdPlacements): void {
  const currencies = resolveCatalogCurrencies(catalog);
  for (const product of catalog.products) {
    if (product.grant.type === 'currency' && !currencies.has(product.grant.currency)) {
      throw new Error(
        `Product ${product.id} grants undeclared currency ${product.grant.currency}; `
          + `declared currencies: ${[...currencies].join(', ')}.`,
      );
    }
  }
  for (const placement of placements.placements) {
    if (placement.reward?.type === 'currency' && !currencies.has(placement.reward.currency)) {
      throw new Error(
        `Ad placement ${placement.id} rewards undeclared currency ${placement.reward.currency}; `
          + `declared currencies: ${[...currencies].join(', ')}.`,
      );
    }
  }
}

export function createGameServicesBackendApiHandler(
  input: CreateGameServicesBackendInput,
): GameServicesBackendApiHandler {
  const backend = createGameServicesBackend(input);

  return {
    ...(backend.version === undefined ? {} : { version: backend.version }),
    async handle(request) {
      if (request.method !== 'POST') {
        return errorResponse(405, 'METHOD_NOT_ALLOWED');
      }

      try {
        return await routeGameServicesRequest(request.endpoint, request.body, backend);
      } catch (error) {
        if (error instanceof GameServicesRequestValidationError) {
          return errorResponse(400, 'INVALID_REQUEST', error.message);
        }

        reportInternalError(input.onInternalError, error);
        return errorResponse(500, 'INTERNAL_ERROR');
      }
    },
  };
}

/**
 * Invokes the diagnostics hook in isolation: a throwing hook, or one that returns a
 * rejecting promise (assignable to the `void`-returning handler type), must never replace
 * the generic `INTERNAL_ERROR` response or escape as an unhandled rejection.
 */
function reportInternalError(
  handler: GameServicesInternalErrorHandler | undefined,
  error: unknown,
): void {
  if (handler === undefined) {
    console.error('GameServices backend internal error:', error);
    return;
  }

  try {
    const result: unknown = handler(error);

    if (isPromiseLike(result)) {
      result.then(undefined, (hookError: unknown) => {
        console.error('GameServices backend onInternalError handler rejected:', hookError);
      });
    }
  } catch (hookError) {
    console.error('GameServices backend onInternalError handler threw:', hookError);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

export function createInProcessGameServicesBackendTransport(
  handler: GameServicesBackendApiHandler,
): GameServicesBackendTransport {
  return {
    async send(request) {
      return handler.handle(request) as Promise<GameServicesBackendTransportResponse<unknown>>;
    },
  };
}

export function createGameServicesRouter(
  backend: GameServicesBackendApi,
  options: CreateGameServicesRouterOptions = {},
) {
  const contract = implement(gameServicesContract).$context<GameServicesOrpcContext>();
  // oRPC already hides non-ORPCError messages behind INTERNAL_SERVER_ERROR; validation
  // failures are surfaced as BAD_REQUEST so clients get a stable 400 instead of a 500.
  const invoke = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      if (error instanceof GameServicesRequestValidationError) {
        throw new ORPCError('BAD_REQUEST', { message: error.message });
      }

      reportInternalError(options.onInternalError, error);
      throw error;
    }
  };

  return contract.router({
    health: contract.health.handler(() => createHealthResponse(backend.version)),
    commerce: contract.commerce.router({
      verifyPurchase: contract.commerce.verifyPurchase.handler(({ input }) => {
        return invoke(() => backend.purchases.verifyPurchase(input));
      }),
      getPurchaseLedgerStatus: contract.commerce.getPurchaseLedgerStatus.handler(({ input }) => {
        const read = backend.purchases.getPurchaseLedgerStatus;
        if (read === undefined) {
          throw new ORPCError('NOT_FOUND', { message: 'This backend has no ledger status read.' });
        }
        return invoke(() => read.call(backend.purchases, input));
      }),
      getCapabilities: contract.commerce.getCapabilities.handler(() => {
        const read = backend.purchases.getCommerceCapabilities;
        if (read === undefined) {
          throw new ORPCError('NOT_FOUND', {
            message: 'This backend publishes no commerce capabilities.',
          });
        }
        return invoke(() => read.call(backend.purchases));
      }),
    }),
    ads: contract.ads.router({
      claimReward: contract.ads.claimReward.handler(({ input }) => {
        return invoke(() => backend.adRewards.claimAdReward(input));
      }),
    }),
    leaderboard: contract.leaderboard.router({
      recordScore: contract.leaderboard.recordScore.handler(({ input }) => {
        return invoke(() => backend.leaderboard.recordScore(input));
      }),
    }),
  });
}

export function createGameServicesRpcFetchHandler(
  router: ReturnType<typeof createGameServicesRouter>,
  options: CreateGameServicesRpcFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const rpcHandler = new RPCHandler<GameServicesOrpcContext>(router as never, {
    plugins: [
      new BodyLimitHandlerPlugin({
        maxBodySize: resolveMaxBodyBytes(options.maxBodyBytes),
      }),
    ],
  });
  const prefix = options.prefix ?? '/rpc';
  const healthPath = options.healthPath ?? '/health';

  return async (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === healthPath) {
      return jsonResponse(createHealthResponse(options.version), 200, options.corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return emptyResponse(204, options.corsHeaders);
    }

    const result = await rpcHandler.handle(
      request,
      {
        prefix,
        context: {
          request,
        },
      } as never,
    );

    if (!result.matched) {
      return textResponse('Not Found', 404, options.corsHeaders);
    }

    return withCors(result.response, options.corsHeaders);
  };
}

export function createGameServicesHttpFetchHandler(
  handler: GameServicesBackendApiHandler,
  options: CreateGameServicesFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const healthPath = options.healthPath ?? '/health';
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);

  return async (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === healthPath) {
      return jsonResponse(
        createHealthResponse(options.version ?? handler.version),
        200,
        options.corsHeaders,
      );
    }

    if (request.method === 'OPTIONS') {
      return emptyResponse(204, options.corsHeaders);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, options.corsHeaders);
    }

    if (!isGameServicesBackendEndpoint(requestUrl.pathname)) {
      return jsonResponse({ error: 'UNKNOWN_ENDPOINT' }, 404, options.corsHeaders);
    }

    let body: unknown;
    try {
      body = await readRequestJson(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestPayloadTooLargeError) {
        return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413, options.corsHeaders);
      }

      return jsonResponse({ error: 'INVALID_JSON' }, 400, options.corsHeaders);
    }

    try {
      const response = await handler.handle({
        method: 'POST',
        endpoint: requestUrl.pathname,
        body,
      });

      return jsonResponse(response.body, response.status, options.corsHeaders);
    } catch (error) {
      // The bundled API handler never throws, but a custom handler must not leak its
      // failure details to clients either.
      reportInternalError(undefined, error);
      return jsonResponse({ error: 'INTERNAL_ERROR' }, 500, options.corsHeaders);
    }
  };
}

function resolveMaxBodyBytes(maxBodyBytes: number | undefined): number {
  const resolved = maxBodyBytes ?? gameServicesRequestLimits.maxBodyBytes;

  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error('maxBodyBytes must be a positive integer.');
  }

  return resolved;
}

type GameServicesDeploymentTargetPlatform = GameServicesAdRewardTarget | GameServicesStoreTarget;

const gameServicesDeploymentTargetPlatforms = new Set<GameServicesDeploymentTargetPlatform>([
  'browser',
  'microsoft-store',
  'android',
  'ios',
  'ait',
  'verse8',
  'oneplay',
  'reddit',
]);

function resolveDeploymentTargetBindings(
  input: GameServicesDeploymentTargetBindings | undefined,
): GameServicesDeploymentTargetBindings {
  const bindings: Partial<Record<GameServicesDeploymentTargetPlatform, string>> = {};

  for (const [platformTarget, deploymentTarget] of Object.entries(input ?? {})) {
    if (!gameServicesDeploymentTargetPlatforms.has(
      platformTarget as GameServicesDeploymentTargetPlatform,
    )) {
      throw new Error(`Unsupported deployment target binding platform: ${platformTarget}.`);
    }

    assertGameServicesDeploymentTarget(deploymentTarget);
    bindings[platformTarget as GameServicesDeploymentTargetPlatform] = deploymentTarget;
  }

  return bindings;
}

function bindRequestDeploymentTarget<
  Request extends VerifyPurchaseRequest | ClaimAdRewardRequest,
>(
  request: Request,
  bindings: GameServicesDeploymentTargetBindings,
): Request {
  const deploymentTarget = (Object.hasOwn(bindings, request.target)
    ? bindings[request.target]
    : undefined) ?? request.target;

  if (
    request.deploymentTarget !== undefined
    && request.deploymentTarget !== deploymentTarget
  ) {
    throw new GameServicesRequestValidationError(
      `deploymentTarget must match the backend binding for ${request.target}.`,
    );
  }

  return deploymentTarget === request.target || request.deploymentTarget === deploymentTarget
    ? request
    : { ...request, deploymentTarget };
}

interface PurchaseVerificationContext {
  readonly catalog: ProductCatalog;
  readonly store: GameServicesStore;
  readonly now: () => string;
  readonly evidenceVerifier: GameServicesEvidenceVerifier;
  readonly evidenceVerificationTimeoutMs: number;
  readonly purchaseGrantFinalizationTimeoutMs: number;
  readonly purchaseGrantFinalizer?: GameServicesPurchaseGrantFinalizer;
  readonly deploymentTargetBindings: GameServicesDeploymentTargetBindings;
  readonly registry?: CommerceEvidenceRegistry;
  readonly restoreSharing: ResolvedPurchaseRestoreSharingPolicy;
}

/** The ledger targets a v1 backend (no registry) accepts: the platform targets with a ledger. */
const gameServicesLedgerTargets = new Set<string>([
  'browser',
  'microsoft-store',
  'android',
  'ios',
  'ait',
  'reddit',
  'verse8',
  'oneplay',
]);

/**
 * A target or store the backend does not serve is a 400, as an unknown v1
 * target was: without a registry the ledger targets are the known platform
 * targets; with one, the store must be registered (or declared for the
 * fallback) and the target a ledger target or a served store id.
 */
function assertServedPurchaseRequest(
  request: VerifyPurchaseRequest,
  registry: CommerceEvidenceRegistry | undefined,
): void {
  if (registry === undefined) {
    if (!gameServicesLedgerTargets.has(request.target)) {
      throw new GameServicesRequestValidationError(
        `target ${request.target} is not a ledger target this backend serves.`,
      );
    }
    return;
  }
  const store = resolveCommerceStoreId(request);
  if (!registry.serves(request)) {
    throw new GameServicesRequestValidationError(
      `store ${store} is not a store this backend serves for target ${request.target}.`,
    );
  }
  // A served store's declared targets are the contract (a custom store may
  // name a custom ledger target); a store without declared targets keeps the
  // ledger target set and the served store ids.
  const allowed = registry.allowedTargets(store);
  if (allowed !== undefined) {
    if (!allowed.has(request.target)) {
      throw new GameServicesRequestValidationError(
        `target ${request.target} is not a ledger target of store ${store}.`,
      );
    }
    return;
  }
  if (!gameServicesLedgerTargets.has(request.target) && !registry.stores.has(request.target)) {
    throw new GameServicesRequestValidationError(
      `target ${request.target} is not a ledger target this backend serves.`,
    );
  }
}

async function verifyPurchaseWithStore(
  input: VerifyPurchaseRequest,
  context: PurchaseVerificationContext,
  onDecision: (verification: VerifyPurchaseResponse) => Promise<void>,
): Promise<VerifyPurchaseResponse> {
  const request = bindRequestDeploymentTarget(
    assertVerifyPurchaseRequest(input),
    context.deploymentTargetBindings,
  );
  assertServedPurchaseRequest(request, context.registry);
  const retryIdentity = {
    source: 'purchase',
    playerId: request.playerId,
    idempotencyKey: request.idempotencyKey,
    grantId: request.productId,
    target: request.target,
    store: resolveCommerceStoreId(request),
    ...(request.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: request.deploymentTarget }),
  } as const;
  return withEntitlementRetryLock(retryIdentity, async () => {
    const verification = await verifyPurchaseForRetry(request, retryIdentity, context);
    await onDecision(verification);
    return verification;
  });
}

async function verifyPurchaseForRetry(
  request: VerifyPurchaseRequest,
  retryIdentity: EntitlementRetryIdentity,
  context: PurchaseVerificationContext,
): Promise<VerifyPurchaseResponse> {
  const completeExistingRetry = async (
    transaction: ProductGrantTransaction,
  ): Promise<VerifyPurchaseResponse> => {
    if (!matchesEntitlementRetry(transaction, retryIdentity)) {
      return assertVerifyPurchaseResponse({
        verified: false,
        alreadyProcessed: false,
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }
    if (await isEntitlementGrantReversed(context.store, transaction.ledgerEntryId)) {
      // A replayed key for a refunded grant is not a grant, as the lookup path answers.
      return assertVerifyPurchaseResponse({
        verified: false,
        alreadyProcessed: false,
        disposition: 'rejected',
        reason: 'LEDGER_GRANT_REVERSED',
      });
    }

    const finalization = await finalizeExistingPurchaseGrant(request, transaction, context);

    return assertVerifyPurchaseResponse({
      verified: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: true,
      ...(finalization === undefined ? {} : { finalization }),
      ...(isRestoredAcrossPlayers(transaction) ? { restoredAcrossPlayers: true } : {}),
    });
  };
  const existing = await findEntitlementTransactionByIdempotency(context.store, retryIdentity);

  // A key names one grant: a resend under the key of a reversed grant
  // answers it as reversed, never as a new restore.
  if (existing !== undefined) {
    return completeExistingRetry(existing);
  }

  const product = context.catalog.products.find((entry) => entry.id === request.productId);

  if (product === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  }

  const platformProductId = resolveProductPlatformId(
    product,
    request.deploymentTarget ?? request.target,
  );

  if (platformProductId === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'PRODUCT_NOT_AVAILABLE_ON_TARGET',
    });
  }

  const verification = await verifyEvidence((signal) => {
    return context.evidenceVerifier.verifyPurchase({
      request,
      product,
      platformProductId,
      signal,
      timeoutMs: context.evidenceVerificationTimeoutMs,
    });
  }, context.evidenceVerificationTimeoutMs);

  if (verification.status === 'settled') {
    // A server-push lookup found the grant the host's fulfillment path wrote.
    // Nothing is written; the entry is answered once it is checked against
    // the requesting player, product, and target.
    return completeSettledPurchase(request, verification, context);
  }

  // The store routed to, as for a grant below.
  const routedEntry = context.registry?.route(request);
  const verifiedStore = routedEntry?.status === 'routed'
    ? routedEntry.entry.store
    : resolveCommerceStoreId(request);

  if (verification.status === 'restorable') {
    // A verified restore of a purchase the store binds to another player.
    return shareRestoredPurchase(
      request,
      {
        product,
        platformProductId,
        verification,
        verifiedStore,
        refusal: assertVerifyPurchaseResponse({
          verified: false,
          alreadyProcessed: false,
          disposition: 'rejected',
          reason: verification.reason,
        }),
      },
      context,
    );
  }

  if (verification.status !== 'verified') {
    // A matching grant can land while provider verification is in flight. Recheck
    // before returning a stale provider state such as an already-consumed token.
    const racedExisting = await findEntitlementTransactionByIdempotency(
      context.store,
      retryIdentity,
    );
    if (racedExisting !== undefined) {
      return completeExistingRetry(racedExisting);
    }

    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      disposition: verification.status === 'pending' ? 'pending' : 'rejected',
      reason: verification.status === 'pending'
        ? (verification.reason ?? 'EVIDENCE_PENDING')
        : verification.reason,
    });
  }

  const verificationPayload = createVerificationPayload(verification, 'platformTransactionId');
  const platformTransactionId = resolvePlatformEvidenceId(
    verification,
    request.platformTransactionId,
  );
  if (
    context.restoreSharing.mode === 'share'
    && product.type === 'non_consumable'
    && context.store.findEntitlementTransactionsByEvidencePrefix !== undefined
  ) {
    // The retention purge can delete a purchase's first grant while its
    // shares remain: the buyer then takes a holder's place under the limit
    // like any other player, never a replacement first grant past it.
    const holders = await listPurchaseHolders(context.store, verification.verificationId);
    if (holders.first === undefined && holders.shared.length > 0) {
      return shareRestoredPurchase(
        request,
        {
          product,
          platformProductId,
          verification,
          verifiedStore,
          bindingMatches: true,
          refusal: assertVerifyPurchaseResponse({
            verified: false,
            alreadyProcessed: false,
            reason: 'EVIDENCE_ALREADY_PROCESSED',
          }),
        },
        context,
      );
    }
  }
  // The store written is the one the registry routed to (an entry's own
  // store, or a declared fallback store); a fallback serving undeclared
  // stores and the v1 path record the request's resolved store.
  const grant = await recordEntitlementGrantWithEvidence(context.store, {
    playerId: request.playerId,
    grantId: product.id,
    source: 'purchase',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    grant: product.grant,
    evidenceVerificationId: verification.verificationId,
    payload: createPurchaseGrantPayload(request, {
      product,
      platformProductId,
      verification,
      verifiedStore,
      ...(platformTransactionId === undefined ? {} : { platformTransactionId }),
    }),
  });

  if (grant.status === 'evidence_already_processed') {
    const existingEvidence = await findEntitlementTransactionByEvidenceVerificationId(
      context.store,
      { source: 'purchase', evidenceVerificationId: verification.verificationId },
    );
    if (
      existingEvidence !== undefined
      && context.restoreSharing.mode === 'share'
      && product.type === 'non_consumable'
      && existingEvidence.playerId !== request.playerId
      && (request.intent === 'restore' || existingEvidence.payload.restoredAcrossAccounts === true)
    ) {
      // The store binds the purchase to this player, but another player's
      // grant names it: a restore of this player's, or (when that grant came
      // from another guest's restore before this player's own verify reached
      // the ledger) the buyer's checkout. The binding match is the proof, so
      // this player gets its own share.
      return shareRestoredPurchase(
        request,
        {
          product,
          platformProductId,
          verification,
          verifiedStore,
          bindingMatches: true,
          refusal: assertVerifyPurchaseResponse({
            verified: false,
            alreadyProcessed: false,
            reason: 'EVIDENCE_ALREADY_PROCESSED',
          }),
        },
        context,
      );
    }
    if (
      existingEvidence !== undefined
      && matchesPurchaseEvidenceRecovery(existingEvidence, {
        playerId: request.playerId,
        grantId: request.productId,
        target: request.target,
        store: verifiedStore,
        ...(request.deploymentTarget === undefined
          ? {}
          : { deploymentTarget: request.deploymentTarget }),
        evidenceVerificationId: verification.verificationId,
      })
    ) {
      if (await isEntitlementGrantReversed(context.store, existingEvidence.ledgerEntryId)) {
        // A refunded grant's evidence replayed under another key is not a grant.
        return assertVerifyPurchaseResponse({
          verified: false,
          alreadyProcessed: false,
          disposition: 'rejected',
          reason: 'LEDGER_GRANT_REVERSED',
        });
      }
      const finalization = await finalizeExistingPurchaseGrant(request, existingEvidence, context);
      // A different idempotency key is evidence replay unless a configured finalizer can resume
      // the provider operation. Keep generic stores fail-closed while allowing Store consume
      // recovery to report the already-recorded grant.
      if (finalization !== undefined) {
        return assertVerifyPurchaseResponse({
          verified: true,
          ledgerEntryId: existingEvidence.ledgerEntryId,
          alreadyProcessed: true,
          finalization,
        });
      }
    }

    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'EVIDENCE_ALREADY_PROCESSED',
    });
  }

  if (grant.result.alreadyProcessed) {
    const recordedTransaction = await context.store.getEntitlementTransaction(
      grant.result.ledgerEntryId,
    );
    const storedEvidenceVerificationId = recordedTransaction?.evidenceVerificationId
      ?? recordedTransaction?.payload.evidenceVerificationId;
    if (
      recordedTransaction === undefined
      || !matchesEntitlementRetry(recordedTransaction, retryIdentity)
      || storedEvidenceVerificationId !== verification.verificationId
    ) {
      return assertVerifyPurchaseResponse({
        verified: false,
        alreadyProcessed: false,
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }
  }

  const finalization = await finalizePurchaseGrant(context.purchaseGrantFinalizer, {
    request,
    product,
    platformProductId,
    evidenceVerificationId: verification.verificationId,
    ...(verification.payload === undefined
      ? {}
      : { evidencePayload: verification.payload }),
    ledgerEntryId: grant.result.ledgerEntryId,
    alreadyProcessed: grant.result.alreadyProcessed,
    timeoutMs: context.purchaseGrantFinalizationTimeoutMs,
  });

  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: grant.result.ledgerEntryId,
    alreadyProcessed: grant.result.alreadyProcessed,
    ...(finalization === undefined ? {} : { finalization }),
  });
}

/**
 * Answers a purchase a server-push lookup verifier found settled by an earlier
 * ledger entry. The entry must be a purchase grant of the requesting player,
 * product, and ledger target; a fulfillment path that bound the grant to a
 * deployment target must agree with the request when both name one.
 */
async function completeSettledPurchase(
  request: VerifyPurchaseRequest,
  decision: Extract<EvidenceVerificationDecision, { readonly status: 'settled' }>,
  context: PurchaseVerificationContext,
): Promise<VerifyPurchaseResponse> {
  const settled = await context.store.getEntitlementTransaction(decision.ledgerEntryId);
  if (
    settled === undefined
    || settled.source !== 'purchase'
    || settled.playerId !== request.playerId
    || settled.grantId !== request.productId
    || settled.payload.target !== (decision.ledgerTarget ?? request.target)
    || (
      settled.payload.deploymentTarget !== undefined
      && request.deploymentTarget !== undefined
      && settled.payload.deploymentTarget !== request.deploymentTarget
    )
  ) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      disposition: 'rejected',
      reason: 'LEDGER_GRANT_IDENTITY_MISMATCH',
    });
  }
  if (await isEntitlementGrantReversed(context.store, settled.ledgerEntryId)) {
    // `settled` is an open verifier contract; a reversed grant never settles
    // a purchase, whichever verifier named it.
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      disposition: 'rejected',
      reason: 'LEDGER_GRANT_REVERSED',
    });
  }

  const finalization = await finalizeExistingPurchaseGrant(request, settled, context);

  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: settled.ledgerEntryId,
    alreadyProcessed: true,
    ...(finalization === undefined ? {} : { finalization }),
  });
}

type PurchaseEvidenceDecision = Extract<
  EvidenceVerificationDecision,
  { readonly status: 'verified' | 'restorable' }
>;

/** The ledger payload of a purchase grant: the verifier's payload and the request's identity. */
function createPurchaseGrantPayload(
  request: VerifyPurchaseRequest,
  input: {
    readonly product: ProductCatalog['products'][number];
    readonly platformProductId: string;
    readonly verification: PurchaseEvidenceDecision;
    readonly verifiedStore: string;
    readonly platformTransactionId?: string;
  },
): EntitlementLedgerPayload {
  const evidenceSchema = request.evidence?.schema;
  return {
    ...createVerificationPayload(input.verification, 'platformTransactionId'),
    target: request.target,
    store: input.verifiedStore,
    ...(request.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: request.deploymentTarget }),
    productId: request.productId,
    productType: input.product.type,
    platformProductId: input.platformProductId,
    ...(input.platformTransactionId === undefined
      ? {}
      : { platformTransactionId: input.platformTransactionId }),
    purchasedAt: request.purchasedAt,
    ...(evidenceSchema === undefined ? {} : { evidenceSchema }),
    evidenceVerificationId: input.verification.verificationId,
    evidenceVerifiedAt: input.verification.verifiedAt,
  };
}

/**
 * A verified restore of a non-consumable the store binds to another player
 * (RFC "Restore sharing"). Under the `share` policy, for a request with
 * `intent: 'restore'` of a non-consumable, the restoring player gets its own
 * grant linked to the purchase and earlier holders keep theirs; otherwise
 * `refusal` is answered. A purchase no grant holds yet is granted to the
 * restoring player as its first grant. A refunded or revoked purchase is
 * refused, a purchase already held by `maxHolders` players answers
 * `pending` (`PURCHASE_HOLDER_LIMIT_REACHED`) and evicts nobody, and a
 * player that already holds it gets its grant back.
 */
async function shareRestoredPurchase(
  request: VerifyPurchaseRequest,
  input: {
    readonly product: ProductCatalog['products'][number];
    readonly platformProductId: string;
    readonly verification: PurchaseEvidenceDecision;
    readonly verifiedStore: string;
    readonly refusal: VerifyPurchaseResponse;
    /** The store binds the purchase to this player (a `verified` decision): no restore intent needed. */
    readonly bindingMatches?: boolean;
  },
  context: PurchaseVerificationContext,
): Promise<VerifyPurchaseResponse> {
  const { store, restoreSharing: policy } = context;
  const { product, verification } = input;
  if (
    policy.mode !== 'share'
    || (request.intent !== 'restore' && input.bindingMatches !== true)
    || product.type !== 'non_consumable'
  ) {
    return input.refusal;
  }
  const purchaseVerificationId = verification.verificationId;
  const notGranted = (
    disposition: 'pending' | 'rejected',
    reason: string,
  ): { readonly status: 'answer'; readonly response: VerifyPurchaseResponse } => ({
    status: 'answer',
    response: assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      disposition,
      reason,
    }),
  });
  const payload = createPurchaseGrantPayload(request, input);
  const platformTransactionId = resolvePlatformEvidenceId(
    verification,
    request.platformTransactionId,
  );
  const holderIdentity = {
    source: 'purchase',
    playerId: request.playerId,
    grantId: request.productId,
    target: request.target,
    store: input.verifiedStore,
    ...(request.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: request.deploymentTarget }),
  } as const;
  const outcome = await withEntitlementEvidenceLocks(
    store,
    [createEntitlementEvidenceKey({
      source: 'purchase',
      evidenceVerificationId: purchaseVerificationId,
    })],
    async (): Promise<
      | { readonly status: 'answer'; readonly response: VerifyPurchaseResponse }
      | { readonly status: 'held'; readonly grant: ProductGrantTransaction }
      | {
          readonly status: 'written';
          readonly ledgerEntryId: string;
          readonly alreadyProcessed: boolean;
        }
    > => {
      // A lost race for a slot (another isolate shared the purchase between
      // the read and the write) reads the holders again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const holders = await listPurchaseHolders(store, purchaseVerificationId);
        const first = holders.first;
        // The holders; the first grant may be gone (the retention purge
        // deleted a deleted player's record) while its shares remain.
        const all = [...(first === undefined ? [] : [first]), ...holders.shared];
        const anchor = all[0];
        if (anchor === undefined) {
          // No grant holds the purchase: it never reached this ledger (an app
          // closed before verifying, or bought outside the app). The store's
          // verification is the proof, as for a share.
          const recorded = await recordEntitlementGrantUnchecked(store, {
            playerId: request.playerId,
            grantId: product.id,
            source: 'purchase',
            idempotencyKey: request.idempotencyKey,
            grantedAt: context.now(),
            grant: product.grant,
            evidenceVerificationId: purchaseVerificationId,
            payload: {
              ...payload,
              ...(platformTransactionId === undefined ? {} : { platformTransactionId }),
              restoredAcrossAccounts: true,
            },
          });
          if (recorded.status !== 'recorded') {
            continue;
          }
          if (recorded.result.alreadyProcessed) {
            // The key already held a grant (another isolate wrote it after the
            // lookup): it is this restore only if it records this purchase.
            const keyed = await store.getEntitlementTransaction(recorded.result.ledgerEntryId);
            if (
              keyed === undefined
              || !matchesEntitlementRetry(keyed, {
                ...holderIdentity,
                idempotencyKey: request.idempotencyKey,
              })
              || readPurchaseVerificationId(keyed) !== purchaseVerificationId
            ) {
              return notGranted('rejected', 'IDEMPOTENCY_KEY_CONFLICT');
            }
            if (await isEntitlementGrantReversed(store, keyed.ledgerEntryId)) {
              return notGranted('rejected', 'LEDGER_GRANT_REVERSED');
            }
          }
          return {
            status: 'written',
            ledgerEntryId: recorded.result.ledgerEntryId,
            alreadyProcessed: recorded.result.alreadyProcessed,
          };
        }
        if (
          anchor.source !== 'purchase'
          || anchor.grantId !== request.productId
          || anchor.payload.target !== request.target
          || (anchor.payload.store !== undefined && anchor.payload.store !== input.verifiedStore)
          // Two deployment targets sharing a ledger never share a grant, as
          // for a retry (`matchesEntitlementTransactionIdentity`).
          || (
            anchor.payload.deploymentTarget !== undefined
            && anchor.payload.deploymentTarget !== request.deploymentTarget
          )
        ) {
          return notGranted('rejected', 'LEDGER_GRANT_IDENTITY_MISMATCH');
        }
        const revocations = await findEntitlementRevocationsChunked(
          store,
          all.map((grant) => grant.ledgerEntryId),
        );
        const reversed = new Set(revocations.map((entry) => entry.revokesLedgerEntryId));
        if (
          await findPurchaseWideRevocation(store, all) !== undefined
          || all.every((grant) => reversed.has(grant.ledgerEntryId))
        ) {
          // Refunded, charged back, or voided: the purchase ended for every
          // holder. An admin entry ends one holder only and frees its place,
          // but a purchase no holder keeps is never shared again (a refund
          // that arrives then finds no grant left to mark).
          return notGranted('rejected', 'LEDGER_GRANT_REVERSED');
        }
        const own = all.find((grant) => grant.playerId === request.playerId);
        if (own !== undefined && !matchesEntitlementTransactionIdentity(own, holderIdentity)) {
          return notGranted('rejected', 'LEDGER_GRANT_IDENTITY_MISMATCH');
        }
        if (own !== undefined) {
          return reversed.has(own.ledgerEntryId)
            ? notGranted('rejected', 'LEDGER_GRANT_REVERSED')
            : { status: 'held', grant: own };
        }
        const active = all.filter((grant) =>
          !reversed.has(grant.ledgerEntryId) && !isRetainedPlayerId(grant.playerId)).length;
        if (active >= policy.maxHolders) {
          return notGranted('pending', 'PURCHASE_HOLDER_LIMIT_REACHED');
        }
        const holderSlot = holders.nextSlot;
        const holderEvidenceVerificationId = createPurchaseHolderEvidenceVerificationId(
          purchaseVerificationId,
          holderSlot,
        );
        const recorded = await recordEntitlementGrantUnchecked(store, {
          playerId: request.playerId,
          grantId: product.id,
          source: 'purchase',
          // The request's key, so a retry under it answers this grant; a
          // player that already holds the purchase was answered above.
          idempotencyKey: request.idempotencyKey,
          grantedAt: context.now(),
          grant: product.grant,
          evidenceVerificationId: holderEvidenceVerificationId,
          // The store transaction id stays with the first grant (its platform
          // evidence is unique); a share names the purchase by its
          // verification id instead.
          payload: {
            ...payload,
            evidenceVerificationId: holderEvidenceVerificationId,
            holderOfEvidenceVerificationId: purchaseVerificationId,
            // No ledger id of another holder: it embeds that player's id,
            // which must not outlive that player's account deletion here.
            holderSlot,
          },
        });
        if (recorded.status !== 'recorded') {
          // The slot went to another restore; read the holders again.
          continue;
        }
        if (recorded.result.alreadyProcessed) {
          // The key held a grant already (this request's share landed from
          // another isolate, or the key names something else).
          const keyed = await store.getEntitlementTransaction(recorded.result.ledgerEntryId);
          if (
            keyed === undefined
            || !matchesEntitlementRetry(keyed, {
              ...holderIdentity,
              idempotencyKey: request.idempotencyKey,
            })
            || readPurchaseVerificationId(keyed) !== purchaseVerificationId
          ) {
            return notGranted('rejected', 'IDEMPOTENCY_KEY_CONFLICT');
          }
          return { status: 'held', grant: keyed };
        }
        // A refund that landed between the read and this write may have
        // fanned out before the share existed: it then ends the share too.
        // A refund writes its first entry before it reads the holders, so
        // either it sees this share or this read sees its entry.
        // A refund that met only admin-revoked grants leaves no entry of its
        // own; the share then ends with them, as a purchase no holder keeps
        // is never shared again.
        const written = await store.getEntitlementTransaction(recorded.result.ledgerEntryId);
        const ended = await findPurchaseWideRevocation(
          store,
          written === undefined ? all : [...all, written],
        );
        const priorReversed = new Set(
          (await findEntitlementRevocationsChunked(store, all.map((grant) => grant.ledgerEntryId)))
            .map((entry) => entry.revokesLedgerEntryId),
        );
        const abandoned = all.every((grant) => priorReversed.has(grant.ledgerEntryId));
        if (ended !== undefined || abandoned) {
          if (written !== undefined && ended?.revokesLedgerEntryId !== written.ledgerEntryId) {
            await revokeEntitlementGrant(store, ended === undefined
              ? {
                  playerId: written.playerId,
                  revokesLedgerEntryId: written.ledgerEntryId,
                  idempotencyKey: `mpgd-holder-closed:${purchaseVerificationId}`,
                  reason: 'admin',
                  revokedAt: context.now(),
                  payload: { holderOfEvidenceVerificationId: purchaseVerificationId },
                }
              : {
                  playerId: written.playerId,
                  revokesLedgerEntryId: written.ledgerEntryId,
                  idempotencyKey: ended.idempotencyKey,
                  reason: ended.reason,
                  revokedAt: ended.revokedAt,
                  payload: ended.payload,
                  ...(ended.evidenceVerificationId === undefined
                    ? {}
                    : {
                        evidenceVerificationId:
                          holderRevocationEvidenceId(ended.evidenceVerificationId, written),
                      }),
                });
          }
          return notGranted('rejected', 'LEDGER_GRANT_REVERSED');
        }
        return {
          status: 'written',
          ledgerEntryId: recorded.result.ledgerEntryId,
          alreadyProcessed: false,
        };
      }
      return notGranted('pending', 'PURCHASE_HOLDER_CONFLICT');
    },
  );
  if (outcome.status === 'answer') {
    return outcome.response;
  }
  if (outcome.status === 'held') {
    const finalization = await finalizeExistingPurchaseGrant(request, outcome.grant, context);
    return assertVerifyPurchaseResponse({
      verified: true,
      ledgerEntryId: outcome.grant.ledgerEntryId,
      alreadyProcessed: true,
      ...(finalization === undefined ? {} : { finalization }),
      ...(isRestoredAcrossPlayers(outcome.grant) ? { restoredAcrossPlayers: true } : {}),
    });
  }
  const finalization = await finalizePurchaseGrant(context.purchaseGrantFinalizer, {
    request,
    product,
    platformProductId: input.platformProductId,
    evidenceVerificationId: purchaseVerificationId,
    ...(verification.payload === undefined ? {} : { evidencePayload: verification.payload }),
    ledgerEntryId: outcome.ledgerEntryId,
    alreadyProcessed: outcome.alreadyProcessed,
    timeoutMs: context.purchaseGrantFinalizationTimeoutMs,
  });
  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: outcome.ledgerEntryId,
    alreadyProcessed: outcome.alreadyProcessed,
    ...(finalization === undefined ? {} : { finalization }),
    restoredAcrossPlayers: true,
  });
}

async function finalizeExistingPurchaseGrant(
  request: VerifyPurchaseRequest,
  transaction: ProductGrantTransaction,
  context: {
    readonly catalog: ProductCatalog;
    readonly purchaseGrantFinalizer?: GameServicesPurchaseGrantFinalizer;
    readonly purchaseGrantFinalizationTimeoutMs: number;
    readonly registry?: CommerceEvidenceRegistry;
  },
): Promise<PurchaseGrantFinalization | undefined> {
  if (context.purchaseGrantFinalizer === undefined) {
    return undefined;
  }

  const currentProduct = context.catalog.products.find((entry) => entry.id === request.productId);
  const storedPlatformProductId = readStoredPlatformProductId(transaction);
  const product = createStoredPurchaseProduct(request, transaction) ?? currentProduct;
  const platformProductId = storedPlatformProductId
    ?? currentProduct?.platformProductIds[request.target];
  // A shared grant is finalized as the purchase it records, not as its slot.
  const evidenceVerificationId = readPurchaseVerificationId(transaction);
  const finalizationRequest = createStoredPurchaseRequest(request, transaction);

  if (
    product === undefined
    || platformProductId === undefined
    || typeof evidenceVerificationId !== 'string'
    || evidenceVerificationId.length === 0
  ) {
    // With a registry, a store nothing finalizes on the server (client,
    // host, or none finish) has no pending finalization to report: the
    // registry decides from the grant's recorded store and schema, never from
    // the stand-in product. The v1 single finalizer keeps answering pending.
    if (context.registry !== undefined) {
      const recordedSchema = transaction.payload.evidenceSchema;
      const supported = context.registry.finalizer.supportsPurchaseGrant?.({
        request: typeof recordedSchema === 'string' && recordedSchema.length > 0
          ? { ...finalizationRequest, evidence: { schema: recordedSchema, payload: {} } }
          : finalizationRequest,
        product: product ?? {
          id: request.productId,
          type: 'consumable' as const,
          grant: transaction.grant ?? { type: 'entitlement' as const, entitlement: request.productId },
          platformProductIds: {},
        },
        platformProductId: platformProductId ?? '',
        evidenceVerificationId: typeof evidenceVerificationId === 'string'
          ? evidenceVerificationId
          : '',
        evidencePayload: transaction.payload,
        ledgerEntryId: transaction.ledgerEntryId,
        alreadyProcessed: true,
        timeoutMs: context.purchaseGrantFinalizationTimeoutMs,
      });
      if (supported === false) {
        return undefined;
      }
    }
    return assertPurchaseGrantFinalization({
      status: 'pending',
      alreadyCompleted: false,
      reason: 'PURCHASE_FINALIZER_CONTEXT_UNAVAILABLE',
    });
  }

  return finalizePurchaseGrant(context.purchaseGrantFinalizer, {
    request: finalizationRequest,
    product,
    platformProductId,
    evidenceVerificationId,
    evidencePayload: transaction.payload,
    ledgerEntryId: transaction.ledgerEntryId,
    alreadyProcessed: true,
    timeoutMs: context.purchaseGrantFinalizationTimeoutMs,
  });
}

async function finalizePurchaseGrant(
  finalizer: GameServicesPurchaseGrantFinalizer | undefined,
  input: Omit<FinalizePurchaseGrantInput, 'signal'>,
): Promise<PurchaseGrantFinalization | undefined> {
  if (finalizer === undefined) {
    return undefined;
  }

  const controller = new AbortController();
  const timeoutDecision = assertPurchaseGrantFinalization({
    status: 'pending',
    alreadyCompleted: false,
    reason: 'PURCHASE_FINALIZER_TIMEOUT',
  });
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    if (finalizer.supportsPurchaseGrant?.(input) === false) {
      return undefined;
    }

    return await Promise.race([
      finalizer.finalizePurchaseGrant({ ...input, signal: controller.signal })
        .then(assertPurchaseGrantFinalization)
        .catch((error: unknown) => {
          if (timedOut) {
            return timeoutDecision;
          }

          throw error;
        }),
      new Promise<PurchaseGrantFinalization>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve(timeoutDecision);
          controller.abort();
        }, input.timeoutMs);
      }),
    ]);
  } catch {
    return assertPurchaseGrantFinalization({
      status: 'pending',
      alreadyCompleted: false,
      reason: 'PURCHASE_FINALIZER_ERROR',
    });
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function readStoredPlatformProductId(
  transaction: ProductGrantTransaction,
): string | undefined {
  const platformProductId = transaction.payload.platformProductId;
  return typeof platformProductId === 'string' && platformProductId.length > 0
    ? platformProductId
    : undefined;
}

function createStoredPurchaseProduct(
  request: VerifyPurchaseRequest,
  transaction: ProductGrantTransaction,
): ProductCatalog['products'][number] | undefined {
  const productType = transaction.payload.productType;
  const platformProductId = readStoredPlatformProductId(transaction);
  if (
    transaction.grant === undefined
    || platformProductId === undefined
    || (
      productType !== 'consumable'
      && productType !== 'non_consumable'
      && productType !== 'subscription'
    )
  ) {
    return undefined;
  }

  return {
    id: request.productId,
    type: productType,
    grant: transaction.grant,
    platformProductIds: { [request.target]: platformProductId },
  };
}

/**
 * Reuses the current request only for retry dimensions already matched against
 * the stored grant, while restoring provider identity and time metadata from
 * the durable transaction for a coherent finalization retry.
 */
function createStoredPurchaseRequest(
  request: VerifyPurchaseRequest,
  transaction: ProductGrantTransaction,
): VerifyPurchaseRequest {
  const platformTransactionId = transaction.payload.platformTransactionId;
  const purchasedAt = transaction.payload.purchasedAt;

  return {
    ...request,
    // Evidence recovery can arrive with another request key. Consume/release must use the
    // original durable grant generation, never the retry's newly supplied key.
    idempotencyKey: transaction.idempotencyKey,
    ...(typeof platformTransactionId === 'string' && platformTransactionId.length > 0
      ? { platformTransactionId }
      : {}),
    ...(typeof purchasedAt === 'string' && purchasedAt.length > 0
      ? { purchasedAt }
      : {}),
  };
}

interface AdRewardClaimContext {
  readonly placements: AdPlacements;
  readonly store: GameServicesStore;
  readonly now: () => string;
  readonly evidenceVerifier: GameServicesEvidenceVerifier;
  readonly evidenceVerificationTimeoutMs: number;
  readonly deploymentTargetBindings: GameServicesDeploymentTargetBindings;
}

async function claimAdRewardWithStore(
  input: ClaimAdRewardRequest,
  context: AdRewardClaimContext,
  onDecision: (claim: ClaimAdRewardResponse) => Promise<void>,
): Promise<ClaimAdRewardResponse> {
  const request = bindRequestDeploymentTarget(
    assertClaimAdRewardRequest(input),
    context.deploymentTargetBindings,
  );
  const retryIdentity = {
    source: 'ad_reward',
    playerId: request.playerId,
    idempotencyKey: request.idempotencyKey,
    grantId: request.placementId,
    target: request.target,
    ...(request.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: request.deploymentTarget }),
  } as const;
  return withEntitlementRetryLock(retryIdentity, async () => {
    const claim = await claimAdRewardForRetry(request, retryIdentity, context);
    await onDecision(claim);
    return claim;
  });
}

async function claimAdRewardForRetry(
  request: ClaimAdRewardRequest,
  retryIdentity: EntitlementRetryIdentity,
  context: AdRewardClaimContext,
): Promise<ClaimAdRewardResponse> {
  const completeExistingRetry = (transaction: ProductGrantTransaction): ClaimAdRewardResponse => {
    if (!matchesEntitlementRetry(transaction, retryIdentity)) {
      return assertClaimAdRewardResponse({
        granted: false,
        alreadyProcessed: false,
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }

    return assertClaimAdRewardResponse({
      granted: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: true,
    });
  };
  const existing = await findEntitlementTransactionByIdempotency(context.store, retryIdentity);

  if (existing !== undefined) {
    return completeExistingRetry(existing);
  }

  const placement = context.placements.placements.find((entry) => entry.id === request.placementId);

  if (placement === undefined || placement.type !== 'rewarded' || placement.reward === undefined) {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: placement === undefined ? 'UNKNOWN_PLACEMENT' : 'NOT_REWARDED_PLACEMENT',
    });
  }

  const platformPlacementId = resolveAdPlacementPlatformId(
    placement,
    request.deploymentTarget ?? request.target,
  );
  const verification = await verifyEvidence((signal) => {
    return context.evidenceVerifier.verifyAdReward({
      request,
      placement,
      ...(platformPlacementId === undefined ? {} : { platformPlacementId }),
      signal,
      timeoutMs: context.evidenceVerificationTimeoutMs,
    });
  }, context.evidenceVerificationTimeoutMs);

  if (verification.status !== 'verified') {
    // Another backend process can record a matching grant while verification is in flight.
    // Recheck before returning a stale pending or rejected state.
    const racedExisting = await findEntitlementTransactionByIdempotency(
      context.store,
      retryIdentity,
    );
    if (racedExisting !== undefined) {
      return completeExistingRetry(racedExisting);
    }

    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      disposition: verification.status === 'pending' ? 'pending' : 'rejected',
      reason: verification.status === 'pending'
        ? (verification.reason ?? 'EVIDENCE_PENDING')
        : verification.status === 'settled' || verification.status === 'restorable'
          // Only purchase verification reads a settled ledger entry or a restore.
          ? 'EVIDENCE_VERIFIER_ERROR'
          : verification.reason,
    });
  }

  // The client-reported impression id only becomes part of the globally unique platform
  // evidence identity when the verifier vouches for it (or replaces it with its own
  // authority id). Otherwise an attacker could pre-register another player's impression id
  // and have that player's legitimate claim rejected as EVIDENCE_ALREADY_PROCESSED.
  const platformImpressionId = resolvePlatformEvidenceId(
    verification,
    request.platformImpressionId,
  );
  const payload: EntitlementLedgerPayload = {
    ...createVerificationPayload(verification, 'platformImpressionId'),
    target: request.target,
    ...(request.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: request.deploymentTarget }),
    placementId: request.placementId,
    rewardType: placement.reward.type,
    amount: placement.reward.amount,
    completedAt: request.completedAt,
    evidenceVerificationId: verification.verificationId,
    evidenceVerifiedAt: verification.verifiedAt,
  };

  if (placement.reward.type === 'currency') {
    payload.currency = placement.reward.currency;
  }

  if (platformImpressionId !== undefined) {
    payload.platformImpressionId = platformImpressionId;
  }

  const result = await recordEntitlementGrantWithEvidence(context.store, {
    playerId: request.playerId,
    grantId: request.placementId,
    source: 'ad_reward',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    evidenceVerificationId: verification.verificationId,
    payload,
  });

  if (result.status === 'evidence_already_processed') {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: 'EVIDENCE_ALREADY_PROCESSED',
    });
  }

  if (
    result.result.alreadyProcessed
    && !await recordedEntitlementMatchesRetry(context.store, result.result, retryIdentity)
  ) {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: 'IDEMPOTENCY_KEY_CONFLICT',
    });
  }

  return assertClaimAdRewardResponse({
    granted: true,
    ledgerEntryId: result.result.ledgerEntryId,
    alreadyProcessed: result.result.alreadyProcessed,
  });
}

async function verifyEvidence(
  verify: (signal: AbortSignal) => Promise<EvidenceVerificationDecision>,
  timeoutMs: number,
): Promise<EvidenceVerificationDecision> {
  const controller = new AbortController();
  const timeoutDecision = {
    status: 'pending',
    reason: 'EVIDENCE_VERIFIER_TIMEOUT',
  } as const satisfies EvidenceVerificationDecision;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let decision: EvidenceVerificationDecision;
  try {
    decision = await Promise.race([
      verify(controller.signal),
      new Promise<EvidenceVerificationDecision>((resolve) => {
        timeout = setTimeout(() => {
          resolve(timeoutDecision);
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch {
    return {
      status: 'pending',
      reason: 'EVIDENCE_VERIFIER_ERROR',
    };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
  try {
    return assertEvidenceVerificationDecision(decision);
  } catch {
    return { status: 'rejected', reason: 'EVIDENCE_VERIFIER_ERROR' };
  }
}

type VerifiedEvidenceDecision = Extract<
  EvidenceVerificationDecision,
  { readonly status: 'verified' }
>;

/**
 * Resolves the platform evidence identity stored in the ledger: the verifier's authority id
 * when it supplies one, the client value when the verifier validated the request without
 * replacing it (`undefined`), and nothing at all when the verifier suppresses it (`null`).
 */
function resolvePlatformEvidenceId(
  verification: PurchaseEvidenceDecision | VerifiedEvidenceDecision,
  clientPlatformEvidenceId: string | undefined,
): string | undefined {
  if (verification.platformEvidenceId === null) {
    return undefined;
  }

  return verification.platformEvidenceId ?? clientPlatformEvidenceId;
}

function createVerificationPayload(
  verification: VerifiedEvidenceDecision | Extract<
    EvidenceVerificationDecision,
    { readonly status: 'restorable' }
  >,
  platformEvidenceField: 'platformTransactionId' | 'platformImpressionId',
): EntitlementLedgerPayload | undefined {
  if (verification.platformEvidenceId !== null || verification.payload === undefined) {
    return verification.payload;
  }

  const { [platformEvidenceField]: suppressedPlatformEvidenceId, ...payload }
    = verification.payload;
  void suppressedPlatformEvidenceId;
  return payload;
}

function assertEvidenceVerificationDecision(
  decision: EvidenceVerificationDecision,
): EvidenceVerificationDecision {
  if (decision.status === 'verified' || decision.status === 'restorable') {
    if (decision.status === 'restorable') {
      assertNonEmptyDecisionString(decision.reason, 'reason');
    }
    assertNonEmptyDecisionString(decision.verificationId, 'verificationId');
    assertNonEmptyDecisionString(decision.verifiedAt, 'verifiedAt');
    if (!Number.isFinite(Date.parse(decision.verifiedAt))) {
      throw new Error('Evidence verification verifiedAt must be a valid timestamp.');
    }
    if (decision.payload !== undefined) {
      if (
        typeof decision.payload !== 'object'
        || decision.payload === null
        || Array.isArray(decision.payload)
      ) {
        throw new Error('Evidence verification payload must be a record.');
      }

      for (const [key, value] of Object.entries(decision.payload)) {
        if (
          typeof value !== 'string'
          && (typeof value !== 'number' || !Number.isFinite(value))
          && typeof value !== 'boolean'
        ) {
          throw new Error(`Evidence verification payload.${key} must be primitive.`);
        }
      }
    }
    if (
      decision.platformEvidenceId !== undefined
      && decision.platformEvidenceId !== null
    ) {
      assertNonEmptyDecisionString(decision.platformEvidenceId, 'platformEvidenceId');
    }
    return decision;
  }

  if (decision.status === 'settled') {
    assertNonEmptyDecisionString(decision.ledgerEntryId, 'ledgerEntryId');
    return decision;
  }

  if (decision.status === 'pending') {
    if (decision.reason !== undefined) {
      assertNonEmptyDecisionString(decision.reason, 'reason');
    }
    return decision;
  }

  if (decision.status === 'rejected') {
    assertNonEmptyDecisionString(decision.reason, 'reason');
    return decision;
  }

  throw new Error('Unknown evidence verification status.');
}

async function recordEntitlementGrantWithEvidence(
  store: GameServicesStore,
  grant: EntitlementLedgerGrant,
): Promise<
  | { readonly status: 'recorded'; readonly result: EntitlementLedgerResult }
  | { readonly status: 'evidence_already_processed' }
> {
  const evidenceVerificationId = grant.evidenceVerificationId;
  if (evidenceVerificationId !== undefined) {
    const evidenceIdentity = {
      source: grant.source,
      evidenceVerificationId,
    } as const;
    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
    const lockKeys = [createEntitlementEvidenceKey(evidenceIdentity)];
    if (platformEvidenceIdentity !== undefined) {
      lockKeys.push(createEntitlementPlatformEvidenceKey(platformEvidenceIdentity));
    }

    return withEntitlementEvidenceLocks(store, lockKeys, async () => {
      const authorityMatch = await findEntitlementTransactionByEvidenceVerificationId(store, {
        source: grant.source,
        evidenceVerificationId,
      });
      const existing = authorityMatch ?? (platformEvidenceIdentity === undefined
        ? undefined
        : await findEntitlementTransactionByPlatformEvidence(
            store,
            platformEvidenceIdentity,
          ));

      if (existing !== undefined) {
        if (
          existing.source === grant.source
          && existing.playerId === grant.playerId
          && existing.idempotencyKey === grant.idempotencyKey
        ) {
          return {
            status: 'recorded',
            result: assertEntitlementLedgerResult({
              ledgerEntryId: existing.ledgerEntryId,
              alreadyProcessed: true,
            }),
          };
        }

        return { status: 'evidence_already_processed' };
      }

      return recordEntitlementGrantUnchecked(store, grant);
    });
  }

  return recordEntitlementGrantUnchecked(store, grant);
}

async function recordEntitlementGrantUnchecked(
  store: GameServicesStore,
  grant: EntitlementLedgerGrant,
): Promise<
  | { readonly status: 'recorded'; readonly result: EntitlementLedgerResult }
  | { readonly status: 'evidence_already_processed' }
> {
  try {
    return {
      status: 'recorded',
      result: await store.recordEntitlementGrant(grant),
    };
  } catch (error) {
    if (error instanceof EvidenceAlreadyProcessedError) {
      return { status: 'evidence_already_processed' };
    }

    throw error;
  }
}

const entitlementLocks = new WeakMap<object, Map<string, Promise<void>>>();
/** Hosts such as the Worker create a store per request, so retries lock per process instead. */
const entitlementRetryLockScope = {};

async function withEntitlementEvidenceLocks<T>(
  store: GameServicesStore,
  lockKeys: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const orderedLockKeys = [...new Set(lockKeys)].sort((left, right) => left.localeCompare(right));

  async function runWithLock(index: number): Promise<T> {
    const lockKey = orderedLockKeys[index];
    return lockKey === undefined
      ? task()
      : withEntitlementLockKey(store, lockKey, () => runWithLock(index + 1));
  }

  return runWithLock(0);
}

/**
 * Serialize one retry identity in this backend process, from its ledger lookup to its grant
 * or non-grant decision, so a verifier decision cannot race a same-key grant here.
 */
async function withEntitlementRetryLock<T>(
  identity: EntitlementRetryIdentity,
  task: () => Promise<T>,
): Promise<T> {
  return withEntitlementLockKey(
    entitlementRetryLockScope,
    createEntitlementIdempotencyKey(identity),
    task,
  );
}

async function withEntitlementLockKey<T>(
  scope: object,
  lockKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const scopeLocks = entitlementLocks.get(scope) ?? new Map<string, Promise<void>>();
  entitlementLocks.set(scope, scopeLocks);

  const previous = scopeLocks.get(lockKey) ?? Promise.resolve();
  const gate = createPromiseGate();
  const current = previous.then(() => gate.promise);
  scopeLocks.set(lockKey, current);

  await previous;
  try {
    return await task();
  } finally {
    gate.release();
    if (scopeLocks.get(lockKey) === current) {
      scopeLocks.delete(lockKey);
      if (scopeLocks.size === 0) {
        entitlementLocks.delete(scope);
      }
    }
  }
}

function createPromiseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

interface EntitlementTransactionIdentity {
  readonly source: EntitlementLedgerGrant['source'];
  readonly playerId: string;
  readonly grantId: string;
  readonly target: string;
  /** The purchase's store; a grant recorded without one (pre-C2) matches any. */
  readonly store?: string;
  readonly deploymentTarget?: string;
}

interface EntitlementRetryIdentity extends EntitlementTransactionIdentity {
  readonly idempotencyKey: string;
}

async function findEntitlementTransactionByIdempotency(
  store: GameServicesStore,
  identity: EntitlementRetryIdentity,
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByIdempotency !== undefined) {
    return store.findEntitlementTransactionByIdempotency(identity);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    return transaction.source === identity.source
      && transaction.playerId === identity.playerId
      && transaction.idempotencyKey === identity.idempotencyKey;
  });
}

async function findEntitlementTransactionByEvidenceVerificationId(
  store: GameServicesStore,
  input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  },
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByEvidenceVerificationId !== undefined) {
    return store.findEntitlementTransactionByEvidenceVerificationId(input);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    const storedEvidenceVerificationId = transaction.evidenceVerificationId
      ?? transaction.payload.evidenceVerificationId;

    return transaction.source === input.source
      && storedEvidenceVerificationId === input.evidenceVerificationId;
  });
}

async function findEntitlementTransactionByPlatformEvidence(
  store: GameServicesStore,
  input: EntitlementPlatformEvidenceIdentity,
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByPlatformEvidence !== undefined) {
    return store.findEntitlementTransactionByPlatformEvidence(input);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    const identity = getEntitlementPlatformEvidenceIdentity(transaction);
    return identity !== undefined
      && identity.source === input.source
      && identity.target === input.target
      && identity.platformEvidenceId === input.platformEvidenceId;
  });
}

function getEntitlementPlatformEvidenceIdentity(
  transaction: Pick<ProductGrantTransaction, 'source' | 'payload'>,
): EntitlementPlatformEvidenceIdentity | undefined {
  if (transaction.source !== 'purchase' && transaction.source !== 'ad_reward') {
    return undefined;
  }

  const target = transaction.payload.target;
  const platformEvidenceId = transaction.source === 'purchase'
    ? transaction.payload.platformTransactionId
    : transaction.payload.platformImpressionId;

  if (
    typeof target !== 'string'
    || target.length === 0
    || typeof platformEvidenceId !== 'string'
    || platformEvidenceId.length === 0
  ) {
    return undefined;
  }

  return {
    source: transaction.source,
    target,
    platformEvidenceId,
  };
}

async function recordedEntitlementMatchesRetry(
  store: GameServicesStore,
  result: EntitlementLedgerResult,
  identity: EntitlementRetryIdentity,
): Promise<boolean> {
  const transaction = await store.getEntitlementTransaction(result.ledgerEntryId);
  return transaction !== undefined && matchesEntitlementRetry(transaction, identity);
}

function matchesEntitlementRetry(
  transaction: ProductGrantTransaction,
  identity: EntitlementRetryIdentity,
): boolean {
  return matchesEntitlementTransactionIdentity(transaction, identity)
    && transaction.idempotencyKey === identity.idempotencyKey;
}

function matchesPurchaseEvidenceRecovery(
  transaction: ProductGrantTransaction,
  identity: {
    readonly playerId: string;
    readonly grantId: string;
    readonly target: string;
    readonly store?: string;
    readonly deploymentTarget?: string;
    readonly evidenceVerificationId: string;
  },
): boolean {
  return matchesEntitlementTransactionIdentity(transaction, {
    ...identity,
    source: 'purchase',
  })
    && (
      transaction.evidenceVerificationId
        ?? transaction.payload.evidenceVerificationId
    ) === identity.evidenceVerificationId;
}

function matchesEntitlementTransactionIdentity(
  transaction: ProductGrantTransaction,
  identity: EntitlementTransactionIdentity,
): boolean {
  return transaction.source === identity.source
    && transaction.playerId === identity.playerId
    && transaction.grantId === identity.grantId
    && transaction.payload.target === identity.target
    // Two stores sharing one ledger target never share a grant: a key reused
    // with another store is a conflict, while a grant recorded before the
    // store was written meets any store.
    && (identity.store === undefined
      || transaction.payload.store === undefined
      || transaction.payload.store === identity.store)
    // A grant written without a deployment target (a host fulfillment path)
    // meets the request bound to one; two bound targets must agree.
    && (transaction.payload.deploymentTarget === undefined
      || transaction.payload.deploymentTarget === identity.deploymentTarget);
}

function resolveEvidenceVerificationTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? 10_000;

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('evidenceVerificationTimeoutMs must be a positive finite number.');
  }

  return resolved;
}

function resolvePurchaseGrantFinalizationTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? 15_000;

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('purchaseGrantFinalizationTimeoutMs must be a positive finite number.');
  }

  return resolved;
}

function assertNonEmptyDecisionString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Evidence verification ${label} must be a non-empty string.`);
  }
}

async function recordLeaderboardScoreWithStore(
  input: RecordLeaderboardScoreRequest,
  context: {
    readonly store: GameServicesStore;
    readonly now: () => string;
  },
): Promise<RecordLeaderboardScoreResponse> {
  return context.store.recordLeaderboardScore(assertRecordLeaderboardScoreRequest(input), {
    recordedAt: context.now(),
  });
}

async function routeGameServicesRequest(
  endpoint: GameServicesBackendEndpoint,
  body: unknown,
  backend: GameServicesBackendApi,
): Promise<GameServicesBackendTransportResponse> {
  switch (endpoint) {
    case gameServicesBackendEndpoints.verifyPurchase:
      return okResponse(await backend.purchases.verifyPurchase(body as VerifyPurchaseRequest));
    case gameServicesBackendEndpoints.getPurchaseLedgerStatus:
      if (backend.purchases.getPurchaseLedgerStatus === undefined) {
        return errorResponse(404, 'UNKNOWN_ENDPOINT');
      }
      return okResponse(
        await backend.purchases.getPurchaseLedgerStatus(body as PurchaseLedgerStatusRequest),
      );
    case gameServicesBackendEndpoints.getCommerceCapabilities:
      if (backend.purchases.getCommerceCapabilities === undefined) {
        return errorResponse(404, 'UNKNOWN_ENDPOINT');
      }
      return okResponse(await backend.purchases.getCommerceCapabilities());
    case gameServicesBackendEndpoints.claimAdReward:
      return okResponse(await backend.adRewards.claimAdReward(body as ClaimAdRewardRequest));
    case gameServicesBackendEndpoints.recordLeaderboardScore:
      return okResponse(
        await backend.leaderboard.recordScore(body as RecordLeaderboardScoreRequest),
      );
  }

  return errorResponse(404, 'UNKNOWN_ENDPOINT');
}

function okResponse(body: unknown): GameServicesBackendTransportResponse {
  return {
    status: 200,
    body,
  };
}

function errorResponse(
  status: number,
  error: GameServicesBackendErrorCode,
  message?: string,
): GameServicesBackendTransportResponse<GameServicesBackendErrorResponse> {
  return {
    status,
    body: {
      error,
      ...(message === undefined ? {} : { message }),
    },
  };
}

function createHealthResponse(version = '0.0.0'): GameServicesHealthResponse {
  return {
    ok: true,
    service: 'game-services',
    version,
  };
}

function createEntitlementTransaction(
  grant: EntitlementLedgerGrant,
): ProductGrantTransaction {
  const baseTransaction = {
    ledgerEntryId: createEntitlementLedgerEntryId(grant),
    playerId: grant.playerId,
    grantId: grant.grantId,
    source: grant.source,
    idempotencyKey: grant.idempotencyKey,
    grantedAt: grant.grantedAt,
    payload: grant.payload,
    ...(grant.evidenceVerificationId === undefined
      ? {}
      : { evidenceVerificationId: grant.evidenceVerificationId }),
  };

  return assertProductGrantTransaction(
    grant.grant === undefined ? baseTransaction : { ...baseTransaction, grant: grant.grant },
  );
}

function createEntitlementIdempotencyKey(grant: {
  readonly source: EntitlementLedgerGrant['source'];
  readonly playerId: string;
  readonly idempotencyKey: string;
}): string {
  return createCompositeKey([grant.source, grant.playerId, grant.idempotencyKey]);
}

function createEntitlementEvidenceKey(grant: {
  readonly source: EntitlementLedgerGrant['source'];
  readonly evidenceVerificationId: string;
}): string {
  return createCompositeKey([grant.source, grant.evidenceVerificationId]);
}

function createEntitlementPlatformEvidenceKey(
  identity: EntitlementPlatformEvidenceIdentity,
): string {
  return createCompositeKey([identity.source, identity.target, identity.platformEvidenceId]);
}

function createRevocationIdempotencyKey(revocation: EntitlementLedgerRevocation): string {
  return createCompositeKey(['revoke', revocation.playerId, revocation.idempotencyKey]);
}

function createRevocationLedgerEntryId(revocation: EntitlementLedgerRevocation): string {
  return [
    'revoke',
    encodeIdSegment(revocation.playerId),
    encodeIdSegment(revocation.idempotencyKey),
  ].join('_');
}

function createEntitlementLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    encodeIdSegment(grant.source),
    encodeIdSegment(grant.playerId),
    encodeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function createLeaderboardRunKey(request: RecordLeaderboardScoreRequest): string {
  return createCompositeKey([
    request.target,
    request.leaderboardId,
    request.playerId,
    request.runId,
  ]);
}

function createLeaderboardLedgerEntryId(request: RecordLeaderboardScoreRequest): string {
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

function isGameServicesBackendEndpoint(pathname: string): pathname is GameServicesBackendEndpoint {
  return Object.values(gameServicesBackendEndpoints).includes(
    pathname as GameServicesBackendEndpoint,
  );
}

class RequestPayloadTooLargeError extends Error {
  constructor() {
    super('Request payload exceeds the configured body limit.');
    this.name = 'RequestPayloadTooLargeError';
  }
}

async function readRequestJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const text = await readRequestText(request, maxBodyBytes);

  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text);
}

/** Reads the body incrementally so an oversized payload is rejected before it is buffered. */
async function readRequestText(request: Request, maxBodyBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new RequestPayloadTooLargeError();
  }

  if (request.body === null) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    receivedBytes += value.byteLength;

    if (receivedBytes > maxBodyBytes) {
      await reader.cancel();
      throw new RequestPayloadTooLargeError();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function jsonResponse(body: unknown, status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });
  applyCorsHeaders(headers, corsHeaders);

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function textResponse(body: string, status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, corsHeaders);

  return new Response(body, {
    status,
    headers,
  });
}

function emptyResponse(status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, corsHeaders);

  return new Response(null, {
    status,
    headers,
  });
}

function withCors(response: Response, corsHeaders: CorsHeaders | undefined): Response {
  if (corsHeaders === undefined) {
    return response;
  }

  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, corsHeaders);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyCorsHeaders(headers: Headers, corsHeaders: CorsHeaders | undefined): void {
  if (corsHeaders === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
}

export * from './notification-delivery.js';
export * from './progress-link.js';

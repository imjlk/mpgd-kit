import type { LogicalProductId, PurchaseResult } from '@mpgd/platform';
import {
  assertCommercePurchaseTransition,
  assertRequestPurchaseSupported,
  CommerceError,
  commerceErrorInfoOf,
  createDerivedPurchaseIdempotencyKey,
  isTerminalCommercePurchaseState,
  summarizeCommercePurchaseState,
  type CommerceCapabilities,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type CommercePurchaseState,
  type CommercePurchaseSummaryStatus,
  type FetchProductsInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import type { PurchaseVerificationApi } from './client.js';
import type { MonetizationOperationStore } from './monetization-recovery.js';
import type { GameServicesPurchaseInput, GameServicesPurchaseResult } from './operations.js';
import type {
  GameServicesLedgerTarget,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

/**
 * Commerce v2 reconciler (RFC "Purchase lifecycle", "Reconciler", and
 * "Idempotency keys"). One reconciler per `CommerceProvider` replaces the
 * per-store recovery drivers: it journals every purchase the game starts or
 * the store reports as one record moving through the RFC states, sends the
 * saved verify request to the game backend, and finishes a purchase only after
 * the backend's ledger grant. Nothing here grants: only the backend response
 * moves a record to `granted`, and only the backend ledger moves it to
 * `revoked`.
 */

/** Journal record kind of a commerce v2 purchase. */
export const commercePurchaseOperationKind = 'commerce-purchase' as const;

export type CommercePurchaseOrigin = 'game' | 'discovered';

/**
 * One commerce v2 purchase in the `MonetizationOperationStore`. `key` is the
 * store's global key (`createCommercePurchaseOperationKey`); `idempotencyKey`
 * is the purchase key the backend sees: the game's key for a purchase the
 * game started, or the derived key of a purchase discovered from the store.
 * Every state change is its own revision; `request` is saved before the
 * first send and resent unchanged; `response` is the last backend answer.
 */
export interface CommercePurchaseOperationRecord {
  readonly kind: typeof commercePurchaseOperationKind;
  /** The store must enforce uniqueness across users, not just within one account. */
  readonly key: string;
  readonly playerId: string;
  readonly target: string;
  readonly deploymentTarget: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly store: StoreId;
  readonly logicalId: LogicalProductId;
  /** Unknown while the catalog cannot be read; a client or host finish waits until it is. */
  readonly productKind?: PurchaseKind;
  readonly origin: CommercePurchaseOrigin;
  readonly state: CommercePurchaseState;
  readonly updatedAt: string;
  /** The game's purchase input; absent for a purchase discovered from the store. */
  readonly input?: GameServicesPurchaseInput;
  readonly purchase?: StorePurchase;
  /** Saved before the first send and resent unchanged on later passes. */
  readonly request?: VerifyPurchaseRequest;
  readonly response?: VerifyPurchaseResponse;
  readonly ledgerEntryId?: string;
  readonly error?: CommerceErrorInfo;
  readonly revokedBy?: string;
}

/** The store key of a commerce v2 purchase record: one namespace per ledger target. */
export function createCommercePurchaseOperationKey(
  target: string,
  idempotencyKey: string,
): string {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new Error('Commerce purchase operations require a nonempty idempotency key.');
  }
  return JSON.stringify([target, commercePurchaseOperationKind, idempotencyKey]);
}

export function isCommercePurchaseOperationRecord(
  record: unknown,
): record is CommercePurchaseOperationRecord {
  return typeof record === 'object'
    && record !== null
    && (record as { readonly kind?: unknown }).kind === commercePurchaseOperationKind;
}

/** Summary status of a record: the RFC mapping, with `revoked` kept distinct. */
export function summarizeCommercePurchaseOperation(
  record: CommercePurchaseOperationRecord,
): CommercePurchaseSummaryStatus {
  return summarizeCommercePurchaseState(record.state);
}

/**
 * Only `granted` and `finishing` records that hold the backend's ledger entry
 * id and a store transaction may be finished. The StoreKit v2 SDK keeps no
 * finish allow-list of its own (the v1 driver's `finishGrantedTransaction`
 * pairing), so this is the finish gate for every `client` and `host` owner:
 * the ledger entry id comes from the journal revision the backend grant wrote.
 */
export function assertCommerceFinishAllowed(
  record: CommercePurchaseOperationRecord,
): { readonly transactionId: string; readonly ledgerEntryId: string } {
  if (record.state !== 'granted' && record.state !== 'finishing') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} is ${record.state}; only granted or finishing records are finished.`,
    );
  }
  const ledgerEntryId = record.ledgerEntryId;
  const transactionId = record.purchase?.transactionId;
  if (typeof ledgerEntryId !== 'string' || ledgerEntryId.trim() === '') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} has no ledger entry id; the backend grant must finish it.`,
    );
  }
  if (typeof transactionId !== 'string' || transactionId.trim() === '') {
    throw new Error(
      `Commerce purchase ${record.idempotencyKey} has no store transaction to finish.`,
    );
  }
  return { transactionId, ledgerEntryId };
}

/** The `GameServicesPurchaseResult` a journal record stands for; `pending` allows no client-side grant. */
export function toGameServicesPurchaseResult(
  record: CommercePurchaseOperationRecord,
): GameServicesPurchaseResult {
  const status = summarizeCommercePurchaseOperation(record);
  return {
    status,
    purchase: toPurchaseResult(record),
    ...(record.response === undefined ? {} : { verification: record.response }),
    ...(record.ledgerEntryId === undefined ? {} : { ledgerEntryId: record.ledgerEntryId }),
  };
}

function toPurchaseResult(record: CommercePurchaseOperationRecord): PurchaseResult {
  const purchase = record.purchase;
  if (record.state === 'cancelled' || record.state === 'failed') {
    return {
      status: record.state,
      entitlementIds: [],
      ...(record.error === undefined ? {} : { diagnostic: toDiagnostic(record.error) }),
    };
  }
  if (purchase === undefined) {
    return { status: 'pending', entitlementIds: [] };
  }
  return {
    status: purchase.state === 'purchased' ? 'completed' : 'pending',
    transactionId: purchase.transactionId,
    entitlementIds: [],
    evidence: purchase.evidence,
  };
}

function toDiagnostic(error: CommerceErrorInfo): NonNullable<PurchaseResult['diagnostic']> {
  const providerCode = error.storeCode;
  return {
    code: error.code,
    retryable: error.retryable,
    ...(providerCode !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/u.test(providerCode)
      ? { providerCode }
      : {}),
  };
}

// Reconciler.

/** A catalog entry the reconciler resolves kinds and SKUs from without a store read. */
export interface CommerceReconcilerProduct {
  readonly logicalId: LogicalProductId;
  readonly kind: PurchaseKind;
  readonly storeSku?: string;
}

export type CommerceReconcilerFailureStage =
  | 'capabilities'
  | 'available'
  | 'catalog'
  | 'match'
  | 'journal'
  | 'verify'
  | 'finish'
  | 'ledger-status'
  | 'restore';

export type CommerceReconcilerEvent =
  | {
      readonly type: 'transition';
      readonly record: CommercePurchaseOperationRecord;
      /** Undefined when the record was just reserved. */
      readonly previous: CommercePurchaseState | undefined;
    }
  | { readonly type: 'verify-requested'; readonly record: CommercePurchaseOperationRecord }
  | {
      readonly type: 'verify-result';
      readonly record: CommercePurchaseOperationRecord;
      readonly response: VerifyPurchaseResponse;
    }
  | {
      readonly type: 'failure';
      readonly stage: CommerceReconcilerFailureStage;
      readonly idempotencyKey?: string;
      readonly error: unknown;
    };

export interface CreateCommerceReconcilerInput {
  readonly provider: CommerceProvider;
  /** The game backend; `getPurchaseLedgerStatus` enables the revocation pass once the server exposes it (C2). */
  readonly backend: PurchaseVerificationApi;
  /** Durable, compare-and-swap journal shared with the v1 recovery client. */
  readonly store: MonetizationOperationStore;
  readonly playerId: string;
  /** Ledger target sent as `VerifyPurchaseRequest.target`. */
  readonly target: GameServicesLedgerTarget;
  readonly deploymentTarget?: string;
  /**
   * Catalog mapping consulted before `fetchProducts`; required for a provider
   * whose product list cannot be read before the first purchase.
   */
  readonly products?: readonly CommerceReconcilerProduct[];
  readonly now?: () => string;
  readonly onEvent?: (event: CommerceReconcilerEvent) => void;
  /**
   * How long a `launched` record with no store purchase keeps serializing
   * purchases of its product. After it the attempt is `failed` with
   * `OUTCOME_UNKNOWN`; a purchase the store reports later is journaled under
   * its derived key. Defaults to 24 hours; `Infinity` keeps the RFC rule
   * without expiry.
   */
  readonly staleLaunchedAfterMs?: number;
}

export const defaultStaleLaunchedAfterMs = 24 * 60 * 60 * 1000;

export interface CommerceReconciler {
  readonly provider: CommerceProvider;
  readonly started: boolean;
  /** Subscribe to the provider, read its available purchases when declared, then reconcile until idle. */
  start(): Promise<void>;
  /** Unsubscribe and drop in-memory state; the journal keeps every record. */
  stop(): Promise<void>;
  /** One reconcile pass (the app-resume trigger), then any passes that events arriving meanwhile trigger. */
  reconcile(): Promise<void>;
  /** Reconcile while a trigger is pending; a no-op when stopped. */
  runUntilIdle(): Promise<void>;
  /** The manual restore trigger: `provider.restorePurchases` when offered, then a pass over the available purchases. */
  restorePurchases(): Promise<void>;
  /** Journals the attempt, opens the store once per key, and reconciles the result. Never reopens the store UI for a journaled key. */
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  fetchProducts(input?: FetchProductsInput): Promise<readonly StoreProduct[]>;
  /** The record journaled under a purchase idempotency key. */
  read(idempotencyKey: string): Promise<CommercePurchaseOperationRecord | undefined>;
  /** The player's open records for this provider's store. */
  listRecoverable(): Promise<readonly CommercePurchaseOperationRecord[]>;
  subscribe(listener: (event: CommerceReconcilerEvent) => void): () => void;
}

type OpenState = Extract<CommercePurchaseState, 'launched' | 'pending'>;

function isOpen(state: CommercePurchaseState): state is OpenState {
  return state === 'launched' || state === 'pending';
}

export function createCommerceReconciler(input: CreateCommerceReconcilerInput): CommerceReconciler {
  const { provider, backend, store: journal, playerId } = input;
  const storeId = provider.store;
  const target = input.target;
  const deploymentTarget = input.deploymentTarget ?? input.target;
  const now = input.now ?? (() => new Date().toISOString());
  const staleLaunchedAfterMs = input.staleLaunchedAfterMs ?? defaultStaleLaunchedAfterMs;
  if (typeof playerId !== 'string' || playerId.trim() === '') {
    throw new TypeError('The commerce reconciler requires an authenticated player id.');
  }
  if (!(staleLaunchedAfterMs > 0)) {
    throw new RangeError('staleLaunchedAfterMs must be a positive duration.');
  }

  const listeners = new Set<(event: CommerceReconcilerEvent) => void>();
  if (input.onEvent !== undefined) {
    listeners.add(input.onEvent);
  }
  const emit = (event: CommerceReconcilerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Observers have no authority over the journal.
      }
    }
  };
  const fail = (
    stage: CommerceReconcilerFailureStage,
    error: unknown,
    idempotencyKey?: string,
  ): void => {
    emit({
      type: 'failure',
      stage,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      error,
    });
  };

  /** Records seen this session by purchase idempotency key, terminal ones included for matching. */
  const records = new Map<string, CommercePurchaseOperationRecord>();
  const inbox: CommerceEvent[] = [];
  /** Keys whose `requestPurchase` call is still running; a `requested` record outside it is stale. */
  const inFlightKeys = new Set<string>();
  const productCache = new Map<string, CommerceReconcilerProduct>();
  let capabilities: CommerceCapabilities | undefined;
  let unsubscribe: (() => void) | undefined;
  let started = false;
  let triggerPending = false;
  let running: Promise<void> | undefined;
  let pendingFailure: { readonly error: unknown } | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  /** Passes and purchase requests never interleave their journal writes. */
  function withLock<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  }

  const trigger = (): void => {
    triggerPending = true;
  };

  const ownsRecord = (record: CommercePurchaseOperationRecord): boolean =>
    record.playerId === playerId
    && record.target === target
    && record.deploymentTarget === deploymentTarget
    && record.store === storeId;

  const remember = (record: CommercePurchaseOperationRecord): CommercePurchaseOperationRecord => {
    records.set(record.idempotencyKey, record);
    return record;
  };

  const readCapabilities = async (): Promise<CommerceCapabilities | undefined> => {
    if (capabilities !== undefined) {
      return capabilities;
    }
    try {
      capabilities = await provider.getCapabilities();
      return capabilities;
    } catch (error) {
      fail('capabilities', error);
      return undefined;
    }
  };

  const resolveProduct = async (
    lookup: { readonly logicalId: string } | { readonly storeSku: string },
  ): Promise<CommerceReconcilerProduct | undefined> => {
    const matches = (product: CommerceReconcilerProduct): boolean =>
      'logicalId' in lookup
        ? product.logicalId === lookup.logicalId
        : product.storeSku === lookup.storeSku;
    const configured = input.products?.find(matches);
    if (configured !== undefined) {
      return configured;
    }
    const cached = [...productCache.values()].find(matches);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const products = await provider.fetchProducts(
        'logicalId' in lookup
          ? { logicalIds: [lookup.logicalId as CommerceLogicalProductId] }
          : { type: 'all' },
      );
      for (const product of products) {
        productCache.set(product.logicalId, {
          logicalId: product.logicalId,
          kind: product.kind,
          storeSku: product.storeSku,
        });
      }
      return [...productCache.values()].find(matches);
    } catch (error) {
      fail('catalog', error);
      return undefined;
    }
  };

  const resolveLogicalId = async (
    purchase: StorePurchase,
  ): Promise<{ readonly logicalId: LogicalProductId; readonly kind?: PurchaseKind } | undefined> => {
    const product = purchase.logicalId === undefined
      ? await resolveProduct({ storeSku: purchase.storeSku })
      : await resolveProduct({ logicalId: purchase.logicalId });
    if (product === undefined) {
      if (purchase.logicalId !== undefined) {
        // The provider mapped the SKU itself. The kind stays unknown until the
        // catalog answers: a client or host finish never guesses consumable.
        return { logicalId: purchase.logicalId };
      }
      return undefined;
    }
    return { logicalId: product.logicalId, kind: product.kind };
  };

  const write = async (
    record: CommercePurchaseOperationRecord,
    state: CommercePurchaseState,
    patch: Partial<CommercePurchaseOperationRecord> = {},
  ): Promise<CommercePurchaseOperationRecord> => {
    assertCommercePurchaseTransition(record.state, state);
    const next: CommercePurchaseOperationRecord = {
      ...record,
      ...patch,
      state,
      revision: record.revision + 1,
      updatedAt: now(),
    };
    await journal.replace(record.revision, next);
    remember(next);
    emit({ type: 'transition', record: next, previous: record.state });
    return next;
  };

  const reserve = async (
    record: Omit<CommercePurchaseOperationRecord, 'kind' | 'key' | 'playerId' | 'target' | 'deploymentTarget' | 'revision' | 'updatedAt'>,
  ): Promise<{ readonly created: boolean; readonly record: CommercePurchaseOperationRecord }> => {
    const candidate: CommercePurchaseOperationRecord = {
      ...record,
      kind: commercePurchaseOperationKind,
      key: createCommercePurchaseOperationKey(target, record.idempotencyKey),
      playerId,
      target,
      deploymentTarget,
      revision: 0,
      updatedAt: now(),
    };
    const reserved = await journal.reserve(candidate);
    if (!isCommercePurchaseOperationRecord(reserved.record)) {
      throw new Error('Commerce purchase operation key is bound to another operation kind.');
    }
    if (!ownsRecord(reserved.record)) {
      throw new Error('Commerce purchase operation key is bound to another player or store.');
    }
    remember(reserved.record);
    if (reserved.created) {
      emit({ type: 'transition', record: reserved.record, previous: undefined });
    }
    return { created: reserved.created, record: reserved.record };
  };

  const readRecord = async (
    idempotencyKey: string,
  ): Promise<CommercePurchaseOperationRecord | undefined> => {
    const found = await journal.read(createCommercePurchaseOperationKey(target, idempotencyKey));
    if (found === undefined) {
      return records.get(idempotencyKey);
    }
    if (!isCommercePurchaseOperationRecord(found) || !ownsRecord(found)) {
      throw new Error('Commerce purchase operation key is bound to another player or store.');
    }
    return remember(found);
  };

  const ownedRecordsOf = (
    listed: readonly unknown[],
  ): CommercePurchaseOperationRecord[] =>
    listed.filter(
      (record): record is CommercePurchaseOperationRecord =>
        isCommercePurchaseOperationRecord(record) && ownsRecord(record),
    );

  const listRecoverable = async (): Promise<CommercePurchaseOperationRecord[]> =>
    ownedRecordsOf(await journal.listRecoverable(playerId))
      .filter((record) => !isTerminalCommercePurchaseState(record.state))
      .map(remember);

  const listGranted = async (): Promise<CommercePurchaseOperationRecord[]> => {
    const listed = journal.listGranted === undefined
      ? []
      : ownedRecordsOf(await journal.listGranted(playerId)).map(remember);
    const granted = new Map<string, CommercePurchaseOperationRecord>();
    for (const record of [...listed, ...records.values()]) {
      if (
        record.ledgerEntryId !== undefined
        && (record.state === 'granted' || record.state === 'finishing' || record.state === 'finished')
      ) {
        granted.set(record.idempotencyKey, record);
      }
    }
    return [...granted.values()];
  };

  const loadRecords = async (): Promise<void> => {
    await listRecoverable();
    if (journal.listGranted !== undefined) {
      ownedRecordsOf(await journal.listGranted(playerId)).forEach(remember);
    }
  };

  const openRecordsFor = (logicalId: string | undefined): CommercePurchaseOperationRecord[] =>
    [...records.values()].filter(
      (record) =>
        record.store === storeId
        && (logicalId === undefined || record.logicalId === logicalId)
        && isOpen(record.state),
    );

  const listener = (event: CommerceEvent): void => {
    if (event.type === 'subscriptionUpdated') {
      return;
    }
    inbox.push(event);
    trigger();
    scheduleRun();
  };

  const readAvailable = async (capabilitiesNow: CommerceCapabilities): Promise<void> => {
    if (!capabilitiesNow.lifecycle.availablePurchases) {
      return;
    }
    try {
      const available = await provider.getAvailablePurchases({
        includePending: capabilitiesNow.lifecycle.pending,
      });
      for (const purchase of available) {
        inbox.push({ type: 'purchaseUpdated', purchase });
      }
    } catch (error) {
      fail('available', error);
    }
  };

  const buildRequest = (
    record: CommercePurchaseOperationRecord,
  ): VerifyPurchaseRequest => {
    const purchase = record.purchase;
    if (purchase === undefined) {
      throw new Error(
        `Commerce purchase ${record.idempotencyKey} is purchased without a purchase.`,
      );
    }
    return {
      // C2 opens `VerifyPurchaseRequest.target` to any `StoreId`; until then
      // the ledger target is sent and the server decides whether it serves it.
      target: target as VerifyPurchaseRequest['target'],
      ...(deploymentTarget === target ? {} : { deploymentTarget }),
      playerId,
      productId: record.logicalId,
      platformTransactionId: purchase.transactionId,
      idempotencyKey: record.idempotencyKey,
      purchasedAt: purchase.purchasedAt ?? now(),
      evidence: purchase.evidence,
    };
  };

  // Reconciler step 2: match a reported purchase to a journal record.
  const ingestPurchase = async (purchase: StorePurchase): Promise<void> => {
    if (purchase.store !== storeId) {
      fail(
        'match',
        new Error(
          `Purchase ${purchase.transactionId} belongs to store ${purchase.store}, not ${storeId}.`,
        ),
      );
      return;
    }
    const product = await resolveLogicalId(purchase);
    if (product === undefined) {
      fail(
        'catalog',
        new Error(
          `Purchase ${purchase.transactionId} names SKU ${purchase.storeSku}, which no catalog entry declares.`,
        ),
      );
      return;
    }
    let record = [...records.values()].find(
      (candidate) =>
        candidate.store === storeId
        && candidate.purchase?.transactionId === purchase.transactionId,
    );
    if (record === undefined) {
      const open = openRecordsFor(product.logicalId);
      if (open.length > 1) {
        fail(
          'match',
          new Error(
            `Purchase ${purchase.transactionId} matches ${open.length} open records for ${product.logicalId}.`,
          ),
          open[0]?.idempotencyKey,
        );
        return;
      }
      record = open[0];
      if (record?.purchase !== undefined && record.purchase.transactionId !== purchase.transactionId) {
        // The open attempt already holds another transaction (store-side or
        // backend-side pending): this is a second purchase of the product.
        record = undefined;
      }
    }
    if (record === undefined) {
      if (purchase.state === 'revoked') {
        // Revoked store states never revoke on their own: only the ledger does (step 5).
        return;
      }
      const idempotencyKey = await createDerivedPurchaseIdempotencyKey({
        store: purchase.store,
        transactionId: purchase.transactionId,
        token: purchase.token,
      });
      record = await readRecord(idempotencyKey);
      if (record === undefined) {
        await reserve({
          idempotencyKey,
          store: purchase.store,
          logicalId: product.logicalId,
          ...(product.kind === undefined ? {} : { productKind: product.kind }),
          origin: 'discovered',
          state: purchase.state,
          purchase,
        });
        return;
      }
    }
    if (purchase.state === 'pending' && record.state === 'launched') {
      await write(record, 'pending', { purchase });
      return;
    }
    if (
      purchase.state === 'purchased'
      && (record.state === 'launched' || (record.state === 'pending' && record.request === undefined))
    ) {
      await write(record, 'purchased', { purchase });
    }
  };

  const ingestError = async (
    logicalId: CommerceLogicalProductId | undefined,
    error: CommerceErrorInfo,
  ): Promise<void> => {
    if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'ALREADY_OWNED') {
      // Not terminal for an attempt: an unfinished purchase may exist, so the
      // record stays open and the available purchases resolve it.
      return;
    }
    // Only an attempt the store never answered can end on an error event: a
    // record holding a store purchase or a saved verify request is decided by
    // the available purchases and the backend, never by a later error.
    const open = openRecordsFor(logicalId).filter(
      (record) => record.purchase === undefined && record.request === undefined,
    );
    if (open.length > 1) {
      fail(
        'match',
        new Error(
          `purchaseError${logicalId === undefined ? '' : ` for ${logicalId}`} matches ${open.length} open records.`,
        ),
      );
      return;
    }
    const record = open[0];
    if (record !== undefined) {
      await write(record, error.code === 'USER_CANCELLED' ? 'cancelled' : 'failed', { error });
    }
  };

  const staleAttemptError = (message: string): CommerceErrorInfo => ({
    code: 'OUTCOME_UNKNOWN',
    retryable: false,
    message,
  });

  const sendVerify = async (
    record: CommercePurchaseOperationRecord,
    request: VerifyPurchaseRequest,
  ): Promise<VerifyPurchaseResponse | undefined> => {
    emit({ type: 'verify-requested', record });
    try {
      const response = await backend.verifyPurchase(request);
      emit({ type: 'verify-result', record, response });
      return response;
    } catch (error) {
      // Transport failure: the state is kept and the next pass resends the saved request.
      fail('verify', error, record.idempotencyKey);
      return undefined;
    }
  };

  // Reconciler steps 3 and 4: drive one record as far as the backend and the store allow.
  const drive = async (
    initial: CommercePurchaseOperationRecord,
    capabilitiesNow: CommerceCapabilities | undefined,
  ): Promise<void> => {
    let record = initial;
    /** Finalization the grant of this drive reported; a later pass re-reads it from the backend. */
    let finalization: 'pending' | 'completed' | undefined;
    try {
      for (;;) {
        switch (record.state) {
          case 'requested':
            if (inFlightKeys.has(record.idempotencyKey)) {
              return;
            }
            // The store answer was never journaled (a crash or a lost write
            // after the reservation): the attempt ends so the product is not
            // serialized behind it; a purchase the store reports later is
            // journaled under its derived key.
            await write(record, 'failed', {
              error: staleAttemptError(
                `The store answer for ${record.idempotencyKey} was never journaled.`,
              ),
            });
            return;
          case 'launched': {
            if (record.purchase !== undefined || inFlightKeys.has(record.idempotencyKey)) {
              return;
            }
            const age = Date.parse(now()) - Date.parse(record.updatedAt);
            if (Number.isFinite(age) && age > staleLaunchedAfterMs) {
              await write(record, 'failed', {
                error: staleAttemptError(
                  `No store purchase was reported for ${record.idempotencyKey} within ${String(staleLaunchedAfterMs)} ms.`,
                ),
              });
            }
            return;
          }
          case 'purchased':
            record = await write(record, 'verifying', {
              request: record.request ?? buildRequest(record),
            });
            continue;
          case 'pending':
            if (record.request === undefined) {
              // Store-side pending: waiting on the store, never sent.
              return;
            }
            record = await write(record, 'verifying');
            continue;
          case 'verifying': {
            const request = record.request ?? buildRequest(record);
            const response = await sendVerify(record, request);
            if (response === undefined) {
              return;
            }
            if (!response.verified) {
              if (response.disposition === 'pending') {
                await write(record, 'pending', { request, response });
              } else {
                await write(record, 'rejected', { request, response });
              }
              return;
            }
            const ledgerEntryId = response.ledgerEntryId;
            if (typeof ledgerEntryId !== 'string' || ledgerEntryId.trim() === '') {
              fail(
                'verify',
                new Error(
                  `A verified response for ${record.idempotencyKey} must carry a ledgerEntryId.`,
                ),
                record.idempotencyKey,
              );
              return;
            }
            finalization = response.finalization?.status;
            record = await write(record, 'granted', { request, response, ledgerEntryId });
            continue;
          }
          case 'granted':
            if (capabilitiesNow === undefined) {
              return;
            }
            if (capabilitiesNow.lifecycle.finish === 'none') {
              await write(record, 'finished');
              return;
            }
            record = await write(record, 'finishing');
            continue;
          case 'finishing': {
            if (capabilitiesNow === undefined) {
              return;
            }
            const owner = capabilitiesNow.lifecycle.finish;
            if (owner === 'none') {
              await write(record, 'finished');
              return;
            }
            if (owner === 'server') {
              if (finalization === undefined) {
                // A pass that did not grant resends the saved request to read
                // finalization; the backend replays the grant, never a second one.
                const response = await sendVerify(record, record.request ?? buildRequest(record));
                finalization = response?.verified === true
                  ? response.finalization?.status
                  : undefined;
              }
              if (finalization === 'completed') {
                await write(record, 'finished');
              }
              return;
            }
            const finish = assertCommerceFinishAllowed(record);
            if (provider.finishTransaction === undefined) {
              fail(
                'finish',
                new Error(`The provider declares finish '${owner}' but has no finishTransaction.`),
                record.idempotencyKey,
              );
              return;
            }
            // A consume and an acknowledge are not interchangeable: the finish
            // waits until the catalog says which kind the product is.
            const kind = record.productKind
              ?? (await resolveProduct({ logicalId: record.logicalId }))?.kind;
            if (kind === undefined) {
              fail(
                'catalog',
                new Error(
                  `The kind of ${record.logicalId} is unknown; the finish waits for the catalog.`,
                ),
                record.idempotencyKey,
              );
              return;
            }
            let finished = false;
            try {
              finished = (await provider.finishTransaction({
                transactionId: finish.transactionId,
                ledgerEntryId: finish.ledgerEntryId,
                isConsumable: kind === 'consumable',
              })).finished;
            } catch (error) {
              // Transport-class failure: keep `finishing` for the next pass.
              fail('finish', error, record.idempotencyKey);
              return;
            }
            if (finished) {
              await write(record, 'finished');
            }
            return;
          }
          default:
            return;
        }
      }
    } catch (error) {
      // A journal write that lost its compare-and-swap, or a malformed record:
      // the next pass reads the stored revision again.
      fail('journal', error, record.idempotencyKey);
    }
  };

  // Reconciler step 5: reversed grants move to revoked. Needs the backend's
  // ledger status read (C2); without it the hook is inert.
  const revokeReversed = async (): Promise<void> => {
    const ledgerStatus = backend.getPurchaseLedgerStatus;
    if (ledgerStatus === undefined) {
      return;
    }
    const granted = await listGranted();
    if (granted.length === 0) {
      return;
    }
    const ledgerEntryIds = [...new Set(granted.flatMap((record) =>
      (record.ledgerEntryId === undefined ? [] : [record.ledgerEntryId])))];
    let statuses: readonly { readonly ledgerEntryId: string; readonly status: string; readonly reversedBy?: string }[];
    try {
      statuses = (await ledgerStatus.call(backend, { ledgerEntryIds })).statuses;
    } catch (error) {
      fail('ledger-status', error);
      return;
    }
    for (const record of granted) {
      const status = statuses.find((candidate) => candidate.ledgerEntryId === record.ledgerEntryId);
      if (status?.status !== 'reversed') {
        continue;
      }
      try {
        await write(record, 'revoked', {
          ...(status.reversedBy === undefined ? {} : { revokedBy: status.reversedBy }),
        });
      } catch (error) {
        fail('journal', error, record.idempotencyKey);
      }
    }
  };

  const pass = async (): Promise<void> => {
    const capabilitiesNow = await readCapabilities();
    // A provider without lifecycle.events is polled: every pass reads its available purchases.
    if (capabilitiesNow !== undefined && !capabilitiesNow.lifecycle.events) {
      await readAvailable(capabilitiesNow);
    }
    for (const event of inbox.splice(0, inbox.length)) {
      try {
        if (event.type === 'purchaseUpdated') {
          await ingestPurchase(event.purchase);
        } else if (event.type === 'purchaseError') {
          await ingestError(event.logicalId, event.error);
        }
      } catch (error) {
        fail('journal', error);
      }
    }
    for (const record of await listRecoverable()) {
      await drive(records.get(record.idempotencyKey) ?? record, capabilitiesNow);
    }
    await revokeReversed();
  };

  const runUntilIdle = async (): Promise<void> => {
    if (running !== undefined) {
      try {
        await running;
      } catch (error) {
        pendingFailure = undefined;
        throw error;
      }
      // An event that landed between the loop's last check and its teardown.
      if (started && triggerPending && running === undefined) {
        await runUntilIdle();
      }
      return;
    }
    if (pendingFailure !== undefined) {
      const failure = pendingFailure;
      pendingFailure = undefined;
      throw failure.error;
    }
    if (!started || !triggerPending) {
      return;
    }
    const loop = (async () => {
      while (started && triggerPending) {
        triggerPending = false;
        await withLock(pass);
      }
    })();
    running = loop.finally(() => {
      running = undefined;
    });
    await running;
  };
  function scheduleRun(): void {
    runUntilIdle().catch((error: unknown) => {
      pendingFailure = { error };
    });
  }

  const journaled = (record: CommercePurchaseOperationRecord): RequestPurchaseResult => {
    if ((record.state === 'cancelled' || record.state === 'failed') && record.error !== undefined) {
      return { outcome: record.state, error: record.error };
    }
    if (record.purchase !== undefined && record.state !== 'requested') {
      return { outcome: 'purchased', purchase: record.purchase };
    }
    return { outcome: 'launched' };
  };

  const requestPurchase = async (request: RequestPurchaseInput): Promise<RequestPurchaseResult> =>
    withLock(async (): Promise<RequestPurchaseResult> => {
      if (!started) {
        await loadRecords();
      }
      // A key is never regenerated on retry: the journaled attempt is the answer,
      // and the store UI opens once per key however many calls overlap.
      const existing = await readRecord(request.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.logicalId !== request.logicalId
          || (existing.input !== undefined && existing.input.source !== request.source)
        ) {
          throw new Error('Purchase idempotency key is bound to another product or source.');
        }
        return journaled(existing);
      }
      const product = await resolveProduct({ logicalId: request.logicalId });
      if (product === undefined) {
        return {
          outcome: 'failed',
          error: new CommerceError('ITEM_UNAVAILABLE', {
            message: `Store ${storeId} does not sell ${request.logicalId}.`,
          }).toCommerceErrorInfo(),
        };
      }
      inFlightKeys.add(request.idempotencyKey);
      const { created, record } = await reserve({
        idempotencyKey: request.idempotencyKey,
        store: storeId,
        logicalId: product.logicalId,
        productKind: product.kind,
        origin: 'game',
        state: 'requested',
        input: {
          productId: product.logicalId,
          source: request.source,
          idempotencyKey: request.idempotencyKey,
        },
      });
      if (!created) {
        return journaled(record);
      }
      const failWith = async (error: unknown): Promise<RequestPurchaseResult> => {
        const info = commerceErrorInfoOf(error);
        await write(record, 'failed', { error: info });
        return { outcome: 'failed', error: info };
      };
      const capabilitiesNow = await readCapabilities();
      if (capabilitiesNow === undefined) {
        return failWith(new CommerceError('NOT_PREPARED', {
          message: `The ${storeId} provider capabilities could not be read.`,
        }));
      }
      try {
        assertRequestPurchaseSupported(capabilitiesNow, request, product.kind);
      } catch (error) {
        return failWith(error);
      }
      // Purchases are serialized per player, store, and logical product: an
      // open attempt for the same product fails this one with IN_PROGRESS, so
      // a reported purchase matches at most one open record. Overlapping
      // calls never both reach here: the lock orders them, and the later one
      // finds the earlier attempt already launched.
      const open = (await listRecoverable()).filter(
        (candidate) =>
          candidate.idempotencyKey !== record.idempotencyKey
          && candidate.logicalId === product.logicalId
          && isOpen(candidate.state),
      );
      if (open.length > 0) {
        return failWith(new CommerceError('IN_PROGRESS', {
          message: `A purchase of ${product.logicalId} is already in progress (${open[0]?.idempotencyKey}).`,
        }));
      }
      let result: RequestPurchaseResult;
      try {
        result = await provider.requestPurchase(request);
      } catch (error) {
        return failWith(error);
      }
      if (result.outcome === 'launched') {
        await write(record, 'launched');
      } else if (result.outcome === 'purchased') {
        const purchase = result.purchase;
        const launched = await write(record, 'launched');
        const reported = await resolveLogicalId(purchase);
        if (purchase.store !== storeId || reported?.logicalId !== product.logicalId) {
          // A synchronous answer for another product is not this attempt's
          // purchase; the attempt stays open and the available purchases decide.
          fail(
            'match',
            new Error(`The provider answered ${request.idempotencyKey} with purchase ${purchase.transactionId} for ${purchase.store}/${purchase.storeSku}.`),
            record.idempotencyKey,
          );
          return { outcome: 'launched' };
        }
        if (purchase.state === 'pending') {
          await write(launched, 'pending', { purchase });
        } else if (purchase.state === 'purchased') {
          await write(launched, 'purchased', { purchase });
        }
      } else {
        await write(record, result.outcome, { error: result.error });
      }
      return result;
    }).then(
      async (result) => {
        inFlightKeys.delete(request.idempotencyKey);
        trigger();
        try {
          await runUntilIdle();
        } catch (error) {
          // The store answer is journaled; a pass that failed meanwhile is
          // reported, not thrown at the caller of a purchase already made.
          fail('journal', error, request.idempotencyKey);
        }
        return result;
      },
      (error: unknown) => {
        inFlightKeys.delete(request.idempotencyKey);
        throw error;
      },
    );

  return {
    provider,
    get started() {
      return started;
    },
    async start() {
      if (started) {
        return;
      }
      try {
        await withLock(async () => {
          await loadRecords();
          // Subscribe first, then read: an event delivered before the listener is found either way.
          unsubscribe = provider.subscribe(listener);
          started = true;
          const capabilitiesNow = await readCapabilities();
          // An event-less provider is polled by the first pass instead, so it is read once.
          if (capabilitiesNow !== undefined && capabilitiesNow.lifecycle.events) {
            await readAvailable(capabilitiesNow);
          }
          trigger();
        });
      } catch (error) {
        // A failed start is retryable: nothing stays subscribed or started.
        started = false;
        unsubscribe?.();
        unsubscribe = undefined;
        throw error;
      }
      await runUntilIdle();
    },
    async stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
      // Quiesce: a pass awaiting the backend or the store finishes before state is dropped.
      if (running !== undefined) {
        try {
          await running;
        } catch (error) {
          pendingFailure = { error };
        }
      }
      await tail;
      triggerPending = false;
      inbox.length = 0;
      records.clear();
    },
    async reconcile() {
      await withLock(async () => {
        if (!started) {
          await loadRecords();
        }
        await pass();
      });
      await runUntilIdle();
    },
    runUntilIdle,
    async restorePurchases() {
      if (provider.restorePurchases !== undefined) {
        try {
          await provider.restorePurchases();
        } catch (error) {
          fail('restore', error);
        }
      }
      await withLock(async () => {
        if (!started) {
          await loadRecords();
        }
        const capabilitiesNow = await readCapabilities();
        // A polled provider is read by the pass itself.
        if (capabilitiesNow !== undefined && capabilitiesNow.lifecycle.events) {
          await readAvailable(capabilitiesNow);
        }
        await pass();
      });
      await runUntilIdle();
    },
    requestPurchase,
    async fetchProducts(request = {}) {
      return provider.fetchProducts(request);
    },
    read: readRecord,
    listRecoverable,
    subscribe(listenerToAdd) {
      listeners.add(listenerToAdd);
      return () => {
        listeners.delete(listenerToAdd);
      };
    },
  };
}

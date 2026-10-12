import type { PlatformEvidenceEnvelope, PurchaseResult, RewardedAdResult } from '@mpgd/platform';

import {
  createGameServicesClient,
  type CreateGameServicesClientInput,
  type GameServicesClient,
} from './client.js';
import { resolveClientRewardClaim } from './client-reward-evidence.js';
import {
  summarizeCommercePurchaseOperation,
  type CommercePurchaseOperationRecord,
  type CommerceReconciler,
} from './commerce-reconciler.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import { isRetiredPurchaseOpen } from './monetization-operation-store.js';
import type {
  GameServicesOperationClient,
  GameServicesPurchaseInput,
  GameServicesPurchaseResult,
  GameServicesRewardedAdInput,
  GameServicesRewardedAdResult,
} from './operations.js';
import {
  forwardGameServicesProgress,
  observeGameServicesOperation,
  type GameServicesOperationOptions,
  type GameServicesPurchaseProgress,
  type GameServicesRewardedAdProgress,
  type OperationReporter,
} from './operation-progress.js';
import type {
  ClaimAdRewardRequest,
  ClaimAdRewardResponse,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

interface OperationIdentity {
  /** The store must enforce uniqueness across users, not just within one account. */
  readonly key: string;
  readonly playerId: string;
  readonly target: string;
  readonly deploymentTarget: string;
  readonly revision: number;
  /** Fixed when a platform result is first journaled, before backend dispatch. */
  readonly platformCompletedAt?: string;
}

/**
 * The v1 purchase journal record. Releases before commerce v2 C4 wrote them;
 * the reconciler is now the only purchase path, so nothing starts, reopens, or
 * grants from one. A durable journal still parses it, and the one thing
 * `reconcile()` still does with it is finish an in-flight verification: a
 * record that holds a completed platform result and no terminal result sends
 * its saved verify request (or the one its own fields describe) to the
 * backend once more, through the ledger and under the same idempotency key,
 * then closes the record with what the backend answered. A record without a
 * completed platform result is closed without a request: whatever the store
 * still holds is found again from the store's own unfinished list.
 */
export type RetiredPurchaseOperationRecord = OperationIdentity & {
  readonly kind: 'purchase';
  readonly input: GameServicesPurchaseInput;
  readonly platform?: PurchaseResult;
  readonly request?: VerifyPurchaseRequest;
  readonly response?: VerifyPurchaseResponse;
  readonly result?: GameServicesPurchaseResult;
};

/** The rewarded-ad journal record. */
export type RewardedAdOperationRecord = OperationIdentity & {
  readonly kind: 'rewarded-ad';
  readonly input: GameServicesRewardedAdInput;
  readonly platform?: RewardedAdResult;
  readonly request?: ClaimAdRewardRequest;
  readonly response?: ClaimAdRewardResponse;
  readonly result?: GameServicesRewardedAdResult;
};

/** The pre-reconciler journal records: a retired purchase record and the live rewarded-ad record. */
export type LegacyMonetizationOperationRecord =
  | RetiredPurchaseOperationRecord
  | RewardedAdOperationRecord;

/**
 * Every record kind the journal holds. `commerce-purchase` records are the
 * reconciler's (`./commerce-reconciler`); their open state is `state`, not
 * `result`, and `isMonetizationOperationRecoverable` applies the rule for
 * every kind.
 */
export type MonetizationOperationRecord =
  | LegacyMonetizationOperationRecord
  | CommercePurchaseOperationRecord;

/** Games must supply a durable, atomic implementation; an in-memory map is not recovery. */
export interface MonetizationOperationStore {
  /** Atomically insert or return the existing operation for this global key. */
  reserve(record: MonetizationOperationRecord): Promise<{
    readonly created: boolean;
    readonly record: MonetizationOperationRecord;
  }>;
  read(key: string): Promise<MonetizationOperationRecord | undefined>;
  /** Compare-and-swap; reject stale revisions and changes to immutable identity. */
  replace(
    expectedRevision: number,
    record: MonetizationOperationRecord,
  ): Promise<void>;
  /** Return only unresolved operations; keep terminal records addressable by read for deduplication. */
  listRecoverable(playerId: string): Promise<readonly MonetizationOperationRecord[]>;
  /**
   * Reconciler records in `granted`, `finishing`, or `finished` kept within
   * the journal retention window, for the reconciler's revocation pass. A
   * store without it only reports reversals of grants seen in this session.
   */
  listGranted?(playerId: string): Promise<readonly MonetizationOperationRecord[]>;
  /**
   * The reconciler record, terminal or not, whose `purchase.transactionId`
   * is this store transaction. With it a transaction the store lists again
   * after a restart (an owned durable, a rejected or finished purchase) meets
   * its own record instead of being verified again under a derived key.
   */
  findByTransaction?(input: {
    readonly playerId: string;
    readonly target: string;
    readonly deploymentTarget: string;
    readonly store: string;
    readonly transactionId: string;
  }): Promise<MonetizationOperationRecord | undefined>;
}

export interface CreateRecoverableMonetizationClientInput extends CreateGameServicesClientInput {
  readonly operationStore: MonetizationOperationStore;
}

export interface MonetizationOperationSummary {
  readonly kind: MonetizationOperationRecord['kind'];
  readonly idempotencyKey: string;
  /**
   * RFC "Purchase lifecycle" mapping for a reconciler record: `granted`
   * covers `granted`, `finishing`, and `finished`; `pending` covers
   * `launched`, `pending`, `purchased`, and `verifying`; `revoked` is a
   * reversed grant.
   */
  readonly status: 'pending' | 'granted' | 'rejected' | 'cancelled' | 'failed'
    | 'skipped' | 'unavailable' | 'action-required' | 'revoked';
  readonly finalizationPending: boolean;
}

export interface RecoverableMonetizationClient extends GameServicesOperationClient {
  recoverRewardResult(
    idempotencyKey: string,
    platform: RewardedAdResult,
  ): Promise<GameServicesRewardedAdResult>;
  /**
   * Startup and app-resume recovery: resumes rewarded-ad records and, with a
   * commerce provider, starts or runs the reconciler (subscribe, read available
   * purchases, send saved verify requests, finish granted purchases).
   */
  reconcile(): Promise<readonly MonetizationOperationSummary[]>;
  /**
   * The manual restore trigger of the reconciler (`provider.restorePurchases`
   * when offered, then a pass). Without a commerce provider it is `reconcile()`.
   */
  restorePurchases(): Promise<readonly MonetizationOperationSummary[]>;
  /** Present when the gateway exposes `commerce`. */
  readonly commerceReconciler?: CommerceReconciler;
}

/**
 * Client-side recovery coordinates UI callbacks and authoritative backend calls.
 * It never grants a wallet locally. Journal evidence can contain receipts/tokens,
 * so the game's durable store must encrypt and access-control its records.
 */
export function createRecoverableMonetizationClient(
  input: CreateRecoverableMonetizationClientInput,
): RecoverableMonetizationClient {
  const store = input.operationStore;
  const rewardEvidenceRegistry = input.rewardEvidenceRegistry ?? createDefaultClientRewardEvidenceRegistry();
  const allowLegacyRewardCompletion = input.rewardEvidenceRegistry === undefined && input.gateway.ads.provider === undefined;
  const observedAt = (): string => input.now?.() ?? new Date().toISOString();
  const inFlight = new Map<string, Promise<unknown>>();
  const unjournaledRewards = new Map<string, {
    readonly platform: RewardedAdResult;
    readonly completedAt: string;
  }>();
  const unjournaledRewardResponses = new Map<string, ClaimAdRewardResponse>();
  const unjournaledRewardResults = new Map<string, GameServicesRewardedAdResult>();
  // One purchase client over the durable journal: its reconciler is the only
  // purchase path. A gateway without a commerce provider gets a client whose
  // `purchase` answers `rejected`; rewarded ads keep the per-operation client
  // below.
  const commerceClient: GameServicesClient = createGameServicesClient({
    ...input,
    operationStore: store,
  });
  const commerceReconciler = commerceClient.commerceReconciler;
  // The per-operation rewarded-ad clients see a gateway without the commerce
  // provider, so they never build a second reconciler over the journal.
  const {
    commerceReconciler: _sharedReconciler,
    operationStore: _journal,
    onCommerceEvent: _onCommerceEvent,
    commerceProducts: _commerceProducts,
    ...legacyClientInput
  } = input;
  const { commerce: _commerce, ...legacyGateway } = input.gateway;

  async function serializeOperation<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(key) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(task);
    inFlight.set(key, running);
    try {
      return await running;
    } finally {
      if (inFlight.get(key) === running) {
        inFlight.delete(key);
      }
    }
  }

  async function save<T extends MonetizationOperationRecord>(
    record: T,
    patch: Partial<T>,
  ): Promise<T> {
    const next = { ...record, ...patch, revision: record.revision + 1 } as T;
    await store.replace(record.revision, next);
    return next;
  }

  function assertOwner(
    record: RewardedAdOperationRecord,
    kind: 'rewarded-ad',
    idempotencyKey: string,
    subjectId: string,
  ): void {
    if (record.key !== operationKey(input.target, kind, idempotencyKey)
      || record.kind !== kind || record.playerId !== input.playerId
      || record.target !== input.target
      || record.deploymentTarget !== (input.deploymentTarget ?? input.target)
      || record.input.idempotencyKey !== idempotencyKey
      || record.input.placementId !== subjectId) {
      throw new Error('Monetization operation key is bound to another player or subject.');
    }
  }

  function purchase(
    operation: GameServicesPurchaseInput,
    options?: GameServicesOperationOptions<GameServicesPurchaseProgress>,
  ): Promise<GameServicesPurchaseResult> {
    return commerceClient.purchase(operation, options);
  }

  async function claimRewardedAd(
    operation: GameServicesRewardedAdInput,
    options?: GameServicesOperationOptions<GameServicesRewardedAdProgress>,
  ): Promise<GameServicesRewardedAdResult> {
    const key = operationKey(input.target, 'rewarded-ad', operation.idempotencyKey);
    return serializeOperation(key, async () => {
      const reserved = await store.reserve({
        key,
        kind: 'rewarded-ad',
        playerId: input.playerId,
        target: input.target,
        deploymentTarget: input.deploymentTarget ?? input.target,
        revision: 0,
        input: operation,
      });
      if (reserved.record.kind !== 'rewarded-ad') {
        throw new Error('Monetization operation kind conflicts with its journal key.');
      }
      assertOwner(reserved.record, 'rewarded-ad', operation.idempotencyKey, operation.placementId);
      return resumeReward(reserved.record, reserved.created, options);
    });
  }

  async function resumeReward(
    initial: RewardedAdOperationRecord,
    mayOpenPlatform = false,
    options?: GameServicesOperationOptions<GameServicesRewardedAdProgress>,
  ): Promise<GameServicesRewardedAdResult> {
    return observeGameServicesOperation('rewarded-ad', options, (progress) => {
      return settleReward(initial, mayOpenPlatform, progress);
    });
  }

  async function settleReward(
    initial: RewardedAdOperationRecord,
    mayOpenPlatform: boolean,
    progress: OperationReporter<'rewarded-ad'>,
  ): Promise<GameServicesRewardedAdResult> {
    let record = initial;
    const unsavedResponse = unjournaledRewardResponses.get(record.key);
    if (unsavedResponse !== undefined && record.response?.granted !== true) {
      // A result beside the non-grant claim is stale, such as another runtime's rejection.
      // Drop it in the same write so the client path derives this grant again.
      const { result: staleResult, ...current } = record;
      try {
        record = await save(current, { response: unsavedResponse });
        unjournaledRewardResponses.delete(record.key);
      } catch {
        return recordedRewardGrant({ ...current, response: unsavedResponse })
          ?? pendingReward(record.platform);
      }
    } else if (record.response?.granted === true) {
      unjournaledRewardResponses.delete(record.key);
    }
    const unsavedResult = unjournaledRewardResults.get(record.key);
    if (unsavedResult !== undefined && record.result?.status !== 'granted') {
      try {
        record = await save(record, { result: unsavedResult });
        unjournaledRewardResults.delete(record.key);
      } catch {
        return unsavedResult;
      }
    } else if (record.result?.status === 'granted') {
      unjournaledRewardResults.delete(record.key);
    }
    const unjournaled = unjournaledRewards.get(record.key);
    if (unjournaled !== undefined && (record.platform === undefined
      || record.platform.status === 'pending' && unjournaled.platform.status !== 'pending')) {
      try {
        record = await save(record, {
          platform: unjournaled.platform,
          platformCompletedAt: unjournaled.completedAt,
        });
        unjournaledRewards.delete(record.key);
      } catch {
        return pendingReward(unjournaled.platform);
      }
    } else if (record.platform !== undefined) {
      if (unjournaled !== undefined && !samePlatformResult(record.platform, unjournaled.platform)) {
        throw new Error('A platform ad callback conflicts with the recorded operation.');
      }
      unjournaledRewards.delete(record.key);
    }
    const completed = record.result;
    if (completed !== undefined && completed.status !== 'pending') {
      return completed;
    }
    if (record.request !== undefined) {
      assertRewardRequest(record, input);
    }
    if (record.platform === undefined && !mayOpenPlatform) {
      return pendingReward();
    }
    const client = createGameServicesClient({
      ...legacyClientInput,
      requestNow: () => record.platformCompletedAt ?? observedAt(),
      gateway: {
        ...legacyGateway,
        ads: {
          ...input.gateway.ads,
          async showRewarded(request) {
            if (record.platform !== undefined) {
              return record.platform;
            }
            const platform = await input.gateway.ads.showRewarded(request);
            const completedAt = observedAt();
            const prior = record;
            record = { ...record, platform, platformCompletedAt: completedAt };
            try {
              record = await save(prior, { platform, platformCompletedAt: completedAt });
            } catch (error) {
              unjournaledRewards.set(record.key, { platform, completedAt });
              throw error;
            }
            return platform;
          },
        },
      },
      backend: {
        ...input.backend,
        adRewards: {
          async claimAdReward(request) {
            if (record.request === undefined) {
              record = await save(record, { request });
            }
            const recordedRequest = record.request;
            if (recordedRequest === undefined) {
              throw new Error('Reward claim was not journaled before backend dispatch.');
            }
            let response: ClaimAdRewardResponse;
            try {
              response = await input.backend.adRewards.claimAdReward(recordedRequest);
            } catch {
              if (record.response?.granted === true) {
                return record.response;
              }
              return {
                granted: false,
                alreadyProcessed: false,
                disposition: 'pending',
                reason: 'BACKEND_UNAVAILABLE',
              };
            }
            if (record.response?.granted === true && !response.granted) {
              return record.response;
            }
            const prior = record;
            record = { ...record, response };
            try {
              record = await save(prior, { response });
              unjournaledRewardResponses.delete(record.key);
            } catch (error) {
              if (response.granted) {
                unjournaledRewardResponses.set(record.key, response);
              }
              throw error;
            }
            return response;
          },
        },
      },
    });
    try {
      const result = await client.claimRewardedAd(
        record.input,
        forwardGameServicesProgress(progress),
      );
      if (result.status === 'granted') {
        unjournaledRewardResults.set(record.key, result);
      }
      record = await save(record, { result });
      unjournaledRewardResults.delete(record.key);
      return result;
    } catch {
      return recordedRewardGrant(record)
        ?? unjournaledRewardResults.get(record.key)
        ?? pendingReward(record.platform);
    }
  }

  async function recoverRewardResult(
    idempotencyKey: string,
    platform: RewardedAdResult,
  ): Promise<GameServicesRewardedAdResult> {
    const key = operationKey(input.target, 'rewarded-ad', idempotencyKey);
    return serializeOperation(key, async () => {
      const found = await store.read(key);
      if (found?.kind !== 'rewarded-ad') {
        throw new Error('No reserved rewarded-ad operation matches this platform callback.');
      }
      assertOwner(found, 'rewarded-ad', idempotencyKey, found.input.placementId);
      const transient = unjournaledRewards.get(key);
      if (transient !== undefined && !samePlatformResult(transient.platform, platform)
        && !canAdvanceReward(transient.platform, platform, false)) {
        throw new Error('A platform ad callback conflicts with the unjournaled result.');
      }
      const canAdvance = found.platform !== undefined
        && !samePlatformResult(found.platform, platform)
        && canAdvanceReward(found.platform, platform, found.request !== undefined);
      if (found.platform !== undefined && !samePlatformResult(found.platform, platform)
        && !canAdvance) {
        throw new Error('A platform ad callback conflicts with the recorded operation.');
      }
      let record = found;
      if (found.platform === undefined || canAdvance) {
        const completedAt = found.platformCompletedAt ?? observedAt();
        try {
          record = await save(found, { platform, platformCompletedAt: completedAt });
        } catch {
          unjournaledRewards.set(key, { platform, completedAt });
          return pendingReward(platform);
        }
      }
      unjournaledRewards.delete(key);
      return resumeReward(record);
    });
  }

  function canAdvanceReward(previous: RewardedAdResult, next: RewardedAdResult, hasRequest: boolean): boolean {
    if (previous.status !== 'pending') {
      return false;
    }
    const legacyUpgrade = !hasRequest && allowLegacyRewardCompletion
      && previous.rewardGranted === false && next.rewardGranted === true && next.status === 'completed';
    // Once a candidate is recorded, its correlation cannot be replaced even
    // when dispatch has not yet reached the server or its journal write failed.
    if (previous.evidence !== undefined && (!sameRewardEvidence(previous.evidence, next.evidence)
      || !legacyUpgrade && (previous.rewardGranted !== next.rewardGranted || previous.ledgerEntryId !== next.ledgerEntryId))) {
      return false;
    }
    if (previous.ledgerEntryId !== undefined && previous.ledgerEntryId !== next.ledgerEntryId) {
      return false;
    }
    const candidate = resolveClientRewardClaim(next, rewardEvidenceRegistry, {
      allowLegacyCompletion: allowLegacyRewardCompletion,
    });
    if (candidate === undefined) {
      return !hasRequest && previous.evidence === undefined && next.evidence === undefined
        && (next.status === 'skipped' || next.status === 'unavailable' || next.status === 'failed');
    }
    const prior = resolveClientRewardClaim(previous, rewardEvidenceRegistry, {
      allowLegacyCompletion: allowLegacyRewardCompletion,
    });
    if (prior !== undefined && (prior.platformImpressionId !== candidate.platformImpressionId
      || !sameRewardEvidence(prior.evidence, candidate.evidence))) {
      return false;
    }
    return !hasRequest || prior !== undefined;
  }

  function ownsRecord(record: MonetizationOperationRecord | undefined): boolean {
    return record?.playerId === input.playerId && record.target === input.target
      && record.deploymentTarget === (input.deploymentTarget ?? input.target);
  }

  function summarizeCommerceRecord(
    record: CommercePurchaseOperationRecord,
  ): MonetizationOperationSummary {
    return {
      kind: record.kind,
      idempotencyKey: record.idempotencyKey,
      status: summarizeCommercePurchaseOperation(record),
      finalizationPending: record.state === 'finishing',
    };
  }

  /** Runs the v2 trigger and reports every record it found open before the pass, at its state after it. */
  async function reconcileCommerce(
    run: (reconciler: CommerceReconciler) => Promise<void>,
  ): Promise<readonly MonetizationOperationSummary[]> {
    if (commerceReconciler === undefined) {
      return [];
    }
    const openBefore = (await commerceReconciler.listRecoverable()).map(
      (record) => record.idempotencyKey,
    );
    await run(commerceReconciler);
    const seen = new Set<string>();
    const summaries: MonetizationOperationSummary[] = [];
    for (const key of [
      ...openBefore,
      ...(await commerceReconciler.listRecoverable()).map((record) => record.idempotencyKey),
    ]) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const latest = await commerceReconciler.read(key);
      if (latest !== undefined) {
        summaries.push(summarizeCommerceRecord(latest));
      }
    }
    return summaries;
  }

  async function restorePurchases(): Promise<readonly MonetizationOperationSummary[]> {
    if (commerceReconciler === undefined) {
      return reconcile();
    }
    return [
      ...(await reconcileLegacy()),
      ...(await reconcileCommerce((reconciler) => reconciler.restorePurchases())),
    ];
  }

  async function reconcile(): Promise<readonly MonetizationOperationSummary[]> {
    return [
      ...(await reconcileLegacy()),
      ...(await reconcileCommerce(async (reconciler) => {
        if (reconciler.started) {
          await reconciler.reconcile();
        } else {
          await reconciler.start();
        }
      })),
    ];
  }

  /**
   * Finishes the backend verification a retired v1 purchase record was in the
   * middle of. The grant is the backend's answer, never a local decision, and
   * the store UI is never reopened. Backend or journal trouble leaves the
   * record open for the next pass.
   */
  async function drainRetiredPurchase(
    initial: RetiredPurchaseOperationRecord,
  ): Promise<MonetizationOperationSummary | undefined> {
    const summarize = (
      latest: RetiredPurchaseOperationRecord,
      status: MonetizationOperationSummary['status'],
    ): MonetizationOperationSummary => ({
      kind: 'purchase',
      idempotencyKey: latest.input.idempotencyKey,
      status,
      finalizationPending: false,
    });
    try {
      return await serializeOperation(initial.key, async () => {
        const latest = await store.read(initial.key) ?? initial;
        if (latest.kind !== 'purchase' || !isRetiredPurchaseOpen(latest)) {
          return undefined;
        }
        if (latest.key !== operationKey(input.target, 'purchase', latest.input.idempotencyKey)
          || !ownsRecord(latest)) {
          return summarize(latest, 'action-required');
        }
        const platform = latest.platform;
        if (platform?.status !== 'completed' || platform.transactionId === undefined) {
          return undefined;
        }
        const request: VerifyPurchaseRequest = latest.request ?? {
          target: latest.target,
          ...(latest.deploymentTarget === latest.target
            ? {}
            : { deploymentTarget: latest.deploymentTarget }),
          playerId: latest.playerId,
          productId: latest.input.productId,
          platformTransactionId: platform.transactionId,
          idempotencyKey: latest.input.idempotencyKey,
          purchasedAt: latest.platformCompletedAt ?? observedAt(),
          ...(platform.evidence === undefined ? {} : { evidence: platform.evidence }),
        };
        if (request.playerId !== input.playerId
          || request.target !== latest.target
          || request.productId !== latest.input.productId
          || request.idempotencyKey !== latest.input.idempotencyKey
          || request.platformTransactionId !== platform.transactionId) {
          return summarize(latest, 'action-required');
        }
        let response = latest.response;
        if (response?.verified !== true) {
          try {
            response = await input.backend.purchases.verifyPurchase(request);
          } catch {
            // Transport trouble stays retryable; nothing is decided here.
            return summarize(latest, 'pending');
          }
        }
        const result: GameServicesPurchaseResult = response.verified
          ? {
              status: 'granted',
              purchase: platform,
              verification: response,
              ...(response.ledgerEntryId === undefined
                ? {}
                : { ledgerEntryId: response.ledgerEntryId }),
            }
          : {
              status: response.disposition === 'pending' ? 'pending' : 'rejected',
              purchase: platform,
              verification: response,
            };
        try {
          await save(latest, { request, response, result });
        } catch {
          return summarize(latest, result.status === 'granted' ? 'granted' : 'pending');
        }
        return summarize(latest, result.status === 'granted' ? 'granted' : result.status);
      });
    } catch {
      return summarize(initial, 'pending');
    }
  }

  async function reconcileLegacy(): Promise<readonly MonetizationOperationSummary[]> {
    const pending = await store.listRecoverable(input.playerId);
    const summaries: MonetizationOperationSummary[] = [];
    for (const record of pending) {
      if (!ownsRecord(record)) {
        continue;
      }
      if (record.kind === 'purchase') {
        const summary = await drainRetiredPurchase(record);
        if (summary !== undefined) {
          summaries.push(summary);
        }
        continue;
      }
      if (record.kind !== 'rewarded-ad') {
        continue;
      }
      const idempotencyKey = typeof record.input?.idempotencyKey === 'string'
        ? record.input.idempotencyKey
        : 'unreadable-operation';
      if (inFlight.has(record.key)) {
        continue;
      }
      try {
        const summary = await serializeOperation(record.key, async () => {
          let latest: MonetizationOperationRecord;
          try {
            latest = await store.read(record.key) ?? record;
          } catch {
            throw new OperationReadError();
          }
          if (latest.kind !== 'rewarded-ad') {
            throw new Error('Monetization operation kind conflicts with its journal key.');
          }
          assertOwner(latest, latest.kind, latest.input.idempotencyKey, latest.input.placementId);
          const result = await resumeReward(latest);
          return {
            kind: latest.kind,
            idempotencyKey: latest.input.idempotencyKey,
            status: result.status,
            finalizationPending: false,
          } satisfies MonetizationOperationSummary;
        });
        summaries.push(summary);
      } catch (error) {
        summaries.push({
          kind: record.kind,
          idempotencyKey,
          status: error instanceof OperationReadError ? 'pending' : 'action-required',
          finalizationPending: false,
        });
      }
    }
    return summaries;
  }

  return {
    purchase,
    claimRewardedAd,
    recoverRewardResult,
    reconcile,
    restorePurchases,
    ...(commerceReconciler === undefined ? {} : { commerceReconciler }),
  };
}

class OperationReadError extends Error {}

function operationKey(target: string, kind: string, idempotencyKey: string): string {
  if (idempotencyKey.trim() === '') {
    throw new Error('Monetization operations require a nonempty idempotency key.');
  }
  return JSON.stringify([target, kind, idempotencyKey]);
}

function samePlatformResult(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function pendingReward(platform?: RewardedAdResult): GameServicesRewardedAdResult {
  return {
    status: 'pending',
    reward: platform ?? { status: 'pending', rewardGranted: false },
  };
}

function recordedRewardGrant(
  record: RewardedAdOperationRecord,
): GameServicesRewardedAdResult | undefined {
  if (record.result?.status === 'granted') {
    return record.result;
  }
  if (record.response?.granted !== true || record.platform === undefined) {
    return undefined;
  }
  return {
    status: 'granted',
    reward: record.platform,
    claim: record.response,
    ...(record.response.ledgerEntryId === undefined
      ? {} : { ledgerEntryId: record.response.ledgerEntryId }),
  };
}

function assertRewardRequest(
  record: RewardedAdOperationRecord,
  input: CreateRecoverableMonetizationClientInput,
): void {
  const request = record.request;
  const candidate = record.platform === undefined ? undefined : resolveClientRewardClaim(
    record.platform,
    input.rewardEvidenceRegistry ?? createDefaultClientRewardEvidenceRegistry(),
    { allowLegacyCompletion: input.rewardEvidenceRegistry === undefined && input.gateway.ads.provider === undefined },
  );
  if (request === undefined || record.platform === undefined
    || candidate === undefined
    || request.playerId !== record.playerId || request.playerId !== input.playerId
    || request.target !== record.target || request.placementId !== record.input.placementId
    || request.idempotencyKey !== record.input.idempotencyKey
    || request.platformImpressionId !== candidate.platformImpressionId
    || request.providerId !== undefined && request.providerId !== input.gateway.ads.provider?.id
    || !sameRewardEvidence(request.evidence, candidate.evidence)
    || request.deploymentTarget !== (input.deploymentTarget === input.target
      ? undefined : input.deploymentTarget)) {
    throw new Error('Journaled ad claim is not bound to its platform result.');
  }
}

function sameRewardEvidence(
  request: PlatformEvidenceEnvelope | undefined,
  candidate: PlatformEvidenceEnvelope | undefined,
): boolean {
  if (request === undefined || candidate === undefined) {
    return request === candidate;
  }
  return request.schema === candidate.schema
    && Object.keys(request.payload).length === Object.keys(candidate.payload).length
    && Object.entries(request.payload).every(([key, value]) =>
      Object.hasOwn(candidate.payload, key) && candidate.payload[key] === value);
}

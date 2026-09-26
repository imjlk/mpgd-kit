import type { PurchaseResult, RewardedAdResult } from '@mpgd/platform';

import { createGameServicesClient, type CreateGameServicesClientInput } from './client.js';
import type {
  GameServicesOperationClient,
  GameServicesPurchaseInput,
  GameServicesPurchaseResult,
  GameServicesRewardedAdInput,
  GameServicesRewardedAdResult,
} from './operations.js';
import {
  observeGameServicesOperation,
  type GameServicesOperationOptions,
  type GameServicesPurchaseProgress,
  type GameServicesRewardedAdProgress,
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
  readonly revision: number;
  /** Fixed when a platform result is first journaled, before backend dispatch. */
  readonly platformCompletedAt?: string;
}

export type MonetizationOperationRecord =
  | (OperationIdentity & {
      readonly kind: 'purchase';
      readonly input: GameServicesPurchaseInput;
      readonly platform?: PurchaseResult;
      readonly request?: VerifyPurchaseRequest;
      readonly response?: VerifyPurchaseResponse;
      readonly result?: GameServicesPurchaseResult;
    })
  | (OperationIdentity & {
      readonly kind: 'rewarded-ad';
      readonly input: GameServicesRewardedAdInput;
      readonly platform?: RewardedAdResult;
      readonly request?: ClaimAdRewardRequest;
      readonly response?: ClaimAdRewardResponse;
      readonly result?: GameServicesRewardedAdResult;
    });

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
}

export interface CreateRecoverableMonetizationClientInput extends CreateGameServicesClientInput {
  readonly operationStore: MonetizationOperationStore;
}

export interface MonetizationOperationSummary {
  readonly kind: MonetizationOperationRecord['kind'];
  readonly idempotencyKey: string;
  readonly status: 'pending' | 'granted' | 'rejected' | 'cancelled' | 'failed'
    | 'skipped' | 'unavailable' | 'action-required';
  readonly finalizationPending: boolean;
}

export interface RecoverableMonetizationClient extends GameServicesOperationClient {
  recoverPurchaseResult(
    idempotencyKey: string,
    platform: PurchaseResult,
  ): Promise<GameServicesPurchaseResult>;
  recoverRewardResult(
    idempotencyKey: string,
    platform: RewardedAdResult,
  ): Promise<GameServicesRewardedAdResult>;
  reconcile(): Promise<readonly MonetizationOperationSummary[]>;
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
  const observedAt = (): string => input.now?.() ?? new Date().toISOString();
  const inFlight = new Map<string, Promise<unknown>>();

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
    record: MonetizationOperationRecord,
    kind: MonetizationOperationRecord['kind'],
    idempotencyKey: string,
    subjectId: string,
  ): void {
    if (record.key !== operationKey(input.target, kind, idempotencyKey)
      || record.kind !== kind || record.playerId !== input.playerId
      || record.target !== input.target || record.input.idempotencyKey !== idempotencyKey
      || (record.kind === 'purchase' ? record.input.productId : record.input.placementId)
        !== subjectId) {
      throw new Error('Monetization operation key is bound to another player or subject.');
    }
  }

  async function purchase(
    operation: GameServicesPurchaseInput,
    options?: GameServicesOperationOptions<GameServicesPurchaseProgress>,
  ): Promise<GameServicesPurchaseResult> {
    const key = operationKey(input.target, 'purchase', operation.idempotencyKey);
    return serializeOperation(key, async () => {
      const reserved = await store.reserve({
        key,
        kind: 'purchase',
        playerId: input.playerId,
        target: input.target,
        revision: 0,
        input: operation,
      });
      if (reserved.record.kind !== 'purchase') {
        throw new Error('Monetization operation kind conflicts with its journal key.');
      }
      assertOwner(reserved.record, 'purchase', operation.idempotencyKey, operation.productId);
      if (reserved.record.input.source !== operation.source) {
        throw new Error('Purchase idempotency key was reused for another source.');
      }
      return resumePurchase(reserved.record, reserved.created, options);
    });
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

  async function resumePurchase(
    initial: Extract<MonetizationOperationRecord, { kind: 'purchase' }>,
    mayOpenPlatform = false,
    options?: GameServicesOperationOptions<GameServicesPurchaseProgress>,
  ): Promise<GameServicesPurchaseResult> {
    let record = initial;
    const completed = record.result;
    if (completed !== undefined && !purchaseNeedsRetry(record)) {
      return observeGameServicesOperation('purchase', options, async () => completed);
    }
    if (record.request !== undefined) {
      assertPurchaseRequest(record, input);
    }
    if (record.platform === undefined && !mayOpenPlatform) {
      return observeGameServicesOperation('purchase', options, async () => pendingPurchase());
    }
    const client = createGameServicesClient({
      ...input,
      requestNow: () => record.platformCompletedAt ?? observedAt(),
      gateway: {
        ...input.gateway,
        commerce: {
          ...input.gateway.commerce,
          async purchase(request) {
            if (record.platform !== undefined) {
              return record.platform;
            }
            const platform = await input.gateway.commerce.purchase(request);
            record = await save(record, { platform, platformCompletedAt: observedAt() });
            return platform;
          },
        },
      },
      backend: {
        ...input.backend,
        purchases: {
          async verifyPurchase(request) {
            if (record.request === undefined) {
              record = await save(record, { request });
            }
            const recordedRequest = record.request;
            if (recordedRequest === undefined) {
              throw new Error('Purchase request was not journaled before backend dispatch.');
            }
            let response: VerifyPurchaseResponse;
            try {
              response = await input.backend.purchases.verifyPurchase(recordedRequest);
            } catch {
              if (record.response?.verified === true) {
                return record.response;
              }
              return {
                verified: false,
                alreadyProcessed: false,
                disposition: 'pending',
                reason: 'BACKEND_UNAVAILABLE',
              };
            }
            if (record.response?.verified === true && !response.verified) {
              return record.response;
            }
            record = await save(record, { response });
            return response;
          },
        },
      },
    });
    try {
      const result = await client.purchase(record.input, options);
      record = await save(record, { result });
      return result;
    } catch {
      // No UI retry is safe after a possibly completed platform callback.
      return recordedPurchaseGrant(record) ?? pendingPurchase(record.platform);
    }
  }

  async function resumeReward(
    initial: Extract<MonetizationOperationRecord, { kind: 'rewarded-ad' }>,
    mayOpenPlatform = false,
    options?: GameServicesOperationOptions<GameServicesRewardedAdProgress>,
  ): Promise<GameServicesRewardedAdResult> {
    let record = initial;
    const completed = record.result;
    if (completed !== undefined && completed.status !== 'pending') {
      return observeGameServicesOperation('rewarded-ad', options, async () => completed);
    }
    if (record.request !== undefined) {
      assertRewardRequest(record, input);
    }
    if (record.platform === undefined && !mayOpenPlatform) {
      return observeGameServicesOperation('rewarded-ad', options, async () => pendingReward());
    }
    const client = createGameServicesClient({
      ...input,
      requestNow: () => record.platformCompletedAt ?? observedAt(),
      gateway: {
        ...input.gateway,
        ads: {
          ...input.gateway.ads,
          async showRewarded(request) {
            if (record.platform !== undefined) {
              return record.platform;
            }
            const platform = await input.gateway.ads.showRewarded(request);
            record = await save(record, { platform, platformCompletedAt: observedAt() });
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
            record = await save(record, { response });
            return response;
          },
        },
      },
    });
    try {
      const result = await client.claimRewardedAd(record.input, options);
      record = await save(record, { result });
      return result;
    } catch {
      return recordedRewardGrant(record) ?? pendingReward(record.platform);
    }
  }

  async function recoverPurchaseResult(
    idempotencyKey: string,
    platform: PurchaseResult,
  ): Promise<GameServicesPurchaseResult> {
    const key = operationKey(input.target, 'purchase', idempotencyKey);
    return serializeOperation(key, async () => {
      const found = await store.read(key);
      if (found?.kind !== 'purchase') {
        throw new Error('No reserved purchase operation matches this platform callback.');
      }
      assertOwner(found, 'purchase', idempotencyKey, found.input.productId);
      const canAdvance = found.platform?.status === 'pending'
        && platform.status !== 'pending' && found.request === undefined;
      if (found.platform !== undefined && !samePlatformResult(found.platform, platform)
        && !canAdvance) {
        throw new Error('A platform purchase callback conflicts with the recorded operation.');
      }
      let record = found;
      if (found.platform === undefined || canAdvance) {
        record = await save(found, { platform, platformCompletedAt: observedAt() });
      }
      return resumePurchase(record);
    });
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
      const canAdvance = found.platform?.status === 'pending'
        && platform.status !== 'pending' && found.request === undefined;
      if (found.platform !== undefined && !samePlatformResult(found.platform, platform)
        && !canAdvance) {
        throw new Error('A platform ad callback conflicts with the recorded operation.');
      }
      let record = found;
      if (found.platform === undefined || canAdvance) {
        record = await save(found, { platform, platformCompletedAt: observedAt() });
      }
      return resumeReward(record);
    });
  }

  async function reconcile(): Promise<readonly MonetizationOperationSummary[]> {
    const pending = await store.listRecoverable(input.playerId);
    const summaries: MonetizationOperationSummary[] = [];
    for (const record of pending) {
      if (record?.playerId !== input.playerId || record.target !== input.target) {
        continue;
      }
      if (record.kind !== 'purchase' && record.kind !== 'rewarded-ad') {
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
          const latest = await store.read(record.key) ?? record;
          assertOwner(
            latest,
            latest.kind,
            latest.input.idempotencyKey,
            latest.kind === 'purchase' ? latest.input.productId : latest.input.placementId,
          );
          if (latest.kind === 'purchase') {
            const result = await resumePurchase(latest);
            return {
              kind: latest.kind,
              idempotencyKey: latest.input.idempotencyKey,
              status: result.status,
              finalizationPending: result.verification?.finalization?.status === 'pending',
            } satisfies MonetizationOperationSummary;
          }
          const result = await resumeReward(latest);
          return {
            kind: latest.kind,
            idempotencyKey: latest.input.idempotencyKey,
            status: result.status,
            finalizationPending: false,
          } satisfies MonetizationOperationSummary;
        });
        summaries.push(summary);
      } catch {
        summaries.push({
          kind: record.kind,
          idempotencyKey,
          status: 'action-required',
          finalizationPending: false,
        });
      }
    }
    return summaries;
  }

  return { purchase, claimRewardedAd, recoverPurchaseResult, recoverRewardResult, reconcile };
}

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

function pendingPurchase(platform?: PurchaseResult): GameServicesPurchaseResult {
  return {
    status: 'pending',
    purchase: platform ?? { status: 'pending', entitlementIds: [] },
  };
}

function pendingReward(platform?: RewardedAdResult): GameServicesRewardedAdResult {
  return {
    status: 'pending',
    reward: platform ?? { status: 'pending', rewardGranted: false },
  };
}

function recordedPurchaseGrant(
  record: Extract<MonetizationOperationRecord, { kind: 'purchase' }>,
): GameServicesPurchaseResult | undefined {
  if (record.result?.status === 'granted') {
    return record.result;
  }
  if (record.response?.verified !== true || record.platform === undefined) {
    return undefined;
  }
  return {
    status: 'granted',
    purchase: record.platform,
    verification: record.response,
    ...(record.response.ledgerEntryId === undefined
      ? {} : { ledgerEntryId: record.response.ledgerEntryId }),
  };
}

function recordedRewardGrant(
  record: Extract<MonetizationOperationRecord, { kind: 'rewarded-ad' }>,
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

function purchaseNeedsRetry(
  record: Extract<MonetizationOperationRecord, { kind: 'purchase' }>,
): boolean {
  return record.result?.status === 'pending'
    || record.response?.finalization?.status === 'pending';
}

function assertPurchaseRequest(
  record: Extract<MonetizationOperationRecord, { kind: 'purchase' }>,
  input: CreateRecoverableMonetizationClientInput,
): void {
  const request = record.request;
  if (request === undefined || record.platform?.status !== 'completed'
    || request.playerId !== record.playerId || request.playerId !== input.playerId
    || request.target !== record.target || request.productId !== record.input.productId
    || request.idempotencyKey !== record.input.idempotencyKey
    || request.platformTransactionId !== record.platform.transactionId
    || request.deploymentTarget !== (input.deploymentTarget === input.target
      ? undefined : input.deploymentTarget)) {
    throw new Error('Journaled purchase verification is not bound to its platform result.');
  }
}

function assertRewardRequest(
  record: Extract<MonetizationOperationRecord, { kind: 'rewarded-ad' }>,
  input: CreateRecoverableMonetizationClientInput,
): void {
  const request = record.request;
  if (request === undefined || record.platform?.status !== 'completed'
    || !record.platform.rewardGranted
    || request.playerId !== record.playerId || request.playerId !== input.playerId
    || request.target !== record.target || request.placementId !== record.input.placementId
    || request.idempotencyKey !== record.input.idempotencyKey
    || request.platformImpressionId !== record.platform.ledgerEntryId
    || request.deploymentTarget !== (input.deploymentTarget === input.target
      ? undefined : input.deploymentTarget)) {
    throw new Error('Journaled ad claim is not bound to its platform result.');
  }
}

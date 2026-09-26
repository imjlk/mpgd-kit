import type { PlatformGateway, PurchaseResult } from '@mpgd/platform';
import type { AnalyticsEvent } from '@mpgd/analytics';

import type { GameServicesBackendApi } from './client.js';
import type { GameServicesPurchaseProgress } from './operation-progress.js';
import {
  createRecoverableMonetizationClient,
  type MonetizationOperationRecord,
  type MonetizationOperationStore,
} from './monetization-recovery.js';

const assert = {
  equal(actual: unknown, expected: unknown, message = 'Values differ'): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
    }
  },
  async rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
      await promise;
    } catch (error) {
      if (pattern.test(String(error))) {
        return;
      }
      throw error;
    }
    throw new Error('Expected operation to reject.');
  },
};

function createStore(): MonetizationOperationStore {
  const records = new Map<string, MonetizationOperationRecord>();
  return {
    async reserve(record) {
      const existing = records.get(record.key);
      if (existing !== undefined) {
        return { created: false, record: structuredClone(existing) };
      }
      records.set(record.key, structuredClone(record));
      return { created: true, record: structuredClone(record) };
    },
    async read(key) {
      const record = records.get(key);
      return record === undefined ? undefined : structuredClone(record);
    },
    async replace(expectedRevision, record) {
      const existing = records.get(record.key);
      if (existing === undefined || existing.revision !== expectedRevision
        || record.revision !== expectedRevision + 1
        || existing.playerId !== record.playerId || existing.target !== record.target
        || existing.kind !== record.kind) {
        throw new Error('stale or conflicting monetization journal write');
      }
      records.set(record.key, structuredClone(record));
    },
    async listRecoverable(playerId) {
      return [...records.values()]
        .filter((record) => record.playerId === playerId
          && (record.result === undefined || record.result.status === 'pending'
            || record.kind === 'purchase'
              && record.response?.finalization?.status === 'pending'))
        .map((record) => structuredClone(record));
    },
  };
}

let purchaseUiCalls = 0;
let rewardUiCalls = 0;
let purchaseGrants = 0;
let rewardGrants = 0;
let losePurchaseResponse = true;
let ssvAvailable = false;
let finalizationComplete = false;
const purchaseKeys = new Set<string>();
const rewardKeys = new Set<string>();
const purchaseRequestTimes: string[] = [];
const analyticsEvents: AnalyticsEvent[] = [];
let currentTime = '2026-09-26T00:00:00.000Z';
const gateway: PlatformGateway = {
  target: 'android',
  async getCapabilities() {
    return {
      nativeIap: true,
      nativeAds: true,
      rewardedAds: true,
      interstitialAds: true,
      nativeLeaderboard: false,
      remoteLeaderboard: false,
      achievements: false,
      cloudSave: false,
      socialShare: false,
      haptics: false,
      localizedContent: true,
    };
  },
  identity: {
    async getPlayer() {
      return { playerId: 'player-1' };
    },
  },
  commerce: {
    async getProducts() {
      return [];
    },
    async purchase(operation) {
      purchaseUiCalls += 1;
      if (operation.idempotencyKey === 'sdk-crash') {
        throw new Error('SDK callback was lost after checkout');
      }
      return {
        status: 'completed',
        transactionId: `transaction-${operation.idempotencyKey}`,
        entitlementIds: [],
        evidence: { schema: 'test.purchase.v1', payload: { token: 'provider-token' } },
      };
    },
    async getEntitlements() {
      return [];
    },
  },
  ads: {
    async preload() {},
    async showRewarded(operation) {
      rewardUiCalls += 1;
      if (operation.idempotencyKey === 'reward-sdk-crash') {
        throw new Error('SDK ad callback was lost');
      }
      return {
        status: 'completed',
        rewardGranted: true,
        ledgerEntryId: `impression-${operation.idempotencyKey}`,
        evidence: { schema: 'test.reward.v1', payload: { nonce: 'reward-nonce' } },
      };
    },
  },
  leaderboard: {
    async submitScore() {
      return { submitted: false };
    },
    async open() {},
  },
  lifecycle: {
    onPause() {
      return () => {};
    },
    onResume() {
      return () => {};
    },
  },
  storage: {
    async load() {
      return null;
    },
    async save() {},
  },
};
const backend: GameServicesBackendApi = {
  purchases: {
    async verifyPurchase(request) {
      if (request.idempotencyKey === 'response-lost') {
        purchaseRequestTimes.push(request.purchasedAt);
      }
      if (!purchaseKeys.has(request.idempotencyKey)) {
        purchaseKeys.add(request.idempotencyKey);
        purchaseGrants += 1;
      }
      if (request.idempotencyKey === 'response-lost' && losePurchaseResponse) {
        losePurchaseResponse = false;
        throw new Error('response disappeared after the ledger grant');
      }
      return {
        verified: true,
        alreadyProcessed: purchaseKeys.has(request.idempotencyKey),
        ledgerEntryId: `purchase-${request.idempotencyKey}`,
        ...(request.idempotencyKey === 'finish-later' ? {
          finalization: finalizationComplete
            ? { status: 'completed' as const, action: 'consume' as const, alreadyCompleted: false }
            : { status: 'pending' as const, alreadyCompleted: false, reason: 'PROVIDER_UNAVAILABLE' },
        } : {}),
      };
    },
  },
  adRewards: {
    async claimAdReward(request) {
      if (!ssvAvailable) {
        return {
          granted: false,
          alreadyProcessed: false,
          disposition: 'pending',
          reason: 'SSV_DELAYED',
        };
      }
      if (!rewardKeys.has(request.idempotencyKey)) {
        rewardKeys.add(request.idempotencyKey);
        rewardGrants += 1;
      }
      return {
        granted: true,
        alreadyProcessed: rewardKeys.has(request.idempotencyKey),
        ledgerEntryId: `reward-${request.idempotencyKey}`,
      };
    },
  },
  leaderboard: {
    async recordScore() {
      return { submitted: false, alreadyProcessed: false, ledgerEntryId: '', rank: 0 };
    },
  },
};
const operationStore = createStore();
const analytics = {
  track(event: AnalyticsEvent): void {
    analyticsEvents.push(event);
  },
};
const makeClient = (playerId: string) => createRecoverableMonetizationClient({
  gateway,
  backend,
  playerId,
  target: 'android',
  operationStore,
  now: () => currentTime,
  analytics,
});
const client = makeClient('player-1');
const purchaseOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'response-lost',
};
assert.equal((await client.purchase(purchaseOperation)).status, 'pending');
assert.equal(purchaseGrants, 1, 'the backend already granted before the response was lost');
assert.equal(purchaseUiCalls, 1);
currentTime = '2026-09-27T00:00:00.000Z';
const restarted = makeClient('player-1');
const recoveryProgress: string[] = [];
const onRecoveryProgress = (progress: GameServicesPurchaseProgress): void => {
  recoveryProgress.push(progress.phase);
};
const recoveredPurchase = await restarted.purchase(purchaseOperation, {
  onProgress: onRecoveryProgress,
});
assert.equal(recoveredPurchase.status, 'granted');
assert.equal(recoveredPurchase.ledgerEntryId, 'purchase-response-lost');
assert.equal(purchaseUiCalls, 1, 'backend retries must not reopen checkout');
assert.equal(purchaseGrants, 1, 'the same purchase must not be granted twice');
assert.equal(purchaseRequestTimes.join(','), '2026-09-26T00:00:00.000Z,2026-09-26T00:00:00.000Z');
assert.equal(recoveryProgress.includes('completed'), true);
assert.equal(analyticsEvents.at(-1)?.name, 'purchase_granted');
assert.equal(analyticsEvents.at(-1)?.occurredAt, currentTime);
await assert.rejects(makeClient('player-2').purchase(purchaseOperation), /another player/u);

const rewardOperation = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'ssv-delayed' };
assert.equal((await client.claimRewardedAd(rewardOperation)).status, 'pending');
assert.equal(rewardUiCalls, 1);
assert.equal(rewardGrants, 0, 'SDK completion cannot grant before server SSV');
ssvAvailable = true;
await restarted.reconcile();
assert.equal((await restarted.claimRewardedAd(rewardOperation)).status, 'granted');
assert.equal(rewardUiCalls, 1, 'SSV delay must not reopen the ad');
assert.equal(rewardGrants, 1, 'duplicate callbacks must not create another grant');

const sdkCrash = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'sdk-crash',
};
assert.equal((await client.purchase(sdkCrash)).status, 'pending');
assert.equal((await restarted.purchase(sdkCrash)).status, 'pending');
assert.equal(purchaseUiCalls, 2, 'an unknown SDK completion must not reopen checkout');
const recoveredPlatform: PurchaseResult = {
  status: 'completed',
  transactionId: 'transaction-sdk-crash',
  entitlementIds: [],
  evidence: { schema: 'test.purchase.v1', payload: { token: 'recovered-token' } },
};
const recoveredCallback = await restarted.recoverPurchaseResult('sdk-crash', recoveredPlatform);
assert.equal(recoveredCallback.status, 'granted');
assert.equal((await restarted.recoverPurchaseResult('sdk-crash', {
  entitlementIds: [],
  evidence: { payload: { token: 'recovered-token' }, schema: 'test.purchase.v1' },
  transactionId: 'transaction-sdk-crash',
  status: 'completed',
})).status, 'granted');
assert.equal(purchaseUiCalls, 2);
await assert.rejects(
  restarted.recoverPurchaseResult('sdk-crash', {
    status: 'completed',
    transactionId: 'other-transaction',
    entitlementIds: [],
  }),
  /conflicts/u,
);

const finishLater = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'finish-later',
};
const pendingFinish = await client.purchase(finishLater);
assert.equal(pendingFinish.status, 'granted');
assert.equal(pendingFinish.verification?.finalization?.status, 'pending');
finalizationComplete = true;
await restarted.reconcile();
const finished = await restarted.purchase(finishLater);
assert.equal(finished.verification?.finalization?.status, 'completed');
assert.equal(purchaseUiCalls, 3, 'finalization retries must not reopen checkout');
assert.equal(purchaseGrants, 3, 'finalization must not regrant an entitlement');

ssvAvailable = false;
const lostAd = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'reward-sdk-crash' };
const lostAdResult = await client.claimRewardedAd(lostAd);
assert.equal(lostAdResult.status, 'pending');
assert.equal(lostAdResult.reward.status, 'pending');
assert.equal((await restarted.claimRewardedAd(lostAd)).status, 'pending');
assert.equal(rewardUiCalls, 2);
ssvAvailable = true;
assert.equal((await restarted.recoverRewardResult('reward-sdk-crash', {
  status: 'completed', rewardGranted: true, ledgerEntryId: 'impression-reward-sdk-crash',
  evidence: { schema: 'test.reward.v1', payload: { nonce: 'recovered-reward' } },
})).status, 'granted');
assert.equal(rewardGrants, 2);

const rejectedClient = createRecoverableMonetizationClient({
  gateway,
  backend: {
    ...backend,
    purchases: {
      async verifyPurchase() {
        return {
          verified: false,
          alreadyProcessed: false,
          disposition: 'rejected',
          reason: 'STORE_REJECTED',
        };
      },
    },
  },
  playerId: 'player-1',
  target: 'android',
  operationStore,
});
const rejectedOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'permanent-rejection',
};
assert.equal((await rejectedClient.purchase(rejectedOperation)).status, 'rejected');
const beforeRepeatedRejection = purchaseUiCalls;
assert.equal((await rejectedClient.purchase(rejectedOperation)).status, 'rejected');
assert.equal(purchaseUiCalls, beforeRepeatedRejection);

let failRequestWrite = true;
const failingStore: MonetizationOperationStore = {
  ...operationStore,
  async replace(expectedRevision, record) {
    if (failRequestWrite && record.kind === 'purchase' && record.request !== undefined) {
      failRequestWrite = false;
      throw new Error('journal write failed before backend dispatch');
    }
    await operationStore.replace(expectedRevision, record);
  },
};
const interrupted = createRecoverableMonetizationClient({
  gateway,
  backend,
  playerId: 'player-1',
  target: 'android',
  operationStore: failingStore,
});
const journalFailure = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'journal-failed-before-dispatch',
};
const grantsBeforeJournalFailure = purchaseGrants;
assert.equal((await interrupted.purchase(journalFailure)).status, 'pending');
assert.equal(purchaseGrants, grantsBeforeJournalFailure);
const uiAfterJournalFailure = purchaseUiCalls;
assert.equal((await restarted.purchase(journalFailure)).status, 'granted');
assert.equal(purchaseUiCalls, uiAfterJournalFailure);
assert.equal(purchaseGrants, grantsBeforeJournalFailure + 1);

ssvAvailable = false;
const stillPending = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'still-pending' };
assert.equal((await client.claimRewardedAd(stillPending)).status, 'pending');
const summary = await restarted.reconcile();
assert.equal(
  summary.some((entry) => entry.idempotencyKey === 'still-pending'),
  true,
);
assert.equal(Object.keys(summary[0] ?? {}).includes('platform'), false);

const malformed: MonetizationOperationRecord = {
  key: 'wrong-journal-key',
  kind: 'rewarded-ad',
  playerId: 'player-1',
  target: 'android',
  revision: 0,
  input: { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'malformed' },
};
const foreignTarget: MonetizationOperationRecord = {
  ...malformed,
  key: 'other-target-key',
  target: 'ios',
  input: { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'foreign-target' },
};
const unreadable = {
  kind: 'purchase',
  playerId: 'player-1',
  target: 'android',
  key: 'bad-record',
  revision: 0,
} as unknown as MonetizationOperationRecord;
const diagnosticStore: MonetizationOperationStore = {
  ...operationStore,
  async listRecoverable(playerId) {
    return [...await operationStore.listRecoverable(playerId), malformed, foreignTarget, unreadable];
  },
};
const isolatedInput = {
  gateway,
  backend,
  playerId: 'player-1',
  target: 'android' as const,
  operationStore: diagnosticStore,
};
const isolated = createRecoverableMonetizationClient(isolatedInput);
const isolatedSummary = await isolated.reconcile();
const hasPending = isolatedSummary.some((entry) => entry.idempotencyKey === 'still-pending');
assert.equal(hasPending, true);
assert.equal(isolatedSummary.some((entry) => entry.idempotencyKey === 'malformed'
  && entry.status === 'action-required'), true);
const hasForeign = isolatedSummary.some((entry) => entry.idempotencyKey === 'foreign-target');
assert.equal(hasForeign, false);
const hasUnreadable = isolatedSummary.some((entry) => entry.idempotencyKey === 'unreadable-operation'
  && entry.status === 'action-required');
assert.equal(hasUnreadable, true);

console.log('Durable monetization operation recovery passed.');

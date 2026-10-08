import type {
  PlatformEvidenceEnvelope,
  PlatformGateway,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/platform';
import type { AnalyticsEvent } from '@mpgd/analytics';

import type { GameServicesBackendApi } from './client.js';
import type { ClaimAdRewardRequest } from './types.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import type {
  GameServicesOperationProgress,
  GameServicesPurchaseProgress,
} from './operation-progress.js';
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
let finalizationOutage = false;
let uiEntered: (() => void) | undefined;
let uiRelease: (() => void) | undefined;
const purchaseKeys = new Set<string>();
const rewardKeys = new Set<string>();
const provisionalAdEvidence: PlatformEvidenceEnvelope = {
  schema: 'mpgd.admob.client-reward.v1',
  payload: { adUnitId: 'ca-app-pub-1234567890123456/1234567890' },
};
const provisionalAdReward: RewardedAdResult = {
  status: 'pending',
  rewardGranted: false,
  evidence: provisionalAdEvidence,
};
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
      if (operation.idempotencyKey === 'inflight-purchase') {
        uiEntered?.();
        await new Promise<void>((resolve) => { uiRelease = resolve; });
      }
      if (operation.idempotencyKey === 'delayed-purchase') {
        return { status: 'pending', entitlementIds: [] };
      }
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
      if (operation.idempotencyKey === 'delayed-reward') {
        return { status: 'pending', rewardGranted: false };
      }
      if (operation.idempotencyKey === 'admob-ssv-delayed') {
        return provisionalAdReward;
      }
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
      if (request.idempotencyKey === 'finish-later' && finalizationOutage) {
        throw new Error('finalization backend unavailable');
      }
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
finalizationOutage = true;
const outageSummary = await restarted.reconcile();
assert.equal(outageSummary.some((entry) => entry.idempotencyKey === 'finish-later'
  && entry.status === 'granted' && entry.finalizationPending), true);
assert.equal((await restarted.purchase(finishLater)).status, 'granted');
finalizationOutage = false;
finalizationComplete = true;
const casStore: MonetizationOperationStore = {
  ...operationStore,
  async replace(expectedRevision, record) {
    if (record.kind === 'purchase' && record.input.idempotencyKey === 'finish-later'
      && record.response?.finalization?.status === 'completed') {
      throw new Error('stale finalization CAS');
    }
    await operationStore.replace(expectedRevision, record);
  },
};
const recoveryBase = { gateway, backend, playerId: 'player-1', target: 'android' as const };
const casInput = { ...recoveryBase, operationStore: casStore };
const casClient = createRecoverableMonetizationClient(casInput);
const afterCasFailure = await casClient.purchase(finishLater);
assert.equal(afterCasFailure.status, 'granted');
assert.equal(afterCasFailure.verification?.finalization?.status, 'pending');
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
  deploymentTarget: 'android',
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
  deploymentTarget: 'android',
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

const delayedPurchase = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'delayed-purchase',
};
assert.equal((await client.purchase(delayedPurchase)).status, 'pending');
const purchaseUiBeforeCallback = purchaseUiCalls;
assert.equal((await restarted.recoverPurchaseResult('delayed-purchase', {
  status: 'completed', transactionId: 'transaction-delayed-purchase', entitlementIds: [],
})).status, 'granted');
assert.equal(purchaseUiCalls, purchaseUiBeforeCallback);
ssvAvailable = true;
const delayedReward = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'delayed-reward' };
assert.equal((await client.claimRewardedAd(delayedReward)).status, 'pending');
const rewardUiBeforeCallback = rewardUiCalls;
assert.equal((await restarted.recoverRewardResult('delayed-reward', {
  status: 'completed', rewardGranted: true, ledgerEntryId: 'impression-delayed-reward',
})).status, 'granted');
assert.equal(rewardUiCalls, rewardUiBeforeCallback);

ssvAvailable = true;
const grantBeforeResult = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'grant-before-result',
};
let failGrantedResultWrite = true;
const interruptedRewardStore: MonetizationOperationStore = {
  ...operationStore,
  async replace(expectedRevision, record) {
    if (failGrantedResultWrite && record.kind === 'rewarded-ad'
      && record.input.idempotencyKey.startsWith('grant-before-')
      && record.result?.status === 'granted') {
      failGrantedResultWrite = false;
      throw new Error('result journal write lost');
    }
    await operationStore.replace(expectedRevision, record);
  },
};
const interruptedRewardInput = { ...recoveryBase, operationStore: interruptedRewardStore };
const interruptedReward = createRecoverableMonetizationClient(interruptedRewardInput);
assert.equal((await interruptedReward.claimRewardedAd(grantBeforeResult)).status, 'granted');
const offlineBackend: GameServicesBackendApi = {
  ...backend,
  adRewards: {
    async claimAdReward() {
      throw new Error('backend offline');
    },
  },
};
const offlineInput = { ...recoveryBase, backend: offlineBackend, operationStore };
const offlineReward = createRecoverableMonetizationClient(offlineInput);
const offlineResult = await offlineReward.claimRewardedAd(grantBeforeResult);
assert.equal(offlineResult.status, 'granted');
assert.equal(offlineResult.ledgerEntryId, 'reward-grant-before-result');
const contradictoryBackend: GameServicesBackendApi = {
  ...backend,
  adRewards: {
    async claimAdReward() {
      return { granted: false, alreadyProcessed: false, disposition: 'rejected' };
    },
  },
};
const contradictoryInput = { ...recoveryBase, backend: contradictoryBackend, operationStore };
const contradictoryReward = createRecoverableMonetizationClient(contradictoryInput);
const grantBeforeContradiction = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'grant-before-contradiction',
};
failGrantedResultWrite = true;
const interruptedGrant = await interruptedReward.claimRewardedAd(grantBeforeContradiction);
assert.equal(interruptedGrant.status, 'granted');
const contradictoryGrant = await contradictoryReward.claimRewardedAd(grantBeforeContradiction);
assert.equal(contradictoryGrant.status, 'granted');

const inflightOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'inflight-purchase',
};
const entered = new Promise<void>((resolve) => {
  uiEntered = resolve;
});
const beforeInflightUi = purchaseUiCalls;
const runningPurchase = client.purchase(inflightOperation);
await entered;
const duringInflight = await client.reconcile();
const retriedDuringInflight = duringInflight.some(
  (entry) => entry.idempotencyKey === 'inflight-purchase',
);
assert.equal(retriedDuringInflight, false);
const queuedPurchase = client.purchase(inflightOperation);
uiRelease?.();
assert.equal((await runningPurchase).status, 'granted');
assert.equal((await queuedPurchase).status, 'granted');
assert.equal(purchaseUiCalls, beforeInflightUi + 1);

function failOneJournalWrite(
  shouldFail: (record: MonetizationOperationRecord) => boolean,
): MonetizationOperationStore {
  let failed = false;
  return {
    ...operationStore,
    async replace(expectedRevision, record) {
      if (!failed && shouldFail(record)) {
        failed = true;
        throw new Error('simulated journal CAS failure');
      }
      await operationStore.replace(expectedRevision, record);
    },
  };
}

const platformWriteKey = 'platform-write-failure';
const platformWriteStore = failOneJournalWrite((record) => record.kind === 'purchase'
  && record.input.idempotencyKey === platformWriteKey && record.platform?.status === 'completed');
const platformWriteInput = { ...recoveryBase, operationStore: platformWriteStore };
const platformWriteClient = createRecoverableMonetizationClient(platformWriteInput);
const platformWriteOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: platformWriteKey,
};
const platformWriteFirst = await platformWriteClient.purchase(platformWriteOperation);
assert.equal(platformWriteFirst.status, 'pending');
assert.equal(platformWriteFirst.purchase.status, 'completed');
const afterPlatformWriteUi = purchaseUiCalls;
assert.equal((await platformWriteClient.purchase(platformWriteOperation)).status, 'granted');
assert.equal(purchaseUiCalls, afterPlatformWriteUi);

const adPlatformWriteKey = 'ad-platform-write-failure';
const adPlatformWriteStore = failOneJournalWrite((record) => record.kind === 'rewarded-ad'
  && record.input.idempotencyKey === adPlatformWriteKey
  && record.platform?.status === 'completed');
const adPlatformWriteInput = { ...recoveryBase, operationStore: adPlatformWriteStore };
const adPlatformWriteClient = createRecoverableMonetizationClient(adPlatformWriteInput);
const adPlatformWriteOperation = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: adPlatformWriteKey,
};
const adPlatformWriteFirst = await adPlatformWriteClient.claimRewardedAd(adPlatformWriteOperation);
assert.equal(adPlatformWriteFirst.status, 'pending');
assert.equal(adPlatformWriteFirst.reward.status, 'completed');
const afterAdPlatformWriteUi = rewardUiCalls;
const recoveredAdPlatformWrite = await adPlatformWriteClient.claimRewardedAd(
  adPlatformWriteOperation,
);
assert.equal(recoveredAdPlatformWrite.status, 'granted');
assert.equal(rewardUiCalls, afterAdPlatformWriteUi);

const responseWriteKey = 'response-write-failure';
const responseWriteStore = failOneJournalWrite((record) => record.kind === 'purchase'
  && record.input.idempotencyKey === responseWriteKey && record.response?.verified === true);
const responseWriteInput = { ...recoveryBase, operationStore: responseWriteStore };
const responseWriteClient = createRecoverableMonetizationClient(responseWriteInput);
const responseWriteOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: responseWriteKey,
};
const grantsBeforeResponseWrite = purchaseGrants;
const responseWriteFirst = await responseWriteClient.purchase(responseWriteOperation);
assert.equal(responseWriteFirst.status, 'granted');
assert.equal(purchaseGrants, grantsBeforeResponseWrite + 1);
const afterResponseWriteUi = purchaseUiCalls;
assert.equal((await responseWriteClient.purchase(responseWriteOperation)).status, 'granted');
assert.equal(purchaseUiCalls, afterResponseWriteUi);
assert.equal(purchaseGrants, grantsBeforeResponseWrite + 1);

const adResponseWriteKey = 'ad-response-write-failure';
const adResponseWriteStore = failOneJournalWrite((record) => record.kind === 'rewarded-ad'
  && record.input.idempotencyKey === adResponseWriteKey && record.response?.granted === true);
const adResponseWriteInput = { ...recoveryBase, operationStore: adResponseWriteStore };
const adResponseWriteClient = createRecoverableMonetizationClient(adResponseWriteInput);
const adResponseWriteOperation = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: adResponseWriteKey,
};
const rewardsBeforeResponseWrite = rewardGrants;
const firstAdResponseWrite = await adResponseWriteClient.claimRewardedAd(adResponseWriteOperation);
assert.equal(firstAdResponseWrite.status, 'granted');
assert.equal(rewardGrants, rewardsBeforeResponseWrite + 1);
const afterAdResponseWriteUi = rewardUiCalls;
const retriedAdResponseWrite = await adResponseWriteClient.claimRewardedAd(
  adResponseWriteOperation,
);
assert.equal(retriedAdResponseWrite.status, 'granted');
assert.equal(rewardUiCalls, afterAdResponseWriteUi);
assert.equal(rewardGrants, rewardsBeforeResponseWrite + 1);

// A known server grant must survive a persistent journal outage within this runtime.
let responseStorageDown = true;
const outageStore: MonetizationOperationStore = {
  ...operationStore,
  async replace(expectedRevision, record) {
    if (responseStorageDown && record.kind === 'purchase'
      && record.input.idempotencyKey === 'persistent-response-outage'
      && record.response?.verified === true) {
      throw new Error('response storage unavailable');
    }
    await operationStore.replace(expectedRevision, record);
  },
};
const outageClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: outageStore,
});
const outageOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'persistent-response-outage',
};
assert.equal((await outageClient.purchase(outageOperation)).status, 'granted');
assert.equal((await outageClient.purchase(outageOperation)).status, 'granted');
responseStorageDown = false;
assert.equal((await outageClient.purchase(outageOperation)).status, 'granted');

let resultStorageDown = true;
const microsoftStore = createStore();
const microsoftJournal: MonetizationOperationStore = {
  ...microsoftStore,
  async replace(expectedRevision, record) {
    if (resultStorageDown && record.kind === 'purchase'
      && record.result?.status === 'granted') {
      throw new Error('result storage unavailable');
    }
    await microsoftStore.replace(expectedRevision, record);
  },
};
let microsoftCheckouts = 0;
const microsoftGateway: PlatformGateway = {
  ...gateway,
  target: 'microsoft-store',
  commerce: {
    ...gateway.commerce,
    async purchase() {
      microsoftCheckouts += 1;
      return {
        status: 'completed',
        transactionId: 'microsoft-ledger-1',
        entitlementIds: ['COINS_100'],
        authoritativeGrant: { ledgerEntryId: 'microsoft-ledger-1' },
      };
    },
  },
};
const microsoftClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  target: 'microsoft-store',
  gateway: microsoftGateway,
  operationStore: microsoftJournal,
});
const microsoftOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'microsoft-result-outage',
};
assert.equal((await microsoftClient.purchase(microsoftOperation)).status, 'granted');
assert.equal((await microsoftClient.purchase(microsoftOperation)).status, 'granted');
resultStorageDown = false;
assert.equal((await microsoftClient.purchase(microsoftOperation)).status, 'granted');

// The adapter completed this Microsoft Store grant before the platform result was journaled.
let platformStorageDown = true;
const microsoftPlatformStore = createStore();
const microsoftPlatformJournal: MonetizationOperationStore = {
  ...microsoftPlatformStore,
  async replace(expectedRevision, record) {
    if (platformStorageDown && record.kind === 'purchase' && record.platform !== undefined) {
      throw new Error('platform storage unavailable');
    }
    await microsoftPlatformStore.replace(expectedRevision, record);
  },
};
const microsoftPlatformClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  target: 'microsoft-store',
  gateway: microsoftGateway,
  operationStore: microsoftPlatformJournal,
});
const microsoftPlatformOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'microsoft-platform-outage',
};
const checkoutsBeforePlatformOutage = microsoftCheckouts;
const microsoftPlatformFirst = await microsoftPlatformClient.purchase(microsoftPlatformOperation);
assert.equal(microsoftPlatformFirst.status, 'granted');
assert.equal(microsoftPlatformFirst.ledgerEntryId, 'microsoft-ledger-1');
const microsoftPlatformRetry = await microsoftPlatformClient.purchase(microsoftPlatformOperation);
assert.equal(microsoftPlatformRetry.status, 'granted');
platformStorageDown = false;
const microsoftRestored = await microsoftPlatformClient.purchase(microsoftPlatformOperation);
assert.equal(microsoftRestored.status, 'granted');
assert.equal(microsoftCheckouts, checkoutsBeforePlatformOutage + 1);
platformStorageDown = true;
await microsoftPlatformStore.reserve({
  key: JSON.stringify(['microsoft-store', 'purchase', 'microsoft-callback-outage']),
  kind: 'purchase',
  playerId: 'player-1',
  target: 'microsoft-store',
  deploymentTarget: 'microsoft-store',
  revision: 0,
  input: { productId: 'COINS_100', source: 'shop', idempotencyKey: 'microsoft-callback-outage' },
});
const replayedMicrosoftGrant = await microsoftPlatformClient.recoverPurchaseResult(
  'microsoft-callback-outage',
  {
    status: 'completed',
    transactionId: 'microsoft-ledger-2',
    entitlementIds: ['COINS_100'],
    authoritativeGrant: { ledgerEntryId: 'microsoft-ledger-2' },
  },
);
assert.equal(replayedMicrosoftGrant.status, 'granted');
assert.equal(replayedMicrosoftGrant.ledgerEntryId, 'microsoft-ledger-2');
platformStorageDown = false;

const otherDeployment = createRecoverableMonetizationClient({
  ...recoveryBase,
  deploymentTarget: 'android-production',
  operationStore,
});
await assert.rejects(otherDeployment.purchase(purchaseOperation), /another player or subject/);

const readFailureStore: MonetizationOperationStore = {
  ...operationStore,
  async read() {
    throw new Error('temporary journal read outage');
  },
};
await operationStore.reserve({
  key: JSON.stringify(['android', 'purchase', 'read-outage']),
  kind: 'purchase',
  playerId: 'player-1',
  target: 'android',
  deploymentTarget: 'android',
  revision: 0,
  input: { productId: 'COINS_100', source: 'shop', idempotencyKey: 'read-outage' },
});
const readFailureClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: readFailureStore,
});
const readFailureSummary = await readFailureClient.reconcile();
assert.equal(
  readFailureSummary.some((entry) => entry.status === 'pending'),
  true,
);

const racedStore = createStore();
let loseCallbackRace = true;
const racingJournal: MonetizationOperationStore = {
  ...racedStore,
  async replace(expectedRevision, record) {
    if (loseCallbackRace && record.kind === 'purchase'
      && record.platform?.transactionId === 'losing-callback') {
      loseCallbackRace = false;
      await racedStore.replace(expectedRevision, {
        ...record,
        platform: {
          status: 'completed',
          transactionId: 'winning-callback',
          entitlementIds: [],
        },
      });
      throw new Error('lost journal compare-and-swap');
    }
    await racedStore.replace(expectedRevision, record);
  },
};
const racingClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: racingJournal,
});
const raceKey = 'conflicting-cross-process-callback';
await racedStore.reserve({
  key: JSON.stringify(['android', 'purchase', raceKey]),
  kind: 'purchase',
  playerId: 'player-1',
  target: 'android',
  deploymentTarget: 'android',
  revision: 0,
  input: { productId: 'COINS_100', source: 'shop', idempotencyKey: raceKey },
});
assert.equal((await racingClient.recoverPurchaseResult(raceKey, {
  status: 'completed',
  transactionId: 'losing-callback',
  entitlementIds: [],
})).status, 'pending');
await assert.rejects(
  racingClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: raceKey,
  }),
  /conflicts with the recorded operation/,
);

const purchaseRejection = {
  verified: false,
  alreadyProcessed: false,
  disposition: 'rejected' as const,
  reason: 'STORE_REJECTED',
};
const rewardRejection = {
  granted: false,
  alreadyProcessed: false,
  disposition: 'rejected' as const,
};

/** Another runtime commits a terminal rejection just before this runtime's grant response. */
function rejectBeforeGrantLands(journal: MonetizationOperationStore): MonetizationOperationStore {
  const raced = new Set<string>();
  return {
    ...journal,
    async replace(expectedRevision, record) {
      if (raced.has(record.key) || record.platform === undefined) {
        await journal.replace(expectedRevision, record);
        return;
      }
      if (record.kind === 'purchase' && record.response?.verified === true) {
        raced.add(record.key);
        await journal.replace(expectedRevision, {
          ...record,
          response: purchaseRejection,
          result: {
            status: 'rejected',
            purchase: record.platform,
            verification: purchaseRejection,
          },
        });
        throw new Error('another runtime recorded a rejection first');
      }
      if (record.kind === 'rewarded-ad' && record.response?.granted === true) {
        raced.add(record.key);
        await journal.replace(expectedRevision, {
          ...record,
          response: rewardRejection,
          result: { status: 'rejected', reward: record.platform, claim: rewardRejection },
        });
        throw new Error('another runtime recorded a rejection first');
      }
      await journal.replace(expectedRevision, record);
    },
  };
}

let contestedVerifications = 0;
let contestedClaims = 0;
const contestedBackend: GameServicesBackendApi = {
  ...backend,
  purchases: {
    async verifyPurchase() {
      contestedVerifications += 1;
      return contestedVerifications === 1
        ? { verified: true, alreadyProcessed: false, ledgerEntryId: 'purchase-contested' }
        : purchaseRejection;
    },
  },
  adRewards: {
    async claimAdReward() {
      contestedClaims += 1;
      return contestedClaims === 1
        ? { granted: true, alreadyProcessed: false, ledgerEntryId: 'reward-contested' }
        : rewardRejection;
    },
  },
};
const contestedStore = createStore();
const contestedClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  backend: contestedBackend,
  operationStore: rejectBeforeGrantLands(contestedStore),
});
const contestedPurchase = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'contested-purchase',
};
assert.equal((await contestedClient.purchase(contestedPurchase)).status, 'granted');
const uiBeforeContestedRetry = purchaseUiCalls;
const contestedRetry = await contestedClient.purchase(contestedPurchase);
assert.equal(contestedRetry.status, 'granted', 'a cached grant replaces a stale rejection');
assert.equal(contestedRetry.ledgerEntryId, 'purchase-contested');
assert.equal(purchaseUiCalls, uiBeforeContestedRetry);
const contestedRecord = await contestedStore.read(
  JSON.stringify(['android', 'purchase', 'contested-purchase']),
);
assert.equal(contestedRecord?.result?.status, 'granted');

const contestedReward = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'contested-reward' };
assert.equal((await contestedClient.claimRewardedAd(contestedReward)).status, 'granted');
const rewardUiBeforeContestedRetry = rewardUiCalls;
const contestedRewardRetry = await contestedClient.claimRewardedAd(contestedReward);
assert.equal(contestedRewardRetry.status, 'granted', 'a cached claim replaces a stale rejection');
assert.equal(contestedRewardRetry.ledgerEntryId, 'reward-contested');
assert.equal(rewardUiCalls, rewardUiBeforeContestedRetry);
const contestedRewardRecord = await contestedStore.read(
  JSON.stringify(['android', 'rewarded-ad', 'contested-reward']),
);
assert.equal(contestedRewardRecord?.result?.status, 'granted');

/** Records one invocation's progress; journal recovery must finish it with `completed`. */
function observeProgress(): {
  readonly events: string[];
  readonly options: { onProgress(progress: GameServicesOperationProgress): void };
} {
  const events: string[] = [];
  const onProgress = (progress: GameServicesOperationProgress): void => {
    assert.equal(progress.sequence, events.length + 1, 'progress sequence');
    events.push(progress.phase === 'completed' ? `completed:${progress.status}` : progress.phase);
  };
  return { events, options: { onProgress } };
}

const settledOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'progress-settled',
};
const settledProgress = observeProgress();
const settledPurchase = await client.purchase(settledOperation, settledProgress.options);
assert.equal(settledPurchase.status, 'granted');
assert.equal(
  settledProgress.events.join(','),
  'platform-requested,platform-result,server-requested,server-result,completed:granted',
);

const progressPlatformKey = 'progress-platform-write';
const progressPlatformClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: failOneJournalWrite((record) => record.kind === 'purchase'
    && record.input.idempotencyKey === progressPlatformKey && record.platform !== undefined),
});
const progressPlatformOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: progressPlatformKey,
};
const progressPlatformEvents = observeProgress();
const progressPlatformResult = await progressPlatformClient.purchase(
  progressPlatformOperation,
  progressPlatformEvents.options,
);
assert.equal(progressPlatformResult.status, 'pending');
assert.equal(progressPlatformEvents.events.join(','), 'platform-requested,completed:pending');

ssvAvailable = true;
const progressClaimKey = 'progress-claim-write';
const progressClaimClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: failOneJournalWrite((record) => record.kind === 'rewarded-ad'
    && record.input.idempotencyKey === progressClaimKey && record.response?.granted === true),
});
const claimWriteOperation = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: progressClaimKey,
};
const claimWriteProgress = observeProgress();
const claimWriteResult = await progressClaimClient.claimRewardedAd(
  claimWriteOperation,
  claimWriteProgress.options,
);
assert.equal(claimWriteResult.status, 'granted');
assert.equal(
  claimWriteProgress.events.join(','),
  'platform-requested,platform-result,server-requested,completed:granted',
);

ssvAvailable = false;
const provisionalAdKey = 'admob-ssv-delayed';
const provisionalAd = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: provisionalAdKey };
const provisionalUiBefore = rewardUiCalls;
assert.equal((await client.claimRewardedAd(provisionalAd)).status, 'pending');
assert.equal(rewardUiCalls, provisionalUiBefore + 1);
ssvAvailable = true;
await restarted.reconcile();
assert.equal((await restarted.claimRewardedAd(provisionalAd)).status, 'granted');
assert.equal(
  rewardUiCalls,
  provisionalUiBefore + 1,
  'SSV recovery must not reopen a provisional ad',
);

// Late callbacks must join the original journal operation, including after a
// runtime restart, without changing proof identity or reopening native UI.
{
  const lateStore = createStore();
  const requests: ClaimAdRewardRequest[] = [];
  let sdkCalls = 0;
  let ready = false;
  let nowTick = 0;
  const lateEvidence = {
    schema: 'mpgd.admob.client-reward.v1',
    payload: { adUnitId: 'ca-app-pub-1234567890123456/1234567890' },
  };
  const args = {
    gateway: {
      ...gateway,
      ads: {
        ...gateway.ads,
        async showRewarded(): Promise<RewardedAdResult> {
          sdkCalls += 1;
          return { status: 'pending', rewardGranted: false };
        },
      },
    },
    backend: {
      ...backend,
      adRewards: {
        async claimAdReward(request: ClaimAdRewardRequest) {
          requests.push(structuredClone(request));
          return ready
            ? { granted: true, ledgerEntryId: 'late-server-ledger', alreadyProcessed: false }
            : { granted: false, alreadyProcessed: false, disposition: 'pending' as const };
        },
      },
    },
    playerId: 'late-player',
    target: 'android' as const,
    operationStore: lateStore,
    rewardEvidenceRegistry: createDefaultClientRewardEvidenceRegistry(),
    now: () => `2026-10-09T00:00:${String(nowTick++).padStart(2, '0')}Z`,
  };
  const initial = createRecoverableMonetizationClient(args);
  assert.equal(
    (await initial.claimRewardedAd({ placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'late-key' })).status,
    'pending',
  );
  assert.equal(requests.length, 0);
  const recorded = (await lateStore.listRecoverable('late-player'))[0];
  if (recorded === undefined) {
    throw new Error('Reserved ad was not journaled.');
  }
  const restartedLate = createRecoverableMonetizationClient(args);
  await assert.rejects(
    restartedLate.recoverRewardResult('late-key', {
      status: 'pending',
      rewardGranted: false,
      evidence: { schema: 'unknown.reward.v1', payload: {} },
    }),
    /conflicts/,
  );
  assert.equal(
    (await restartedLate.recoverRewardResult('late-key', { status: 'pending', rewardGranted: false, evidence: lateEvidence })).status,
    'pending',
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.completedAt,
    recorded.platformCompletedAt,
    'first journal timestamp must remain fixed',
  );
  await assert.rejects(
    restartedLate.recoverRewardResult('late-key', {
      status: 'completed',
      rewardGranted: false,
      evidence: { ...lateEvidence, payload: { adUnitId: 'ca-app-pub-9999999999999999/9999999999' } },
    }),
    /conflicts/,
  );
  assert.equal(requests.length, 1, 'conflicting evidence cannot reach the backend');
  ready = true;
  const settled = await restartedLate.recoverRewardResult('late-key', {
    status: 'completed',
    rewardGranted: false,
    evidence: lateEvidence,
  });
  assert.equal(settled.status, 'granted');
  assert.equal(settled.ledgerEntryId, 'late-server-ledger');
  assert.equal(
    JSON.stringify(requests[1]),
    JSON.stringify(requests[0]),
    'reuse the original complete verification request',
  );
  assert.equal(sdkCalls, 1, 'late correlation and restart never reopen native UI');
  const undispatchedStore = createStore();
  const undispatched = createRecoverableMonetizationClient({
    ...args,
    gateway: {
      ...args.gateway,
      ads: {
        ...args.gateway.ads,
        async showRewarded(): Promise<RewardedAdResult> {
          return { status: 'pending', rewardGranted: false, evidence: lateEvidence };
        },
      },
    },
    operationStore: {
      ...undispatchedStore,
      async replace(revision, record) {
        if (record.request !== undefined) {
          throw new Error('request journal unavailable');
        }
        await undispatchedStore.replace(revision, record);
      },
    },
  });
  const before = requests.length;
  assert.equal(
    (await undispatched.claimRewardedAd({ placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'bound-before-request' })).status,
    'pending',
  );
  await assert.rejects(
    undispatched.recoverRewardResult('bound-before-request', {
      status: 'completed',
      rewardGranted: false,
      evidence: { ...lateEvidence, payload: { adUnitId: 'ca-app-pub-9999999999999999/9999999999' } },
    }),
    /conflicts/,
  );
  assert.equal(
    requests.length,
    before,
    'proof binding remains immutable even before dispatch is journaled',
  );
  const legacyEvidence = { schema: 'legacy.reward.v1', payload: { operation: 'legacy-late' } };
  const legacyLate = createRecoverableMonetizationClient({
    gateway: {
      ...gateway,
      ads: {
        ...gateway.ads,
        async showRewarded(): Promise<RewardedAdResult> {
          return { status: 'pending', rewardGranted: false, evidence: legacyEvidence };
        },
      },
    },
    backend: args.backend,
    playerId: 'late-player',
    target: 'android',
    operationStore: createStore(),
  });
  assert.equal(
    (await legacyLate.claimRewardedAd({ placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'legacy-late' })).status,
    'pending',
  );
  assert.equal(
    (await legacyLate.recoverRewardResult('legacy-late', { status: 'completed', rewardGranted: true, ledgerEntryId: 'legacy-impression', evidence: legacyEvidence })).status,
    'granted',
  );
  assert.equal(
    requests.at(-1)?.platformImpressionId,
    'legacy-impression',
    'legacy completion still goes through backend verification',
  );
}

console.log('Durable monetization operation recovery passed.');

import type { PlatformEvidenceEnvelope, PlatformGateway, RewardedAdResult } from '@mpgd/platform';
import type { AnalyticsEvent } from '@mpgd/analytics';

import type { GameServicesBackendApi } from './client.js';
import {
  createTestCommerceProvider,
  createTestGateway,
  createTestStorePurchase,
} from './commerce-test-provider.test.js';
import type { ClaimAdRewardRequest } from './types.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import type {
  GameServicesOperationProgress,
  GameServicesPurchaseProgress,
} from './operation-progress.js';
import { isMonetizationOperationRecoverable } from './monetization-operation-store.js';
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
        .filter((record) => record.playerId === playerId && isMonetizationOperationRecoverable(record))
        .map((record) => structuredClone(record));
    },
  };
}

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
// The store sheet: `finish: 'server'` means the backend's finalization ends a granted purchase.
const commerce = createTestCommerceProvider({
  finish: 'server',
  async answer(request) {
    if (request.idempotencyKey === 'inflight-purchase') {
      uiEntered?.();
      await new Promise<void>((resolve) => { uiRelease = resolve; });
    }
    if (request.idempotencyKey === 'delayed-purchase') {
      // The store answers later: the purchase shows up in its unfinished list.
      return { outcome: 'launched' };
    }
    return {
      outcome: 'purchased',
      purchase: createTestStorePurchase(request),
    };
  },
});
const gateway: PlatformGateway = createTestGateway({
  playerId: 'player-1',
  provider: commerce,
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
});
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
        finalization: request.idempotencyKey === 'finish-later' && !finalizationComplete
          ? { status: 'pending' as const, alreadyCompleted: false, reason: 'PROVIDER_UNAVAILABLE' }
          : { status: 'completed' as const, action: 'consume' as const, alreadyCompleted: false },
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

// A backend response lost after the ledger grant: the saved verify request is resent after a restart.
const purchaseOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'response-lost',
};
assert.equal((await client.purchase(purchaseOperation)).status, 'pending');
assert.equal(purchaseGrants, 1, 'the backend already granted before the response was lost');
assert.equal(commerce.purchaseUiOpened, 1);
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
assert.equal(commerce.purchaseUiOpened, 1, 'backend retries must not reopen checkout');
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

// A store that answers later: the store lists the purchase, and a reconcile pass verifies it
// under the game's key without opening the sheet again.
const delayedPurchase = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'delayed-purchase',
};
assert.equal((await client.purchase(delayedPurchase)).status, 'pending');
const purchaseUiBeforeListing = commerce.purchaseUiOpened;
commerce.available.push(
  createTestStorePurchase({
    idempotencyKey: 'delayed-purchase',
    logicalId: 'COINS_100',
  }),
);
const resumed = makeClient('player-1');
const listedSummary = await resumed.reconcile();
assert.equal(
  listedSummary.some((entry) => entry.kind === 'commerce-purchase'
    && entry.idempotencyKey === 'delayed-purchase' && entry.status === 'granted'),
  true,
  'the purchase the store lists later is granted by the backend',
);
assert.equal(commerce.purchaseUiOpened, purchaseUiBeforeListing, 'recovery never reopens checkout');
assert.equal((await resumed.purchase(delayedPurchase)).status, 'granted');
assert.equal(commerce.purchaseUiOpened, purchaseUiBeforeListing);
assert.equal(
  Object.keys(listedSummary[0] ?? {}).includes('purchase'),
  false,
  'summaries never carry the store purchase or its evidence',
);

// A server-owned finish: the grant stays open while the provider-side finalization is pending.
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
await restarted.reconcile();
const finished = await restarted.purchase(finishLater);
assert.equal(finished.verification?.finalization?.status, 'completed');
assert.equal(
  (await restarted.reconcile()).some((entry) => entry.idempotencyKey === 'finish-later'),
  false,
  'a finished purchase is no longer reported',
);
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
const beforeRepeatedRejection = commerce.purchaseUiOpened;
assert.equal((await rejectedClient.purchase(rejectedOperation)).status, 'rejected');
assert.equal(commerce.purchaseUiOpened, beforeRepeatedRejection);

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
  kind: 'rewarded-ad',
  playerId: 'player-1',
  target: 'android',
  key: 'bad-record',
  deploymentTarget: 'android',
  revision: 0,
} as unknown as MonetizationOperationRecord;
// A journal written before commerce v2 C4 can still hold v1 purchase records: they parse, and
// one that was mid-verification (a completed platform result, no terminal result) is finished
// through the backend once; nothing reopens checkout or grants locally.
const retiredPurchase: MonetizationOperationRecord = {
  key: JSON.stringify(['android', 'purchase', 'retired-v1-purchase']),
  kind: 'purchase',
  playerId: 'player-1',
  target: 'android',
  deploymentTarget: 'android',
  revision: 0,
  input: { productId: 'COINS_100', source: 'shop', idempotencyKey: 'retired-v1-purchase' },
  platform: {
    status: 'completed',
    transactionId: 'retired-v1-transaction',
    entitlementIds: [],
    evidence: { schema: 'test.purchase.v1', payload: { token: 'retired-token' } },
  },
  platformCompletedAt: '2026-09-01T00:00:00.000Z',
};
assert.equal(
  isMonetizationOperationRecoverable(retiredPurchase),
  true,
  'a retired v1 purchase record with a completed platform result and no result is still open',
);
const neverCompletedRetiredPurchase: MonetizationOperationRecord = {
  ...(retiredPurchase as Extract<MonetizationOperationRecord, { kind: 'purchase' }>),
  key: JSON.stringify(['android', 'purchase', 'retired-v1-never-completed']),
  input: { productId: 'COINS_100', source: 'shop', idempotencyKey: 'retired-v1-never-completed' },
  platform: { status: 'pending', entitlementIds: [] },
};
assert.equal(
  isMonetizationOperationRecoverable(neverCompletedRetiredPurchase),
  false,
  'a retired v1 purchase record whose platform never completed has nothing to verify',
);
await operationStore.reserve(retiredPurchase);
await operationStore.reserve(neverCompletedRetiredPurchase);
const diagnosticStore: MonetizationOperationStore = {
  ...operationStore,
  async listRecoverable(playerId) {
    return [
      ...await operationStore.listRecoverable(playerId),
      malformed,
      foreignTarget,
      unreadable,
    ];
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
const purchaseUiBeforeIsolated = commerce.purchaseUiOpened;
const grantsBeforeIsolated = purchaseGrants;
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
assert.equal(
  isolatedSummary.some((entry) => entry.idempotencyKey === 'retired-v1-purchase'
    && entry.status === 'granted'),
  true,
  'reconcile() finishes the verification a retired v1 purchase record was in the middle of',
);
assert.equal(
  isolatedSummary.some((entry) => entry.idempotencyKey === 'retired-v1-never-completed'),
  false,
  'reconcile() has nothing to report for a retired record whose platform never completed',
);
assert.equal(
  commerce.purchaseUiOpened,
  purchaseUiBeforeIsolated,
  'a retired v1 purchase record never reopens checkout',
);
assert.equal(
  purchaseGrants,
  grantsBeforeIsolated + 1,
  'the retired record is verified once, by the backend (the ledger grants, not the client)',
);
const drained = await operationStore.read(retiredPurchase.key);
assert.equal(
  drained?.kind === 'purchase' && drained.result?.status === 'granted'
    && drained.result.ledgerEntryId === 'purchase-retired-v1-purchase',
  true,
  'the backend answer is journaled as the closing result',
);
assert.equal(
  drained !== undefined && isMonetizationOperationRecoverable(drained),
  false,
  'a closed retired record is not open again',
);
assert.equal(
  (await isolated.restorePurchases()).some(
    (entry) => entry.idempotencyKey === 'retired-v1-purchase',
  ),
  false,
  'restorePurchases() does not send a closed retired v1 purchase record again',
);
assert.equal(
  purchaseGrants,
  grantsBeforeIsolated + 1,
  'a closed retired record is not verified a second time',
);

ssvAvailable = true;
const delayedReward = { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'delayed-reward' };
assert.equal((await client.claimRewardedAd(delayedReward)).status, 'pending');
const rewardUiBeforeCallback = rewardUiCalls;
assert.equal((await restarted.recoverRewardResult('delayed-reward', {
  status: 'completed', rewardGranted: true, ledgerEntryId: 'impression-delayed-reward',
})).status, 'granted');
assert.equal(rewardUiCalls, rewardUiBeforeCallback);

ssvAvailable = true;
const recoveryBase = { gateway, backend, playerId: 'player-1', target: 'android' as const };
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

// A checkout still open: a reconcile pass does not open a second sheet, and a queued replay of the
// same key answers from the one purchase.
const inflightOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'inflight-purchase',
};
const entered = new Promise<void>((resolve) => {
  uiEntered = resolve;
});
const beforeInflightUi = commerce.purchaseUiOpened;
const runningPurchase = client.purchase(inflightOperation);
await entered;
await client.reconcile();
assert.equal(commerce.purchaseUiOpened, beforeInflightUi + 1, 'a pass never opens a second sheet');
const queuedPurchase = client.purchase(inflightOperation);
uiRelease?.();
assert.equal((await runningPurchase).status, 'granted');
assert.equal((await queuedPurchase).status, 'granted');
assert.equal(commerce.purchaseUiOpened, beforeInflightUi + 1);

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

// Reconciliation survives a temporary journal read outage on a rewarded-ad record.
const readFailureStore: MonetizationOperationStore = {
  ...operationStore,
  async read() {
    throw new Error('temporary journal read outage');
  },
};
await operationStore.reserve({
  key: JSON.stringify(['android', 'rewarded-ad', 'read-outage']),
  kind: 'rewarded-ad',
  playerId: 'player-1',
  target: 'android',
  deploymentTarget: 'android',
  revision: 0,
  input: { placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'read-outage' },
});
const readFailureClient = createRecoverableMonetizationClient({
  ...recoveryBase,
  operationStore: readFailureStore,
});
const readFailureSummary = await readFailureClient.reconcile();
assert.equal(
  readFailureSummary.some((entry) => entry.kind === 'rewarded-ad' && entry.status === 'pending'),
  true,
);

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
      if (raced.has(record.key) || record.kind !== 'rewarded-ad' || record.platform === undefined) {
        await journal.replace(expectedRevision, record);
        return;
      }
      if (record.response?.granted === true) {
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

let contestedClaims = 0;
const contestedBackend: GameServicesBackendApi = {
  ...backend,
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
assert.equal(
  contestedRewardRecord?.kind === 'rewarded-ad' ? contestedRewardRecord.result?.status : undefined,
  'granted',
);

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

// The recoverable client's restore trigger runs the provider restore and a pass.
{
  const restoreProvider = createTestCommerceProvider({ finish: 'none' });
  let restoreCalls = 0;
  const restoring = createRecoverableMonetizationClient({
    gateway: createTestGateway({
      playerId: 'restore-player',
      provider: {
        ...restoreProvider,
        async restorePurchases() {
          restoreCalls += 1;
          restoreProvider.available.push(
            createTestStorePurchase({
              idempotencyKey: 'restored-purchase',
              logicalId: 'COINS_100',
            }),
          );
        },
      },
    }),
    backend,
    playerId: 'restore-player',
    target: 'android',
    operationStore: createStore(),
    now: () => currentTime,
  });
  assert.equal((await restoring.reconcile()).length, 0, 'nothing to recover before the restore');
  const grantsBeforeRestore = purchaseGrants;
  await restoring.restorePurchases();
  assert.equal(restoreCalls, 1, 'the provider restore ran');
  assert.equal(
    purchaseGrants,
    grantsBeforeRestore + 1,
    'a restored purchase is verified and granted by the backend',
  );
  assert.equal(
    (await restoring.commerceReconciler?.listRecoverable())?.length,
    0,
    'the restored purchase ends terminal, so it is no longer reported',
  );
  await restoring.commerceReconciler?.stop();
}

// A gateway without a commerce provider: purchases are rejected without any store UI, there is no
// reconciler, and rewarded-ad recovery is untouched.
{
  const rewardsBeforeNoCommerce = rewardUiCalls;
  const { commerce: _commerce, ...gatewayWithoutCommerce } = gateway;
  const noCommerce = createRecoverableMonetizationClient({
    gateway: gatewayWithoutCommerce,
    backend,
    playerId: 'player-1',
    target: 'android',
    operationStore,
    now: () => currentTime,
    analytics,
  });
  const purchaseUiBeforeNoCommerce = commerce.purchaseUiOpened;
  const grantsBeforeNoCommerce = purchaseGrants;
  const rejected = await noCommerce.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'no-commerce-purchase',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.purchase.status, 'failed');
  assert.equal(analyticsEvents.at(-1)?.name, 'purchase_rejected');
  assert.equal(analyticsEvents.at(-1)?.properties.reason, 'commerce_unavailable');
  assert.equal(noCommerce.commerceReconciler, undefined, 'no provider, no reconciler');
  assert.equal(commerce.purchaseUiOpened, purchaseUiBeforeNoCommerce, 'no store UI opened');
  assert.equal(purchaseGrants, grantsBeforeNoCommerce, 'nothing was verified or granted');
  assert.equal(
    (await noCommerce.restorePurchases()).every((entry) => entry.kind === 'rewarded-ad'),
    true,
    'restorePurchases() falls back to the rewarded-ad pass',
  );
  assert.equal(rewardUiCalls, rewardsBeforeNoCommerce, 'recovery never reopens a rewarded ad');
}

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
  if (recorded === undefined || recorded.kind !== 'rewarded-ad') {
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

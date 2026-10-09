import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AdPlacements } from '@mpgd/catalog';
import { createAdRewardEvidenceVerifierRegistry } from './ad-reward-verifier-registry.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import { createGameServicesBackend, createInMemoryGameServicesStore } from './server.js';
import {
  createOnePlayAdRewardVerifier,
  createOnePlayRewardRequestIssuer,
  createOnePlaySsvReceiver,
  verifyOnePlaySsv,
  type OnePlayRewardBinding,
  type OnePlayRewardClaimIdentity,
  type OnePlayRewardStore,
  type OnePlaySsvReceipt,
} from './oneplay-reward.js';
import { onePlayClientRewardEvidenceSchema } from './oneplay-client-reward.js';

const now = 1_900_000_000_000;
const key = 'oneplay_test_secret_key';
const placements: AdPlacements = {
  version: 'test',
  sharedPlatformPlacementTargets: ['oneplay'],
  placements: [
    {
      id: 'CONTINUE',
      type: 'rewarded',
      reward: { type: 'continue', amount: 1 },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { oneplay: 'issued-reward' },
    },
    {
      id: 'BONUS',
      type: 'rewarded',
      reward: { type: 'currency', amount: 3, currency: 'coin' },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { oneplay: 'issued-reward' },
    },
  ],
};
class Store implements OnePlayRewardStore {
  readonly bindings: OnePlayRewardBinding[] = [];
  readonly receipts = new Map<string, OnePlaySsvReceipt>();
  async issue(binding: OnePlayRewardBinding) {
    const existing = await this.findByClaim(binding);
    if (existing !== undefined) {
      return existing;
    }
    if (this.bindings.some((entry) => entry.requestId === binding.requestId)) {
      throw new Error('request collision');
    }
    this.bindings.push(binding);
    return binding;
  }
  async findByClaim(input: OnePlayRewardClaimIdentity) {
    return this.bindings.find(
    (entry) => entry.applicationId === input.applicationId && entry.deploymentTarget === input.deploymentTarget && entry.playerId === input.playerId && entry.idempotencyKey === input.idempotencyKey,
  );
  }
  async findByRequest(input: { applicationId: string; requestId: string }) {
    return this.bindings.find(
      (entry) => entry.applicationId === input.applicationId && entry.requestId === input.requestId,
    );
  }
  async recordReceipt(input: { requestId: string; receipt: OnePlaySsvReceipt }) {
    if (!this.receipts.has(input.requestId)) {
      this.receipts.set(input.requestId, input.receipt);
    }
  }
  async findReceipt(input: { requestId: string }) {
    return this.receipts.get(input.requestId);
  }
}
const store = new Store();
let nonce = 0;
const issuer = createOnePlayRewardRequestIssuer({
  applicationId: 'app',
  placements,
  store,
  now: () => now,
  createRequestId: () => `request-${++nonce}`,
});
const issued = await issuer.issue({
  playerId: 'authenticated-player',
  placementId: 'CONTINUE',
  idempotencyKey: 'claim',
});
assert.equal(
  (await issuer.issue({ playerId: 'authenticated-player', placementId: 'CONTINUE', idempotencyKey: 'claim' })).requestId,
  issued.requestId,
);
await assert.rejects(
  () =>
    issuer.issue({
      playerId: 'authenticated-player',
      placementId: 'BONUS',
      idempotencyKey: 'claim',
    }),
  /conflict/u,
);
function signed(body: string, timestamp = String(now)) {
  return {
    apiKey: key,
    rawBody: new TextEncoder().encode(body),
    timestamp,
    signature: createHmac('sha256', key).update(`${timestamp}\n`).update(body).digest('hex'),
  };
}
const callback = signed(
  `{ "requestId": "${issued.requestId}", "status": "SUCCESS", "reason": "" }`,
);
assert.equal(
  (await verifyOnePlaySsv(callback, { apiKey: key, now: () => now })).status,
  'verified',
);
assert.equal(
  (await verifyOnePlaySsv({ ...callback, rawBody: new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(callback.rawBody)))) }, { apiKey: key, now: () => now })).status,
  'rejected',
);
assert.equal(
  (await verifyOnePlaySsv({ ...callback, apiKey: 'wrong-key' }, { apiKey: key, now: () => now })).status,
  'rejected',
);
assert.equal(
  (await verifyOnePlaySsv(signed('{"requestId":"request-1","status":"SUCCESS","reason":""}', String(now - 300001)), { apiKey: key, now: () => now })).status,
  'rejected',
);
assert.equal(
  (await verifyOnePlaySsv(signed('{"requestId":"request-1","status":"FAILED","reason":""}'), { apiKey: key, now: () => now })).status,
  'rejected',
);
const registration = createOnePlayAdRewardVerifier({
  applicationId: 'app',
  apiKey: key,
  store,
  now: () => now,
});
const registry = createAdRewardEvidenceVerifierRegistry([registration]);
const ledger = createInMemoryGameServicesStore();
const backend = createGameServicesBackend({
  catalog: { version: 'test', products: [] },
  placements,
  store: ledger,
  evidenceVerifier: {
    verifyPurchase: async () => ({ status: 'rejected', reason: 'unsupported' }),
    verifyAdReward: registry.verifyAdReward,
  },
  now: () => new Date(now).toISOString(),
});
const claim = {
  target: 'oneplay' as const,
  providerId: 'oneplay-ads',
  playerId: 'authenticated-player',
  placementId: 'CONTINUE',
  idempotencyKey: 'claim',
  platformImpressionId: issued.requestId,
  completedAt: new Date(now).toISOString(),
};
assert.equal((await backend.adRewards.claimAdReward(claim)).disposition, 'pending');
assert.equal((await ledger.listEntitlementTransactions()).length, 0);
const receiver = createOnePlaySsvReceiver({
  applicationId: 'app',
  apiKey: key,
  store,
  now: () => now,
  backend,
});
assert.equal(
  (await receiver.receive(signed('{"requestId":"unknown","status":"SUCCESS","reason":""}'))).status,
  'rejected',
);
const received = await receiver.receive(callback);
assert.equal(received.status, 'verified');
assert.equal(received.status === 'verified' && received.grant?.granted, true);
assert.equal((await receiver.receive(callback)).status, 'verified');
assert.equal((await backend.adRewards.claimAdReward(claim)).alreadyProcessed, true);
assert.equal((await ledger.listEntitlementTransactions()).length, 1);
assert.equal(
  (await backend.adRewards.claimAdReward({ ...claim, playerId: 'another-player' })).granted,
  false,
);
assert.equal(
  (await backend.adRewards.claimAdReward({ ...claim, placementId: 'BONUS', idempotencyKey: 'another' })).granted,
  false,
);
assert.equal(
  (await backend.adRewards.claimAdReward({ ...claim, platformImpressionId: 'counterfeit', idempotencyKey: 'another' })).granted,
  false,
);
const verifyInput = {
  request: claim,
  placement: placements.placements[0]!,
  platformPlacementId: 'issued-reward',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};
assert.equal(
  (await registration.verify({ ...verifyInput, request: { ...claim, deploymentTarget: 'different' } })).status,
  'rejected',
);
const delayed = createOnePlayAdRewardVerifier({
  applicationId: 'app',
  apiKey: key,
  store,
  now: () => now + 600_000,
});
assert.equal((await delayed.verify(verifyInput)).status, 'verified'); // receipt is checked at trusted receiver time, not the later claim time.
store.receipts.set(issued.requestId, {
  ...store.receipts.get(issued.requestId)!,
  signature: '0'.repeat(64),
});
assert.equal((await registration.verify(verifyInput)).status, 'rejected');
const evidence = {
  schema: onePlayClientRewardEvidenceSchema,
  payload: {
    requestId: issued.requestId,
    placementId: 'CONTINUE',
    platformPlacementId: 'issued-reward',
    event: 'rewarded',
    rewardGranted: false,
  },
};
const decoder = createDefaultClientRewardEvidenceRegistry();
assert.equal(
  decoder.resolve({ status: 'completed', rewardGranted: false, evidence })?.platformImpressionId,
  issued.requestId,
);
assert.equal(decoder.resolve({ status: 'completed', rewardGranted: true, evidence }), undefined);
assert.equal(
  decoder.resolve({ status: 'pending', rewardGranted: false, evidence: { ...evidence, payload: { ...evidence.payload, event: 'outcome-unknown' } } })?.platformImpressionId,
  issued.requestId,
);
console.log(
  'ONE play signed SSV issuance, raw-byte authentication, durable correlation, independent grants, replay protection and late recovery passed.',
);

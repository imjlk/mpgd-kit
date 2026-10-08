/// <reference types="node" />
import assert from 'node:assert/strict';

import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type RewardedAdResult,
} from '@mpgd/platform';
import { adProtocol, adProtocolVersion, toAdAdapter } from '@mpgd/platform/ads';

import { createGameServicesClient, type GameServicesBackendApi } from './client.js';
import {
  createClientRewardEvidenceRegistry,
  resolveClientRewardClaim,
} from './client-reward-evidence.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import { createGameServicesRuntime } from './runtime.js';
import { createGameServicesBackend } from './server.js';
import {
  createRecoverableMonetizationClient,
  type MonetizationOperationRecord,
  type MonetizationOperationStore,
} from './monetization-recovery.js';

const schema = 'new-provider.reward.v1';
const normalizer = {
  schema,
  normalize: (reward: RewardedAdResult) =>
    reward.evidence?.payload.token === 'proof'
      ? { platformImpressionId: 'native-impression' }
      : undefined,
};
const registry = createClientRewardEvidenceRegistry([normalizer]);
const evidence = { schema, payload: { token: 'proof' } };
let reward: RewardedAdResult = { status: 'completed', rewardGranted: false, evidence };
const candidate = registry.resolve(reward);
assert.equal(candidate?.platformImpressionId, 'native-impression');
assert.equal(Object.isFrozen(candidate?.evidence?.payload), true);
evidence.payload.token = 'mutated';
assert.equal(candidate?.evidence?.payload.token, 'proof');
evidence.payload.token = 'proof';
assert.throws(() => createClientRewardEvidenceRegistry([normalizer, normalizer]), /duplicate/);
assert.equal(registry.resolve({ ...reward, status: 'skipped' }), undefined);
assert.equal(
  registry.resolve({ ...reward, evidence: { schema: 'unknown', payload: {} } }),
  undefined,
);
assert.equal(
  registry.resolve({ ...reward, evidence: { schema, payload: { token: Number.NaN } } }),
  undefined,
);
assert.equal(
  registry.resolve({ ...reward, evidence: { schema, payload: { token: 'wrong' } } }),
  undefined,
);
assert.equal(
  createClientRewardEvidenceRegistry([{ schema, normalize() { throw new Error('raw proof'); } }]).resolve(
    reward,
  ),
  undefined,
);
assert.equal(
  createClientRewardEvidenceRegistry([{ schema, normalize: () => ({ platformImpressionId: '' }) }]).resolve(
    reward,
  ),
  undefined,
);
assert.equal(
  resolveClientRewardClaim(
    { ...reward, rewardGranted: true, evidence: { schema, payload: {} } },
    registry,
    { allowLegacyCompletion: true },
  ),
  undefined,
);
assert.equal(
  resolveClientRewardClaim({ status: 'completed', rewardGranted: true }, registry, {
    allowLegacyCompletion: false,
  }),
  undefined,
);
assert.deepEqual(
  resolveClientRewardClaim({ status: 'completed', rewardGranted: true }, registry, {
    allowLegacyCompletion: true,
  }),
  {},
);
assert.equal(
  resolveClientRewardClaim(
    { ...reward, rewardGranted: true, evidence: null } as unknown as RewardedAdResult,
    registry,
    { allowLegacyCompletion: true },
  ),
  undefined,
);

const defaults = createDefaultClientRewardEvidenceRegistry();
const ait: RewardedAdResult = {
  status: 'completed',
  rewardGranted: false,
  evidence: {
    schema: 'apps-in-toss.rewarded-ad.callback.v1',
    payload: { event: 'user-earned-reward', correlationId: 'ait-request', placementId: 'CONTINUE' },
  },
};
assert.equal(defaults.resolve(ait)?.platformImpressionId, 'ait-request');
assert.equal(defaults.resolve({ ...ait, ledgerEntryId: 'different-correlation' }), undefined);
assert.equal(
  defaults.resolve({
    ...ait,
    evidence: { schema: 'apps-in-toss.rewarded-ad.callback.v1', payload: { event: 'dismissed' } },
  }),
  undefined,
);

let displays = 0;
let claims = 0;
let verified = false;
const requests: unknown[] = [];
const backend: GameServicesBackendApi = {
  purchases: {
    async verifyPurchase() {
      return { verified: false, alreadyProcessed: false };
    },
  },
  adRewards: {
    async claimAdReward(request) {
      claims += 1;
      requests.push(structuredClone(request));
      return verified
        ? { granted: true, alreadyProcessed: false, ledgerEntryId: 'server-ledger' }
        : {
            granted: false,
            alreadyProcessed: false,
            disposition: 'pending',
            reason: 'PROOF_NOT_RECEIVED',
          };
    },
  },
  leaderboard: {
    async recordScore() {
      return { submitted: false, alreadyProcessed: false, ledgerEntryId: '', rank: 0 };
    },
  },
};
const gateway: PlatformGateway = {
  target: 'android',
  getCapabilities: async () => createUnsupportedCapabilities(),
  identity: { getPlayer: async () => ({ playerId: 'player' }) },
  commerce: {
    getProducts: async () => [],
    purchase: async () => ({ status: 'failed', entitlementIds: [] }),
    getEntitlements: async () => [],
  },
  ads: {
    preload: async () => {},
    showRewarded: async () => {
      displays += 1;
      return reward;
    },
  },
  leaderboard: { submitScore: async () => ({ submitted: false }), open: async () => {} },
  lifecycle: { onPause: () => () => {}, onResume: () => () => {} },
  storage: { load: async () => null, save: async () => {} },
};
const input = {
  gateway,
  backend,
  target: 'android' as const,
  playerId: 'player',
  rewardEvidenceRegistry: registry,
  now: () => '2026-10-08T00:00:00.000Z',
};
const operation = { placementId: 'CONTINUE', idempotencyKey: 'new-provider-key' };
assert.equal((await createGameServicesClient(input).claimRewardedAd(operation)).status, 'pending');
assert.equal(claims, 1, 'a registered new schema reaches the backend without a provider branch');
assert.deepEqual(requests[0], {
  target: 'android',
  playerId: 'player',
  placementId: 'CONTINUE',
  platformImpressionId: 'native-impression',
  idempotencyKey: operation.idempotencyKey,
  completedAt: '2026-10-08T00:00:00.000Z',
  evidence,
});
for (const bad of [
  { schema: 'unknown', payload: {} },
  { schema, payload: { token: 'wrong' } },
]) {
  reward = { status: 'completed', rewardGranted: true, evidence: bad };
  assert.equal(
    (await createGameServicesClient(input).claimRewardedAd(operation)).status,
    'rejected',
  );
}
assert.equal(claims, 1, 'SDK reward flags cannot bypass an explicit registry');

const provider = toAdAdapter({
  id: 'new-provider',
  protocol: adProtocol,
  protocolVersion: adProtocolVersion,
  rewardSignal: 'immediate',
  getAvailability: async () => ({ state: 'available' }),
  preload: async () => ({ status: 'deferred' }),
  subscribe: () => () => {},
  show: async (request) => ({
    providerId: 'new-provider',
    invocationId: request.invocationId,
    format: request.format,
    outcome: 'shown',
    presentation: 'closed',
    eligibility: 'eligible',
    evidence,
  }),
});
assert.ok(provider.provider);
const versionedGateway = { ...gateway, ads: { ...gateway.ads, provider: provider.provider } };
reward = { status: 'completed', rewardGranted: true, evidence: { schema: 'unregistered', payload: {} } };
assert.equal(
  (await createGameServicesClient({ gateway: versionedGateway, backend, target: 'android', playerId: 'player' }).claimRewardedAd(operation)).status,
  'rejected',
);
assert.equal(claims, 1, 'v2 consumers never take the legacy flag fallback');
reward = { status: 'completed', rewardGranted: false, evidence };
const rejectingBackend = createGameServicesBackend({
  catalog: { version: 'test', products: [] },
  placements: {
    version: 'test',
    placements: [
      {
        id: 'CONTINUE',
        type: 'rewarded',
        reward: { type: 'currency', currency: 'coin', amount: 1 },
        frequencyCap: { cooldownSeconds: 0 },
        platformPlacementIds: { android: 'native-placement' },
      },
    ],
  },
});
assert.equal(
  (await createGameServicesClient({ ...input, backend: rejectingBackend }).claimRewardedAd(operation)).status,
  'rejected',
  'client registration cannot install a trusted server verifier',
);

const records = new Map<string, MonetizationOperationRecord>();
const operationStore: MonetizationOperationStore = {
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
  async replace(revision, record) {
    assert.equal(records.get(record.key)?.revision, revision);
    records.set(record.key, structuredClone(record));
  },
  async listRecoverable(playerId) {
    return [...records.values()].filter((record) => record.playerId === playerId && record.result?.status === 'pending').map(
      (record) => structuredClone(record),
    );
  },
};
const runtime = createGameServicesRuntime({
  ...input,
  authorityMode: 'non-production',
  allowLocalBackend: true,
  localBackend: backend,
  operationStore,
});
assert.equal(
  (await runtime.client?.claimRewardedAd(operation))?.status,
  'pending',
  'runtime forwards the registry to durable client',
);
const displaysBeforeRecovery = displays;
const claimsBeforeRecovery = claims;
const emptyRegistry = createClientRewardEvidenceRegistry([]);
const missing = createRecoverableMonetizationClient({
  ...input,
  operationStore,
  rewardEvidenceRegistry: emptyRegistry,
});
assert.equal((await missing.reconcile())[0]?.status, 'action-required');
assert.equal(claims, claimsBeforeRecovery);
assert.equal(displays, displaysBeforeRecovery);
const changed = createRecoverableMonetizationClient({
  ...input,
  operationStore,
  rewardEvidenceRegistry: createClientRewardEvidenceRegistry([
    { schema, normalize: () => ({ platformImpressionId: 'changed' }) },
  ]),
});
assert.equal((await changed.reconcile())[0]?.status, 'action-required');
const saved = [...records.values()][0];
assert.ok(saved?.kind === 'rewarded-ad' && saved.request !== undefined);
records.set(saved.key, {
  ...saved,
  request: { ...saved.request, evidence: { schema: 'tampered', payload: {} } },
});
assert.equal(
  (await createRecoverableMonetizationClient({ ...input, operationStore }).reconcile())[0]?.status,
  'action-required',
);
assert.equal(claims, claimsBeforeRecovery, 'recovery cannot dispatch changed evidence');
records.set(saved.key, saved);
verified = true;
const recovered = createGameServicesRuntime({
  ...input,
  authorityMode: 'non-production',
  allowLocalBackend: true,
  localBackend: backend,
  operationStore,
});
assert.equal((await recovered.monetizationRecovery?.reconcile())?.[0]?.status, 'granted');
assert.equal((await recovered.client?.claimRewardedAd(operation))?.ledgerEntryId, 'server-ledger');
assert.equal(
  displays,
  displaysBeforeRecovery,
  'recovery and repeat callers never reopen advertising',
);
assert.equal(claims, claimsBeforeRecovery + 1);
verified = false;
const versionedInput = { ...input, gateway: versionedGateway, operationStore };
const versionedOperation = { ...operation, idempotencyKey: 'persist-provider-identity' };
assert.equal(
  (await createRecoverableMonetizationClient(versionedInput).claimRewardedAd(versionedOperation)).status,
  'pending',
);
assert.equal((requests.at(-1) as { providerId?: string }).providerId, 'new-provider');
const beforeChangedProvider = { displays, claims };
const changedProvider = {
  ...versionedGateway,
  ads: { ...versionedGateway.ads, provider: { ...provider.provider, id: 'another-provider' } },
};
assert.equal(
  (await createRecoverableMonetizationClient({ ...versionedInput, gateway: changedProvider }).reconcile())[0]?.status,
  'action-required',
);
assert.deepEqual(
  { displays, claims },
  beforeChangedProvider,
  'a recorded provider cannot be replaced during pending recovery',
);
console.log('Registered client evidence, backend authority, and durable reward recovery passed.');

/// <reference types="node" />
import assert from 'node:assert/strict';

import type { AdPlacements } from '@mpgd/catalog';

import {
  createAdRewardEvidenceVerifierRegistry,
  type AdRewardVerifierRegistration,
} from './ad-reward-verifier-registry.js';
import {
  createRejectingGameServicesEvidenceVerifier,
  type VerifyAdRewardEvidenceInput,
} from './evidence-verification.js';
import { createGameServicesBackend, createInMemoryGameServicesStore } from './server.js';
import {
  assertClaimAdRewardRequest,
  type ClaimAdRewardRequest,
  type EntitlementLedgerPayload,
} from './types.js';

const now = '2026-10-09T00:00:00.000Z';
const schema = 'game-provider.reward.v1';
const placements: AdPlacements = {
  version: 'test',
  placements: [
    {
      id: 'CONTINUE',
      type: 'rewarded',
      reward: { type: 'currency', currency: 'coin', amount: 1 },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { 'browser-stage': 'native-placement' },
    },
  ],
};
let verifications = 0;
let available = false;
const registration: AdRewardVerifierRegistration = {
  providerId: 'game-provider',
  schema,
  bindings: [{ target: 'browser', deploymentTarget: 'browser-stage' }],
  async verify({ request, signal }) {
    verifications += 1;
    assert.equal(signal.aborted, false);
    const proof = request.evidence?.payload;
    if (proof?.player !== request.playerId || proof.placement !== request.placementId || proof.invocation !== request.idempotencyKey || proof.provider !== 'game-provider') {
      return { status: 'rejected', reason: 'AUTHORITATIVE_BINDING_MISMATCH' };
    }
    if (!available) {
      return { status: 'pending', reason: 'PROOF_PENDING' };
    }
    return {
      status: 'verified',
      verificationId: 'provider:verified-impression',
      platformEvidenceId: 'native-impression',
      verifiedAt: now,
    };
  },
};
const registry = createAdRewardEvidenceVerifierRegistry([registration]);
const request: ClaimAdRewardRequest = {
  target: 'browser',
  deploymentTarget: 'browser-stage',
  playerId: 'player',
  placementId: 'CONTINUE',
  idempotencyKey: 'invocation',
  completedAt: now,
  evidence: {
    schema,
    payload: {
      player: 'player',
      placement: 'CONTINUE',
      invocation: 'invocation',
      provider: 'game-provider',
    },
  },
};
const placement = placements.placements[0];
assert.ok(placement);
const verificationInput: VerifyAdRewardEvidenceInput = {
  request,
  placement,
  signal: new AbortController().signal,
  timeoutMs: 1000,
};
const { evidence: omittedEvidence, ...withoutEvidence } = request;
void omittedEvidence;
for (const changed of [
  { ...request, evidence: { schema: 'unknown-provider', payload: {} } },
  withoutEvidence,
  { ...request, target: 'android' as const },
  { ...request, deploymentTarget: 'browser-other' },
]) {
  assert.equal(
    (await registry.verifyAdReward({ ...verificationInput, request: changed })).status,
    'rejected',
  );
}
assert.equal(
  verifications,
  0,
  'unregistered schema/target/deployment cannot dispatch trusted proof verification',
);
assert.equal(
  (await registry.verifyAdReward({ ...verificationInput, request: { ...request, providerId: 'foreign-provider' } })).status,
  'rejected',
);
assert.equal(verifications, 0, 'a reported provider identity must match the schema owner');
const malformedPayloads: readonly unknown[] = ['invalid-payload', null, { nested: {} }];
for (const malformed of malformedPayloads) {
  const invalidRegistry = createAdRewardEvidenceVerifierRegistry([{
    ...registration,
    verify: async () => ({
      status: 'verified', verificationId: 'invalid-proof', verifiedAt: now,
      // Simulate malformed data received from a remote proof-verifier binding.
      payload: malformed as EntitlementLedgerPayload,
    }),
  }]);
  assert.equal((await invalidRegistry.verifyAdReward(verificationInput)).status, 'rejected');
}
assert.throws(
  () => createAdRewardEvidenceVerifierRegistry([registration, registration]),
  /Duplicate/,
);
assert.throws(
  () =>
    createAdRewardEvidenceVerifierRegistry([
      registration,
      { ...registration, providerId: 'other-provider' },
    ]),
  /another provider/,
);
assert.throws(
  () => createAdRewardEvidenceVerifierRegistry([{ ...registration, bindings: [] }]),
  /Invalid/,
);
assert.throws(
  () =>
    createAdRewardEvidenceVerifierRegistry([
      { ...registration, bindings: [{ target: 'browser', deploymentTarget: '../escape' }] },
    ]),
  /deployment/,
);
const mutableBindings = [{ target: 'browser' as const, deploymentTarget: 'browser-stage' }];
const immutable = createAdRewardEvidenceVerifierRegistry([
  { ...registration, bindings: mutableBindings },
]);
const mutableBinding = mutableBindings[0];
assert.ok(mutableBinding);
mutableBinding.deploymentTarget = 'browser-other';
assert.equal(
  (await immutable.verifyAdReward(verificationInput)).status,
  'pending',
  'registered binding keys do not change through caller mutation',
);
for (const target of [
  'browser',
  'reddit',
  'microsoft-store',
  'android',
  'ios',
  'ait',
  'verse8',
] as const) {
  assert.doesNotThrow(() => assertClaimAdRewardRequest({ ...request, target }));
}
assert.throws(() => {
  // @ts-expect-error Intentionally invalid wire input exercises runtime target validation.
  assertClaimAdRewardRequest({ ...request, target: 'invented' });
}, /target/);

const store = createInMemoryGameServicesStore();
const backend = createGameServicesBackend({
  catalog: { version: 'test', products: [] },
  placements,
  store,
  deploymentTargetBindings: { browser: 'browser-stage' },
  now: () => now,
  evidenceVerifier: {
    ...createRejectingGameServicesEvidenceVerifier(),
    verifyAdReward: registry.verifyAdReward,
  },
});
assert.equal((await backend.adRewards.claimAdReward(request)).disposition, 'pending');
assert.equal(
  (await store.listEntitlementTransactions()).length,
  0,
  'registration and pending proof cannot write a grant',
);
for (const field of ['player', 'placement', 'invocation', 'provider'] as const) {
  assert.equal(
    (await backend.adRewards.claimAdReward({ ...request, evidence: { schema, payload: { ...request.evidence?.payload, [field]: 'foreign' } } })).granted,
    false,
  );
}
available = true;
const grant = await backend.adRewards.claimAdReward(request);
assert.equal(grant.granted, true);
assert.equal((await backend.adRewards.claimAdReward(request)).ledgerEntryId, grant.ledgerEntryId);
const replay = await backend.adRewards.claimAdReward({
  ...request,
  idempotencyKey: 'another-key',
  evidence: { schema, payload: { ...request.evidence?.payload, invocation: 'another-key' } },
});
assert.equal(replay.granted, false);
assert.equal(replay.reason, 'EVIDENCE_ALREADY_PROCESSED');
assert.equal((await store.listEntitlementTransactions()).length, 1);
assert.equal((await store.listEntitlementTransactions())[0]?.payload.adProviderId, 'game-provider');
console.log(
  'Independent server advertising registrations and authoritative impression dedup passed.',
);

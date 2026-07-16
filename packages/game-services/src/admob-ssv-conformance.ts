import type { AdPlacementEntry, AdPlacements } from '@mpgd/catalog';

import {
  createAdMobSsvEvidenceVerifier,
  importAdMobSsvPublicKey,
  type AdMobSsvCallbackSource,
  type AdMobSsvPublicKeySource,
} from './admob-ssv.js';
import type {
  GameServicesEvidenceVerifier,
  VerifyAdRewardEvidenceInput,
} from './evidence-verification';
import type { ClaimAdRewardRequest } from './types';

export const adMobSsvConformanceChecks = [
  'verified callback reaches the ledger',
  'missing callback remains pending',
  'tampered signature fails closed',
  'raw signed query bytes reject equivalent percent-encoding',
  'missing and duplicate signed fields fail closed',
  'unknown key fails closed',
  'signed identity mismatch fails closed',
  'timestamp age and future-skew boundaries fail closed',
  'transaction replay preserves one authority identity',
] as const;

export interface AdMobSsvConformanceReport {
  readonly checks: readonly string[];
  readonly passed: true;
}

export interface RunAdMobSsvConformanceInput {
  readonly subtle?: SubtleCrypto;
}

export interface AdMobSsvConformanceFixture {
  readonly verifier: GameServicesEvidenceVerifier;
  readonly placements: AdPlacements;
  readonly firstRequest: ClaimAdRewardRequest;
  readonly replayRequest: ClaimAdRewardRequest;
}

const fixtureTimestampMs = 1_784_160_000_000;
const fixtureKeyId = '1234567890';
const fixturePublicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvYEdl5vbYIy+udYlF2Qfw+LLwZs09vcw9WQ3iKFHLiPRCyic1goA3pDBiydEIcVsrnqHFdCmKQBcPMlTVnqkqA==';
const firstFixtureSignature = 'MEUCIGhBVO1Bw89dklPTxgevCJM0YJi43YuSfCGaCNMVWf4-AiEAzPVTSggVLJSSSl0R3QdSf6GqoEB9snN94cIg-bTorM8';
const secondFixtureSignature = 'MEYCIQDXBqcZQkMOPagwxaDgkwii1S4TUcfC5Tak9CJj8RTfEQIhAKYZm_vbWG1EOto6yq8jAkx8mxLpGzipJIzkxfpHghDT';

const placement = {
  id: 'CONTINUE_AFTER_FAIL',
  type: 'rewarded',
  reward: {
    type: 'continue',
    amount: 1,
  },
  frequencyCap: {
    cooldownSeconds: 60,
    maxPerSession: 3,
  },
  platformPlacementIds: {
    android: 'reward_continue',
    ios: 'reward_continue',
  },
} as const satisfies AdPlacementEntry;

const placements = {
  version: 'admob-ssv-conformance',
  placements: [placement],
} as const satisfies AdPlacements;

export async function createAdMobSsvConformanceFixture(
  input: RunAdMobSsvConformanceInput = {},
): Promise<AdMobSsvConformanceFixture> {
  const subtle = input.subtle ?? readGlobalSubtleCrypto();
  const publicKey = await importAdMobSsvPublicKey(fixturePublicKey, subtle);
  const callbacks = new Map([
    ['reward-1', fixtureCallback('reward-1', firstFixtureSignature)],
    ['reward-2', fixtureCallback('reward-2', secondFixtureSignature)],
  ]);

  return {
    verifier: createAdMobSsvEvidenceVerifier({
      callbackSource: mapCallbackSource(callbacks),
      publicKeySource: fixedPublicKeySource(publicKey),
      subtle,
      now: () => fixtureTimestampMs + 1_000,
    }),
    placements,
    firstRequest: rewardRequest('reward-1'),
    replayRequest: rewardRequest('reward-2'),
  };
}

export async function runAdMobSsvConformance(
  input: RunAdMobSsvConformanceInput = {},
): Promise<AdMobSsvConformanceReport> {
  const subtle = input.subtle ?? readGlobalSubtleCrypto();
  const publicKey = await importAdMobSsvPublicKey(fixturePublicKey, subtle);
  const callbacks = new Map([
    ['reward-1', fixtureCallback('reward-1', firstFixtureSignature)],
    ['reward-2', fixtureCallback('reward-2', secondFixtureSignature)],
  ]);
  const publicKeySource = fixedPublicKeySource(publicKey);
  const callbackSource = mapCallbackSource(callbacks);
  const verifier = createAdMobSsvEvidenceVerifier({
    callbackSource,
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  });
  const firstRequest = rewardRequest('reward-1');
  const firstDecision = await verifier.verifyAdReward(verificationInput(firstRequest));

  assert(
    firstDecision.status === 'verified'
      && firstDecision.verificationId
        === 'admob:ssv:18fa792de1bca816048293fc71035638'
      && firstDecision.verifiedAt === '2026-07-16T00:00:00.000Z',
    'a verified callback must emit the signed transaction authority identity',
  );

  const pending = await createAdMobSsvEvidenceVerifier({
    callbackSource: mapCallbackSource(new Map()),
    publicKeySource,
    subtle,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(pending, 'pending', 'ADMOB_SSV_EVIDENCE_PENDING');

  const tamperedCallback = fixtureCallback(
    'reward-1',
    firstFixtureSignature.replace('bTorM8', 'bTorN8'),
  );
  const tampered = await createAdMobSsvEvidenceVerifier({
    callbackSource: fixedCallbackSource(tamperedCallback),
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(tampered, 'rejected', 'ADMOB_SSV_SIGNATURE_INVALID');

  const equivalentPercentEncoding = await createAdMobSsvEvidenceVerifier({
    callbackSource: fixedCallbackSource(
      fixtureCallback('reward-1', firstFixtureSignature).replace('%7B', '%7b'),
    ),
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(equivalentPercentEncoding, 'rejected', 'ADMOB_SSV_SIGNATURE_INVALID');

  const validCallback = fixtureCallback('reward-1', firstFixtureSignature);
  const duplicateSignedField = await createAdMobSsvEvidenceVerifier({
    callbackSource: fixedCallbackSource(
      validCallback.replace(
        '&signature=',
        '&user_id=player-1&signature=',
      ),
    ),
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(duplicateSignedField, 'rejected', 'ADMOB_SSV_CALLBACK_INVALID');

  const missingSignedField = await createAdMobSsvEvidenceVerifier({
    callbackSource: fixedCallbackSource(
      validCallback.replace('&user_id=player-1', ''),
    ),
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(missingSignedField, 'rejected', 'ADMOB_SSV_CALLBACK_INVALID');

  const unknownKey = await createAdMobSsvEvidenceVerifier({
    callbackSource: fixedCallbackSource(
      fixtureCallback('reward-1', firstFixtureSignature).replace(
        `key_id=${fixtureKeyId}`,
        'key_id=9999999999',
      ),
    ),
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 1_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(unknownKey, 'rejected', 'ADMOB_SSV_KEY_UNAVAILABLE');

  const identityMismatch = await verifier.verifyAdReward(
    verificationInput({
      ...firstRequest,
      playerId: 'different-player',
    }),
  );
  assertDecision(identityMismatch, 'rejected', 'ADMOB_SSV_USER_MISMATCH');

  const expired = await createAdMobSsvEvidenceVerifier({
    callbackSource,
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 86_400_001,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(expired, 'rejected', 'ADMOB_SSV_CALLBACK_EXPIRED');

  const future = await createAdMobSsvEvidenceVerifier({
    callbackSource,
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs - 300_001,
  }).verifyAdReward(verificationInput(firstRequest));
  assertDecision(future, 'rejected', 'ADMOB_SSV_TIMESTAMP_IN_FUTURE');

  const ageBoundary = await createAdMobSsvEvidenceVerifier({
    callbackSource,
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs + 86_400_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assert(ageBoundary.status === 'verified', 'the maximum callback age boundary must remain valid');

  const futureSkewBoundary = await createAdMobSsvEvidenceVerifier({
    callbackSource,
    publicKeySource,
    subtle,
    now: () => fixtureTimestampMs - 300_000,
  }).verifyAdReward(verificationInput(firstRequest));
  assert(
    futureSkewBoundary.status === 'verified',
    'the maximum future skew boundary must remain valid',
  );

  const replayedDecision = await verifier.verifyAdReward(
    verificationInput(rewardRequest('reward-2')),
  );
  assert(
    replayedDecision.status === 'verified'
      && firstDecision.status === 'verified'
      && replayedDecision.verificationId === firstDecision.verificationId,
    'a signed transaction replay must preserve one ledger authority identity',
  );

  return {
    checks: adMobSsvConformanceChecks,
    passed: true,
  };
}

function verificationInput(request: ClaimAdRewardRequest): VerifyAdRewardEvidenceInput {
  return {
    request,
    placement,
    platformPlacementId: 'reward_continue',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

function rewardRequest(idempotencyKey: string): ClaimAdRewardRequest {
  return {
    target: 'android',
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey,
    completedAt: '2026-07-16T00:00:01.000Z',
  };
}

function fixtureCallback(idempotencyKey: string, signature: string): string {
  const customData = encodeURIComponent(
    JSON.stringify({
      schema: 'mpgd.admob.ssv.binding.v1',
      playerId: 'player-1',
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey,
    }),
  );
  const query = [
    'ad_network=5450213213286189855',
    'ad_unit=reward_continue',
    `custom_data=${customData}`,
    'reward_amount=1',
    'reward_item=continue',
    `timestamp=${String(fixtureTimestampMs)}`,
    'transaction_id=18fa792de1bca816048293fc71035638',
    'user_id=player-1',
  ].join('&');

  return `https://game.example.test/admob/ssv?${query}&signature=${signature}&key_id=${fixtureKeyId}`;
}

function mapCallbackSource(callbacks: ReadonlyMap<string, string>): AdMobSsvCallbackSource {
  return {
    async findCallback({ request }) {
      return callbacks.get(request.idempotencyKey);
    },
  };
}

function fixedCallbackSource(callback: string): AdMobSsvCallbackSource {
  return {
    async findCallback() {
      return callback;
    },
  };
}

function fixedPublicKeySource(publicKey: CryptoKey): AdMobSsvPublicKeySource {
  return {
    async getPublicKey({ keyId }) {
      return keyId === fixtureKeyId ? publicKey : undefined;
    },
  };
}

function assertDecision(
  decision: { readonly status: string; readonly reason?: string },
  status: string,
  reason: string,
): void {
  assert(
    decision.status === status && decision.reason === reason,
    `expected ${status}/${reason}, received ${decision.status}/${String(decision.reason)}`,
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`AdMob SSV conformance failed: ${message}.`);
  }
}

function readGlobalSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;

  if (subtle === undefined) {
    throw new Error('AdMob SSV conformance requires Web Crypto SubtleCrypto.');
  }

  return subtle;
}

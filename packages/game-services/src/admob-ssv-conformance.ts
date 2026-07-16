import type { AdPlacementEntry, AdPlacements } from '@mpgd/catalog';

import {
  createAdMobSsvEvidenceVerifier,
  importAdMobSsvPublicKey,
  type AdMobSsvCallbackSource,
  type AdMobSsvPublicKey,
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
  'AdMob-decoded signed query bytes accept equivalent percent-encoding',
  'missing and duplicate signed fields fail closed',
  'unknown key fails closed',
  'secp256k1 key feed entries verify',
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
const fixturePublicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvYnh4p45wAsdENipvmqwXzvdNaCgRqx2IvxoYI8kiummEYytzHIhL738YLr3vs5vG/A8xY8QiCLDqVV2c5sUZw==';
const firstFixtureSignature = 'MEYCIQDR1_VmQ4xw4WHff8KGDgv4insP7p5VAw8MhP5mZTFTgAIhAJ2Ejy5MU75UxeAxFqdLzvJwzL43qXl3PwuHMGYbjaiR';
const secondFixtureSignature = 'MEYCIQCq2WuuqIuZmykTaoF0fCZYgLmaYS8fdqNosnuK7UTDyQIhAJRNgIDOqFFvMGboT37xjjynNi8sYlI5_l4y-qUmQeR4';
const secp256k1FixtureKeyId = '3901585526';
const secp256k1FixturePublicKey = 'MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEYWHOBDbohSMvoXvGOhnElOsG6JzFP3K3dbpoJqOF7xzRwM0FGLLSwIvECbFxctV5pcq7JVAut5Imaa75p+lcKw==';
const secp256k1FixtureSignature = 'MEYCIQDXWRwz4J2pZbcRcQJyNFI3cwQDeC5aulegoedKeJ9EcwIhAJnkRWFOzL4KD2hyWRdmSp3lYGPcrN_yPYyM2nfDt4Of';
const fixtureTransactionId = '18fa792de1bca816048293fc71035638';
const secp256k1FixtureTransactionId = '28fa792de1bca816048293fc71035639';

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
    android: 'ca-app-pub-test/reward_continue',
    ios: 'ca-app-pub-test/reward_continue',
  },
} as const satisfies AdPlacementEntry;

const placements = {
  version: 'admob-ssv-conformance',
  placements: [placement],
} as const satisfies AdPlacements;

interface AdMobSsvConformanceContext {
  readonly callbackSource: AdMobSsvCallbackSource;
  readonly publicKeySource: AdMobSsvPublicKeySource;
  readonly subtle: SubtleCrypto;
  readonly verifier: GameServicesEvidenceVerifier;
}

interface CreateAdMobSsvConformanceContextOptions {
  readonly includeSecp256k1Fixture: boolean;
}

async function createAdMobSsvConformanceContext(
  input: RunAdMobSsvConformanceInput,
  options: CreateAdMobSsvConformanceContextOptions,
): Promise<AdMobSsvConformanceContext> {
  const subtle = input.subtle ?? readGlobalSubtleCrypto();
  const publicKey = await importAdMobSsvPublicKey(fixturePublicKey, subtle);
  const callbacks = new Map([
    ['reward-1', fixtureCallback('reward-1', firstFixtureSignature)],
    ['reward-2', fixtureCallback('reward-2', secondFixtureSignature)],
  ]);
  const publicKeys = new Map<string, AdMobSsvPublicKey>([[fixtureKeyId, publicKey]]);

  if (options.includeSecp256k1Fixture) {
    const secp256k1PublicKey = await importAdMobSsvPublicKey(secp256k1FixturePublicKey, subtle);
    callbacks.set(
      'reward-secp',
      fixtureCallback('reward-secp', secp256k1FixtureSignature, {
        keyId: secp256k1FixtureKeyId,
        transactionId: secp256k1FixtureTransactionId,
      }),
    );
    publicKeys.set(secp256k1FixtureKeyId, secp256k1PublicKey);
  }
  const callbackSource = mapCallbackSource(callbacks);
  const publicKeySource = fixedPublicKeySource(publicKeys);

  return {
    callbackSource,
    publicKeySource,
    subtle,
    verifier: createAdMobSsvEvidenceVerifier({
      callbackSource,
      publicKeySource,
      subtle,
      now: () => fixtureTimestampMs + 1_000,
    }),
  };
}

export async function createAdMobSsvConformanceFixture(
  input: RunAdMobSsvConformanceInput = {},
): Promise<AdMobSsvConformanceFixture> {
  const { verifier } = await createAdMobSsvConformanceContext(input, {
    includeSecp256k1Fixture: false,
  });

  return {
    verifier,
    placements,
    firstRequest: rewardRequest('reward-1'),
    replayRequest: rewardRequest('reward-2'),
  };
}

export async function runAdMobSsvConformance(
  input: RunAdMobSsvConformanceInput = {},
): Promise<AdMobSsvConformanceReport> {
  const {
    callbackSource,
    publicKeySource,
    subtle,
    verifier,
  } = await createAdMobSsvConformanceContext(input, {
    includeSecp256k1Fixture: true,
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

  const tamperedCallback = fixtureCallback('reward-1', `${firstFixtureSignature.slice(0, -1)}S`);
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
  assert(
    equivalentPercentEncoding.status === 'verified',
    'equivalent percent-encoding must verify against AdMob-decoded query bytes',
  );

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

  const secp256k1Decision = await verifier.verifyAdReward(
    verificationInput(rewardRequest('reward-secp')),
  );
  assert(
    secp256k1Decision.status === 'verified'
      && secp256k1Decision.verificationId
        === `admob:ssv:${secp256k1FixtureTransactionId}`,
    'a signed secp256k1 callback must verify when the key feed rotates curves',
  );

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
    platformPlacementId: placement.platformPlacementIds.android,
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

function fixtureCallback(
  idempotencyKey: string,
  signature: string,
  input: {
    readonly keyId?: string;
    readonly transactionId?: string;
  } = {},
): string {
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
    `transaction_id=${input.transactionId ?? fixtureTransactionId}`,
    'user_id=player-1',
  ].join('&');

  return `https://game.example.test/admob/ssv?${query}&signature=${signature}&key_id=${input.keyId ?? fixtureKeyId}`;
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

function fixedPublicKeySource(
  publicKeys: ReadonlyMap<string, AdMobSsvPublicKey>,
): AdMobSsvPublicKeySource {
  return {
    async getPublicKey({ keyId }) {
      return publicKeys.get(keyId);
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

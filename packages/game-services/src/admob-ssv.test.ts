import {
  createAdMobSsvConformanceFixture,
  runAdMobSsvConformance,
} from './admob-ssv-conformance.js';
import {
  createAdMobSsvEvidenceVerifier,
  decodeAdMobSsvCustomData,
  encodeAdMobSsvCustomData,
} from './admob-ssv.js';
import { createGameServicesBackend } from './server.js';

const binding = {
  playerId: 'player-1',
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'reward-1',
};

assertEqual(
  decodeAdMobSsvCustomData(encodeAdMobSsvCustomData(binding)),
  binding,
  'custom data bindings should round-trip without credentials',
);
assertEqual(
  decodeAdMobSsvCustomData('{"schema":"different"}'),
  undefined,
  'unknown custom data schemas should fail closed',
);

const canonicalCustomData = encodeAdMobSsvCustomData(binding);
assertEqual(
  decodeAdMobSsvCustomData(
    canonicalCustomData.replace(
      '"playerId":"player-1"',
      '"playerId":"different-player","playerId":"player-1"',
    ),
  ),
  undefined,
  'duplicate custom data fields should fail closed',
);
const additionalCustomData = `${canonicalCustomData.slice(0, -1)},"unexpected":true}`;
assertEqual(
  decodeAdMobSsvCustomData(additionalCustomData),
  undefined,
  'additional custom data fields should fail closed',
);

const keyFailureVerifier = createAdMobSsvEvidenceVerifier({
  callbackSource: {
    async findCallback() {
      return 'https://game.example.test/admob/ssv?ad_network=1&ad_unit=reward_continue&custom_data=%7B%7D&reward_amount=1&reward_item=continue&timestamp=1784160000000&transaction_id=deadbeef&user_id=player-1&signature=MEUCIQAA&key_id=1';
    },
  },
  publicKeySource: {
    async getPublicKey() {
      throw new Error('key service unavailable');
    },
  },
  now: () => 1_784_160_001_000,
});
const keyFailure = await keyFailureVerifier.verifyAdReward({
  request: {
    target: 'android',
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'reward-1',
    completedAt: '2026-07-16T00:00:01.000Z',
  },
  placement: {
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
    },
  },
  platformPlacementId: 'reward_continue',
  signal: new AbortController().signal,
  timeoutMs: 10_000,
});

assertEqual(
  keyFailure,
  {
    status: 'rejected',
    reason: 'ADMOB_SSV_KEY_ERROR',
  },
  'key provider failures should return a stable fail-closed decision',
);

const report = await runAdMobSsvConformance();
assert(report.passed, 'AdMob SSV conformance should pass');
assertEqual(report.checks.length, 9, 'AdMob SSV conformance should cover every security case');

const ledgerFixture = await createAdMobSsvConformanceFixture();
const backend = createGameServicesBackend({
  catalog: {
    version: 'admob-ssv-ledger-test',
    products: [],
  },
  placements: ledgerFixture.placements,
  evidenceVerifier: ledgerFixture.verifier,
  now: () => '2026-07-16T00:00:02.000Z',
});
const firstGrant = await backend.adRewards.claimAdReward(ledgerFixture.firstRequest);
const replayedGrant = await backend.adRewards.claimAdReward(ledgerFixture.replayRequest);

assert(
  firstGrant.granted && !firstGrant.alreadyProcessed,
  'verified SSV evidence should reach one authoritative ledger grant',
);
assertEqual(
  replayedGrant,
  {
    granted: false,
    alreadyProcessed: false,
    reason: 'EVIDENCE_ALREADY_PROCESSED',
  },
  'the ledger should fail closed when the signed transaction is replayed under a new claim',
);

console.log(`admob ssv tests passed (${String(report.checks.length)} conformance checks)`);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

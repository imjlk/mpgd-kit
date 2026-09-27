import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { encodeAdMobSsvCustomData } from '@mpgd/game-services';
import { Miniflare } from 'miniflare';

import { createD1AdMobSsvCallbackStore } from './admobSsvD1.js';
import { createWorkerFetchHandler, createWorkerService } from './handler.js';
import {
  createAdMobSsvCallbackFetchHandler,
  createD1AdMobSsvEvidenceVerifier,
} from './admobSsvHandler.js';

const timestamp = Date.now();
const placements = {
  version: 'admob-test',
  placements: [{
    id: 'CONTINUE_AFTER_FAIL',
    type: 'rewarded',
    reward: { type: 'continue', amount: 1 },
    frequencyCap: { cooldownSeconds: 60, maxPerSession: 3 },
    platformPlacementIds: { android: 'reward_continue' },
  }],
} as const;
const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'admob-ssv-intake' },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  for (const name of [
    '0001_game_services.sql',
    '0004_entitlement_evidence.sql',
    '0005_admob_ssv_callbacks.sql',
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await db.exec(toD1ExecScript(migration));
  }
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicKeySpki = Buffer.from(await crypto.subtle.exportKey('spki', keyPair.publicKey))
    .toString('base64');
  let currentKeys = [{ keyId: 1, base64: publicKeySpki }];
  const fetcher = (async () => Response.json({ keys: currentKeys })) as typeof fetch;
  const config = {
    db,
    placements,
    adUnits: { android: 'reward_continue' },
    fetcher,
    now: () => new Date(timestamp + 1_000),
  } as const;
  const intake = createAdMobSsvCallbackFetchHandler(config);
  const claimVerifier = createD1AdMobSsvEvidenceVerifier(config);
  const claimRequest = {
    target: 'android',
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'reward-1',
    completedAt: new Date(timestamp).toISOString(),
  } as const;
  const claimInput = {
    request: claimRequest,
    placement: placements.placements[0],
    platformPlacementId: 'reward_continue',
    signal: new AbortController().signal,
    timeoutMs: 5_000,
  };
  assert.equal((await claimVerifier.verifyAdReward(claimInput)).status, 'pending');
  const unavailableStore = createD1AdMobSsvEvidenceVerifier({
    ...config,
    db: { prepare() { throw new Error('D1 unavailable'); } } as unknown as D1Database,
  });
  await assert.rejects(unavailableStore.verifyAdReward(claimInput), /lookup failed/u);
  const callbackUrl = await signedCallback(keyPair.privateKey, 'reward-1', 'aabbccdd');
  assert.equal((await intake(new Request(callbackUrl)))?.status, 200);
  assert.equal((await intake(new Request(callbackUrl)))?.status, 200);
  const stored = await createD1AdMobSsvCallbackStore(db).find(claimRequest);
  assert.equal(stored?.transactionId, 'aabbccdd');
  assert.equal(stored?.acceptedAdUnit, 'reward_continue');
  const verified = await claimVerifier.verifyAdReward(claimInput);
  assert.equal(verified.status, 'verified');
  if (verified.status === 'verified') {
    assert.equal(verified.verificationId, 'admob:ssv:aabbccdd');
  }
  currentKeys = [];
  assert.equal((await claimVerifier.verifyAdReward(claimInput)).status, 'verified');
  assert.equal((await intake(new Request(callbackUrl)))?.status, 200);
  const workerEnv = {
    DB: db,
    MPGD_STORE: 'd1',
    MPGD_ADMOB_SSV_ANDROID_AD_UNIT: 'rotated_ad_unit',
  } as const;
  assert.throws(() => createWorkerFetchHandler({
    MPGD_STORE: 'memory',
    MPGD_ADMOB_SSV_ANDROID_AD_UNIT: 'reward_continue',
  }), /requires MPGD_STORE=d1/u);
  let purchaseBindingCalls = 0;
  let rewardBindingCalls = 0;
  const composedWorker = createWorkerService({
    ...workerEnv,
    GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: {
      async verifyPurchase() {
        purchaseBindingCalls += 1;
        return { status: 'rejected', reason: 'PURCHASE_TEST' } as const;
      },
      async verifyAdReward() {
        rewardBindingCalls += 1;
        return { status: 'rejected', reason: 'REWARD_BINDING_SHOULD_NOT_RUN' } as const;
      },
    },
  });
  await composedWorker.verifyPurchase({
    target: 'android',
    playerId: 'purchase-player',
    productId: 'COINS_100',
    platformTransactionId: 'purchase-transaction',
    idempotencyKey: 'purchase-binding-test',
    purchasedAt: new Date(timestamp).toISOString(),
  });
  assert.equal(purchaseBindingCalls, 1);
  await composedWorker.claimAdReward({ ...claimRequest, idempotencyKey: 'pending-composed' });
  assert.equal(rewardBindingCalls, 0);
  const workerService = createWorkerService(workerEnv);
  const firstGrant = await workerService.claimAdReward(claimRequest) as {
    readonly granted: boolean;
    readonly alreadyProcessed: boolean;
  };
  assert.equal(firstGrant.granted, true, JSON.stringify(firstGrant));
  assert.equal(firstGrant.alreadyProcessed, false);
  const retriedGrant = await workerService.claimAdReward(claimRequest) as {
    readonly granted: boolean;
    readonly alreadyProcessed: boolean;
  };
  assert.equal(retriedGrant.granted, true);
  assert.equal(retriedGrant.alreadyProcessed, true);
  let androidBindingCalls = 0;
  const mixedWorker = createWorkerService({
    DB: db,
    MPGD_STORE: 'd1',
    MPGD_ADMOB_SSV_IOS_AD_UNIT: 'reward_continue',
    GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: {
      async verifyPurchase() {
        return { status: 'rejected', reason: 'UNSUPPORTED' } as const;
      },
      async verifyAdReward() {
        androidBindingCalls += 1;
        return {
          status: 'verified',
          verificationId: 'test:android-separate-binding',
          verifiedAt: new Date(timestamp).toISOString(),
        } as const;
      },
    },
  });
  const mixedClaim = await mixedWorker.claimAdReward({
    ...claimRequest,
    playerId: 'player-2',
    idempotencyKey: 'reward-other',
  }) as { readonly granted: boolean };
  assert.equal(mixedClaim.granted, true);
  assert.equal(androidBindingCalls, 1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    currentKeys = [{ keyId: 1, base64: publicKeySpki }];
    const workerFetch = createWorkerFetchHandler(workerEnv);
    assert.equal((await workerFetch(new Request(callbackUrl))).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  currentKeys = [];
  const tampered = callbackUrl.replace('reward_amount=1', 'reward_amount=2');
  assert.equal((await intake(new Request(tampered)))?.status, 503);
  currentKeys = [{ keyId: 1, base64: publicKeySpki }];
  assert.equal((await intake(new Request(tampered)))?.status, 400);
  const duplicateTransaction = await signedCallback(keyPair.privateKey, 'reward-2', 'aabbccdd');
  assert.equal((await intake(new Request(duplicateTransaction)))?.status, 409);
  const duplicateOperation = await signedCallback(keyPair.privateKey, 'reward-1', 'eeff0011');
  assert.equal((await intake(new Request(duplicateOperation)))?.status, 409);
  const oversizedBinding = await signedCallback(keyPair.privateKey, 'x'.repeat(257), 'eeff0022');
  assert.equal((await intake(new Request(oversizedBinding)))?.status, 400);
  assert.equal((await intake(new Request(callbackUrl, { method: 'POST' })))?.status, 405);
  console.info('D1 AdMob SSV intake and claim integration passed.');
} finally {
  await miniflare.dispose();
}

async function signedCallback(
  privateKey: CryptoKey,
  idempotencyKey: string,
  transactionId: string,
): Promise<string> {
  const customData = encodeURIComponent(encodeAdMobSsvCustomData({
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey,
  }));
  const query = [
    'ad_network=5450213213286189855',
    'ad_unit=reward_continue',
    `custom_data=${customData}`,
    'reward_amount=1',
    'reward_item=continue',
    `timestamp=${String(timestamp)}`,
    `transaction_id=${transactionId}`,
    'user_id=player-1',
  ].join('&');
  const signedBytes = new TextEncoder().encode(decodeURIComponent(query));
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    signedBytes,
  ));
  const signature = Buffer.from(derSignature(rawSignature)).toString('base64url');
  return `https://game.test/admob/ssv/android?${query}&signature=${signature}&key_id=1`;
}

function derSignature(raw: Uint8Array): Uint8Array {
  const first = encodeDerInteger(raw.subarray(0, 32));
  const second = encodeDerInteger(raw.subarray(32));
  const length = first.length + second.length;
  return Uint8Array.of(0x30, length, ...first, ...second);
}

function encodeDerInteger(component: Uint8Array): Uint8Array {
  let start = 0;
  while (start < component.length - 1 && component[start] === 0) {
    start += 1;
  }
  const bytes = component.subarray(start);
  const positive = (bytes[0] ?? 0) >= 0x80 ? Uint8Array.of(0, ...bytes) : bytes;
  return Uint8Array.of(0x02, positive.length, ...positive);
}

function toD1ExecScript(migration: string): string {
  return migration
    .split(/\n\s*\n/u)
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement.length > 0)
    .join('\n');
}

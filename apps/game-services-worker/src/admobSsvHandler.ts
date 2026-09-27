import type { AdPlacements } from '@mpgd/catalog';
import {
  createAdMobSsvEvidenceVerifier,
  decodeAdMobSsvCustomData,
  importAdMobSsvPublicKey,
  admobSsvMaximumBindingFieldLength,
  type GameServicesEvidenceVerifier,
} from '@mpgd/game-services';

import { createD1AdMobSsvCallbackStore, type VerifiedAdMobSsvCallback } from './admobSsvD1.js';
import { fetchAdMobSsvPublicKeySpki } from './admobSsvKeys.js';

export interface AdMobSsvWorkerConfig {
  readonly db: D1Database;
  readonly placements: AdPlacements;
  readonly adUnits: Partial<Record<'android' | 'ios', string>>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

const callbackPath = /^\/admob\/ssv\/(android|ios)$/u;
const maximumCallbackUrlLength = 8_192;

/** Google-facing intake. The existing game-services verifier checks the signed callback. */
export function createAdMobSsvCallbackFetchHandler(
  config: AdMobSsvWorkerConfig,
): (request: Request) => Promise<Response | undefined> {
  const store = createD1AdMobSsvCallbackStore(config.db);
  const now = config.now;
  return async (request) => {
    const url = new URL(request.url);
    const match = callbackPath.exec(url.pathname);
    if (match === null) {
      return undefined;
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }
    const target = match[1] as 'android' | 'ios';
    const adUnit = config.adUnits[target];
    if (adUnit === undefined || adUnit.length === 0) {
      return new Response('AdMob SSV is not configured', { status: 503 });
    }
    if (request.url.length > maximumCallbackUrlLength || url.protocol !== 'https:') {
      return new Response('Invalid callback URL', { status: 400 });
    }
    const customData = uniqueParameter(url.searchParams, 'custom_data');
    const binding = customData === undefined ? undefined : decodeAdMobSsvCustomData(customData);
    const keyId = uniqueParameter(url.searchParams, 'key_id');
    const transactionId = uniqueParameter(url.searchParams, 'transaction_id');
    if (binding === undefined || keyId === undefined || transactionId === undefined) {
      return new Response('Invalid AdMob SSV binding', { status: 400 });
    }
    if (binding.playerId.length > admobSsvMaximumBindingFieldLength
      || binding.placementId.length > admobSsvMaximumBindingFieldLength
      || binding.idempotencyKey.length > admobSsvMaximumBindingFieldLength
      || keyId.length > 32 || transactionId.length > 128) {
      return new Response('AdMob SSV binding is too large', { status: 400 });
    }
    const placement = config.placements.placements.find((entry) => {
      return entry.id === binding.placementId && entry.type === 'rewarded';
    });
    const platformPlacementId = placement?.platformPlacementIds?.[target];
    if (placement === undefined || platformPlacementId === undefined) {
      return new Response('Unknown AdMob placement', { status: 400 });
    }
    try {
      const existing = await store.find({
        target,
        playerId: binding.playerId,
        placementId: binding.placementId,
        idempotencyKey: binding.idempotencyKey,
      });
      if (existing?.transactionId === transactionId
        && existing.callbackUrl === request.url && existing.keyId === keyId) {
        return new Response('ok', { status: 200 });
      }
    } catch {
      return new Response('AdMob SSV storage unavailable', { status: 503 });
    }
    let publicKeySpki: string | undefined;
    try {
      publicKeySpki = await fetchAdMobSsvPublicKeySpki(keyId, {
        ...(config.fetcher === undefined ? {} : { fetcher: config.fetcher }),
        signal: request.signal,
      });
    } catch {
      return new Response('AdMob public key unavailable', { status: 503 });
    }
    if (publicKeySpki === undefined) {
      return new Response('AdMob public key unavailable', { status: 503 });
    }
    let publicKey: Awaited<ReturnType<typeof importAdMobSsvPublicKey>>;
    try {
      publicKey = await importAdMobSsvPublicKey(publicKeySpki);
    } catch {
      return new Response('AdMob public key invalid', { status: 503 });
    }
    const verifier = createAdMobSsvEvidenceVerifier({
      callbackSource: { async findCallback() { return request.url; } },
      publicKeySource: { async getPublicKey() { return publicKey; } },
      resolveAdUnit() { return adUnit; },
      ...(now === undefined ? {} : { now: () => now().getTime() }),
    });
    const decision = await verifier.verifyAdReward({
      request: {
        target,
        playerId: binding.playerId,
        placementId: binding.placementId,
        idempotencyKey: binding.idempotencyKey,
        completedAt: (config.now?.() ?? new Date()).toISOString(),
      },
      placement,
      platformPlacementId,
      signal: request.signal,
      timeoutMs: 5_000,
    });
    if (decision.status !== 'verified'
      || decision.verificationId !== `admob:ssv:${transactionId}`) {
      return new Response('AdMob SSV verification failed', { status: 400 });
    }
    const callback: VerifiedAdMobSsvCallback = {
      transactionId,
      target,
      playerId: binding.playerId,
      placementId: binding.placementId,
      idempotencyKey: binding.idempotencyKey,
      callbackUrl: request.url,
      acceptedAdUnit: adUnit,
      keyId,
      publicKeySpki,
      receivedAt: (config.now?.() ?? new Date()).toISOString(),
    };
    try {
      const result = await store.record(callback);
      return result === 'conflict'
        ? new Response('Conflicting AdMob SSV callback', { status: 409 })
        : new Response('ok', { status: 200 });
    } catch {
      return new Response('AdMob SSV storage unavailable', { status: 503 });
    }
  };
}

/** Claim-side lookup reuses the stored SPKI so Google key rotation cannot orphan a grant. */
export function createD1AdMobSsvEvidenceVerifier(
  config: AdMobSsvWorkerConfig,
): GameServicesEvidenceVerifier {
  const store = createD1AdMobSsvCallbackStore(config.db);
  const now = config.now;
  return {
    async verifyPurchase() {
      return { status: 'rejected', reason: 'ADMOB_SSV_PURCHASE_EVIDENCE_UNSUPPORTED' };
    },
    async verifyAdReward(input) {
      let callback: VerifiedAdMobSsvCallback | undefined;
      const verifier = createAdMobSsvEvidenceVerifier({
        callbackSource: {
          async findCallback({ request }) {
            if (request.target !== 'android' && request.target !== 'ios') {
              return undefined;
            }
            callback = await store.find({
              target: request.target,
              playerId: request.playerId,
              placementId: request.placementId,
              idempotencyKey: request.idempotencyKey,
            });
            return callback?.callbackUrl;
          },
        },
        publicKeySource: {
          async getPublicKey({ keyId }) {
            return callback?.keyId === keyId
              ? importAdMobSsvPublicKey(callback.publicKeySpki)
              : undefined;
          },
        },
        resolveAdUnit({ request }) {
          return request.target === 'android' || request.target === 'ios'
            ? callback?.acceptedAdUnit ?? config.adUnits[request.target] ?? ''
            : '';
        },
        ...(now === undefined ? {} : { now: () => now().getTime() }),
      });
      const decision = await verifier.verifyAdReward(input);
      if (decision.status === 'rejected'
        && (decision.reason === 'ADMOB_SSV_CALLBACK_ERROR'
          || decision.reason === 'ADMOB_SSV_KEY_ERROR')) {
        throw new Error(`AdMob SSV evidence lookup failed: ${decision.reason}`);
      }
      return decision;
    },
  };
}

function uniqueParameter(parameters: URLSearchParams, name: string): string | undefined {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

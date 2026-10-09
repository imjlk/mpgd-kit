import { resolveAdPlacementPlatformId, type AdPlacements } from '@mpgd/catalog';
import type { AdRewardVerifierRegistration } from './ad-reward-verifier-registry.js';
import { onePlayClientRewardEvidenceSchema } from './oneplay-client-reward.js';
import type { GameServicesBackendApi } from './client.js';
import type { ClaimAdRewardResponse } from './types.js';

export interface OnePlayRewardBinding {
  readonly applicationId: string;
  readonly deploymentTarget: string;
  readonly requestId: string;
  readonly playerId: string;
  readonly placementId: string;
  readonly platformPlacementId: string;
  readonly idempotencyKey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface OnePlayRewardClaimIdentity {
  readonly applicationId: string;
  readonly deploymentTarget: string;
  readonly playerId: string;
  readonly idempotencyKey: string;
}
export interface OnePlaySsvReceipt {
  /** Original bytes. Never reserialize the body used for HMAC verification. */
  readonly rawBody: Uint8Array<ArrayBuffer>;
  readonly timestamp: string;
  readonly signature: string;
  /** Trusted receiver time, not a client-supplied backdated timestamp. */
  readonly receivedAt: number;
}
/** Production implementations must durably enforce unique claim and request IDs, and immutable callbacks. */
export interface OnePlayRewardStore {
  /** Atomically insert or return the row for application/deployment/player/idempotency. */
  issue(binding: OnePlayRewardBinding): Promise<OnePlayRewardBinding>;
  findByClaim(input: OnePlayRewardClaimIdentity): Promise<OnePlayRewardBinding | undefined>;
  findByRequest(input: { readonly applicationId: string; readonly requestId: string }): Promise<OnePlayRewardBinding | undefined>;
  recordReceipt(input: { readonly applicationId: string; readonly requestId: string; readonly receipt: OnePlaySsvReceipt }): Promise<void>;
  findReceipt(input: { readonly applicationId: string; readonly requestId: string }): Promise<OnePlaySsvReceipt | undefined>;
}
export interface OnePlaySsvInput {
  readonly rawBody: Uint8Array<ArrayBuffer>;
  readonly apiKey: string;
  readonly timestamp: string;
  readonly signature: string;
}
export type OnePlaySsvVerification =
  | { readonly status: 'verified'; readonly requestId: string; readonly grant?: ClaimAdRewardResponse }
  | { readonly status: 'rejected'; readonly reason: string };

export function createOnePlayRewardRequestIssuer(input: {
  readonly applicationId: string;
  readonly deploymentTarget?: string;
  readonly placements: AdPlacements;
  readonly store: OnePlayRewardStore;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
}) {
  const applicationId = identifier(input.applicationId);
  const deploymentTarget = identifier(input.deploymentTarget ?? 'oneplay');
  const now = input.now ?? Date.now;
  return {
    /** playerId MUST come from authenticated server context, not SDK identity or the request body. */
    async issue(request: { readonly playerId: string; readonly placementId: string; readonly idempotencyKey: string }): Promise<{ readonly requestId: string }> {
      const playerId = identifier(request.playerId);
      const idempotencyKey = identifier(request.idempotencyKey);
      const placement = input.placements.placements.find((entry) => entry.id === request.placementId);
      const platformPlacementId = placement === undefined ? undefined : resolveAdPlacementPlatformId(placement, deploymentTarget);
      if (placement?.type !== 'rewarded' || platformPlacementId === undefined) { throw new TypeError('ONE play rewarded placement is not configured.'); }
      const issuedAt = timestamp(now());
      const candidate: OnePlayRewardBinding = { applicationId, deploymentTarget, playerId, idempotencyKey, placementId: placement.id,
        platformPlacementId, requestId: identifier((input.createRequestId ?? (() => globalThis.crypto.randomUUID()))()), issuedAt, expiresAt: issuedAt + 86_400_000 };
      const stored = await input.store.issue(candidate);
      if (!matchesClaim(stored, candidate) || stored.placementId !== candidate.placementId || stored.platformPlacementId !== platformPlacementId
        || !validBinding(stored) || stored.expiresAt < issuedAt) { throw new Error('ONE play reward request binding conflict.'); }
      return { requestId: stored.requestId };
    },
  };
}

/** Authenticate the sender, timestamp and exact raw bytes before trusting requestId. */
export async function verifyOnePlaySsv(input: OnePlaySsvInput, options: {
  readonly apiKey: string;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
}): Promise<OnePlaySsvVerification> {
  const key = apiKey(options.apiKey);
  const at = (options.now ?? Date.now)();
  if (input.rawBody.byteLength > 8192 || !constantTimeEqual(input.apiKey, key) || !/^\d{1,16}$/u.test(input.timestamp)
    || !Number.isSafeInteger(at) || Math.abs(Number(input.timestamp) - at) > 300_000 || !/^[a-f\d]{64}$/iu.test(input.signature)) {
    return { status: 'rejected', reason: 'ONEPLAY_SSV_INVALID' };
  }
  try {
    const subtle = options.subtle ?? globalThis.crypto.subtle;
    const signingKey = await subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const prefix = new TextEncoder().encode(`${input.timestamp}\n`);
    const bytes = new Uint8Array(prefix.length + input.rawBody.length);
    bytes.set(prefix);
    bytes.set(input.rawBody, prefix.length);
    const signature = Uint8Array.from(input.signature.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    );
    if (!await subtle.verify('HMAC', signingKey, signature, bytes)) {
      return {
        status: 'rejected',
        reason: 'ONEPLAY_SSV_INVALID',
      };
    }
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody),
    );
    if (!record(body) || body.status !== 'SUCCESS' || body.reason !== '' || !isIdentifier(body.requestId)) {
      return {
        status: 'rejected',
        reason: 'ONEPLAY_SSV_INVALID',
      };
    }
    return { status: 'verified', requestId: body.requestId };
  } catch {
    return { status: 'rejected', reason: 'ONEPLAY_SSV_INVALID' };
  }
}

/** Receive once, persist first, then let the normal backend claim / recovery pipeline grant. */
export function createOnePlaySsvReceiver(input: {
  readonly applicationId: string;
  readonly apiKey: string;
  readonly store: OnePlayRewardStore;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
  /** Optional immediate grant through the same configured verifier and backend ledger used by client claims. */
  readonly backend?: Pick<GameServicesBackendApi, 'adRewards'>;
}) {
  const applicationId = identifier(input.applicationId);
  apiKey(input.apiKey);
  const now = input.now ?? Date.now;
  return {
    async receive(callback: OnePlaySsvInput): Promise<OnePlaySsvVerification> {
      const receivedAt = timestamp(now());
      const decision = await verifyOnePlaySsv(callback, { apiKey: input.apiKey, now: () => receivedAt, ...(input.subtle === undefined ? {} : { subtle: input.subtle }) });
      if (decision.status !== 'verified') { return decision; }
      const binding = await input.store.findByRequest({ applicationId, requestId: decision.requestId });
      if (binding === undefined || !validBinding(binding) || binding.applicationId !== applicationId || binding.requestId !== decision.requestId
        || receivedAt < binding.issuedAt - 300_000 || receivedAt > binding.expiresAt + 300_000) { return { status: 'rejected', reason: 'ONEPLAY_SSV_BINDING_INVALID' }; }
      await input.store.recordReceipt({ applicationId, requestId: decision.requestId, receipt: {
        rawBody: new Uint8Array(callback.rawBody), timestamp: callback.timestamp, signature: callback.signature, receivedAt,
      } });
      if (input.backend === undefined) { return decision; }
      const grant = await input.backend.adRewards.claimAdReward({
        target: 'oneplay', providerId: 'oneplay-ads',
        ...(binding.deploymentTarget === 'oneplay' ? {} : { deploymentTarget: binding.deploymentTarget }),
        playerId: binding.playerId, placementId: binding.placementId, platformImpressionId: binding.requestId,
        idempotencyKey: binding.idempotencyKey, completedAt: new Date(receivedAt).toISOString(),
      });
      return { ...decision, grant };
    },
  };
}

export function createOnePlayAdRewardVerifier(input: {
  readonly applicationId: string;
  readonly deploymentTarget?: string;
  readonly apiKey: string;
  readonly store: OnePlayRewardStore;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
}): AdRewardVerifierRegistration {
  const applicationId = identifier(input.applicationId);
  const deploymentTarget = identifier(input.deploymentTarget ?? 'oneplay');
  apiKey(input.apiKey);
  const now = input.now ?? Date.now;
  return {
    providerId: 'oneplay-ads', schema: onePlayClientRewardEvidenceSchema,
    bindings: [{ target: 'oneplay', deploymentTarget }], acceptsMissingEvidence: true,
    async verify({ request, platformPlacementId, signal }) {
      signal.throwIfAborted();
      if (request.target !== 'oneplay' || (request.deploymentTarget ?? request.target) !== deploymentTarget
        || platformPlacementId === undefined || request.providerId !== undefined && request.providerId !== 'oneplay-ads') { return { status: 'rejected', reason: 'ONEPLAY_REWARD_BINDING_INVALID' }; }
      const identity = { applicationId, deploymentTarget, playerId: request.playerId, idempotencyKey: request.idempotencyKey };
      const binding = await input.store.findByClaim(identity);
      signal.throwIfAborted();
      if (binding === undefined || !validBinding(binding) || !matchesClaim(binding, identity) || binding.placementId !== request.placementId
        || binding.platformPlacementId !== platformPlacementId || request.platformImpressionId !== undefined && request.platformImpressionId !== binding.requestId) {
        return { status: 'rejected', reason: 'ONEPLAY_REWARD_BINDING_INVALID' };
      }
      const envelope = request.evidence;
      if (envelope !== undefined && (envelope.schema !== onePlayClientRewardEvidenceSchema || envelope.payload.requestId !== binding.requestId
        || envelope.payload.placementId !== binding.placementId || envelope.payload.platformPlacementId !== platformPlacementId || envelope.payload.rewardGranted !== false)) {
        return { status: 'rejected', reason: 'ONEPLAY_REWARD_BINDING_INVALID' };
      }
      const receipt = await input.store.findReceipt({ applicationId, requestId: binding.requestId });
      signal.throwIfAborted();
      if (receipt === undefined) { return { status: 'pending', reason: 'ONEPLAY_SSV_PENDING' }; }
      if (!Number.isSafeInteger(receipt.receivedAt) || receipt.receivedAt < binding.issuedAt - 300_000 || receipt.receivedAt > binding.expiresAt + 300_000 || receipt.receivedAt > now() + 300_000) {
        return { status: 'rejected', reason: 'ONEPLAY_SSV_BINDING_INVALID' };
      }
      const verified = await verifyOnePlaySsv({ ...receipt, apiKey: input.apiKey }, {
        apiKey: input.apiKey, now: () => receipt.receivedAt, ...(input.subtle === undefined ? {} : { subtle: input.subtle }),
      });
      signal.throwIfAborted();
      if (verified.status !== 'verified' || verified.requestId !== binding.requestId) { return { status: 'rejected', reason: 'ONEPLAY_SSV_INVALID' }; }
      const proofId = `${encodeURIComponent(applicationId)}:${encodeURIComponent(binding.requestId)}`;
      return { status: 'verified', verificationId: `oneplay:ssv:${proofId}`, platformEvidenceId: proofId,
        verifiedAt: new Date(receipt.receivedAt).toISOString(), payload: { onePlayRequestId: binding.requestId, onePlayApplicationId: applicationId } };
    },
  };
}
function validBinding(binding: OnePlayRewardBinding): boolean {
  return [binding.applicationId, binding.deploymentTarget, binding.playerId, binding.idempotencyKey, binding.requestId, binding.placementId, binding.platformPlacementId].every(isIdentifier)
    && Number.isSafeInteger(binding.issuedAt) && Number.isSafeInteger(binding.expiresAt) && binding.issuedAt >= 0 && binding.expiresAt >= binding.issuedAt;
}
function matchesClaim(binding: OnePlayRewardBinding, request: OnePlayRewardClaimIdentity): boolean {
  return binding.applicationId === request.applicationId && binding.deploymentTarget === request.deploymentTarget
    && binding.playerId === request.playerId && binding.idempotencyKey === request.idempotencyKey;
}
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function identifier(value: unknown): string {
  if (!isIdentifier(value)) {
    throw new TypeError('ONE play identifier is invalid.');
  }
  return value;
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_639_999_913_600_000) {
    throw new TypeError('ONE play timestamp is invalid.');
  }
  return value;
}
function apiKey(value: string): string {
  if (!/^[A-Za-z\d_-]{5,64}$/u.test(value)) {
    throw new TypeError('ONE play SSV API key is invalid.');
  }
  return value;
}
function constantTimeEqual(left: string, right: string): boolean {
  if (typeof left !== 'string' || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < right.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

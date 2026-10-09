import type { PlatformEvidenceEnvelope } from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  assertAdShowInput,
  type AdAvailability,
  type AdPlacementInput,
  type AdPresentationEvent,
  type AdProvider,
  type AdReason,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';
import type { OnePlaySdk } from './oneplay-sdk.js';

/** Authenticated server issuance. The client never chooses requestId or authorizes a grant. */
export interface OnePlayRewardRequestPort {
  issueRequest(input: {
    readonly placementId: string;
    readonly platformPlacementId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly requestId: string }>;
}
/** Shared across gateways and checkout: a timeout cannot prove native fullscreen UI has closed. */
export const onePlayFullscreenOwners = new WeakMap<OnePlaySdk, object>();
export function createOnePlayAdProvider(input: {
  readonly sdk?: OnePlaySdk;
  readonly placementIds: Readonly<Record<string, { readonly format: 'rewarded' | 'interstitial'; readonly platformId: string }>>;
  readonly rewardRequests?: OnePlayRewardRequestPort;
}): AdProvider {
  const { sdk, rewardRequests } = input;
  const placements = Object.fromEntries(
    Object.entries(input.placementIds).map(([key, value]) => [key, Object.freeze({ ...value })]),
  );
  const id = 'oneplay-ads';
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  const flights = new Map<string, { input: AdShowInput; promise: Promise<AdShowResult> }>();
  const availability = (request: AdPlacementInput): AdAvailability => {
    if (sdk === undefined || !sdk.ads.isSupported(request.format)) {
      return {
        state: 'unsupported',
        reason: 'unsupported',
      };
    }
    const placement = Object.hasOwn(placements, request.placementId)
      ? placements[request.placementId]
      : undefined;
    if (placement?.format !== request.format || !placement.platformId.trim()
      || request.format === 'rewarded' && rewardRequests === undefined) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    if (onePlayFullscreenOwners.has(sdk)) {
      return {
        state: 'temporarily-unavailable',
        reason: 'busy',
      };
    }
    return { state: 'available' };
  };
  return {
    id, protocol: adProtocol, protocolVersion: adProtocolVersion, rewardSignal: 'delayed',
    getAvailability: async (request) => availability(request),
    async preload(request) {
      const state = availability(request);
      const placement = placements[request.placementId];
      if (state.state !== 'available' || sdk === undefined || placement === undefined) { return { status: 'unavailable', reason: state.reason ?? 'unsupported' }; }
      if (request.format === 'rewarded') { sdk.ads.loadRewarded({ placementId: placement.platformId }); } else { sdk.ads.loadInterstitial({ placementId: placement.platformId }); }
      return { status: 'deferred' };
    },
    show(supplied) {
      const request = assertAdShowInput(supplied);
      const previous = flights.get(request.invocationId);
      if (previous !== undefined) {
        if (JSON.stringify(previous.input) !== JSON.stringify(request)) { throw new TypeError('Advertising invocation identity changed.'); }
        return previous.promise;
      }
      const base = { providerId: id, invocationId: request.invocationId, format: request.format };
      const unavailableEligibility = request.format === 'interstitial' ? 'not-applicable' : 'not-earned';
      const state = availability(request);
      const placement = placements[request.placementId];
      if (state.state !== 'available' || sdk === undefined || placement === undefined) {
        return Promise.resolve({ ...base, eligibility: unavailableEligibility, outcome: 'unavailable', presentation: 'not-started', reason: state.reason ?? 'unsupported' });
      }
      let sequence = 0;
      const emit = (event: { type: 'requested'; claimEvidence?: PlatformEvidenceEnvelope }
        | { type: 'closed' | 'unknown' } | { type: 'failed'; reason: AdReason }
        | { type: 'reward-earned'; evidence: PlatformEvidenceEnvelope }) => {
        const observation = Object.freeze({ providerId: id, invocationId: request.invocationId, sequence: ++sequence, ...event });
        for (const listener of listeners) { try { listener(observation); } catch { /* Observers cannot alter native ownership. */ } }
      };
      const owner = {};
      onePlayFullscreenOwners.set(sdk, owner);
      const release = () => { if (onePlayFullscreenOwners.get(sdk) === owner) { onePlayFullscreenOwners.delete(sdk); } };
      const promise = Promise.resolve().then(async (): Promise<AdShowResult> => {
        let requestId: string | undefined;
        let claimEvidence: PlatformEvidenceEnvelope | undefined;
        const evidence = (event: 'rewarded' | 'outcome-unknown'): PlatformEvidenceEnvelope => ({
          schema: 'oneplay.rewarded-ad.callback.v1', payload: { event, requestId: requestId ?? '', placementId: request.placementId, platformPlacementId: placement.platformId, rewardGranted: false },
        });
        if (request.format === 'rewarded') {
          try {
            if (rewardRequests === undefined) { throw new TypeError('ONE play reward issuer is missing.'); }
            const issued = await rewardRequests.issueRequest({ placementId: request.placementId, platformPlacementId: placement.platformId, idempotencyKey: request.idempotencyKey });
            if (typeof issued.requestId !== 'string' || issued.requestId.trim() !== issued.requestId || !issued.requestId || issued.requestId.length > 256) { throw new TypeError('Invalid ONE play server request ID.'); }
            requestId = issued.requestId;
            claimEvidence = evidence('outcome-unknown');
          } catch {
            release();
            emit({ type: 'failed', reason: 'transient-failure' });
            return { ...base, eligibility: 'not-earned', outcome: 'failed', presentation: 'not-started', reason: 'transient-failure' };
          }
        }
        emit({ type: 'requested', ...(claimEvidence === undefined ? {} : { claimEvidence }) });
        try {
          const result = request.format === 'rewarded' && requestId !== undefined
            ? await sdk.ads.showRewardedAsync({ placementId: placement.platformId, requestId })
            : await sdk.ads.showInterstitialAsync({ placementId: placement.platformId });
          const correlated = request.format === 'interstitial' || result.requestId === requestId;
          if (correlated && request.format === 'rewarded' && result.status === 'rewarded') {
            const earned = evidence('rewarded');
            emit({ type: 'reward-earned', evidence: earned });
            release();
            emit({ type: 'closed' });
            return { ...base, outcome: 'shown', presentation: 'closed', eligibility: 'eligible', evidence: earned, claimEvidence: earned };
          }
          if (correlated && (request.format === 'interstitial' && result.status === 'completed'
            || request.format === 'rewarded' && result.status === 'dismissed')) {
            release();
            emit({ type: 'closed' });
            return { ...base, outcome: 'shown', presentation: 'closed', eligibility: unavailableEligibility };
          }
          const reason = correlated && result.status === 'failed' ? noStartReason(result.reason) : undefined;
          if (reason !== undefined) { release(); emit({ type: 'failed', reason }); return { ...base, outcome: 'unavailable', presentation: 'not-started', eligibility: unavailableEligibility, reason }; }
        } catch { /* Transport exceptions leave the physical outcome uncertain. */ }
        emit({ type: 'unknown' });
        return { ...base, outcome: 'pending', presentation: 'unknown', eligibility: request.format === 'rewarded' ? 'unknown' : 'not-applicable', reason: 'outcome-unknown', ...(claimEvidence === undefined ? {} : { claimEvidence }) };
      });
      flights.set(request.invocationId, { input: request, promise });
      return promise;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
function noStartReason(reason: string | undefined): AdReason | undefined {
  switch (reason) {
    case 'no_fill':
      return 'no-fill';
    case 'invalid_request':
      return 'configuration-required';
    case 'platform_not_supported':
    case 'unsupported_action':
    case 'unsupported_screen':
      return 'unsupported';
    case 'already_showing':
    case 'rate_limited':
      return 'busy';
    case 'not_initialized':
      return 'action-required';
    case 'show_failed':
      return 'transient-failure';
    default:
      return undefined;
  }
}

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

/** Shared across gateways: a timeout cannot prove that native fullscreen UI has closed. */
export const onePlayFullscreenOwners = new WeakMap<OnePlaySdk, object>();
export function createOnePlayAdProvider(input: {
  readonly sdk?: OnePlaySdk;
  readonly placementIds: Readonly<Record<string, { readonly format: 'rewarded' | 'interstitial'; readonly platformId: string }>>;
}): AdProvider {
  const { sdk } = input;
  const id = 'oneplay-ads';
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  const flights = new Map<string, { input: AdShowInput; promise: Promise<AdShowResult> }>();
  const availability = (request: AdPlacementInput): AdAvailability => {
    if (request.format !== 'interstitial') {
      return {
        state: 'unsupported',
        reason: 'unsupported',
      };
    }
    if (sdk === undefined || !sdk.ads.isSupported(request.format)) {
      return {
        state: 'unsupported',
        reason: 'unsupported',
      };
    }
    const placement = Object.hasOwn(input.placementIds, request.placementId)
      ? input.placementIds[request.placementId]
      : undefined;
    if (placement?.format !== request.format || !placement.platformId.trim()) {
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
    id,
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'delayed',
    getAvailability: async (request) => availability(request),
    async preload(request) {
      const state = availability(request);
      if (state.state !== 'available' || sdk === undefined) {
        return { status: 'unavailable', reason: state.reason ?? 'unsupported' };
      }
      sdk.ads.loadInterstitial({ placementId: input.placementIds[request.placementId]!.platformId });
      return { status: 'deferred' };
    },
    show(supplied) {
      const request = assertAdShowInput(supplied);
      const previous = flights.get(request.invocationId);
      if (previous !== undefined) {
        if (JSON.stringify(previous.input) !== JSON.stringify(request)) {
          throw new TypeError('Advertising invocation identity changed.');
        }
        return previous.promise;
      }
      const base = { providerId: id, invocationId: request.invocationId, format: request.format, eligibility: request.format === 'interstitial' ? 'not-applicable' : 'not-earned' } as const;
      const state = availability(request);
      if (state.state !== 'available' || sdk === undefined) {
        return Promise.resolve({
          ...base,
          outcome: 'unavailable',
          presentation: 'not-started',
          reason: state.reason ?? 'unsupported',
        });
      }
      let sequence = 0;
      const emit = (event: { type: 'requested' | 'closed' | 'unknown' } | { type: 'failed'; reason: AdReason }) => {
        const observation = {
          providerId: id,
          invocationId: request.invocationId,
          sequence: ++sequence,
          ...event,
        };
        for (const listener of listeners) {
          try {
            listener(observation);
          } catch {
            /* Observers cannot alter native ownership. */
          }
        }
      };
      const owner = {};
      onePlayFullscreenOwners.set(sdk, owner);
      const promise = Promise.resolve().then(async (): Promise<AdShowResult> => {
        emit({ type: 'requested' });
        try {
          const result = await sdk.ads.showInterstitialAsync({ placementId: input.placementIds[request.placementId]!.platformId });
          if (result.status === 'completed') {
            if (onePlayFullscreenOwners.get(sdk) === owner) {
              onePlayFullscreenOwners.delete(sdk);
            }
            emit({ type: 'closed' });
            return { ...base, outcome: 'shown', presentation: 'closed' };
          }
          const reason = result.status === 'failed' ? noStartReason(result.reason) : undefined;
          if (reason !== undefined) {
            if (onePlayFullscreenOwners.get(sdk) === owner) {
              onePlayFullscreenOwners.delete(sdk);
            }
            emit({ type: 'failed', reason });
            return { ...base, outcome: 'unavailable', presentation: 'not-started', reason };
          }
        } catch {
          /* Transport exceptions leave the physical outcome uncertain. */
        }
        emit({ type: 'unknown' });
        return { ...base, outcome: 'pending', presentation: 'unknown', reason: 'outcome-unknown' };
      });
      flights.set(request.invocationId, { input: request, promise });
      return promise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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

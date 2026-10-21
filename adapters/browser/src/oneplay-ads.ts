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
import type { OnePlayAdResult, OnePlaySdk } from './oneplay-sdk.js';

/** Authenticated server issuance. The client never chooses requestId or authorizes a grant. */
export interface OnePlayRewardRequestPort {
  issueRequest(input: {
    readonly placementId: string;
    readonly platformPlacementId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly requestId: string }>;
}
/** Shared across gateways and checkout. Dispose and a bounded recovery can clear it; resume cannot. */
export const onePlayFullscreenOwners = new WeakMap<OnePlaySdk, object>();
const onePlayOwnerScopes = new WeakMap<object, object>();
const onePlayOccupancyCancels = new WeakMap<OnePlaySdk, Map<object, Set<() => void>>>();
const defaultShowTimeoutMs = 60_000;
const defaultRecoveryTimeoutMs = 5 * 60_000;

/** Tag occupancy so dispose of one gateway cannot clear another gateway's ad or checkout. */
export function claimOnePlayFullscreenOwner(sdk: OnePlaySdk, owner: object, scope: object): void {
  onePlayFullscreenOwners.set(sdk, owner);
  onePlayOwnerScopes.set(owner, scope);
}

/** Drop fullscreen occupancy and show/recovery timers created by this gateway scope. */
export function clearOnePlayFullscreenOwner(sdk: OnePlaySdk, scope: object): void {
  const owner = onePlayFullscreenOwners.get(sdk);
  if (owner !== undefined && onePlayOwnerScopes.get(owner) === scope) {
    onePlayFullscreenOwners.delete(sdk);
  }
  const cancels = onePlayOccupancyCancels.get(sdk)?.get(scope);
  if (cancels === undefined) {
    return;
  }
  onePlayOccupancyCancels.get(sdk)?.delete(scope);
  for (const cancel of cancels) {
    try {
      cancel();
    } catch { /* Teardown cannot keep a wedged owner. */ }
  }
}

function bindOccupancyCancel(sdk: OnePlaySdk, scope: object, cancel: () => void): () => void {
  const scoped = onePlayOccupancyCancels.get(sdk) ?? new Map();
  const set = scoped.get(scope) ?? new Set();
  set.add(cancel);
  scoped.set(scope, set);
  onePlayOccupancyCancels.set(sdk, scoped);
  return () => {
    set.delete(cancel);
  };
}

function requireTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new RangeError(`${label} must be a positive timer duration.`);
  }
  return timeout;
}
export function createOnePlayAdProvider(input: {
  readonly sdk?: OnePlaySdk;
  readonly placementIds: Readonly<Record<string, { readonly format: 'rewarded' | 'interstitial'; readonly platformId: string }>>;
  readonly rewardRequests?: OnePlayRewardRequestPort;
  /** Bounds the SDK show promise. A hang resolves pending and does not grant. */
  readonly showTimeoutMs?: number;
  /** After an unresolved or paused rejection, release occupancy if no terminal result arrives. */
  readonly recoveryTimeoutMs?: number;
  /** Gateway identity for dispose. Omitted providers keep a private scope another gateway cannot clear. */
  readonly fullscreenScope?: object;
}): AdProvider {
  const { sdk, rewardRequests } = input;
  const fullscreenScope = input.fullscreenScope ?? {};
  const showTimeoutMs = requireTimeout(
    input.showTimeoutMs,
    defaultShowTimeoutMs,
    'ONE play ad show timeout',
  );
  const recoveryTimeoutMs = requireTimeout(
    input.recoveryTimeoutMs,
    defaultRecoveryTimeoutMs,
    'ONE play ad recovery timeout',
  );
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
      claimOnePlayFullscreenOwner(sdk, owner, fullscreenScope);
      const release = () => { if (onePlayFullscreenOwners.get(sdk) === owner) { onePlayFullscreenOwners.delete(sdk); } };
      const promise = Promise.resolve().then(async (): Promise<AdShowResult> => {
        const abandoned = (): AdShowResult => ({
          ...base,
          eligibility: unavailableEligibility,
          outcome: 'failed',
          presentation: 'not-started',
          reason: 'transient-failure',
        });
        if (onePlayFullscreenOwners.get(sdk) !== owner) { return abandoned(); }
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
          if (onePlayFullscreenOwners.get(sdk) !== owner) { return abandoned(); }
        }
        emit({ type: 'requested', ...(claimEvidence === undefined ? {} : { claimEvidence }) });
        let opened = false;
        let dropped = false;
        const onPause = (event: { readonly reason: string }) => {
          if (event.reason === 'ad') { opened = true; }
        };
        sdk.on('pause', onPause);
        const pendingResult = (): AdShowResult => ({
          ...base,
          outcome: 'pending',
          presentation: 'unknown',
          eligibility: request.format === 'rewarded' ? 'unknown' : 'not-applicable',
          reason: 'outcome-unknown',
          ...(claimEvidence === undefined ? {} : { claimEvidence }),
        });
        let showTimer: ReturnType<typeof setTimeout> | undefined;
        let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
        let resolveRace: ((value: { readonly kind: 'value'; readonly value: OnePlayAdResult } | { readonly kind: 'rejected' } | { readonly kind: 'timeout' } | { readonly kind: 'dropped' }) => void) | undefined;
        const clearTimers = () => {
          if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined; }
          if (recoveryTimer !== undefined) { clearTimeout(recoveryTimer); recoveryTimer = undefined; }
        };
        const unlisten = () => { sdk.off('pause', onPause); };
        const endWatch = () => { clearTimers(); unlisten(); unbind(); };
        const drop = () => {
          if (dropped) { return; }
          dropped = true;
          clearTimers();
          unlisten();
          release();
          resolveRace?.({ kind: 'dropped' });
        };
        const unbind = bindOccupancyCancel(sdk, fullscreenScope, drop);
        const armRecovery = () => {
          if (dropped) { return; }
          recoveryTimer = setTimeout(() => {
            recoveryTimer = undefined;
            if (dropped) { return; }
            const sawAd = opened;
            drop();
            // The deadline ends the runtime lease. It is not a reward.
            emit(sawAd ? { type: 'closed' } : { type: 'failed', reason: 'outcome-unknown' });
          }, recoveryTimeoutMs);
        };
        let sdkCall: Promise<OnePlayAdResult> | undefined;
        const raced = await new Promise<
          | { readonly kind: 'value'; readonly value: OnePlayAdResult }
          | { readonly kind: 'rejected' }
          | { readonly kind: 'timeout' }
          | { readonly kind: 'dropped' }
        >((done) => {
          resolveRace = done;
          showTimer = setTimeout(() => done({ kind: 'timeout' }), showTimeoutMs);
          const rejectCall = () => {
            if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined; }
            done({ kind: 'rejected' });
          };
          try {
            const invoked = request.format === 'rewarded' && requestId !== undefined
              ? sdk.ads.showRewardedAsync({ placementId: placement.platformId, requestId })
              : sdk.ads.showInterstitialAsync({ placementId: placement.platformId });
            sdkCall = invoked;
            invoked.then(
              (value) => {
                if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined; }
                done({ kind: 'value', value });
              },
              rejectCall,
            );
          } catch {
            rejectCall();
          }
        });
        if (dropped || raced.kind === 'dropped') { endWatch(); return pendingResult(); }
        if (raced.kind === 'timeout') {
          emit({ type: 'unknown' });
          armRecovery();
          const late = sdkCall;
          if (late !== undefined) {
            const emitTerminal = (event: { type: 'closed' } | { type: 'failed'; reason: AdReason }) => {
              if (dropped) { return; }
              clearTimers();
              release();
              endWatch();
              // A late rewarded status is correlation only. Never emit reward-earned.
              emit(event);
            };
            void late.then(
              (value) => {
                if (dropped || !terminalAdResult(request.format, requestId, value)) { return; }
                const reason = value.status === 'failed' ? noStartReason(value.reason) : undefined;
                emitTerminal(reason === undefined ? { type: 'closed' } : { type: 'failed', reason });
              },
              () => {
                if (dropped || opened) { return; }
                emitTerminal({ type: 'failed', reason: 'transient-failure' });
              },
            );
          }
          return pendingResult();
        }
        if (raced.kind === 'rejected') {
          if (!opened) {
            endWatch();
            release();
            emit({ type: 'failed', reason: 'transient-failure' });
            return { ...base, outcome: 'failed', presentation: 'not-started', eligibility: unavailableEligibility, reason: 'transient-failure' };
          }
          emit({ type: 'unknown' });
          armRecovery();
          return pendingResult();
        }
        const result = raced.value;
        const correlated = request.format === 'interstitial' || result.requestId === requestId;
        if (correlated && request.format === 'rewarded' && result.status === 'rewarded') {
          const earned = evidence('rewarded');
          emit({ type: 'reward-earned', evidence: earned });
          release();
          endWatch();
          emit({ type: 'closed' });
          return { ...base, outcome: 'shown', presentation: 'closed', eligibility: 'eligible', evidence: earned, claimEvidence: earned };
        }
        if (correlated && (request.format === 'interstitial' && result.status === 'completed'
          || request.format === 'rewarded' && result.status === 'dismissed')) {
          release();
          endWatch();
          emit({ type: 'closed' });
          return { ...base, outcome: 'shown', presentation: 'closed', eligibility: unavailableEligibility };
        }
        const reason = correlated && result.status === 'failed' ? noStartReason(result.reason) : undefined;
        if (reason !== undefined) {
          release();
          endWatch();
          emit({ type: 'failed', reason });
          return { ...base, outcome: 'unavailable', presentation: 'not-started', eligibility: unavailableEligibility, reason };
        }
        // A settled unknown reason may still have native UI. Resume does not prove closure.
        endWatch();
        emit({ type: 'unknown' });
        return pendingResult();
      });
      flights.set(request.invocationId, { input: request, promise });
      return promise;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
function terminalAdResult(
  format: 'rewarded' | 'interstitial',
  requestId: string | undefined,
  result: OnePlayAdResult,
): boolean {
  const correlated = format === 'interstitial' || result.requestId === requestId;
  if (!correlated) {
    return false;
  }
  if (format === 'interstitial' && result.status === 'completed') {
    return true;
  }
  if (format === 'rewarded' && (result.status === 'rewarded' || result.status === 'dismissed')) {
    return true;
  }
  return result.status === 'failed' && noStartReason(result.reason) !== undefined;
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

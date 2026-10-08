import type { PlatformEvidenceEnvelope } from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  assertAdPresentationEvent,
  assertAdShowInput,
  assertAdShowResult,
  type AdAvailability,
  type AdPlacementInput,
  type AdPresentationEvent,
  type AdProvider,
  type AdReason,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';
import type { Verse8AdsClient } from './index.js';
import { verse8AdsRewardEvidenceSchema } from './ads-contract.js';

export interface Verse8AdPresentationEvent {
  readonly requestId: string;
  readonly sequence: number;
  readonly state: 'open' | 'closed' | 'not-started' | 'unknown';
}
/** Trusted host facts, scoped to the original SDK request. Reward telemetry is not closure. */
export interface Verse8AdPresentationSource {
  subscribe(listener: (event: Verse8AdPresentationEvent) => void): () => void;
}
interface NativeOwner {
  state: 'requested' | 'open' | 'unknown';
}
const owners = new WeakMap<object, NativeOwner>();
type EventBody<T = AdPresentationEvent> = T extends AdPresentationEvent ? Omit<T, 'providerId' | 'invocationId' | 'sequence'> : never;

export function createVerse8AdProvider(input: {
  readonly client: Verse8AdsClient;
  readonly resolvePlacement?: (placementId: string) => string | undefined;
  readonly presentation?: Verse8AdPresentationSource;
  readonly timeoutMs?: number;
}): AdProvider {
  const id = 'verse8-ads';
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('Verse8 ad timeout must be a positive timer duration.');
  }
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  function availability(request: AdPlacementInput): AdAvailability {
    const placement = input.resolvePlacement?.(request.placementId);
    if (typeof placement !== 'string' || placement.trim() === '' || placement.length > 512) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    // SDK 0.4 resolves rewarded H5 ads at adViewed, before adBreakDone. It has
    // no reliable rewarded closure port; require a trusted host integration.
    if (request.format === 'rewarded' && input.presentation === undefined) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    const owner = owners.get(input.client);
    if (owner?.state === 'unknown') {
      return {
        state: 'action-required',
        reason: 'action-required',
      };
    }
    if (owner !== undefined) {
      return { state: 'temporarily-unavailable', reason: 'busy' };
    }
    return { state: 'available' };
  }
  async function show(supplied: AdShowInput): Promise<AdShowResult> {
    const request = assertAdShowInput(supplied);
    const make = (value: Omit<AdShowResult, 'providerId' | 'invocationId' | 'format'>) => assertAdShowResult(
      { providerId: id, invocationId: request.invocationId, format: request.format, ...value },
    );
    const negative = (reason: AdReason, outcome: 'unavailable' | 'failed' = 'unavailable') => make({
      outcome,
      presentation: 'not-started',
      eligibility: request.format === 'rewarded' ? 'not-earned' : 'not-applicable',
      reason,
    });
    const available = availability(request);
    if (available.state !== 'available') {
      return negative(available.reason ?? 'configuration-required');
    }
    const placement = input.resolvePlacement?.(request.placementId);
    if (placement === undefined) {
      return negative('configuration-required');
    }
    const owner: NativeOwner = { state: 'requested' };
    owners.set(input.client, owner);
    const release = () => {
      if (owners.get(input.client) === owner) {
        owners.delete(input.client);
      }
    };
    let started = false;
    let closed = false;
    let called = false;
    let delivered = false;
    let sdkSettled = false;
    let nativeSequence = 0;
    let sequence = 0;
    let earned: PlatformEvidenceEnvelope | undefined;
    let notEarned = false;
    let didNotStart = false;
    const candidate: PlatformEvidenceEnvelope = {
      schema: verse8AdsRewardEvidenceSchema,
      payload: { requestId: request.invocationId, placementId: placement },
    };
    let unsubscribe: (() => void) | undefined;
    let cleaned = false;
    let resolve!: (value: AdShowResult) => void;
    const pending = new Promise<AdShowResult>((done) => {
      resolve = done;
    });
    const clean = () => {
      if (cleaned || !closed || !sdkSettled || unsubscribe === undefined) {
        return;
      }
      cleaned = true;
      try {
        unsubscribe();
      } catch { /* Native closure is already known. */ }
    };
    const emit = (event: EventBody) => {
      const safe = assertAdPresentationEvent({
        ...event,
        providerId: id,
        invocationId: request.invocationId,
        sequence: ++sequence,
      });
      for (const listener of [...listeners]) {
        try {
          void Promise.resolve(listener(safe)).catch(() => undefined);
        } catch { /* Isolate observation. */ }
      }
    };
    const eligibility = (): AdShowResult['eligibility'] => {
      if (request.format === 'interstitial') {
        return 'not-applicable';
      }
      if (notEarned) {
        return 'not-earned';
      }
      return earned === undefined ? 'unknown' : 'eligible';
    };
    const result = () => make({
      outcome: closed ? 'shown' : 'pending',
      presentation: closed ? 'closed' : 'unknown',
      eligibility: eligibility(),
      ...(!closed ? { reason: 'outcome-unknown' as const } : {}),
      ...(earned === undefined ? {} : { evidence: earned }),
      ...(request.format === 'rewarded' && !notEarned ? { claimEvidence: candidate } : {}),
    });
    const finish = (value: AdShowResult) => {
      if (!delivered) {
        delivered = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const unknown = () => {
      if (!closed) {
        owner.state = 'unknown';
        emit({ type: 'unknown' });
      }
      finish(result());
    };
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      release();
      emit({ type: 'closed' });
      finish(result());
      clean();
    };
    try {
      unsubscribe = input.presentation?.subscribe((event) => {
        if (!called || event.requestId !== request.invocationId || closed || !Number.isSafeInteger(event.sequence) || event.sequence <= nativeSequence) { return; }
        if (!['open', 'closed', 'not-started', 'unknown'].includes(event.state)) { return; }
        nativeSequence = event.sequence;
        if (event.state === 'open') { if (!started) { started = true; owner.state = 'open'; emit({ type: 'started' }); } } else if (event.state === 'closed') { close(); } else if (event.state === 'not-started') {
          if (started || earned !== undefined) { unknown(); } else { closed = true; didNotStart = true; notEarned = true; release(); emit({ type: 'failed', reason: 'transient-failure' }); finish(negative('transient-failure', 'failed')); clean(); }
        } else { unknown(); }
      });
    } catch {
      release();
      return negative('transient-failure', 'failed');
    }
    emit({
      type: 'requested',
      ...(request.format === 'rewarded' && !notEarned ? { claimEvidence: candidate } : {}),
    });
    const timer = setTimeout(unknown, timeoutMs);
    called = true;
    const sdkInput = {
      placementId: placement,
      requestId: request.invocationId,
      timeoutMs,
      meta: { logicalPlacementId: request.placementId },
    };
    try {
      const promise = request.format === 'rewarded'
        ? input.client.showRewarded(sdkInput)
        : input.client.showInterstitial(sdkInput);
      void Promise.resolve(promise).then((value) => {
        sdkSettled = true;
        if (value.requestId !== request.invocationId) { unknown(); clean(); return; }
        if (didNotStart) { clean(); return; }
        if (value.status === 'rewarded' && request.format === 'rewarded') {
          earned = candidate;
          if (!started && !closed) { started = true; owner.state = 'open'; emit({ type: 'started' }); }
          emit({ type: 'reward-earned', evidence: candidate });
          // Rewarded completion is eligibility only. The host must close UI.
          if (closed) { finish(result()); }
        } else if (value.status === 'dismissed') {
          notEarned = earned === undefined;
          close();
        } else if (value.status === 'failed' && !started && !closed && (value.error.code === 'unsupported_env' || value.error.code === 'busy')) {
          closed = true;
          release();
          emit({ type: 'failed', reason: value.error.code === 'busy' ? 'busy' : 'unsupported' });
          finish(negative(value.error.code === 'busy' ? 'busy' : 'unsupported'));
        } else { unknown(); }
        clean();
      }, () => { sdkSettled = true; unknown(); clean(); }).catch(() => { sdkSettled = true; unknown(); clean(); });
    } catch {
      sdkSettled = true;
      unknown();
      clean();
    }
    return pending;
  }
  return {
    id,
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'delayed',
    getAvailability: async (request) => availability(request),
    async preload(request) {
      const available = availability(request);
      return available.state === 'available'
        ? { status: 'deferred' }
        : {
            status: 'unavailable',
            ...(available.reason === undefined ? {} : { reason: available.reason }),
          };
    },
    show,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

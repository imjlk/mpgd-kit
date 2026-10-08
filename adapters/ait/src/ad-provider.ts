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
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';
import type { PlatformEvidenceEnvelope } from '@mpgd/platform';
import type { AitHostDependencies } from './host.js';
import type { AitAdPlacementType } from './ad-config.js';

type EventBody<T = AdPresentationEvent> = T extends AdPresentationEvent ? Omit<T, 'providerId' | 'invocationId' | 'sequence'> : never;
interface NativeOwner {
  state: 'requested' | 'open' | 'unknown';
}
const nativeOwners = new WeakMap<object, NativeOwner>();

/** SDK event interpretation only. Game execution and backend grants are separate owners. */
export function createAitAdProvider(input: {
  readonly dependencies: Pick<AitHostDependencies, 'showFullScreenAd'>;
  readonly groups: ReadonlyMap<string, string>;
  readonly types: ReadonlyMap<string, AitAdPlacementType>;
  readonly isSupported: () => boolean;
  readonly prepare: (group: string) => Promise<void>;
  readonly consume: (group: string) => boolean;
  readonly requestTimeoutMs: number;
  readonly startTimeoutMs: number;
  readonly displayTimeoutMs: number;
  readonly onLegacyPhase?: (active: boolean) => void;
}): AdProvider & { showLegacy(request: AdShowInput): Promise<AdShowResult> } {
  const id = 'apps-in-toss-ads';
  const sdk = input.dependencies.showFullScreenAd;
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  function availability(request: AdPlacementInput): AdAvailability {
    if (!input.isSupported()) {
      return { state: 'unsupported', reason: 'unsupported' };
    }
    if (input.types.has(request.placementId) && input.types.get(request.placementId) !== request.format) {
      return {
        state: 'unsupported',
        reason: 'unsupported',
      };
    }
    if (!input.groups.has(request.placementId) || !input.types.has(request.placementId)) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    const owner = nativeOwners.get(sdk);
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
  async function show(supplied: AdShowInput, legacy: boolean): Promise<AdShowResult> {
    const request = assertAdShowInput(supplied);
    if (request.idempotencyKey.length > 256 || /[\p{Cc}\p{Cf}]/u.test(request.idempotencyKey)) {
      throw new TypeError('AIT ad correlation must contain 1 to 256 visible characters.');
    }
    const makeResult = (state: Omit<AdShowResult, 'providerId' | 'invocationId' | 'format'>) => assertAdShowResult(
      { providerId: id, invocationId: request.invocationId, format: request.format, ...state },
    );
    const noStart = (outcome: 'unavailable' | 'failed', reason: AdShowResult['reason']) => makeResult(
      {
        outcome,
        presentation: 'not-started',
        eligibility: request.format === 'rewarded' ? 'not-earned' : 'not-applicable',
        ...(reason === undefined ? {} : { reason }),
      },
    );
    const available = availability(request);
    if (available.state !== 'available') {
      return noStart('unavailable', available.reason);
    }
    const group = input.groups.get(request.placementId);
    if (group === undefined) {
      return noStart('unavailable', 'configuration-required');
    }
    const owned: NativeOwner = { state: 'requested' };
    nativeOwners.set(sdk, owned);
    const legacyPhase = (active: boolean) => {
      if (!legacy) {
        return;
      }
      try {
        input.onLegacyPhase?.(active);
      } catch { /* Isolate lifecycle observation. */ }
    };
    const release = () => {
      if (nativeOwners.get(sdk) === owned) {
        nativeOwners.delete(sdk);
      }
    };
    try {
      await input.prepare(group);
    } catch {
      release();
      return noStart('failed', 'transient-failure');
    }
    if (!input.consume(group)) {
      release();
      return noStart('failed', 'transient-failure');
    }
    let started = false;
    let closed = false;
    let earned: PlatformEvidenceEnvelope | undefined;
    let sequence = 0;
    let cleanup: (() => void) | undefined;
    let cleaned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let displayTimerArmed = false;
    let delivered = false;
    let resolve!: (result: AdShowResult) => void;
    const result = new Promise<AdShowResult>((done) => {
      resolve = done;
    });
    const startedAt = Date.now();
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
        } catch { /* Keep native terminal observation alive. */ }
      }
    };
    const clean = () => {
      if (cleaned || cleanup === undefined || !closed || request.format === 'rewarded' && earned === undefined) {
        return;
      }
      cleaned = true;
      try {
        cleanup();
      } catch { /* Cleanup does not change native closure. */ }
    };
    const finish = (value: AdShowResult) => {
      if (!delivered) {
        delivered = true;
        resolve(value);
      }
    };
    const eligibility = (): AdShowResult['eligibility'] => {
      if (request.format === 'interstitial') {
        return 'not-applicable';
      }
      return earned === undefined ? 'unknown' : 'eligible';
    };
    const uncertain = () => {
      if (closed || owned.state === 'unknown') {
        return;
      }
      owned.state = 'unknown';
      emit({ type: 'unknown' });
      finish(
        makeResult({
          outcome: 'pending',
          presentation: 'unknown',
          eligibility: eligibility(),
          reason: 'outcome-unknown',
          ...(earned === undefined ? {} : { evidence: earned }),
        }),
      );
    };
    const close = (failed: boolean) => {
      if (closed) {
        return;
      }
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      release();
      legacyPhase(false);
      emit(failed ? { type: 'failed', reason: 'transient-failure' } : { type: 'closed' });
      if (failed && !started && earned === undefined) {
        finish(noStart('failed', 'transient-failure'));
      } else {
        finish(
          makeResult({
            outcome: failed ? 'failed' : 'shown',
            presentation: 'closed',
            eligibility: eligibility(),
            ...(failed ? { reason: 'transient-failure' } : {}),
            ...(earned === undefined ? {} : { evidence: earned }),
          }),
        );
      }
      // Failure before presentation proves no earning is forthcoming. After a
      // started presentation, retain the scoped callback for a delayed reward.
      if (failed && !started && earned === undefined) {
        cleaned = true;
        if (cleanup !== undefined) {
          try {
            cleanup();
          } catch { /* Isolate cleanup. */ }
        }
      } else {
        clean();
      }
    };
    const startedEvent = () => {
      if (closed) {
        return;
      }
      if (!started) {
        started = true;
        owned.state = 'open';
        emit({ type: 'started' });
      }
      if (!displayTimerArmed) {
        displayTimerArmed = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(uncertain, input.displayTimeoutMs);
      }
    };
    legacyPhase(true);
    emit({ type: 'requested' });
    timer = setTimeout(uncertain, input.requestTimeoutMs);
    try {
      cleanup = sdk({
        options: { adGroupId: group },
        onEvent(event) {
          switch (event.type) {
            case 'requested':
              if (!closed && !started) { if (timer !== undefined) { clearTimeout(timer); } timer = setTimeout(uncertain, Math.min(input.startTimeoutMs, Math.max(0, input.requestTimeoutMs - (Date.now() - startedAt)))); }
              break;
            case 'show': case 'impression': case 'clicked':
              startedEvent();
              break;
            case 'userEarnedReward':
              if (request.format !== 'rewarded' || earned !== undefined || cleaned) { break; }
              if (!closed) { startedEvent(); }
              earned = { schema: 'apps-in-toss.rewarded-ad.callback.v1', payload: { event: 'user-earned-reward', correlationId: request.idempotencyKey, placementId: group } };
              emit({ type: 'reward-earned', evidence: earned });
              clean();
              break;
            case 'dismissed':
              close(false);
              break;
            case 'failedToShow':
              close(true);
              break;
          }
        },
        // A bridge error does not prove the native UI never opened.
        onError() { uncertain(); },
      });
      if (cleaned) {
        try {
          cleanup();
        } catch { /* Isolate synchronous terminal cleanup. */ }
      } else {
        clean();
      }
    } catch {
      uncertain();
    }
    return result;
  }
  return {
    id,
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'delayed',
    getAvailability: async (request) => availability(request),
    async preload(request) {
      const available = availability(request);
      if (available.state !== 'available') {
        return {
          status: 'unavailable',
          ...(available.reason === undefined ? {} : { reason: available.reason }),
        };
      }
      const group = input.groups.get(request.placementId);
      if (group === undefined) {
        return { status: 'unavailable', reason: 'configuration-required' };
      }
      try {
        await input.prepare(group);
        return { status: 'ready' };
      } catch {
        return { status: 'failed', reason: 'transient-failure' };
      }
    },
    show: (request) => show(request, false),
    showLegacy: (request) => show(request, true),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

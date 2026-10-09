import type {
  PlatformEvidenceEnvelope,
  PlatformGateway,
  PlatformPurchasePresentationEvent,
  PurchaseResult,
} from '@mpgd/platform';
import type { GameServicesRewardedAdResult } from '@mpgd/game-services/operations';
import {
  assertAdAvailability,
  assertAdPreparationResult,
  assertAdPresentationEvent,
  assertAdShowInput,
  assertAdShowResult,
  createAdSession,
  reduceAdSession,
  toAdAdapter,
  type AdAvailability,
  type AdPlacementInput,
  type AdPresentationEvent,
  type AdProvider,
  type AdReason,
  type AdSessionSnapshot,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';

import { observe, type ObserverErrorHandler } from '../observers.js';
import {
  PresentationExecutionError,
  type FullScreenPresentationLease,
  type FullScreenPresentationScope,
} from '../presentation/index.js';

/** Scheduling is injected so the runtime remains usable without DOM or Node globals. */
export interface AdWaitDeadline {
  readonly milliseconds: number;
  schedule(callback: () => void, milliseconds: number): () => void;
}
export interface AdClaimEvidenceObservation {
  readonly input: AdShowInput;
  readonly evidence: PlatformEvidenceEnvelope;
  readonly eligibility: 'eligible' | 'unknown';
}

/** Connect late SDK candidates to the reserved journal operation, without reopening UI. */
export function createAdClaimEvidenceRecoveryObserver(input: {
  readonly recovery: {
    recoverRewardResult(idempotencyKey: string, reward: { readonly status: 'pending'; readonly rewardGranted: false; readonly evidence: PlatformEvidenceEnvelope }): Promise<GameServicesRewardedAdResult>;
  };
  /** Application-owned settlement observation, never a view-scoped SDK grant callback. */
  readonly onResult?: (request: AdShowInput, result: GameServicesRewardedAdResult) => void | Promise<void>;
}): (observation: AdClaimEvidenceObservation) => Promise<void> {
  const recover = input.recovery.recoverRewardResult.bind(input.recovery);
  return async (observation) => {
    const request = assertAdShowInput(observation.input);
    if (request.format !== 'rewarded' || (observation.eligibility !== 'eligible' && observation.eligibility !== 'unknown')) {
      throw new TypeError('Late claim observation must belong to a rewarded invocation.');
    }
    const result = assertAdShowResult({
      providerId: 'claim-recovery',
      invocationId: request.invocationId,
      format: 'rewarded',
      outcome: 'pending',
      presentation: 'unknown',
      eligibility: 'unknown',
      reason: 'outcome-unknown',
      claimEvidence: observation.evidence,
    });
    if (result.claimEvidence === undefined) {
      throw new TypeError('Late claim observation lacks evidence.');
    }
    const settled = await recover(
      request.idempotencyKey,
      Object.freeze({ status: 'pending', rewardGranted: false, evidence: result.claimEvidence }),
    );
    await input.onResult?.(request, settled);
  };
}
export interface CoordinatedAdProvider extends AdProvider {
  /** Detach projections and reject new calls; native terminal/reward observers remain while needed. */
  dispose(): void;
}
interface Flight {
  readonly input: AdShowInput;
  readonly fingerprint: string;
  readonly promise: Promise<AdShowResult>;
  readonly resolve: (result: AdShowResult) => void;
  session: AdSessionSnapshot;
  lease?: FullScreenPresentationLease;
  claimEvidence?: PlatformEvidenceEnvelope | undefined;
  lastClaimFingerprint?: string;
  lastLateResultFingerprint?: string;
  hasObservedCandidate?: boolean;
  called: boolean;
  delivered: boolean;
  cancelWait: () => void;
}

export function createCoordinatedAdProvider(input: {
  readonly provider: AdProvider;
  readonly presentation: FullScreenPresentationScope;
  readonly canShow?: (placement: AdPlacementInput) => boolean;
  readonly deadline?: AdWaitDeadline;
  readonly maxRememberedInvocations?: number;
  readonly onObserverError?: ObserverErrorHandler;
  /** Application-owned claim/journal observer, never a grant callback. Survives view disposal. */
  readonly onClaimEvidence?: (observation: AdClaimEvidenceObservation) => void | Promise<void>;
  /** Application-owned provider settlement after a caller deadline; never a UI callback. */
  readonly onLateResult?: (observation: { readonly input: AdShowInput; readonly result: AdShowResult }) => void | Promise<void>;
}): CoordinatedAdProvider {
  const provider = input.provider;
  // Validate protocol metadata before installing any external observer.
  toAdAdapter(provider);
  const id = provider.id;
  const protocol = provider.protocol;
  const protocolVersion = provider.protocolVersion;
  const rewardSignal = provider.rewardSignal;
  const presentationAudio = provider.presentationAudio;
  const capacity = input.maxRememberedInvocations ?? 1024;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) {
    throw new RangeError('maxRememberedInvocations must be from 1 to 10000.');
  }
  const deadline = input.deadline;
  if (deadline !== undefined && (!Number.isSafeInteger(deadline.milliseconds) || deadline.milliseconds < 1
    || typeof deadline.schedule !== 'function')) {
    throw new TypeError('Invalid advertising wait deadline.');
  }
  const flights = new Map<string, Flight>();
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  const outputSequences = new Map<string, number>();
  let disposed = false;
  let detached = false;

  function emit(flight: Flight, event: Omit<AdPresentationEvent, 'providerId' | 'invocationId' | 'sequence'>): void {
    const sequence = (outputSequences.get(flight.input.invocationId) ?? 0) + 1;
    outputSequences.set(flight.input.invocationId, sequence);
    const published = assertAdPresentationEvent({
      ...event,
      providerId: id,
      invocationId: flight.input.invocationId,
      sequence,
    });
    for (const listener of [...listeners]) {
      observe(() => listener(published), input.onObserverError);
    }
  }
  function evidence(flight: Flight, candidate: PlatformEvidenceEnvelope, eligibility: 'eligible' | 'unknown'): void {
    if (!flight.delivered) {
      return;
    }
    const fingerprint = JSON.stringify([
      eligibility,
      candidate.schema,
      Object.entries(candidate.payload).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    if (fingerprint === flight.lastClaimFingerprint) {
      return;
    }
    flight.lastClaimFingerprint = fingerprint;
    observe(
      () =>
        input.onClaimEvidence?.(
          Object.freeze({ input: flight.input, evidence: candidate, eligibility }),
        ),
      input.onObserverError,
    );
  }
  function lateResult(flight: Flight, result: AdShowResult): void {
    if (!flight.delivered || flight.hasObservedCandidate && (result.eligibility === 'not-earned' || result.presentation === 'not-started')) {
      return;
    }
    const fingerprint = JSON.stringify(result);
    if (flight.lastLateResultFingerprint === fingerprint) {
      return;
    }
    flight.lastLateResultFingerprint = fingerprint;
    observe(
      () => input.onLateResult?.(Object.freeze({ input: flight.input, result })),
      input.onObserverError,
    );
  }
  function maybeDetach(): void {
    if (!disposed || detached || [...flights.values()].some((flight) => !flight.delivered
      || flight.session.presentation === 'unknown' || flight.session.presentation === 'open'
      || flight.session.presentation === 'closed' && flight.session.eligibility === 'unknown' && rewardSignal === 'delayed')) {
      return;
    }
    detached = true;
    if (unsubscribe !== undefined) {
      observe(unsubscribe, input.onObserverError);
    }
  }
  function updateLease(flight: Flight): void {
    if (flight.session.presentation === 'closed' || flight.session.terminal && flight.session.presentation === 'not-started') {
      flight.lease?.confirmClosed();
    } else if (flight.session.presentation === 'unknown') {
      flight.lease?.markUnknown();
    } else if (flight.session.presentation === 'open') {
      flight.lease?.markStarted();
    }
  }
  const unsubscribe = provider.subscribe((event) => {
    observe(() => {
      const flight = flights.get(event.invocationId);
      if (flight === undefined || !flight.called || event.providerId !== id) {
        return;
      }
      const previous = flight.session;
      const next = reduceAdSession(previous, event);
      if (next === previous) {
        return;
      }
      flight.session = next;
      flight.claimEvidence = next.claimEvidence;
      flight.hasObservedCandidate ||= next.evidence !== undefined || next.claimEvidence !== undefined;
      updateLease(flight);
      if (event.type === 'failed' && next.presentation === 'not-started' && !next.started
        && previous.evidence === undefined && previous.claimEvidence === undefined) {
        lateResult(flight, assertAdShowResult({ providerId: id, invocationId: flight.input.invocationId, format: flight.input.format,
          outcome: 'failed', presentation: 'not-started', eligibility: flight.input.format === 'rewarded' ? 'not-earned' : 'not-applicable', reason: event.reason }));
      }
      if (!previous.terminal || event.type === 'reward-earned' && next.evidence !== previous.evidence) {
        if (event.type !== 'reward-earned' || next.evidence !== previous.evidence) {
          emit(flight, event);
        }
      }
      if (event.type === 'reward-earned' && next.evidence !== previous.evidence && next.evidence !== undefined) {
        evidence(flight, flight.claimEvidence ?? next.evidence, 'eligible');
      }
      if (event.type === 'requested' && next.claimEvidence !== undefined && next.claimEvidence !== previous.claimEvidence) {
        evidence(
          flight,
          next.claimEvidence,
          next.eligibility === 'eligible' ? 'eligible' : 'unknown',
        );
      }
      maybeDetach();
    }, input.onObserverError);
  });

  function placement(supplied: AdPlacementInput): AdPlacementInput {
    const request = assertAdShowInput({
      ...supplied,
      invocationId: 'availability',
      idempotencyKey: 'availability',
    });
    return Object.freeze({ placementId: request.placementId, format: request.format });
  }
  async function getAvailability(supplied: AdPlacementInput): Promise<AdAvailability> {
    const request = placement(supplied);
    if (disposed || input.presentation.getSnapshot().status === 'disposed') {
      return { state: 'action-required', reason: 'action-required' };
    }
    if (input.canShow?.(request) === false) {
      return {
        state: 'temporarily-unavailable',
        reason: 'policy-disabled',
      };
    }
    if (input.presentation.getSnapshot().owner !== undefined) {
      return {
        state: 'temporarily-unavailable',
        reason: 'busy',
      };
    }
    return assertAdAvailability(await provider.getAvailability(request));
  }
  function unavailable(request: AdShowInput, reason: AdReason): AdShowResult {
    return assertAdShowResult({
      providerId: id,
      invocationId: request.invocationId,
      format: request.format,
      outcome: 'unavailable',
      presentation: 'not-started',
      eligibility: request.format === 'rewarded' ? 'not-earned' : 'not-applicable',
      reason,
    });
  }
  function availabilityReason(value: AdAvailability): AdReason {
    if (value.reason !== undefined) {
      return value.reason;
    }
    if (value.state === 'configuration-required' || value.state === 'action-required') {
      return value.state;
    }
    return value.state === 'temporarily-unavailable' ? 'transient-failure' : 'unsupported';
  }
  function observation(flight: Flight): AdShowResult {
    const session = flight.session;
    if (session.terminal && session.presentation === 'not-started') {
      return assertAdShowResult({
        providerId: id,
        invocationId: flight.input.invocationId,
        format: flight.input.format,
        outcome: 'failed',
        presentation: 'not-started',
        eligibility: session.eligibility,
        reason: session.reason ?? 'transient-failure',
      });
    }
    const closed = session.presentation === 'closed';
    const shown = session.started || session.eligibility === 'eligible';
    let outcome: AdShowResult['outcome'] = 'pending';
    if (closed) {
      outcome = shown ? 'shown' : 'skipped';
    }
    return assertAdShowResult({
      providerId: id, invocationId: flight.input.invocationId, format: flight.input.format,
      outcome, presentation: closed ? 'closed' : 'unknown', eligibility: session.eligibility,
      ...(!closed ? { reason: 'outcome-unknown' } : {}),
      ...(session.evidence === undefined ? {} : { evidence: session.evidence }),
      ...(flight.claimEvidence === undefined || session.eligibility === 'not-earned' || session.eligibility === 'not-applicable'
        ? {} : { claimEvidence: flight.claimEvidence }),
    });
  }
  function deliver(flight: Flight, result: AdShowResult): void {
    if (flight.delivered) {
      return;
    }
    flight.delivered = true;
    observe(flight.cancelWait, input.onObserverError);
    flight.resolve(result);
    if (!flight.called) {
      flights.delete(flight.input.invocationId);
    }
    maybeDetach();
  }
  function unknown(flight: Flight): void {
    if (!flight.session.terminal && flight.session.presentation !== 'closed') {
      flight.session = Object.freeze({ ...flight.session, presentation: 'unknown', reason: 'outcome-unknown' });
      updateLease(flight);
      emit(flight, { type: 'unknown' });
    }
    deliver(flight, observation(flight));
  }
  function finish(flight: Flight, supplied: AdShowResult): void {
    const result = assertAdShowResult(supplied);
    if (result.providerId !== id || result.invocationId !== flight.input.invocationId || result.format !== flight.input.format) {
      throw new TypeError('Advertising result belongs to another invocation.');
    }
    if (result.presentation === 'not-started' && (flight.session.started || flight.session.eligibility === 'eligible')) {
      throw new TypeError('Advertising result contradicts native presentation observations.');
    }
    const previous = flight.session;
    flight.hasObservedCandidate ||= previous.evidence !== undefined || previous.claimEvidence !== undefined || result.evidence !== undefined || result.claimEvidence !== undefined;
    if (previous.terminal && previous.presentation === 'not-started' && result.presentation !== 'not-started') {
      // A less specific Promise cannot reopen a definitively failed native request.
      const terminal = observation(flight);
      lateResult(flight, terminal);
      deliver(flight, terminal);
      maybeDetach();
      return;
    }
    const closed = previous.presentation === 'closed' || result.presentation === 'closed';
    let eligibility = result.eligibility;
    if (previous.eligibility === 'eligible') {
      eligibility = 'eligible';
    } else if (previous.terminal && rewardSignal === 'immediate') {
      eligibility = previous.eligibility;
    }
    const rewardEvidence = eligibility === 'eligible'
      ? (previous.evidence ?? result.evidence)
      : undefined;
    const { evidence: previousEvidence, reason: previousReason, claimEvidence: previousClaimEvidence, ...base } = previous;
    void previousEvidence;
    void previousReason;
    void previousClaimEvidence;
    if (eligibility !== 'eligible' && eligibility !== 'unknown' || result.presentation === 'not-started') {
      flight.claimEvidence = undefined;
    } else if (result.claimEvidence !== undefined) {
      flight.claimEvidence ??= result.claimEvidence;
    }
    // Native sequence watermarks belong to the native event stream, never synthetic result/deadline observations.
    flight.session = Object.freeze({
      ...base, presentation: closed ? 'closed' : result.presentation,
      terminal: closed || result.presentation === 'not-started',
      started: previous.started || result.outcome === 'shown',
      eligibility,
      ...(rewardEvidence === undefined ? {} : { evidence: rewardEvidence }),
      ...(flight.claimEvidence === undefined ? {} : { claimEvidence: flight.claimEvidence }),
    });
    if (result.presentation === 'not-started') {
      flight.lease?.confirmClosed();
    } else {
      updateLease(flight);
    }
    if (closed && previous.presentation !== 'closed') {
      emit(flight, { type: 'closed' });
    }
    const candidate = flight.claimEvidence ?? rewardEvidence;
    if (candidate !== undefined && (eligibility === 'eligible' || eligibility === 'unknown')) {
      evidence(flight, candidate, eligibility);
    }
    const { evidence: suppliedEvidence, claimEvidence: suppliedClaimEvidence, ...resultBase } = result;
    void suppliedEvidence;
    void suppliedClaimEvidence;
    let outcome = result.outcome;
    if (closed && eligibility === 'eligible') {
      outcome = 'shown';
    }
    if (closed && outcome === 'pending') {
      outcome = flight.session.started ? 'shown' : 'skipped';
    }
    const settled = assertAdShowResult({
      ...resultBase,
      outcome,
      presentation: flight.session.presentation,
      eligibility,
      ...(rewardEvidence === undefined ? {} : { evidence: rewardEvidence }),
      ...(flight.claimEvidence === undefined ? {} : { claimEvidence: flight.claimEvidence }),
    });
    lateResult(flight, settled);
    deliver(flight, settled);
    maybeDetach();
  }
  function show(supplied: AdShowInput): Promise<AdShowResult> {
    const request = assertAdShowInput(supplied);
    if (disposed || input.presentation.getSnapshot().status === 'disposed') {
      return Promise.reject(new PresentationExecutionError('disposed'));
    }
    const fingerprint = JSON.stringify([
      request.placementId,
      request.format,
      request.idempotencyKey,
    ]);
    const prior = flights.get(request.invocationId);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? prior.promise
        : Promise.reject(new PresentationExecutionError('key-conflict'));
    }
    if (flights.size >= capacity) {
      return Promise.reject(new PresentationExecutionError('history-full'));
    }
    let resolve!: Flight['resolve'];
    const promise = new Promise<AdShowResult>((done) => {
      resolve = done;
    });
    const flight: Flight = {
      input: request,
      fingerprint,
      promise,
      resolve,
      called: false,
      delivered: false,
      cancelWait: () => {},
      session: createAdSession({
        providerId: id,
        invocationId: request.invocationId,
        format: request.format,
        rewardSignal: rewardSignal,
      }),
    };
    flights.set(request.invocationId, flight);
    void (async () => {
      try {
        const available = await getAvailability(request);
        if (available.state !== 'available') {
          deliver(flight, unavailable(request, availabilityReason(available)));
          return;
        }
        // Availability may await an SDK check; arbitrate again immediately before display.
        if (disposed || input.presentation.getSnapshot().status === 'disposed') { throw new PresentationExecutionError('disposed'); }
        try { flight.lease = input.presentation.acquire({ kind: request.format, invocationId: request.invocationId, audioStart: presentationAudio ?? 'requested' }); } catch (error) {
          if (error instanceof PresentationExecutionError && error.code === 'busy') {
            deliver(flight, unavailable(request, 'busy'));
            return;
          }
          throw error;
        }
        if (disposed || input.presentation.getSnapshot().status === 'disposed') { throw new PresentationExecutionError('disposed'); }
        flight.called = true;
        const native = Promise.resolve(provider.show(request));
        void native.then((result) => {
          try { finish(flight, result); } catch { unknown(flight); }
        }, () => unknown(flight));
        if (deadline !== undefined && !flight.delivered) {
          const cancel = deadline.schedule(() => unknown(flight), deadline.milliseconds);
          if (typeof cancel !== 'function') { throw new TypeError('Invalid advertising deadline cleanup.'); }
          flight.cancelWait = cancel;
          if (flight.delivered) { observe(cancel, input.onObserverError); }
        }
      } catch {
        if (flight.called) { unknown(flight); } else {
          flight.lease?.confirmClosed();
          deliver(flight, assertAdShowResult({ ...unavailable(request, 'transient-failure'), outcome: 'failed' }));
        }
      }
    })();
    return promise;
  }
  return Object.freeze({
    id: id, protocol: protocol, protocolVersion: protocolVersion, rewardSignal: rewardSignal,
    ...(presentationAudio === undefined ? {} : { presentationAudio }),
    getAvailability,
    async preload(supplied) {
      const request = placement(supplied);
      try {
        const available = await getAvailability(request);
        if (available.state !== 'available') { return { status: 'unavailable', reason: availabilityReason(available) }; }
        if (input.presentation.getSnapshot().owner !== undefined) { return { status: 'unavailable', reason: 'busy' }; }
        return assertAdPreparationResult(await provider.preload(request));
      } catch { return { status: 'failed', reason: 'transient-failure' }; }
    },
    show,
    subscribe(listener) {
      if (disposed) { throw new PresentationExecutionError('disposed'); }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): void { disposed = true; listeners.clear(); maybeDetach(); },
  } satisfies CoordinatedAdProvider);
}

export type PurchasePresentationEvent = PlatformPurchasePresentationEvent;
export interface CoordinatedPlatformGateway extends PlatformGateway {
  dispose(): void;
}
interface PurchaseFlight {
  readonly key: string;
  readonly promise: Promise<PurchaseResult>;
  lease?: FullScreenPresentationLease;
  called: boolean;
  settled: boolean;
  closed: boolean;
  started: boolean;
  sequence: number;
}

/** Games receive this gateway so direct gateway calls use the same native surface. */
export function createCoordinatedPlatformGateway(input: Parameters<typeof createCoordinatedAdProvider>[0] & {
  readonly gateway: PlatformGateway;
  /** Trusted native facts only. A purchase business result alone defaults to unknown. */
  readonly classifyPurchasePresentation?: (result: PurchaseResult) => 'closed' | 'not-started' | 'unknown';
  readonly purchasePresentation?: { subscribe(listener: (event: PurchasePresentationEvent) => void): () => void };
}): CoordinatedPlatformGateway {
  const ads = createCoordinatedAdProvider(input);
  const source = input.gateway.commerce;
  const history = new Map<string, string>();
  const purchases = new Map<string, PurchaseFlight>();
  let last: PurchaseFlight | undefined;
  let disposed = false;
  let detached = false;
  function maybeDetach(): void {
    if (!disposed || detached || [...purchases.values()].some((flight) => flight.called && !flight.closed)) {
      return;
    }
    detached = true;
    if (unsubscribe !== undefined) {
      observe(unsubscribe, input.onObserverError);
    }
  }
  function close(flight: PurchaseFlight): void {
    flight.closed = true;
    flight.lease?.confirmClosed();
    if (flight.settled) {
      purchases.delete(flight.key);
    }
    maybeDetach();
  }
  const purchasePresentation = input.purchasePresentation ?? input.gateway.commerce.presentation;
  const unsubscribe = purchasePresentation?.subscribe((event) => {
    observe(() => {
      const flight = purchases.get(event.idempotencyKey);
      if (flight === undefined || !flight.called || flight.closed) {
        return;
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= flight.sequence) {
        return;
      }
      if (!['open', 'closed', 'not-started', 'unknown'].includes(event.state)) {
        return;
      }
      flight.sequence = event.sequence;
      if (event.state === 'not-started' && flight.started) {
        flight.lease?.markUnknown();
        return;
      }
      if (event.state === 'closed' || event.state === 'not-started') {
        close(flight);
      } else if (event.state === 'open') {
        flight.started = true;
        flight.lease?.markStarted();
      } else {
        flight.lease?.markUnknown();
      }
    }, input.onObserverError);
  });
  const commerce = forward(source, {
    purchase(supplied: Parameters<typeof source.purchase>[0]): Promise<PurchaseResult> {
      if (disposed) { return Promise.reject(new PresentationExecutionError('disposed')); }
      const request = Object.freeze({ productId: supplied.productId, source: supplied.source, idempotencyKey: supplied.idempotencyKey });
      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '' || request.idempotencyKey.length > 512
        || typeof request.productId !== 'string' || request.productId.trim() === '' || request.productId.length > 512
        || !['shop', 'stage_fail', 'result', 'event'].includes(request.source)) {
        return Promise.reject(new TypeError('Invalid purchase presentation input.'));
      }
      const key = request.idempotencyKey;
      const fingerprint = JSON.stringify([request.productId, request.source]);
      const prior = history.get(key);
      if (prior !== undefined) {
        if (prior !== fingerprint) { return Promise.reject(new PresentationExecutionError('key-conflict')); }
        const flight = purchases.get(key) ?? (last?.key === key ? last : undefined);
        return flight?.promise ?? Promise.reject(new PresentationExecutionError('already-completed'));
      }
      if (history.size >= (input.maxRememberedInvocations ?? 1024)) {
        return Promise.reject(new PresentationExecutionError('history-full'));
      }
      const flight: PurchaseFlight = {
        key, called: false, settled: false, closed: false, started: false, sequence: 0,
        promise: Promise.resolve().then(async () => {
          try {
            if (disposed) { throw new PresentationExecutionError('disposed'); }
            flight.lease = input.presentation.acquire({ kind: 'purchase', invocationId: key });
            if (disposed) { close(flight); throw new PresentationExecutionError('disposed'); }
            flight.called = true;
            const result = await source.purchase(request);
            const state = input.classifyPurchasePresentation?.(result) ?? 'unknown';
            if (state !== 'closed' && state !== 'not-started' && state !== 'unknown') {
              throw new TypeError('Invalid purchase presentation observation.');
            }
            if (state === 'not-started' && flight.started && !flight.closed) {
              throw new TypeError('Purchase observation contradicts native presentation.');
            }
            if (state === 'unknown') { if (!flight.closed) { flight.lease.markUnknown(); } } else { close(flight); }
            return result;
          } catch (error) {
            if (flight.called && !flight.closed) { flight.lease?.markUnknown(); }
            throw error;
          } finally {
            flight.settled = true;
            if (!flight.called) { history.delete(key); purchases.delete(key); } else {
              last = flight;
              if (flight.closed) { purchases.delete(key); }
            }
            maybeDetach();
          }
        }),
      };
      history.set(key, fingerprint);
      purchases.set(key, flight);
      void flight.promise.catch(() => {});
      return flight.promise;
    },
  });
  return forward(input.gateway, {
    ads: forward(input.gateway.ads, toAdAdapter(ads)),
    commerce,
    dispose(): void {
      disposed = true;
      ads.dispose();
      maybeDetach();
    },
  }) as CoordinatedPlatformGateway;
}

/** Preserve prototype methods and their receivers, including optional port methods. */
function forward<T extends object>(source: T, overrides: Partial<T> | object): T {
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  return new Proxy({} as T, {
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) {
        return Reflect.get(overrides, key);
      }
      const value: unknown = Reflect.get(source, key, source);
      if (typeof value !== 'function') {
        return value;
      }
      const prior = methods.get(key);
      if (prior?.original === value) {
        return prior.bound;
      }
      const bound: unknown = value.bind(source);
      methods.set(key, { original: value, bound });
      return bound;
    },
    has: (_target, key) => Object.hasOwn(overrides, key) || key in source,
    ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Reflect.ownKeys(overrides)])],
    getOwnPropertyDescriptor: (_target, key) =>
      key in source || Object.hasOwn(overrides, key)
        ? { configurable: true, enumerable: true, writable: false, value: undefined }
        : undefined,
    getPrototypeOf: () => Reflect.getPrototypeOf(source),
  });
}

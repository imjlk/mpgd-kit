import {
  commercePresentationAttempt,
  type PlatformGateway,
  type PlatformPurchasePresentationEvent,
} from '@mpgd/platform';
import { forward } from '../forward.js';
import { observe, type ObserverErrorHandler } from '../observers.js';
import { coordinatorRefusalAnswers, type CoordinatorRefusal } from './refusals.js';
import {
  PresentationExecutionError,
  type FullScreenPresentationLease,
  type FullScreenPresentationScope,
} from '../presentation/index.js';

// Derived from the gateway so this entry never imports the typia-backed
// `@mpgd/platform/commerce` module (see the headless type-check).
type CommerceProviderSource = NonNullable<PlatformGateway['commerce']>;
type PurchaseRequestInput = Parameters<CommerceProviderSource['requestPurchase']>[0];
type PurchaseOutcome = Awaited<ReturnType<CommerceProviderSource['requestPurchase']>>;
// The failed variant shares its member with `cancelled`, so narrow by the error field.
type PurchaseFailure = Extract<PurchaseOutcome, { readonly error: unknown }> & { readonly outcome: 'failed' };
type HistoryEntry = { fingerprint: string; sequence: number; retryable: boolean; attempt: number; nativeSequence: number };
interface PurchaseFlight {
  readonly key: string;
  readonly promise: Promise<PurchaseOutcome>;
  lease?: FullScreenPresentationLease;
  called: boolean;
  settled: boolean;
  closed: boolean;
  started: boolean;
  sequence: number;
  notStarted: boolean;
  /** The settled result or rejection was explicitly retryable, independent of presentation timing. */
  failedRetryable: boolean;
  retryable: boolean;
  attempt: number;
}

export type CoordinatedCommerceProvider = CommerceProviderSource & { dispose(): void };
export interface CoordinatedCommerceOptions {
  readonly provider: CommerceProviderSource;
  readonly presentation: FullScreenPresentationScope;
  /** Native surface facts, never transaction updates or generic application resume events. */
  readonly purchasePresentation?: { subscribe(listener: (event: PlatformPurchasePresentationEvent) => void): () => void };
  /** Only use where the provider contract independently proves UI closure/non-launch. */
  readonly classifyPurchasePresentation?: (result: PurchaseOutcome) => 'closed' | 'not-started' | 'unknown';
  readonly maxRememberedInvocations?: number;
  /**
   * Hears each call this coordinator refuses itself, before the provider runs
   * (and before its `not-started` fact and retryable answer): `busy`
   * (`PRESENTATION_BUSY`), `disposed` or `history-full`.
   */
  readonly onRefusal?: (refusal: CoordinatedPurchaseRefusal) => void;
  readonly onObserverError?: ObserverErrorHandler;
}
export interface CoordinatedPurchaseRefusal {
  readonly idempotencyKey: string;
  readonly reason: CoordinatorRefusal;
}

/** Coordinate checkout without requiring an advertising provider or a complete gateway.
 * Missing native facts disable new purchases; recovery and finalization still forward.
 * This owns UI exclusion, not authoritative fulfillment or persisted idempotency.
 */
export function createCoordinatedCommerceProvider(input: CoordinatedCommerceOptions): CoordinatedCommerceProvider {
  const source = input.provider;
  const purchasePresentation = input.purchasePresentation ?? source.presentation;
  const capacity = input.maxRememberedInvocations ?? 1024;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError('Invalid purchase history capacity.');
  }
  const history = new Map<string, HistoryEntry>();
  const listeners = new Set<(event: PlatformPurchasePresentationEvent) => void>();
  function emit(key: string, sequence: number, state: PlatformPurchasePresentationEvent['state']): void {
    const event = Object.freeze({ idempotencyKey: key, sequence, state });
    for (const listener of [...listeners]) {
      observe(() => listener(event), input.onObserverError);
    }
  }
  function publish(flight: PurchaseFlight, state: PlatformPurchasePresentationEvent['state']): void {
    const entry = history.get(flight.key);
    if (entry !== undefined) {
      emit(flight.key, ++entry.sequence, state);
    }
  }
  /**
   * Answers a call the coordinator refused before the provider ran as data, like
   * a provider's own pre-launch refusal: a `not-started` fact first, then a
   * retryable failure, so a reconciler keeps the key for a same-key retry.
   */
  function refuse(key: string, entry: HistoryEntry | undefined, reason: CoordinatorRefusal): PurchaseFailure {
    const onRefusal = input.onRefusal;
    if (onRefusal !== undefined) {
      const refusal = Object.freeze({ idempotencyKey: key, reason });
      observe(() => onRefusal(refusal), input.onObserverError);
    }
    if (entry === undefined) {
      // Not remembered (history full): a one-off fact, as for a first call.
      emit(key, 1, 'not-started');
    } else {
      entry.retryable = true;
      emit(key, ++entry.sequence, 'not-started');
    }
    const answer = coordinatorRefusalAnswers[reason];
    return Object.freeze({
      outcome: 'failed',
      error: Object.freeze({ ...answer, retryable: true }),
    }) as PurchaseFailure;
  }
  /** Frees the oldest settled, closed, non-retryable key; in-flight, retryable and the last result stay. */
  function evictSettled(): boolean {
    for (const [key, entry] of history) {
      if (!entry.retryable && !purchases.has(key) && last?.key !== key) {
        history.delete(key);
        return true;
      }
    }
    return false;
  }
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
    // A listener that retries on this fact may already own the key.
    if (flight.settled && purchases.get(flight.key) === flight) {
      purchases.delete(flight.key);
    }
    maybeDetach();
  }
  const unsubscribe = purchasePresentation?.subscribe((event) => {
    observe(() => {
      const flight = purchases.get(event.idempotencyKey);
      if (flight === undefined || !flight.called || flight.closed) {
        return;
      }
      if (typeof event.attempt === 'number' && event.attempt !== flight.attempt) {
        return;
      }
      const entry = history.get(flight.key);
      if (entry === undefined) {
        return;
      }
      // Untagged providers keep one increasing sequence. Tagged providers restart
      // it per attempt, so only their own generation uses a local cursor.
      const tagged = typeof event.attempt === 'number';
      const floor = tagged ? flight.sequence : entry.nativeSequence;
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= floor) {
        return;
      }
      if (!['open', 'closed', 'not-started', 'unknown'].includes(event.state)) {
        return;
      }
      if (tagged) { flight.sequence = event.sequence; } else { entry.nativeSequence = event.sequence; }
      if (event.state === 'not-started' && flight.started) {
        flight.lease?.markUnknown();
        publish(flight, 'unknown');
        return;
      }
      if (event.state === 'closed' || event.state === 'not-started') {
        flight.notStarted = event.state === 'not-started';
        // A trusted non-launch can arrive after the SDK result. It releases the
        // key only for a retryable failure that never opened; it never grants.
        if (flight.settled && flight.notStarted && flight.failedRetryable && !flight.started) {
          flight.retryable = true;
          const remembered = history.get(flight.key);
          if (remembered !== undefined) { remembered.retryable = true; }
        }
        publish(flight, event.state);
        close(flight);
      } else if (event.state === 'open') {
        flight.started = true;
        flight.lease?.markStarted();
        publish(flight, 'open');
      } else {
        flight.lease?.markUnknown();
        publish(flight, 'unknown');
      }
    }, input.onObserverError);
  });
  const commerce = forward(source, {
    presentation: {
      subscribe(listener: (event: PlatformPurchasePresentationEvent) => void): () => void {
        // After disposal a listener still hears the facts of the calls it makes
        // (each refused `not-started`); subscribing never throws.
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    requestPurchase(supplied: PurchaseRequestInput): Promise<PurchaseOutcome> {
      if (purchasePresentation === undefined && input.classifyPurchasePresentation === undefined) {
        return Promise.reject(new PresentationExecutionError('presentation-unavailable'));
      }
      const suppliedRequest = {
        logicalId: supplied.logicalId,
        source: supplied.source,
        idempotencyKey: supplied.idempotencyKey,
        ...(supplied.offerId === undefined ? {} : { offerId: supplied.offerId }),
        ...(supplied.quantity === undefined ? {} : { quantity: supplied.quantity }),
      };
      if (typeof suppliedRequest.idempotencyKey !== 'string' || suppliedRequest.idempotencyKey.trim() === '' || suppliedRequest.idempotencyKey.length > 512
        || typeof suppliedRequest.logicalId !== 'string' || suppliedRequest.logicalId.trim() === '' || suppliedRequest.logicalId.length > 512
        || !['shop', 'stage_fail', 'result', 'event'].includes(suppliedRequest.source)) {
        return Promise.reject(new TypeError('Invalid purchase presentation input.'));
      }
      const key = suppliedRequest.idempotencyKey;
      const fingerprint = JSON.stringify([suppliedRequest.logicalId, suppliedRequest.source, suppliedRequest.offerId ?? null, suppliedRequest.quantity ?? null]);
      const prior = history.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) { return Promise.reject(new PresentationExecutionError('key-conflict')); }
        const flight = purchases.get(key) ?? (last?.key === key ? last : undefined);
        if (!prior.retryable) { return flight?.promise ?? Promise.reject(new PresentationExecutionError('already-completed')); }
      }
      // Refusals publish on a later turn, as a flight's do, so a listener that
      // retries on the fact never reenters this call.
      if (disposed) {
        if (prior === undefined && (history.size < capacity || evictSettled())) {
          history.set(key, { fingerprint, sequence: 0, retryable: true, attempt: 0, nativeSequence: 0 });
        }
        return Promise.resolve().then(() => refuse(key, history.get(key), 'disposed'));
      }
      if (prior === undefined && history.size >= capacity && !evictSettled()) {
        return Promise.resolve().then(() => refuse(key, undefined, 'history-full'));
      }
      const entry = prior ?? { fingerprint, sequence: 0, retryable: false, attempt: 0, nativeSequence: 0 };
      entry.retryable = false;
      entry.attempt += 1;
      const request = Object.freeze({ ...suppliedRequest, [commercePresentationAttempt]: entry.attempt });
      const flight: PurchaseFlight = {
        key, called: false, settled: false, closed: false, started: false, sequence: 0, notStarted: false, failedRetryable: false, retryable: false, attempt: entry.attempt,
        promise: Promise.resolve().then(async () => {
          try {
            if (disposed) { return refuse(key, entry, 'disposed'); }
            try {
              flight.lease = input.presentation.acquire({ kind: 'purchase', invocationId: key });
            } catch (error) {
              if (error instanceof PresentationExecutionError && (error.code === 'busy' || error.code === 'disposed')) {
                return refuse(key, entry, error.code);
              }
              throw error;
            }
            if (disposed) { close(flight); return refuse(key, entry, 'disposed'); }
            flight.called = true;
            const result = await source.requestPurchase(request);
            const state = input.classifyPurchasePresentation?.(result) ?? 'unknown';
            if (state !== 'closed' && state !== 'not-started' && state !== 'unknown') {
              throw new TypeError('Invalid purchase presentation observation.');
            }
            if (state === 'not-started' && (flight.started || flight.closed && !flight.notStarted)) {
              throw new TypeError('Purchase observation contradicts native presentation.');
            }
            if (!flight.closed) {
              flight.notStarted = state === 'not-started';
              publish(flight, state);
              if (state === 'unknown') { flight.lease.markUnknown(); } else { close(flight); }
            }
            flight.failedRetryable = result.outcome === 'failed' && result.error.retryable === true;
            flight.retryable = flight.failedRetryable && flight.notStarted && !flight.started;
            return result;
          } catch (error) {
            if (flight.called && !flight.closed) { flight.lease?.markUnknown(); }
            if (explicitlyRetryable(error)) {
              flight.failedRetryable = true;
              if (flight.notStarted && !flight.started) { flight.retryable = true; }
            }
            throw error;
          } finally {
            flight.settled = true;
            // A listener may already have retried this key on its `not-started`
            // fact: that replacement owns the key's flight and history entry.
            const current = entry.attempt === flight.attempt;
            if (purchases.get(key) === flight && (!flight.called || flight.closed)) { purchases.delete(key); }
            if (!flight.called) {
              // A refused call published `not-started` under this entry; keep it
              // (retryable) so the key's published sequence keeps increasing.
              if (current) {
                if (prior === undefined && !entry.retryable) { history.delete(key); } else { entry.retryable = true; }
              }
            } else {
              if (current) { entry.retryable = flight.retryable; }
              last = flight;
            }
            maybeDetach();
          }
        }),
      };
      history.set(key, entry);
      purchases.set(key, flight);
      void flight.promise.catch(() => {});
      return flight.promise;
    },
  });
  return forward(commerce, {
    dispose(): void {
      disposed = true;
      maybeDetach();
    },
  }) as CoordinatedCommerceProvider;
}

function explicitlyRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
}

export {
  coordinatorRefusalAnswers,
  matchCoordinatorRefusal,
  type CoordinatorRefusal,
} from './refusals.js';

import type { PlatformGateway, PlatformPurchasePresentationEvent } from '@mpgd/platform';
import { forward } from '../forward.js';
import { observe, type ObserverErrorHandler } from '../observers.js';
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
interface PurchaseFlight {
  readonly key: string;
  readonly promise: Promise<PurchaseOutcome>;
  lease?: FullScreenPresentationLease;
  called: boolean;
  settled: boolean;
  closed: boolean;
  started: boolean;
  sequence: number;
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
  readonly onObserverError?: ObserverErrorHandler;
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
    requestPurchase(supplied: PurchaseRequestInput): Promise<PurchaseOutcome> {
      if (disposed) { return Promise.reject(new PresentationExecutionError('disposed')); }
      if (purchasePresentation === undefined && input.classifyPurchasePresentation === undefined) {
        return Promise.reject(new PresentationExecutionError('presentation-unavailable'));
      }
      const request: PurchaseRequestInput = Object.freeze({
        logicalId: supplied.logicalId,
        source: supplied.source,
        idempotencyKey: supplied.idempotencyKey,
        ...(supplied.offerId === undefined ? {} : { offerId: supplied.offerId }),
        ...(supplied.quantity === undefined ? {} : { quantity: supplied.quantity }),
      });
      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '' || request.idempotencyKey.length > 512
        || typeof request.logicalId !== 'string' || request.logicalId.trim() === '' || request.logicalId.length > 512
        || !['shop', 'stage_fail', 'result', 'event'].includes(request.source)) {
        return Promise.reject(new TypeError('Invalid purchase presentation input.'));
      }
      const key = request.idempotencyKey;
      const fingerprint = JSON.stringify([request.logicalId, request.source, request.offerId ?? null, request.quantity ?? null]);
      const prior = history.get(key);
      if (prior !== undefined) {
        if (prior !== fingerprint) { return Promise.reject(new PresentationExecutionError('key-conflict')); }
        const flight = purchases.get(key) ?? (last?.key === key ? last : undefined);
        return flight?.promise ?? Promise.reject(new PresentationExecutionError('already-completed'));
      }
      if (history.size >= capacity) {
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
            const result = await source.requestPurchase(request);
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
  return forward(commerce, {
    dispose(): void {
      disposed = true;
      maybeDetach();
    },
  }) as CoordinatedCommerceProvider;
}

/** Diagnostics only: a succeeded checkout is not an authoritative entitlement or revenue. */
export interface MonetizationObservation {
  readonly operationId: string;
  readonly operation: 'catalog' | 'purchase' | 'restore' | 'attendance' | 'promotion';
  readonly stage: 'identity' | 'catalog' | 'checkout' | 'verification' | 'fulfillment' | 'confirmation' | 'eligibility' | 'claim' | 'finalization' | 'recovery';
  readonly status: 'requested' | 'succeeded' | 'pending' | 'cancelled' | 'failed' | 'unavailable';
  readonly mode: 'test' | 'live' | 'unknown';
  /** Logical catalog identifier, not a transaction ID, provider receipt or user identifier. */
  readonly productId?: string;
  readonly errorCode?: string;
  /** Null when the supplied clock is invalid, throws or moves before the start. */
  readonly elapsedMs: number | null;
  readonly sequence: number;
}
export type MonetizationObserver = (event: MonetizationObservation) => void | Promise<void>;
export interface MonetizationAttempt {
  stage(stage: MonetizationObservation['stage'], status: MonetizationObservation['status'], errorCode?: string): void;
  finish(stage: MonetizationObservation['stage'], status: Exclude<MonetizationObservation['status'], 'requested'>, errorCode?: string): void;
}

/**
 * Pure, SDK-independent observer lifecycle. Clock and diagnostic-only ID are supplied by the
 * composition root. Never awaits the observer, persists a grant, or reads platform/user data.
 * Invalid diagnostic metadata disables observation; it must not prevent the business operation.
 */
export function createMonetizationAttempt(input: {
  readonly operationId: string;
  readonly operation: MonetizationObservation['operation'];
  readonly stage: MonetizationObservation['stage'];
  readonly mode: MonetizationObservation['mode'];
  readonly productId?: string;
  readonly now: () => number;
  readonly observer?: MonetizationObserver;
}): MonetizationAttempt {
  // Snapshot validated metadata so later caller mutations cannot change an active attempt.
  const { operationId, operation, stage: initialStage, mode, productId, now: clock, observer } = input;
  let sequence = 0;
  let closed = false;
  const readClock = (): number | null => {
    try {
      const value = clock();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const startedAt = readClock();
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(operationId)
    && (productId === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(productId));
  const emit = (stage: MonetizationObservation['stage'], status: MonetizationObservation['status'], errorCode?: string): void => {
    if (!valid || !observer) {
      return;
    }
    const now = readClock();
    const event: MonetizationObservation = {
      operationId,
      operation,
      stage,
      status,
      mode,
      ...(productId === undefined ? {} : { productId }),
      ...(errorCode !== undefined && /^[A-Z][A-Z0-9_]{0,95}$/u.test(errorCode) ? { errorCode } : {}),
      elapsedMs: startedAt === null || now === null || now < startedAt ? null : now - startedAt,
      sequence: sequence++,
    };
    try {
      void Promise.resolve(observer(event)).catch(() => {});
    } catch {
      // Synchronous observers and rejected asynchronous observers cannot affect checkout.
    }
  };
  emit(initialStage, 'requested');
  return {
    stage(stage, status, errorCode) {
      if (!closed) {
        emit(stage, status, errorCode);
      }
    },
    finish(stage, status, errorCode) {
      if (closed) {
        return;
      }
      closed = true;
      emit(stage, status, errorCode);
    },
  };
}

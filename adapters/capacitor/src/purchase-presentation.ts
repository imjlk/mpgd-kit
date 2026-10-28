import type {
  PlatformPurchasePresentationEvent,
  PlatformPurchasePresentationReason,
} from '@mpgd/platform';

// Purchase presentation facts as the adapter publishes them. Internal: the
// package entry re-exports only `purchasePresentationTimeoutMs`.

/**
 * Upper bound on how long one store sheet counts as open without a native
 * `closed` fact. Past it the provider reports `closed` with reason `timeout`,
 * so a lost native observation can pause the game, but never forever. It
 * matches the purchase flow timeout of the OpenIAP Google core (15 minutes).
 */
export const purchasePresentationTimeoutMs = 15 * 60_000;

export type PurchasePresentationListener = (event: PlatformPurchasePresentationEvent) => void;

/** `CommerceProvider.presentation` plus the side that publishes into it. */
export interface PurchasePresentationChannel {
  readonly presentation: {
    subscribe(listener: PurchasePresentationListener): () => void;
  };
  /**
   * Delivers one fact to every current listener, synchronously, numbered
   * with the next `sequence` of this channel (from 1, increasing across every
   * key, so each key's facts increase too). Facts are never buffered: a
   * listener receives the ones published while it is subscribed.
   */
  publish(fact: {
    readonly idempotencyKey: string;
    readonly state: PlatformPurchasePresentationEvent['state'];
    /** A source's attempt generation, kept so a consumer can drop an earlier attempt's fact. */
    readonly attempt?: number;
    readonly reason?: PlatformPurchasePresentationReason;
  }): void;
  clear(): void;
}

export function createPurchasePresentationChannel(): PurchasePresentationChannel {
  const listeners = new Set<PurchasePresentationListener>();
  let sequence = 0;
  return {
    presentation: {
      subscribe(listener) {
        // One entry per call, so the same listener subscribed twice gets two
        // deliveries and two independent unsubscribes.
        const entry: PurchasePresentationListener = (event) => listener(event);
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
        };
      },
    },
    publish(fact) {
      sequence += 1;
      const event: PlatformPurchasePresentationEvent = Object.freeze({
        idempotencyKey: fact.idempotencyKey,
        sequence,
        state: fact.state,
        ...(fact.attempt === undefined ? {} : { attempt: fact.attempt }),
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
      });
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          // A failing listener must not keep a `closed` fact from the others:
          // a consumer that misses it would hold the game paused.
          console.warn('A purchase presentation listener failed.', error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

const presentationReasons: ReadonlySet<string> = new Set<PlatformPurchasePresentationReason>([
  'timeout',
  'interrupted',
  'disposed',
]);

export function isPurchasePresentationReason(
  value: unknown,
): value is PlatformPurchasePresentationReason {
  return typeof value === 'string' && presentationReasons.has(value);
}

/**
 * Drops a relayed fact its source already superseded, before the relay
 * numbers it again: a fact whose `sequence` is not above the last one seen
 * for its key (per `attempt` when the source tags attempts), as the game
 * runtime's coordinator would have done with the source's own numbers.
 */
export function createPresentationSequenceGuard(): (event: PlatformPurchasePresentationEvent) => boolean {
  const cursors = new Map<string, number>();
  return (event) => {
    if (!Number.isSafeInteger(event.sequence)) {
      return false;
    }
    const cursor = typeof event.attempt === 'number'
      ? `${event.idempotencyKey}\u0000${String(event.attempt)}`
      : event.idempotencyKey;
    const last = cursors.get(cursor);
    if (last !== undefined && event.sequence <= last) {
      return false;
    }
    cursors.set(cursor, event.sequence);
    return true;
  };
}

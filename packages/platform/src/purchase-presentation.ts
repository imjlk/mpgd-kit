import type {
  PlatformPurchasePresentationEvent,
  PlatformPurchasePresentationReason,
} from './index.js';

// Purchase presentation facts (`CommerceProvider.presentation`) as a provider
// publishes them and as a wrapper relays them. Pure and typia-free: the main
// entry re-exports this module, and headless consumers type-check it without
// a DOM or Node lib.

export type PurchasePresentationListener = (event: PlatformPurchasePresentationEvent) => void;

/** The `presentation` member of a `CommerceProvider`. */
export interface PurchasePresentationSource {
  subscribe(listener: PurchasePresentationListener): () => void;
}

export interface PurchasePresentationOptions {
  /**
   * Told when a listener throws. The fact still reaches every other
   * listener: one that misses a `closed` would keep the game paused.
   */
  readonly onListenerError?: (error: unknown) => void;
}

/** `presentation` plus the side that publishes into it. */
export interface PurchasePresentationChannel {
  readonly presentation: PurchasePresentationSource;
  /**
   * Delivers one fact to every current listener, synchronously, numbered with
   * the next `sequence` of this channel (from 1, increasing across every key,
   * so each key's facts increase too). Facts are never buffered.
   */
  publish(fact: Omit<PlatformPurchasePresentationEvent, 'sequence'>): void;
  clear(): void;
}

export function createPurchasePresentationChannel(
  options: PurchasePresentationOptions = {},
): PurchasePresentationChannel {
  const listeners = new Set<{ readonly listener: PurchasePresentationListener }>();
  let sequence = 0;
  return {
    presentation: {
      subscribe(listener) {
        // One entry per call: the same listener subscribed twice gets two
        // deliveries and two independent unsubscribes.
        const entry = { listener };
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
      for (const entry of [...listeners]) {
        if (!listeners.has(entry)) {
          continue;
        }
        try {
          entry.listener(event);
        } catch (error) {
          options.onListenerError?.(error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

/**
 * How many ended keys a sequence guard remembers, the default history of the
 * game runtime's purchase coordinator (`maxRememberedInvocations`).
 */
export const purchasePresentationRetiredKeyLimit = 1024;

/**
 * Drops a fact its source already superseded, before a relay numbers it
 * again: one whose `sequence` is not above the last one seen for its key (per
 * `attempt` when the source tags attempts), as the game runtime's coordinator
 * would with the source's own numbers. A key with an open fact stays
 * remembered; a key whose last fact ended it (`closed`, `not-started`) moves
 * to a bounded list of the most recent `retiredKeyLimit` ended keys, which
 * still rejects a replay of its old facts during a same-key retry while
 * keeping memory bounded.
 */
export function createPurchasePresentationSequenceGuard(
  options: { readonly retiredKeyLimit?: number } = {},
): (event: PlatformPurchasePresentationEvent) => boolean {
  const limit = options.retiredKeyLimit ?? purchasePresentationRetiredKeyLimit;
  const live = new Map<string, number>();
  const retired = new Map<string, number>();
  return (event) => {
    if (!Number.isSafeInteger(event.sequence)) {
      return false;
    }
    const cursor = typeof event.attempt === 'number'
      ? `${event.idempotencyKey}\u0000${String(event.attempt)}`
      : event.idempotencyKey;
    const last = live.get(cursor) ?? retired.get(cursor);
    if (last !== undefined && event.sequence <= last) {
      return false;
    }
    retired.delete(cursor);
    if (event.state === 'closed' || event.state === 'not-started') {
      live.delete(cursor);
      retired.set(cursor, event.sequence);
      for (const oldest of retired.keys()) {
        if (retired.size <= limit) {
          break;
        }
        retired.delete(oldest);
      }
    } else {
      live.set(cursor, event.sequence);
    }
    return true;
  };
}

/** A source's facts relayed by a wrapper that may answer a purchase itself. */
export interface PurchasePresentationRelay {
  readonly presentation: PurchasePresentationSource;
  /**
   * Runs one purchase call of `idempotencyKey`. When it settles without any
   * fact from the source for its key (the wrapper refused it, or failed,
   * before the source ran), the relay reports `not-started` before the
   * caller sees the answer, unless another call of the key is still running
   * or left its sheet up (`open` or `unknown`).
   */
  track<T>(idempotencyKey: string, run: () => Promise<T>): Promise<T>;
}

/**
 * Relays a source's facts with the relay's own increasing `sequence`, after
 * dropping a fact the source already superseded, and adds `not-started` for
 * a call that ended without a fact. A consumer that waits for a fact after
 * every purchase (the game runtime's presentation gate) would otherwise wait
 * forever for a call the wrapper answered. One attachment to the source,
 * made with the first listener and dropped with the last, serves every
 * listener; facts are observed only while one is attached, so a consumer
 * subscribes before its first purchase.
 */
export function createPurchasePresentationRelay(
  source: PurchasePresentationSource,
  options: PurchasePresentationOptions = {},
): PurchasePresentationRelay {
  const channel = createPurchasePresentationChannel(options);
  const fresh = createPurchasePresentationSequenceGuard();
  const calls = new Map<string, { seen: boolean }[]>();
  // Keys whose last relayed fact left a sheet up (`open`) or possibly up
  // (`unknown`): a refused same-key call does not end them.
  const live = new Set<string>();
  let listenerCount = 0;
  let detach: (() => void) | undefined;
  const onFact: PurchasePresentationListener = (event) => {
    if (typeof event !== 'object' || event === null || typeof event.idempotencyKey !== 'string'
      || !fresh(event)) {
      return;
    }
    for (const call of calls.get(event.idempotencyKey) ?? []) {
      call.seen = true;
    }
    if (event.state === 'open' || event.state === 'unknown') {
      live.add(event.idempotencyKey);
    } else {
      live.delete(event.idempotencyKey);
    }
    channel.publish({
      idempotencyKey: event.idempotencyKey,
      state: event.state,
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
  };
  return {
    presentation: {
      subscribe(listener) {
        const unsubscribe = channel.presentation.subscribe(listener);
        listenerCount += 1;
        detach ??= source.subscribe(onFact);
        let active = true;
        return () => {
          if (!active) {
            return;
          }
          active = false;
          unsubscribe();
          listenerCount -= 1;
          if (listenerCount === 0 && detach !== undefined) {
            const unsubscribeSource = detach;
            detach = undefined;
            unsubscribeSource();
          }
        };
      },
    },
    async track(idempotencyKey, run) {
      const call = { seen: false };
      calls.set(idempotencyKey, [...(calls.get(idempotencyKey) ?? []), call]);
      try {
        return await run();
      } finally {
        const remaining = (calls.get(idempotencyKey) ?? []).filter((entry) => entry !== call);
        if (remaining.length === 0) {
          calls.delete(idempotencyKey);
        } else {
          calls.set(idempotencyKey, remaining);
        }
        // No fact for this call: it opened nothing. A key whose earlier
        // call still has a sheet up, or still runs, keeps that call's facts
        // as its truth (a provider refuses such a same-key call without a
        // fact), so no `not-started` is claimed for it.
        if (!call.seen && remaining.length === 0 && !live.has(idempotencyKey)) {
          channel.publish({ idempotencyKey, state: 'not-started' });
        }
      }
    },
  };
}

export function isPurchasePresentationReason(
  value: unknown,
): value is PlatformPurchasePresentationReason {
  return value === 'timeout' || value === 'interrupted' || value === 'disposed';
}

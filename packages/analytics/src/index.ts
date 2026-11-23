import typia from 'typia';

import type { PlatformTarget } from '@mpgd/platform';

export {
  createMonetizationAttempt,
  type MonetizationAttempt,
  type MonetizationObservation,
  type MonetizationObserver,
} from './monetization-observation.js';

export type AnalyticsEventName =
  | 'game_started'
  | 'stage_finished'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_granted'
  | 'purchase_pending'
  | 'purchase_rejected'
  | 'rewarded_ad_completed'
  | 'rewarded_ad_granted'
  | 'rewarded_ad_pending'
  | 'rewarded_ad_rejected'
  | 'leaderboard_submitted'
  | 'leaderboard_recorded';

export type AnalyticsPropertyValue = string | number | boolean;

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  readonly target: PlatformTarget | 'server';
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly properties: Record<string, AnalyticsPropertyValue>;
}

export interface AnalyticsSink {
  track(event: AnalyticsEvent): Promise<void> | void;
}

export interface AnalyticsReporter {
  track(input: {
    readonly name: AnalyticsEventName;
    readonly properties?: Record<string, AnalyticsPropertyValue | undefined>;
    readonly occurredAt?: string;
  }): Promise<void>;
}

export interface CreateAnalyticsReporterInput {
  readonly target: PlatformTarget | 'server';
  readonly sessionId: string;
  readonly sink?: AnalyticsSink;
  readonly now?: () => string;
}

export interface BufferedAnalyticsSink extends AnalyticsSink {
  /**
   * The most recent events, oldest first, up to the sink's capacity. Every read returns the
   * same array, which changes in place as events arrive and the oldest are dropped.
   */
  readonly events: readonly AnalyticsEvent[];
  /** Events tracked since the sink was created, including those no longer in `events`. */
  readonly trackedCount: number;
}

export interface CreateBufferedAnalyticsSinkInput {
  /**
   * The most events `events` keeps; each event past it drops the oldest. A non-negative
   * integer, `defaultBufferedAnalyticsSinkCapacity` when omitted; anything else throws a
   * `RangeError`. `0` keeps no events and only counts them.
   */
  readonly capacity?: number;
}

/** How many events a buffered sink keeps when no `capacity` is given. */
export const defaultBufferedAnalyticsSinkCapacity = 1_000;

export const assertAnalyticsEvent = typia.createAssert<AnalyticsEvent>();

export function createNoopAnalyticsSink(): AnalyticsSink {
  return {
    track() {},
  };
}

/**
 * An in-memory sink for tests and debug views. It keeps only the most recent events, so a
 * long session holds at most `capacity` of them, and it sends nothing anywhere.
 */
export function createBufferedAnalyticsSink(
  input: CreateBufferedAnalyticsSinkInput = {},
): BufferedAnalyticsSink {
  const capacity = input.capacity ?? defaultBufferedAnalyticsSinkCapacity;
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError('Buffered analytics sink capacity must be a non-negative integer.');
  }
  const events: AnalyticsEvent[] = [];
  let trackedCount = 0;

  return {
    get events() {
      return events;
    },
    get trackedCount() {
      return trackedCount;
    },
    track(event) {
      events.push(assertAnalyticsEvent(event));
      trackedCount += 1;
      // Each call trims, so at most one event is over. In place, so a caller holding
      // `events` keeps reading the live buffer.
      if (events.length > capacity) {
        events.shift();
      }
    },
  };
}

export function createAnalyticsReporter(input: CreateAnalyticsReporterInput): AnalyticsReporter {
  const sink = input.sink ?? createNoopAnalyticsSink();
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async track(eventInput) {
      const event = assertAnalyticsEvent({
        name: eventInput.name,
        target: input.target,
        sessionId: input.sessionId,
        occurredAt: eventInput.occurredAt ?? now(),
        properties: compactProperties(eventInput.properties ?? {}),
      });

      try {
        await sink.track(event);
      } catch {
        // Analytics is best-effort and must not break gameplay or ledger flows.
      }
    },
  };
}

function compactProperties(
  input: Record<string, AnalyticsPropertyValue | undefined>,
): Record<string, AnalyticsPropertyValue> {
  const output: Record<string, AnalyticsPropertyValue> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

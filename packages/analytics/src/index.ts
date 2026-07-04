import typia from 'typia';

import type { PlatformTarget } from '@mpgd/platform';

export type AnalyticsEventName =
  | 'game_started'
  | 'stage_finished'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_granted'
  | 'purchase_rejected'
  | 'rewarded_ad_completed'
  | 'rewarded_ad_granted'
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
  readonly events: readonly AnalyticsEvent[];
}

export const assertAnalyticsEvent = typia.createAssert<AnalyticsEvent>();

export function createNoopAnalyticsSink(): AnalyticsSink {
  return {
    track() {},
  };
}

export function createBufferedAnalyticsSink(): BufferedAnalyticsSink {
  const events: AnalyticsEvent[] = [];

  return {
    get events() {
      return events;
    },
    track(event) {
      events.push(assertAnalyticsEvent(event));
    },
  };
}

export function createAnalyticsReporter(input: CreateAnalyticsReporterInput): AnalyticsReporter {
  const sink = input.sink ?? createNoopAnalyticsSink();
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async track(eventInput) {
      await sink.track(
        assertAnalyticsEvent({
          name: eventInput.name,
          target: input.target,
          sessionId: input.sessionId,
          occurredAt: eventInput.occurredAt ?? now(),
          properties: compactProperties(eventInput.properties ?? {}),
        }),
      );
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

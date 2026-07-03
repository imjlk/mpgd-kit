import typia from 'typia';

export type AnalyticsEventName =
  | 'game_started'
  | 'stage_finished'
  | 'purchase_started'
  | 'purchase_completed'
  | 'rewarded_ad_completed';

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  readonly target: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly properties: Record<string, string | number | boolean>;
}

export const assertAnalyticsEvent = typia.createAssert<AnalyticsEvent>();

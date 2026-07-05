import type { AnalyticsReporter, BufferedAnalyticsSink } from '@mpgd/analytics';
import type { Locale } from '@mpgd/i18n';
import type { PlayerIdentity } from '@mpgd/platform';
import type { TargetConfiguredGateway, TargetRuntimeSnapshot } from '@mpgd/target-config';

import type { StarterGameServices } from '../platform/gameServices';

export const starterContextKey = 'starterContext';

export interface StarterContext {
  readonly platform: TargetConfiguredGateway;
  readonly runtime: TargetRuntimeSnapshot;
  readonly player: PlayerIdentity;
  readonly locale: Locale;
  readonly gameServices: StarterGameServices;
  readonly analytics: AnalyticsReporter;
  readonly analyticsSink: BufferedAnalyticsSink;
}

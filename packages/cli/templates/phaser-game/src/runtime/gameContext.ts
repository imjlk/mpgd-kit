import type { AnalyticsReporter, BufferedAnalyticsSink } from '@mpgd/analytics';
import type { Locale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlayerIdentity } from '@mpgd/platform';
import type {
  TargetConfiguredGateway,
  TargetRuntimeSnapshot,
  TargetViewportSnapshot,
} from '@mpgd/target-config';

import type { StarterGameServices } from '../platform/gameServices';

export const starterContextKey = 'starterContext';

export interface StarterContext {
  readonly platform: TargetConfiguredGateway;
  readonly runtime: TargetRuntimeSnapshot;
  readonly viewport: TargetViewportSnapshot;
  readonly player: PlayerIdentity;
  readonly identitySession: IdentitySession;
  readonly launchIntent: LaunchIntent;
  readonly locale: Locale;
  readonly gameServices: StarterGameServices;
  readonly analytics: AnalyticsReporter;
  readonly analyticsSink: BufferedAnalyticsSink;
}

import type { MpgdLocale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlayerIdentity } from '@mpgd/platform';
import type {
  TargetConfiguredGateway,
  TargetRuntimeSnapshot,
  TargetViewportPlan,
} from '@mpgd/target-config';

import type { StarterGameServices } from '../platform/gameServices';

export interface StarterContext {
  readonly platform: TargetConfiguredGateway;
  readonly runtime: TargetRuntimeSnapshot;
  readonly viewport: TargetViewportPlan;
  readonly player: PlayerIdentity;
  readonly identitySession: IdentitySession;
  readonly launchIntent: LaunchIntent;
  readonly locale: MpgdLocale;
  readonly gameServices: StarterGameServices;
}

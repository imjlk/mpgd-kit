import type { MpgdLocale } from '@mpgd/i18n';
import type { PlayerIdentity } from '@mpgd/platform';
import type {
  TargetConfiguredGateway,
  TargetRuntimeSnapshot,
} from '@mpgd/target-config';

import type { StarterGameServices } from '../platform/gameServices';

export interface StarterContext {
  readonly platform: TargetConfiguredGateway;
  readonly runtime: TargetRuntimeSnapshot;
  readonly player: PlayerIdentity;
  readonly locale: MpgdLocale;
  readonly gameServices: StarterGameServices;
}

import type { GamePlatformRuntime } from '@mpgd/game-runtime/game';
import type { MpgdLocale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlayerIdentity } from '@mpgd/platform';
import type {
  TargetConfiguredGateway,
  TargetRuntimeSnapshot,
  TargetViewportSnapshot,
} from '@mpgd/target-config';

import type { StarterGameServices } from '../platform/gameServices';

export interface StarterContext {
  readonly gameRuntime: GamePlatformRuntime<TargetConfiguredGateway, StarterGameServices>;
  readonly platform: TargetConfiguredGateway;
  readonly runtime: TargetRuntimeSnapshot;
  readonly viewport: TargetViewportSnapshot;
  readonly player: PlayerIdentity;
  readonly identitySession: IdentitySession;
  readonly launchIntent: LaunchIntent;
  readonly locale: MpgdLocale;
  readonly gameServices: StarterGameServices;
}

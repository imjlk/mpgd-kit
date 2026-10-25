/// <reference types="vite/client" />

declare const __APP_TARGET__: string;
declare const __MPGD_CONFIG_TARGET__: string;
/** The Apps in Toss app name `intoss://` share links carry; see `vite.shared.ts`. */
declare const __MPGD_AIT_APP_NAME__: string;
declare const __MPGD_PLATFORM_TARGET__:
  | import('@mpgd/target-config').EffectivePlatformTargetMetadata
  | undefined;
declare const __MPGD_TARGET_CONFIG_MATRIX__:
  | import('@mpgd/target-config').TargetConfigMatrix
  | undefined;
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __SOURCE_GIT_SHA__: string;
declare const __DEBUG_BUILD__: boolean;

interface ImportMetaEnv {
  readonly VITE_MPGD_GAME_SERVICES_URL?: string;
  readonly VITE_MPGD_GAME_SERVICES_TARGET?: string;
  readonly VITE_MPGD_GAME_SERVICES_TRANSPORT?: string;
  /**
   * The guest identity service (the kit's reference Worker,
   * `apps/game-identity-worker`): an https URL, or http on a local
   * development host. See `src/platform/guestIdentity.ts`.
   */
  readonly VITE_MPGD_IDENTITY_URL?: string;
  /**
   * Local development only: `<playerId>` or `<playerId>.<installationId>`
   * for an unauthenticated notifications session (see `serverSession.ts`).
   */
  readonly VITE_MPGD_DEV_NOTIFICATION_SESSION?: string;
}

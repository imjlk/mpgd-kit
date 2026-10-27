import { createGamePlatformRuntime, type GamePlatformRuntime } from '@mpgd/game-runtime/game';
import './styles.css';

import { createAnalyticsReporter, createBufferedAnalyticsSink } from '@mpgd/analytics';
import { resolveTargetMpgdLocale, type Locale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlatformGateway } from '@mpgd/platform';
import {
  getEffectiveAdPlacementConfig,
  measureTargetViewport,
  resolveTargetViewportSnapshot,
  waitForTargetViewportMeasurement,
  type TargetViewportMeasurement,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { t } from './i18n/messages';
import { createClientId } from './runtime/id';
import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import {
  createStarterGameServices,
  createStarterSessionGatedGameServices,
  type StarterMonetizationPorts,
} from './platform/gameServices';
import { createStarterGuestSignIn } from './platform/guestIdentity';
import { setStarterServerSession } from './platform/serverSession';
import { installPlatform } from './platform/installPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

/** Set by the first restart for another player (before bootstrap, which may call it). */
let restartingForAnotherPlayer = false;

await bootstrap();

/** Install target services, analytics, and viewport state before starting the game. */
async function bootstrap(options: { readonly monetization?: StarterMonetizationPorts } = {}): Promise<void> {
  let gameRuntime: GamePlatformRuntime | undefined;
  let locale: Locale = 'en';
  let disposeMicrosoftStorePwa: (() => void) | undefined;
  let disposeGuestSignIn: (() => void) | undefined;

  try {
    if (__APP_TARGET__ === 'ait') {
      const { install } = await import('@ait-co/polyfill');
      await install();
    }

    const runtimeConfig = detectRuntime();
    disposeMicrosoftStorePwa = installMicrosoftStorePwa(runtimeConfig);
    const platform = await installPlatform(runtimeConfig);
    const runtime = await platform.getTargetRuntime();
    const orientationPolicy = {
      mode: 'prefer-landscape',
    } as const satisfies TargetViewportOrientationPolicy;
    // A hidden iframe or background tab can boot at 0x0; wait for layout instead of failing.
    const measurement = await waitForTargetViewportMeasurement({
      measure: measureGameViewport,
      subscribe: subscribeToGameViewportChanges,
    });
    const viewport = resolveTargetViewportSnapshot({
      ...measurement,
      ...(platform.viewport === undefined ? {} : { safeAreaInsets: platform.viewport.getState().safeAreaInsets }),
      runtime: runtime.config.runtime,
      orientationPolicy,
    });
    const platformPlayer =
      (await platform.identity.getPlayer()) ?? {
        playerId: 'local-player',
        displayName: 'Local Player',
      };
    // The server-issued guest (VITE_MPGD_IDENTITY_URL): tried at boot, and when that fails,
    // again in the background and before any purchase or restore (`guestIdentity.ts`).
    const guestSignIn = createStarterGuestSignIn({
      identityUrl: import.meta.env.VITE_MPGD_IDENTITY_URL,
      credentials: platform.secureCredentials,
    });
    disposeGuestSignIn = () => guestSignIn.dispose();
    const [bootSignIn, platformSession, launchIntent] = await Promise.all([
      guestSignIn.ensure(),
      resolveIdentitySession(platform, platformPlayer.playerId),
      resolveLaunchIntent(platform),
    ]);
    // A background retry may have won while the other boot reads were pending.
    const guestIdentity = guestSignIn.current() ?? bootSignIn;
    // Before the game services read the session: at once, or when a later attempt succeeds
    // (notifications then come up on their next open; the session-gated services read it).
    if (guestIdentity !== undefined) {
      setStarterServerSession(guestIdentity.serverSession);
    } else {
      guestSignIn.onSignedIn((later) => setStarterServerSession(later.serverSession));
    }
    // Signed in at boot, the server player replaces the platform's (on the native shell a local
    // placeholder) everywhere. Signed in later, the scenes keep this run's boot player (see
    // README, "Guest identity"); only the purchase and notification services use the server player.
    const player = guestIdentity !== undefined
      ? { ...platformPlayer, playerId: guestIdentity.playerId }
      : platformPlayer;
    const identitySession: IdentitySession = guestIdentity !== undefined
      ? {
          identityLevel: guestIdentity.identityLevel,
          playerId: guestIdentity.playerId,
          trustLevel: 'server-verified',
        }
      : platformSession;
    locale = resolveTargetMpgdLocale({
      capabilities: runtime.capabilities,
      ...(platform.gameSettings?.getLocale === undefined ? {} : { preferredLocales: [platform.gameSettings.getLocale()] }),
      fallbackLocale:
        runtime.effectiveConfig?.localization.fallbackLocale
        ?? runtime.config.localization.fallbackLocale,
    });
    const analyticsSink = createBufferedAnalyticsSink();
    const analyticsSessionId = createClientId('session');
    const analytics = createAnalyticsReporter({
      target: platform.target,
      sessionId: analyticsSessionId,
      sink: analyticsSink,
    });
    const sessionGated = guestIdentity === undefined && guestSignIn.configured;
    const ownedRuntime = createGamePlatformRuntime({
      gateway: platform,
      initialLifecycleState: document.visibilityState === 'hidden' ? 'inactive' : 'active',
      canShow: (placement) => {
        // A run that booted before its sign-in shows no rewarded ad: the runtime's late
        // reward evidence recovery is bound at boot, which had no recovery client.
        if (placement.format === 'rewarded' && sessionGated) {
          return false;
        }
        const enabled = placement.format === 'rewarded'
          ? runtime.config.features.rewardedAds
          : runtime.config.features.interstitialAds;
        const configured = runtime.effectiveConfig === undefined
          ? undefined
          : getEffectiveAdPlacementConfig(runtime.effectiveConfig, placement.placementId);
        return enabled && (runtime.effectiveConfig === undefined || configured !== undefined && configured.reason !== 'target-disabled');
      },
      deadline: {
        milliseconds: 30000,
        schedule(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      },
      ...(options.monetization?.reconciliation === undefined ? {} : { reconciliation: options.monetization.reconciliation }),
      ...(options.monetization?.purchasePresentation === undefined ? {} : { purchasePresentation: options.monetization.purchasePresentation }),
      onObserverError: (error) => {
        console.error('[game-runtime]', error);
      },
      createServices: (gateway) => {
        const servicesInput = {
          gateway,
          configTarget: runtime.configTarget,
          ...(options.monetization === undefined ? {} : { operationStore: options.monetization.operationStore }),
          analytics: analyticsSink,
          analyticsSessionId,
          // The services are one player's for the run: another player signing in closes them
          // (purchases fail closed, retryably) and the game boots again for that player.
          onPlayerChanged: restartForAnotherPlayer,
        };
        // Configured but not signed in yet: the services wait for the server player, never
        // binding purchases or the journal to the platform's local placeholder.
        return sessionGated
          ? createStarterSessionGatedGameServices({
              ...servicesInput,
              signIn: guestSignIn,
              // The startup recovery the boot ran without a player, with the action coordinator's.
              onActivated: () => {
                void gameRuntime?.reconcile().catch((error: unknown) => {
                  console.error('[game-services] recovery after sign-in failed', error);
                });
              },
            })
          : createStarterGameServices({
              ...servicesInput,
              playerId: identitySession.playerId ?? player.playerId,
            });
      },
    });
    gameRuntime = ownedRuntime;
    const gameServices = ownedRuntime.services;
    try {
      await ownedRuntime.reconcile();
    } catch (error) {
      // A journal the platform storage cannot read must not stop the game:
      // recovery runs again on resume, and purchases and rewarded ads fail
      // closed until the journal is readable.
      console.error('[game-services] startup recovery failed', error);
    }

    await analytics.track({
      name: 'game_started',
      properties: {
        target: platform.target,
        configTarget: runtime.configTarget,
      },
    });

    createStarterGame({
      mountId: 'game',
      preserveBrowserTouchGestures:
        document.body.dataset.mpgdPreserveBrowserTouchGestures === 'true',
      context: {
        platform: ownedRuntime.gateway,
        gameRuntime: ownedRuntime,
        runtime,
        viewport,
        player,
        identitySession,
        launchIntent,
        locale,
        gameServices,
        analytics,
        analyticsSink,
      },
    });
  } catch (error) {
    gameRuntime?.dispose();
    disposeGuestSignIn?.();
    disposeMicrosoftStorePwa?.();
    renderBootstrapError(error, locale);
    console.error('[bootstrap]', error);
  }
}

/**
 * Another player signed in to the server session within the run (a game's own
 * account switch; the reference guest never changes player). The game
 * services already closed for the boot player; the scenes, the action
 * coordinator, and the notifications still hold it, so the game boots again
 * and builds them all for the new player. Replace the reload with your own
 * restart (back to the title, then `bootstrap()`) if a reload does not suit
 * the target.
 */
function restartForAnotherPlayer(): void {
  if (!restartingForAnotherPlayer) {
    restartingForAnotherPlayer = true;
    globalThis.location?.reload();
  }
}

/** Resolve a verified platform session or fall back to a local guest. */
async function resolveIdentitySession(
  platform: PlatformGateway,
  fallbackPlayerId: string,
): Promise<IdentitySession> {
  try {
    return (await platform.identity.getSession?.()) ?? createGuestSession(fallbackPlayerId);
  } catch (error) {
    console.warn('[platform] identity session unavailable; using guest fallback.', error);
    return createGuestSession(fallbackPlayerId);
  }
}

/** Resolve the host launch intent while preserving a home-entry fallback. */
async function resolveLaunchIntent(platform: PlatformGateway): Promise<LaunchIntent> {
  try {
    return (await platform.presentation?.getLaunchIntent()) ?? { entry: 'home' };
  } catch (error) {
    console.warn('[platform] launch intent unavailable; using home fallback.', error);
    return { entry: 'home' };
  }
}

/** Create the minimal local identity used when a host session is unavailable. */
function createGuestSession(playerId: string): IdentitySession {
  return {
    identityLevel: 'guest',
    playerId,
    trustLevel: 'local',
  };
}

/** Render a localized bootstrap failure inside the game mount. */
function renderBootstrapError(error: unknown, locale: Locale): void {
  const message = error instanceof Error ? error.message : String(error);
  const root = document.querySelector<HTMLDivElement>('#game');

  if (root === null) {
    return;
  }

  root.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'boot-error';
  panel.textContent = `${t(locale, 'bootError')}: ${message}`;
  root.append(panel);
}

/** Measure the game surface before falling back to browser viewport geometry. */
function measureGameViewport(): TargetViewportMeasurement | null {
  return measureTargetViewport({
    container: document.querySelector<HTMLElement>('#game'),
    visualViewport: window.visualViewport,
    window,
  });
}

/** Notify when the game surface may have gained a size or become visible. */
function subscribeToGameViewportChanges(listener: () => void): () => void {
  const container = document.querySelector<HTMLElement>('#game');
  const observer =
    container === null || typeof ResizeObserver !== 'function'
      ? undefined
      : new ResizeObserver(listener);

  if (container !== null) {
    observer?.observe(container);
  }
  window.addEventListener('resize', listener);
  window.visualViewport?.addEventListener('resize', listener);
  document.addEventListener('visibilitychange', listener);

  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', listener);
    window.visualViewport?.removeEventListener('resize', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}

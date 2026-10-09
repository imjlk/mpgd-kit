import { createGamePlatformRuntime, type GamePlatformRuntime } from '@mpgd/game-runtime/game';
import { resolveTargetMpgdLocale } from '@mpgd/i18n';
import type {
  IdentitySession,
  LaunchIntent,
  PlatformGateway,
  PlatformTarget,
} from '@mpgd/platform';
import {
  getEffectiveAdPlacementConfig,
  measureTargetViewport,
  resolveTargetViewportSnapshot,
  waitForTargetViewportMeasurement,
  type TargetViewportMeasurement,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { createStarterGame } from './runtime/createGame';
import { disposeStarterMiniGameBridgeAfterBootstrapFailure } from './platform/minigameBridge';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices, type StarterMonetizationPorts } from './platform/gameServices';
import { installStarterPlatform } from './platform/installStarterPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

/** Install target services, resolve viewport state, and start the example game. */
export async function bootstrapStarter(options: { readonly monetization?: StarterMonetizationPorts } = {}): Promise<void> {
  let gameRuntime: GamePlatformRuntime | undefined;
  let runtimeTarget: PlatformTarget | undefined;
  let disposeMicrosoftStorePwa: () => void = () => undefined;

  try {
    const runtimeConfig = detectRuntime();
    runtimeTarget = runtimeConfig.target;
    disposeMicrosoftStorePwa = installMicrosoftStorePwa(runtimeConfig);
    const platform = await installStarterPlatform(runtimeConfig);
    const runtime = await platform.getTargetRuntime();
    const orientationPolicy = {
      mode: 'responsive',
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
    const player =
      (await platform.identity.getPlayer()) ?? {
        playerId: 'local-player',
        displayName: 'Local Player',
      };
    const [identitySession, launchIntent] = await Promise.all([
      resolveIdentitySession(platform, player.playerId),
      resolveLaunchIntent(platform),
    ]);
    const locale = resolveTargetMpgdLocale({
      capabilities: runtime.capabilities,
      ...(platform.gameSettings?.getLocale === undefined ? {} : { preferredLocales: [platform.gameSettings.getLocale()] }),
      fallbackLocale:
        runtime.effectiveConfig?.localization.fallbackLocale
        ?? runtime.config.localization.fallbackLocale,
    });
    const ownedRuntime = createGamePlatformRuntime({
      gateway: platform,
      initialLifecycleState: document.visibilityState === 'hidden' ? 'inactive' : 'active',
      canShow: (placement) => {
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
      createServices: (gateway) =>
        createStarterGameServices({
          gateway,
          playerId: identitySession.playerId ?? player.playerId,
          configTarget: runtime.configTarget,
          ...(options.monetization === undefined ? {} : { operationStore: options.monetization.operationStore }),
        }),
    });
    gameRuntime = ownedRuntime;
    const gameServices = ownedRuntime.services;
    await ownedRuntime.reconcile();

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
      },
    });
  } catch (error) {
    gameRuntime?.dispose();
    disposeStarterMiniGameBridgeAfterBootstrapFailure(runtimeTarget);
    try {
      disposeMicrosoftStorePwa();
    } catch (cleanupError) {
      reportStarterBootstrapCleanupError(cleanupError);
    }
    throw error;
  }
}

function reportStarterBootstrapCleanupError(error: unknown): void {
  try {
    console.error('Failed starter bootstrap cleanup encountered an error.', error);
  } catch {
    // Preserve the authoritative bootstrap error when host logging is unavailable.
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

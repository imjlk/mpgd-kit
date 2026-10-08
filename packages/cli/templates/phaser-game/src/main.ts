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
import { createStarterGameServices, type StarterMonetizationPorts } from './platform/gameServices';
import { installPlatform } from './platform/installPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

await bootstrap();

/** Install target services, analytics, and viewport state before starting the game. */
async function bootstrap(options: { readonly monetization?: StarterMonetizationPorts } = {}): Promise<void> {
  let gameRuntime: GamePlatformRuntime | undefined;
  let locale: Locale = 'en';
  let disposeMicrosoftStorePwa: (() => void) | undefined;

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
    locale = resolveTargetMpgdLocale({
      capabilities: runtime.capabilities,
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
          analytics: analyticsSink,
          analyticsSessionId,
        }),
    });
    gameRuntime = ownedRuntime;
    const gameServices = ownedRuntime.services;
    await ownedRuntime.reconcile();

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
    disposeMicrosoftStorePwa?.();
    renderBootstrapError(error, locale);
    console.error('[bootstrap]', error);
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

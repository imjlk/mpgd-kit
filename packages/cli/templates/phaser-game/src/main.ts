import './styles.css';

import { createAnalyticsReporter, createBufferedAnalyticsSink } from '@mpgd/analytics';
import { resolveTargetMpgdLocale, type Locale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlatformGateway } from '@mpgd/platform';
import {
  resolveTargetViewportSnapshot,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { t } from './i18n/messages';
import { createClientId } from './runtime/id';
import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installPlatform } from './platform/installPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

await bootstrap();

/** Install target services, analytics, and viewport state before starting the game. */
async function bootstrap(): Promise<void> {
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
    const viewport = resolveTargetViewportSnapshot({
      ...measureGameViewport(),
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
    const gameServices = createStarterGameServices({
      gateway: platform,
      playerId: identitySession.playerId ?? player.playerId,
      analytics: analyticsSink,
      analyticsSessionId,
    });

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
        platform,
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
function measureGameViewport(): {
  readonly width: number;
  readonly height: number;
  readonly source: 'container' | 'visual-viewport' | 'window';
} {
  const container = document.querySelector<HTMLElement>('#game');
  const rect = container?.getBoundingClientRect();

  if (rect !== undefined && rect.width > 0 && rect.height > 0) {
    return {
      width: rect.width,
      height: rect.height,
      source: 'container',
    };
  }

  const visualViewport = window.visualViewport;

  if (
    visualViewport !== undefined &&
    visualViewport !== null &&
    visualViewport.width > 0 &&
    visualViewport.height > 0
  ) {
    return {
      width: visualViewport.width,
      height: visualViewport.height,
      source: 'visual-viewport',
    };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
    source: 'window',
  };
}

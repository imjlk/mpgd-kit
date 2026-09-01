import { resolveTargetMpgdLocale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlatformGateway } from '@mpgd/platform';
import {
  resolveTargetViewportSnapshot,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installStarterPlatform } from './platform/installStarterPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

/** Install target services, resolve viewport state, and start the example game. */
export async function bootstrapStarter(): Promise<void> {
  const runtimeConfig = detectRuntime();
  const disposeMicrosoftStorePwa = installMicrosoftStorePwa(runtimeConfig);

  try {
    const platform = await installStarterPlatform(runtimeConfig);
    const runtime = await platform.getTargetRuntime();
    const orientationPolicy = {
      mode: 'responsive',
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
    const locale = resolveTargetMpgdLocale({
      capabilities: runtime.capabilities,
      fallbackLocale:
        runtime.effectiveConfig?.localization.fallbackLocale
        ?? runtime.config.localization.fallbackLocale,
    });
    const gameServices = createStarterGameServices({
      gateway: platform,
      playerId: identitySession.playerId ?? player.playerId,
      configTarget: runtime.configTarget,
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
      },
    });
  } catch (error) {
    disposeMicrosoftStorePwa();
    throw error;
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
    visualViewport !== undefined
    && visualViewport !== null
    && visualViewport.width > 0
    && visualViewport.height > 0
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

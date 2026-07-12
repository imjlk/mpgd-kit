import './styles.css';

import { resolveTargetMpgdLocale } from '@mpgd/i18n';
import type { IdentitySession, LaunchIntent, PlatformGateway } from '@mpgd/platform';
import {
  resolveTargetViewportPlan,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installStarterPlatform } from './platform/installStarterPlatform';
import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';

await bootstrapStarter();

async function bootstrapStarter(): Promise<void> {
  const runtimeConfig = detectRuntime();
  const disposeMicrosoftStorePwa = installMicrosoftStorePwa(runtimeConfig);

  try {
    const platform = await installStarterPlatform(runtimeConfig);
    const runtime = await platform.getTargetRuntime();
    const orientationPolicy = {
      mode: 'responsive',
    } as const satisfies TargetViewportOrientationPolicy;
    const viewport = resolveTargetViewportPlan({
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
    });

    createStarterGame({
      mountId: 'game',
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

async function resolveLaunchIntent(platform: PlatformGateway): Promise<LaunchIntent> {
  try {
    return (await platform.presentation?.getLaunchIntent()) ?? { entry: 'home' };
  } catch (error) {
    console.warn('[platform] launch intent unavailable; using home fallback.', error);
    return { entry: 'home' };
  }
}

function createGuestSession(playerId: string): IdentitySession {
  return {
    identityLevel: 'guest',
    playerId,
    trustLevel: 'local',
  };
}

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

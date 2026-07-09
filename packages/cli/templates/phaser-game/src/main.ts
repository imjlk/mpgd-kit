import './styles.css';

import { createAnalyticsReporter, createBufferedAnalyticsSink } from '@mpgd/analytics';
import { resolveMpgdLocale, type Locale } from '@mpgd/i18n';
import { resolveTargetViewportPlan } from '@mpgd/target-config';

import { t } from './i18n/messages';
import { createClientId } from './runtime/id';
import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installPlatform } from './platform/installPlatform';

await bootstrap();

async function bootstrap(): Promise<void> {
  let locale: Locale = 'en';

  try {
    if (__APP_TARGET__ === 'ait') {
      const { install } = await import('@ait-co/polyfill');
      await install();
    }

    const runtimeConfig = detectRuntime();
    const platform = await installPlatform(runtimeConfig);
    const runtime = await platform.getTargetRuntime();
    const viewport = resolveTargetViewportPlan({
      ...measureGameViewport(),
      runtime: runtime.config.runtime,
    });
    const player =
      (await platform.identity.getPlayer()) ?? {
        playerId: 'local-player',
        displayName: 'Local Player',
      };
    locale = resolveMpgdLocale(runtime.capabilities);
    const analyticsSink = createBufferedAnalyticsSink();
    const analytics = createAnalyticsReporter({
      target: platform.target,
      sessionId: createClientId('session'),
      sink: analyticsSink,
    });
    const gameServices = createStarterGameServices({
      gateway: platform,
      playerId: player.playerId,
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
      context: {
        platform,
        runtime,
        viewport,
        player,
        locale,
        gameServices,
        analytics,
        analyticsSink,
      },
    });
  } catch (error) {
    renderBootstrapError(error, locale);
    console.error('[bootstrap]', error);
  }
}

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

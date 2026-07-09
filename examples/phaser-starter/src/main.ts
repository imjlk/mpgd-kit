import './styles.css';

import { resolveMpgdLocale } from '@mpgd/i18n';
import {
  resolveTargetViewportPlan,
  type TargetViewportOrientationPolicy,
} from '@mpgd/target-config';

import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installStarterPlatform } from './platform/installStarterPlatform';

const runtimeConfig = detectRuntime();
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
const locale = resolveMpgdLocale(runtime.capabilities);
const gameServices = createStarterGameServices({
  gateway: platform,
  playerId: player.playerId,
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
  },
});

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

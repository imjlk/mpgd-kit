import Phaser from 'phaser';

import { isMiniGameRuntime } from '@mpgd/target-config';

import { requireStarterMiniGameRuntimeBridge } from '../platform/minigameBridge';
import { sceneRegistry } from './sceneRegistry';
import type { StarterContext } from './starterContext';

export interface CreateStarterGameInput {
  readonly mountId: string;
  readonly preserveBrowserTouchGestures?: boolean;
  readonly context: StarterContext;
}

export function createStarterGame(input: CreateStarterGameInput): Phaser.Game {
  const config = {
    type: Phaser.CANVAS,
    parent: input.mountId,
    backgroundColor: '#0d1117',
    scene: sceneRegistry,
    input: {
      touch: {
        capture: input.preserveBrowserTouchGestures !== true,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 960,
      height: 540,
    },
    render: {
      antialias: true,
      pixelArt: false,
    },
    callbacks: {
      postBoot(game: Phaser.Game) {
        game.registry.set('starterContext', input.context);
      },
    },
  } satisfies Phaser.Types.Core.GameConfig;
  const miniGameBridge = isMiniGameRuntime(input.context.runtime.config.runtime)
    ? requireStarterMiniGameRuntimeBridge(
        input.context.runtime.config.runtime === 'wechat-minigame' ? 'wechat' : 'tiktok',
      )
    : undefined;
  const game = new Phaser.Game(
    miniGameBridge === undefined ? config : miniGameBridge.createPhaserConfig(config),
  );

  if (miniGameBridge !== undefined) {
    try {
      miniGameBridge.attachGame(game);
    } catch (error) {
      destroyFailedMiniGame(game, miniGameBridge);
      throw error;
    }
  }

  return game;
}

function destroyFailedMiniGame(
  game: Phaser.Game,
  bridge: ReturnType<typeof requireStarterMiniGameRuntimeBridge>,
): void {
  try {
    if (game.events?.once === undefined) {
      throw new Error('Failed mini-game bootstrap cannot observe Phaser destruction.');
    }

    game.events.once('destroy', () => disposeBridgeAfterFailedBootstrap(bridge));
    game.destroy(true);
  } catch (cleanupError) {
    disposeBridgeAfterFailedBootstrap(bridge);
    reportFailedMiniGameCleanup(cleanupError);
  }
}

function disposeBridgeAfterFailedBootstrap(
  bridge: ReturnType<typeof requireStarterMiniGameRuntimeBridge>,
): void {
  try {
    bridge.dispose();
  } catch (error) {
    reportFailedMiniGameCleanup(error);
  }
}

function reportFailedMiniGameCleanup(error: unknown): void {
  try {
    console.error('Failed mini-game bootstrap cleanup encountered an error.', error);
  } catch {
    // Preserve the authoritative bootstrap error when host logging is unavailable.
  }
}

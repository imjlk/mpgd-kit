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
  };
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
      game.destroy(true);
      miniGameBridge.dispose();
      throw error;
    }
  }

  return game;
}

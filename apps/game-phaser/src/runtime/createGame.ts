import Phaser from 'phaser';

import type { PlatformGateway } from '@mpgd/platform-contract';

import { installPlatformEvents } from '../platform/platformEvents';
import { sceneRegistry } from './sceneRegistry';

export interface CreateGameInput {
  readonly mountId: string;
  readonly platform: PlatformGateway;
}

export function createGame(input: CreateGameInput): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: input.mountId,
    backgroundColor: '#101820',
    scene: sceneRegistry,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 960,
      height: 540,
    },
    render: {
      pixelArt: false,
      antialias: true,
    },
    callbacks: {
      postBoot(createdGame) {
        createdGame.registry.set('platform', input.platform);
      },
    },
  });

  installPlatformEvents(game, input.platform);

  return game;
}

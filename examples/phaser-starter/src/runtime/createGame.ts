import Phaser from 'phaser';

import { sceneRegistry } from './sceneRegistry';
import type { StarterContext } from './starterContext';

export interface CreateStarterGameInput {
  readonly mountId: string;
  readonly context: StarterContext;
}

export function createStarterGame(input: CreateStarterGameInput): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.CANVAS,
    parent: input.mountId,
    backgroundColor: '#0d1117',
    scene: sceneRegistry,
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
      postBoot(game) {
        game.registry.set('starterContext', input.context);
      },
    },
  });
}

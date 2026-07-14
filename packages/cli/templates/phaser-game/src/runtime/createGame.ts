import Phaser from 'phaser';

import { BootScene } from '../scenes/BootScene';
import { LobbyScene } from '../scenes/LobbyScene';
import { PlayScene } from '../scenes/PlayScene';
import { starterContextKey, type StarterContext } from './gameContext';

export function createStarterGame(input: {
  readonly mountId: string;
  readonly preserveBrowserTouchGestures?: boolean;
  readonly context: StarterContext;
}): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: input.mountId,
    width: 960,
    height: 540,
    backgroundColor: '#07111f',
    input: {
      touch: {
        capture: input.preserveBrowserTouchGestures !== true,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, LobbyScene, PlayScene],
  });

  game.registry.set(starterContextKey, input.context);

  return game;
}

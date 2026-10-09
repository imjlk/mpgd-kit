import { bindGameAudio } from '@mpgd/game-runtime/audio';
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
    callbacks: {
      preBoot(game: Phaser.Game) {
        game.registry.set(starterContextKey, input.context);
      },
      postBoot(game: Phaser.Game) {
        ownGameAudio(game, input.context);
      },
    },
  });

  return game;
}

/** The sound manager and execution projection belong to the game, not a scene. */
function ownGameAudio(game: Phaser.Game, context: StarterContext): void {
  const audio = bindGameAudio({
    execution: context.gameRuntime.execution,
    sink: {
      getMuted: () => game.sound.mute,
      setMuted: (muted) => {
        game.sound.mute = muted;
      },
    },
    onError: (error) => {
      console.error('[game-audio]', error);
    },
  });
  game.events.once('destroy', () => {
    context.gameRuntime.dispose();
    audio.dispose();
  });
}

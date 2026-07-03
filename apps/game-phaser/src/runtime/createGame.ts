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
    type: Phaser.CANVAS,
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
  installTestHooks(game);

  return game;
}

function installTestHooks(game: Phaser.Game): void {
  const testHost = globalThis as {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  };

  testHost.render_game_to_text = () => {
    const activeScenes = game.scene.getScenes(true);
    const currentScene = activeScenes.at(-1);
    const state = game.registry.get('demoState') as unknown;

    return JSON.stringify({
      coordinateSystem: 'canvas origin top-left, x right, y down',
      scenes: activeScenes.map((scene) => scene.scene.key),
      currentScene: currentScene?.scene.key ?? null,
      target: game.registry.get('platform')?.target ?? null,
      demoState: state,
      sceneState: getSceneState(currentScene),
    });
  };

  testHost.advanceTime = (ms: number) => {
    const step = (game.loop as { step?: (time: number) => void }).step?.bind(game.loop);

    if (step === undefined) {
      return;
    }

    const frames = Math.max(1, Math.round(ms / (1000 / 60)));
    const start = performance.now();

    for (let index = 0; index < frames; index += 1) {
      step(start + index * (1000 / 60));
    }
  };
}

function getSceneState(scene: Phaser.Scene | undefined): unknown {
  const stateSource = scene as { renderGameToText?: () => unknown } | undefined;

  return stateSource?.renderGameToText?.() ?? null;
}

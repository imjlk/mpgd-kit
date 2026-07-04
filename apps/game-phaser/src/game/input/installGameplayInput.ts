import Phaser from 'phaser';

import type { GameplayInputEvent } from './actions';

export interface InstallGameplayInputOptions {
  readonly target: Phaser.GameObjects.Image;
  readonly onAction: (event: GameplayInputEvent) => void;
}

export function installGameplayInput(
  scene: Phaser.Scene,
  options: InstallGameplayInputOptions,
): void {
  const targetHandler = () => {
    options.onAction({ action: 'hit-target', source: 'pointer' });
  };
  const backgroundHandler = (_pointer: Phaser.Input.Pointer, objects: readonly unknown[]) => {
    if (objects.length === 0) {
      options.onAction({ action: 'miss', source: 'pointer' });
    }
  };
  const spaceHandler = () => {
    options.onAction({ action: 'hit-target', source: 'keyboard' });
  };
  const missHandler = () => {
    options.onAction({ action: 'miss', source: 'keyboard' });
  };
  const returnLobbyHandler = () => {
    options.onAction({ action: 'return-lobby', source: 'keyboard' });
  };
  const keyboard = scene.input.keyboard;

  options.target.setInteractive({ useHandCursor: true });
  options.target.on('pointerdown', targetHandler);
  scene.input.on('pointerdown', backgroundHandler);
  keyboard?.on('keydown-SPACE', spaceHandler);
  keyboard?.on('keydown-M', missHandler);
  keyboard?.on('keydown-ESC', returnLobbyHandler);

  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    options.target.off('pointerdown', targetHandler);
    scene.input.off('pointerdown', backgroundHandler);
    keyboard?.off('keydown-SPACE', spaceHandler);
    keyboard?.off('keydown-M', missHandler);
    keyboard?.off('keydown-ESC', returnLobbyHandler);
  });
}

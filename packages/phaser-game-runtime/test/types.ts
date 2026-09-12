import type Phaser from 'phaser';

import { createGameExecutionController } from '@mpgd/game-runtime';
import { bindPhaserGameScene } from '@mpgd/phaser-game-runtime';

declare const scene: Phaser.Scene;
const binding = bindPhaserGameScene({
  controller: createGameExecutionController(),
  scene,
  renderingPolicy: 'visibility',
  resetInput: () => {},
  onUnsupportedState: (_snapshot, reason) => {
    void reason; },
});
binding.dispose();

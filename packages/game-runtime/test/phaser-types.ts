import type Phaser from 'phaser';

import { createGameExecutionController } from '@mpgd/game-runtime';
import { bindPhaserGameScene } from '@mpgd/game-runtime/phaser';

declare const scene: Phaser.Scene;
const binding = bindPhaserGameScene({
  controller: createGameExecutionController(),
  scene,
  renderingPolicy: 'visibility',
  resetInput: () => {},
  onUnsupportedState: (_snapshot, reason) => {
    void reason;
  },
});
binding.dispose();

import { PhaserImpactFeedbackPool } from '@mpgd/game-runtime/phaser/impact';
const feedback = new PhaserImpactFeedbackPool(scene, { capacity: 8 });
feedback.update(100);
feedback.destroy();

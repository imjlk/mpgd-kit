import Phaser from 'phaser';

import type { StarterContext } from '../runtime/starterContext';

import { starterImageAssets } from '../game/assets/manifest';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    const context = this.registry.get('starterContext') as StarterContext;
    this.load.on('progress', (progress: number) =>
      context.gameRuntime.setLoadingProgress(progress * 100),
    );
    for (const asset of starterImageAssets) {
      this.load.image(asset.key, asset.path);
    }
  }

  create(): void {
    const context = this.registry.get('starterContext') as StarterContext;
    void context.gameRuntime.completeLoading().then(() => {
      this.scene.start(context.launchIntent.entry === 'free-play' ? 'PlayScene' : 'StarterScene');
    }).catch((error: unknown) => { console.error('[game-loading]', error); });
  }
}

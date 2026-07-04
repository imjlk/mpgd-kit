import Phaser from 'phaser';

import { starterImageAssets } from '../game/assets/manifest';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    for (const asset of starterImageAssets) {
      this.load.image(asset.key, asset.path);
    }
  }

  create(): void {
    this.scene.start('StarterScene');
  }
}

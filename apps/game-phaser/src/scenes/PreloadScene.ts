import Phaser from 'phaser';

import { gameImageAssets } from '../game/assets/manifest';

export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('PreloadScene');
  }

  preload(): void {
    for (const asset of Object.values(gameImageAssets)) {
      this.load.svg(asset.key, asset.path, {
        width: asset.width,
        height: asset.height,
      });
    }
  }

  create(): void {
    this.scene.start('LobbyScene');
  }
}

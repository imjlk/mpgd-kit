import Phaser from 'phaser';

import { assetManifest } from '../runtime/assetManifest';

export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('PreloadScene');
  }

  preload(): void {
    const { orb } = assetManifest.images;
    this.load.svg(orb.key, orb.path, { width: 96, height: 96 });
  }

  create(): void {
    this.scene.start('LobbyScene');
  }
}

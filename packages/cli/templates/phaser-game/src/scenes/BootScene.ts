import Phaser from 'phaser';

import { loadPhaserAssets } from '@mpgd/phaser-assets';

import { starterAssets } from '../assets/manifest';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    loadPhaserAssets(this, starterAssets);
  }

  create(): void {
    this.scene.start('LobbyScene');
  }
}

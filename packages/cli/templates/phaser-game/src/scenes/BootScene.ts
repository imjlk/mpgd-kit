import Phaser from 'phaser';

import { loadPhaserAssets } from '@mpgd/phaser-assets';

import { starterContextKey, type StarterContext } from '../runtime/gameContext';

import { starterAssets } from '../assets/manifest';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    const context = this.registry.get(starterContextKey) as StarterContext;
    this.load.on('progress', (progress: number) =>
      context.gameRuntime.setLoadingProgress(progress * 100),
    );
    loadPhaserAssets(this, starterAssets);
  }

  create(): void {
    const context = this.registry.get(starterContextKey) as StarterContext;
    void context.gameRuntime.completeLoading().then(() => {
      this.scene.start(context.launchIntent.entry === 'free-play' ? 'PlayScene' : 'LobbyScene');
    }).catch((error: unknown) => { console.error('[game-loading]', error); });
  }
}

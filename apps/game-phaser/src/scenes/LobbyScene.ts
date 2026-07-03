import Phaser from 'phaser';

import type { PlatformGateway } from '@mpgd/platform-contract';

export class LobbyScene extends Phaser.Scene {
  constructor() {
    super('LobbyScene');
  }

  create(): void {
    const platform = this.registry.get('platform') as PlatformGateway;

    this.add
      .text(480, 150, 'MPGD Kit', {
        fontFamily: 'Inter, Arial',
        fontSize: '64px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 235, `Target: ${platform.target}`, {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#48d6c8',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 330, 'Tap or press Enter', {
        fontFamily: 'Inter, Arial',
        fontSize: '28px',
        color: '#fff7ad',
      })
      .setOrigin(0.5);

    this.add.image(480, 430, 'orb').setScale(0.9);

    const start = () => this.scene.start('GameScene');

    this.input.once('pointerdown', start);
    this.input.keyboard?.once('keydown-ENTER', start);
  }
}

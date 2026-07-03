import Phaser from 'phaser';

import type { FinishedStage } from '@mpgd/game-core';
import type { PlatformGateway } from '@mpgd/platform-contract';

export class ResultScene extends Phaser.Scene {
  constructor() {
    super('ResultScene');
  }

  create(result: FinishedStage): void {
    const platform = this.registry.get('platform') as PlatformGateway;
    const status = result.cleared ? 'Cleared' : 'Try Again';

    this.add
      .text(480, 130, status, {
        fontFamily: 'Inter, Arial',
        fontSize: '56px',
        color: result.cleared ? '#48d6c8' : '#fff7ad',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 220, `Score ${result.score.total}`, {
        fontFamily: 'Inter, Arial',
        fontSize: '34px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 300, 'Tap to return', {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#cbd5e1',
      })
      .setOrigin(0.5);

    void platform.leaderboard.submitScore({
      leaderboardId: 'default',
      score: result.score.total,
      runId: result.session.id,
      submittedAt: new Date().toISOString(),
    });

    this.input.once('pointerdown', () => this.scene.start('LobbyScene'));
    this.input.keyboard?.once('keydown-ENTER', () => this.scene.start('LobbyScene'));
  }
}

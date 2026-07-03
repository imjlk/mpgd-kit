import Phaser from 'phaser';

import type { FinishedStage } from '@mpgd/game-core';
import type { PlatformGateway } from '@mpgd/platform-contract';

import {
  addCoinsToSave,
  applyScoreToSave,
  persistDemoSave,
  type DemoState,
} from '../platform/demoState';

export class ResultScene extends Phaser.Scene {
  private platform: PlatformGateway | null = null;
  private state: DemoState | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;
  private saveText: Phaser.GameObjects.Text | null = null;
  private result: FinishedStage | null = null;

  constructor() {
    super('ResultScene');
  }

  create(result: FinishedStage): void {
    const platform = this.registry.get('platform') as PlatformGateway;
    const state = this.registry.get('demoState') as DemoState;
    const status = result.cleared ? 'Cleared' : 'Try Again';
    const nextSave = applyScoreToSave(state.save, result.score.total, result.cleared);

    this.platform = platform;
    this.state = {
      ...state,
      save: nextSave,
    };
    this.result = result;
    this.registry.set('demoState', this.state);

    this.add
      .text(480, 95, status, {
        fontFamily: 'Inter, Arial',
        fontSize: '56px',
        color: result.cleared ? '#48d6c8' : '#fff7ad',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 175, `Score ${result.score.total}`, {
        fontFamily: 'Inter, Arial',
        fontSize: '34px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.saveText = this.add
      .text(480, 230, '', {
        fontFamily: 'Inter, Arial',
        fontSize: '22px',
        color: '#cbd5e1',
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(480, 275, 'Saving result...', {
        fontFamily: 'Inter, Arial',
        fontSize: '18px',
        color: '#9fb3c8',
      })
      .setOrigin(0.5);

    this.addAction(480, 340, 'Reward ad +10 coins', () => this.claimReward());
    this.addAction(480, 390, 'Buy 100 coins', () => this.buyCoins());
    this.addAction(480, 440, 'Open leaderboard', () => this.openLeaderboard());
    this.addAction(480, 490, 'Play again', () => this.scene.start('LobbyScene'));

    this.input.keyboard?.once('keydown-ENTER', () => this.scene.start('LobbyScene'));
    this.renderSave();
    void this.persistAndSubmit();
  }

  renderGameToText(): unknown {
    return {
      score: this.result?.score.total ?? null,
      cleared: this.result?.cleared ?? null,
      coins: this.state?.save.coins ?? null,
      bestScore: this.state?.save.bestScore ?? null,
      status: this.statusText?.text ?? null,
    };
  }

  private addAction(x: number, y: number, label: string, callback: () => void): void {
    this.add
      .text(x, y, label, {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#fff7ad',
        backgroundColor: '#193340',
        padding: {
          x: 14,
          y: 8,
        },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback);
  }

  private renderSave(): void {
    if (this.saveText === null || this.state === null) {
      return;
    }

    const saveSummary = `Best ${this.state.save.bestScore}  Coins ${this.state.save.coins}`;

    this.saveText.setText(saveSummary);
  }

  private async persistAndSubmit(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    await persistDemoSave(this.platform, this.state.save);
    await this.platform.leaderboard.submitScore({
      leaderboardId: 'default',
      score: this.result.score.total,
      runId: this.result.session.id,
      submittedAt: new Date().toISOString(),
    });
    this.setStatus('Saved and submitted.');
  }

  private async claimReward(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    this.setStatus('Showing rewarded ad...');
    const reward = await this.platform.ads.showRewarded({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: `reward-${this.result.session.id}`,
    });

    if (reward.rewardGranted) {
      this.state = {
        ...this.state,
        save: addCoinsToSave(this.state.save, 10),
      };
      this.registry.set('demoState', this.state);
      await persistDemoSave(this.platform, this.state.save);
      this.renderSave();
      this.setStatus('Reward granted.');
    } else {
      this.setStatus(`Reward unavailable: ${reward.status}`);
    }
  }

  private async buyCoins(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    this.setStatus('Opening mock purchase...');
    const purchase = await this.platform.commerce.purchase({
      productId: 'COINS_100',
      source: 'result',
      idempotencyKey: `purchase-${this.result.session.id}`,
    });

    if (purchase.status === 'completed') {
      this.state = {
        ...this.state,
        save: addCoinsToSave(this.state.save, 100),
      };
      this.registry.set('demoState', this.state);
      await persistDemoSave(this.platform, this.state.save);
      this.renderSave();
      this.setStatus('Purchase completed.');
    } else {
      this.setStatus(`Purchase ${purchase.status}.`);
    }
  }

  private async openLeaderboard(): Promise<void> {
    if (this.platform === null) {
      return;
    }

    await this.platform.leaderboard.open({ leaderboardId: 'default' });
    this.setStatus('Leaderboard opened.');
  }

  private setStatus(message: string): void {
    this.statusText?.setText(message);
  }
}

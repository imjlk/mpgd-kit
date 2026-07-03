import Phaser from 'phaser';

import {
  createGameSession,
  finishStage,
  recordHit,
  recordMiss,
  type GameSession,
} from '@mpgd/game-core';

export class GameScene extends Phaser.Scene {
  private session: GameSession | null = null;
  private scoreText: Phaser.GameObjects.Text | null = null;
  private timerText: Phaser.GameObjects.Text | null = null;
  private target: Phaser.GameObjects.Image | null = null;
  private finishAtMs = 0;

  constructor() {
    super('GameScene');
  }

  create(): void {
    this.session = createGameSession({
      id: crypto.randomUUID(),
      seed: Date.now(),
      startedAtMs: this.time.now,
    });
    this.finishAtMs = this.time.now + 15_000;

    this.add
      .text(32, 28, 'Hit the orb', {
        fontFamily: 'Inter, Arial',
        fontSize: '28px',
        color: '#f8fafc',
      })
      .setOrigin(0, 0);

    this.scoreText = this.add.text(32, 72, '', {
      fontFamily: 'Inter, Arial',
      fontSize: '22px',
      color: '#cbd5e1',
    });

    this.timerText = this.add.text(760, 32, '', {
      fontFamily: 'Inter, Arial',
      fontSize: '22px',
      color: '#fff7ad',
    });

    this.target = this.add.image(480, 280, 'orb').setInteractive({ useHandCursor: true });
    this.target.on('pointerdown', () => this.hitTarget());
    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, objects: unknown[]) => {
      if (objects.length === 0) {
        this.miss();
      }
    });

    this.moveTarget();
    this.updateHud();
  }

  override update(_time: number): void {
    if (this.session === null) {
      return;
    }

    if (this.time.now >= this.finishAtMs || this.session.hits >= 10) {
      this.finish();
      return;
    }

    this.updateHud();
  }

  private hitTarget(): void {
    if (this.session === null) {
      return;
    }

    this.session = recordHit(this.session);
    this.cameras.main.flash(80, 72, 214, 200);
    this.moveTarget();
    this.updateHud();
  }

  private miss(): void {
    if (this.session === null) {
      return;
    }

    this.session = recordMiss(this.session);
    this.cameras.main.shake(80, 0.004);
    this.updateHud();
  }

  private moveTarget(): void {
    if (this.target === null) {
      return;
    }

    this.tweens.add({
      targets: this.target,
      x: Phaser.Math.Between(140, 820),
      y: Phaser.Math.Between(150, 460),
      scale: Phaser.Math.FloatBetween(0.55, 0.9),
      duration: 180,
      ease: 'Sine.easeOut',
    });
  }

  private updateHud(): void {
    if (this.session === null || this.scoreText === null || this.timerText === null) {
      return;
    }

    const secondsLeft = Math.max(0, Math.ceil((this.finishAtMs - this.time.now) / 1000));
    this.scoreText.setText(
      `Hits ${this.session.hits}/10  Misses ${this.session.misses}  Combo ${this.session.combo}`,
    );
    this.timerText.setText(`${secondsLeft}s`);
  }

  private finish(): void {
    if (this.session === null) {
      return;
    }

    const result = finishStage(this.session, this.time.now);
    this.scene.start('ResultScene', result);
    this.session = null;
  }
}

import Phaser from 'phaser';

import {
  createGameSession,
  finishStage,
  recordHit,
  recordMiss,
  type GameSession,
} from '@mpgd/game-core';

import { gameImageAssets } from '../game/assets/manifest';
import { quickstartStage } from '../game/content/stageConfig';
import { gameplayActionBindings, type GameplayInputEvent } from '../game/input/actions';
import { installGameplayInput } from '../game/input/installGameplayInput';
import type { DemoState } from '../platform/demoState';

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
    this.finishAtMs = this.time.now + quickstartStage.durationMs;

    this.add
      .text(32, 28, quickstartStage.title, {
        fontFamily: 'Inter, Arial',
        fontSize: '28px',
        color: '#f8fafc',
      })
      .setOrigin(0, 0);

    const state = this.registry.get('demoState') as DemoState | undefined;
    const progressText = `Coins ${state?.save.coins ?? 0}  Best ${state?.save.bestScore ?? 0}`;

    this.add.text(32, 112, progressText, {
      fontFamily: 'Inter, Arial',
      fontSize: '18px',
      color: '#9fb3c8',
    });

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

    this.target = this.add.image(480, 280, gameImageAssets[quickstartStage.targetImage].key);
    installGameplayInput(this, {
      target: this.target,
      onAction: (event) => this.handleInput(event),
    });

    this.moveTarget();
    this.updateHud();
  }

  override update(_time: number): void {
    if (this.session === null) {
      return;
    }

    if (
      this.time.now >= this.finishAtMs ||
      this.session.hits >= quickstartStage.completion.hitGoal
    ) {
      this.finish();
      return;
    }

    this.updateHud();
  }

  renderGameToText(): unknown {
    return {
      session: this.session,
      stage: {
        id: quickstartStage.id,
        completion: quickstartStage.completion,
        input: gameplayActionBindings,
      },
      target:
        this.target === null
          ? null
          : {
              x: this.target.x,
              y: this.target.y,
              scale: this.target.scale,
            },
      secondsLeft: Math.max(0, Math.ceil((this.finishAtMs - this.time.now) / 1000)),
    };
  }

  private handleInput(event: GameplayInputEvent): void {
    switch (event.action) {
      case 'hit-target':
        this.hitTarget();
        return;
      case 'miss':
        this.miss();
        return;
      case 'return-lobby':
        this.scene.start('LobbyScene');
        return;
    }
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
      x: Phaser.Math.Between(
        quickstartStage.targetBounds.minX,
        quickstartStage.targetBounds.maxX,
      ),
      y: Phaser.Math.Between(
        quickstartStage.targetBounds.minY,
        quickstartStage.targetBounds.maxY,
      ),
      scale: Phaser.Math.FloatBetween(
        quickstartStage.targetScale.min,
        quickstartStage.targetScale.max,
      ),
      duration: 180,
      ease: 'Sine.easeOut',
    });
  }

  private updateHud(): void {
    if (this.session === null || this.scoreText === null || this.timerText === null) {
      return;
    }

    const secondsLeft = Math.max(0, Math.ceil((this.finishAtMs - this.time.now) / 1000));
    const { hitGoal, maxMisses } = quickstartStage.completion;

    this.scoreText.setText(
      `Hits ${this.session.hits}/${hitGoal}  Misses ${this.session.misses}/${maxMisses}  Combo ${this.session.combo}`,
    );
    this.timerText.setText(`${secondsLeft}s`);
  }

  private finish(): void {
    if (this.session === null) {
      return;
    }

    const result = finishStage(this.session, this.time.now, quickstartStage.completion);
    this.scene.start('ResultScene', result);
    this.session = null;
  }
}

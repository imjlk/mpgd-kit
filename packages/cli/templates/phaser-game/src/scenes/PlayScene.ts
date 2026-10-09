import type { GameActionController } from '@mpgd/game-runtime/actions';
import { bindPhaserGameScene } from '@mpgd/game-runtime/phaser';
import Phaser from 'phaser';

import type { LogicalAdPlacementId } from '@mpgd/platform';

import { starterAssetKeys } from '../assets/manifest';
import { createStarterRunState, stepStarterRunState, type StarterRunState } from '../game/state';
import { t } from '../i18n/messages';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';
import { createClientId } from '../runtime/id';

const rewardedPlacementId = 'CONTINUE_AFTER_FAIL' satisfies LogicalAdPlacementId;

export class PlayScene extends Phaser.Scene {
  private state: StarterRunState = createStarterRunState();
  private marker!: Phaser.GameObjects.Image;
  private scoreText!: Phaser.GameObjects.Text;
  private rewardText!: Phaser.GameObjects.Text;
  private analyticsText!: Phaser.GameObjects.Text;
  private context!: StarterContext;
  private rewardedAction: GameActionController<'rewarded-ad'> | undefined;
  private lastScore = -1;
  private lastAnalyticsCount = -1;

  constructor() {
    super('PlayScene');
  }

  create(): void {
    this.context = this.registry.get(starterContextKey) as StarterContext;
    // A host exit callback cannot await a server upload. Keep this local checkpoint synchronous.
    const checkpoint = () => {
      try {
        this.context.platform.storage.saveSync?.({
          key: 'starter-run',
          value: this.state,
        });
      } catch (error) {
        console.error('[checkpoint]', error);
      }
    };
    const unsubscribeExit = this.context.platform.lifecycle.onExit?.(checkpoint);
    this.events.once('shutdown', () => {
      checkpoint();
      unsubscribeExit?.();
    });
    bindPhaserGameScene({
      controller: this.context.gameRuntime.execution,
      gameplayScope: this.context.gameRuntime.createGameplayScope(),
      scene: this,
      renderingPolicy: 'visibility',
      audioOwner: 'game',
      resetInput: () => {
        this.input.keyboard?.resetKeys();
      },
      onUnsupportedState: (_snapshot, reason) => {
        console.error('[game-execution]', reason);
      },
    });

    this.marker = this.add.image(480, 250, starterAssetKeys.marker).setDisplaySize(72, 72);
    this.scoreText = this.add
      .text(480, 86, '', {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '28px',
      })
      .setOrigin(0.5);
    this.rewardText = this.add
      .text(480, 412, this.rewardHint(), {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.analyticsText = this.add
      .text(480, 454, '', {
        color: '#9fb3c8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
      })
      .setOrigin(0.5);

    this.rewardedAction = this.context.gameRuntime.actions?.createRewardedAdController();
    const action = this.rewardedAction;
    const keyboard = this.input.keyboard;
    const onReward = () => {
      void this.requestRewardedAd();
    };
    keyboard?.on('keydown-R', onReward);
    this.events.once('shutdown', () => {
      action?.dispose();
      keyboard?.off('keydown-R', onReward);
    });
  }

  override update(_time: number, delta: number): void {
    this.state = stepStarterRunState(this.state, delta);

    const angle = this.state.phase * Math.PI * 2;
    this.marker.setPosition(480 + Math.cos(angle) * 144, 250 + Math.sin(angle) * 54);

    if (this.state.score !== this.lastScore) {
      this.lastScore = this.state.score;
      this.scoreText.setText(t(this.context.locale, 'score', { score: this.state.score }));
    }

    const analyticsCount = this.context.analyticsSink.events.length;

    if (analyticsCount !== this.lastAnalyticsCount) {
      this.lastAnalyticsCount = analyticsCount;
      this.analyticsText.setText(t(this.context.locale, 'analytics', { count: analyticsCount }));
    }
  }

  private rewardHint(): string {
    const rewardedAds = this.context.runtime.features.rewardedAds;

    if (!rewardedAds.enabled || this.context.gameServices.client === undefined || this.context.gameServices.monetizationRecovery === undefined) {
      return t(this.context.locale, 'rewardUnavailable');
    }

    return t(this.context.locale, 'rewardPending');
  }

  private async requestRewardedAd(): Promise<void> {
    const rewardedAds = this.context.runtime.features.rewardedAds;
    const action = this.rewardedAction;

    if (!rewardedAds.enabled || action === undefined || this.context.gameServices.monetizationRecovery === undefined) {
      this.rewardText.setText(t(this.context.locale, 'rewardUnavailable'));
      return;
    }

    if (this.context.gameRuntime.actions?.getAvailability() !== 'ready') {
      return;
    }
    try {
      const result = await action.execute({
        placementId: rewardedPlacementId,
        idempotencyKey: createClientId('starter-reward'),
      });

      if (action.isDisposed() || this.rewardedAction !== action) {
        return;
      }
      this.rewardText.setText(
        result.claim?.granted === true
          ? t(this.context.locale, 'reward', { status: result.status })
          : t(this.context.locale, 'rewardError'),
      );
    } catch (error) {
      await this.context.analytics.track({
        name: 'rewarded_ad_rejected',
        properties: {
          status: 'failed',
          granted: false,
        },
      });
      if (!action.isDisposed() && this.rewardedAction === action) {
        this.rewardText.setText(t(this.context.locale, 'rewardError'));
      }
      console.error('[rewarded-ad]', error);
    }
  }
}

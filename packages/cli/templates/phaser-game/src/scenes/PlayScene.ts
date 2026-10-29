import type { GameActionAvailability, GameActionController } from '@mpgd/game-runtime/actions';
import { bindPhaserGameScene } from '@mpgd/game-runtime/phaser';
import Phaser from 'phaser';

import type { LogicalAdPlacementId } from '@mpgd/platform';

import { starterAssetKeys } from '../assets/manifest';
import { createStarterRunState, stepStarterRunState, type StarterRunState } from '../game/state';
import { t } from '../i18n/messages';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';
import { createClientId } from '../runtime/id';
import { starterRunKey } from '../platform/deleteAccount';

const rewardedPlacementId = 'CONTINUE_AFTER_FAIL' satisfies LogicalAdPlacementId;

export class PlayScene extends Phaser.Scene {
  private state: StarterRunState = createStarterRunState();
  private marker!: Phaser.GameObjects.Image;
  private scoreText!: Phaser.GameObjects.Text;
  private rewardText!: Phaser.GameObjects.Text;
  private analyticsText!: Phaser.GameObjects.Text;
  private context!: StarterContext;
  private rewardedAction: GameActionController<'rewarded-ad'> | undefined;
  private showingNotReady = false;
  private requesting = false;
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
          key: starterRunKey,
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

    const actions = this.context.gameRuntime.actions;
    this.rewardedAction = actions?.createRewardedAdController();
    const action = this.rewardedAction;
    // Follow the runtime's availability, so the hint changes while any purchase
    // (one from the shop included) or ad holds the screen, without a key press.
    this.showingNotReady = false;
    this.requesting = false;
    const stopAvailability = actions?.subscribeAvailability((availability) => {
      this.showAvailability(availability);
    });
    if (actions !== undefined) {
      this.showAvailability(actions.getAvailability());
    }
    const keyboard = this.input.keyboard;
    const onReward = () => {
      void this.requestRewardedAd();
    };
    keyboard?.on('keydown-R', onReward);
    this.events.once('shutdown', () => {
      stopAvailability?.();
      action?.dispose();
      keyboard?.off('keydown-R', onReward);
    });
  }

  private showAvailability(availability: GameActionAvailability): void {
    // This scene's own request makes the actions busy too; its result text
    // follows, so only someone else's purchase or ad shows the waiting text.
    if (!this.rewardedAdsAvailable() || this.rewardedAction === undefined || availability === 'disposed'
      || this.requesting) {
      return;
    }
    if (availability === 'ready') {
      // Restore the hint only over the waiting text, never over a result.
      if (this.showingNotReady) {
        this.showingNotReady = false;
        this.rewardText.setText(this.rewardHint());
      }
      return;
    }
    this.showingNotReady = true;
    this.rewardText.setText(t(this.context.locale, 'rewardNotReady'));
  }

  /** A result or error replaces the waiting text for good: `ready` must not restore the hint over it. */
  private showRewardText(text: string): void {
    this.showingNotReady = false;
    this.rewardText.setText(text);
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

  /**
   * Rewarded ads need the target feature and the recovery client, and a run
   * that booted before its guest sign-in (session-gated services) shows none,
   * matching the runtime's `canShow` in `main.ts`.
   */
  private rewardedAdsAvailable(): boolean {
    const services = this.context.gameServices;
    return this.context.runtime.features.rewardedAds.enabled
      && services.monetizationRecovery !== undefined
      && services.ensureSession === undefined;
  }

  private rewardHint(): string {
    if (!this.rewardedAdsAvailable() || this.context.gameServices.client === undefined) {
      return t(this.context.locale, 'rewardUnavailable');
    }

    return t(this.context.locale, 'rewardPending');
  }

  private async requestRewardedAd(): Promise<void> {
    const action = this.rewardedAction;

    if (!this.rewardedAdsAvailable() || action === undefined) {
      this.showRewardText(t(this.context.locale, 'rewardUnavailable'));
      return;
    }

    // The tap-time guard stays: availability can change before the next frame.
    if (this.context.gameRuntime.actions?.getAvailability() !== 'ready') {
      return;
    }
    this.requesting = true;
    try {
      const result = await action.execute({
        placementId: rewardedPlacementId,
        idempotencyKey: createClientId('starter-reward'),
      });

      if (action.isDisposed() || this.rewardedAction !== action) {
        return;
      }
      this.showRewardText(
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
        this.showRewardText(t(this.context.locale, 'rewardError'));
      }
      console.error('[rewarded-ad]', error);
    } finally {
      if (this.rewardedAction === action) {
        this.requesting = false;
      }
    }
  }
}

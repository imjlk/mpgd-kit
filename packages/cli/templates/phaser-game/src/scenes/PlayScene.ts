import Phaser from 'phaser';

import type { LogicalAdPlacementId } from '@mpgd/platform';

import { createStarterRunState, stepStarterRunState, type StarterRunState } from '../game/state';
import { t } from '../i18n/messages';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';
import { createClientId } from '../runtime/id';

const rewardedPlacementId = 'CONTINUE_AFTER_FAIL' satisfies LogicalAdPlacementId;

export class PlayScene extends Phaser.Scene {
  private state: StarterRunState = createStarterRunState();
  private marker!: Phaser.GameObjects.Arc;
  private scoreText!: Phaser.GameObjects.Text;
  private rewardText!: Phaser.GameObjects.Text;
  private analyticsText!: Phaser.GameObjects.Text;
  private context!: StarterContext;
  private lastScore = -1;
  private lastAnalyticsCount = -1;

  constructor() {
    super('PlayScene');
  }

  create(): void {
    this.context = this.registry.get(starterContextKey) as StarterContext;

    this.marker = this.add.circle(480, 250, 34, 0x2dd4bf);
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

    this.input.keyboard?.on('keydown-R', () => {
      void this.requestRewardedAd();
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

    if (!rewardedAds.enabled) {
      return t(this.context.locale, 'rewardUnavailable');
    }

    return t(this.context.locale, 'rewardPending');
  }

  private async requestRewardedAd(): Promise<void> {
    const rewardedAds = this.context.runtime.features.rewardedAds;

    if (!rewardedAds.enabled) {
      this.rewardText.setText(t(this.context.locale, 'rewardUnavailable'));
      return;
    }

    try {
      const result = await this.context.platform.ads.showRewarded({
        placementId: rewardedPlacementId,
        idempotencyKey: createClientId('starter-reward'),
      });

      await this.context.analytics.track({
        name: result.status === 'completed' ? 'rewarded_ad_completed' : 'rewarded_ad_rejected',
        properties: {
          status: result.status,
          granted: result.rewardGranted,
        },
      });

      this.rewardText.setText(t(this.context.locale, 'reward', { status: result.status }));
    } catch (error) {
      await this.context.analytics.track({
        name: 'rewarded_ad_rejected',
        properties: {
          status: 'failed',
          granted: false,
        },
      });
      this.rewardText.setText(t(this.context.locale, 'rewardError'));
      console.error('[rewarded-ad]', error);
    }
  }
}

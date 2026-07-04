import Phaser from 'phaser';

import type { FinishedStage } from '@mpgd/game-core';
import { createGameServicesIdempotencyKey, type GameServicesClient } from '@mpgd/game-services';
import { m, type MpgdLocale } from '@mpgd/i18n';
import type { PlatformGateway } from '@mpgd/platform';
import {
  getEffectiveAdPlacementConfig,
  getEffectiveProductConfig,
  type FeatureAvailability,
  type PlatformFeature,
} from '@mpgd/target-config';

import { createDemoGameServicesClient } from '../platform/demoGameServices';
import {
  addCoinsToSave,
  applyScoreToSave,
  persistDemoSave,
  type DemoState,
} from '../platform/demoState';

export class ResultScene extends Phaser.Scene {
  private platform: PlatformGateway | null = null;
  private gameServices: GameServicesClient | null = null;
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
    const status = result.cleared
      ? m.status_cleared({}, { locale: state.locale })
      : m.status_try_again({}, { locale: state.locale });
    const nextSave = applyScoreToSave(state.save, result.score.total, result.cleared);

    this.platform = platform;
    this.state = {
      ...state,
      save: nextSave,
    };
    this.result = result;
    this.registry.set('demoState', this.state);
    this.gameServices = createDemoGameServicesClient(platform, this.state);
    const rewardedAdEnabled = this.isRewardedContinueEnabled();
    const purchaseEnabled = this.isCoinProductEnabled();
    const leaderboardOpenEnabled = this.isLeaderboardOpenEnabled();

    this.add
      .text(480, 95, status, {
        fontFamily: 'Inter, Arial',
        fontSize: '56px',
        color: result.cleared ? '#48d6c8' : '#fff7ad',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 175, m.score({ score: result.score.total }, { locale: state.locale }), {
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
      .text(480, 275, m.saving_result({}, { locale: state.locale }), {
        fontFamily: 'Inter, Arial',
        fontSize: '18px',
        color: '#9fb3c8',
      })
      .setOrigin(0.5);

    this.addAction(
      480,
      340,
      rewardedAdEnabled
        ? m.reward_ad_action({}, { locale: state.locale })
        : m.reward_ad_unavailable({}, { locale: state.locale }),
      () => {
        void this.claimReward();
      },
      {
        disabled: !rewardedAdEnabled,
      },
    );
    this.addAction(
      480,
      390,
      purchaseEnabled
        ? m.purchase_action({}, { locale: state.locale })
        : m.purchase_unavailable({}, { locale: state.locale }),
      () => {
        void this.buyCoins();
      },
      {
        disabled: !purchaseEnabled,
      },
    );
    this.addAction(
      480,
      440,
      leaderboardOpenEnabled
        ? m.leaderboard_action({}, { locale: state.locale })
        : m.leaderboard_action_unavailable({}, { locale: state.locale }),
      () => {
        void this.openLeaderboard();
      },
      {
        disabled: !leaderboardOpenEnabled,
      },
    );
    this.addAction(480, 490, m.play_again({}, { locale: state.locale }), () =>
      this.scene.start('LobbyScene'),
    );

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
      locale: this.state?.locale ?? null,
      status: this.statusText?.text ?? null,
      actions: {
        rewardedAd: this.getActionState('rewardedAds'),
        purchase: this.getActionState('iap'),
        leaderboard: this.getActionState('leaderboard'),
        localization: this.getActionState('localization'),
      },
      targetRuntime: this.state?.targetRuntime ?? null,
      effectiveConfig: this.state?.effectiveConfig ?? null,
      configuredItems: {
        coinProduct: this.effectiveCoinProduct(),
        rewardedPlacement: this.effectiveRewardedPlacement(),
        leaderboardId: this.effectiveLeaderboardId(),
      },
    };
  }

  private addAction(
    x: number,
    y: number,
    label: string,
    callback: () => void,
    options: { readonly disabled?: boolean } = {},
  ): void {
    const action = this.add
      .text(x, y, label, {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: options.disabled === true ? '#94a3b8' : '#fff7ad',
        backgroundColor: options.disabled === true ? '#24313a' : '#193340',
        padding: {
          x: 14,
          y: 8,
        },
      })
      .setOrigin(0.5);

    if (options.disabled !== true) {
      action.setInteractive({ useHandCursor: true }).on('pointerdown', callback);
    }
  }

  private renderSave(): void {
    if (this.saveText === null || this.state === null) {
      return;
    }

    const saveSummary = m.save_summary(
      {
        bestScore: this.state.save.bestScore,
        coins: this.state.save.coins,
      },
      { locale: this.state.locale },
    );

    this.saveText.setText(saveSummary);
  }

  private async persistAndSubmit(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    await persistDemoSave(this.platform, this.state.save);

    if (!this.isLeaderboardEnabled()) {
      this.setStatus(
        `${m.saved({}, { locale: this.state.locale })} ${this.unavailableMessage('leaderboard')}`,
      );
      return;
    }

    const submission = await this.gameServices?.submitLeaderboardScore({
      leaderboardId: this.effectiveLeaderboardId(),
      score: this.result.score.total,
      runId: this.result.session.id,
      submittedAt: new Date().toISOString(),
    });
    this.setStatus(
      submission?.submitted === true
        ? m.saved_and_submitted({}, { locale: this.state.locale })
        : `${m.saved({}, { locale: this.state.locale })} ${m.leaderboard_unavailable(
            {},
            { locale: this.state.locale },
          )}`,
    );
  }

  private async claimReward(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    if (!this.isRewardedContinueEnabled()) {
      this.setStatus(this.unavailableMessage('rewardedAds'));
      return;
    }

    this.setStatus(m.showing_rewarded_ad({}, { locale: this.state.locale }));
    if (this.gameServices === null) {
      this.setStatus(this.unavailableMessage('rewardedAds'));
      return;
    }

    const reward = await this.gameServices.claimRewardedAd({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: createGameServicesIdempotencyKey({
        target: this.platform.target,
        playerId: this.state.player.playerId,
        action: 'rewarded-ad',
        subjectId: 'CONTINUE_AFTER_FAIL',
        runId: this.result.session.id,
      }),
    });

    if (reward.status === 'granted') {
      this.state = {
        ...this.state,
        save: addCoinsToSave(this.state.save, 10),
      };
      this.registry.set('demoState', this.state);
      await persistDemoSave(this.platform, this.state.save);
      this.renderSave();
      this.setStatus(m.reward_granted({}, { locale: this.state.locale }));
    } else {
      this.setStatus(
        m.reward_unavailable({ status: reward.reward.status }, { locale: this.state.locale }),
      );
    }
  }

  private async buyCoins(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    if (!this.isCoinProductEnabled()) {
      this.setStatus(this.unavailableMessage('iap'));
      return;
    }

    this.setStatus(m.opening_purchase({}, { locale: this.state.locale }));
    if (this.gameServices === null) {
      this.setStatus(this.unavailableMessage('iap'));
      return;
    }

    const purchase = await this.gameServices.purchase({
      productId: 'COINS_100',
      source: 'result',
      idempotencyKey: createGameServicesIdempotencyKey({
        target: this.platform.target,
        playerId: this.state.player.playerId,
        action: 'purchase',
        subjectId: 'COINS_100',
        runId: this.result.session.id,
      }),
    });

    if (purchase.status === 'granted') {
      this.state = {
        ...this.state,
        save: addCoinsToSave(this.state.save, this.coinPurchaseAmount()),
      };
      this.registry.set('demoState', this.state);
      await persistDemoSave(this.platform, this.state.save);
      this.renderSave();
      this.setStatus(m.purchase_completed({}, { locale: this.state.locale }));
    } else {
      const statusMessage = m.purchase_status(
        { status: purchase.purchase.status },
        { locale: this.state.locale },
      );

      this.setStatus(statusMessage);
    }
  }

  private async openLeaderboard(): Promise<void> {
    if (this.platform === null || this.state === null) {
      return;
    }

    if (!this.isLeaderboardOpenEnabled()) {
      this.setStatus(this.unavailableMessage('leaderboard'));
      return;
    }

    try {
      await this.platform.leaderboard.open({ leaderboardId: this.effectiveLeaderboardId() });
      this.setStatus(m.leaderboard_opened({}, { locale: this.state.locale }));
    } catch (error) {
      console.warn(`leaderboard open failed: ${errorMessage(error)}`);
      this.setStatus(this.unavailableMessage('leaderboard'));
    }
  }

  private setStatus(message: string): void {
    this.statusText?.setText(message);
  }

  private getActionState(feature: PlatformFeature): {
    readonly enabled: boolean;
    readonly reason: FeatureAvailability['reason'] | 'unknown';
  } {
    const featureRuntime = this.state?.targetRuntime?.features[feature];

    if (featureRuntime !== undefined) {
      return {
        enabled: featureRuntime.enabled,
        reason: featureRuntime.reason,
      };
    }

    return {
      enabled: this.isCapabilityEnabled(feature),
      reason: 'unknown',
    };
  }

  private isCapabilityEnabled(feature: PlatformFeature): boolean {
    if (this.state === null) {
      return false;
    }

    switch (feature) {
      case 'iap':
        return this.state.capabilities.nativeIap;
      case 'rewardedAds':
        return this.state.capabilities.rewardedAds;
      case 'interstitialAds':
        return this.state.capabilities.interstitialAds;
      case 'leaderboard':
        return this.state.capabilities.nativeLeaderboard;
      case 'localization':
        return this.state.capabilities.localizedContent;
    }
  }

  private isCoinProductEnabled(): boolean {
    if (this.state === null) {
      return false;
    }

    if (this.state.effectiveConfig !== null) {
      return getEffectiveProductConfig(this.state.effectiveConfig, 'COINS_100')?.enabled === true;
    }

    return this.state.capabilities.nativeIap;
  }

  private isRewardedContinueEnabled(): boolean {
    if (this.state === null) {
      return false;
    }

    if (this.state.effectiveConfig !== null) {
      return (
        getEffectiveAdPlacementConfig(this.state.effectiveConfig, 'CONTINUE_AFTER_FAIL')
          ?.enabled === true
      );
    }

    return this.state.capabilities.rewardedAds;
  }

  private isLeaderboardEnabled(): boolean {
    if (this.state === null) {
      return false;
    }

    return this.state.effectiveConfig?.leaderboard.enabled ?? this.state.capabilities.nativeLeaderboard;
  }

  private isLeaderboardOpenEnabled(): boolean {
    // Devvit can submit scores but does not expose a native leaderboard UI.
    if (this.platform?.target === 'reddit') {
      return false;
    }

    return this.isLeaderboardEnabled();
  }

  private effectiveLeaderboardId(): string {
    return this.state?.effectiveConfig?.leaderboard.defaultLeaderboardId ?? 'default';
  }

  private effectiveCoinProduct() {
    const config = this.state?.effectiveConfig;

    return config === undefined || config === null
      ? null
      : (getEffectiveProductConfig(config, 'COINS_100') ?? null);
  }

  private effectiveRewardedPlacement() {
    const config = this.state?.effectiveConfig;

    return config === undefined || config === null
      ? null
      : (getEffectiveAdPlacementConfig(config, 'CONTINUE_AFTER_FAIL') ?? null);
  }

  private coinPurchaseAmount(): number {
    const grant = this.effectiveCoinProduct()?.grant;

    if (grant?.type === 'currency' && grant.currency === 'coin') {
      return grant.amount;
    }

    return 0;
  }

  private unavailableMessage(feature: PlatformFeature): string {
    const locale = this.state?.locale ?? 'en';
    const actionName = actionLabel(locale, feature);
    const reason = this.getActionState(feature).reason;

    switch (reason) {
      case 'target-disabled':
        return m.feature_target_disabled({ feature: actionName }, { locale });
      case 'capability-unsupported':
        return m.feature_unsupported({ feature: actionName }, { locale });
      case 'available':
        return m.feature_unavailable({ feature: actionName }, { locale });
      case 'unknown':
        return m.feature_unavailable({ feature: actionName }, { locale });
    }
  }
}

function actionLabel(locale: MpgdLocale, feature: PlatformFeature): string {
  switch (feature) {
    case 'iap':
      return m.action_purchases({}, { locale });
    case 'rewardedAds':
      return m.action_reward_ads({}, { locale });
    case 'interstitialAds':
      return m.action_interstitial_ads({}, { locale });
    case 'leaderboard':
      return m.action_leaderboard({}, { locale });
    case 'localization':
      return m.action_localization({}, { locale });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

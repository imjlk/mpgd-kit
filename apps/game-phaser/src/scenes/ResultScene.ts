import Phaser from 'phaser';

import type { FinishedStage } from '@mpgd/game-core';
import type { PlatformGateway } from '@mpgd/platform-contract';
import type { PolicyFeature, PolicyFeatureRuntime } from '@mpgd/policy-matrix';

import {
  addCoinsToSave,
  applyScoreToSave,
  persistDemoSave,
  type DemoState,
} from '../platform/demoState';
import { translate } from '../platform/i18n';

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
    const status = result.cleared
      ? translate(state.locale, 'statusCleared')
      : translate(state.locale, 'statusTryAgain');
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
      .text(480, 175, translate(state.locale, 'score', { score: result.score.total }), {
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
      .text(480, 275, translate(state.locale, 'savingResult'), {
        fontFamily: 'Inter, Arial',
        fontSize: '18px',
        color: '#9fb3c8',
      })
      .setOrigin(0.5);

    this.addAction(
      480,
      340,
      this.state.capabilities.rewardedAds
        ? translate(state.locale, 'rewardAdAction')
        : translate(state.locale, 'rewardAdUnavailable'),
      () => {
        void this.claimReward();
      },
      {
        disabled: !this.state.capabilities.rewardedAds,
      },
    );
    this.addAction(
      480,
      390,
      this.state.capabilities.nativeIap
        ? translate(state.locale, 'purchaseAction')
        : translate(state.locale, 'purchaseUnavailable'),
      () => {
        void this.buyCoins();
      },
      {
        disabled: !this.state.capabilities.nativeIap,
      },
    );
    this.addAction(
      480,
      440,
      this.state.capabilities.nativeLeaderboard
        ? translate(state.locale, 'leaderboardAction')
        : translate(state.locale, 'leaderboardActionUnavailable'),
      () => {
        void this.openLeaderboard();
      },
      {
        disabled: !this.state.capabilities.nativeLeaderboard,
      },
    );
    this.addAction(480, 490, translate(state.locale, 'playAgain'), () =>
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
        i18n: this.getActionState('i18n'),
      },
      policyRuntime: this.state?.policyRuntime ?? null,
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

    const saveSummary = translate(this.state.locale, 'saveSummary', {
      bestScore: this.state.save.bestScore,
      coins: this.state.save.coins,
    });

    this.saveText.setText(saveSummary);
  }

  private async persistAndSubmit(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    await persistDemoSave(this.platform, this.state.save);

    if (!this.state.capabilities.nativeLeaderboard) {
      this.setStatus(
        `${translate(this.state.locale, 'saved')} ${this.unavailableMessage('leaderboard')}`,
      );
      return;
    }

    const submission = await this.platform.leaderboard.submitScore({
      leaderboardId: 'default',
      score: this.result.score.total,
      runId: this.result.session.id,
      submittedAt: new Date().toISOString(),
    });
    this.setStatus(
      submission.submitted
        ? translate(this.state.locale, 'savedAndSubmitted')
        : `${translate(this.state.locale, 'saved')} ${translate(
            this.state.locale,
            'leaderboardUnavailable',
          )}`,
    );
  }

  private async claimReward(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    if (!this.state.capabilities.rewardedAds) {
      this.setStatus(this.unavailableMessage('rewardedAds'));
      return;
    }

    this.setStatus(translate(this.state.locale, 'showingRewardedAd'));
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
      this.setStatus(translate(this.state.locale, 'rewardGranted'));
    } else {
      this.setStatus(translate(this.state.locale, 'rewardUnavailable', { status: reward.status }));
    }
  }

  private async buyCoins(): Promise<void> {
    if (this.platform === null || this.state === null || this.result === null) {
      return;
    }

    if (!this.state.capabilities.nativeIap) {
      this.setStatus(this.unavailableMessage('iap'));
      return;
    }

    this.setStatus(translate(this.state.locale, 'openingPurchase'));
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
      this.setStatus(translate(this.state.locale, 'purchaseCompleted'));
    } else {
      this.setStatus(translate(this.state.locale, 'purchaseStatus', { status: purchase.status }));
    }
  }

  private async openLeaderboard(): Promise<void> {
    if (this.platform === null || this.state === null) {
      return;
    }

    if (!this.state.capabilities.nativeLeaderboard) {
      this.setStatus(this.unavailableMessage('leaderboard'));
      return;
    }

    await this.platform.leaderboard.open({ leaderboardId: 'default' });
    this.setStatus(translate(this.state.locale, 'leaderboardOpened'));
  }

  private setStatus(message: string): void {
    this.statusText?.setText(message);
  }

  private getActionState(feature: PolicyFeature): {
    readonly enabled: boolean;
    readonly reason: PolicyFeatureRuntime['reason'] | 'unknown';
  } {
    const featureRuntime = this.state?.policyRuntime?.features[feature];

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

  private isCapabilityEnabled(feature: PolicyFeature): boolean {
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
      case 'i18n':
        return this.state.capabilities.localizedContent;
    }
  }

  private unavailableMessage(feature: PolicyFeature): string {
    const locale = this.state?.locale ?? 'en';
    const actionName = translate(locale, actionLabels[feature]);
    const reason = this.getActionState(feature).reason;

    switch (reason) {
      case 'policy-disabled':
        return translate(locale, 'featurePolicyDisabled', { feature: actionName });
      case 'capability-unsupported':
        return translate(locale, 'featureUnsupported', { feature: actionName });
      case 'available':
        return translate(locale, 'featureUnavailable', { feature: actionName });
      case 'unknown':
        return translate(locale, 'featureUnavailable', { feature: actionName });
    }
  }
}

const actionLabels = {
  iap: 'actionPurchases',
  rewardedAds: 'actionRewardAds',
  interstitialAds: 'actionInterstitialAds',
  leaderboard: 'actionLeaderboard',
  i18n: 'actionI18n',
} satisfies Record<PolicyFeature, Parameters<typeof translate>[1]>;

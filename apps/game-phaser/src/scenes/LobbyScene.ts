import Phaser from 'phaser';

import type { PlatformGateway } from '@mpgd/platform-contract';
import type { PolicyFeature, PolicyFeatureRuntimeReason } from '@mpgd/policy-matrix';

import { loadDemoState, type DemoState } from '../platform/demoState';
import { translate } from '../platform/i18n';

export class LobbyScene extends Phaser.Scene {
  private ready = false;
  private state: DemoState | null = null;
  private playerText: Phaser.GameObjects.Text | null = null;
  private saveText: Phaser.GameObjects.Text | null = null;
  private capabilityText: Phaser.GameObjects.Text | null = null;
  private policyText: Phaser.GameObjects.Text | null = null;
  private startText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('LobbyScene');
  }

  create(): void {
    const platform = this.registry.get('platform') as PlatformGateway;

    this.add
      .text(480, 150, translate('en', 'appTitle'), {
        fontFamily: 'Inter, Arial',
        fontSize: '64px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 220, translate('en', 'target', { target: platform.target }), {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#48d6c8',
      })
      .setOrigin(0.5);

    this.playerText = this.add
      .text(480, 275, translate('en', 'loadingPlayer'), {
        fontFamily: 'Inter, Arial',
        fontSize: '22px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.saveText = this.add
      .text(480, 315, '', {
        fontFamily: 'Inter, Arial',
        fontSize: '22px',
        color: '#cbd5e1',
      })
      .setOrigin(0.5);

    this.capabilityText = this.add
      .text(480, 355, '', {
        fontFamily: 'Inter, Arial',
        fontSize: '18px',
        color: '#9fb3c8',
      })
      .setOrigin(0.5);

    this.policyText = this.add
      .text(480, 390, '', {
        fontFamily: 'Inter, Arial',
        fontSize: '17px',
        color: '#c7d2fe',
      })
      .setOrigin(0.5);

    this.startText = this.add
      .text(480, 450, translate('en', 'preparingDemo'), {
        fontFamily: 'Inter, Arial',
        fontSize: '28px',
        color: '#fff7ad',
      })
      .setOrigin(0.5);

    this.add.image(480, 510, 'orb').setScale(0.55);

    const start = () => {
      if (this.ready) {
        this.scene.start('GameScene');
      }
    };

    this.input.once('pointerdown', start);
    this.input.keyboard?.once('keydown-ENTER', start);

    void loadDemoState(platform).then((state) => {
      if (!this.scene.isActive()) {
        return;
      }

      this.ready = true;
      this.state = state;
      this.registry.set('demoState', state);
      this.renderState();
    });
  }

  renderGameToText(): unknown {
    return {
      ready: this.ready,
      playerId: this.state?.player.playerId ?? null,
      coins: this.state?.save.coins ?? null,
      bestScore: this.state?.save.bestScore ?? null,
      locale: this.state?.locale ?? null,
      policyRuntime: this.state?.policyRuntime ?? null,
    };
  }

  private renderState(): void {
    if (
      this.state === null ||
      this.playerText === null ||
      this.saveText === null ||
      this.capabilityText === null ||
      this.policyText === null ||
      this.startText === null
    ) {
      return;
    }

    const playerName = this.state.player.displayName ?? this.state.player.playerId;
    const supported = [
      this.state.capabilities.rewardedAds ? 'rewardedAds' : null,
      this.state.capabilities.nativeIap ? 'iap' : null,
      this.state.capabilities.nativeLeaderboard ? 'leaderboard' : null,
      this.state.capabilities.cloudSave ? 'save' : null,
      this.state.capabilities.localizedContent ? 'i18n' : null,
    ].filter((label): label is CapabilityLabel => label !== null);
    const locale = this.state.locale;
    const saveSummary = translate(this.state.locale, 'saveSummary', {
      bestScore: this.state.save.bestScore,
      coins: this.state.save.coins,
    });
    const capabilitySummary =
      supported.length > 0
        ? supported
            .map((capability) => translate(locale, capabilityLabels[capability]))
            .join(', ')
        : translate(this.state.locale, 'mockOnly');

    this.playerText.setText(translate(this.state.locale, 'player', { name: playerName }));
    this.saveText.setText(saveSummary);
    this.capabilityText.setText(
      translate(this.state.locale, 'sdkSummary', { features: capabilitySummary }),
    );
    this.policyText.setText(summarizePolicyRuntime(this.state));
    this.startText.setText(translate(this.state.locale, 'tapToStart'));
  }
}

const policyFeatureLabels = {
  iap: 'policyFeatureIap',
  rewardedAds: 'policyFeatureRewardedAds',
  interstitialAds: 'policyFeatureInterstitialAds',
  leaderboard: 'policyFeatureLeaderboard',
  i18n: 'policyFeatureI18n',
} satisfies Record<PolicyFeature, Parameters<typeof translate>[1]>;

const capabilityLabels = {
  rewardedAds: 'capRewardedAds',
  iap: 'capIap',
  leaderboard: 'capLeaderboard',
  save: 'capSave',
  i18n: 'capI18n',
} satisfies Record<string, Parameters<typeof translate>[1]>;

type CapabilityLabel = keyof typeof capabilityLabels;

function summarizePolicyRuntime(state: DemoState): string {
  const runtime = state.policyRuntime;

  if (runtime === null) {
    return translate(state.locale, 'policyUnavailable');
  }

  const summary = (Object.keys(policyFeatureLabels) as PolicyFeature[])
    .map((feature) => {
      const featureRuntime = runtime.features[feature];
      return `${translate(state.locale, policyFeatureLabels[feature])} ${reasonLabel(
        state,
        featureRuntime.reason,
      )}`;
    })
    .join('  ');

  return translate(state.locale, 'policySummary', {
    target: runtime.policyTarget,
    summary,
  });
}

function reasonLabel(state: DemoState, reason: PolicyFeatureRuntimeReason): string {
  switch (reason) {
    case 'available':
      return translate(state.locale, 'policyOn');
    case 'policy-disabled':
      return translate(state.locale, 'policyOff');
    case 'capability-unsupported':
      return translate(state.locale, 'policyUnsupported');
  }
}

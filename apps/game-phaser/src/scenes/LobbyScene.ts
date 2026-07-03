import Phaser from 'phaser';

import { m, type MpgdLocale } from '@mpgd/i18n';
import type { PlatformGateway } from '@mpgd/platform-contract';
import type { PolicyFeature, PolicyFeatureRuntimeReason } from '@mpgd/policy-matrix';

import { loadDemoState, type DemoState } from '../platform/demoState';

export class LobbyScene extends Phaser.Scene {
  private ready = false;
  private state: DemoState | null = null;
  private titleText: Phaser.GameObjects.Text | null = null;
  private targetText: Phaser.GameObjects.Text | null = null;
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

    this.titleText = this.add
      .text(480, 150, m.app_title({}, { locale: 'en' }), {
        fontFamily: 'Inter, Arial',
        fontSize: '64px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.targetText = this.add
      .text(480, 220, m.target({ target: platform.target }, { locale: 'en' }), {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#48d6c8',
      })
      .setOrigin(0.5);

    this.playerText = this.add
      .text(480, 275, m.loading_player({}, { locale: 'en' }), {
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
      .text(480, 450, m.preparing_demo({}, { locale: 'en' }), {
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
      text: {
        title: this.titleText?.text ?? null,
        target: this.targetText?.text ?? null,
        player: this.playerText?.text ?? null,
        save: this.saveText?.text ?? null,
        capabilities: this.capabilityText?.text ?? null,
        policy: this.policyText?.text ?? null,
        start: this.startText?.text ?? null,
      },
      policyRuntime: this.state?.policyRuntime ?? null,
    };
  }

  private renderState(): void {
    if (
      this.state === null ||
      this.titleText === null ||
      this.targetText === null ||
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
    const saveSummary = m.save_summary(
      {
        bestScore: this.state.save.bestScore,
        coins: this.state.save.coins,
      },
      { locale },
    );
    const capabilitySummary = supported.length > 0
      ? supported.map((capability) => capabilityLabel(locale, capability)).join(', ')
      : m.mock_only({}, { locale });

    const platform = this.registry.get('platform') as PlatformGateway;

    this.titleText.setText(m.app_title({}, { locale }));
    this.targetText.setText(m.target({ target: platform.target }, { locale }));
    this.playerText.setText(m.player({ name: playerName }, { locale }));
    this.saveText.setText(saveSummary);
    this.capabilityText.setText(m.sdk_summary({ features: capabilitySummary }, { locale }));
    this.policyText.setText(summarizePolicyRuntime(this.state));
    this.startText.setText(m.tap_to_start({}, { locale }));
  }
}

const capabilityLabels = {
  rewardedAds: 'rewardedAds',
  iap: 'iap',
  leaderboard: 'leaderboard',
  save: 'save',
  i18n: 'i18n',
} as const;

type CapabilityLabel = keyof typeof capabilityLabels;

function summarizePolicyRuntime(state: DemoState): string {
  const runtime = state.policyRuntime;
  const locale = state.locale;

  if (runtime === null) {
    return m.policy_unavailable({}, { locale });
  }

  const summary = (Object.keys(policyFeatureLabels) as PolicyFeature[])
    .map((feature) => {
      const featureRuntime = runtime.features[feature];
      return `${policyFeatureLabel(locale, feature)} ${reasonLabel(locale, featureRuntime.reason)}`;
    })
    .join('  ');

  return m.policy_summary(
    {
      target: runtime.policyTarget,
      summary,
    },
    { locale },
  );
}

const policyFeatureLabels = {
  iap: 'iap',
  rewardedAds: 'rewardedAds',
  interstitialAds: 'interstitialAds',
  leaderboard: 'leaderboard',
  i18n: 'i18n',
} satisfies Record<PolicyFeature, string>;

function policyFeatureLabel(locale: MpgdLocale, feature: PolicyFeature): string {
  switch (feature) {
    case 'iap':
      return m.policy_feature_iap({}, { locale });
    case 'rewardedAds':
      return m.policy_feature_rewarded_ads({}, { locale });
    case 'interstitialAds':
      return m.policy_feature_interstitial_ads({}, { locale });
    case 'leaderboard':
      return m.policy_feature_leaderboard({}, { locale });
    case 'i18n':
      return m.policy_feature_i18n({}, { locale });
  }
}

function capabilityLabel(locale: MpgdLocale, capability: CapabilityLabel): string {
  switch (capability) {
    case 'rewardedAds':
      return m.cap_rewarded_ads({}, { locale });
    case 'iap':
      return m.cap_iap({}, { locale });
    case 'leaderboard':
      return m.cap_leaderboard({}, { locale });
    case 'save':
      return m.cap_save({}, { locale });
    case 'i18n':
      return m.cap_i18n({}, { locale });
  }
}

function reasonLabel(locale: MpgdLocale, reason: PolicyFeatureRuntimeReason): string {
  switch (reason) {
    case 'available':
      return m.policy_on({}, { locale });
    case 'policy-disabled':
      return m.policy_off({}, { locale });
    case 'capability-unsupported':
      return m.policy_unsupported({}, { locale });
  }
}

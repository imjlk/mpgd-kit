import Phaser from 'phaser';

import type { PlatformGateway } from '@mpgd/platform-contract';
import type { PolicyFeature, PolicyFeatureRuntimeReason } from '@mpgd/policy-matrix';

import { loadDemoState, type DemoState } from '../platform/demoState';

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
      .text(480, 150, 'MPGD Kit', {
        fontFamily: 'Inter, Arial',
        fontSize: '64px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.add
      .text(480, 220, `Target: ${platform.target}`, {
        fontFamily: 'Inter, Arial',
        fontSize: '24px',
        color: '#48d6c8',
      })
      .setOrigin(0.5);

    this.playerText = this.add
      .text(480, 275, 'Loading player...', {
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
      .text(480, 450, 'Preparing SDK demo...', {
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
      this.state.capabilities.rewardedAds ? 'rewarded ads' : null,
      this.state.capabilities.nativeIap ? 'iap' : null,
      this.state.capabilities.nativeLeaderboard ? 'leaderboard' : null,
      this.state.capabilities.cloudSave ? 'save' : null,
    ].filter((label): label is string => label !== null);
    const saveSummary = `Best ${this.state.save.bestScore}  Coins ${this.state.save.coins}`;
    const capabilitySummary = supported.length > 0 ? supported.join(', ') : 'mock only';

    this.playerText.setText(`Player: ${playerName}`);
    this.saveText.setText(saveSummary);
    this.capabilityText.setText(`SDK: ${capabilitySummary}`);
    this.policyText.setText(summarizePolicyRuntime(this.state));
    this.startText.setText('Tap or press Enter');
  }
}

const policyFeatureLabels = {
  iap: 'IAP',
  rewardedAds: 'Reward',
  interstitialAds: 'Inter',
  leaderboard: 'Board',
} satisfies Record<PolicyFeature, string>;

function summarizePolicyRuntime(state: DemoState): string {
  const runtime = state.policyRuntime;

  if (runtime === null) {
    return 'Policy: unavailable';
  }

  const summary = (Object.keys(policyFeatureLabels) as PolicyFeature[])
    .map((feature) => {
      const featureRuntime = runtime.features[feature];
      return `${policyFeatureLabels[feature]} ${reasonLabel(featureRuntime.reason)}`;
    })
    .join('  ');

  return `Policy ${runtime.policyTarget}: ${summary}`;
}

function reasonLabel(reason: PolicyFeatureRuntimeReason): string {
  switch (reason) {
    case 'available':
      return 'on';
    case 'policy-disabled':
      return 'off';
    case 'capability-unsupported':
      return 'n/a';
  }
}

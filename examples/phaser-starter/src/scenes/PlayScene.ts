import { m } from '@mpgd/i18n';
import Phaser from 'phaser';

import {
  createStarterRunState,
  stepStarterRunState,
  type StarterRunState,
} from '../game/simulation/state';
import type { StarterContext } from '../runtime/starterContext';

export class PlayScene extends Phaser.Scene {
  private state: StarterRunState = createStarterRunState();
  private marker!: Phaser.GameObjects.Arc;
  private status!: Phaser.GameObjects.Text;

  constructor() {
    super('PlayScene');
  }

  create(): void {
    const context = this.registry.get('starterContext') as StarterContext;

    this.add
      .text(480, 92, m.sdk_summary({ features: featureSummary(context) }, { locale: context.locale }), {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5);

    this.marker = this.add.circle(480, 270, 34, 0x2dd4bf);
    this.status = this.add
      .text(480, 410, '', {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
      })
      .setOrigin(0.5);
  }

  override update(_time: number, delta: number): void {
    this.state = stepStarterRunState(this.state, delta);

    const angle = this.state.phase * Math.PI * 2;
    this.marker.setPosition(480 + Math.cos(angle) * 144, 270 + Math.sin(angle) * 54);
    this.status.setText(`Starter loop ${Math.floor(this.state.elapsedMs / 1000)}s`);
  }
}

function featureSummary(context: StarterContext): string {
  return Object.values(context.runtime.features)
    .filter((feature) => feature.enabled)
    .map((feature) => feature.feature)
    .join(', ');
}

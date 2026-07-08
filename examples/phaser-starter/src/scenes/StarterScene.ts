import { m } from '@mpgd/i18n';
import Phaser from 'phaser';

import type { StarterContext } from '../runtime/starterContext';

export class StarterScene extends Phaser.Scene {
  constructor() {
    super('StarterScene');
  }

  create(): void {
    const context = this.registry.get('starterContext') as StarterContext;
    const locale = context.locale;
    const effectiveConfig = context.runtime.effectiveConfig;
    const backendText =
      context.gameServices.mode === 'disabled'
        ? 'Game Services: disabled'
        : `Game Services: ${context.gameServices.mode} ${context.gameServices.target ?? ''}`;

    this.add.image(480, 88, 'starter-logo').setDisplaySize(96, 96);
    this.add
      .text(480, 170, m.app_title({}, { locale }), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '36px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 220, m.target({ target: context.runtime.configTarget }, { locale }), {
        color: '#9fb3c8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5);
    this.add
      .text(
        480,
        264,
        `Viewport: ${context.viewport.layout.sizeClass} ${context.viewport.layout.orientation} - controls ${context.viewport.composition.primaryControls}`,
        {
          color: '#d6dee8',
          fontFamily: 'Arial, sans-serif',
          fontSize: '18px',
        },
      )
      .setOrigin(0.5);
    this.add
      .text(
        480,
        306,
        m.effective_config_summary(
          {
            products: effectiveConfig?.monetization.products.length ?? 0,
            ads: effectiveConfig?.ads.placements.length ?? 0,
            storage: effectiveConfig?.storage.support ?? 'none',
          },
          { locale },
        ),
        {
          color: '#d6dee8',
          fontFamily: 'Arial, sans-serif',
          fontSize: '18px',
        },
      )
      .setOrigin(0.5);
    this.add
      .text(480, 348, m.player({ name: context.player.displayName ?? context.player.playerId }, { locale }), {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 388, backendText, {
        color: context.gameServices.client === undefined ? '#f59e0b' : '#2dd4bf',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 452, m.tap_to_start({}, { locale }), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
      })
      .setOrigin(0.5);

    this.input.once('pointerdown', () => this.scene.start('PlayScene'));
    this.input.keyboard?.once('keydown-ENTER', () => this.scene.start('PlayScene'));
  }
}

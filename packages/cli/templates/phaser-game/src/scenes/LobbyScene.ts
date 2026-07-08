import Phaser from 'phaser';

import { t } from '../i18n/messages';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';

export class LobbyScene extends Phaser.Scene {
  constructor() {
    super('LobbyScene');
  }

  create(): void {
    const rawContext = this.registry.get(starterContextKey);

    if (rawContext === undefined || rawContext === null) {
      throw new Error('Starter context is missing from Phaser registry.');
    }

    const context = rawContext as StarterContext;
    const locale = context.locale;
    const features = Object.values(context.runtime.features)
      .filter((feature) => feature.enabled)
      .map((feature) => feature.feature)
      .join(', ') || t(locale, 'featuresNone');

    this.add
      .text(480, 106, t(locale, 'title'), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '40px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 174, t(locale, 'target', { target: context.runtime.configTarget }), {
        color: '#9fb3c8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 216, t(locale, 'features', { features }), {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(
        480,
        258,
        t(locale, 'viewport', {
          sizeClass: context.viewport.layout.sizeClass,
          orientation: context.viewport.layout.orientation,
          controls: context.viewport.composition.primaryControls,
        }),
        {
          color: '#d6dee8',
          fontFamily: 'Arial, sans-serif',
          fontSize: '18px',
        },
      )
      .setOrigin(0.5);
    this.add
      .text(480, 300, t(locale, 'backend', { mode: context.gameServices.mode }), {
        color: context.gameServices.mode === 'disabled' ? '#f59e0b' : '#2dd4bf',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 374, t(locale, 'tapToStart'), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
      })
      .setOrigin(0.5);

    this.input.once('pointerdown', () => this.scene.start('PlayScene'));
    this.input.keyboard?.once('keydown-ENTER', () => this.scene.start('PlayScene'));
  }
}

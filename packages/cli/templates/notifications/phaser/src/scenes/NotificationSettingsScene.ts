import Phaser from 'phaser';

import {
  starterNotificationLabelsFor,
  type StarterNotificationLabels,
  type StarterNotificationSettings,
  type StarterNotificationSettingsView,
} from '../platform/notificationSettings';
import {
  createStarterNotificationSettingsModel,
  subscribeStarterNotificationSettingsOpens,
} from '../platform/notifications';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';

export const notificationSettingsSceneKey = 'NotificationSettingsScene';
/** Set when a settings open arrives before the lobby; the lobby opens the screen then. */
const pendingOpenKey = 'pendingNotificationSettings';

const textStyle = { color: '#d6dee8', fontFamily: 'Arial, sans-serif', fontSize: '18px' } as const;
const buttonStyle = { ...textStyle, color: '#5eead4' } as const;
const contentTop = 80;
const contentBottom = 480;

/**
 * Opens the settings screen for a notification open whose route is the
 * settings screen (the advertising opt-out action, a consent notice). While
 * the game is still booting the open waits for the lobby
 * (`takePendingNotificationSettings`).
 */
export function routeNotificationSettingsOpens(game: Phaser.Game, context: StarterContext): void {
  const unsubscribe = subscribeStarterNotificationSettingsOpens(context.platform, () => {
    const active = game.scene.getScenes(true).map((scene) => scene.scene.key);
    if (active.length === 0 || active.includes('BootScene')) {
      game.registry.set(pendingOpenKey, true);
      return;
    }
    for (const key of active) {
      if (key !== notificationSettingsSceneKey) {
        game.scene.stop(key);
      }
    }
    game.scene.start(notificationSettingsSceneKey);
  });
  game.events.once('destroy', unsubscribe);
}

/** Whether a settings open waited for the lobby; clears it. */
export function takePendingNotificationSettings(scene: Phaser.Scene): boolean {
  const pending = scene.registry.get(pendingOpenKey) === true;
  scene.registry.remove(pendingOpenKey);
  return pending;
}

/**
 * The game-rendered notification settings: the OS or host permission,
 * reminder topics, and the advertising and night consent the Korean rules
 * require before any advertising push (`notificationSettings.ts` holds the
 * logic). Every change is a tap; no switch starts on. The list scrolls by
 * dragging when it is taller than the screen.
 */
export class NotificationSettingsScene extends Phaser.Scene {
  private settings!: StarterNotificationSettings;
  private labels!: StarterNotificationLabels;
  private content!: Phaser.GameObjects.Container;
  private busy = false;

  constructor() {
    super(notificationSettingsSceneKey);
  }

  create(): void {
    const rawContext = this.registry.get(starterContextKey);
    if (rawContext === undefined || rawContext === null) {
      throw new Error('Starter context is missing from Phaser registry.');
    }
    const context = rawContext as StarterContext;
    // A visit that left while an action was pending starts fresh.
    this.busy = false;
    this.labels = starterNotificationLabelsFor(context.locale);
    this.settings = createStarterNotificationSettingsModel(context.platform, {
      playerId: context.player.playerId,
      locale: context.locale,
    });
    this.add
      .text(480, 40, this.labels.title, { ...textStyle, color: '#ffffff', fontSize: '30px' })
      .setOrigin(0.5);
    this.content = this.add.container(0, contentTop);
    const mask = this.make.graphics({}, false).fillRect(
      0,
      contentTop,
      960,
      contentBottom - contentTop,
    );
    this.content.setMask(mask.createGeometryMask());
    this.enableScroll();
    this.button(480, 510, this.labels.back, () => {
      this.scene.start('LobbyScene');
    }).setOrigin(0.5);
    void this.apply(() => this.settings.load());
  }

  private enableScroll(): void {
    let lastY: number | undefined;
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      lastY = pointer.y;
    });
    this.input.on('pointerup', () => {
      lastY = undefined;
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (lastY === undefined || !pointer.isDown) {
        return;
      }
      const height = this.content.getBounds().height;
      const minY = Math.min(contentTop, contentBottom - height);
      this.content.y = Phaser.Math.Clamp(this.content.y + pointer.y - lastY, minY, contentTop);
      lastY = pointer.y;
    });
  }

  private async apply(action: () => Promise<StarterNotificationSettingsView>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const view = await action();
      if (this.sys.isActive()) {
        this.render(view);
        if (view.notices.length > 0) {
          await this.settings.recordNoticesShown();
        }
      }
    } catch (error) {
      // The model reports its own failures as messages; anything else is logged.
      console.error('[notifications] settings screen failed.', error);
    } finally {
      this.busy = false;
    }
  }

  private render(view: StarterNotificationSettingsView): void {
    const text = this.labels;
    this.content.removeAll(true);
    this.content.y = contentTop;
    let y = 0;
    const line = (value: string, style: Phaser.Types.GameObjects.Text.TextStyle = textStyle) => {
      const object = this.add.text(60, y, value, { ...style, wordWrap: { width: 840 } });
      this.content.add(object);
      y += object.height + 10;
    };
    const action = (value: string, run: () => Promise<StarterNotificationSettingsView>) => {
      const object = this.button(60, y, `[ ${value} ]`, () => {
        void this.apply(run);
      });
      this.content.add(object);
      y += object.height + 8;
    };

    if (!view.available) {
      line(view.message ?? text.unavailable);
      return;
    }
    if (!view.permission.perTopic) {
      line(view.permission.state === 'granted' ? text.permissionOn : text.permissionOff);
      if (view.permission.canRequest) {
        // Explain before the one-shot OS prompt; the prompt runs only from the tap below.
        line(text.explanation, { ...textStyle, fontSize: '15px' });
        action(text.turnOn, () => this.settings.turnOn());
      }
      if (view.permission.canLogin) {
        action(text.logIn, () => this.settings.logIn());
      }
      if (view.permission.canOpenSettings) {
        action(text.openSettings, () => this.settings.openSettings());
      }
      if (view.permission.canRevoke) {
        action(text.turnOff, () => this.settings.turnOff());
      }
    }
    if (view.reminders.length > 0) {
      line(text.reminders, { ...textStyle, color: '#ffffff' });
      for (const reminder of view.reminders) {
        action(`${reminder.label}: ${reminder.enabled ? text.on : text.off}`, () =>
          this.settings.setReminder(reminder.topic, !reminder.enabled),
        );
      }
    }
    if (view.advertising !== undefined) {
      const { granted, night } = view.advertising;
      action(`${text.advertising}: ${granted ? text.on : text.off}`, () =>
        this.settings.setAdvertising({ advertising: !granted }),
      );
      line(text.advertisingHelp, { ...textStyle, fontSize: '15px' });
      action(`${text.night}: ${night ? text.on : text.off}`, () =>
        this.settings.setAdvertising({ night: !night }),
      );
    }
    if (view.notices.length > 0) {
      line(text.notices, { ...textStyle, color: '#ffffff' });
      for (const notice of view.notices) {
        line(`${notice.title}\n${notice.body}`, { ...textStyle, fontSize: '15px' });
      }
    }
    if (view.message !== undefined) {
      line(view.message, { ...textStyle, color: '#f59e0b' });
    }
  }

  private button(x: number, y: number, value: string, onTap: () => void): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, value, buttonStyle)
      .setPadding(0, 8, 24, 8)
      .setInteractive({ useHandCursor: true })
      // A drag that scrolls the list and ends on a button is not a tap.
      .on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (pointer.getDistance() < 12) {
          onTap();
        }
      });
  }
}

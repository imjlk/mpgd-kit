import Phaser from 'phaser';

import {
  starterNotificationLabelsFor,
  type StarterNotificationLabels,
  type StarterNotificationSettings,
  type StarterNotificationSettingsView,
} from '../platform/notificationSettings';
import {
  createStarterNotificationSettingsModel,
  subscribeStarterNotificationOpens,
} from '../platform/notifications';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';

export const notificationSettingsSceneKey = 'NotificationSettingsScene';

const textStyle = { color: '#d6dee8', fontFamily: 'Arial, sans-serif', fontSize: '18px' } as const;
const buttonStyle = { ...textStyle, color: '#5eead4' } as const;
/** The list's viewport on the 960x540 game: between the title and the Back button. */
const list = { top: 80, height: 400, width: 960 } as const;

/**
 * Routes notification opens: one whose route is the settings screen (the
 * advertising opt-out action, a consent notice) shows the screen, after boot
 * when the open started the game. Route your other topics' opens in `other`
 * (see `subscribeStarterNotificationOpens`): this is the first subscriber,
 * the one that receives a cold-start open. An open during play leaves the
 * run; the play scene saves its checkpoint when it shuts down.
 */
export function routeNotificationSettingsOpens(game: Phaser.Game, context: StarterContext): void {
  const activeKeys = (): string[] => game.scene.getScenes(true).map((scene) => scene.scene.key);
  const show = (): void => {
    for (const key of activeKeys()) {
      if (key !== notificationSettingsSceneKey) {
        game.scene.stop(key);
      }
    }
    game.scene.start(notificationSettingsSceneKey);
  };
  let waiting = false;
  const afterBoot = (): void => {
    const active = activeKeys();
    if (active.length === 0 || active.includes('BootScene')) {
      return;
    }
    game.events.off('poststep', afterBoot);
    waiting = false;
    show();
  };
  const unsubscribe = subscribeStarterNotificationOpens(context.platform, {
    settings: () => {
      const active = activeKeys();
      if (active.length > 0 && !active.includes('BootScene')) {
        show();
      } else if (!waiting) {
        // Booting: show the screen once the first scene after boot runs.
        waiting = true;
        game.events.on('poststep', afterBoot);
      }
    },
  });
  game.events.once('destroy', () => {
    unsubscribe();
    game.events.off('poststep', afterBoot);
  });
}

/**
 * The game-rendered notification settings: the OS or host permission,
 * reminder topics, and the advertising and night consent the Korean rules
 * require before any advertising push (`notificationSettings.ts` holds the
 * logic). Every change is a tap; no switch starts on. The list has a camera
 * of its own, which clips it under WebGL and Canvas alike and keeps hidden
 * rows from taking taps; it scrolls by dragging.
 */
export class NotificationSettingsScene extends Phaser.Scene {
  private settings!: StarterNotificationSettings;
  private labels!: StarterNotificationLabels;
  private content!: Phaser.GameObjects.Container;
  private listCamera!: Phaser.Cameras.Scene2D.Camera;
  private busy = false;
  /** Each visit's token: a pending action from an earlier visit changes nothing. */
  private visit = 0;

  constructor() {
    super(notificationSettingsSceneKey);
  }

  create(): void {
    const rawContext = this.registry.get(starterContextKey);
    if (rawContext === undefined || rawContext === null) {
      throw new Error('Starter context is missing from Phaser registry.');
    }
    const context = rawContext as StarterContext;
    this.visit += 1;
    this.busy = false;
    this.labels = starterNotificationLabelsFor(context.locale);
    this.settings = createStarterNotificationSettingsModel(context.platform, {
      playerId: context.player.playerId,
      locale: context.locale,
    });
    const title = this.add
      .text(480, 40, this.labels.title, { ...textStyle, color: '#ffffff', fontSize: '30px' })
      .setOrigin(0.5);
    const back = this.button(480, 510, this.labels.back, () => {
      this.scene.start('LobbyScene');
    }).setOrigin(0.5);
    this.content = this.add.container(0, 0);
    this.listCamera = this.cameras.add(0, list.top, list.width, list.height);
    this.listCamera.ignore([title, back]);
    this.cameras.main.ignore(this.content);
    this.enableScroll();
    const visit = this.visit;
    void this.apply(visit, () => this.settings.load());
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
      this.scrollTo(this.listCamera.scrollY - (pointer.y - lastY));
      lastY = pointer.y;
    });
  }

  private scrollTo(scrollY: number): void {
    const height = this.content.getBounds().height;
    this.listCamera.scrollY = Phaser.Math.Clamp(scrollY, 0, Math.max(0, height - list.height));
  }

  private async apply(visit: number, action: () => Promise<StarterNotificationSettingsView>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const view = await action();
      if (visit !== this.visit || !this.sys.isActive()) {
        return;
      }
      this.render(view);
      if (view.notices.length > 0) {
        // Recorded in the background: taps need not wait for it.
        void this.settings.recordNoticesShown();
      }
    } catch (error) {
      // The model reports its own failures as messages; anything else is logged.
      console.error('[notifications] settings screen failed.', error);
    } finally {
      if (visit === this.visit) {
        this.busy = false;
      }
    }
  }

  private render(view: StarterNotificationSettingsView): void {
    const text = this.labels;
    this.content.removeAll(true);
    const visit = this.visit;
    let y = 0;
    const line = (value: string, style: Phaser.Types.GameObjects.Text.TextStyle = textStyle) => {
      const object = this.add.text(60, y, value, { ...style, wordWrap: { width: 840 } });
      this.content.add(object);
      y += object.height + 10;
    };
    const action = (value: string, run: () => Promise<StarterNotificationSettingsView>) => {
      const object = this.button(60, y, `[ ${value} ]`, () => {
        void this.apply(visit, run);
      });
      this.content.add(object);
      y += object.height + 8;
    };

    // The outcome of the last tap comes first, so it is seen without scrolling.
    if (view.message !== undefined) {
      line(view.message, { ...textStyle, color: '#f59e0b' });
    }
    if (!view.available) {
      if (view.message === undefined) {
        line(text.unavailable);
      }
      this.scrollTo(0);
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
    // Keep the scroll position across a re-render, within the new height.
    this.scrollTo(this.listCamera.scrollY);
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

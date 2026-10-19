import Phaser from 'phaser';

import type {
  StarterNotificationSettings,
  StarterNotificationSettingsView,
} from '../platform/notificationSettings';
import { createStarterNotificationSettingsModel } from '../platform/notifications';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';

const labels = {
  ko: {
    title: '알림 설정',
    unavailable: '이 플랫폼에서는 알림을 쓸 수 없어요.',
    permission: { granted: '알림: 켜짐', other: '알림: 꺼짐' },
    turnOn: '[ 알림 켜기 ]',
    turnOff: '[ 알림 끄기 ]',
    openSettings: '[ 시스템 설정 열기 ]',
    reminders: '리마인더 (내가 켠 알림만 받아요)',
    advertising: '광고성 정보 수신동의 (선택)',
    advertisingHelp: '이벤트와 새 소식을 알림으로 받아요. 동의하지 않아도 게임을 그대로 이용할 수 있어요.',
    night: '야간(21시~다음 날 8시) 광고성 정보 수신동의 (선택)',
    on: '켜짐',
    off: '꺼짐',
    notices: '수신동의 안내',
    back: '[ 돌아가기 ]',
  },
  en: {
    title: 'Notifications',
    unavailable: 'Notifications are not available on this platform.',
    permission: { granted: 'Notifications: on', other: 'Notifications: off' },
    turnOn: '[ Turn on notifications ]',
    turnOff: '[ Turn off notifications ]',
    openSettings: '[ Open system settings ]',
    reminders: 'Reminders (only the ones you turn on)',
    advertising: 'Promotional notifications (optional)',
    advertisingHelp: 'Get event news as notifications. The game works the same without it.',
    night: 'Promotional notifications at night, 21:00-08:00 (optional)',
    on: 'on',
    off: 'off',
    notices: 'Consent notices',
    back: '[ Back ]',
  },
} as const;

const textStyle = { color: '#d6dee8', fontFamily: 'Arial, sans-serif', fontSize: '18px' } as const;
const buttonStyle = { ...textStyle, color: '#5eead4' } as const;

/**
 * The game-rendered notification settings: the OS or host permission,
 * reminder topics, and the advertising and night consent the Korean rules
 * require before any advertising push (`notificationSettings.ts` holds the
 * logic). Every change is a tap; no switch starts on.
 */
export class NotificationSettingsScene extends Phaser.Scene {
  private settings!: StarterNotificationSettings;
  private content: Phaser.GameObjects.GameObject[] = [];
  private busy = false;

  constructor() {
    super('NotificationSettingsScene');
  }

  create(): void {
    const context = this.registry.get(starterContextKey) as StarterContext;
    const text = context.locale === 'ko' ? labels.ko : labels.en;
    this.settings = createStarterNotificationSettingsModel(context.platform, context.locale);
    this.add.text(480, 40, text.title, { ...textStyle, color: '#ffffff', fontSize: '30px' }).setOrigin(
      0.5,
    );
    this.button(480, 510, text.back, () => {
      this.scene.start('LobbyScene');
    }).setOrigin(0.5);
    void this.apply(() => this.settings.load(), text);
  }

  private async apply(
    action: () => Promise<StarterNotificationSettingsView>,
    text: (typeof labels)['ko' | 'en'],
  ): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const view = await action();
      if (this.sys.isActive()) {
        this.render(view, text);
      }
    } finally {
      this.busy = false;
    }
  }

  private render(view: StarterNotificationSettingsView, text: (typeof labels)['ko' | 'en']): void {
    for (const object of this.content) {
      object.destroy();
    }
    this.content = [];
    let y = 90;
    const line = (value: string, style: Phaser.Types.GameObjects.Text.TextStyle = textStyle) => {
      this.content.push(this.add.text(60, y, value, { ...style, wordWrap: { width: 840 } }));
      y += 30;
    };
    const action = (value: string, run: () => Promise<StarterNotificationSettingsView>) => {
      this.content.push(
        this.button(60, y, value, () => {
          void this.apply(run, text);
        }),
      );
      y += 32;
    };

    if (!view.available) {
      line(text.unavailable);
      return;
    }
    if (!view.permission.perTopic) {
      line(view.permission.state === 'granted' ? text.permission.granted : text.permission.other);
      if (view.permission.canRequest) {
        action(text.turnOn, () => this.settings.turnOn());
      }
      if (view.permission.canOpenSettings) {
        action(text.openSettings, () => this.settings.openSettings());
      }
      if (view.permission.canRevoke) {
        action(text.turnOff, () => this.settings.turnOff());
      }
    }
    if (view.reminders.length > 0) {
      y += 6;
      line(text.reminders, { ...textStyle, color: '#ffffff' });
      for (const reminder of view.reminders) {
        action(`${reminder.label}: ${reminder.enabled ? text.on : text.off}`, () =>
          this.settings.setReminder(reminder.topic, !reminder.enabled),
        );
      }
    }
    if (view.advertising !== undefined) {
      const { granted, night } = view.advertising;
      y += 6;
      action(`${text.advertising}: ${granted ? text.on : text.off}`, () =>
        this.settings.setAdvertising({ advertising: !granted }),
      );
      line(text.advertisingHelp, { ...textStyle, fontSize: '15px' });
      action(`${text.night}: ${night ? text.on : text.off}`, () =>
        this.settings.setAdvertising({ night: !night }),
      );
    }
    if (view.notices.length > 0) {
      y += 6;
      line(text.notices, { ...textStyle, color: '#ffffff' });
      for (const notice of view.notices) {
        line(`${notice.title} - ${notice.body}`, { ...textStyle, fontSize: '15px' });
      }
    }
    if (view.message !== undefined) {
      y = Math.max(y + 6, 460);
      line(view.message, { ...textStyle, color: '#f59e0b' });
    }
  }

  private button(x: number, y: number, value: string, onTap: () => void): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, value, buttonStyle)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', onTap);
  }
}

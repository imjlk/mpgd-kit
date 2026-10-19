import type {
  StarterNotificationSettings,
  StarterNotificationSettingsView,
} from '../platform/notificationSettings';
import { createStarterNotificationSettingsModel } from '../platform/notifications';
import type { StarterContext } from '../runtime/gameContext';

const labels = {
  ko: {
    open: '알림 설정',
    close: '닫기',
    unavailable: '이 플랫폼에서는 알림을 쓸 수 없어요.',
    on: '켜짐',
    off: '꺼짐',
    permission: '알림',
    turnOn: '알림 켜기',
    turnOff: '알림 끄기',
    openSettings: '시스템 설정 열기',
    advertising: '광고성 정보 수신동의 (선택)',
    advertisingHelp: '이벤트와 새 소식을 알림으로 받아요. 동의하지 않아도 게임을 그대로 이용할 수 있어요.',
    night: '야간(21시~다음 날 8시) 광고성 정보 수신동의 (선택)',
  },
  en: {
    open: 'Notifications',
    close: 'Close',
    unavailable: 'Notifications are not available on this platform.',
    on: 'on',
    off: 'off',
    permission: 'Notifications',
    turnOn: 'Turn on notifications',
    turnOff: 'Turn off notifications',
    openSettings: 'Open system settings',
    advertising: 'Promotional notifications (optional)',
    advertisingHelp: 'Get event news as notifications. The game works the same without it.',
    night: 'Promotional notifications at night, 21:00-08:00 (optional)',
  },
} as const;

/**
 * A minimal notification settings panel for the lite template: a button over
 * the game opens a DOM panel with the OS or host permission, reminders, and
 * the advertising and night consent (`notificationSettings.ts` holds the
 * logic). Every change is a tap; no switch starts on. Returns the disposer.
 */
export function mountNotificationSettingsPanel(mount: HTMLElement, context: StarterContext): () => void {
  const text = context.locale === 'ko' ? labels.ko : labels.en;
  let settings: StarterNotificationSettings | undefined;
  let busy = false;
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.style.cssText = 'position:absolute;inset:8%;overflow:auto;padding:16px;'
    + 'background:#0b1726;color:#d6dee8;font:14px system-ui,sans-serif;border-radius:12px;display:none;';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.textContent = text.open;
  openButton.style.cssText = 'position:absolute;top:8px;right:8px;';
  // Taps on the panel stay out of the game's own tap handling.
  for (const element of [panel, openButton]) {
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  const apply = async (action: () => Promise<StarterNotificationSettingsView>): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      render(await action());
    } finally {
      busy = false;
    }
  };
  const button = (label: string, run: () => Promise<StarterNotificationSettingsView>): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.display = 'block';
    element.style.margin = '6px 0';
    element.addEventListener('click', () => {
      void apply(run);
    });
    return element;
  };
  const paragraph = (value: string): HTMLParagraphElement => {
    const element = document.createElement('p');
    element.textContent = value;
    return element;
  };
  const render = (view: StarterNotificationSettingsView): void => {
    const model = settings;
    if (model === undefined) {
      return;
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = text.close;
    close.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    const children: HTMLElement[] = [close];
    if (!view.available) {
      children.push(paragraph(text.unavailable));
    } else {
      if (!view.permission.perTopic) {
        children.push(
          paragraph(
            `${text.permission}: ${view.permission.state === 'granted' ? text.on : text.off}`,
          ),
        );
        if (view.permission.canRequest) {
          children.push(button(text.turnOn, () => model.turnOn()));
        }
        if (view.permission.canOpenSettings) {
          children.push(button(text.openSettings, () => model.openSettings()));
        }
        if (view.permission.canRevoke) {
          children.push(button(text.turnOff, () => model.turnOff()));
        }
      }
      for (const reminder of view.reminders) {
        children.push(
          button(`${reminder.label}: ${reminder.enabled ? text.on : text.off}`, () =>
            model.setReminder(reminder.topic, !reminder.enabled),
          ),
        );
      }
      if (view.advertising !== undefined) {
        const { granted, night } = view.advertising;
        children.push(
          button(`${text.advertising}: ${granted ? text.on : text.off}`, () =>
            model.setAdvertising({ advertising: !granted }),
          ),
        );
        children.push(paragraph(text.advertisingHelp));
        children.push(
          button(`${text.night}: ${night ? text.on : text.off}`, () =>
            model.setAdvertising({ night: !night }),
          ),
        );
      }
      for (const notice of view.notices) {
        children.push(paragraph(`${notice.title} - ${notice.body}`));
      }
    }
    if (view.message !== undefined) {
      children.push(paragraph(view.message));
    }
    panel.replaceChildren(...children);
  };

  openButton.addEventListener('click', () => {
    panel.style.display = 'block';
    settings ??= createStarterNotificationSettingsModel(context.platform, context.locale);
    const model = settings;
    void apply(() => model.load());
  });
  if (getComputedStyle(mount).position === 'static') {
    mount.style.position = 'relative';
  }
  mount.append(openButton, panel);
  return () => {
    openButton.remove();
    panel.remove();
  };
}

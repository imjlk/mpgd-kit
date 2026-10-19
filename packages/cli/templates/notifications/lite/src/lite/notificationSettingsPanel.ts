import {
  starterNotificationLabelsFor,
  type StarterNotificationSettings,
  type StarterNotificationSettingsView,
} from '../platform/notificationSettings';
import {
  createStarterNotificationSettingsModel,
  subscribeStarterNotificationOpens,
} from '../platform/notifications';
import type { StarterContext } from '../runtime/gameContext';

/**
 * A minimal notification settings panel for the lite template: a button over
 * the game opens a DOM panel with the OS or host permission, reminders, and
 * the advertising and night consent (`notificationSettings.ts` holds the
 * logic). Every change is a tap; no switch starts on. A notification open
 * whose route is the settings screen (the advertising opt-out action, a
 * consent notice) opens the panel too. Returns the disposer.
 */
export function mountNotificationSettingsPanel(mount: HTMLElement, context: StarterContext): () => void {
  if (context.platform.notificationsV2 === undefined) {
    // This target has no notifications: no button that opens an empty panel.
    return () => undefined;
  }
  const text = starterNotificationLabelsFor(context.locale);
  let settings: StarterNotificationSettings | undefined;
  let busy = false;
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', text.title);
  panel.style.cssText = 'position:absolute;inset:8%;overflow:auto;padding:16px;'
    + 'background:#0b1726;color:#d6dee8;font:14px system-ui,sans-serif;border-radius:12px;display:none;';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.textContent = text.title;
  openButton.style.cssText = 'position:absolute;top:8px;right:8px;padding:8px 12px;';
  // Taps on the panel stay out of the game's own tap handling.
  for (const element of [panel, openButton]) {
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  const model = (): StarterNotificationSettings => {
    settings ??= createStarterNotificationSettingsModel(context.platform, {
      playerId: context.player.playerId,
      locale: context.locale,
    });
    return settings;
  };
  const apply = async (action: () => Promise<StarterNotificationSettingsView>): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const view = await action();
      // A panel closed or removed meanwhile shows nothing, so records nothing.
      if (panel.style.display === 'none' || !panel.isConnected) {
        return;
      }
      render(view);
      if (view.notices.length > 0) {
        // Recorded in the background: taps need not wait for it.
        void model().recordNoticesShown();
      }
    } catch (error) {
      // The model reports its own failures as messages; anything else is logged.
      console.error('[notifications] settings panel failed.', error);
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
    // Notices put their title and body on two lines.
    element.style.whiteSpace = 'pre-line';
    return element;
  };
  const render = (view: StarterNotificationSettingsView): void => {
    const current = model();
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = text.close;
    close.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    const children: HTMLElement[] = [close];
    if (!view.available) {
      children.push(paragraph(view.message ?? text.unavailable));
      panel.replaceChildren(...children);
      return;
    }
    if (!view.permission.perTopic) {
      children.push(
        paragraph(view.permission.state === 'granted' ? text.permissionOn : text.permissionOff),
      );
      if (view.permission.canRequest) {
        // Explain before the one-shot OS prompt; the prompt runs only from the tap below.
        children.push(paragraph(text.explanation));
        children.push(button(text.turnOn, () => current.turnOn()));
      }
      if (view.permission.canLogin) {
        children.push(button(text.logIn, () => current.logIn()));
      }
      if (view.permission.canOpenSettings) {
        children.push(button(text.openSettings, () => current.openSettings()));
      }
      if (view.permission.canRevoke) {
        children.push(button(text.turnOff, () => current.turnOff()));
      }
    }
    if (!view.recording && (view.reminders.length > 0 || view.advertising !== undefined)) {
      // Nothing could record these choices: no switches that cannot work.
      children.push(paragraph(text.notConnected));
    } else if (view.reminders.length > 0) {
      children.push(paragraph(text.reminders));
      for (const reminder of view.reminders) {
        children.push(
          button(`${reminder.label}: ${reminder.enabled ? text.on : text.off}`, () =>
            current.setReminder(reminder.topic, !reminder.enabled),
          ),
        );
      }
    }
    if (view.recording && view.advertising !== undefined) {
      const { granted, night } = view.advertising;
      children.push(
        button(`${text.advertising}: ${granted ? text.on : text.off}`, () =>
          current.setAdvertising({ advertising: !granted }),
        ),
      );
      children.push(paragraph(text.advertisingHelp));
      children.push(
        button(`${text.night}: ${night ? text.on : text.off}`, () =>
          current.setAdvertising({ night: !night }),
        ),
      );
    }
    if (view.notices.length > 0) {
      children.push(paragraph(text.notices));
      for (const notice of view.notices) {
        children.push(paragraph(`${notice.title}\n${notice.body}`));
      }
    }
    if (view.message !== undefined) {
      children.push(paragraph(view.message));
    }
    panel.replaceChildren(...children);
  };

  const open = (): void => {
    panel.style.display = 'block';
    const current = model();
    void apply(() => current.load());
  };
  openButton.addEventListener('click', open);
  // The game's one listener for opens, which receives a cold-start open:
  // route your other topics' opens in `other` here.
  const unsubscribe = subscribeStarterNotificationOpens(context.platform, { settings: open });
  if (getComputedStyle(mount).position === 'static') {
    mount.style.position = 'relative';
  }
  mount.append(openButton, panel);
  return () => {
    unsubscribe();
    openButton.remove();
    panel.remove();
  };
}

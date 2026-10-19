import type { StorageAdapter } from '@mpgd/platform';
import {
  fillNotificationTemplate,
  findNotificationCopy,
  notificationNoticeVariantCopy,
  type NotificationCapabilities,
  type NotificationNotice,
  type NotificationNoticeCopy,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
  type NotificationRequiredAction,
  type NotificationRuntime,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

/**
 * The notification settings screen's model, shared by the Phaser scene and
 * the lite panel: the OS or host permission, the reminders the player turns
 * on (`requested` topics), and the consent the Korean rules ask for before
 * any advertising: 광고성 정보 수신동의 and the separate night consent
 * (21:00 to 08:00).
 *
 * - Every change starts from a player action (a tap), which is the gesture
 *   Apps in Toss and Devvit require. Nothing here prompts on its own, and no
 *   switch is on before the player turns it on.
 * - Consent is recorded through the notifications runtime, which sends it to
 *   the game backend: the server keeps the records the policy gate reads.
 *   Without a runtime (see `createStarterNotificationRuntime`), the screen
 *   asks only for the OS or host permission and keeps the switches off.
 * - A reminder or consent is never paid for: the game gives no reward for
 *   turning notifications on, and keeps working when the player declines.
 */
export interface StarterNotificationSettingsView {
  /** False when this target exposes no notifications (`gateway.notificationsV2` is absent). */
  readonly available: boolean;
  /** Whether consent can be recorded: a runtime is present. */
  readonly recording: boolean;
  readonly permission: {
    /** The app permission, or for a host that asks per topic, the reminders' combined state. */
    readonly state: NotificationPermissionState;
    /** Whether the permission is per topic (Apps in Toss): it is asked when a reminder is turned on. */
    readonly perTopic: boolean;
    /** Whether a tap may show the OS or host prompt now. */
    readonly canRequest: boolean;
    /** Whether only the system settings can change it, and the game can open them. */
    readonly canOpenSettings: boolean;
    /** Whether the player turned the consent on in the game and can turn it off here (Devvit). */
    readonly canRevoke: boolean;
    readonly requiredAction?: NotificationRequiredAction;
  };
  readonly reminders: readonly {
    readonly topic: string;
    readonly label: string;
    /** As last recorded from this device; the server record decides. */
    readonly enabled: boolean;
  }[];
  /** Present when this target delivers an advertising topic. */
  readonly advertising?: {
    readonly granted: boolean;
    readonly night: boolean;
  };
  /** Consent notices the server says are due, already in the player's language. */
  readonly notices: readonly { readonly title: string; readonly body: string }[];
  /** The latest action's outcome, for the screen to show. */
  readonly message?: string;
}

export interface StarterNotificationSettingsInput {
  /** `gateway.notificationsV2`; absent on targets without notifications. */
  readonly provider: NotificationProvider | undefined;
  /** The game's notifications runtime; absent until the game has a backend for it. */
  readonly runtime: NotificationRuntime | undefined;
  /** The topics this target maps (`starterNotificationTopics(configTarget)`). */
  readonly topics: readonly NotificationTopicDeclaration[];
  /** `notices.copy` of the catalog, for the notices the server lists. */
  readonly noticeCopy?: NotificationNoticeCopy;
  readonly defaultLocale: string;
  /** The consent text version recorded with advertising and night consent. */
  readonly consentTextVersion: string;
  /** Remembers this device's last recorded choices for display; `gateway.storage`. */
  readonly storage?: StorageAdapter;
  readonly locale: string;
}

export interface StarterNotificationSettings {
  load(): Promise<StarterNotificationSettingsView>;
  /** From a tap: asks for the OS or host permission (app-scope hosts). */
  turnOn(): Promise<StarterNotificationSettingsView>;
  /** From a tap: withdraws a consent the game rendered (Devvit). */
  turnOff(): Promise<StarterNotificationSettingsView>;
  /** From a tap: opens the system notification settings. */
  openSettings(): Promise<StarterNotificationSettingsView>;
  /** From a tap: turns one reminder topic on (asking for its permission first) or off. */
  setReminder(topic: string, enabled: boolean): Promise<StarterNotificationSettingsView>;
  /** From a tap: records advertising or night consent, or its withdrawal. */
  setAdvertising(change: { readonly advertising?: boolean; readonly night?: boolean }): Promise<StarterNotificationSettingsView>;
}

const storageKey = 'mpgd.notification-settings.v1';

interface Remembered {
  readonly reminders: Readonly<Record<string, boolean>>;
  readonly advertising: boolean;
  readonly night: boolean;
}

const copy = {
  ko: {
    reminderLabels: { 'daily-ready': '오늘의 플레이 알림', 'streak-at-risk': '연속 기록 알림' } as Record<string, string>,
    granted: '알림을 켰어요.',
    denied: '알림이 꺼져 있어요. 원하면 언제든 다시 켤 수 있어요.',
    blocked: '알림이 꺼져 있어요. 시스템 설정에서 켤 수 있어요.',
    dismissed: '선택하지 않았어요.',
    login: '알림을 켜려면 먼저 로그인해 주세요.',
    hostSettings: '앱의 개인화 약관에 동의해야 알림을 켤 수 있어요.',
    unavailable: '이 기기에서는 알림을 켤 수 없어요.',
    noRecording: '서버가 연결되지 않아 수신 설정을 저장할 수 없어요.',
    failed: '설정을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.',
    advertisingOn: '광고성 정보 수신에 동의했어요.',
    advertisingOff: '광고성 정보 수신동의를 철회했어요.',
    nightOn: '야간 광고성 정보 수신에 동의했어요.',
    nightOff: '야간 광고성 정보 수신동의를 철회했어요.',
    reminderOn: '리마인더를 켰어요.',
    reminderOff: '리마인더를 껐어요.',
  },
  en: {
    reminderLabels: { 'daily-ready': "Today's run reminder", 'streak-at-risk': 'Streak reminder' } as Record<string, string>,
    granted: 'Notifications are on.',
    denied: 'Notifications are off. You can turn them on any time.',
    blocked: 'Notifications are off. You can turn them on in system settings.',
    dismissed: 'Nothing was changed.',
    login: 'Log in first to turn notifications on.',
    hostSettings: "Agree to the app's personalization terms to turn notifications on.",
    unavailable: 'Notifications are not available on this device.',
    noRecording: 'The game server is not connected, so these choices cannot be saved.',
    failed: 'The setting could not be changed. Try again later.',
    advertisingOn: 'You agreed to promotional notifications.',
    advertisingOff: 'You withdrew your consent to promotional notifications.',
    nightOn: 'You agreed to promotional notifications at night.',
    nightOff: 'You withdrew your consent to promotional notifications at night.',
    reminderOn: 'The reminder is on.',
    reminderOff: 'The reminder is off.',
  },
} as const;

type Strings = (typeof copy)['en' | 'ko'];

export function createStarterNotificationSettings(
  input: StarterNotificationSettingsInput,
): StarterNotificationSettings {
  const strings: Strings = input.locale.toLowerCase().startsWith('ko') ? copy.ko : copy.en;
  const reminderTopics = input.topics.filter((topic) => topic.purpose === 'requested');
  const advertisingTopics = input.topics.filter((topic) => topic.purpose === 'advertising');
  // Every topic but advertising asks for delivery permission up front; an
  // advertising topic needs the player's advertising consent first.
  const permissionTopics = input.topics
    .filter((topic) => topic.purpose !== 'advertising')
    .map((topic) => topic.id);
  let remembered: Remembered = { reminders: {}, advertising: false, night: false };
  let capabilities: NotificationCapabilities | undefined;
  let message: string | undefined;
  let notices: StarterNotificationSettingsView['notices'] = [];

  // Without a runtime only the provider can read and ask for the permission;
  // nothing is recorded then, and the host still enforces its own answer.
  const readPermission = async (
    provider: NotificationProvider,
    topics: readonly string[],
  ): Promise<NotificationPermissionSnapshot> =>
    input.runtime === undefined
      ? provider.getPermission({ topics })
      : input.runtime.getPermission({ topics });

  const view = async (): Promise<StarterNotificationSettingsView> => {
    if (input.provider === undefined) {
      return {
        available: false,
        recording: false,
        permission: {
          state: 'unsupported',
          perTopic: false,
          canRequest: false,
          canOpenSettings: false,
          canRevoke: false,
        },
        reminders: [],
        notices: [],
        ...(message === undefined ? {} : { message }),
      };
    }
    capabilities ??= await input.provider.getCapabilities();
    const perTopic = capabilities.permission.scope === 'topic';
    const snapshot = await readPermission(input.provider, permissionTopics);
    const state = perTopic
      ? combinedState(
          snapshot,
          reminderTopics.map((topic) => topic.id),
        )
      : (snapshot.app ?? 'unsupported');
    return {
      available: capabilities.availability !== 'unsupported',
      recording: input.runtime !== undefined,
      permission: {
        state,
        perTopic,
        canRequest: !perTopic && isRequestable(state),
        canOpenSettings: state === 'blocked' && capabilities.permission.settings,
        canRevoke: capabilities.permission.prompt === 'game' && state === 'granted'
          && input.runtime !== undefined,
        ...(snapshot.requiredAction === undefined ? {} : { requiredAction: snapshot.requiredAction }),
      },
      reminders: reminderTopics.map((topic) => ({
        topic: topic.id,
        label: strings.reminderLabels[topic.id] ?? topic.id,
        enabled: input.runtime !== undefined && remembered.reminders[topic.id] === true,
      })),
      ...(advertisingTopics.length === 0
        ? {}
        : {
            advertising: {
              granted: input.runtime !== undefined && remembered.advertising,
              night: input.runtime !== undefined && remembered.night,
            },
          }),
      notices,
      ...(message === undefined ? {} : { message }),
    };
  };

  const remember = async (next: Remembered): Promise<void> => {
    remembered = next;
    try {
      await input.storage?.save({ key: storageKey, value: next });
    } catch (error) {
      // Only a display hint: the server keeps the record.
      console.warn('[notifications] could not remember the settings on this device.', error);
    }
  };

  const run = async (action: () => Promise<string | undefined>): Promise<StarterNotificationSettingsView> => {
    try {
      message = await action();
    } catch (error) {
      console.warn('[notifications] settings change failed.', error);
      message = strings.failed;
    }
    return view();
  };

  const request = async (topics: readonly string[]): Promise<string> => {
    const provider = input.provider;
    if (provider === undefined) {
      return strings.unavailable;
    }
    const result = input.runtime === undefined
      ? await provider.requestPermission({ topics })
      : await input.runtime.requestPermission({ topics, gesture: true });
    const outcomes = Object.values(result.outcomes);
    if (outcomes.some((outcome) => outcome === 'granted' || outcome === 'already-granted')) {
      return strings.granted;
    }
    if (result.requiredAction === 'host-settings') {
      return strings.hostSettings;
    }
    if (result.requiredAction === 'login' || outcomes.includes('action-required')) {
      return strings.login;
    }
    if (outcomes.includes('blocked')) {
      return strings.blocked;
    }
    if (outcomes.includes('denied')) {
      return strings.denied;
    }
    return outcomes.includes('dismissed') ? strings.dismissed : strings.unavailable;
  };

  return {
    async load() {
      try {
        const stored = await input.storage?.load({ key: storageKey });
        remembered = readRemembered(stored?.value);
      } catch (error) {
        console.warn('[notifications] could not read the remembered settings.', error);
      }
      if (input.runtime !== undefined) {
        try {
          const listed = await input.runtime.notices.list();
          notices = renderNotices(listed, input);
          // The screen shows them now: record each as given in the game, so
          // the server does not push it as well.
          for (const notice of listed) {
            await input.runtime.notices.recordShown(notice);
          }
        } catch (error) {
          console.warn('[notifications] consent notices are unavailable.', error);
        }
      }
      return view();
    },
    turnOn() {
      return run(() => request(permissionTopics));
    },
    turnOff() {
      return run(async () => {
        if (input.runtime === undefined) {
          return strings.noRecording;
        }
        await input.runtime.revokePermission({ topics: permissionTopics });
        return strings.denied;
      });
    },
    openSettings() {
      return run(async () => {
        const opened = input.runtime === undefined
          ? await input.provider?.openSettings?.()
          : await input.runtime.openSettings();
        return opened === 'opened' ? undefined : strings.unavailable;
      });
    },
    setReminder(topic, enabled) {
      return run(async () => {
        if (input.runtime === undefined) {
          return strings.noRecording;
        }
        if (!reminderTopics.some((candidate) => candidate.id === topic)) {
          return strings.unavailable;
        }
        if (enabled) {
          const snapshot = await input.runtime.getPermission({ topics: [topic] });
          const state = snapshot.app ?? snapshot.topics[topic] ?? 'unsupported';
          if (state !== 'granted') {
            // The prompt is this tap's: an Apps in Toss topic gets its own sheet.
            const answer = await request([topic]);
            if (answer !== strings.granted) {
              return answer;
            }
          }
        }
        await input.runtime.setTopicPreference({ topic, enabled });
        await remember({ ...remembered, reminders: { ...remembered.reminders, [topic]: enabled } });
        return enabled ? strings.reminderOn : strings.reminderOff;
      });
    },
    setAdvertising(change) {
      return run(async () => {
        if (input.runtime === undefined) {
          return strings.noRecording;
        }
        if (advertisingTopics.length === 0) {
          return strings.unavailable;
        }
        await input.runtime.setAdvertisingConsent({
          ...(change.advertising === undefined
            ? {}
            : { advertising: change.advertising ? 'granted' : 'withdrawn' }),
          ...(change.night === undefined ? {} : { night: change.night ? 'granted' : 'withdrawn' }),
          textVersion: input.consentTextVersion,
        });
        await remember({
          ...remembered,
          advertising: change.advertising ?? remembered.advertising,
          night: change.night ?? remembered.night,
        });
        if (change.advertising !== undefined) {
          return change.advertising ? strings.advertisingOn : strings.advertisingOff;
        }
        return change.night === true ? strings.nightOn : strings.nightOff;
      });
    },
  };
}

function isRequestable(state: NotificationPermissionState): boolean {
  return state === 'prompt' || state === 'prompt-with-rationale' || state === 'denied' || state === 'unknown';
}

/** A per-topic host's state for the screen: granted when every reminder is, else the first other state. */
function combinedState(
  snapshot: NotificationPermissionSnapshot,
  topics: readonly string[],
): NotificationPermissionState {
  const states = topics.map((topic) => snapshot.topics[topic] ?? 'unsupported');
  if (states.length === 0) {
    return 'unsupported';
  }
  return states.find((state) => state !== 'granted') ?? 'granted';
}

function readRemembered(value: unknown): Remembered {
  if (typeof value !== 'object' || value === null) {
    return { reminders: {}, advertising: false, night: false };
  }
  const record = value as Partial<Record<keyof Remembered, unknown>>;
  const reminders: Record<string, boolean> = {};
  if (typeof record.reminders === 'object' && record.reminders !== null) {
    for (const [topic, enabled] of Object.entries(record.reminders)) {
      if (enabled === true) {
        reminders[topic] = true;
      }
    }
  }
  return {
    reminders,
    advertising: record.advertising === true,
    night: record.night === true,
  };
}

/** The notices in the player's language, filled with the record's Asia/Seoul date as the server fills a pushed one. */
function renderNotices(
  listed: readonly NotificationNotice[],
  input: StarterNotificationSettingsInput,
): StarterNotificationSettingsView['notices'] {
  const noticeCopy = input.noticeCopy;
  if (noticeCopy === undefined) {
    return [];
  }
  return listed.flatMap((notice) => {
    const text = findNotificationCopy(
      { copy: notificationNoticeVariantCopy(noticeCopy, notice.variant) },
      input.locale,
      input.defaultLocale,
    );
    if (text === undefined) {
      return [];
    }
    const consentDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(notice.record.at));
    return [{
      title: fillNotificationTemplate(text.title, { consentDate }),
      body: fillNotificationTemplate(text.body, { consentDate }),
    }];
  });
}

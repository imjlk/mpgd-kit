/**
 * The notifications starter (`mpgd game create --providers notifications`):
 * the files `templates/notifications` adds to a generated game, and the
 * anchored edits it makes to the base template, so a game without
 * notifications ships none of it (notifications v2 RFC, PR C1).
 *
 * Every edit names an anchor that must occur exactly once in the base file,
 * so a template change that moves an anchor fails the CLI's tests instead of
 * generating a half-wired game.
 */

/** The provider id that selects the notifications starter. */
export const notificationsProviderId = 'notifications';

/**
 * The npm packages a game with notifications declares. The two Capacitor
 * plugins are the optional peers `@mpgd/adapter-capacitor/notifications`
 * loads, at the versions the adapter is tested with; `firebase` is the
 * package the messaging plugin's web fallback imports, which the bundler
 * must resolve even though a native shell never loads it.
 */
export const notificationsGameDependencies: Readonly<Record<string, string>> = Object.freeze({
  '@capacitor-firebase/messaging': '8.5.2',
  '@capacitor/local-notifications': '8.3.1',
  firebase: '12.19.0',
});

/** The plugins `mpgd target init capacitor --providers notifications` installs into the shell. */
export const notificationsShellPlugins: readonly string[] = Object.freeze([
  '@capacitor-firebase/messaging',
  '@capacitor/local-notifications',
]);

/** Never installed next to the messaging plugin: on iOS both claim Capacitor's one push handler. */
export const conflictingPushPlugin = '@capacitor/push-notifications';

export type NotificationsStarterTemplate = 'phaser' | 'lite';

export interface NotificationsStarterFile {
  readonly relativePath: string;
  readonly content: string;
}

interface AnchoredEdit {
  readonly anchor: string;
  readonly replacement: string;
}

const gatewayImport: AnchoredEdit = {
  anchor: "import type { RuntimeConfig } from '../runtimeDetector';\n",
  replacement: [
    "import { createStarterCapacitorNotifications } from '../capacitorNotifications';",
    "import type { RuntimeConfig } from '../runtimeDetector';",
    '',
  ].join('\n'),
};

const gatewayProviders = (platform: 'android' | 'ios'): AnchoredEdit => ({
  anchor: '  const providers = createStoreProviders(runtime, () => gateway);\n',
  replacement: [
    '  const providers = [',
    '    ...createStoreProviders(runtime, () => gateway),',
    '    // Notifications v2 (FCM and local reminders); `notifications/topics.json`',
    '    // maps the topics, and the shell needs the two plugins',
    '    // (`mpgd target init capacitor --providers notifications`).',
    `    ...(await createStarterCapacitorNotifications('${platform}', runtime.configTarget)),`,
    '  ];',
    '',
  ].join('\n'),
});

/** Edits to base template files, by path, for both templates unless noted. */
const commonEdits: Readonly<Record<string, readonly AnchoredEdit[]>> = {
  'src/platform/buildGateways/capacitorAndroid.ts': [gatewayImport, gatewayProviders('android')],
  'src/platform/buildGateways/capacitorIos.ts': [gatewayImport, gatewayProviders('ios')],
  'src/platform/buildGateways/reddit.ts': [
    {
      anchor: "import { createDevvitWebPaymentsClient } from '@mpgd/adapter-devvit/web';\n",
      replacement: [
        'import {',
        '  createDevvitWebLoginPrompt,',
        '  createDevvitWebPaymentsClient,',
        "} from '@mpgd/adapter-devvit/web';",
        '',
      ].join('\n'),
    },
    {
      anchor: "import type { RuntimeConfig } from '../runtimeDetector';\n",
      replacement: [
        "import { starterNotificationTopics } from '../notifications';",
        "import type { RuntimeConfig } from '../runtimeDetector';",
        '',
      ].join('\n'),
    },
    {
      anchor: '    ...(commerce === undefined ? {} : { commerce }),\n',
      replacement: [
        '    ...(commerce === undefined ? {} : { commerce }),',
        '    // Notifications v2: the game-rendered opt-in the server bridge serves',
        '    // (a gated beta: `integrations.notifications` stays approval-required',
        '    // until Reddit approves the app), and Reddit login for a logged-out',
        '    // player, who must log in before opting in.',
        '    ...notificationOptions(runtime),',
        '    loginPrompt: createDevvitWebLoginPrompt(),',
        '',
      ].join('\n'),
    },
    {
      anchor: 'function createCommerceOptions(): DevvitGatewayCommerceOptions | undefined {\n',
      replacement: [
        'function notificationOptions(',
        '  runtime: RuntimeConfig,',
        "): Pick<Parameters<typeof createDevvitPlatformGateway>[0], 'notifications'> {",
        '  const topics = starterNotificationTopics(runtime.configTarget).map((topic) => topic.id);',
        '  return topics.length === 0 ? {} : { notifications: { topics } };',
        '}',
        '',
        'function createCommerceOptions(): DevvitGatewayCommerceOptions | undefined {',
        '',
      ].join('\n'),
    },
  ],
  'apps/target-devvit/src/server/index.ts': [
    {
      anchor:
        "import { context, createServer, getServerPort, payments, reddit, redis } from '@devvit/web/server';\n",
      replacement: [
        'import {',
        '  context,',
        '  createServer,',
        '  getServerPort,',
        '  notifications,',
        '  payments,',
        '  reddit,',
        '  redis,',
        "} from '@devvit/web/server';",
        '',
      ].join('\n'),
    },
    {
      anchor: [
        'import {',
        '  createDevvitCommerceBridgeProducts,',
        '  createDevvitCommerceV2BridgeHandler,',
        "} from '@mpgd/adapter-devvit/server';",
        '',
      ].join('\n'),
      replacement: [
        'import {',
        '  createDevvitCommerceBridgeProducts,',
        '  createDevvitCommerceV2BridgeHandler,',
        '  createDevvitNotificationService,',
        '  createDevvitNotificationsV2BridgeHandler,',
        "} from '@mpgd/adapter-devvit/server';",
        '',
      ].join('\n'),
    },
    {
      anchor: "import type { ProductCatalog } from '@mpgd/catalog';\n",
      replacement: [
        "import { resolveNotificationTopicsForTarget, type NotificationTopicCatalog, type ProductCatalog } from '@mpgd/catalog';",
        "import { assertNotificationDeployment } from '@mpgd/platform/notifications';",
        '',
      ].join('\n'),
    },
    {
      anchor: "import devvitManifest from '../../devvit.json';\n",
      replacement: [
        "import notificationDeploymentJson from '../../../../notifications/deployment.json';",
        "import notificationTopicsJson from '../../../../notifications/topics.json';",
        "import devvitManifest from '../../devvit.json';",
        '',
      ].join('\n'),
    },
    {
      anchor: [
        'const handleBridgeRequest = createDevvitBridgeHandler({',
        '  redis,',
        '  currentPlayerId,',
        '  currentDisplayName,',
        '  storageKeyNamespace: gameName,',
        '  ...(commerce === undefined ? {} : { commerce }),',
        '});',
        '',
      ].join('\n'),
      replacement: [
        '/**',
        ' * Notifications v2 (`notifications/topics.json`, mapped for the `reddit`',
        ' * target): the game-rendered opt-in for the logged-in requester, and the',
        ' * service that records consent and sends server reminders over the Devvit',
        ' * notifications plugin. Devvit notifications are a gated beta: the game',
        ' * shows them only once `integrations.notifications` is `available`.',
        ' */',
        'const notificationTopicCatalog = notificationTopicsJson as NotificationTopicCatalog;',
        "const redditNotificationTopics = resolveNotificationTopicsForTarget(notificationTopicCatalog, 'reddit')",
        '  .map((topic) => topic.id);',
        'const notificationsBridge = redditNotificationTopics.length === 0',
        '  ? undefined',
        '  : createDevvitNotificationsV2BridgeHandler({',
        '      notifications,',
        '      currentUserId: currentPlayerId,',
        '      topics: redditNotificationTopics,',
        '    });',
        'const handleBridgeRequest = createDevvitBridgeHandler({',
        '  redis,',
        '  currentPlayerId,',
        '  currentDisplayName,',
        '  storageKeyNamespace: gameName,',
        '  ...(commerce === undefined ? {} : { commerce }),',
        '  ...(notificationsBridge === undefined ? {} : { notifications: notificationsBridge }),',
        '});',
        '',
      ].join('\n'),
    },
    {
      anchor: [
        '/**',
        ' * The notifications v2 service (`createDevvitNotificationService` from',
        ' * `@mpgd/adapter-devvit/server`). None until the game declares a topic',
        ' * catalog, so the scheduler tasks below do no work.',
        ' */',
        "const notificationService: Parameters<typeof handleNotificationTask>[0]['notifications'] = undefined;",
        '',
      ].join('\n'),
      replacement: [
        '/**',
        ' * The notifications v2 service over Redis and the Devvit plugin; the',
        ' * scheduler tasks below run its reminders and purges.',
        ' */',
        "const notificationService: Parameters<typeof handleNotificationTask>[0]['notifications'] =",
        '  redditNotificationTopics.length === 0',
        '    ? undefined',
        '    : createDevvitNotificationService({',
        '        redis,',
        '        notifications,',
        '        catalog: notificationTopicCatalog,',
        '        deployment: assertNotificationDeployment(notificationDeploymentJson),',
        '      }).service;',
        '',
      ].join('\n'),
    },
  ],
};

const phaserEdits: Readonly<Record<string, readonly AnchoredEdit[]>> = {
  'src/runtime/createGame.ts': [
    {
      anchor: "import { LobbyScene } from '../scenes/LobbyScene';\n",
      replacement: [
        "import { LobbyScene } from '../scenes/LobbyScene';",
        "import { NotificationSettingsScene } from '../scenes/NotificationSettingsScene';",
        '',
      ].join('\n'),
    },
    {
      anchor: '    scene: [BootScene, LobbyScene, PlayScene],\n',
      replacement: '    scene: [BootScene, LobbyScene, PlayScene, NotificationSettingsScene],\n',
    },
  ],
  'src/scenes/LobbyScene.ts': [
    {
      anchor: "    this.input.once('pointerdown', () => this.scene.start('PlayScene'));\n",
      replacement: [
        '    const notificationsButton = this.add',
        "      .text(930, 24, locale === 'ko' ? '알림 설정' : 'Notifications', {",
        "        color: '#5eead4',",
        "        fontFamily: 'Arial, sans-serif',",
        "        fontSize: '18px',",
        '      })',
        '      .setOrigin(1, 0)',
        '      .setInteractive({ useHandCursor: true });',
        "    notificationsButton.on('pointerup', () => this.scene.start('NotificationSettingsScene'));",
        '    // A tap anywhere else starts the game; the scene drops this listener on shutdown.',
        "    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {",
        '      if (!over.includes(notificationsButton)) {',
        "        this.scene.start('PlayScene');",
        '      }',
        '    });',
        '',
      ].join('\n'),
    },
  ],
};

const liteEdits: Readonly<Record<string, readonly AnchoredEdit[]>> = {
  'src/runtime/createGame.ts': [
    {
      anchor: "import { createTapGame } from '../lite/tapGame';\n",
      replacement: [
        "import { mountNotificationSettingsPanel } from '../lite/notificationSettingsPanel';",
        "import { createTapGame } from '../lite/tapGame';",
        '',
      ].join('\n'),
    },
    {
      anchor: "  const shell = createTapGame({ mount, title: '__GAME_TITLE__' });\n",
      replacement: [
        "  const shell = createTapGame({ mount, title: '__GAME_TITLE__' });",
        '  const disposeNotificationSettings = mountNotificationSettingsPanel(mount, input.context);',
        '',
      ].join('\n'),
    },
    {
      anchor: '    audio.dispose();\n',
      replacement: ['    audio.dispose();', '    disposeNotificationSettings();', ''].join('\n'),
    },
  ],
};

const readmeSection = [
  '',
  '## Notifications',
  '',
  'This game was created with `--providers notifications`. Its topics live in',
  '`notifications/topics.json` and the backend settings (`advertisingRules`,',
  'the advertising sender) in `notifications/deployment.json`; run',
  '`pnpm validate:notifications` after every change and before every release.',
  'Replace the sender contact placeholder in `notifications/deployment.json`',
  'before any advertising is sent. The notification settings screen asks for the',
  'OS or host permission and records reminder, advertising (광고성 정보',
  '수신동의), and night consent through the notifications runtime. See',
  '`docs/NOTIFICATIONS.md` and, for Android and iOS, the mpgd-kit Firebase setup',
  'guide; `mpgd target init capacitor --providers notifications` installs the two',
  'Capacitor plugins into a game-owned shell.',
  '',
].join('\n');

function applyEdits(path: string, content: string, edits: readonly AnchoredEdit[]): string {
  let next = content;
  for (const { anchor, replacement } of edits) {
    const first = next.indexOf(anchor);
    if (first === -1 || next.indexOf(anchor, first + anchor.length) !== -1) {
      throw new Error(
        `The notifications starter could not find exactly one anchor in ${path}; the template changed: ${
          JSON.stringify(anchor.split('\n')[0])}`,
      );
    }
    next = `${next.slice(0, first)}${replacement}${next.slice(first + anchor.length)}`;
  }
  return next;
}

function editPackageJson(content: string): string {
  const value = JSON.parse(content) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  value.scripts = {
    ...value.scripts,
    'validate:notifications': 'ttsx --project tsconfig.tools.json tools/validate-notifications.ts',
  };
  value.dependencies = Object.fromEntries(
    Object.entries({ ...value.dependencies, ...notificationsGameDependencies })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The Devvit server reads the deployment settings through `@mpgd/platform/notifications`. */
function editDevvitPackageJson(content: string): string {
  const value = JSON.parse(content) as { dependencies?: Record<string, string> };
  value.dependencies = Object.fromEntries(
    Object.entries({
      ...value.dependencies,
      '@mpgd/platform': '__MPGD_DEPENDENCY_VERSION_PLATFORM__',
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

function editTargets(content: string): string {
  const value = JSON.parse(content) as {
    targets: Record<string, { integrations?: Record<string, string> } | undefined>;
  };
  // Android, iOS, and Apps in Toss expose notifications once their provider
  // is ready; the provider still reports its own readiness (no plugin, no
  // mapped topic), which the target config follows. Reddit keeps the
  // default `approval-required` until Reddit approves the app, and exposes
  // the login prompt the opt-in needs.
  for (const name of ['android', 'ios', 'ait'] as const) {
    const target = value.targets[name];
    if (target !== undefined) {
      target.integrations = { ...target.integrations, notifications: 'available' };
    }
  }
  const reddit = value.targets.reddit;
  if (reddit !== undefined) {
    reddit.integrations = { ...reddit.integrations, identityUpgrade: 'available' };
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Applies the notifications starter to a generated game's template files:
 * adds the overlay's files (`common` and the template's own) and edits the
 * base files at their anchors. Throws when an anchor is missing, so a
 * template change cannot silently drop the wiring.
 */
export function applyNotificationsStarter<File extends NotificationsStarterFile>(
  baseFiles: readonly File[],
  overlay: {
    readonly template: NotificationsStarterTemplate;
    readonly common: readonly File[];
    readonly phaser: readonly File[];
    readonly lite: readonly File[];
  },
): readonly File[] {
  const edits: Record<string, readonly AnchoredEdit[]> = {
    ...commonEdits,
    ...(overlay.template === 'phaser' ? phaserEdits : liteEdits),
  };
  const pending = new Set(Object.keys(edits));
  const edited = baseFiles.map((file) => {
    const fileEdits = edits[file.relativePath];
    let content = file.content;
    if (fileEdits !== undefined) {
      pending.delete(file.relativePath);
      content = applyEdits(file.relativePath, content, fileEdits);
    } else if (file.relativePath === 'package.json') {
      content = editPackageJson(content);
    } else if (file.relativePath === 'apps/target-devvit/package.json') {
      content = editDevvitPackageJson(content);
    } else if (file.relativePath === 'mpgd.targets.json') {
      content = editTargets(content);
    } else if (file.relativePath === 'README.md') {
      content = `${content.trimEnd()}\n${readmeSection}`;
    }
    return content === file.content ? file : { ...file, content };
  });
  if (pending.size > 0) {
    throw new Error(
      `The notifications starter is missing template files: ${[...pending].sort().join(', ')}`,
    );
  }
  const added = [
    ...overlay.common,
    ...(overlay.template === 'phaser' ? overlay.phaser : overlay.lite),
  ];
  const existing = new Set(edited.map((file) => file.relativePath));
  for (const file of added) {
    if (existing.has(file.relativePath)) {
      throw new Error(`The notifications starter would overwrite ${file.relativePath}.`);
    }
  }
  return [...edited, ...added];
}

/** Reads `--providers` for `mpgd game create`: only `notifications` is a game-level provider today. */
export function readGameCreateProviders(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const ids = [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id.length > 0))];
  for (const id of ids) {
    if (id !== notificationsProviderId) {
      throw new Error(
        `Unsupported --providers ${id} for mpgd game create; expected: ${notificationsProviderId}. `
          + 'Store plugins (play-billing, storekit) are installed with "mpgd target init capacitor --providers ...".',
      );
    }
  }
  return ids;
}

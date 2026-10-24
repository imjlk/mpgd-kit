import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { satisfies } from 'semver';

import { validateNotificationTopicCatalog } from '@mpgd/catalog';
import {
  assertNotificationDeployment,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
} from '@mpgd/platform/notifications';

import {
  applyNotificationsStarter,
  notificationsGameDependencies,
  notificationsMessagingFirebaseRange,
  readGameCreateProviders,
  type NotificationsStarterFile,
} from '../src/notifications-starter.js';

/**
 * The templates live in the checkout, not next to the compiled test: the
 * prepared CI lane runs this entry from its emit root, so the directory is
 * resolved from the source root the runner names, the working directory (the
 * package scripts run from the repository root), or the source tree.
 */
function resolveTemplatesRoot(): string {
  const relative = path.join('packages', 'cli', 'templates', 'notifications-overlay');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(path.join(root, relative, 'common'))) {
      return path.join(root, 'packages', 'cli', 'templates');
    }
  }
  throw new Error(`Cannot locate ${relative} from ${candidates.join(', ')}.`);
}

const templatesRoot = resolveTemplatesRoot();

function collect(root: string, relative = ''): NotificationsStarterFile[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory()
      ? collect(root, next)
      : [{ relativePath: next, content: readFileSync(path.join(root, next), 'utf8') }];
  });
}

const base = collect(path.join(templatesRoot, 'phaser-game'));
const liteOverlay = collect(path.join(templatesRoot, 'lite-overlay'));
const overlay = {
  common: collect(path.join(templatesRoot, 'notifications-overlay/common')),
  phaser: collect(path.join(templatesRoot, 'notifications-overlay/phaser')),
  lite: collect(path.join(templatesRoot, 'notifications-overlay/lite')),
};
const liteBase = [
  ...base.map((file) => liteOverlay.find((candidate) => candidate.relativePath === file.relativePath) ?? file),
  ...liteOverlay.filter((file) => !base.some((candidate) => candidate.relativePath === file.relativePath)),
];
const byPath = (files: readonly NotificationsStarterFile[], relativePath: string): string => {
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  assert.ok(file, `${relativePath} is generated`);
  return file.content;
};

// `--providers` for game create takes only notifications, once, and refuses the rest.
assert.deepEqual(readGameCreateProviders(undefined), []);
assert.deepEqual(readGameCreateProviders(' notifications , notifications '), ['notifications']);
assert.throws(
  () => readGameCreateProviders('notifications,play-billing'),
  /Unsupported --providers play-billing/u,
);

// Phaser: every anchor is found, the overlay is added, nothing is overwritten.
const phaser = applyNotificationsStarter(base, { template: 'phaser', ...overlay });
for (const added of [
  'notifications/topics.json',
  'notifications/deployment.json',
  'src/platform/notifications.ts',
  'src/platform/capacitorNotifications.ts',
  'src/platform/notificationSettings.ts',
  'src/platform/notificationOpens.ts',
  'src/scenes/NotificationSettingsScene.ts',
  'tools/validate-notifications.ts',
]) {
  byPath(phaser, added);
}
assert.equal(
  phaser.some((file) => file.relativePath === 'src/lite/notificationSettingsPanel.ts'),
  false,
);
for (const platform of ['Android', 'Ios'] as const) {
  const gateway = byPath(phaser, `src/platform/buildGateways/capacitor${platform}.ts`);
  assert.match(
    gateway,
    /createStarterCapacitorNotifications\('(?:android|ios)', runtime\.configTarget\)/u,
  );
  assert.match(gateway, /\.\.\.createStoreProviders\(runtime, \(\) => gateway\),/u);
}
const reddit = byPath(phaser, 'src/platform/buildGateways/reddit.ts');
assert.match(reddit, /loginPrompt: createDevvitWebLoginPrompt\(\),/u);
assert.match(reddit, /\{ notifications: \{ topics \} \}/u);
const server = byPath(phaser, 'apps/target-devvit/src/server/index.ts');
assert.match(server, /notifications: notificationsBridge/u);
assert.match(server, /createDevvitNotificationService\(\{/u);
assert.doesNotMatch(server, /\['notifications'\] = undefined;/u);
assert.match(server, /function createNotificationService\(\)/u);
// The opt-in bridge is served only with the service that sends.
assert.match(server, /const notificationsBridge = notificationService === undefined/u);
assert.ok(
  server.indexOf('const notificationService:') < server.indexOf('const notificationsBridge'),
);
// The runtime's backend: served with the same service, for the request's context.
assert.match(
  server,
  /createDevvitNotificationsBackendBridgeHandler\(\{ service: notificationService, context: \(\) => context \}\)/u,
);
assert.match(server, /\{ notificationsBackend \}/u);
assert.ok(
  server.indexOf('const notificationService:') < server.indexOf('const notificationsBackend'),
);
// The Reddit gateway builder sets the hosted backend for its config target, created on first use.
assert.match(reddit, /setStarterHostedNotificationBackend\(runtime\.configTarget, \(\) =>/u);
assert.match(
  reddit,
  /createDevvitNotificationsBackend\(\{ appVersion: runtime\.appVersion, buildId: runtime\.buildId \}\)/u,
);
assert.ok(
  reddit.indexOf('if (topics.length === 0)') < reddit.indexOf('setStarterHostedNotificationBackend('),
);
assert.match(byPath(phaser, 'src/runtime/createGame.ts'), /NotificationSettingsScene\]/u);
assert.match(
  byPath(phaser, 'src/runtime/createGame.ts'),
  /routeNotificationSettingsOpens\(game, input\.context\);/u,
);
assert.match(
  byPath(phaser, 'src/scenes/LobbyScene.ts'),
  /context\.platform\.notificationsV2 === undefined/u,
);
assert.match(
  byPath(phaser, 'src/scenes/LobbyScene.ts'),
  /scene\.start\(notificationSettingsSceneKey\)/u,
);
const settingsScene = byPath(phaser, 'src/scenes/NotificationSettingsScene.ts');
assert.match(settingsScene, /const listTextWidth = 840;/u);
assert.match(settingsScene, /wordWrap: \{ width: listTextWidth \}/u);
assert.match(settingsScene, /setOrigin\(0\.5, 0\)/u);
assert.match(settingsScene, /placeListBelowOutcome\(\)/u);
const manifest = JSON.parse(byPath(phaser, 'package.json')) as {
  readonly scripts: Record<string, string>;
  readonly dependencies: Record<string, string>;
};
assert.equal(
  manifest.scripts['validate:notifications'],
  'ttsx --project tsconfig.tools.json tools/validate-notifications.ts',
);
for (const [name, version] of Object.entries(notificationsGameDependencies)) {
  assert.equal(manifest.dependencies[name], version);
}
assert.equal(manifest.dependencies['@capacitor/push-notifications'], undefined);
assert.deepEqual(Object.keys(manifest.dependencies), Object.keys(manifest.dependencies).sort());
const devvitManifest = JSON.parse(byPath(phaser, 'apps/target-devvit/package.json')) as {
  readonly dependencies: Record<string, string>;
};
assert.equal(devvitManifest.dependencies['@mpgd/platform'], '__MPGD_DEPENDENCY_VERSION_PLATFORM__');
const targets = JSON.parse(byPath(phaser, 'mpgd.targets.json')) as {
  readonly targets: Record<string, { readonly integrations?: Record<string, string> }>;
};
for (const target of ['android', 'ios', 'ait']) {
  assert.equal(targets.targets[target]?.integrations?.notifications, 'available');
}
// Devvit notifications stay behind Reddit's approval; the login prompt is exposed.
assert.equal(targets.targets.reddit?.integrations?.notifications, undefined);
assert.equal(targets.targets.reddit?.integrations?.identityUpgrade, 'available');
assert.match(byPath(phaser, 'README.md'), /## Notifications\n/u);

// Lite: the panel instead of the Phaser scene, mounted and disposed with the game.
const lite = applyNotificationsStarter(liteBase, { template: 'lite', ...overlay });
byPath(lite, 'src/lite/notificationSettingsPanel.ts');
assert.equal(
  lite.some((file) => file.relativePath === 'src/scenes/NotificationSettingsScene.ts'),
  false,
);
const liteGame = byPath(lite, 'src/runtime/createGame.ts');
assert.match(liteGame, /mountNotificationSettingsPanel\(mount, input\.context\)/u);
assert.match(liteGame, /disposeNotificationSettings\(\);/u);

// A template whose anchor moved fails loudly instead of generating a half-wired game.
assert.throws(
  () =>
    applyNotificationsStarter(
      base.map((file) =>
        file.relativePath === 'src/scenes/LobbyScene.ts'
          ? { ...file, content: 'export {};\n' }
          : file,
      ),
      { template: 'phaser', ...overlay },
    ),
  /could not find exactly one anchor in src\/scenes\/LobbyScene\.ts/u,
);
assert.throws(
  () =>
    applyNotificationsStarter(
      base.filter((file) => file.relativePath !== 'src/scenes/LobbyScene.ts'),
      {
        template: 'phaser',
        ...overlay,
      },
    ),
  /missing template files: src\/scenes\/LobbyScene\.ts/u,
);

// The starter catalog passes the notifications v2 rules under the Korean
// advertising rules: starter topic purposes (RFC open question 1), the
// notice topic, and every notices.copy variant with {{consentDate}}.
const catalog = JSON.parse(byPath(phaser, 'notifications/topics.json')) as unknown;
// `game create` fills the title; the contact stays the starter's placeholder.
const starterDeployment = JSON.parse(
  byPath(phaser, 'notifications/deployment.json').replaceAll('__GAME_TITLE__', 'Starter Game'),
) as {
  readonly advertisingSender: { readonly name: string; readonly contact: string };
};
// The shipped sender contact is a placeholder the backend refuses, so a
// Worker given the starter file as is does not start.
assert.throws(
  () => assertNotificationDeployment(starterDeployment),
  /placeholder in advertisingSender\.contact:/u,
);
const deployment = assertNotificationDeployment({
  ...starterDeployment,
  advertisingSender: { ...starterDeployment.advertisingSender, contact: '080-1234-5678' },
});
assert.equal(deployment.advertisingRules, 'kr');
const validation = validateNotificationTopicCatalog(catalog, {
  targetProviders: Object.fromEntries(
    Object.entries(referenceNotificationTargetProviders).map(([target, provider]) => [
      target,
      referenceNotificationProviders[provider],
    ]),
  ),
  deployment,
});
assert.ok(validation.valid, JSON.stringify(validation.issues));
const purposes = Object.fromEntries(
  validation.catalog.topics.map((topic) => [topic.id, topic.purpose]),
);
assert.deepEqual(purposes, {
  'daily-ready': 'requested',
  'streak-at-risk': 'requested',
  'friend-challenge': 'service',
  events: 'advertising',
  'consent-notice': 'service',
});
// Starter reminder copy states the player's own progress, never a benefit,
// in the catalog copy and in every target mapping's own text (Devvit).
for (const topic of validation.catalog.topics.filter((entry) => entry.purpose === 'requested')) {
  const texts = [
    ...Object.values(topic.copy ?? {}).map((text) => `${text.title} ${text.body}`),
    ...Object.values(topic.targets ?? {}).map((mapping) =>
      `${String(mapping.title ?? '')} ${String(mapping.body ?? '')}`),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /보상|혜택|이벤트|할인|무료|reward|bonus|free|sale|event/iu);
  }
}
// The starter's plugin versions are the ones the Capacitor adapter is tested with.
const adapterManifest = JSON.parse(
  readFileSync(path.join(templatesRoot, '../../../adapters/capacitor/package.json'), 'utf8'),
) as { readonly devDependencies: Record<string, string> };
for (const name of ['@capacitor-firebase/messaging', '@capacitor/local-notifications']) {
  assert.equal(notificationsGameDependencies[name], adapterManifest.devDependencies[name], name);
}
// The firebase range the shell starter checks a game's own copy against is
// the starter messaging plugin's published peer, and the starter's firebase is in it.
const messagingManifest = JSON.parse(
  readFileSync(
    path.join(
      templatesRoot,
      '../../../adapters/capacitor/node_modules/@capacitor-firebase/messaging/package.json',
    ),
    'utf8',
  ),
) as { readonly version: string; readonly peerDependencies: Record<string, string> };
assert.equal(
  messagingManifest.version,
  notificationsGameDependencies['@capacitor-firebase/messaging'],
);
assert.equal(messagingManifest.peerDependencies.firebase, notificationsMessagingFirebaseRange);
assert.ok(
  satisfies(notificationsGameDependencies.firebase ?? '', notificationsMessagingFirebaseRange),
);
// An overlay path that two parts carry fails loudly instead of one winning.
const duplicated = overlay.common[0];
assert.ok(duplicated);
assert.throws(
  () =>
    applyNotificationsStarter(base, {
      template: 'phaser',
      ...overlay,
      phaser: [...overlay.phaser, duplicated],
    }),
  /would overwrite/u,
);
// The opt-out route and the notice route are the route the game routes to its settings screen.
const settingsRoute = /export const starterNotificationSettingsRoute = '([^']+)';/u
  .exec(byPath(phaser, 'src/platform/notificationOpens.ts'))?.[1];
assert.equal(settingsRoute, '/?entry=notification-settings');
for (const topic of validation.catalog.topics) {
  if (topic.purpose === 'advertising') {
    assert.equal(topic.optOutRoute, settingsRoute, `${topic.id} opt-out route`);
  }
}
assert.equal(
  validation.catalog.topics.find((topic) => topic.id === 'consent-notice')?.route,
  settingsRoute,
);
// No advertising topic reaches Apps in Toss or Devvit, which cannot carry
// it, or Android, whose FCM pushes cannot carry the opt-out action yet.
const advertisingTopics = validation.catalog.topics.filter(
  (entry) => entry.purpose === 'advertising',
);
assert.ok(advertisingTopics.length > 0);
for (const topic of advertisingTopics) {
  assert.deepEqual(Object.keys(topic.targets ?? {}).sort(), ['ios'], topic.id);
}

console.info('Notifications starter checks passed.');

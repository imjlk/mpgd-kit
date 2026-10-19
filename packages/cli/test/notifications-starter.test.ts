import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateNotificationTopicCatalog } from '@mpgd/catalog';
import {
  assertNotificationDeployment,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
} from '@mpgd/platform/notifications';

import {
  applyNotificationsStarter,
  notificationsGameDependencies,
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
  const relative = path.join('packages', 'cli', 'templates', 'notifications');
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
  common: collect(path.join(templatesRoot, 'notifications/common')),
  phaser: collect(path.join(templatesRoot, 'notifications/phaser')),
  lite: collect(path.join(templatesRoot, 'notifications/lite')),
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
assert.doesNotMatch(server, /= undefined;\n/u);
assert.match(byPath(phaser, 'src/runtime/createGame.ts'), /NotificationSettingsScene\]/u);
assert.match(
  byPath(phaser, 'src/scenes/LobbyScene.ts'),
  /scene\.start\('NotificationSettingsScene'\)/u,
);
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
const deployment = assertNotificationDeployment(
  JSON.parse(byPath(phaser, 'notifications/deployment.json')),
);
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
// Starter reminder copy states the player's own progress, never a benefit.
for (const topic of validation.catalog.topics.filter((entry) => entry.purpose === 'requested')) {
  for (const text of Object.values(topic.copy ?? {})) {
    assert.doesNotMatch(
      `${text.title} ${text.body}`,
      /보상|혜택|이벤트|할인|무료|reward|bonus|free|sale/iu,
    );
  }
}
// No advertising topic reaches Apps in Toss or Devvit, which cannot carry it.
const events = validation.catalog.topics.find((topic) => topic.id === 'events');
assert.deepEqual(Object.keys(events?.targets ?? {}).sort(), ['android', 'ios']);

console.info('Notifications starter checks passed.');

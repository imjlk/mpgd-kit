import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  androidInexactAlarmPermission,
  androidManifestRemovesExactAlarm,
  applyAndroidManifestInexactAlarms,
  applyCapacitorShellStarter,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';
import {
  notificationsCapacitorSupportFiles,
  notificationsGameDependencies,
  wireCapacitorGatewayNotifications,
} from '../src/notifications-starter.js';

// `mpgd target init capacitor --providers notifications`: the adopt path for
// an existing game's Capacitor shell (notifications RFC, PR C1).

/**
 * The templates live in the checkout, not next to the compiled test: the
 * prepared CI lane runs this entry from its emit root.
 */
function resolveKitRoot(): string {
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0
      && existsSync(path.join(root, 'packages/cli/templates/notifications/common'))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

const kitRoot = resolveKitRoot();
const templateRoot = path.join(kitRoot, 'packages/cli/templates/phaser-game');
const androidGateway = 'src/platform/buildGateways/capacitorAndroid.ts';
const iosGateway = 'src/platform/buildGateways/capacitorIos.ts';
const readTemplate = (relative: string): string => readFileSync(
  path.join(templateRoot, relative),
  'utf8',
);
const adapterVersion = (JSON.parse(
  readFileSync(path.join(kitRoot, 'adapters/capacitor/package.json'), 'utf8'),
) as { readonly version: string }).version;

function createGame(gateways: { readonly android?: string; readonly ios?: string } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-notifications-'));
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const writeJson = (relative: string, value: unknown): void => {
    write(relative, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson('package.json', {
    name: '@game/notifications',
    private: true,
    scripts: { check: 'ttsc --noEmit' },
    dependencies: { '@capacitor/core': '8.5.2', '@capacitor/app': '8.1.1' },
  });
  writeJson('node_modules/@mpgd/adapter-capacitor/package.json', {
    name: '@mpgd/adapter-capacitor',
    version: adapterVersion,
    dependencies: { '@mpgd/capacitor-game-services': 'workspace:*' },
  });
  writeJson(
    'node_modules/@mpgd/adapter-capacitor/node_modules/@mpgd/capacitor-game-services/package.json',
    { name: '@mpgd/capacitor-game-services', version: '0.7.1' },
  );
  writeJson('mpgd.targets.json', {
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        gameApp: '.',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
      },
      ios: {
        kind: 'capacitor-ios',
        adapter: 'capacitor',
        gameApp: '.',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
      },
    },
  });
  write(androidGateway, gateways.android ?? readTemplate(androidGateway));
  write(iosGateway, gateways.ios ?? readTemplate(iosGateway));
  return root;
}

const input = (root: string, providerIds: readonly string[]) => ({
  gameRoot: root,
  appId: 'dev.example.notify',
  displayName: 'Notify "Game"',
  templateRoot,
  providerIds,
});
const readJson = (root: string, relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;

const roots: string[] = [];
try {
  // The template's gateways get the notifications wiring and the starter
  // modules; the shell and the game get the plugins at the starter versions.
  {
    const root = createGame();
    roots.push(root);
    const plan = planCapacitorShellStarter(input(root, ['notifications']));
    assert.deepEqual(plan.notificationPlugins, [
      {
        packageName: '@capacitor-firebase/messaging',
        version: notificationsGameDependencies['@capacitor-firebase/messaging'],
      },
      {
        packageName: '@capacitor/local-notifications',
        version: notificationsGameDependencies['@capacitor/local-notifications'],
      },
    ]);
    assert.deepEqual(plan.providerPlugins, []);
    for (const file of [
      androidGateway,
      iosGateway,
      ...notificationsCapacitorSupportFiles,
      'package.json',
    ]) {
      assert.ok(plan.changedFiles.includes(file), `the plan lists ${file}`);
    }
    assert.ok(plan.warnings.some((warning) => /google-services\.json/u.test(warning)));
    assert.ok(
      plan.warnings.some((warning) =>
        /GoogleService-Info\.plist, the Push Notifications/u.test(warning),
      ),
    );
    assert.ok(
      plan.warnings.some((warning) => /notification settings screen is not added/u.test(warning)),
    );

    applyCapacitorShellStarter(plan);
    for (const [gateway, platform] of [
      [androidGateway, 'android'],
      [iosGateway, 'ios'],
    ] as const) {
      const wired = readFileSync(path.join(root, gateway), 'utf8');
      assert.equal(wired, wireCapacitorGatewayNotifications(gateway, readTemplate(gateway)));
      assert.match(wired, new RegExp(`createStarterCapacitorNotifications\\('${platform}'`, 'u'));
    }
    // The game title reaches the catalog as valid JSON.
    const deployment = readJson(root, 'notifications/deployment.json') as {
      readonly advertisingSender: { readonly name: string };
    };
    assert.equal(deployment.advertisingSender.name, 'Notify "Game"');
    assert.match(
      readFileSync(path.join(root, 'notifications/topics.json'), 'utf8'),
      /\[Notify \\"Game\\"\]/u,
    );
    const game = readJson(root, 'package.json') as {
      readonly scripts: Record<string, string>;
      readonly dependencies: Record<string, string>;
    };
    assert.equal(game.scripts.check, 'ttsc --noEmit');
    assert.equal(
      game.scripts['validate:notifications'],
      'ttsx --project tsconfig.tools.json tools/validate-notifications.ts',
    );
    for (const [name, version] of Object.entries(notificationsGameDependencies)) {
      assert.equal(game.dependencies[name], version);
    }
    const shell = readJson(root, 'apps/mobile-capacitor/package.json') as {
      readonly dependencies: Record<string, string>;
    };
    assert.equal(shell.dependencies['@capacitor-firebase/messaging'], '8.5.2');
    assert.equal(shell.dependencies['@capacitor/local-notifications'], '8.3.1');
    assert.equal(shell.dependencies.firebase, undefined, 'the web SDK stays in the game');
    const manifest = readJson(root, 'apps/mobile-capacitor/mpgd.native-shell.json');
    assert.deepEqual(manifest.requestedProviderIds, ['notifications']);
    assert.deepEqual(manifest.providers, {
      notifications: {
        packages: {
          '@capacitor-firebase/messaging': '8.5.2',
          '@capacitor/local-notifications': '8.3.1',
        },
        platforms: ['android', 'ios'],
      },
    });
    assert.match(
      readFileSync(path.join(root, 'apps/mobile-capacitor/README.md'), 'utf8'),
      /never\n@capacitor\/push-notifications/u,
    );

    // A rerun once the game installed the plugins changes nothing it owns:
    // the wired gateways and the starter modules stay.
    for (const [name, version] of Object.entries(notificationsGameDependencies)) {
      const file = path.join(root, 'node_modules', name, 'package.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ name, version }));
    }
    const rerun = planCapacitorShellStarter({ ...input(root, ['notifications']) });
    assert.deepEqual(rerun.changedFiles, ['apps/mobile-capacitor/ios/App/App/Info-Smoke.plist']);
    assert.equal(
      rerun.warnings.some((warning) => /settings screen/u.test(warning)),
      false,
    );

    // An installed version other than the shell's pin is refused.
    writeFileSync(
      path.join(root, 'node_modules/@capacitor/local-notifications/package.json'),
      JSON.stringify({ name: '@capacitor/local-notifications', version: '8.4.0' }),
    );
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['notifications'])),
      /Existing shell @capacitor\/local-notifications is 8\.3\.1 but the game uses 8\.4\.0/u,
    );
  }

  // With the store plugins on an unwired legacy gateway, the gateway gets the
  // store wiring and the notifications wiring on top of it.
  {
    const unwired = (target: 'android' | 'ios'): string => [
      "import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';",
      "import type { PlatformGateway } from '@mpgd/platform';",
      '',
      "import type { RuntimeConfig } from '../runtimeDetector';",
      '',
      'export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {',
      '  return createCapacitorPlatformGateway({',
      `    target: '${target}',`,
      '    appVersion: runtime.appVersion,',
      '    buildId: runtime.buildId,',
      '  });',
      '}',
      '',
    ].join('\n');
    const root = createGame({ android: unwired('android'), ios: unwired('ios') });
    roots.push(root);
    const plan = planCapacitorShellStarter(
      input(root, ['play-billing', 'storekit', 'notifications']),
    );
    applyCapacitorShellStarter(plan);
    for (const gateway of [androidGateway, iosGateway]) {
      const wired = readFileSync(path.join(root, gateway), 'utf8');
      assert.equal(wired, wireCapacitorGatewayNotifications(gateway, readTemplate(gateway)));
    }
    assert.match(
      readFileSync(path.join(root, androidGateway), 'utf8'),
      /createCapacitorPlayBillingServiceProvider\(/u,
    );
  }

  // A game-owned gateway and game-owned modules are never rewritten; an
  // already wired gateway needs nothing.
  {
    const owned = `${readTemplate(androidGateway)}// game-owned change\n`;
    const alreadyWired = `${readTemplate(iosGateway)}// createCapacitorNotificationServiceProvider(\n`;
    const root = createGame({ android: owned, ios: alreadyWired });
    roots.push(root);
    const ownCatalog = '{ "version": "game", "defaultLocale": "en", "topics": [] }\n';
    mkdirSync(path.join(root, 'notifications'), { recursive: true });
    writeFileSync(path.join(root, 'notifications/topics.json'), ownCatalog);
    const plan = planCapacitorShellStarter(input(root, ['notifications']));
    assert.equal(plan.changedFiles.includes(androidGateway), false);
    assert.equal(plan.changedFiles.includes(iosGateway), false);
    assert.deepEqual(
      plan.changedFiles.filter(
        (file) => file.startsWith('src/') || file.startsWith('notifications/'),
      ),
      [],
      'no starter module is written without a gateway to wire',
    );
    assert.ok(
      plan.warnings.some((warning) =>
        /capacitorAndroid\.ts does not register notifications and is game-owned/u.test(warning),
      ),
    );
    assert.equal(
      plan.warnings.some((warning) => /capacitorIos\.ts/u.test(warning)),
      false,
    );
    // The plugins are installed all the same.
    assert.equal(plan.notificationPlugins.length, 2);
  }

  // @capacitor/push-notifications claims the same iOS push handler: refused.
  {
    const root = createGame();
    roots.push(root);
    const gamePackage = readJson(root, 'package.json');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...gamePackage,
        dependencies: {
          ...(gamePackage.dependencies as Record<string, string>),
          '@capacitor/push-notifications': '8.0.0',
        },
      }),
    );
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['notifications'])),
      /cannot run next to @capacitor\/push-notifications/u,
    );
  }

  // A declared but uninstalled plugin is refused before anything is written.
  {
    const root = createGame();
    roots.push(root);
    const gamePackage = readJson(root, 'package.json');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...gamePackage,
        dependencies: {
          ...(gamePackage.dependencies as Record<string, string>),
          '@capacitor/local-notifications': '8.3.1',
        },
      }),
    );
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['notifications'])),
      /declares @capacitor\/local-notifications but it is not installed/u,
    );
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

// The Android manifest drops SCHEDULE_EXACT_ALARM, which the local plugin adds.
{
  const plain = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <application android:label="Game" />',
    '    <uses-permission android:name="android.permission.INTERNET" />',
    '</manifest>',
    '',
  ].join('\n');
  const hardened = applyAndroidManifestInexactAlarms(plain);
  assert.match(
    hardened,
    /<manifest xmlns:tools="http:\/\/schemas\.android\.com\/tools" xmlns:android=/u,
  );
  assert.ok(hardened.includes(`    ${androidInexactAlarmPermission}\n</manifest>`));
  assert.ok(androidManifestRemovesExactAlarm(hardened));
  assert.equal(applyAndroidManifestInexactAlarms(hardened), hardened, 'idempotent');
  assert.equal(androidManifestRemovesExactAlarm(plain), false);
  // Attribute order does not matter.
  assert.ok(androidManifestRemovesExactAlarm(
    '<uses-permission tools:node="remove" android:name="android.permission.SCHEDULE_EXACT_ALARM"/>',
  ));
  // The kit's reference shell drops it already.
  assert.ok(
    androidManifestRemovesExactAlarm(
      readFileSync(
        path.join(kitRoot, 'apps/mobile-capacitor/android/app/src/main/AndroidManifest.xml'),
        'utf8',
      ),
    ),
  );
}

console.info('Capacitor shell notifications checks passed.');

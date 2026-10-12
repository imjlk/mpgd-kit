import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCapacitorShellStarter,
  capacitorShellProviderPlugins,
  capacitorShellProviderSupportFiles,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';

const kitRoot = fileURLToPath(new URL('../../..', import.meta.url));
const templateRoot = path.join(kitRoot, 'packages/cli/templates/phaser-game');
const readKitVersion = (packageDir: string): string =>
  (JSON.parse(readFileSync(path.join(kitRoot, packageDir, 'package.json'), 'utf8')) as {
    readonly version: string;
  }).version;
const playBillingVersion = readKitVersion('native-plugins/capacitor-play-billing');
const storeKitVersion = readKitVersion('native-plugins/capacitor-storekit');
const androidGateway = 'src/platform/buildGateways/capacitorAndroid.ts';
const iosGateway = 'src/platform/buildGateways/capacitorIos.ts';
const unwiredGateway = (target: 'android' | 'ios'): string => [
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

function createGame(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-providers-'));
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const writeJson = (relative: string, value: unknown): void => {
    write(relative, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson('package.json', {
    name: '@game/store',
    private: true,
    dependencies: { '@capacitor/core': '8.5.2', '@capacitor/app': '8.1.1' },
  });
  writeJson('node_modules/@mpgd/adapter-capacitor/package.json', {
    name: '@mpgd/adapter-capacitor',
    version: readKitVersion('adapters/capacitor'),
    dependencies: { '@mpgd/capacitor-game-services': 'workspace:*' },
  });
  writeJson(
    'node_modules/@mpgd/adapter-capacitor/node_modules/@mpgd/capacitor-game-services/package.json',
    { name: '@mpgd/capacitor-game-services', version: '0.5.4' },
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
  write(androidGateway, unwiredGateway('android'));
  write(iosGateway, unwiredGateway('ios').replaceAll('\n', '\r\n'));
  return root;
}

const readGameJson = (root: string, relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
const readTemplate = (relative: string): string =>
  readFileSync(path.join(templateRoot, relative), 'utf8');
const baseInput = (root: string) => ({
  gameRoot: root,
  appId: 'dev.example.store',
  displayName: 'Store Game',
  templateRoot,
});

assert.deepEqual(
  capacitorShellProviderPlugins.map((plugin) => [plugin.id, plugin.platform, plugin.gatewayFile]),
  [
    ['play-billing', 'android', androidGateway],
    ['storekit', 'ios', iosGateway],
  ],
);
for (const plugin of capacitorShellProviderPlugins) {
  const template = readTemplate(plugin.gatewayFile);
  assert.ok(template.includes(plugin.packageName), `${plugin.gatewayFile} imports the plugin`);
  assert.ok(template.includes(plugin.gatewayFactory), `${plugin.gatewayFile} registers it`);
  assert.equal(
    readFileSync(path.join(kitRoot, 'examples/phaser-starter', plugin.gatewayFile), 'utf8'),
    template,
    `${plugin.gatewayFile} stays in parity with the private starter`,
  );
}
for (const file of capacitorShellProviderSupportFiles) {
  assert.ok(
    capacitorShellProviderPlugins.some((plugin) =>
      readTemplate(plugin.gatewayFile).includes(`'../${path.basename(file, '.ts')}'`),
    ),
    `${file} is imported by a wired gateway`,
  );
}

const roots: string[] = [];
try {
  // A store plugin needs its native target.
  {
    const root = createGame();
    roots.push(root);
    const targets = readGameJson(root, 'mpgd.targets.json');
    delete (targets.targets as Record<string, unknown>).android;
    writeFileSync(path.join(root, 'mpgd.targets.json'), `${JSON.stringify(targets, null, 2)}\n`);
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['play-billing'] }),
      /--providers play-billing installs the android store plugin.*no android target/u,
    );
    // Metadata-only ids keep the general target requirement.
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['identity'] }),
      /canonical android target/u,
    );
  }

  // Not yet installed: the kit's version is pinned in the shell and the game,
  // and the unwired template gateways are replaced by the wired ones.
  {
    const root = createGame();
    roots.push(root);
    const plan = planCapacitorShellStarter({
      ...baseInput(root),
      providerIds: ['storekit', 'identity', 'play-billing'],
    });
    assert.deepEqual(
      plan.providerPlugins.map((plugin) => [plugin.id, plugin.version, plugin.versionSource]),
      [
        ['play-billing', playBillingVersion, 'kit'],
        ['storekit', storeKitVersion, 'kit'],
      ],
    );
    assert.deepEqual(plan.warnings, []);
    for (const file of [
      'package.json',
      'apps/mobile-capacitor/package.json',
      'apps/mobile-capacitor/mpgd.native-shell.json',
      androidGateway,
      iosGateway,
      ...capacitorShellProviderSupportFiles,
    ]) {
      assert.ok(plan.changedFiles.includes(file), `the dry run lists ${file}`);
    }
    assert.equal(
      existsSync(path.join(root, 'apps/mobile-capacitor')),
      false,
      'a plan writes nothing',
    );
    assert.equal(readFileSync(path.join(root, androidGateway), 'utf8'), unwiredGateway('android'));

    applyCapacitorShellStarter(plan);
    const gameDependencies = readGameJson(
      root,
      'package.json',
    ).dependencies as Record<string, string>;
    assert.equal(gameDependencies['@mpgd/capacitor-play-billing'], playBillingVersion);
    assert.equal(gameDependencies['@mpgd/capacitor-storekit'], storeKitVersion);
    const shellDependencies = readGameJson(root, 'apps/mobile-capacitor/package.json')
      .dependencies as Record<string, string>;
    assert.equal(shellDependencies['@mpgd/capacitor-play-billing'], playBillingVersion);
    assert.equal(shellDependencies['@mpgd/capacitor-storekit'], storeKitVersion);
    assert.equal(shellDependencies['@mpgd/capacitor-game-services'], '0.5.4');
    const manifest = readGameJson(root, 'apps/mobile-capacitor/mpgd.native-shell.json');
    assert.deepEqual(manifest.requestedProviderIds, ['identity', 'play-billing', 'storekit']);
    assert.deepEqual(manifest.providers, {
      'play-billing': {
        package: '@mpgd/capacitor-play-billing',
        version: playBillingVersion,
        platform: 'android',
      },
      storekit: {
        package: '@mpgd/capacitor-storekit',
        version: storeKitVersion,
        platform: 'ios',
      },
    });
    for (const file of [androidGateway, iosGateway, ...capacitorShellProviderSupportFiles]) {
      assert.equal(
        readFileSync(path.join(root, file), 'utf8'),
        readTemplate(file),
        `${file} is wired`,
      );
    }
    assert.match(
      readFileSync(path.join(root, 'apps/mobile-capacitor/README.md'), 'utf8'),
      /play-billing and\nstorekit: those install the kit store plugin/u,
    );

    // A rerun without --providers keeps the recorded selection and changes
    // nothing once the game installed the pinned versions.
    for (const [packageName, version] of [
      ['@mpgd/capacitor-play-billing', playBillingVersion],
      ['@mpgd/capacitor-storekit', storeKitVersion],
    ] as const) {
      const file = path.join(root, 'node_modules', packageName, 'package.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ name: packageName, version }));
    }
    const rerun = planCapacitorShellStarter({
      gameRoot: root,
      appId: 'dev.example.store',
      displayName: 'Store Game',
      templateRoot,
    });
    assert.deepEqual(rerun.changedFiles, ['apps/mobile-capacitor/ios/App/App/Info-Smoke.plist']);
    assert.deepEqual(
      rerun.providerPlugins.map((plugin) => plugin.versionSource),
      ['installed', 'installed'],
    );

    // Dropping a store provider never uninstalls it, and says so.
    const narrowed = planCapacitorShellStarter({ ...baseInput(root), providerIds: ['storekit'] });
    assert.deepEqual(
      narrowed.providerPlugins.map((plugin) => plugin.id),
      ['storekit'],
    );
    assert.equal(narrowed.warnings.length, 1);
    assert.match(narrowed.warnings[0] ?? '', /still lists @mpgd\/capacitor-play-billing/u);

    // The game's installed plugin must match the shell's pin.
    writeFileSync(
      path.join(root, 'node_modules/@mpgd/capacitor-storekit/package.json'),
      JSON.stringify({ name: '@mpgd/capacitor-storekit', version: '9.9.9' }),
    );
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['storekit'] }),
      /Existing shell @mpgd\/capacitor-storekit is .* but the game uses 9\.9\.9/u,
    );
  }

  // A game-owned gateway is never rewritten; the plan warns instead.
  {
    const root = createGame();
    roots.push(root);
    const customGateway = `${unwiredGateway('android')}// game-owned change\n`;
    writeFileSync(path.join(root, androidGateway), customGateway);
    unlinkSync(path.join(root, iosGateway));
    const plan = planCapacitorShellStarter({
      ...baseInput(root),
      providerIds: ['play-billing', 'storekit'],
    });
    assert.equal(plan.changedFiles.includes(androidGateway), false);
    assert.equal(plan.changedFiles.includes(iosGateway), false);
    assert.deepEqual(
      plan.changedFiles.filter((file) => file.startsWith('src/')),
      [],
      'no support module is written without a gateway to wire',
    );
    assert.equal(plan.warnings.length, 2);
    assert.match(
      plan.warnings[0] ?? '',
      /capacitorAndroid\.ts does not import @mpgd\/capacitor-play-billing; register createCapacitorPlayBillingServiceProvider/u,
    );
    assert.match(
      plan.warnings[1] ?? '',
      /capacitorIos\.ts is missing; register createCapacitorStoreKitServiceProvider/u,
    );
  }

  // A differing game-owned support module keeps the legacy gateway.
  {
    const root = createGame();
    roots.push(root);
    const ownProducts = '// game-owned products\n';
    mkdirSync(path.join(root, 'src/platform'), { recursive: true });
    writeFileSync(path.join(root, 'src/platform/commerceProducts.ts'), ownProducts);
    const plan = planCapacitorShellStarter({ ...baseInput(root), providerIds: ['play-billing'] });
    assert.equal(plan.changedFiles.includes(androidGateway), false);
    assert.equal(plan.changedFiles.includes('src/platform/commerceAccountBinding.ts'), false);
    assert.match(plan.warnings[0] ?? '', /game-owned src\/platform\/commerceProducts\.ts differs/u);
    // Without the template the plan can only check the gateway.
    const unguided = planCapacitorShellStarter({
      gameRoot: root,
      appId: 'dev.example.store',
      displayName: 'Store Game',
      providerIds: ['play-billing'],
    });
    assert.equal(unguided.changedFiles.includes(androidGateway), false);
    assert.match(unguided.warnings[0] ?? '', /does not import @mpgd\/capacitor-play-billing/u);
  }

  // Declared but not installed, or installed against older kit packages.
  {
    const root = createGame();
    roots.push(root);
    const gamePackage = readGameJson(root, 'package.json');
    (gamePackage.dependencies as Record<string, string>)['@mpgd/capacitor-play-billing'] = '0.2.1';
    writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(gamePackage, null, 2)}\n`);
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['play-billing'] }),
      /declares @mpgd\/capacitor-play-billing but it is not installed/u,
    );
    const pluginFile = path.join(root, 'node_modules/@mpgd/capacitor-play-billing/package.json');
    mkdirSync(path.dirname(pluginFile), { recursive: true });
    writeFileSync(
      pluginFile,
      JSON.stringify({
        name: '@mpgd/capacitor-play-billing',
        version: '0.2.1',
        peerDependencies: { '@mpgd/adapter-capacitor': '^99.0.0' },
      }),
    );
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['play-billing'] }),
      /needs @mpgd\/adapter-capacitor \^99\.0\.0, but the game has .*mpgd kit upgrade/u,
    );
    writeFileSync(
      pluginFile,
      JSON.stringify({
        name: '@mpgd/capacitor-play-billing',
        version: 'latest',
      }),
    );
    assert.throws(
      () => planCapacitorShellStarter({ ...baseInput(root), providerIds: ['play-billing'] }),
      /must resolve to a concrete version/u,
    );
  }

  console.info('Capacitor shell store provider installation and gateway wiring passed.');
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

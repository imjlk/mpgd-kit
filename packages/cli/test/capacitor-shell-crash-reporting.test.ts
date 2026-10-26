import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCapacitorShellStarter,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';
import {
  androidAppGradleHasCrashlytics,
  androidRootGradleHasCrashlytics,
  androidShellHasCrashlytics,
  applyAndroidAppGradleCrashlytics,
  applyAndroidRootGradleCrashlytics,
  crashlyticsGradlePluginVersion,
  crashReportingPlugin,
  crashReportingPluginVersion,
  iosProjectUploadsCrashlyticsSymbols,
  materializeAndroidCrashlytics,
} from '../src/crash-reporting-starter.js';

// `mpgd target init capacitor --providers crash-reporting` (mobile launch L5a).

/**
 * The reference shell lives in the checkout, not next to the compiled test:
 * the prepared CI lane runs this entry from its emit root.
 */
function resolveKitRoot(): string {
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0
      && existsSync(path.join(root, 'apps/mobile-capacitor/android/app/build.gradle'))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

const kitRoot = resolveKitRoot();
const referenceAndroid = path.join(kitRoot, 'apps/mobile-capacitor/android');
const referenceRootGradle = readFileSync(path.join(referenceAndroid, 'build.gradle'), 'utf8');
const referenceAppGradle = readFileSync(path.join(referenceAndroid, 'app/build.gradle'), 'utf8');
const kitAdapter = JSON.parse(
  readFileSync(path.join(kitRoot, 'adapters/capacitor/package.json'), 'utf8'),
) as {
  readonly version: string;
  readonly exports: Record<string, unknown>;
  readonly peerDependencies: Record<string, string>;
};
const classpath = `classpath 'com.google.firebase:firebase-crashlytics-gradle:${crashlyticsGradlePluginVersion}'`;

// The adapter accepts the plugin version the CLI installs.
assert.ok(kitAdapter.exports['./crash-reporting'] !== undefined);
assert.equal(kitAdapter.peerDependencies[crashReportingPlugin], `^${crashReportingPluginVersion}`);

// Gradle wiring on the Capacitor template files the reference shell keeps.
{
  assert.equal(androidRootGradleHasCrashlytics(referenceRootGradle), false);
  assert.equal(androidAppGradleHasCrashlytics(referenceAppGradle), false);
  const root = applyAndroidRootGradleCrashlytics(referenceRootGradle);
  assert.ok(root !== undefined);
  assert.match(
    root,
    new RegExp(
      `classpath 'com\\.google\\.gms:google-services:[^']+'\\n        ${classpath.replaceAll('.', '\\.')}\\n`,
      'u',
    ),
  );
  assert.equal(applyAndroidRootGradleCrashlytics(root), root, 'the root patch is idempotent');
  const app = applyAndroidAppGradleCrashlytics(referenceAppGradle);
  assert.ok(app !== undefined);
  // Inside the google-services.json check, right after the Google services plugin.
  assert.match(
    app,
    /if \(servicesJSON\.text\) \{\n {8}apply plugin: 'com\.google\.gms\.google-services'\n {8}apply plugin: 'com\.google\.firebase\.crashlytics'\n {4}\}/u,
  );
  assert.equal(applyAndroidAppGradleCrashlytics(app), app, 'the app patch is idempotent');
  assert.equal(androidRootGradleHasCrashlytics(root), true);
  assert.equal(androidAppGradleHasCrashlytics(app), true);

  // CRLF files keep their line endings.
  const crlf = applyAndroidRootGradleCrashlytics(referenceRootGradle.replaceAll('\n', '\r\n'));
  assert.ok(crlf?.includes(`'\r\n        ${classpath}\r\n`));
  // A commented-out plugin does not count.
  assert.equal(
    androidAppGradleHasCrashlytics("// apply plugin: 'com.google.firebase.crashlytics'"),
    false,
  );
  // The plugins DSL counts as applied.
  assert.equal(
    androidRootGradleHasCrashlytics(
      "plugins { id 'com.google.firebase.crashlytics' version '3.0.8' apply false }",
    ),
    true,
  );
  // Layouts the template does not produce are left to the game.
  assert.equal(applyAndroidRootGradleCrashlytics('buildscript { dependencies { } }'), undefined);
  assert.equal(
    applyAndroidAppGradleCrashlytics("apply plugin: 'com.android.application'"),
    undefined,
  );
}

assert.equal(
  iosProjectUploadsCrashlyticsSymbols(
    'shellScript = "\\"${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run\\"\\n";',
  ),
  true,
);
assert.equal(iosProjectUploadsCrashlyticsSymbols('shellScript = "echo";'), false);

function createGame(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-crash-reporting-'));
  const writeJson = (relative: string, value: unknown): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson('package.json', {
    name: '@game/crash',
    private: true,
    dependencies: { '@capacitor/core': '8.5.2', '@capacitor/app': '8.1.1' },
  });
  writeJson('node_modules/@mpgd/adapter-capacitor/package.json', {
    name: '@mpgd/adapter-capacitor',
    version: kitAdapter.version,
    exports: kitAdapter.exports,
    peerDependencies: kitAdapter.peerDependencies,
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
  return root;
}

const input = (root: string, providerIds?: readonly string[]) => ({
  gameRoot: root,
  appId: 'dev.example.crash',
  displayName: 'Crash Game',
  ...(providerIds === undefined ? {} : { providerIds }),
});
const readJson = (root: string, relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;

const roots: string[] = [];
try {
  // A fresh shell gets the plugin and a manifest entry; the game does not change.
  {
    const root = createGame();
    roots.push(root);
    const gameBefore = readFileSync(path.join(root, 'package.json'), 'utf8');
    const plan = planCapacitorShellStarter(input(root, ['crash-reporting']));
    assert.deepEqual(plan.crashReportingPlugins, [
      { packageName: crashReportingPlugin, version: crashReportingPluginVersion },
    ]);
    assert.deepEqual(plan.notificationPlugins, []);
    assert.deepEqual(plan.providerPlugins, []);
    assert.equal(
      plan.changedFiles.includes('package.json'),
      false,
      'the game package is unchanged',
    );
    assert.ok(
      plan.warnings.some((warning) => /dSYMs/u.test(warning)),
      'the iOS steps are printed',
    );
    applyCapacitorShellStarter(plan);
    assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), gameBefore);
    const shell = readJson(root, 'apps/mobile-capacitor/package.json') as {
      readonly dependencies: Record<string, string>;
    };
    assert.equal(shell.dependencies[crashReportingPlugin], crashReportingPluginVersion);
    const manifest = readJson(root, 'apps/mobile-capacitor/mpgd.native-shell.json') as {
      readonly requestedProviderIds: readonly string[];
      readonly providers: Record<string, unknown>;
    };
    assert.deepEqual(manifest.requestedProviderIds, ['crash-reporting']);
    assert.deepEqual(manifest.providers['crash-reporting'], {
      packages: { [crashReportingPlugin]: crashReportingPluginVersion },
      platforms: ['android', 'ios'],
      crashlyticsGradlePlugin: crashlyticsGradlePluginVersion,
    });

    // A rerun reads the selection from the manifest and keeps the shell's version.
    const rerun = planCapacitorShellStarter(input(root));
    assert.deepEqual(rerun.crashReportingPlugins, plan.crashReportingPlugins);
    assert.equal(
      rerun.changedFiles.some((file) => file.startsWith('apps/mobile-capacitor/package.json')),
      false,
    );

    // An existing Android project without the Crashlytics Gradle plugin is
    // refused before anything is installed, with the manual steps.
    const android = path.join(root, 'apps/mobile-capacitor/android');
    mkdirSync(path.join(android, 'app'), { recursive: true });
    writeFileSync(path.join(android, 'build.gradle'), referenceRootGradle);
    writeFileSync(path.join(android, 'app/build.gradle'), referenceAppGradle);
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['crash-reporting'])),
      (error: unknown) => error instanceof Error
        && /stops the app at startup/u.test(error.message)
        && error.message.includes(classpath)
        && error.message.includes("apply plugin: 'com.google.firebase.crashlytics'"),
    );
    assert.equal(androidShellHasCrashlytics(path.join(root, 'apps/mobile-capacitor')), false);
    materializeAndroidCrashlytics(path.join(root, 'apps/mobile-capacitor'));
    assert.equal(androidShellHasCrashlytics(path.join(root, 'apps/mobile-capacitor')), true);
    const patchedApp = readFileSync(path.join(android, 'app/build.gradle'), 'utf8');
    materializeAndroidCrashlytics(path.join(root, 'apps/mobile-capacitor'));
    assert.equal(
      readFileSync(path.join(android, 'app/build.gradle'), 'utf8'),
      patchedApp,
      'materializing twice changes nothing',
    );
    rmSync(android, { recursive: true });

    // Dropping the provider warns about the plugin the shell still lists.
    const dropped = planCapacitorShellStarter(input(root, []));
    assert.deepEqual(dropped.crashReportingPlugins, []);
    assert.ok(
      dropped.warnings.some((warning) => warning.includes(`still lists ${crashReportingPlugin}`)),
    );
  }

  // A layout the template does not produce is refused with the manual steps.
  {
    const shell = mkdtempSync(path.join(tmpdir(), 'mpgd-crash-gradle-'));
    roots.push(shell);
    mkdirSync(path.join(shell, 'android/app'), { recursive: true });
    writeFileSync(path.join(shell, 'android/build.gradle'), 'plugins { }\n');
    writeFileSync(path.join(shell, 'android/app/build.gradle'), referenceAppGradle);
    assert.throws(() => materializeAndroidCrashlytics(shell), /unexpected Gradle layout/u);
    assert.equal(
      readFileSync(path.join(shell, 'android/app/build.gradle'), 'utf8'),
      referenceAppGradle,
      'neither file is written when one cannot be patched',
    );
  }

  // An adapter without the crash reporter, or a shell pinned outside the
  // adapter's range, is refused.
  {
    const root = createGame();
    roots.push(root);
    const adapterFile = path.join(root, 'node_modules/@mpgd/adapter-capacitor/package.json');
    const adapter = readJson(root, 'node_modules/@mpgd/adapter-capacitor/package.json');
    const { './crash-reporting': _crash, ...olderExports } = kitAdapter.exports;
    writeFileSync(adapterFile, JSON.stringify({ ...adapter, exports: olderExports }));
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['crash-reporting'])),
      /upgrade the game's kit packages/u,
    );
    writeFileSync(adapterFile, JSON.stringify(adapter));
    const shellPackage = path.join(root, 'apps/mobile-capacitor/package.json');
    mkdirSync(path.dirname(shellPackage), { recursive: true });
    writeFileSync(
      shellPackage,
      JSON.stringify({
        name: '@game/crash-native-shell',
        private: true,
        dependencies: {
          '@capacitor/android': '8.5.2',
          '@capacitor/app': '8.1.1',
          '@capacitor/core': '8.5.2',
          '@capacitor/ios': '8.5.2',
          '@mpgd/capacitor-game-services': '0.7.1',
          [crashReportingPlugin]: '7.0.0',
        },
      }),
    );
    assert.throws(
      () => planCapacitorShellStarter(input(root, ['crash-reporting'])),
      /needs @capacitor-firebase\/crashlytics \^8\.5\.2, but the shell would get 7\.0\.0/u,
    );
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.info('capacitor shell crash-reporting provider passed');

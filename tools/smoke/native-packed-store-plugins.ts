// Packs @mpgd/capacitor-storekit and @mpgd/capacitor-play-billing the way npm
// publishes them and checks what a consumer shell receives: the Swift package
// and Gradle module, Capacitor registration names, types and exports, and the
// pinned OpenIAP native cores. With `ios` it compiles the packed Swift package
// for the iOS simulator (resolving OpenIAP Apple through SwiftPM); with
// `android` it assembles the packed Android module inside the reference
// Capacitor shell (resolving OpenIAP Google from Maven Central). Neither build
// stands in for a StoreKit or Play sandbox purchase.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const modes = new Set(process.argv.slice(2));
for (const mode of modes) {
  assert.ok(['ios', 'android'].includes(mode), `Unknown mode ${mode}; use ios and/or android.`);
}
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-packed-store-'));
const openIapApple = '.package(url: "https://github.com/hyodotdev/openiap.git", exact: "4.0.7")';
const openIapGoogle = "implementation 'io.github.hyochan.openiap:openiap-google:4.0.8'";

function run(command: string, args: readonly string[], cwd: string, timeout = 180_000): string {
  const result = spawnSync(command, [...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed in ${cwd}`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout ?? '';
}

interface PackedPlugin {
  readonly entries: ReadonlySet<string>;
  readonly read: (path: string) => string;
  readonly root: string;
}

function pack(name: string): PackedPlugin {
  const directory = join(repoRoot, 'native-plugins', name);
  assert.ok(existsSync(join(directory, 'dist/index.js')), `${name} is not built`);
  const destination = join(fixtureRoot, name);
  mkdirSync(destination, { recursive: true });
  run(
    'pnpm',
    ['--dir', directory, 'pack', '--silent', '--pack-destination', destination],
    repoRoot,
  );
  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `${name} must produce exactly one tarball`);
  const tarball = join(destination, tarballs[0] ?? '');
  run('tar', ['-xzf', tarball, '-C', destination], repoRoot);
  const entries = new Set(run('tar', ['-tzf', tarball], repoRoot).trim().split('\n'));
  const read = (path: string): string => run('tar', ['-xOf', tarball, `package/${path}`], repoRoot);
  return { entries, read, root: join(destination, 'package') };
}

function requireEntries(entries: ReadonlySet<string>, paths: readonly string[], label: string): void {
  for (const path of paths) {
    assert.ok(entries.has(`package/${path}`), `${label} is missing ${path}`);
  }
}

function forbidEntries(entries: ReadonlySet<string>, pattern: RegExp, label: string): void {
  const found = [...entries].filter((entry) => pattern.test(entry));
  assert.deepEqual(found, [], `${label} must not ship ${pattern}`);
}

function checkManifest(read: PackedPlugin['read'], name: string, platform: 'ios' | 'android'): void {
  const manifest = JSON.parse(read('package.json')) as {
    readonly name?: string;
    readonly exports?: { readonly '.'?: { readonly types?: string; readonly default?: string } };
    readonly capacitor?: Readonly<Record<string, { readonly src?: string } | undefined>>;
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  assert.equal(manifest.name, `@mpgd/${name}`);
  assert.equal(manifest.exports?.['.']?.types, './dist/index.d.ts');
  assert.equal(manifest.exports?.['.']?.default, './dist/index.js');
  assert.equal(manifest.capacitor?.[platform]?.src, platform);
  assert.equal(
    manifest.dependencies?.['@capacitor/core'],
    undefined,
    `${name}: the host supplies Capacitor`,
  );
}

try {
  // iOS: Swift package, plugin registration, OpenIAP Apple pin.
  const storeKit = pack('capacitor-storekit');
  requireEntries(
    storeKit.entries,
    [
      'package.json',
      'Package.swift',
      'dist/index.js',
      'dist/index.d.ts',
      'ios/Sources/CapacitorStoreKit/CapacitorStoreKitPlugin.swift',
      'ios/Sources/MpgdStoreKitBridge/OpenIapAppleConnection.swift',
      'ios/Sources/MpgdStoreKitBridge/RevocationUpdatesShim.swift',
      'ios/Sources/MpgdStoreKitBridge/StoreKitTransactionPolicy.swift',
    ],
    '@mpgd/capacitor-storekit',
  );
  forbidEntries(storeKit.entries, /^package\/ios\/Tests\//u, '@mpgd/capacitor-storekit');
  checkManifest(storeKit.read, 'capacitor-storekit', 'ios');
  const packageSwift = storeKit.read('Package.swift');
  assert.ok(
    packageSwift.includes(openIapApple),
    'The packed Swift package must pin OpenIAP Apple 4.0.7',
  );
  assert.match(
    packageSwift,
    /\.library\(name: "MpgdCapacitorStoreKit", targets: \["MpgdCapacitorStoreKit"\]\)/u,
  );
  // The product `cap sync ios` links for `@mpgd/capacitor-storekit` (Capacitor's fixName).
  assert.match(
    packageSwift,
    /\.library\(name: "MpgdCapacitorStorekit", targets: \["MpgdCapacitorStoreKit"\]\)/u,
  );
  const swift = storeKit.read('ios/Sources/CapacitorStoreKit/CapacitorStoreKitPlugin.swift');
  assert.match(swift, /@objc\(CapacitorStoreKitPlugin\)/u);
  assert.match(swift, /public let jsName = "CapacitorStoreKit"/u);
  for (const method of [
    'getProducts',
    'purchase',
    'getTransactions',
    'sync',
    'finishTransaction',
    'getFinishSupport',
  ]) {
    assert.match(
      swift,
      new RegExp(`CAPPluginMethod\\(name: "${method}"`, 'u'),
      `StoreKit registers ${method}`,
    );
  }
  assert.match(storeKit.read('dist/index.js'), /export \* from '\.\/plugin\.js'/u);
  assert.match(storeKit.read('dist/plugin.js'), /registerPlugin\(['"]CapacitorStoreKit['"]\)/u);
  assert.match(storeKit.read('dist/index.d.ts'), /createCapacitorStoreKitStoreSdk|store-sdk/u);

  // Android: Gradle module, plugin registration, OpenIAP Google pin.
  const playBilling = pack('capacitor-play-billing');
  const kotlinRoot = 'android/src/main/java/dev/mpgd/capacitor/playbilling';
  requireEntries(
    playBilling.entries,
    [
      'package.json',
      'dist/index.js',
      'dist/index.d.ts',
      'android/build.gradle',
      'android/src/main/AndroidManifest.xml',
      `${kotlinRoot}/CapacitorPlayBillingPlugin.kt`,
      `${kotlinRoot}/OpenIapPlayConnection.kt`,
      `${kotlinRoot}/PlayBillingPolicy.kt`,
    ],
    '@mpgd/capacitor-play-billing',
  );
  forbidEntries(
    playBilling.entries,
    /^package\/android\/src\/test\/|\.java$/u,
    '@mpgd/capacitor-play-billing',
  );
  checkManifest(playBilling.read, 'capacitor-play-billing', 'android');
  const gradle = playBilling.read('android/build.gradle');
  assert.ok(
    gradle.includes(openIapGoogle),
    'The packed Gradle module must pin OpenIAP Google 4.0.8',
  );
  assert.doesNotMatch(
    gradle,
    /com\.android\.billingclient:billing:/u,
    'Billing comes from OpenIAP only',
  );
  const kotlin = playBilling.read(`${kotlinRoot}/CapacitorPlayBillingPlugin.kt`);
  // Capacitor's CLI finds plugins with this pattern in android/src/main.
  assert.match(kotlin, /^package dev\.mpgd\.capacitor\.playbilling$/mu);
  assert.match(
    kotlin,
    /^@CapacitorPlugin\(name = "CapacitorPlayBilling"\)\nclass CapacitorPlayBillingPlugin : Plugin\(\)/mu,
  );
  for (const method of ['getProducts', 'purchase', 'getPurchases']) {
    assert.match(
      kotlin,
      new RegExp(`@PluginMethod\\n    fun ${method}\\(call: PluginCall\\)`, 'u'),
      `Play registers ${method}`,
    );
  }
  assert.match(
    playBilling.read('dist/plugin.js'),
    /registerPlugin\(['"]CapacitorPlayBilling['"]\)/u,
  );

  if (modes.has('ios')) {
    const simulatorSdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], repoRoot).trim();
    run(
      'swift',
      [
        'build',
        '--package-path',
        storeKit.root,
        '--target',
        'MpgdCapacitorStoreKit',
        '--triple',
        'arm64-apple-ios15.0-simulator',
        '--sdk',
        simulatorSdk,
      ],
      storeKit.root,
      1_200_000,
    );
    console.info(
      'Packed StoreKit Swift package resolved OpenIAP Apple and compiled for the iOS simulator.',
    );
  }

  if (modes.has('android')) {
    const shell = join(repoRoot, 'apps/mobile-capacitor/android');
    assert.ok(
      existsSync(join(shell, 'capacitor-cordova-android-plugins')),
      'Run `pnpm --dir apps/mobile-capacitor sync:android` before the Android packed smoke.',
    );
    run(
      './gradlew',
      [
        '-PmpgdPlayBillingPluginTest=true',
        `-PmpgdPlayBillingPluginDir=${join(playBilling.root, 'android')}`,
        ':mpgd-capacitor-play-billing:assembleRelease',
      ],
      shell,
      1_800_000,
    );
    const aar = join(
      playBilling.root,
      'android/build/outputs/aar/mpgd-capacitor-play-billing-release.aar',
    );
    assert.ok(existsSync(aar), 'The packed Android module must produce a release AAR');
    console.info('Packed Play Billing module resolved OpenIAP Google and assembled a release AAR.');
  }
  console.info('Packed store plugins passed.');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

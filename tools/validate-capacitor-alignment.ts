import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { manifest, object, parseObject } from './validation/json.js';

const shellVersion = '8.5.2';
const pluginMinimum = '8.5.1';
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path: string) => manifest(read(path), path);

const shell = readJson('apps/mobile-capacitor/package.json');
for (const name of ['@capacitor/android', '@capacitor/core', '@capacitor/ios']) {
  assert.equal(
    shell.dependencies[name],
    shellVersion,
    `${name} must match the native shell version`,
  );
}
assert.equal(
  shell.devDependencies['@capacitor/cli'],
  shellVersion,
  '@capacitor/cli must match the native shell version',
);

const plugin = readJson('native-plugins/capacitor-game-services/package.json');
assert.equal(
  plugin.dependencies['@capacitor/core'],
  undefined,
  'The host must supply Capacitor core',
);
assert.equal(plugin.peerDependencies['@capacitor/core'], `^${pluginMinimum}`);
assert.equal(plugin.devDependencies['@capacitor/core'], shellVersion);
const adapter = readJson('adapters/capacitor/package.json');
assert.equal(
  adapter.peerDependencies['@capacitor/core'],
  plugin.peerDependencies['@capacitor/core'],
);
assert.equal(adapter.devDependencies['@capacitor/core'], shellVersion);
const gameTemplate = readJson('packages/cli/templates/phaser-game/package.json');
assert.equal(gameTemplate.dependencies['@capacitor/core'], shellVersion);

// The store plugins `--providers` installs share the shell's Capacitor line,
// and the template pins them so the wired gateways resolve.
for (const name of ['capacitor-play-billing', 'capacitor-storekit']) {
  const storePlugin = readJson(`native-plugins/${name}/package.json`);
  assert.equal(
    storePlugin.dependencies?.['@capacitor/core'],
    undefined,
    `${name}: the host must supply Capacitor core`,
  );
  assert.equal(
    storePlugin.peerDependencies['@capacitor/core'],
    `^${pluginMinimum}`,
    `${name}: Capacitor peer range`,
  );
  assert.equal(
    storePlugin.devDependencies['@capacitor/core'],
    shellVersion,
    `${name}: Capacitor dev version`,
  );
  assert.ok(
    gameTemplate.dependencies[`@mpgd/${name}`] !== undefined,
    `The game template must depend on @mpgd/${name}`,
  );
}

const swiftPackageUrl = 'https://github.com/ionic-team/capacitor-swift-pm.git';
const shellSwift = read('apps/mobile-capacitor/ios/App/CapApp-SPM/Package.swift');
assert.ok(
  shellSwift.includes(`.package(url: "${swiftPackageUrl}", exact: "${shellVersion}")`),
  'The generated iOS shell must pin the same Capacitor version',
);
const storeKitSwift = read('native-plugins/capacitor-storekit/Package.swift');
assert.ok(
  storeKitSwift.includes(`.package(url: "${swiftPackageUrl}", exact: "${shellVersion}")`)
    || storeKitSwift.includes(`.package(url: "${swiftPackageUrl}", from: "${pluginMinimum}")`),
  'The StoreKit plugin must resolve the same Capacitor 8 line as the shell',
);
const pluginSwift = read('native-plugins/capacitor-game-services/Package.swift');
assert.ok(
  pluginSwift.includes(`.package(url: "${swiftPackageUrl}", from: "${pluginMinimum}")`),
  'The native plugin must support the same Capacitor 8 range as its npm peer',
);

const resolved = parseObject(
  read(
    'apps/mobile-capacitor/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  ),
  'SPM Package.resolved',
);
assert.ok(Array.isArray(resolved.pins), 'SPM pins must be an array');
const capacitorPin = resolved.pins.map((pin: unknown) => object(pin, 'SPM pin')).find(
  (pin) => pin.identity === 'capacitor-swift-pm',
);
assert.ok(capacitorPin, 'Missing Capacitor SPM pin');
const pinState = object(capacitorPin.state, 'SPM state');
assert.equal(typeof pinState.revision, 'string');
assert.equal(pinState.version, shellVersion, 'Xcode SPM resolution is stale');
assert.match(
  typeof pinState.revision === 'string' ? pinState.revision : '',
  /^[0-9a-f]{40}$/,
  'The capacitor-swift-pm pin must record a full-length commit revision',
);

const gradleSettings = read('apps/mobile-capacitor/android/capacitor.settings.gradle');
const androidResolution = gradleSettings.match(
  /@capacitor\+android@([0-9.]+)_@capacitor\+core@([0-9.]+)/,
);
assert.equal(androidResolution?.[1], shellVersion, 'Android generated path is stale');
assert.equal(androidResolution?.[2], shellVersion, 'Android generated core path is stale');

const sceneDelegate = read('apps/mobile-capacitor/ios/App/App/SceneDelegate.swift');
const appDelegate = read('apps/mobile-capacitor/ios/App/App/AppDelegate.swift');
const xcodeProject = read('apps/mobile-capacitor/ios/App/App.xcodeproj/project.pbxproj');
assert.match(
  sceneDelegate,
  /SceneDelegateProxy\.shared\.scene\(scene, openURLContexts: URLContexts\)/,
);
assert.match(sceneDelegate, /SceneDelegateProxy\.shared\.scene\(scene, continue: userActivity\)/);
assert.match(
  sceneDelegate,
  /connectionOptions\.notificationResponse/,
  'A killed-app notification tap is only in connectionOptions.notificationResponse',
);
assert.match(
  sceneDelegate,
  /capacitorViewDidAppear/,
  'Cold-start notification taps must be forwarded once the bridge has loaded plugins',
);
assert.match(
  sceneDelegate,
  /userNotificationCenter/,
  'Cold-start notification taps must reach the UNUserNotificationCenter delegate',
);
assert.match(appDelegate, /configurationForConnecting connectingSceneSession/);
assert.match(xcodeProject, /SceneDelegate\.swift in Sources/);
for (const name of ['Info.plist', 'Info-Smoke.plist']) {
  assert.match(read(`apps/mobile-capacitor/ios/App/App/${name}`), /UISceneDelegateClassName/);
}

const androidManifest = read('apps/mobile-capacitor/android/app/src/main/AndroidManifest.xml');
const androidApplication = androidManifest.match(/<application\b[^>]*>/u)?.[0] ?? '';
assert.match(
  androidManifest,
  /<manifest\b[^>]*\sxmlns:tools="http:\/\/schemas\.android\.com\/tools"/u,
  'The Android shell manifest must bind the tools namespace for tools:targetApi',
);
for (const attribute of [
  'android:allowBackup="false"',
  'android:fullBackupContent="@xml/backup_rules"',
  'android:dataExtractionRules="@xml/data_extraction_rules"',
  'tools:targetApi="s"',
]) {
  assert.ok(
    androidApplication.includes(` ${attribute}`),
    `The Android shell must opt out of backups and Android 12+ device transfers with ${attribute}: WebView storage and game-services SharedPreferences hold save data`,
  );
}
const backupDomains = ['root', 'file', 'database', 'sharedpref', 'external'];
const backupRules = read('apps/mobile-capacitor/android/app/src/main/res/xml/backup_rules.xml');
const extractionRules = read(
  'apps/mobile-capacitor/android/app/src/main/res/xml/data_extraction_rules.xml',
);
for (const rules of [backupRules, extractionRules]) {
  assert.doesNotMatch(rules, /<include\b/u, 'Backup rules must not opt any path back in');
}
assert.match(backupRules, /<full-backup-content>[\s\S]*<\/full-backup-content>/u);
for (const section of ['cloud-backup', 'device-transfer']) {
  const body = extractionRules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, 'u'))?.[1];
  assert.ok(body !== undefined, `data_extraction_rules.xml must declare <${section}>`);
  for (const domain of backupDomains) {
    const exclude = `<exclude domain="${domain}" path="." />`;
    assert.ok(body.includes(exclude), `${section} must exclude the ${domain} domain`);
    assert.ok(backupRules.includes(exclude), `backup_rules.xml must exclude the ${domain} domain`);
  }
}

console.info(`Capacitor ${shellVersion} npm, Android, iOS, scene, and backup alignment verified.`);

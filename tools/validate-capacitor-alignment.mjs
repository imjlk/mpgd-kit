import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shellVersion = '8.5.2';
const pluginMinimum = '8.5.1';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(read(path));

const shell = readJson('apps/mobile-capacitor/package.json');
for (const name of ['@capacitor/android', '@capacitor/core', '@capacitor/ios']) {
  assert.equal(shell.dependencies[name], shellVersion, `${name} must match the native shell version`);
}
assert.equal(shell.devDependencies['@capacitor/cli'], shellVersion);

const plugin = readJson('native-plugins/capacitor-game-services/package.json');
assert.equal(plugin.dependencies['@capacitor/core'], undefined, 'The host must supply Capacitor core');
assert.equal(plugin.peerDependencies['@capacitor/core'], `^${pluginMinimum}`);
assert.equal(plugin.devDependencies['@capacitor/core'], shellVersion);

const swiftPackageUrl = 'https://github.com/ionic-team/capacitor-swift-pm.git';
const shellSwift = read('apps/mobile-capacitor/ios/App/CapApp-SPM/Package.swift');
assert.ok(
  shellSwift.includes(`.package(url: "${swiftPackageUrl}", exact: "${shellVersion}")`),
  'The generated iOS shell must pin the same Capacitor version',
);
const pluginSwift = read('native-plugins/capacitor-game-services/Package.swift');
assert.ok(
  pluginSwift.includes(`.package(url: "${swiftPackageUrl}", from: "${pluginMinimum}")`),
  'The native plugin must support the same Capacitor 8 range as its npm peer',
);

const resolved = readJson('apps/mobile-capacitor/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved');
const capacitorPin = resolved.pins.find((pin) => pin.identity === 'capacitor-swift-pm');
assert.equal(capacitorPin?.state.version, shellVersion, 'Xcode SPM resolution is stale');
assert.match(capacitorPin?.state.revision ?? '', /^[0-9a-f]{40}$/);

const gradleSettings = read('apps/mobile-capacitor/android/capacitor.settings.gradle');
const androidResolution = gradleSettings.match(
  /@capacitor\+android@([0-9.]+)_@capacitor\+core@([0-9.]+)/,
);
assert.equal(androidResolution?.[1], shellVersion, 'Android generated path is stale');
assert.equal(androidResolution?.[2], shellVersion, 'Android generated core path is stale');

const sceneDelegate = read('apps/mobile-capacitor/ios/App/App/SceneDelegate.swift');
const appDelegate = read('apps/mobile-capacitor/ios/App/App/AppDelegate.swift');
const xcodeProject = read('apps/mobile-capacitor/ios/App/App.xcodeproj/project.pbxproj');
assert.match(sceneDelegate, /SceneDelegateProxy\.shared\.scene\(scene, openURLContexts: URLContexts\)/);
assert.match(sceneDelegate, /SceneDelegateProxy\.shared\.scene\(scene, continue: userActivity\)/);
assert.match(appDelegate, /configurationForConnecting connectingSceneSession/);
assert.match(xcodeProject, /SceneDelegate\.swift in Sources/);
for (const name of ['Info.plist', 'Info-Smoke.plist']) {
  assert.match(read(`apps/mobile-capacitor/ios/App/App/${name}`), /UISceneDelegateClassName/);
}

console.log(`Capacitor ${shellVersion} npm, Android, iOS, and scene alignment verified.`);

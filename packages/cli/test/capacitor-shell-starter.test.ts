import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyCapacitorShellStarter,
  decodeAndroidStringResource,
  materializeCapacitorShellStarter,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-shell-'));

assert.equal(decodeAndroidStringResource("King\\'s Quest"), "King's Quest");
assert.equal(decodeAndroidStringResource('"King\\\'s Quest"'), "King's Quest");
assert.equal(decodeAndroidStringResource('Puzzle   Game'), 'Puzzle Game');
assert.equal(decodeAndroidStringResource('"Puzzle   Game"'), 'Puzzle   Game');

function writeJson(relative: string, value: unknown): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
}

function iosProjectWithAppId(appId: string): string {
  return [
    'AAAAAAAA /* App */ = { isa = PBXNativeTarget; name = App; buildConfigurationList = BBBBBBBB; };',
    'BBBBBBBB /* App configurations */ = { isa = XCConfigurationList; buildConfigurations = (',
    '  CCCCCCCC /* Debug */, DDDDDDDD /* Release */,); };',
    `CCCCCCCC /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${appId}; }; };`,
    `DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${appId}; INFOPLIST_FILE = App/Info.plist; }; };`,
    'EEEEEEEE /* NotificationService */ = { isa = PBXNativeTarget; name = NotificationService;',
    '  buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle.NotificationService; }; };',
    '/* SceneDelegate.swift in Sources */',
    '/* Main.storyboard in Resources */',
    '/* LaunchScreen.storyboard in Resources */',
    '/* Assets.xcassets in Resources */',
  ].join('\n');
}

const androidManifestOpen = [
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
  ' package="dev.example.puzzle">',
].join('');

const completeAndroidManifest = [
  androidManifestOpen,
  '<application android:label="@string/app_name" android:theme="@style/AppTheme">',
  '<activity android:name="com.vendor.SdkActivity"/>',
  '<activity android:name=".MainActivity"><intent-filter>',
  '<action android:name="android.intent.action.MAIN"/>',
  '<category android:name="android.intent.category.LAUNCHER"/>',
  '</intent-filter></activity></application></manifest>',
].join('');

try {
  writeJson('package.json', {
    name: '@game/puzzle',
    private: true,
    dependencies: { '@capacitor/core': '8.5.2', '@capacitor/app': '8.1.1' },
  });
  writeJson('node_modules/@mpgd/adapter-capacitor/package.json', {
    name: '@mpgd/adapter-capacitor',
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
        webDir: '${MPGD_KIT_PATH}/apps/mobile-capacitor/www',
        artifact: 'aab',
        icon: { profile: 'android' },
      },
      ios: {
        kind: 'capacitor-ios',
        adapter: 'capacitor',
        gameApp: '.',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
        webDir: '${MPGD_KIT_PATH}/apps/mobile-capacitor/www',
        artifact: 'ipa',
        icon: { profile: 'ios' },
      },
    },
  });
  mkdirSync(path.join(root, 'public'));
  writeFileSync(path.join(root, 'public/icon.svg'), '<svg/>');
  const options = {
    gameRoot: root,
    appId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
    iconSource: 'public/icon.svg',
    backendUrl: 'https://api.example.com',
    providerIds: ['game-platform', 'identity', 'identity'],
  } as const;

  assert.throws(
    () => planCapacitorShellStarter({ ...options, displayName: 'Bad\u0001Name' }),
    /invalid in native XML/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, displayName: 'Bad\ud800Name' }),
    /invalid in native XML/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, displayName: 'Bad\rName' }),
    /invalid in native XML/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, displayName: 'Puzzle $(PRODUCT_NAME)' }),
    /Xcode build-setting expansions/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'dev.example.class' }),
    /Java keyword/u,
  );

  const dryRun = planCapacitorShellStarter(options);
  const baseTargets = readJson('mpgd.targets.json');
  const baseMap = baseTargets.targets as Record<string, Record<string, unknown>>;
  const initialAndroidTarget = baseMap.android;
  assert.ok(initialAndroidTarget);
  delete initialAndroidTarget.gameApp;
  writeJson('mpgd.targets.json', baseTargets);
  assert.throws(() => planCapacitorShellStarter(options), /android.gameApp/u);
  initialAndroidTarget.gameApp = '.';
  initialAndroidTarget.gameApp = '../other-game';
  writeJson('mpgd.targets.json', baseTargets);
  assert.throws(() => planCapacitorShellStarter(options), /gameApp must select this game root/u);
  initialAndroidTarget.gameApp = '.';
  writeJson('mpgd.targets.json', baseTargets);
  delete initialAndroidTarget.adapter;
  writeJson('mpgd.targets.json', baseTargets);
  assert.throws(() => planCapacitorShellStarter(options), /android.adapter/u);
  initialAndroidTarget.adapter = 'capacitor';
  writeJson('mpgd.targets.json', baseTargets);
  assert.ok(dryRun.changedFiles.includes('mpgd.targets.json'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/capacitor.config.ts'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/www/index.html'));
  const smokePath = 'apps/mobile-capacitor/ios/App/App/Info-Smoke.plist';
  assert.ok(dryRun.changedFiles.includes(smokePath));
  assert.ok(dryRun.files.some((file) => file.path === smokePath));
  assert.equal(existsSync(path.join(root, 'apps/mobile-capacitor')), false);
  applyCapacitorShellStarter(dryRun);
  assert.equal(existsSync(path.join(root, 'apps/mobile-capacitor/ios')), false);

  const targets = readJson('mpgd.targets.json').targets as Record<string, Record<string, unknown>>;
  assert.equal(targets.android?.shellApp, 'apps/mobile-capacitor');
  assert.equal(targets.ios?.webDir, 'apps/mobile-capacitor/www');
  assert.deepEqual(targets.android?.metadata, {
    packageId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
  });
  assert.deepEqual(targets.ios?.metadata, {
    bundleId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
  });
  assert.deepEqual(targets.android?.icon, {
    profile: 'android',
    source: 'public/icon.svg',
  });
  const shellPackage = readJson('apps/mobile-capacitor/package.json');
  assert.ok(readFileSync(path.join(root, 'apps/mobile-capacitor/www/index.html'), 'utf8')
    .includes('Native shell setup'));
  assert.equal(shellPackage.private, true);
  assert.equal((shellPackage.devDependencies as Record<string, string>).typescript, '7.0.2');
  assert.equal(
    (shellPackage.dependencies as Record<string, string>)['@mpgd/capacitor-game-services'],
    '0.5.4',
  );
  assert.deepEqual(readJson('apps/mobile-capacitor/mpgd.native-shell.json').requestedProviderIds, [
    'game-platform',
    'identity',
  ]);
  assert.equal(
    readFileSync(path.join(root, '.env.production'), 'utf8'),
    'VITE_MPGD_GAME_SERVICES_URL=https://api.example.com\n',
  );
  const localProductionEnv = path.join(root, '.env.production.local');
  writeFileSync(localProductionEnv, 'VITE_MPGD_GAME_SERVICES_URL=https://other.example.com\n');
  assert.throws(() => planCapacitorShellStarter(options), /Production-local Game Services URL/u);
  writeFileSync(
    localProductionEnv,
    '\uFEFFVITE_MPGD_GAME_SERVICES_URL=https://other.example.com\n',
  );
  assert.throws(() => planCapacitorShellStarter(options), /Production-local Game Services URL/u);
  rmSync(localProductionEnv);

  const repeat = planCapacitorShellStarter(options);
  assert.deepEqual(repeat.changedFiles, [smokePath]);
  assert.deepEqual(repeat.nativePlatformsToAdd, ['android', 'ios']);
  const omittedSelections = planCapacitorShellStarter({
    gameRoot: root,
    appId: options.appId,
    displayName: options.displayName,
  });
  assert.deepEqual(omittedSelections.changedFiles, [smokePath]);
  const commands: string[] = [];
  materializeCapacitorShellStarter(repeat, {
    run(command, args, cwd) {
      assert.equal(cwd, realpathSync(root));
      commands.push(`${command} ${args.join(' ')}`);
      if (args[0] === 'install') {
        const cli = path.join(root, 'apps/mobile-capacitor/node_modules/.bin/cap');
        mkdirSync(path.dirname(cli), { recursive: true });
        writeFileSync(cli, 'pinned-capacitor-cli');
      }
      if (args.at(-2) === 'add') {
        const platform = String(args.at(-1));
        const sentinel = platform === 'android'
          ? 'android/app/build.gradle'
          : 'ios/App/App.xcodeproj/project.pbxproj';
        const file = path.join(root, 'apps/mobile-capacitor', sentinel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          platform === 'android'
            ? 'applicationId "dev.example.puzzle"'
            : iosProjectWithAppId('dev.example.puzzle'),
        );
        const required = platform === 'android'
          ? [
              'android/gradlew',
              'android/build.gradle',
              'android/variables.gradle',
              'android/gradle/wrapper/gradle-wrapper.jar',
              'android/gradle/wrapper/gradle-wrapper.properties',
              'android/settings.gradle',
              'android/capacitor.settings.gradle',
              'android/app/capacitor.build.gradle',
              'android/capacitor-cordova-android-plugins/cordova.variables.gradle',
              'android/app/src/main/AndroidManifest.xml',
              'android/app/src/main/res/values/strings.xml',
              'android/app/src/main/res/values/styles.xml',
              'android/app/src/main/java/dev/example/puzzle/MainActivity.java',
            ]
          : [
              'ios/App/App/AppDelegate.swift',
              'ios/App/App/SceneDelegate.swift',
              'ios/App/App/Info.plist',
              'ios/App/App/Base.lproj/Main.storyboard',
              'ios/App/App/Base.lproj/LaunchScreen.storyboard',
              'ios/App/App/Assets.xcassets/Contents.json',
              'ios/App/CapApp-SPM/Package.swift',
            ];
        for (const relative of required) {
          const requiredFile = path.join(root, 'apps/mobile-capacitor', relative);
          mkdirSync(path.dirname(requiredFile), { recursive: true });
          const contents: Record<string, string> = {
            'android/build.gradle': 'apply from: "variables.gradle"',
            'android/settings.gradle': "apply from: 'capacitor.settings.gradle'",
            'android/app/capacitor.build.gradle':
              'apply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"',
            'android/app/src/main/res/values/strings.xml':
              '<resources><string name="app_name">Puzzle Game</string></resources>',
            'android/app/src/main/res/values/styles.xml':
              '<resources><style name="AppTheme" /></resources>',
            'android/app/src/main/AndroidManifest.xml':
              completeAndroidManifest,
            'android/app/src/main/java/dev/example/puzzle/MainActivity.java':
              'package dev.example.puzzle; public class MainActivity {}',
            'ios/App/App/Info.plist':
              '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
            'ios/App/App/SceneDelegate.swift': 'class SceneDelegate {}',
          };
          writeFileSync(requiredFile, contents[relative] ?? 'generated-native-project');
        }
        if (platform === 'android') {
          writeFileSync(file, [
            'namespace "dev.example.puzzle"',
            'applicationId "dev.example.puzzle"',
            "apply from: 'capacitor.build.gradle'",
          ].join('\n'));
          chmodSync(path.join(root, 'apps/mobile-capacitor/android/gradlew'), 0o755);
        }
      }
    },
  });
  assert.deepEqual(commands, [
    'pnpm install --no-frozen-lockfile',
    'pnpm --dir apps/mobile-capacitor install --ignore-workspace --no-frozen-lockfile',
    'pnpm --dir apps/mobile-capacitor cap add android',
    'pnpm --dir apps/mobile-capacitor cap add ios',
  ]);
  const cli = path.join(root, 'apps/mobile-capacitor/node_modules/.bin/cap');
  assert.equal(existsSync(cli), true);
  const smokeInfo = path.join(root, 'apps/mobile-capacitor/ios/App/App/Info-Smoke.plist');
  const originalSmoke = readFileSync(smokeInfo, 'utf8');
  assert.match(originalSmoke, /<string>Puzzle Game<\/string>/u);
  assert.doesNotMatch(originalSmoke, /UIMainStoryboardFile/u);
  writeFileSync(smokeInfo, originalSmoke.replace('Puzzle Game', 'Other Game'));
  assert.throws(
    () => planCapacitorShellStarter(options),
    /simulator Info.plist CFBundleDisplayName/u,
  );
  writeFileSync(smokeInfo, '<plist><dict><key>CFBundleDisplayName</key>');
  assert.throws(() => planCapacitorShellStarter(options), /simulator Info.plist is malformed/u);
  writeFileSync(
    smokeInfo,
    originalSmoke.replace('<plist version="1.0"><dict>', '<plist version="1.0"><dict><dict>'),
  );
  assert.throws(() => planCapacitorShellStarter(options), /simulator Info.plist is malformed/u);
  writeFileSync(smokeInfo, originalSmoke);
  writeFileSync(
    smokeInfo,
    originalSmoke.replace(
      '</dict></plist>',
      '<key>UIMainStoryboardFile~ipad</key><string>Main</string></dict></plist>',
    ),
  );
  assert.throws(() => planCapacitorShellStarter(options), /excluded storyboards/u);
  writeFileSync(smokeInfo, originalSmoke);
  writeFileSync(
    smokeInfo,
    originalSmoke.replace('<key>CFBundleIdentifier</key>', '<key> CFBundleIdentifier </key>'),
  );
  assert.throws(
    () => planCapacitorShellStarter(options),
    /simulator Info.plist CFBundleIdentifier/u,
  );
  writeFileSync(smokeInfo, originalSmoke);
  const invalidSmoke = originalSmoke.replace(
    '</dict></plist>',
    '<key>Extra</key><bogus/></dict></plist>',
  );
  writeFileSync(smokeInfo, invalidSmoke);
  assert.throws(() => planCapacitorShellStarter(options), /unsupported value node/u);
  writeFileSync(smokeInfo, originalSmoke);
  const invalidInteger = originalSmoke.replace(
    '</dict></plist>',
    '<key>Extra</key><integer>bogus</integer></dict></plist>',
  );
  writeFileSync(smokeInfo, invalidInteger);
  assert.throws(() => planCapacitorShellStarter(options), /unsupported value node/u);
  const paddedInteger = originalSmoke.replace(
    '</dict></plist>',
    '<key>Extra</key><integer> 1 </integer></dict></plist>',
  );
  writeFileSync(smokeInfo, paddedInteger);
  assert.throws(() => planCapacitorShellStarter(options), /unsupported value node/u);
  const paddedBoolean = originalSmoke.replace(
    '</dict></plist>',
    '<key>Extra</key><true> </true></dict></plist>',
  );
  writeFileSync(smokeInfo, paddedBoolean);
  assert.throws(() => planCapacitorShellStarter(options), /unsupported value node/u);
  writeFileSync(smokeInfo, originalSmoke);
  renameSync(smokeInfo, `${smokeInfo}.saved`);
  const smokeRepair = planCapacitorShellStarter(options);
  assert.deepEqual(smokeRepair.changedFiles, [
    'apps/mobile-capacitor/ios/App/App/Info-Smoke.plist',
  ]);
  assert.deepEqual(smokeRepair.nativePlatformsToAdd, []);
  applyCapacitorShellStarter(smokeRepair);
  assert.equal(existsSync(smokeInfo), true);
  unlinkSync(smokeInfo);
  renameSync(`${smokeInfo}.saved`, smokeInfo);
  const retryCommands: string[] = [];
  materializeCapacitorShellStarter(planCapacitorShellStarter(options), {
    run(command, args, cwd) {
      assert.equal(cwd, realpathSync(root));
      retryCommands.push(`${command} ${args.join(' ')}`);
      if (args.includes('--ignore-workspace')) {
        writeFileSync(cli, 'standalone-capacitor-cli');
      }
    },
  });
  assert.deepEqual(retryCommands, [
    'pnpm install --no-frozen-lockfile',
    'pnpm --dir apps/mobile-capacitor install --ignore-workspace --no-frozen-lockfile',
  ]);
  const completeRetryCommands: string[] = [];
  materializeCapacitorShellStarter(planCapacitorShellStarter(options), {
    run(command, args) {
      completeRetryCommands.push(`${command} ${args.join(' ')}`);
    },
  });
  assert.deepEqual(completeRetryCommands, [
    'pnpm install --no-frozen-lockfile',
    'pnpm --dir apps/mobile-capacitor install --ignore-workspace --no-frozen-lockfile',
  ]);
  writeFileSync(path.join(root, 'apps/mobile-capacitor/ios/CustomViewController.swift'), 'custom');
  const withNativeProjects = planCapacitorShellStarter(options);
  assert.deepEqual(withNativeProjects.changedFiles, []);
  assert.deepEqual(withNativeProjects.nativePlatformsToAdd, []);
  const iosProjectFile = path.join(
    root,
    'apps/mobile-capacitor/ios/App/App.xcodeproj/project.pbxproj',
  );
  writeFileSync(
    iosProjectFile,
    iosProjectWithAppId('dev.example.puzzle').replace(
      'INFOPLIST_FILE = App/Info.plist;',
      'PRODUCT_NAME = CustomGame; INFOPLIST_FILE = App/Info.plist;',
    ),
  );
  assert.throws(() => planCapacitorShellStarter(options), /PRODUCT_NAME must build App.app/u);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  const customBuildFile = path.join(root, 'apps/mobile-capacitor/ios/App/App/CustomView.swift');
  writeFileSync(customBuildFile, 'class CustomView {}');
  const customProject = iosProjectWithAppId('dev.example.puzzle').replace(
    'buildConfigurationList = BBBBBBBB; };',
    'buildConfigurationList = BBBBBBBB; buildPhases = (11111111 /* Sources */); };',
  ) + '\n' + [
    '11111111 /* Sources */ = { isa = PBXSourcesBuildPhase;',
    'files = (22222222 /* CustomView.swift in Sources */); };',
    '22222222 /* CustomView.swift in Sources */ = { isa = PBXBuildFile;',
    'fileRef = 33333333 /* CustomView.swift */; };',
    '33333333 /* CustomView.swift */ = { isa = PBXFileReference;',
    'path = CustomView.swift; sourceTree = "<group>"; };',
  ].join('\n');
  writeFileSync(iosProjectFile, customProject);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const hexCommentProject = customProject.replace(
    'CustomView.swift in Sources',
    'ABC.swift in Sources',
  );
  writeFileSync(iosProjectFile, hexCommentProject);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, customProject);
  unlinkSync(customBuildFile);
  assert.throws(() => planCapacitorShellStarter(options), /App build input.*missing/u);
  const groupedProject = customProject + '\n' + [
    '44444444 /* App */ = { isa = PBXGroup; children = (55555555);',
    'path = App; sourceTree = "<group>"; };',
    '55555555 /* Controllers */ = { isa = PBXGroup; children = (33333333);',
    'path = Controllers; sourceTree = "<group>"; };',
  ].join('\n');
  const groupedView = path.join(
    root,
    'apps/mobile-capacitor/ios/App/App/Controllers/CustomView.swift',
  );
  mkdirSync(path.dirname(groupedView), { recursive: true });
  writeFileSync(groupedView, 'class CustomView {}');
  writeFileSync(iosProjectFile, groupedProject);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const sourceRootProject = groupedProject.replace(
    'path = CustomView.swift; sourceTree = "<group>";',
    'path = App/Controllers/CustomView.swift; sourceTree = SOURCE_ROOT;',
  );
  writeFileSync(iosProjectFile, sourceRootProject);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, groupedProject);
  unlinkSync(groupedView);
  assert.throws(() => planCapacitorShellStarter(options), /App build input.*missing/u);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  renameSync(iosProjectFile, `${iosProjectFile}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /ios project is incomplete/u);
  renameSync(`${iosProjectFile}.saved`, iosProjectFile);
  const sceneDelegate = path.join(root, 'apps/mobile-capacitor/ios/App/App/SceneDelegate.swift');
  renameSync(sceneDelegate, `${sceneDelegate}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /referenced app file/u);
  const appOnlyProject = readFileSync(iosProjectFile, 'utf8').replace(
    '/* SceneDelegate.swift in Sources */',
    '',
  );
  writeFileSync(iosProjectFile, appOnlyProject);
  assert.throws(() => planCapacitorShellStarter(options), /simulator scene delegate.*missing/u);
  const customScene = path.join(root, 'apps/mobile-capacitor/ios/App/App/CustomScenes.swift');
  const customSmoke = originalSmoke.replace(
    '$(PRODUCT_MODULE_NAME).SceneDelegate',
    '$(PRODUCT_MODULE_NAME).GameSceneDelegate',
  );
  writeFileSync(customScene, 'class GameSceneDelegate {}');
  writeFileSync(smokeInfo, customSmoke);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  unlinkSync(customScene);
  assert.throws(() => planCapacitorShellStarter(options), /GameSceneDelegate.*missing/u);
  writeFileSync(smokeInfo, originalSmoke);
  const smokeWithoutScene = originalSmoke.replace(
    '<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>',
    '',
  );
  writeFileSync(smokeInfo, smokeWithoutScene);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(smokeInfo, originalSmoke);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  renameSync(`${sceneDelegate}.saved`, sceneDelegate);
  const androidWrapper = path.join(root, 'apps/mobile-capacitor/android/gradlew');
  renameSync(androidWrapper, `${androidWrapper}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /android project is incomplete/u);
  renameSync(`${androidWrapper}.saved`, androidWrapper);
  if (process.platform !== 'win32') {
    chmodSync(androidWrapper, 0o644);
    assert.throws(() => planCapacitorShellStarter(options), /Gradle wrapper is not executable/u);
    chmodSync(androidWrapper, 0o755);
  }
  const androidRootBuild = path.join(root, 'apps/mobile-capacitor/android/build.gradle');
  renameSync(androidRootBuild, `${androidRootBuild}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /android project is incomplete/u);
  renameSync(`${androidRootBuild}.saved`, androidRootBuild);
  const androidVariables = path.join(root, 'apps/mobile-capacitor/android/variables.gradle');
  renameSync(androidVariables, `${androidVariables}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /applied Gradle script/u);
  renameSync(`${androidVariables}.saved`, androidVariables);
  writeFileSync(androidRootBuild, 'apply from: file("missing.gradle")');
  assert.throws(() => planCapacitorShellStarter(options), /applied Gradle script/u);
  writeFileSync(androidRootBuild, 'apply(from = file("missing.gradle"))');
  assert.throws(() => planCapacitorShellStarter(options), /applied Gradle script/u);
  writeFileSync(androidRootBuild, 'apply from: dynamicScript()');
  assert.throws(() => planCapacitorShellStarter(options), /unsupported Gradle apply expression/u);
  const rootCallback = 'project(":app") { afterEvaluate { android.defaultConfig.versionName = "9.0.0" } }';
  writeFileSync(androidRootBuild, rootCallback);
  assert.throws(() => planCapacitorShellStarter(options), /root Gradle app callbacks/u);
  writeFileSync(androidRootBuild, [
    'println("afterEvaluate android")',
    'apply from: "variables.gradle"',
  ].join('\n'));
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(androidRootBuild, 'apply from: "variables.gradle"');
  const capacitorGradle = path.join(
    root,
    'apps/mobile-capacitor/android/app/capacitor.build.gradle',
  );
  renameSync(capacitorGradle, `${capacitorGradle}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /applied Gradle script/u);
  renameSync(`${capacitorGradle}.saved`, capacitorGradle);
  writeFileSync(capacitorGradle, 'applicationId "dev.other.game"');
  assert.throws(
    () => planCapacitorShellStarter(options),
    /applied Gradle script changes identity/u,
  );
  for (const mutation of [
    'applicationId rootProject.ext.gameAppId',
    'applicationId(project.findProperty("id"))',
    'setApplicationId("dev.other.game")',
    'versionCode(computeCode())',
    "android.defaultConfig.setProperty('versionCode', 99)",
    "def key = 'versionName'; android.defaultConfig.setProperty(key, '9.9.9')",
  ]) {
    writeFileSync(capacitorGradle, mutation);
    assert.throws(
      () => planCapacitorShellStarter(options),
      /applied Gradle script changes identity/u,
    );
  }
  const readOnlyGradle = 'println(android.defaultConfig.versionName)\nprintln("versionName")';
  writeFileSync(capacitorGradle, readOnlyGradle);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(capacitorGradle, 'android { productFlavors { demo {} } }');
  assert.throws(() => planCapacitorShellStarter(options), /product flavors are unsupported/u);
  writeFileSync(
    capacitorGradle,
    'apply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"',
  );
  const wrapperJar = path.join(
    root,
    'apps/mobile-capacitor/android/gradle/wrapper/gradle-wrapper.jar',
  );
  renameSync(wrapperJar, `${wrapperJar}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /android project is incomplete/u);
  renameSync(`${wrapperJar}.saved`, wrapperJar);
  const androidStrings = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/values/strings.xml',
  );
  writeFileSync(
    androidStrings,
    '<resources><string name="app_name">Other Game</string></resources>',
  );
  assert.throws(() => planCapacitorShellStarter(options), /android project display name differs/u);
  writeFileSync(
    androidStrings,
    '<resources><string name="app_name">Puzzle Game</string></resources>',
  );
  const releaseValues = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/release/res/values/strings.xml',
  );
  mkdirSync(path.dirname(releaseValues), { recursive: true });
  writeFileSync(
    releaseValues,
    '<resources><string name="app_name">Other Game</string></resources>',
  );
  assert.throws(() => planCapacitorShellStarter(options), /android project display name differs/u);
  unlinkSync(releaseValues);
  const androidManifest = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/AndroidManifest.xml',
  );
  const wrongLabelManifest = `${androidManifestOpen}<application android:label="Other Game" /></manifest>`;
  writeFileSync(androidManifest, wrongLabelManifest);
  assert.throws(() => planCapacitorShellStarter(options), /application label differs/u);
  writeFileSync(androidManifest, [
    `${androidManifestOpen}<application android:label="@string/app_name">`,
    '<activity android:label="Other Game"><intent-filter>',
    '<action android:name="android.intent.action.MAIN"/>',
    '<category android:name="android.intent.category.LAUNCHER"/>',
    '</intent-filter></activity></application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /launcher label differs/u);
  writeFileSync(androidManifest, completeAndroidManifest);
  writeFileSync(androidManifest, [
    androidManifestOpen,
    '<application android:label="@string/app_name" android:theme="@style/AppTheme">',
    '<activity-alias android:name=".Alias" android:targetActivity=".MainActivity">',
    '<intent-filter><action android:name="android.intent.action.MAIN"/>',
    '<category android:name="android.intent.category.LAUNCHER"/>',
    '</intent-filter></activity-alias></application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /alias target.*undeclared/u);
  writeFileSync(androidManifest, completeAndroidManifest);
  const releaseManifest = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/release/AndroidManifest.xml',
  );
  const aliasManifest = [
    androidManifestOpen,
    '<application android:label="@string/app_name" android:theme="@style/AppTheme">',
    '<activity android:name=".MainActivity"/>',
    '<activity-alias android:name=".Alias" android:targetActivity=".MainActivity">',
    '<intent-filter><action android:name="android.intent.action.MAIN"/>',
    '<category android:name="android.intent.category.LAUNCHER"/>',
    '</intent-filter></activity-alias></application></manifest>',
  ].join('');
  writeFileSync(androidManifest, aliasManifest);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(releaseManifest, [
    androidManifestOpen.replace(' package=',
      ' xmlns:tools="http://schemas.android.com/tools" package='),
    '<application><activity android:name=".MainActivity" tools:node="remove"/>',
    '</application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /alias target.*changed by Release/u);
  writeFileSync(androidManifest, completeAndroidManifest);
  writeFileSync(
    releaseManifest,
    `${androidManifestOpen}<application android:label="Other Game" /></manifest>`,
  );
  assert.throws(() => planCapacitorShellStarter(options), /Release application label differs/u);
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<application><activity android:name=".MainActivity" android:label="Other Game"/>',
    '</application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /Release launcher label differs/u);
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<application><activity android:name=".MainActivity" android:enabled="false"/>',
    '</application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /android:enabled/u);
  writeFileSync(releaseManifest, [
    androidManifestOpen.replace(' package=',
      ' xmlns:tools="http://schemas.android.com/tools" package='),
    '<application><activity android:name=".MainActivity" tools:node="remove"/>',
    '</application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /changes a launcher node/u);
  writeFileSync(releaseManifest, [
    androidManifestOpen.replace(' package=',
      ' xmlns:tools="http://schemas.android.com/tools" package='),
    '<application><activity android:name=".MainActivity">',
    '<intent-filter tools:node="removeAll"/>',
    '</activity></application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /changes a launcher node/u);
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<uses-permission android:name="android.permission.CAMERA"/>',
    '</manifest>',
  ].join(''));
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<application android:theme="@style/ReleaseTheme"/></manifest>',
  ].join(''));
  assert.throws(
    () => planCapacitorShellStarter(options),
    /manifest resource @style\/ReleaseTheme is missing/u,
  );
  const nightDrawable = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/drawable-night',
  );
  mkdirSync(nightDrawable, { recursive: true });
  writeFileSync(path.join(nightDrawable, 'only_night.xml'), '<shape/>');
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<application android:icon="@drawable/only_night"/></manifest>',
  ].join(''));
  assert.throws(
    () => planCapacitorShellStarter(options),
    /manifest resource @drawable\/only_night is missing/u,
  );
  unlinkSync(path.join(nightDrawable, 'only_night.xml'));
  writeFileSync(releaseManifest, [
    androidManifestOpen,
    '<application><activity android:name=".MissingActivity"><intent-filter>',
    '<action android:name="android.intent.action.MAIN"/>',
    '<category android:name="android.intent.category.LAUNCHER"/>',
    '</intent-filter></activity></application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /launcher class.*missing/u);
  const releaseActivity = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/release/java/dev/example/puzzle/MissingActivity.java',
  );
  mkdirSync(path.dirname(releaseActivity), { recursive: true });
  writeFileSync(releaseActivity, 'package dev.example.puzzle; public class MissingActivity {}');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  unlinkSync(releaseActivity);
  unlinkSync(releaseManifest);
  const mainActivity = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/java/dev/example/puzzle/MainActivity.java',
  );
  writeFileSync(mainActivity, 'package dev.other.puzzle; public class MainActivity {}');
  assert.throws(() => planCapacitorShellStarter(options), /launcher class.*missing/u);
  writeFileSync(mainActivity, 'package dev.example.puzzle; // class MainActivity {}');
  assert.throws(() => planCapacitorShellStarter(options), /launcher class.*missing/u);
  const kotlinLauncher = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/kotlin/dev/example/puzzle/Launcher.kt',
  );
  mkdirSync(path.dirname(kotlinLauncher), { recursive: true });
  writeFileSync(kotlinLauncher, 'package dev.example.puzzle\nclass MainActivity {}');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  unlinkSync(kotlinLauncher);
  writeFileSync(mainActivity, 'package dev.example.puzzle; public class MainActivity {}');
  const androidStyles = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/values/styles.xml',
  );
  renameSync(androidStyles, `${androidStyles}.saved`);
  assert.throws(
    () => planCapacitorShellStarter(options),
    /manifest resource @style\/AppTheme is missing/u,
  );
  renameSync(`${androidStyles}.saved`, androidStyles);
  const nightValues = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/values-night',
  );
  mkdirSync(nightValues, { recursive: true });
  renameSync(androidStyles, path.join(nightValues, 'styles.xml'));
  assert.throws(
    () => planCapacitorShellStarter(options),
    /manifest resource @style\/AppTheme is missing/u,
  );
  renameSync(path.join(nightValues, 'styles.xml'), androidStyles);
  writeFileSync(androidStyles, '<resources><!-- <style name="AppTheme" /> --></resources>');
  assert.throws(
    () => planCapacitorShellStarter(options),
    /manifest resource @style\/AppTheme is missing/u,
  );
  writeFileSync(androidStyles, '<resources><style name="AppTheme" /></resources>');
  const mainStrings = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/values/strings.xml',
  );
  const alternateStrings = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/res/values/app.xml',
  );
  writeFileSync(mainStrings, '<resources/>');
  writeFileSync(
    alternateStrings,
    '<resources><string name="app_name">Puzzle Game</string></resources>',
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(
    alternateStrings,
    '<resources><item type="string" name="app_name">Puzzle Game</item></resources>',
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  unlinkSync(alternateStrings);
  writeFileSync(mainStrings, '<resources><string name="app_name">Puzzle Game</string></resources>');
  const iosInfo = path.join(root, 'apps/mobile-capacitor/ios/App/App/Info.plist');
  writeFileSync(
    iosInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Other Game</string></dict></plist>',
  );
  assert.throws(() => planCapacitorShellStarter(options), /ios project display name differs/u);
  writeFileSync(
    iosInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
  );
  const iosReleaseInfo = path.join(root, 'apps/mobile-capacitor/ios/App/App/Info-Release.plist');
  writeFileSync(
    iosReleaseInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Other Game</string></dict></plist>',
  );
  const releaseProject = iosProjectWithAppId('dev.example.puzzle').replace(
    'INFOPLIST_FILE = App/Info.plist;',
    'INFOPLIST_FILE = App/Info-Release.plist;',
  );
  writeFileSync(iosProjectFile, releaseProject);
  assert.throws(() => planCapacitorShellStarter(options), /ios project display name differs/u);
  writeFileSync(
    iosReleaseInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(
    iosReleaseInfo,
    '<plist><dict><!-- <key>CFBundleDisplayName</key><string>Puzzle Game</string> --></dict></plist>',
  );
  assert.throws(() => planCapacitorShellStarter(options), /ios project display name differs/u);
  writeFileSync(
    iosReleaseInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
  );
  writeFileSync(
    iosProjectFile,
    releaseProject.replace(
      'INFOPLIST_FILE = App/Info-Release.plist;',
      'INFOPLIST_FILE = "$(CONFIGURATION)/Info.plist";',
    ),
  );
  assert.throws(
    () => planCapacitorShellStarter(options),
    /Release Info.plist cannot be read safely/u,
  );
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  unlinkSync(iosReleaseInfo);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.other.game'));
  assert.throws(() => planCapacitorShellStarter(options), /ios project app ID differs/u);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  writeFileSync(
    iosProjectFile,
    iosProjectWithAppId('dev.example.puzzle').replace(
      'PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle;',
      'PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle.debug;',
    ),
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  const inheritedIosProject = iosProjectWithAppId('dev.example.puzzle').replace(
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle;',
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
  );
  writeFileSync(iosProjectFile, inheritedIosProject);
  assert.throws(() => planCapacitorShellStarter(options), /no project configuration/u);
  const projectReleaseSettings = [
    'FFFFFFFF /* Project */ = { isa = PBXProject; buildConfigurationList = 99999999; };',
    '99999999 /* Project configurations */ = { isa = XCConfigurationList;',
    '  buildConfigurations = (88888888 /* Release */,); };',
    '88888888 /* Release */ = { isa = XCBuildConfiguration;',
    '  buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle;',
    '    INFOPLIST_FILE = App/Info.plist; }; };',
  ].join('\n');
  writeFileSync(iosProjectFile, `${inheritedIosProject}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const inheritedInfo = inheritedIosProject.replace(
    'INFOPLIST_FILE = App/Info.plist;',
    'INFOPLIST_FILE = "$(inherited)";',
  );
  writeFileSync(iosProjectFile, `${inheritedInfo}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, `${inheritedInfo.replace(
    'INFOPLIST_FILE = "$(inherited)";',
    '',
  )}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const omittedIosId = inheritedIosProject.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
    '',
  );
  writeFileSync(iosProjectFile, `${omittedIosId}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, `${omittedIosId.replace(
    'INFOPLIST_FILE = App/Info.plist;',
    '"PRODUCT_BUNDLE_IDENTIFIER" = dev.other.game; INFOPLIST_FILE = App/Info.plist;',
  )}\n${projectReleaseSettings}`);
  assert.throws(() => planCapacitorShellStarter(options), /ios project app ID differs/u);
  writeFileSync(iosProjectFile, `${omittedIosId.replace(
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration;',
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; baseConfigurationReference = 12345678;',
  )}\n${projectReleaseSettings}`);
  assert.throws(() => planCapacitorShellStarter(options), /Release xcconfig identity/u);
  writeFileSync(iosProjectFile, `${omittedIosId.replace(
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = {',
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = dev.other.game;',
  )}\n${projectReleaseSettings}`);
  assert.throws(() => planCapacitorShellStarter(options), /conditional Release bundle ID/u);
  writeFileSync(iosProjectFile, `${omittedIosId.replace(
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = {',
    'DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*][arch=arm64]" = dev.other.game;',
  )}\n${projectReleaseSettings}`);
  assert.throws(() => planCapacitorShellStarter(options), /conditional Release bundle ID/u);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle').replace(
    'PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle;',
    '/* PRODUCT_BUNDLE_IDENTIFIER = dev.other.game; */ PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle;',
  ));
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(iosProjectFile, iosProjectWithAppId('dev.example.puzzle'));
  const spmPackage = path.join(root, 'apps/mobile-capacitor/ios/App/CapApp-SPM/Package.swift');
  renameSync(spmPackage, `${spmPackage}.saved`);
  const podfile = path.join(root, 'apps/mobile-capacitor/ios/App/Podfile');
  const workspaceFile = path.join(
    root,
    'apps/mobile-capacitor/ios/App/App.xcworkspace/contents.xcworkspacedata',
  );
  mkdirSync(path.dirname(workspaceFile), { recursive: true });
  writeFileSync(podfile, 'platform :ios, "15.0"');
  writeFileSync(workspaceFile, '<Workspace/>');
  assert.throws(() => planCapacitorShellStarter(options), /SPM files are required/u);
  rmSync(podfile);
  rmSync(workspaceFile);
  renameSync(`${spmPackage}.saved`, spmPackage);
  const androidProjectFile = path.join(root, 'apps/mobile-capacitor/android/app/build.gradle');
  writeFileSync(androidProjectFile, [
    'defaultConfig { applicationId nativeId }',
    '// applicationId "dev.example.puzzle"',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, 'applicationId "dev.example.puzzle"');
  writeFileSync(androidProjectFile, 'applicationId "dev.example.puzzle" + ".beta"');
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'android.defaultConfig.applicationId = dynamicAppId',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, 'applicationId "dev.example.puzzle"');
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'productFlavors { demo {} }',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /product flavors are unsupported/u);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'buildTypes { debug { applicationIdSuffix ".debug" } }',
  ].join('\n'));
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'buildTypes { release { applicationIdSuffix ".release" } }',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'buildTypes { getByName("release").applicationIdSuffix = ".store" }',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'buildTypes { val release by getting { applicationIdSuffix = ".store" } }',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, [
    'applicationId "dev.example.puzzle"',
    'buildTypes { release { setApplicationIdSuffix(".store") } }',
  ].join('\n'));
  assert.throws(() => planCapacitorShellStarter(options), /android project app ID differs/u);
  writeFileSync(androidProjectFile, 'applicationId "dev.example.puzzle"');
  const kotlinGradle = `${androidProjectFile}.kts`;
  const groovySettings = path.join(root, 'apps/mobile-capacitor/android/settings.gradle');
  const kotlinSettings = `${groovySettings}.kts`;
  const kotlinRootBuild = `${androidRootBuild}.kts`;
  renameSync(androidProjectFile, kotlinGradle);
  renameSync(groovySettings, kotlinSettings);
  renameSync(androidRootBuild, kotlinRootBuild);
  writeFileSync(kotlinGradle, 'applicationId = "dev.example.puzzle"');
  writeFileSync(kotlinRootBuild, 'apply(from = "variables.gradle")');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  renameSync(kotlinGradle, androidProjectFile);
  renameSync(kotlinSettings, groovySettings);
  renameSync(kotlinRootBuild, androidRootBuild);
  writeFileSync(groovySettings, 'gradle.beforeProject { project -> project.version = 9 }');
  assert.throws(() => planCapacitorShellStarter(options), /settings Gradle callbacks/u);
  writeFileSync(groovySettings, "apply from: 'capacitor.settings.gradle'");
  writeFileSync(androidRootBuild, 'apply from: "variables.gradle"');
  writeFileSync(androidProjectFile, 'applicationId "dev.example.puzzle"');
  applyCapacitorShellStarter(withNativeProjects);
  assert.equal(
    readFileSync(path.join(root, 'apps/mobile-capacitor/ios/CustomViewController.swift'), 'utf8'),
    'custom',
  );

  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'dev.other.puzzle' }),
    /conflicts|differs/u,
  );
  const configFile = path.join(root, 'apps/mobile-capacitor/capacitor.config.ts');
  const originalConfig = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, originalConfig.replaceAll('\n', '\r\n'));
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(configFile, originalConfig);
  writeFileSync(configFile, originalConfig.replace('Puzzle Game', 'Other Game'));
  assert.throws(() => planCapacitorShellStarter(options), /display name differs/u);
  writeFileSync(configFile, originalConfig);
  writeFileSync(configFile, originalConfig.replace("webDir: 'www'", "webDir: 'other-www'"));
  assert.throws(() => planCapacitorShellStarter(options), /webDir differs/u);
  writeFileSync(configFile, originalConfig);
  const remoteConfig = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    "server: { url: 'https://stale.example', androidScheme: 'https' }",
  );
  writeFileSync(configFile, remoteConfig);
  assert.throws(() => planCapacitorShellStarter(options), /server.url is unsupported/u);
  const spreadServer = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    "server: { ...remote, androidScheme: 'https' }",
  );
  writeFileSync(configFile, spreadServer);
  assert.throws(() => planCapacitorShellStarter(options), /dynamic properties/u);
  const getterServer = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    "server: { get url() { return 'https://stale.example'; } }",
  );
  writeFileSync(configFile, getterServer);
  assert.throws(() => planCapacitorShellStarter(options), /dynamic properties/u);
  const escapedServer = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    "s\\u0065rver: { url: 'https://stale.example' }",
  );
  writeFileSync(configFile, escapedServer);
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  const escapedQuotedServer = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    '"ser\\u0076er": { url: "https://stale.example" }',
  );
  writeFileSync(configFile, escapedQuotedServer);
  assert.throws(() => planCapacitorShellStarter(options), /quoted property key is ambiguous/u);
  const topLevelGetter = originalConfig.replace(
    "server: { androidScheme: 'https' }",
    "get server() { return { url: 'https://stale.example' }; }",
  );
  writeFileSync(configFile, topLevelGetter);
  assert.throws(() => planCapacitorShellStarter(options), /server field is dynamic/u);
  writeFileSync(configFile, originalConfig);
  writeFileSync(
    configFile,
    originalConfig.replace('  appId:', '  // appId: "dev.other.game",\n  appId:'),
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(
    configFile,
    originalConfig.replace(
      '  server:',
      '  plugins: { FacebookLogin: { appId: "social-provider", scopes: ["profile"] } },\n  server:',
    ),
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const nestedConfigKey = originalConfig.replace(
    '  server:',
    '  plugins: { SomePlugin: { config: { mode: "release" } } },\n  server:',
  );
  writeFileSync(configFile, nestedConfigKey);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(
    configFile,
    originalConfig.replace('  server:', '  includePlugins: ["@capacitor/app"],\n  server:'),
  );
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(
    configFile,
    originalConfig.replace('  server:', '  ["appId"]: "dev.other.game",\n  server:'),
  );
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  writeFileSync(configFile, originalConfig.replace('  appName:', '  ...overrides,\n  appName:'));
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  writeFileSync(configFile, originalConfig.replace('  appName:', '  appName,\n  appName:'));
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  writeFileSync(configFile, originalConfig
    .replace('const config: CapacitorConfig = {', 'const config = Object.assign({')
    .replace('};\n\nexport default config;', '}, overrides);\n\nexport default config;'));
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  writeFileSync(configFile, originalConfig.replace('  webDir:', '  webDir: "other",\n  webDir:'));
  assert.throws(() => planCapacitorShellStarter(options), /ambiguous dynamic syntax/u);
  writeFileSync(configFile, originalConfig);
  const quotedName = 'King\'s "Quest" & \\ Game';
  const xmlQuotedName = quotedName.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;');
  const androidQuotedName = xmlQuotedName.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const quotedConfig = originalConfig.replace(
    JSON.stringify(options.displayName),
    JSON.stringify(quotedName),
  );
  writeFileSync(configFile, quotedConfig);
  writeFileSync(
    androidStrings,
    `<resources><string name="app_name">${androidQuotedName}</string></resources>`,
  );
  writeFileSync(
    iosInfo,
    `<plist><dict><key>CFBundleDisplayName</key><string>${xmlQuotedName}</string></dict></plist>`,
  );
  writeFileSync(smokeInfo, originalSmoke.replace('Puzzle Game', xmlQuotedName));
  const quotedTargets = readJson('mpgd.targets.json');
  const quotedTargetMap = quotedTargets.targets as Record<string, Record<string, unknown>>;
  for (const target of Object.values(quotedTargetMap)) {
    const metadata = target.metadata as Record<string, unknown>;
    metadata.displayName = quotedName;
  }
  writeJson('mpgd.targets.json', quotedTargets);
  const manifestFile = path.join(root, 'apps/mobile-capacitor/mpgd.native-shell.json');
  const originalManifest = readFileSync(manifestFile, 'utf8');
  const quotedManifest = JSON.parse(originalManifest) as Record<string, unknown>;
  quotedManifest.displayName = quotedName;
  writeJson('apps/mobile-capacitor/mpgd.native-shell.json', quotedManifest);
  assert.deepEqual(
    planCapacitorShellStarter({ ...options, displayName: quotedName }).changedFiles,
    [],
  );
  const literalManifest = completeAndroidManifest.replace(
    'android:label="@string/app_name"',
    `android:label="${xmlQuotedName}"`,
  );
  writeFileSync(androidManifest, literalManifest);
  assert.deepEqual(
    planCapacitorShellStarter({ ...options, displayName: quotedName }).changedFiles,
    [],
  );
  writeFileSync(androidManifest, completeAndroidManifest);
  writeFileSync(manifestFile, originalManifest);
  writeJson('apps/mobile-capacitor/mpgd.native-shell.json', {
    ...(JSON.parse(originalManifest) as Record<string, unknown>),
    schemaVersion: 2,
    futureField: 'preserve-me',
  });
  assert.throws(
    () => planCapacitorShellStarter({ ...options, displayName: quotedName }),
    /manifest schema is unsupported/u,
  );
  writeFileSync(manifestFile, originalManifest);
  writeFileSync(
    androidStrings,
    '<resources><string name="app_name">Puzzle Game</string></resources>',
  );
  writeFileSync(
    iosInfo,
    '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
  );
  writeFileSync(smokeInfo, originalSmoke);
  for (const target of Object.values(quotedTargetMap)) {
    const metadata = target.metadata as Record<string, unknown>;
    metadata.displayName = options.displayName;
  }
  writeJson('mpgd.targets.json', quotedTargets);
  writeFileSync(configFile, originalConfig);
  const customShellTargets = readJson('mpgd.targets.json');
  const customShellTargetMap = customShellTargets.targets as Record<string, Record<string, unknown>>;
  assert.ok(customShellTargetMap.android);
  customShellTargetMap.android.shellApp = '${MPGD_KIT_PATH}/apps/company-shell';
  writeJson('mpgd.targets.json', customShellTargets);
  assert.throws(() => planCapacitorShellStarter(options), /another shell/u);
  customShellTargetMap.android.shellApp = 'apps/mobile-capacitor';
  writeJson('mpgd.targets.json', customShellTargets);
  const renamedTargets = readJson('mpgd.targets.json');
  const renamedMap = renamedTargets.targets as Record<string, Record<string, unknown>>;
  assert.ok(renamedMap.android && renamedMap.ios);
  renamedMap['google-play'] = renamedMap.android;
  renamedMap['app-store'] = renamedMap.ios;
  delete renamedMap.android;
  delete renamedMap.ios;
  writeJson('mpgd.targets.json', renamedTargets);
  assert.throws(() => planCapacitorShellStarter(options), /canonical android target name/u);
  renamedMap.android = renamedMap['google-play'] ?? {};
  renamedMap.ios = renamedMap['app-store'] ?? {};
  delete renamedMap['google-play'];
  delete renamedMap['app-store'];
  writeJson('mpgd.targets.json', renamedTargets);
  assert.throws(
    () => planCapacitorShellStarter({ ...options, backendUrl: 'http://api.example.com' }),
    /HTTPS/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, backendUrl: 'https://localhost' }),
    /public HTTPS hostname/u,
  );
  const expandedBackend = 'https://api.example.com/$API_VERSION';
  const expandedBackendInput = { ...options, backendUrl: expandedBackend };
  assert.throws(() => planCapacitorShellStarter(expandedBackendInput), /dotenv expansion/u);
  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'dev.example.my_game' }),
    /app ID/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'io.mygame' }),
    /conflicts|differs/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, iconSource: '../outside.svg' }),
    /ENOENT|game-owned/u,
  );
  const targetsWithConflictingName = readJson('mpgd.targets.json');
  const androidTarget = (targetsWithConflictingName.targets as Record<string, Record<string, unknown>>).android;
  assert.ok(androidTarget);
  (androidTarget.metadata as Record<string, unknown>).displayName = 'Other Game';
  writeJson('mpgd.targets.json', targetsWithConflictingName);
  assert.throws(() => planCapacitorShellStarter(options), /display name conflicts/u);
  (androidTarget.metadata as Record<string, unknown>).displayName = options.displayName;
  writeJson('mpgd.targets.json', targetsWithConflictingName);
  const noArtifactTargets = readJson('mpgd.targets.json');
  const noArtifactMap = noArtifactTargets.targets as Record<string, Record<string, unknown>>;
  assert.ok(noArtifactMap.android && noArtifactMap.ios);
  delete noArtifactMap.android.artifact;
  delete noArtifactMap.ios.artifact;
  writeJson('mpgd.targets.json', noArtifactTargets);
  const defaultArtifactPlan = planCapacitorShellStarter(options);
  assert.ok(defaultArtifactPlan.changedFiles.includes('mpgd.targets.json'));
  const artifactFile = defaultArtifactPlan.files.find((file) => file.path === 'mpgd.targets.json');
  assert.ok(artifactFile);
  const completedTargets = JSON.parse(artifactFile.content) as {
    targets: { android: { artifact: string }; ios: { artifact: string } };
  };
  assert.equal(completedTargets.targets.android.artifact, 'aab');
  assert.equal(completedTargets.targets.ios.artifact, 'ipa');
  applyCapacitorShellStarter(defaultArtifactPlan);
  const wrongArtifactTargets = readJson('mpgd.targets.json');
  const wrongArtifactMap = wrongArtifactTargets.targets as Record<string, Record<string, unknown>>;
  assert.ok(wrongArtifactMap.android && wrongArtifactMap.ios);
  wrongArtifactMap.android.artifact = 'ipa';
  writeJson('mpgd.targets.json', wrongArtifactTargets);
  assert.throws(() => planCapacitorShellStarter(options), /android.artifact must be aab/u);
  wrongArtifactMap.android.artifact = 'aab';
  wrongArtifactMap.ios.artifact = 'aab';
  writeJson('mpgd.targets.json', wrongArtifactTargets);
  assert.throws(() => planCapacitorShellStarter(options), /ios.artifact must be ipa/u);
  wrongArtifactMap.ios.artifact = 'ipa';
  writeJson('mpgd.targets.json', wrongArtifactTargets);

  const envFile = path.join(root, '.env.production');
  const originalEnv = readFileSync(envFile, 'utf8');
  const originalEnvMode = statSync(envFile).mode & 0o777;
  writeFileSync(envFile, 'GAME_PRIVATE_VALUE=secret\n');
  chmodSync(envFile, 0o600);
  applyCapacitorShellStarter(planCapacitorShellStarter(options));
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.match(readFileSync(envFile, 'utf8'), /GAME_PRIVATE_VALUE=secret/u);
  writeFileSync(envFile, 'VITE_MPGD_GAME_SERVICES_URL="https://api.example.com/"\r\n');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(envFile, 'VITE_MPGD_GAME_SERVICES_URL=https://api.example.com # production\n');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(envFile, 'VITE_MPGD_GAME_SERVICES_URL="https://api.example.com" # production\n');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(envFile, [
    'VITE_MPGD_GAME_SERVICES_URL=https://api.example.com',
    'VITE_MPGD_GAME_SERVICES_URL=https://other.example.com',
  ].join('\n'));
  assert.throws(
    () => planCapacitorShellStarter(options),
    /Duplicate production Game Services URLs/u,
  );
  writeFileSync(envFile, originalEnv);
  chmodSync(envFile, originalEnvMode);
  const backupFile = path.join(root, '.env.production.saved');
  renameSync(envFile, backupFile);
  symlinkSync(path.join(root, 'missing.env'), envFile);
  assert.throws(() => planCapacitorShellStarter(options), /symbolic link/u);
  const previousManifest = readFileSync(manifestFile, 'utf8');
  const noBackendManifest = JSON.parse(previousManifest) as Record<string, unknown>;
  delete noBackendManifest.backendUrl;
  writeFileSync(manifestFile, `${JSON.stringify(noBackendManifest, null, 2)}\n`);
  assert.deepEqual(planCapacitorShellStarter({
    gameRoot: root,
    appId: options.appId,
    displayName: options.displayName,
  }).changedFiles, []);
  writeFileSync(manifestFile, previousManifest);
  unlinkSync(envFile);
  renameSync(backupFile, envFile);

  const adapterFile = path.join(root, 'node_modules/@mpgd/adapter-capacitor/package.json');
  renameSync(adapterFile, `${adapterFile}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /Install game dependencies/u);
  renameSync(`${adapterFile}.saved`, adapterFile);

  writeFileSync(path.join(root, 'public/icon2.svg'), '<svg/>');
  const beforeRollbackTargets = readFileSync(path.join(root, 'mpgd.targets.json'), 'utf8');
  const beforeRollbackManifest = readFileSync(manifestFile, 'utf8');
  const rollbackPlan = planCapacitorShellStarter({
    ...options,
    iconSource: 'public/icon2.svg',
    providerIds: ['identity', 'new-provider'],
  });
  assert.ok(rollbackPlan.changedFiles.length > 1);
  let installs = 0;
  assert.throws(
    () =>
      applyCapacitorShellStarter(rollbackPlan, (temporary, destination) => {
        installs += 1;
        if (installs === 2) {
          throw new Error('simulated later rename failure');
        }
        renameSync(temporary, destination);
      }),
    /simulated later rename failure/u,
  );
  assert.equal(readFileSync(path.join(root, 'mpgd.targets.json'), 'utf8'), beforeRollbackTargets);
  assert.equal(readFileSync(manifestFile, 'utf8'), beforeRollbackManifest);

  console.info('Game-owned Capacitor shell planning and preservation passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

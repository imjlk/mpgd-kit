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
  materializeCapacitorShellStarter,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-shell-'));

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
    `DDDDDDDD /* Release */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${appId}; }; };`,
    'EEEEEEEE /* NotificationService */ = { isa = PBXNativeTarget; name = NotificationService;',
    '  buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle.NotificationService; }; };',
    '/* SceneDelegate.swift in Sources */',
    '/* Main.storyboard in Resources */',
    '/* LaunchScreen.storyboard in Resources */',
    '/* Assets.xcassets in Resources */',
  ].join('\n');
}

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

  const dryRun = planCapacitorShellStarter(options);
  assert.ok(dryRun.changedFiles.includes('mpgd.targets.json'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/capacitor.config.ts'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/www/index.html'));
  assert.equal(existsSync(path.join(root, 'apps/mobile-capacitor')), false);
  applyCapacitorShellStarter(dryRun);

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

  const repeat = planCapacitorShellStarter(options);
  assert.deepEqual(repeat.changedFiles, []);
  assert.deepEqual(repeat.nativePlatformsToAdd, ['android', 'ios']);
  const omittedSelections = planCapacitorShellStarter({
    gameRoot: root,
    appId: options.appId,
    displayName: options.displayName,
  });
  assert.deepEqual(omittedSelections.changedFiles, []);
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
            'android/app/src/main/AndroidManifest.xml':
              '<manifest><application android:label="@string/app_name" /></manifest>',
            'ios/App/App/Info.plist':
              '<plist><dict><key>CFBundleDisplayName</key><string>Puzzle Game</string></dict></plist>',
          };
          writeFileSync(requiredFile, contents[relative] ?? 'generated-native-project');
        }
        if (platform === 'android') {
          writeFileSync(file, [
            'applicationId "dev.example.puzzle"',
            "apply from: 'capacitor.build.gradle'",
          ].join('\n'));
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
  renameSync(iosProjectFile, `${iosProjectFile}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /ios project is incomplete/u);
  renameSync(`${iosProjectFile}.saved`, iosProjectFile);
  const sceneDelegate = path.join(root, 'apps/mobile-capacitor/ios/App/App/SceneDelegate.swift');
  renameSync(sceneDelegate, `${sceneDelegate}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /referenced app file/u);
  renameSync(`${sceneDelegate}.saved`, sceneDelegate);
  const androidWrapper = path.join(root, 'apps/mobile-capacitor/android/gradlew');
  renameSync(androidWrapper, `${androidWrapper}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /android project is incomplete/u);
  renameSync(`${androidWrapper}.saved`, androidWrapper);
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
  writeFileSync(androidRootBuild, 'apply from: "variables.gradle"');
  const capacitorGradle = path.join(
    root,
    'apps/mobile-capacitor/android/app/capacitor.build.gradle',
  );
  renameSync(capacitorGradle, `${capacitorGradle}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /applied Gradle script/u);
  renameSync(`${capacitorGradle}.saved`, capacitorGradle);
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
  const androidManifest = path.join(
    root,
    'apps/mobile-capacitor/android/app/src/main/AndroidManifest.xml',
  );
  writeFileSync(androidManifest, '<manifest><application android:label="Other Game" /></manifest>');
  assert.throws(() => planCapacitorShellStarter(options), /application label differs/u);
  writeFileSync(androidManifest, [
    '<manifest><application android:label="@string/app_name">',
    '<activity android:label="Other Game"><intent-filter>',
    '<action android:name="android.intent.action.MAIN"/>',
    '<category android:name="android.intent.category.LAUNCHER"/>',
    '</intent-filter></activity></application></manifest>',
  ].join(''));
  assert.throws(() => planCapacitorShellStarter(options), /launcher label differs/u);
  writeFileSync(
    androidManifest,
    '<manifest><application android:label="@string/app_name" /></manifest>',
  );
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
    '  buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = dev.example.puzzle; }; };',
  ].join('\n');
  writeFileSync(iosProjectFile, `${inheritedIosProject}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  const omittedIosId = inheritedIosProject.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
    '',
  );
  writeFileSync(iosProjectFile, `${omittedIosId}\n${projectReleaseSettings}`);
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
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
  const quotedName = 'King\'s "Quest" \\ Game';
  const quotedConfig = originalConfig.replace(
    JSON.stringify(options.displayName),
    JSON.stringify(quotedName),
  );
  writeFileSync(configFile, quotedConfig);
  writeFileSync(
    androidStrings,
    `<resources><string name="app_name">${quotedName}</string></resources>`,
  );
  writeFileSync(
    iosInfo,
    `<plist><dict><key>CFBundleDisplayName</key><string>${quotedName}</string></dict></plist>`,
  );
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

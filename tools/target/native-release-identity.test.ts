import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  assertNativeReleaseIdentity,
  runNativeSyncWithIdentityCheck,
} from './native-release-identity';

const shellRoot = mkdtempSync(join(os.tmpdir(), 'mpgd-native-release-'));

try {
  writeShellFiles(shellRoot);

  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_VERSION_CODE: '42',
        MPGD_TARGET_VERSION_NAME: '1.4.0',
      },
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: false,
      shellApp: shellRoot,
    }),
  );
  const groovy = join(shellRoot, 'android/app/build.gradle');
  const kotlin = `${groovy}.kts`;
  renameSync(groovy, kotlin);
  writeFileSync(kotlin, [
    'defaultConfig {',
    '  applicationId = "dev.example.game"',
    '  versionCode = 42',
    '  versionName = "1.4.0"',
    '}',
  ].join('\n'));
  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_VERSION_CODE: '42',
        MPGD_TARGET_VERSION_NAME: '1.4.0',
      },
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: false,
      shellApp: shellRoot,
    }),
  );
  writeFileSync(kotlin, [
    'defaultConfig { applicationId = "dev.example.game"; versionCode = 42;',
    '  versionName = "1.4.0" }',
    'buildTypes { getByName("release").applicationIdSuffix = ".store" }',
  ].join('\n'));
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support applicationIdSuffix/u,
  );
  writeFileSync(kotlin, [
    'defaultConfig { applicationId = "dev.example.game"; versionCode = 42;',
    '  versionName = "1.4.0" }',
    'buildTypes { val release by getting { applicationIdSuffix = ".store" } }',
  ].join('\n'));
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support applicationIdSuffix/u,
  );
  renameSync(kotlin, groovy);
  writeShellFiles(shellRoot);
  const appliedIdentity = join(shellRoot, 'android/app/identity.gradle');
  writeFileSync(appliedIdentity, 'applicationId "dev.other.game"');
  writeFileSync(groovy, `${readFileSync(groovy, 'utf8')}\napply from: 'identity.gradle'\n`);
  const appliedIdentityInput = {
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_VERSION_CODE: '42',
      MPGD_TARGET_VERSION_NAME: '1.4.0',
    },
    metadata: { packageId: 'dev.example.game' },
    platform: 'android' as const,
    required: false,
    shellApp: shellRoot,
  };
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /identity override in applied Gradle script/u,
  );
  for (const mutation of [
    'applicationId rootProject.ext.gameAppId',
    'applicationId(project.findProperty("id"))',
    'setApplicationId("dev.other.game")',
    "android.defaultConfig['versionName'] = '9.9.9'",
    'versionCode(computeCode())',
    "android.defaultConfig.setProperty('versionCode', 99)",
    "def key = 'versionName'; android.defaultConfig.setProperty(key, '9.9.9')",
  ]) {
    writeFileSync(appliedIdentity, mutation);
    assert.throws(
      () => assertNativeReleaseIdentity(appliedIdentityInput),
      /identity override in applied Gradle script/u,
    );
  }
  writeFileSync(appliedIdentity, 'versionCode 99');
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /identity override in applied Gradle script/u,
  );
  const readOnlyGradle = 'println(android.defaultConfig.versionName)\nprintln("versionName")';
  writeFileSync(appliedIdentity, readOnlyGradle);
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeFileSync(appliedIdentity, 'println("apply from: \'legacy.gradle\'")');
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeFileSync(appliedIdentity, 'android { productFlavors { demo {} } }');
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /product flavors/u);
  rmSync(appliedIdentity);
  writeShellFiles(shellRoot);
  const productionInput = {
    ...appliedIdentityInput,
    metadata: { packageId: 'dev.example.game', displayName: 'Puzzle Game' },
    required: true,
  };
  assert.doesNotThrow(() => assertNativeReleaseIdentity(productionInput));
  const appNameFile = join(shellRoot, 'android/app/src/main/res/values/strings.xml');
  let androidSynced = false;
  const mismatchedAppName = '<resources><string name="app_name">Other Game</string></resources>';
  const mutateNameOnSync = (): void => {
    androidSynced = true;
    writeFileSync(appNameFile, mismatchedAppName);
  };
  const recheckAfterSync = (): void => runNativeSyncWithIdentityCheck(
    productionInput,
    mutateNameOnSync,
  );
  assert.throws(recheckAfterSync, /application label differs/u);
  assert.equal(androidSynced, true);
  writeShellFiles(shellRoot);
  writeFileSync(appNameFile, '<resources><string name="app_name">Other Game</string></resources>');
  assert.throws(() => assertNativeReleaseIdentity(productionInput), /application label differs/u);
  writeShellFiles(shellRoot);
  const qualifiedValues = join(shellRoot, 'android/app/src/main/res/values-en/strings.xml');
  mkdirSync(join(shellRoot, 'android/app/src/main/res/values-en'), { recursive: true });
  writeFileSync(qualifiedValues, mismatchedAppName);
  assert.throws(() => assertNativeReleaseIdentity(productionInput), /configuration-qualified/u);
  rmSync(qualifiedValues);
  writeShellFiles(shellRoot);
  const launcherManifest = join(shellRoot, 'android/app/src/main/AndroidManifest.xml');
  const validLauncherManifest = readFileSync(launcherManifest, 'utf8');
  writeFileSync(
    launcherManifest,
    validLauncherManifest.replace('android:exported="true"', 'android:exported="false"'),
  );
  assert.throws(() => assertNativeReleaseIdentity(productionInput), /android:exported/u);
  writeShellFiles(shellRoot);
  const launcherSource = join(
    shellRoot,
    'android/app/src/main/java/dev/example/game/MainActivity.java',
  );
  writeFileSync(launcherSource, 'package dev.example.game; public class MainActivity {}');
  assert.throws(() => assertNativeReleaseIdentity(productionInput), /not an Android Activity/u);
  writeShellFiles(shellRoot);
  const releaseManifest = join(shellRoot, 'android/app/src/release/AndroidManifest.xml');
  mkdirSync(join(shellRoot, 'android/app/src/release'), { recursive: true });
  writeFileSync(releaseManifest, [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '<application android:label="Other Game"/></manifest>',
  ].join(''));
  assert.throws(
    () => assertNativeReleaseIdentity(productionInput),
    /Release application label differs/u,
  );
  rmSync(releaseManifest);
  writeShellFiles(shellRoot);
  const flavoredGradle = `${readFileSync(groovy, 'utf8')}\nproductFlavors { demo {} }\n`;
  writeFileSync(groovy, flavoredGradle);
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /product flavors/u);
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    "android.defaultConfig['versionName'] = '9.9.9'",
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /bracket identity writes/u,
  );
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'buildTypes { release { resValue "string", "app_name", "Other Game" } }',
  ].join('\n'));
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /generated app_name/u);
  writeShellFiles(shellRoot);
  for (const suffixSetter of [
    'setApplicationIdSuffix(".store")',
    'setVersionNameSuffix("-store")',
  ]) {
    writeFileSync(groovy, [
      readFileSync(groovy, 'utf8'),
      `buildTypes { release { ${suffixSetter} } }`,
    ].join('\n'));
    assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /Suffix/u);
    writeShellFiles(shellRoot);
  }
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'buildTypes["release"].applicationIdSuffix = ".store"',
  ].join('\n'));
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /applicationIdSuffix/u);
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'buildTypes["release"].apply { applicationIdSuffix = ".store" }',
  ].join('\n'));
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /applicationIdSuffix/u);
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'buildTypes.named("release").configure { applicationIdSuffix = ".store" }',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /applicationIdSuffix/u,
    'configure release suffix must fail',
  );
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'sourceSets.release.res.srcDirs = ["src/store/res"]',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /custom resource sourceSets/u,
    'release resource sourceSets must fail',
  );
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'sourceSets.main.manifest.srcFile("src/store/AndroidManifest.xml")',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /custom manifest sourceSets/u,
  );
  writeShellFiles(shellRoot);
  const androidRootGradle = join(shellRoot, 'android/build.gradle');
  writeFileSync(androidRootGradle, 'apply(mapOf("from" to "missing.gradle"))');
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /applied Gradle script/u,
    'map-based Gradle apply must fail',
  );
  writeShellFiles(shellRoot);
  const androidSettingsGradle = join(shellRoot, 'android/settings.gradle');
  writeFileSync(androidSettingsGradle, [
    'include ":app"',
    'findProject(":app")?.projectDir = file("elsewhere")',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /without remapping/u,
    'findProject remap must fail',
  );
  writeShellFiles(shellRoot);
  writeFileSync(groovy, `${readFileSync(groovy, 'utf8')}\nprintln("productFlavors")\n`);
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'buildTypes { release { println("applicationIdSuffix") } }',
    'println("setProperty(\'versionCode\', 99)")',
  ].join('\n'));
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeShellFiles(shellRoot);
  writeFileSync(
    groovy,
    readFileSync(groovy, 'utf8').replace(
      'applicationId "dev.example.game"',
      'applicationId "dev.example.game" + ".beta"',
    ),
  );
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /cannot read every/u);
  writeShellFiles(shellRoot);
  const originalGradle = readFileSync(groovy, 'utf8');
  const incrementedCode = originalGradle.replace('versionCode 42', 'versionCode 42 + 1');
  writeFileSync(groovy, incrementedCode);
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /cannot read every/u);
  writeShellFiles(shellRoot);
  const androidRootBuild = join(shellRoot, 'android/build.gradle');
  const rootCallback = 'project(":app") { afterEvaluate { android.defaultConfig.versionName = "9.0.0" } }';
  writeFileSync(androidRootBuild, rootCallback);
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /root Gradle app callbacks/u,
  );
  writeFileSync(androidRootBuild, 'println("afterEvaluate android")');
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeShellFiles(shellRoot);
  const androidSettings = join(shellRoot, 'android/settings.gradle');
  writeFileSync(androidSettings, [
    'include ":app"',
    'gradle.beforeProject { project ->',
    '  if (project.path == ":app") project.android.defaultConfig.versionName = "9.0.0"',
    '}',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /settings Gradle project callbacks/u,
  );
  writeShellFiles(shellRoot);
  writeFileSync(androidSettings, 'include ":other"\n');
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /include :app/u);
  writeShellFiles(shellRoot);
  writeFileSync(androidSettings, [
    'include(":app")',
    'project(":app").projectDir = file("elsewhere")',
  ].join('\n'));
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /without remapping/u);
  writeShellFiles(shellRoot);
  writeFileSync(androidSettings, 'include ":app"\napply { from "settings-extra.gradle" }');
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /applied Gradle script/u);
  writeShellFiles(shellRoot);
  const appliedSettings = join(shellRoot, 'android/settings-extra.gradle');
  writeFileSync(appliedSettings, 'project(":app").projectDir = file("elsewhere")');
  writeFileSync(androidSettings, 'include ":app"\napply from: "settings-extra.gradle"\n');
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /without remapping/u);
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'println(android.defaultConfig.versionName)',
    'println("versionCode")',
  ].join('\n'));
  assert.doesNotThrow(() => assertNativeReleaseIdentity(appliedIdentityInput));
  writeShellFiles(shellRoot);
  writeFileSync(groovy, [
    readFileSync(groovy, 'utf8'),
    'android.defaultConfig.versionName = releaseName',
  ].join('\n'));
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /cannot read every versionName assignment/u,
  );
  writeShellFiles(shellRoot);
  writeFileSync(groovy, `${readFileSync(groovy, 'utf8')}\nversionCode releaseCode\n`);
  assert.throws(
    () => assertNativeReleaseIdentity(appliedIdentityInput),
    /cannot read every versionCode assignment/u,
  );
  writeShellFiles(shellRoot);

  writeAndroidWithCommentedIdentity(shellRoot);
  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_VERSION_CODE: '42',
        MPGD_TARGET_VERSION_NAME: '1.4.0',
      },
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: false,
      shellApp: shellRoot,
    }),
  );
  writeShellFiles(shellRoot);

  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '43',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /Native release identity mismatch/u,
  );

  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_BUILD_NUMBER: '42',
        MPGD_TARGET_MARKETING_VERSION: '1.4.0',
      },
      metadata: { bundleId: 'dev.example.game' },
      platform: 'ios',
      required: false,
      shellApp: shellRoot,
    }),
  );

  writeIosInheritedReleaseSettings(shellRoot);
  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_BUILD_NUMBER: '42',
        MPGD_TARGET_MARKETING_VERSION: '1.4.0',
      },
      metadata: { bundleId: 'dev.example.game' },
      platform: 'ios',
      required: false,
      shellApp: shellRoot,
    }),
  );
  const iosProject = join(shellRoot, 'ios/App/App.xcodeproj/project.pbxproj');
  const inheritedIosSource = readFileSync(iosProject, 'utf8');
  const iosInput = {
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_BUILD_NUMBER: '42',
      MPGD_TARGET_MARKETING_VERSION: '1.4.0',
    },
    metadata: { bundleId: 'dev.example.game' },
    platform: 'ios' as const,
    required: false,
    shellApp: shellRoot,
  };
  const productionIosInput = {
    ...iosInput,
    metadata: { bundleId: 'dev.example.game', displayName: 'Puzzle Game' },
    required: true,
  };
  assert.doesNotThrow(() => assertNativeReleaseIdentity(productionIosInput));
  const compiledIosProject = readFileSync(iosProject, 'utf8');
  const scriptedIosProject = compiledIosProject.replace(
    'buildPhases = (00000009 /* Sources */);',
    'buildPhases = (00000009 /* Sources */, 00000011 /* Script */);',
  ) + '\n00000011 /* Script */ = { isa = PBXShellScriptBuildPhase; shellScript = "echo hi"; };';
  writeFileSync(iosProject, scriptedIosProject);
  assert.throws(
    () => assertNativeReleaseIdentity(productionIosInput),
    /shell script build phases/u,
  );
  writeFileSync(iosProject, compiledIosProject);
  const uncompiledIosProject = compiledIosProject.replace(
    'files = (00000008 /* SceneDelegate.swift in Sources */);',
    'files = ();',
  );
  writeFileSync(iosProject, uncompiledIosProject);
  assert.throws(
    () => assertNativeReleaseIdentity(productionIosInput),
    /scene delegate.*App Sources/u,
    'uncompiled SceneDelegate must fail release preflight',
  );
  writeFileSync(iosProject, compiledIosProject);
  const localizedNameFile = join(shellRoot, 'ios/App/App/en.lproj/InfoPlist.strings');
  mkdirSync(join(shellRoot, 'ios/App/App/en.lproj'), { recursive: true });
  writeFileSync(localizedNameFile, '"CFBundleDisplayName" = "Other Game";');
  assert.throws(
    () => assertNativeReleaseIdentity(productionIosInput),
    /localized InfoPlist.strings/u,
  );
  rmSync(localizedNameFile);
  const releaseIosPlist = join(shellRoot, 'ios/App/App/Info.plist');
  const originalReleaseIosPlist = readFileSync(releaseIosPlist, 'utf8');
  let iosSynced = false;
  assert.throws(() => runNativeSyncWithIdentityCheck(productionIosInput, () => {
    iosSynced = true;
    writeFileSync(releaseIosPlist, originalReleaseIosPlist.replace('Puzzle Game', 'Other Game'));
  }), /display name differs/u);
  assert.equal(iosSynced, true);
  writeFileSync(releaseIosPlist, originalReleaseIosPlist);
  writeFileSync(releaseIosPlist, originalReleaseIosPlist.replace('Puzzle Game', 'Other Game'));
  assert.throws(() => assertNativeReleaseIdentity(productionIosInput), /display name differs/u);
  writeFileSync(releaseIosPlist, originalReleaseIosPlist);
  const schemeDir = join(shellRoot, 'ios/App/App.xcodeproj/xcshareddata/xcschemes');
  const schemeFile = join(schemeDir, 'App.xcscheme');
  const originalScheme = readFileSync(schemeFile, 'utf8');
  const validBlueprint = 'BlueprintIdentifier="001"';
  const invalidScheme = originalScheme.replace(validBlueprint, 'BlueprintIdentifier="999"');
  writeFileSync(schemeFile, invalidScheme);
  assert.throws(
    () => assertNativeReleaseIdentity(productionIosInput),
    /archive scheme.*App target/u,
  );
  writeFileSync(schemeFile, originalScheme);
  const customProductName = inheritedIosSource.replace(
    'CURRENT_PROJECT_VERSION = "$(inherited)";',
    'CURRENT_PROJECT_VERSION = "$(inherited)"; PRODUCT_NAME = CustomGame;',
  );
  writeFileSync(iosProject, customProductName);
  assert.throws(() => assertNativeReleaseIdentity(iosInput), /PRODUCT_NAME must build App.app/u);
  const duplicatedBundleId = inheritedIosSource.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
    'PRODUCT_BUNDLE_IDENTIFIER = dev.example.game; PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
  );
  writeFileSync(iosProject, duplicatedBundleId);
  assert.throws(
    () => assertNativeReleaseIdentity(iosInput),
    /ambiguous App Release PRODUCT_BUNDLE_IDENTIFIER/u,
  );
  writeFileSync(iosProject, inheritedIosSource);
  const iosPlist = join(shellRoot, 'ios/App/App/Info.plist');
  const originalPlist = readFileSync(iosPlist, 'utf8');
  const invalidPlistIdentities: readonly [string, string, string][] = [
    ['$(EXECUTABLE_NAME)', 'MissingExecutable', 'CFBundleExecutable'],
    ['$(PRODUCT_BUNDLE_IDENTIFIER)', 'dev.other.game', 'CFBundleIdentifier'],
    ['$(PRODUCT_NAME)', 'Other Game', 'CFBundleName'],
    ['<string>APPL</string>', '<string>FMWK</string>', 'CFBundlePackageType'],
    ['$(MARKETING_VERSION)', '9.0.0', 'CFBundleShortVersionString'],
    ['$(CURRENT_PROJECT_VERSION)', '99', 'CFBundleVersion'],
  ];
  for (const [macro, literal, key] of invalidPlistIdentities) {
    writeFileSync(iosPlist, originalPlist.replace(macro, literal));
    assert.throws(
      () => assertNativeReleaseIdentity(iosInput),
      new RegExp(`Release Info.plist ${key}`, 'u'),
    );
  }
  writeFileSync(iosPlist, originalPlist);
  for (const [key, invalid] of [
    ['PRODUCT_BUNDLE_IDENTIFIER', 'dev.other.game'],
    ['MARKETING_VERSION', '2.0.0'],
    ['CURRENT_PROJECT_VERSION', '99'],
  ]) {
    writeFileSync(
      iosProject,
      inheritedIosSource.replace(`${key} = "$(inherited)";`, `"${key}" = ${invalid};`),
    );
    assert.throws(() => assertNativeReleaseIdentity(iosInput), /Native release identity mismatch/u);
  }
  writeFileSync(iosProject, inheritedIosSource);
  writeFileSync(iosProject, inheritedIosSource.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
    '"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = dev.other.game;\n    PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
  ));
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_BUILD_NUMBER: '42',
          MPGD_TARGET_MARKETING_VERSION: '1.4.0',
        },
        metadata: { bundleId: 'dev.example.game' },
        platform: 'ios',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support conditional PRODUCT_BUNDLE_IDENTIFIER/u,
  );
  writeFileSync(iosProject, inheritedIosSource.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
    '"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*][arch=arm64]" = dev.other.game;\n    PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
  ));
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_BUILD_NUMBER: '42',
          MPGD_TARGET_MARKETING_VERSION: '1.4.0',
        },
        metadata: { bundleId: 'dev.example.game' },
        platform: 'ios',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support conditional PRODUCT_BUNDLE_IDENTIFIER/u,
  );
  const conditionalProjectSource = inheritedIosSource.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;',
    '"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = dev.other.game;\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;',
  );
  writeFileSync(iosProject, conditionalProjectSource);
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_BUILD_NUMBER: '42',
          MPGD_TARGET_MARKETING_VERSION: '1.4.0',
        },
        metadata: { bundleId: 'dev.example.game' },
        platform: 'ios',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support conditional PRODUCT_BUNDLE_IDENTIFIER/u,
  );
  writeFileSync(
    iosProject,
    conditionalProjectSource.replace(
      'PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";',
      'PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;',
    ),
  );
  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_BUILD_NUMBER: '42',
        MPGD_TARGET_MARKETING_VERSION: '1.4.0',
      },
      metadata: { bundleId: 'dev.example.game' },
      platform: 'ios',
      required: false,
      shellApp: shellRoot,
    }),
  );
  writeFileSync(iosProject, inheritedIosSource.replace(
    '003 /* Release */ = {\n  isa = XCBuildConfiguration;',
    '003 /* Release */ = {\n  isa = XCBuildConfiguration;\n  baseConfigurationReference = 99999999;',
  ));
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_BUILD_NUMBER: '42',
          MPGD_TARGET_MARKETING_VERSION: '1.4.0',
        },
        metadata: { bundleId: 'dev.example.game' },
        platform: 'ios',
        required: false,
        shellApp: shellRoot,
      }),
    /Release.*xcconfig/u,
  );
  writeShellFiles(shellRoot);
  const inlineIosSource = readFileSync(iosProject, 'utf8');
  for (const [key, value] of [
    ['MARKETING_VERSION', '2.0.0'],
    ['CURRENT_PROJECT_VERSION', '99'],
  ]) {
    for (const conditions of ['[sdk=iphoneos*]', '[sdk=iphoneos*][arch=arm64]']) {
      writeFileSync(iosProject, inlineIosSource.replace(
        `${key} = ${key === 'MARKETING_VERSION' ? '1.4.0' : '42'};`,
        `${key} = ${key === 'MARKETING_VERSION' ? '1.4.0' : '42'};\n    "${key}${conditions}" = ${value};`,
      ));
      assert.throws(
        () =>
          assertNativeReleaseIdentity({
            environment: {
              APP_VERSION: '1.4.0',
              MPGD_TARGET_BUILD_NUMBER: '42',
              MPGD_TARGET_MARKETING_VERSION: '1.4.0',
            },
            metadata: { bundleId: 'dev.example.game' },
            platform: 'ios',
            required: false,
            shellApp: shellRoot,
          }),
        new RegExp(`does not support conditional ${key}`, 'u'),
      );
    }
  }
  writeFileSync(iosProject, inlineIosSource);

  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {},
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: true,
        shellApp: shellRoot,
      }),
    /MPGD_TARGET_VERSION_CODE is required/u,
  );

  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        MPGD_TARGET_VERSION_CODE: '42',
        MPGD_TARGET_VERSION_NAME: '1.4.0',
      },
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: false,
      shellApp: shellRoot,
    }),
  );

  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '0.0.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: true,
        shellApp: shellRoot,
      }),
    /APP_VERSION must be a non-default final SemVer/u,
  );

  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.5.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /Native release version mismatch/u,
  );

  writeAndroidReleaseSuffix(shellRoot);
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support applicationIdSuffix or versionNameSuffix/u,
  );
  writeShellFiles(shellRoot);

  writeAndroidQualifiedReleaseSuffix(shellRoot);
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support applicationIdSuffix or versionNameSuffix/u,
  );
  writeShellFiles(shellRoot);

  writeAndroidNamedReleaseSuffix(shellRoot);
  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.4.0',
          MPGD_TARGET_VERSION_CODE: '42',
          MPGD_TARGET_VERSION_NAME: '1.4.0',
        },
        metadata: { packageId: 'dev.example.game' },
        platform: 'android',
        required: false,
        shellApp: shellRoot,
      }),
    /does not support applicationIdSuffix or versionNameSuffix/u,
  );
  writeShellFiles(shellRoot);

  writeAndroidSigningConfigSuffix(shellRoot);
  assert.doesNotThrow(() =>
    assertNativeReleaseIdentity({
      environment: {
        APP_VERSION: '1.4.0',
        MPGD_TARGET_VERSION_CODE: '42',
        MPGD_TARGET_VERSION_NAME: '1.4.0',
      },
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: false,
      shellApp: shellRoot,
    }),
  );
  writeShellFiles(shellRoot);

  assert.throws(
    () =>
      assertNativeReleaseIdentity({
        environment: {
          APP_VERSION: '1.5.0',
          MPGD_TARGET_BUILD_NUMBER: '42',
          MPGD_TARGET_MARKETING_VERSION: '1.4.0',
        },
        metadata: { bundleId: 'dev.example.game' },
        platform: 'ios',
        required: false,
        shellApp: shellRoot,
      }),
    /Native release version mismatch/u,
  );
} finally {
  rmSync(shellRoot, { force: true, recursive: true });
}

function writeShellFiles(root: string): void {
  const android = join(root, 'android/app/build.gradle');
  const androidRoot = join(root, 'android/build.gradle');
  const androidSettings = join(root, 'android/settings.gradle');
  const ios = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  const iosPlist = join(root, 'ios/App/App/Info.plist');
  mkdirSync(join(root, 'android/app'), { recursive: true });
  mkdirSync(join(root, 'android/app/src/main/res/values'), { recursive: true });
  mkdirSync(join(root, 'android/app/src/main/java/dev/example/game'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App.xcodeproj'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App.xcodeproj/xcshareddata/xcschemes'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App'), { recursive: true });
  writeFileSync(
    android,
    `defaultConfig {\n  applicationId "dev.example.game"\n  versionCode 42\n  versionName "1.4.0"\n}\n`,
  );
  writeFileSync(androidRoot, '// Standard root Gradle build.\n');
  writeFileSync(androidSettings, 'include ":app"\n');
  writeFileSync(
    join(root, 'android/app/src/main/AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.example.game"><application android:label="@string/app_name"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>',
  );
  writeFileSync(
    join(root, 'android/app/src/main/java/dev/example/game/MainActivity.java'),
    'package dev.example.game; import com.getcapacitor.BridgeActivity; public class MainActivity extends BridgeActivity {}',
  );
  writeFileSync(
    join(root, 'android/app/src/main/res/values/strings.xml'),
    '<resources><string name="app_name">Puzzle Game</string></resources>',
  );
  writeFileSync(iosPlist, [
    '<plist><dict>',
    '<key>CFBundleDisplayName</key><string>Puzzle Game</string>',
    '<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>',
    '<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>',
    '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
    '<key>UIApplicationSceneManifest</key><dict>',
    '<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>',
    '</dict>',
    '</dict></plist>',
  ].join(''));
  writeFileSync(join(root, 'ios/App/App/SceneDelegate.swift'), 'class SceneDelegate {}');
  writeFileSync(
    join(root, 'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'),
    '<Scheme><BuildAction><BuildActionEntries><BuildActionEntry buildForArchiving="YES"><BuildableReference BlueprintIdentifier="001" BlueprintName="App" BuildableName="App.app" ReferencedContainer="container:App.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><ArchiveAction buildConfiguration="Release"/></Scheme>',
  );
  writeFileSync(
    ios,
    `001 /* App */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 002 /* Build configuration list for PBXNativeTarget \"App\" */;\n  name = \"App\";\n};\n\n002 /* Build configuration list for PBXNativeTarget \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    003 /* Debug */,\n    004 /* Release */,\n  );\n};\n\n003 /* Debug */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.debug;\n    MARKETING_VERSION = 1.4.0-debug;\n    CURRENT_PROJECT_VERSION = 7;\n  };\n};\n\n004 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\n    MARKETING_VERSION = 1.4.0;\n    CURRENT_PROJECT_VERSION = 42;\n    INFOPLIST_FILE = App/Info.plist;\n  };\n};\n\n005 /* ShareExtension */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */;\n  name = ShareExtension;\n};\n\n006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.share;\n    MARKETING_VERSION = 9.9.9;\n    CURRENT_PROJECT_VERSION = 99;\n  };\n};\n`,
  );
  writeIosAppProductReference(root);
}

function writeIosInheritedReleaseSettings(root: string): void {
  writeFileSync(
    join(root, 'ios/App/App.xcodeproj/project.pbxproj'),
    `001 /* App */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 002 /* Build configuration list for PBXNativeTarget \"App\" */;\n  name = \"App\";\n};\n\n002 /* Build configuration list for PBXNativeTarget \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    003 /* Release */,\n  );\n};\n\n003 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = \"$(inherited)\";\n    MARKETING_VERSION = \"$(inherited)\";\n    CURRENT_PROJECT_VERSION = \"$(inherited)\";\n    INFOPLIST_FILE = App/Info.plist;\n  };\n};\n\n004 /* Project object */ = {\n  isa = PBXProject;\n  buildConfigurationList = 005 /* Build configuration list for PBXProject \"App\" */;\n};\n\n005 /* Build configuration list for PBXProject \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    006 /* Release */,\n  );\n};\n\n006 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\n    MARKETING_VERSION = 1.4.0;\n    CURRENT_PROJECT_VERSION = 42;\n  };\n};\n`,
  );
  writeIosAppProductReference(root);
}

function writeIosAppProductReference(root: string): void {
  const projectFile = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  const source = readFileSync(projectFile, 'utf8');
  const appTarget = [
    'name = "App";',
    'buildPhases = (00000009 /* Sources */);',
    'productReference = 007 /* App.app */;',
    'productType = "com.apple.product-type.application";',
  ].join('\n  ');
  const product = '007 /* App.app */ = { isa = PBXFileReference; explicitFileType = wrapper.application; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };';
  const compiledScene = [
    '00000008 /* SceneDelegate.swift in Sources */ = { isa = PBXBuildFile;',
    'fileRef = 00000010 /* SceneDelegate.swift */; };',
    '00000009 /* Sources */ = { isa = PBXSourcesBuildPhase;',
    'files = (00000008 /* SceneDelegate.swift in Sources */); };',
    '00000010 /* SceneDelegate.swift */ = { isa = PBXFileReference;',
    'path = SceneDelegate.swift; sourceTree = "<group>"; };',
  ].join('\n');
  const updated = `${source.replace('name = "App";', appTarget)}\n${product}\n${compiledScene}\n`;
  writeFileSync(projectFile, updated);
}

function writeAndroidReleaseSuffix(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `android {\n  defaultConfig {\n    applicationId \"dev.example.game\"\n    versionCode 42\n    versionName \"1.4.0\"\n  }\n  buildTypes {\n    getByName(\"release\") {\n      applicationIdSuffix = \".store\"\n    }\n  }\n}\n`,
  );
}

function writeAndroidQualifiedReleaseSuffix(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `defaultConfig {\n  applicationId \"dev.example.game\"\n  versionCode 42\n  versionName \"1.4.0\"\n}\n\nbuildTypes.release.applicationIdSuffix = \".store\"\n`,
  );
}

function writeAndroidNamedReleaseSuffix(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `defaultConfig {\n  applicationId "dev.example.game"\n  versionCode 42\n  versionName "1.4.0"\n}\n\nbuildTypes.getByName("release").applicationIdSuffix = ".store"\n`,
  );
}

function writeAndroidSigningConfigSuffix(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `defaultConfig {\n  applicationId "dev.example.game"\n  versionCode 42\n  versionName "1.4.0"\n}\n\nsigningConfigs {\n  release {\n    applicationIdSuffix = ".ignored"\n  }\n}\n`,
  );
}

function writeAndroidWithCommentedIdentity(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `defaultConfig {\n  applicationId \"dev.example.game\"\n  versionCode 42\n  // versionName \"1.3.0\"\n  versionName \"1.4.0\"\n}\n`,
  );
}

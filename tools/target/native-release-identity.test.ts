import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { assertNativeReleaseIdentity } from './native-release-identity';

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
    'versionCode(computeCode())',
    "android.defaultConfig.setProperty('versionCode', 99)",
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
  writeFileSync(appliedIdentity, 'android { productFlavors { demo {} } }');
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /product flavors/u);
  rmSync(appliedIdentity);
  writeShellFiles(shellRoot);
  const flavoredGradle = `${readFileSync(groovy, 'utf8')}\nproductFlavors { demo {} }\n`;
  writeFileSync(groovy, flavoredGradle);
  assert.throws(() => assertNativeReleaseIdentity(appliedIdentityInput), /product flavors/u);
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
  const iosPlist = join(shellRoot, 'ios/App/App/Info.plist');
  const originalPlist = readFileSync(iosPlist, 'utf8');
  const invalidPlistIdentities: readonly [string, string, string][] = [
    ['$(PRODUCT_BUNDLE_IDENTIFIER)', 'dev.other.game', 'CFBundleIdentifier'],
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
    /cannot resolve Release xcconfig PRODUCT_BUNDLE_IDENTIFIER/u,
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
  mkdirSync(join(root, 'ios/App/App.xcodeproj'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App'), { recursive: true });
  writeFileSync(
    android,
    `defaultConfig {\n  applicationId "dev.example.game"\n  versionCode 42\n  versionName "1.4.0"\n}\n`,
  );
  writeFileSync(androidRoot, '// Standard root Gradle build.\n');
  writeFileSync(androidSettings, 'include ":app"\n');
  writeFileSync(iosPlist, [
    '<plist><dict>',
    '<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>',
    '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
    '</dict></plist>',
  ].join(''));
  writeFileSync(
    ios,
    `001 /* App */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 002 /* Build configuration list for PBXNativeTarget \"App\" */;\n  name = \"App\";\n};\n\n002 /* Build configuration list for PBXNativeTarget \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    003 /* Debug */,\n    004 /* Release */,\n  );\n};\n\n003 /* Debug */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.debug;\n    MARKETING_VERSION = 1.4.0-debug;\n    CURRENT_PROJECT_VERSION = 7;\n  };\n};\n\n004 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\n    MARKETING_VERSION = 1.4.0;\n    CURRENT_PROJECT_VERSION = 42;\n    INFOPLIST_FILE = App/Info.plist;\n  };\n};\n\n005 /* ShareExtension */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */;\n  name = ShareExtension;\n};\n\n006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.share;\n    MARKETING_VERSION = 9.9.9;\n    CURRENT_PROJECT_VERSION = 99;\n  };\n};\n`,
  );
}

function writeIosInheritedReleaseSettings(root: string): void {
  writeFileSync(
    join(root, 'ios/App/App.xcodeproj/project.pbxproj'),
    `001 /* App */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 002 /* Build configuration list for PBXNativeTarget \"App\" */;\n  name = \"App\";\n};\n\n002 /* Build configuration list for PBXNativeTarget \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    003 /* Release */,\n  );\n};\n\n003 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = \"$(inherited)\";\n    MARKETING_VERSION = \"$(inherited)\";\n    CURRENT_PROJECT_VERSION = \"$(inherited)\";\n    INFOPLIST_FILE = App/Info.plist;\n  };\n};\n\n004 /* Project object */ = {\n  isa = PBXProject;\n  buildConfigurationList = 005 /* Build configuration list for PBXProject \"App\" */;\n};\n\n005 /* Build configuration list for PBXProject \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    006 /* Release */,\n  );\n};\n\n006 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\n    MARKETING_VERSION = 1.4.0;\n    CURRENT_PROJECT_VERSION = 42;\n  };\n};\n`,
  );
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

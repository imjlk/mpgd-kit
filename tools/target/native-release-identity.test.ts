import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { assertNativeReleaseIdentity } from './native-release-identity';

const shellRoot = mkdtempSync(join(os.tmpdir(), 'mpgd-native-release-'));

try {
  writeShellFiles(shellRoot);

  assert.doesNotThrow(() => assertNativeReleaseIdentity({
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_VERSION_CODE: '42',
      MPGD_TARGET_VERSION_NAME: '1.4.0',
    },
    metadata: { packageId: 'dev.example.game' },
    platform: 'android',
    required: false,
    shellApp: shellRoot,
  }));

  assert.throws(() => assertNativeReleaseIdentity({
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_VERSION_CODE: '43',
      MPGD_TARGET_VERSION_NAME: '1.4.0',
    },
    metadata: { packageId: 'dev.example.game' },
    platform: 'android',
    required: false,
    shellApp: shellRoot,
  }), /Native release identity mismatch/u);

  assert.doesNotThrow(() => assertNativeReleaseIdentity({
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_BUILD_NUMBER: '42',
      MPGD_TARGET_MARKETING_VERSION: '1.4.0',
    },
    metadata: { bundleId: 'dev.example.game' },
    platform: 'ios',
    required: false,
    shellApp: shellRoot,
  }));

  assert.throws(
    () => assertNativeReleaseIdentity({
      environment: {},
      metadata: { packageId: 'dev.example.game' },
      platform: 'android',
      required: true,
      shellApp: shellRoot,
    }),
    /MPGD_TARGET_VERSION_CODE is required/u,
  );

  assert.throws(() => assertNativeReleaseIdentity({
    environment: {
      APP_VERSION: '1.5.0',
      MPGD_TARGET_VERSION_CODE: '42',
      MPGD_TARGET_VERSION_NAME: '1.4.0',
    },
    metadata: { packageId: 'dev.example.game' },
    platform: 'android',
    required: false,
    shellApp: shellRoot,
  }), /Native release version mismatch/u);

  writeAndroidReleaseSuffix(shellRoot);
  assert.throws(() => assertNativeReleaseIdentity({
    environment: {
      APP_VERSION: '1.4.0',
      MPGD_TARGET_VERSION_CODE: '42',
      MPGD_TARGET_VERSION_NAME: '1.4.0',
    },
    metadata: { packageId: 'dev.example.game' },
    platform: 'android',
    required: false,
    shellApp: shellRoot,
  }), /does not support applicationIdSuffix or versionNameSuffix/u);
} finally {
  rmSync(shellRoot, { force: true, recursive: true });
}

function writeShellFiles(root: string): void {
  const android = join(root, 'android/app/build.gradle');
  const ios = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  mkdirSync(join(root, 'android/app'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App.xcodeproj'), { recursive: true });
  writeFileSync(
    android,
    `defaultConfig {\n  applicationId "dev.example.game"\n  versionCode 42\n  versionName "1.4.0"\n}\n`,
  );
  writeFileSync(
    ios,
    `001 /* App */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 002 /* Build configuration list for PBXNativeTarget \"App\" */;\n  name = App;\n};\n\n002 /* Build configuration list for PBXNativeTarget \"App\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    003 /* Debug */,\n    004 /* Release */,\n  );\n};\n\n003 /* Debug */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.debug;\n    MARKETING_VERSION = 1.4.0-debug;\n    CURRENT_PROJECT_VERSION = 7;\n  };\n};\n\n004 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\n    MARKETING_VERSION = 1.4.0;\n    CURRENT_PROJECT_VERSION = 42;\n  };\n};\n\n005 /* ShareExtension */ = {\n  isa = PBXNativeTarget;\n  buildConfigurationList = 006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */;\n  name = ShareExtension;\n};\n\n006 /* Build configuration list for PBXNativeTarget \"ShareExtension\" */ = {\n  isa = XCConfigurationList;\n  buildConfigurations = (\n    007 /* Release */,\n  );\n};\n\n007 /* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = dev.example.game.share;\n    MARKETING_VERSION = 9.9.9;\n    CURRENT_PROJECT_VERSION = 99;\n  };\n};\n`,
  );
}

function writeAndroidReleaseSuffix(root: string): void {
  writeFileSync(
    join(root, 'android/app/build.gradle'),
    `android {\n  defaultConfig {\n    applicationId \"dev.example.game\"\n    versionCode 42\n    versionName \"1.4.0\"\n  }\n  buildTypes {\n    release {\n      applicationIdSuffix \".store\"\n    }\n  }\n}\n`,
  );
}

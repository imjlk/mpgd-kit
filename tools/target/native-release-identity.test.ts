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
    `PRODUCT_BUNDLE_IDENTIFIER = dev.example.game;\nMARKETING_VERSION = 1.4.0;\nCURRENT_PROJECT_VERSION = 42;\n`,
  );
}

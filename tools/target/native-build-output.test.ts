import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  targetConfigExtensionsFileEnv,
  targetConfigMatrixFileEnv,
} from '../../packages/cli/src/target-config-env';
import { assertReleaseManifest } from '../../packages/release-manifest/src/index';
import { createReleaseManifestWriter } from './generate-release-manifest';
import { executeAndroidBuild } from './native-build-execution';
import {
  androidRehearsalBundleFileName,
  androidReleaseBundleFileName,
  nativeReleaseDelivery,
  resolveNativeBuildPlan,
  type NativeBuildPlan,
} from './native-build-mode';
import type { CapacitorTargetConfig } from './schemas';

// build-target.ts runs on import, so this test cannot execute it. It drives the
// two steps that script composes for an Android target instead: the Gradle step
// that names the bundle it copies out of the stage, and the release manifest
// writer, given the delivery record nativeReleaseDelivery(plan) builds. The
// script's own one-line hand-off of its plan and artifact is not executed here.
const root = mkdtempSync(path.join(tmpdir(), 'mpgd-native-build-output-'));
const gameRoot = path.join(root, 'game');
const stagedShell = path.join(root, 'stage');
const gradleBundle = path.join(
  stagedShell,
  'android/app/build/outputs/bundle/release/app-release.aab',
);
const target: CapacitorTargetConfig = {
  kind: 'capacitor-android',
  gameApp: '.',
  shellApp: 'shell',
  webDir: 'shell/www',
  adapter: 'capacitor',
  artifact: 'aab',
  metadata: { packageId: 'dev.example.game' },
};
const androidPlan = (profile: string, mode?: string): NativeBuildPlan => resolveNativeBuildPlan({
  platform: 'android',
  profile,
  environment: mode === undefined ? {} : { MPGD_NATIVE_BUILD_MODE: mode },
});
const rehearsalPlan = androidPlan('production', 'rehearsal-archive');
const signedPlan = androidPlan('production', 'signed-archive');
const stagingPlan = androidPlan('staging');

try {
  const rehearsalRoot = 'release-output/native/android/production/rehearsal-run';
  const rehearsalArtifact = buildAndroid(rehearsalPlan, rehearsalRoot);
  assert.equal(rehearsalArtifact, `${rehearsalRoot}/${androidRehearsalBundleFileName}`);
  assert.equal(
    existsSync(path.join(gameRoot, rehearsalRoot, androidReleaseBundleFileName)),
    false,
    'a rehearsal must not write a bundle under the submission name',
  );
  assert.notEqual(androidRehearsalBundleFileName, androidReleaseBundleFileName);
  assert.match(androidRehearsalBundleFileName, /\.aab$/u);

  const stagingRoot = 'release-output/native/android/staging/staging-run';
  assert.equal(
    buildAndroid(stagingPlan, stagingRoot),
    `${stagingRoot}/${androidReleaseBundleFileName}`,
  );

  // A signed build copies the bundle, then inspects its signer and version with
  // bundletool. Without the version inputs it stops before that inspection, after
  // the copy, so the name it wrote is still visible here.
  const signedRoot = 'release-output/native/android/production/signed-run';
  const signedArtifact = `${signedRoot}/${androidReleaseBundleFileName}`;
  assert.throws(
    () => buildAndroid(signedPlan, signedRoot),
    /Missing target config value: MPGD_TARGET_VERSION_CODE/u,
  );
  assert.equal(
    readFileSync(path.join(gameRoot, signedArtifact), 'utf8'),
    `bundle for ${signedRoot}`,
  );
  assert.equal(existsSync(path.join(gameRoot, signedRoot, androidRehearsalBundleFileName)), false);

  const iconManifest = path.join(root, 'icon-manifest.json');
  const manifestFile = path.join(root, 'release-manifest.json');
  writeFileSync(iconManifest, `${JSON.stringify({
    schemaVersion: 2,
    canonicalSource: { path: 'assets/icon.svg', sha256: 'a'.repeat(64), format: 'svg' },
    renderSource: { path: 'assets/icon.svg', sha256: 'a'.repeat(64), format: 'svg' },
    sharedConfigSha256: 'b'.repeat(64),
    renderConfigSha256: 'c'.repeat(64),
    generatorVersion: '1.1.0',
    targetProfile: 'fixture',
    targetProfileVersion: '1.0.0',
    outputs: [],
    warnings: [],
  }, null, 2)}\n`);
  const writeManifest = createReleaseManifestWriter({
    sourceGitSha: 'd'.repeat(40),
    kitGitSha: 'e'.repeat(40),
  });
  const signedDelivery = {
    platform: 'android',
    mode: 'signed-archive',
    signed: true,
    submissionCandidate: true,
  };

  withEnvironment({
    APP_VERSION: '1.4.0',
    BUILD_ID: 'native-build-output-test',
    MPGD_PLATFORM_TARGETS_FILE: path.resolve('examples/phaser-starter/mpgd.targets.json'),
    MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: path.join(root, 'target-config'),
    MPGD_ICON_MANIFEST_PATH: iconManifest,
    MPGD_TARGET_VERSION_CODE: '42',
    MPGD_TARGET_VERSION_NAME: '1.4.0',
    MPGD_PRODUCT_CATALOG_FILE: undefined,
    MPGD_AD_PLACEMENTS_FILE: undefined,
    MPGD_RELEASE_REVISION: undefined,
    MPGD_RELEASE_LABEL: undefined,
    MPGD_TARGET_MARKETING_VERSION: undefined,
    MPGD_TARGET_BUILD_NUMBER: undefined,
    MPGD_AIT_APP_NAME: undefined,
    MPGD_AIT_SDK_MAJOR: undefined,
    [targetConfigMatrixFileEnv]: undefined,
    [targetConfigExtensionsFileEnv]: undefined,
  }, () => {
    const record = (plan: NativeBuildPlan, artifact: string) => {
      writeManifest({
        target: 'android',
        profile: 'production',
        artifact,
        iconManifestArtifactPath: 'mpgd-icon-manifest.json',
        nativeDelivery: nativeReleaseDelivery(plan),
        outputPath: manifestFile,
      });
      const entry = assertReleaseManifest(JSON.parse(readFileSync(manifestFile, 'utf8')))
        .targets.android;
      assert.equal(entry?.artifact, artifact);
      return entry?.nativeDelivery;
    };

    assert.deepEqual(record(signedPlan, signedArtifact), signedDelivery);
    assert.deepEqual(record(rehearsalPlan, rehearsalArtifact), {
      platform: 'android',
      mode: 'unsigned-archive',
      signed: false,
      submissionCandidate: false,
      rehearsal: true,
    });
    // A signed build after a rehearsal replaces the Android entry, so no
    // rehearsal flag is left on the submission build (strict deepEqual).
    assert.deepEqual(record(signedPlan, signedArtifact), signedDelivery);
  });

  console.info('Native build output names and release manifest delivery passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function buildAndroid(plan: NativeBuildPlan, artifactRoot: string): string {
  rmSync(gradleBundle, { force: true });
  const gradleRuns: string[] = [];
  const output = executeAndroidBuild(
    {
      plan,
      artifactRoot,
      environment: {},
      target,
      targetPath: (file) => path.join(gameRoot, file),
      replaceDirectory: () => {
        throw new Error('An Android archive build does not replace a directory.');
      },
      copyFile: (source, destination) => {
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(source, destination);
      },
      run: (command, args, _environment, cwd) => {
        gradleRuns.push([command, ...args].join(' '));
        assert.equal(path.resolve(cwd ?? ''), path.join(stagedShell, 'android'));
        mkdirSync(path.dirname(gradleBundle), { recursive: true });
        writeFileSync(gradleBundle, `bundle for ${artifactRoot}`);
      },
    },
    stagedShell,
  );
  assert.deepEqual(gradleRuns, ['./gradlew bundleRelease --no-daemon']);
  assert.equal(output.symbols, undefined);
  assert.equal(
    readFileSync(path.join(gameRoot, output.artifact), 'utf8'),
    `bundle for ${artifactRoot}`,
  );
  return output.artifact;
}

function withEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  callback: () => T,
): T {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

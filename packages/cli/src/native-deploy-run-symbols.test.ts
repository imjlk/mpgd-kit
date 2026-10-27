import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  formatMpgdReleaseId,
  type PlatformVersionLedger,
  type PlatformVersionReleasePlan,
} from '@mpgd/target-config';

import { initializeDeployConfig, planNativeDeployment } from './deploy-planning.js';
import { runNativeDeployment } from './native-deploy-run.js';
import { hashMappingFile } from './play-release-options.js';
import {
  readNativeReleaseStatus,
  recordNativeReleaseBuild,
  reserveNativeRelease,
} from './release-state.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';
import { createSignedAabFixture } from '../test/signed-aab-fixture.js';

// `mpgd deploy run` end to end on recorded builds (no build stage): a
// --mapping-file that differs from the recorded R8 mapping is refused before
// any target is submitted, and the Crashlytics dSYM upload does not run when
// the run fails. No store or Firebase call is made: the refusal happens first,
// and the iOS submission fails on a fake App Store Connect tool.

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-deploy-run-symbols-'));
const gitEnvironment = { ...process.env };
for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]) {
  delete gitEnvironment[name];
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: gitEnvironment });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

try {
  const bare = path.join(fixture, 'remote.git');
  const game = path.join(fixture, 'game');
  git(['init', '--bare', '-q', bare], fixture);
  git(['init', '-q', game], fixture);
  git(['remote', 'add', 'origin', bare], game);
  mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
  writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
  writeFileSync(path.join(game, 'package.json'), '{"name":"deploy-run-symbols"}\n');
  writeFileSync(path.join(game, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(game, '.gitignore'), '.mpgd/\n');
  writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        artifact: 'aab',
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.game' },
      },
      ios: {
        kind: 'capacitor-ios',
        adapter: 'capacitor',
        artifact: 'ipa',
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { bundleId: 'dev.mpgd.game' },
      },
    },
  }, null, 2)}\n`);
  const deployFile = initializeDeployConfig(game);
  const deployConfig = JSON.parse(readFileSync(deployFile, 'utf8'));
  deployConfig.profiles.beta.targets.ios.testGroup = 'group-1';
  writeFileSync(deployFile, `${JSON.stringify(deployConfig, null, 2)}\n`);
  git(['add', '.'], game);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'game input',
    ],
    game,
  );
  // iOS first: before the fix, it reached TestFlight before Android's refusal.
  const plan = planNativeDeployment({ game, profile: 'beta', targets: ['ios', 'android'] });
  const kit = { packageVersion: '0.60.0', gitSha: 'b'.repeat(40) };
  const initialLedger: PlatformVersionLedger = {
    schemaVersion: 2,
    platforms: { android: { versionCode: 40 }, ios: { buildNumber: 50 } },
    releaseRevision: { lastAllocated: 0 },
  };
  const reserved = await reserveNativeRelease({
    gameRoot: plan.gameRoot,
    releaseKey: 'beta-01',
    gameId: 'alpha',
    gameVersion: '1.0.0',
    sourceGitSha: git(['rev-parse', 'HEAD'], game),
    kitGitSha: kit.gitSha,
    targetConfigDigest: plan.targetConfigSha256,
    targets: [{ target: 'ios' }, { target: 'android' }],
    initialLedger,
  });

  const releaseDirectory = path.join(plan.gameRoot, '.mpgd/releases/beta-01');
  mkdirSync(releaseDirectory, { recursive: true });
  const write = (name: string, content: string): string => {
    const file = path.join(releaseDirectory, name);
    writeFileSync(file, content);
    return file;
  };
  const aab = path.join(releaseDirectory, 'android.aab');
  createSignedAabFixture(aab);
  const mapping = write('android-mapping.txt', 'com.example.Game -> a:\n');
  const common = {
    gameRoot: plan.gameRoot,
    gameId: 'alpha',
    releaseKey: 'beta-01',
    kitPackageVersion: kit.packageVersion,
    buildConfigDigest: 'f'.repeat(64),
    deployConfigSha256: plan.deployConfigSha256,
    deploymentProfile: 'beta',
    inspectedAppId: 'dev.mpgd.game',
  };
  const androidManifest = writeManifest(reserved.plan, 'android', fixture);
  await recordNativeReleaseBuild({
    ...common,
    target: 'android',
    buildRunId: 'android-run',
    deploymentDestination: 'play-internal',
    artifactFile: aab,
    expectedArtifactSha256: sha256(aab),
    artifactLocation: '.mpgd/releases/beta-01/android.aab',
    releaseManifestFile: androidManifest,
    expectedReleaseManifestSha256: sha256(androidManifest),
    inspectedSignerSha256: await inspectAndroidBundleSigner(aab),
    r8Mapping: { file: mapping, location: '.mpgd/releases/beta-01/android-mapping.txt' },
  });
  const ipa = write('ios.ipa', 'signed iOS candidate');
  const iosManifest = writeManifest(reserved.plan, 'ios', fixture);
  const symbolFile = (name: string, content: string) => ({
    file: write(name, content),
    location: `.mpgd/releases/beta-01/${name}`,
  });
  await recordNativeReleaseBuild({
    ...common,
    target: 'ios',
    buildRunId: 'ios-run',
    deploymentDestination: 'testflight',
    internalTestGroupId: 'group-1',
    artifactFile: ipa,
    expectedArtifactSha256: sha256(ipa),
    artifactLocation: '.mpgd/releases/beta-01/ios.ipa',
    releaseManifestFile: iosManifest,
    expectedReleaseManifestSha256: sha256(iosManifest),
    inspectedTeamId: 'ABCDEFGHIJ',
    crashlyticsSymbols: {
      dsymArchive: symbolFile('ios-dsyms.zip', 'zip of dSYMs'),
      dsyms: [{ bundle: 'App.app.dSYM', uuids: ['00112233-4455-6677-8899-AABBCCDDEEFF'] }],
      uploadTool: symbolFile('ios-upload-symbols', '#!/bin/sh\nexit 0\n'),
      googleServiceInfo: symbolFile('ios-GoogleService-Info.plist', '<plist/>\n'),
    },
  });

  // Credentials are fake files; the fake ASC tool fails if it is ever called.
  const credentials = path.join(fixture, 'credentials');
  mkdirSync(credentials);
  const serviceAccount = path.join(credentials, 'play.json');
  writeFileSync(serviceAccount, '{}\n');
  const asc = path.join(credentials, 'asc');
  writeFileSync(asc, '#!/bin/sh\necho "fake asc must not upload" >&2\nexit 9\n');
  chmodSync(asc, 0o755);
  const environment = {
    ...gitEnvironment,
    MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT: serviceAccount,
    MPGD_ASC_BINARY: asc,
    MPGD_ASC_APP_ID: '1234567890',
    MPGD_ASC_KEY_ID: 'KEYID12345',
    MPGD_ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
    MPGD_ASC_API_KEY: Buffer.from('not a key').toString('base64'),
  };
  const otherMapping = path.join(fixture, 'other-mapping.txt');
  writeFileSync(otherMapping, 'com.example.Other -> b:\n');
  const reports: string[] = [];
  const runInput = {
    plan,
    releaseKey: 'beta-01',
    gameId: 'alpha',
    gameVersion: '1.0.0',
    kit,
    approved: true,
    environment,
    onCrashSymbolsReport: (message: string) => reports.push(message),
  };
  await assert.rejects(
    runNativeDeployment({
      ...runInput,
      androidRelease: {
        track: 'internal',
        status: 'completed',
        mappingFile: otherMapping,
        mappingSha256: await hashMappingFile(otherMapping),
      },
    }),
    /--mapping-file differs from the R8 mapping recorded with this build/u,
  );
  const refused = await readNativeReleaseStatus({ ...common, environment });
  assert.deepEqual(refused.submissions, {}, 'neither target was submitted');
  assert.deepEqual(reports, [], 'a refused run uploads no dSYMs');

  // A run whose (iOS) submission fails reports that error and skips the upload.
  await assert.rejects(runNativeDeployment(runInput));
  const failedRun = await readNativeReleaseStatus({ ...common, environment });
  assert.equal(failedRun.submissions.android, undefined, 'Android was never reached');
  assert.notEqual(failedRun.submissions.ios, undefined, 'the iOS submission was attempted');
  assert.deepEqual(reports, [], 'a failed run uploads no dSYMs');
  assert.deepEqual(failedRun.symbolUploads, {});
  console.info('deploy run crash symbols ordering passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function writeManifest(
  plan: PlatformVersionReleasePlan,
  target: 'android' | 'ios',
  directory: string,
): string {
  const file = path.join(directory, `${target}-release-manifest.json`);
  const digest = 'c'.repeat(64);
  writeFileSync(file, `${JSON.stringify({
    releaseId: formatMpgdReleaseId(plan.releaseLabel, plan.buildId),
    gitSha: plan.sourceGitSha,
    kitGitSha: plan.kitGitSha,
    buildId: plan.buildId,
    gameVersion: plan.gameVersion,
    targetConfigVersion: '1',
    catalogVersion: '1',
    adPlacementVersion: '1',
    releaseIdentity: {
      gameVersion: plan.gameVersion,
      releaseRevision: plan.releaseRevision,
      label: plan.releaseLabel,
    },
    targets: {
      [target]: {
        artifact: `game.${target === 'android' ? 'aab' : 'ipa'}`,
        effectiveConfig: { path: 'effective.json', version: '1', digest },
        iconManifest: {
          path: 'icons.json', digest, sourceSha256: digest,
          sharedConfigSha256: digest, renderConfigSha256: digest,
          generatorVersion: '1', targetProfile: target, targetProfileVersion: '1',
        },
        profile: 'production',
        ...(target === 'android'
          ? {
              versionCode: plan.targets.android?.versionCode,
              versionName: plan.targets.android?.versionName,
            }
          : {
              buildNumber: String(plan.targets.ios?.buildNumber),
              marketingVersion: plan.targets.ios?.marketingVersion,
            }),
        nativeDelivery: {
          platform: target,
          mode: target === 'android' ? 'signed-archive' : 'store-export',
          signed: true,
          submissionCandidate: true,
        },
      },
    },
  })}\n`);
  return file;
}

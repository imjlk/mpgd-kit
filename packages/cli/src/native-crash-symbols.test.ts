import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { formatMpgdReleaseId, type PlatformVersionLedger } from '@mpgd/target-config';

import {
  crashSymbolsRetryCommand,
  uploadCrashSymbolsForDeployRun,
  uploadRecordedCrashSymbols,
  type CrashSymbolUploadPorts,
} from './crash-symbols-upload.js';
import { runReleaseProcess } from './deploy-process.js';
import type { NativeDeploymentPlan } from './deploy-planning.js';
import {
  assertNativeBuildSymbols,
  collectIosCrashlyticsSymbols,
  crashlyticsUploadToolCandidates,
  readArchiveDsyms,
  readMachOUuids,
} from './native-build-symbols.js';
import {
  submitRecordedNativeTargetWithPorts,
  withRecordedR8Mapping,
  type NativeSubmissionPorts,
} from './native-deploy-submission.js';
import { playReleaseRequestDigest, type PlayReleaseRequest } from './play-release-options.js';
import {
  readNativeReleaseStatus,
  recordCrashSymbolUpload,
  recordNativeReleaseBuild,
  reserveNativeRelease,
  type ImmutableNativeBuildRecord,
  type NativeReleaseStatus,
} from './release-state.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';
import { createSignedAabFixture } from '../test/signed-aab-fixture.js';

// R8 mappings and Crashlytics dSYMs recorded with a native build, the Play
// submission's use of the recorded mapping, and the dSYM upload step. The
// upload runs a fake upload-symbols script; nothing reaches Firebase.

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-crash-symbols-test-'));
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

/** A thin little-endian 64-bit Mach-O header with one segment and an LC_UUID. */
function thinMachO(uuidHex: string): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(0xa, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(16 + 24, 20);
  const segment = Buffer.alloc(16);
  segment.writeUInt32LE(0x19, 0);
  segment.writeUInt32LE(16, 4);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  Buffer.from(uuidHex, 'hex').copy(uuid, 8);
  return Buffer.concat([header, segment, uuid]);
}

/** A universal (fat) Mach-O holding two thin slices. */
function fatMachO(first: string, second: string): Buffer {
  const header = Buffer.alloc(8 + 2 * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  const sliceA = thinMachO(first);
  const sliceB = thinMachO(second);
  header.writeUInt32BE(0x1000, 8 + 8);
  header.writeUInt32BE(sliceA.length, 8 + 12);
  header.writeUInt32BE(0x2000, 28 + 8);
  header.writeUInt32BE(sliceB.length, 28 + 12);
  const file = Buffer.alloc(0x2000 + sliceB.length);
  header.copy(file, 0);
  sliceA.copy(file, 0x1000);
  sliceB.copy(file, 0x2000);
  return file;
}

try {
  // --- Mach-O UUIDs ---------------------------------------------------------
  const thin = path.join(fixture, 'thin');
  writeFileSync(thin, thinMachO('0123456789abcdef0123456789abcdef'));
  assert.deepEqual(readMachOUuids(thin), ['01234567-89AB-CDEF-0123-456789ABCDEF']);
  const fat = path.join(fixture, 'fat');
  writeFileSync(
    fat,
    fatMachO('11111111222233334444555555555555', 'aaaaaaaabbbbccccddddeeeeeeeeeeee'),
  );
  assert.deepEqual(readMachOUuids(fat), [
    '11111111-2222-3333-4444-555555555555',
    'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
  ]);
  const notMachO = path.join(fixture, 'text');
  writeFileSync(notMachO, 'not a binary at all, but long enough to read a header');
  assert.throws(() => readMachOUuids(notMachO), /not a Mach-O file/u);

  // --- Collecting the iOS symbols out of a staged archive -------------------
  const stage = path.join(fixture, 'stage/ios');
  const archive = path.join(fixture, 'App.xcarchive');
  const sourcePackages = path.join(stage, '.mpgd-source-packages');
  const dwarf = path.join(archive, 'dSYMs/App.app.dSYM/Contents/Resources/DWARF');
  mkdirSync(dwarf, { recursive: true });
  writeFileSync(path.join(dwarf, 'App'), thinMachO('00112233445566778899aabbccddeeff'));
  const app = path.join(archive, 'Products/Applications/App.app');
  mkdirSync(app, { recursive: true });
  const outputDirectory = path.join(fixture, 'release-output/native/ios/production/run/symbols');
  const zipped: string[] = [];
  const collectInput = {
    archive,
    iosProject: stage,
    sourcePackages,
    outputDirectory,
    copyFile: (source: string, destination: string) => {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    },
    zipDirectory: (source: string, destination: string) => {
      zipped.push(source);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, `zip of ${path.basename(source)}`);
    },
  };
  assert.throws(
    () => collectIosCrashlyticsSymbols(collectInput),
    /no Firebase Crashlytics upload-symbols/u,
  );
  const [spmTool, podsTool] = crashlyticsUploadToolCandidates({
    sourcePackages,
    iosProject: stage,
  });
  assert.equal(
    spmTool,
    path.join(sourcePackages, 'checkouts/firebase-ios-sdk/Crashlytics/upload-symbols'),
  );
  assert.equal(podsTool, path.join(stage, 'App/Pods/FirebaseCrashlytics/upload-symbols'));
  mkdirSync(path.dirname(podsTool ?? ''), { recursive: true });
  writeFileSync(podsTool ?? '', '#!/bin/sh\nexit 0\n');
  assert.throws(
    () => collectIosCrashlyticsSymbols(collectInput),
    /does not bundle GoogleService-Info.plist/u,
  );
  writeFileSync(path.join(app, 'GoogleService-Info.plist'), '<plist>firebase app</plist>\n');
  const collected = collectIosCrashlyticsSymbols(collectInput);
  assert.deepEqual(zipped, [path.join(archive, 'dSYMs')]);
  assert.deepEqual(collected.dsyms, [
    { bundle: 'App.app.dSYM', uuids: ['00112233-4455-6677-8899-AABBCCDDEEFF'] },
  ]);
  assert.equal(readFileSync(collected.uploadTool, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(readFileSync(collected.googleServiceInfo, 'utf8'), '<plist>firebase app</plist>\n');
  // The Swift Package checkout is preferred over CocoaPods.
  mkdirSync(path.dirname(spmTool ?? ''), { recursive: true });
  writeFileSync(spmTool ?? '', '#!/bin/sh\necho spm\n');
  assert.equal(
    readFileSync(collectIosCrashlyticsSymbols(collectInput).uploadTool, 'utf8'),
    '#!/bin/sh\necho spm\n',
  );
  rmSync(path.join(archive, 'dSYMs'), { recursive: true });
  assert.deepEqual(readArchiveDsyms(path.join(archive, 'dSYMs')), []);
  assert.throws(() => collectIosCrashlyticsSymbols(collectInput), /DWARF with dSYM File/u);

  // --- The build status record ----------------------------------------------
  const inside = (file: string): boolean => file.startsWith('release-output/native/ios/');
  assertNativeBuildSymbols({ r8Mapping: 'release-output/native/ios/x/mapping.txt' }, inside);
  assertNativeBuildSymbols(
    {
      crashlytics: {
        dsymArchive: 'release-output/native/ios/x/dSYMs.zip',
        dsyms: [{ bundle: 'App.app.dSYM', uuids: ['00112233-4455-6677-8899-AABBCCDDEEFF'] }],
        uploadTool: 'release-output/native/ios/x/upload-symbols',
        googleServiceInfo: 'release-output/native/ios/x/GoogleService-Info.plist',
      },
    },
    inside,
  );
  for (const malformed of [
    {},
    { r8Mapping: '/tmp/mapping.txt' },
    { r8Mapping: 'release-output/native/ios/x/mapping.txt', extra: true },
    {
      crashlytics: {
        dsymArchive: 'release-output/native/ios/x/dSYMs.zip',
        dsyms: [{ bundle: 'App.app.dSYM', uuids: ['not-a-uuid'] }],
        uploadTool: 'release-output/native/ios/x/upload-symbols',
        googleServiceInfo: 'release-output/native/ios/x/GoogleService-Info.plist',
      },
    },
    {
      crashlytics: {
        dsymArchive: 'release-output/native/ios/x/dSYMs.zip',
        dsyms: [],
        uploadTool: 'release-output/native/ios/x/upload-symbols',
        googleServiceInfo: 'release-output/native/ios/x/GoogleService-Info.plist',
      },
    },
  ]) {
    assert.throws(() => assertNativeBuildSymbols(malformed, inside), /malformed/u);
  }

  // --- The recorded R8 mapping and an explicit --mapping-file ---------------
  const mappingGame = path.join(fixture, 'mapping-game');
  mkdirSync(path.join(mappingGame, '.mpgd/releases/beta-01'), { recursive: true });
  const recordedMapping = path.join(mappingGame, '.mpgd/releases/beta-01/android-mapping.txt');
  writeFileSync(recordedMapping, 'com.example.Game -> a:\n');
  const mappingRecord = {
    r8Mapping: {
      location: '.mpgd/releases/beta-01/android-mapping.txt',
      sha256: sha256(recordedMapping),
    },
  };
  assert.equal(withRecordedR8Mapping(undefined, undefined, mappingGame), undefined);
  const notes: PlayReleaseRequest = { track: 'beta', status: 'completed' };
  assert.equal(withRecordedR8Mapping(notes, {}, mappingGame), notes);
  const recordedDefault = withRecordedR8Mapping(undefined, mappingRecord, mappingGame);
  assert.equal(recordedDefault?.track, 'internal');
  assert.equal(recordedDefault?.status, 'completed');
  assert.equal(recordedDefault?.mappingSha256, mappingRecord.r8Mapping.sha256);
  assert.equal(
    recordedDefault?.mappingFile,
    path.join(realpathSync(mappingGame), '.mpgd/releases/beta-01/android-mapping.txt'),
  );
  const recordedBeta = withRecordedR8Mapping(notes, mappingRecord, mappingGame);
  assert.equal(recordedBeta?.track, 'beta');
  assert.equal(recordedBeta?.mappingSha256, mappingRecord.r8Mapping.sha256);
  const sameExplicit: PlayReleaseRequest = {
    ...notes,
    mappingFile: path.join(fixture, 'copy-of-mapping.txt'),
    mappingSha256: mappingRecord.r8Mapping.sha256,
  };
  assert.equal(withRecordedR8Mapping(sameExplicit, mappingRecord, mappingGame), sameExplicit);
  assert.throws(
    () =>
      withRecordedR8Mapping(
        { ...notes, mappingFile: path.join(fixture, 'other.txt'), mappingSha256: 'f'.repeat(64) },
        mappingRecord,
        mappingGame,
      ),
    /differs from the R8 mapping recorded with this build/u,
  );
  // A build without a recorded mapping keeps an explicit one (minify off, older records).
  const explicitOnly = { ...notes, mappingFile: '/abs/mapping.txt', mappingSha256: 'f'.repeat(64) };
  assert.equal(withRecordedR8Mapping(explicitOnly, {}, mappingGame), explicitOnly);

  // The submission sends the recorded mapping and binds it to the checkpoint.
  writeFileSync(path.join(mappingGame, 'android.aab'), 'test Android bytes');
  const submissionPlan: NativeDeploymentPlan = {
    schemaVersion: 1,
    gameRoot: mappingGame,
    profile: 'beta',
    buildProfile: 'production',
    approval: 'manual',
    targetConfigSha256: 'd'.repeat(64),
    deployConfigSha256: 'e'.repeat(64),
    targets: [{ target: 'android', destination: 'play-internal', appId: 'dev.mpgd.test' }],
  };
  const androidRecord = {
    releaseKey: 'beta-01',
    target: 'android',
    buildRunId: 'android-run',
    inspectedAppId: 'dev.mpgd.test',
    artifactLocation: 'android.aab',
    artifactSha256: 'a'.repeat(64),
    deployConfigSha256: submissionPlan.deployConfigSha256,
    deploymentProfile: submissionPlan.profile,
    deploymentDestination: 'play-internal',
    ...mappingRecord,
  } as ImmutableNativeBuildRecord;
  let submissions: NativeReleaseStatus['submissions'] = {};
  const sentReleases: (PlayReleaseRequest | undefined)[] = [];
  const submissionPorts: NativeSubmissionPorts = {
    async readStatus() {
      return {
        plan: {
          gameId: 'game',
          targetConfigDigest: 'd'.repeat(64),
          targets: { android: {} },
        } as unknown as NativeReleaseStatus['plan'],
        builds: { android: androidRecord },
        submissions,
        stateCommit: 'c'.repeat(40),
      };
    },
    async checkpoint({ checkpoint }) {
      submissions = { ...submissions, [checkpoint.target]: checkpoint };
      return { checkpoint, stateCommit: 'c'.repeat(40) };
    },
    async reclaim() {
      throw new Error('not reclaimed in this test');
    },
    async releaseLease() {
      throw new Error('not released in this test');
    },
    async submitAndroid(input) {
      sentReleases.push(input.release);
      await input.onEditCreated?.('edit-1');
      return {
        status: 'committed',
        packageName: 'dev.mpgd.test',
        editId: 'edit-1',
        track: 'internal',
        releaseStatus: 'completed',
        draftAppFallback: false,
        versionCode: 41,
        bundleSha256: 'a'.repeat(64),
        alreadyCommitted: false,
      };
    },
    async submitIos() {
      throw new Error('no iOS submission in this test');
    },
  };
  const submitInput = {
    plan: submissionPlan,
    gameId: 'game',
    releaseKey: 'beta-01',
    credential: { target: 'android' as const, serviceAccountFile: '/unused.json' },
    approved: true,
  };
  await assert.rejects(
    submitRecordedNativeTargetWithPorts(
      {
        ...submitInput,
        androidRelease: { ...explicitOnly, track: 'internal' },
      },
      submissionPorts,
    ),
    /differs from the R8 mapping recorded/u,
  );
  assert.deepEqual(submissions, {}, 'a refused mapping writes no checkpoint');
  const committed = await submitRecordedNativeTargetWithPorts(submitInput, submissionPorts);
  assert.equal(committed.status, 'committed');
  assert.equal(sentReleases.length, 1);
  assert.equal(sentReleases[0]?.mappingSha256, mappingRecord.r8Mapping.sha256);
  assert.equal(committed.playReleaseSha256, playReleaseRequestDigest(recordedDefault ?? notes));

  // --- Build records and the dSYM upload on a real release-state branch -----
  const bare = path.join(fixture, 'remote.git');
  const game = path.join(fixture, 'game');
  git(['init', '--bare', '-q', bare], fixture);
  git(['init', '-q', game], fixture);
  git(['remote', 'add', 'origin', bare], game);
  writeFileSync(path.join(game, 'package.json'), '{"name":"symbols-test"}\n');
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
  const initialLedger: PlatformVersionLedger = {
    schemaVersion: 2,
    platforms: { android: { versionCode: 40 }, ios: { buildNumber: 50 } },
    releaseRevision: { lastAllocated: 0 },
  };
  const digest = 'c'.repeat(64);
  const reserved = await reserveNativeRelease({
    gameRoot: game,
    releaseKey: 'beta-01',
    gameId: 'alpha',
    gameVersion: '1.0.0',
    sourceGitSha: git(['rev-parse', 'HEAD'], game),
    kitGitSha: 'b'.repeat(40),
    targetConfigDigest: digest,
    targets: [{ target: 'android' }, { target: 'ios' }],
    initialLedger,
  });
  const manifestFor = (target: 'android' | 'ios', artifact: string): string => {
    const file = path.join(fixture, `${target}-release-manifest.json`);
    const plan = reserved.plan;
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
          artifact,
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
  };
  const releaseDirectory = path.join(game, '.mpgd/releases/beta-01');
  mkdirSync(releaseDirectory, { recursive: true });
  const aab = path.join(releaseDirectory, 'android.aab');
  createSignedAabFixture(aab);
  const androidManifest = manifestFor('android', 'game.aab');
  const mapping = path.join(releaseDirectory, 'android-mapping.txt');
  writeFileSync(mapping, 'com.example.Game -> a:\n');
  const androidInput = {
    gameRoot: game,
    gameId: 'alpha',
    releaseKey: 'beta-01',
    target: 'android' as const,
    buildRunId: 'android-run',
    kitPackageVersion: '0.60.0',
    buildConfigDigest: 'f'.repeat(64),
    artifactFile: aab,
    expectedArtifactSha256: sha256(aab),
    artifactLocation: '.mpgd/releases/beta-01/android.aab',
    releaseManifestFile: androidManifest,
    expectedReleaseManifestSha256: sha256(androidManifest),
    inspectedAppId: 'dev.mpgd.alpha',
    inspectedSignerSha256: await inspectAndroidBundleSigner(aab),
  };
  await assert.rejects(
    recordNativeReleaseBuild({
      ...androidInput,
      r8Mapping: { file: mapping, location: '../outside/mapping.txt' },
    }),
    /invalid location/u,
  );
  const androidBuilt = await recordNativeReleaseBuild({
    ...androidInput,
    r8Mapping: { file: mapping, location: '.mpgd/releases/beta-01/android-mapping.txt' },
  });
  assert.deepEqual(androidBuilt.record.r8Mapping, {
    location: '.mpgd/releases/beta-01/android-mapping.txt',
    sha256: sha256(mapping),
  });
  // The immutable record cannot be re-recorded without (or with another) mapping.
  await assert.rejects(recordNativeReleaseBuild(androidInput), /cannot be replaced/u);

  const ipa = path.join(releaseDirectory, 'ios.ipa');
  writeFileSync(ipa, 'signed iOS candidate');
  const iosManifest = manifestFor('ios', 'game.ipa');
  const dsymZip = path.join(releaseDirectory, 'ios-dsyms.zip');
  writeFileSync(dsymZip, 'zip of dSYMs');
  const plist = path.join(releaseDirectory, 'ios-GoogleService-Info.plist');
  writeFileSync(plist, '<plist>firebase app</plist>\n');
  const tool = path.join(releaseDirectory, 'ios-upload-symbols');
  // The fake tool records its arguments and fails while $HOME/fail exists.
  writeFileSync(tool, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$HOME/upload-args.txt"',
    'if [ -n "$MPGD_ASC_KEY_ID" ]; then echo leaked >> "$HOME/upload-args.txt"; fi',
    'if [ -f "$HOME/fail" ]; then echo "simulated network error" >&2; exit 3; fi',
    'echo "Successfully uploaded Crashlytics symbols"',
    '',
  ].join('\n'));
  chmodSync(tool, 0o644);
  const dsyms = [{ bundle: 'App.app.dSYM', uuids: ['00112233-4455-6677-8899-AABBCCDDEEFF'] }];
  const iosInput = {
    ...androidInput,
    target: 'ios' as const,
    buildRunId: 'ios-run',
    artifactFile: ipa,
    expectedArtifactSha256: sha256(ipa),
    artifactLocation: '.mpgd/releases/beta-01/ios.ipa',
    releaseManifestFile: iosManifest,
    expectedReleaseManifestSha256: sha256(iosManifest),
    inspectedAppId: 'dev.mpgd.alpha.ios',
    inspectedSignerSha256: undefined,
    inspectedTeamId: 'ABCDEFGHIJ',
  };
  const crashlyticsSymbols = {
    dsymArchive: { file: dsymZip, location: '.mpgd/releases/beta-01/ios-dsyms.zip' },
    dsyms,
    uploadTool: { file: tool, location: '.mpgd/releases/beta-01/ios-upload-symbols' },
    googleServiceInfo: {
      file: plist,
      location: '.mpgd/releases/beta-01/ios-GoogleService-Info.plist',
    },
  };
  await assert.rejects(
    recordNativeReleaseBuild({
      ...iosInput,
      r8Mapping: { file: mapping, location: '.mpgd/releases/beta-01/android-mapping.txt' },
    }),
    /do not match the build target/u,
  );
  const iosBuilt = await recordNativeReleaseBuild({ ...iosInput, crashlyticsSymbols });
  assert.equal(iosBuilt.record.crashlyticsSymbols?.dsymArchive.sha256, sha256(dsymZip));
  assert.deepEqual(iosBuilt.record.crashlyticsSymbols?.dsyms, dsyms);

  const home = path.join(fixture, 'home');
  mkdirSync(home);
  const uploadEnvironment = { ...process.env, HOME: home, MPGD_ASC_KEY_ID: 'store-key-id' };
  const uploadInput = {
    gameRoot: game,
    gameId: 'alpha',
    releaseKey: 'beta-01',
    environment: uploadEnvironment,
  };
  const darwinPorts: CrashSymbolUploadPorts = {
    readStatus: readNativeReleaseStatus,
    recordUpload: recordCrashSymbolUpload,
    run: runReleaseProcess,
    platform: 'darwin',
  };
  const planned = await uploadRecordedCrashSymbols({ ...uploadInput, dryRun: true }, darwinPorts);
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.status === 'planned' ? planned.plan.command : [], [
    '.mpgd/releases/beta-01/ios-upload-symbols',
    '-gsp',
    '.mpgd/releases/beta-01/ios-GoogleService-Info.plist',
    '-p',
    'ios',
    '.mpgd/releases/beta-01/ios-dsyms.zip',
  ]);
  assert.equal(existsSync(path.join(home, 'upload-args.txt')), false, 'a dry run runs nothing');
  assert.deepEqual((await readNativeReleaseStatus(uploadInput)).symbolUploads, {});
  await assert.rejects(
    uploadRecordedCrashSymbols(uploadInput, { ...darwinPorts, platform: 'linux' }),
    /macOS tool/u,
  );
  // Tampered bytes are refused before anything runs, also for a dry run.
  writeFileSync(dsymZip, 'other dSYMs');
  await assert.rejects(
    uploadRecordedCrashSymbols({ ...uploadInput, dryRun: true }, darwinPorts),
    /dSYM archive differs from the immutable build record/u,
  );
  writeFileSync(dsymZip, 'zip of dSYMs');

  writeFileSync(path.join(home, 'fail'), '');
  const reports: string[] = [];
  const failed = await uploadCrashSymbolsForDeployRun(
    uploadInput,
    (message) => reports.push(message),
    (input) => uploadRecordedCrashSymbols(input, darwinPorts),
  );
  assert.equal(failed?.status, 'failed');
  assert.match(reports.join('\n'), /dSYM upload failed \(upload-symbols exited with code 3\)/u);
  assert.match(reports.join('\n'), /simulated network error/u);
  assert.ok(reports.join('\n').includes(crashSymbolsRetryCommand(uploadInput)));
  const afterFailure = await readNativeReleaseStatus(uploadInput);
  assert.equal(afterFailure.symbolUploads?.ios?.status, 'failed');
  assert.equal(afterFailure.symbolUploads?.ios?.failure, 'upload-symbols exited with code 3');
  assert.deepEqual(
    readFileSync(path.join(home, 'upload-args.txt'), 'utf8').trim().split('\n'),
    ['-gsp', realpathSync(plist), '-p', 'ios', realpathSync(dsymZip)],
    'upload-symbols gets the recorded plist and archive, and no store credential',
  );
  assert.equal(statSync(tool).mode & 0o111, 0, 'the recorded tool is not modified');

  rmSync(path.join(home, 'fail'));
  const uploaded = await uploadRecordedCrashSymbols(uploadInput, darwinPorts);
  assert.equal(uploaded.status, 'uploaded');
  assert.match(uploaded.status === 'uploaded' ? uploaded.output : '', /Successfully uploaded/u);
  const afterUpload = await readNativeReleaseStatus(uploadInput);
  assert.equal(afterUpload.symbolUploads?.ios?.status, 'uploaded');
  assert.equal(afterUpload.symbolUploads?.ios?.failure, undefined);
  rmSync(path.join(home, 'upload-args.txt'));
  const again = await uploadRecordedCrashSymbols(uploadInput, darwinPorts);
  assert.equal(again.status, 'already-uploaded');
  assert.equal(existsSync(path.join(home, 'upload-args.txt')), false, 'an upload is done once');
  await assert.rejects(
    recordCrashSymbolUpload({
      ...uploadInput,
      buildRunId: 'ios-run',
      dsymArchiveSha256: sha256(dsymZip),
      status: 'failed',
      failure: 'late failure',
    }),
    /already uploaded/u,
  );
  await assert.rejects(
    recordCrashSymbolUpload({
      ...uploadInput,
      buildRunId: 'other-run',
      dsymArchiveSha256: sha256(dsymZip),
      status: 'uploaded',
    }),
    /immutable iOS build record/u,
  );

  // The deploy-run step never throws, even when the release cannot be read.
  const unreadable: string[] = [];
  const skipped = await uploadCrashSymbolsForDeployRun(
    { ...uploadInput, releaseKey: 'missing-release' },
    (message) => unreadable.push(message),
  );
  assert.equal(skipped, undefined);
  assert.match(
    unreadable.join('\n'),
    /did not run \(The requested native release has not been reserved/u,
  );
  // An Android-only release has no dSYMs to upload.
  const notApplicable = await uploadRecordedCrashSymbols(
    { ...uploadInput, dryRun: true },
    {
      ...darwinPorts,
      readStatus: async (input) => {
        const status = await readNativeReleaseStatus(input);
        const { crashlyticsSymbols: _symbols, ...withoutSymbols } = status.builds.ios ?? iosBuilt.record;
        return { ...status, builds: { ios: withoutSymbols } };
      },
    },
  );
  assert.equal(notApplicable.status, 'not-applicable');

  // A tampered stored upload record makes the release state unreadable.
  const tamperCheckout = path.join(fixture, 'tamper');
  git(['clone', '-q', '--branch', 'release-state', bare, tamperCheckout], fixture);
  const stateFile = path.join(tamperCheckout, 'mpgd-release-state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.games.alpha.symbolUploads['beta-01/ios'].dsymArchiveSha256 = '0'.repeat(64);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qam',
      'tamper',
    ],
    tamperCheckout,
  );
  git(['push', '-q', 'origin', 'HEAD:release-state'], tamperCheckout);
  await assert.rejects(readNativeReleaseStatus(uploadInput), /invalid dSYM upload/u);
  console.info('native crash symbols tests passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

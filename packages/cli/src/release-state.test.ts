import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertReleaseManifest } from '@mpgd/release-manifest';
import { formatMpgdReleaseId, type PlatformVersionLedger } from '@mpgd/target-config';

import { recordNativeReleaseBuild, reserveNativeRelease } from './release-state.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-release-state-test-'));
const bare = path.join(fixture, 'remote.git');
const game = path.join(fixture, 'game');
const stateObject = 'refs/heads/release-state:mpgd-release-state.json';
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
  git(['init', '--bare', '-q', bare], fixture);
  git(['init', '-q', game], fixture);
  git(['remote', 'add', 'origin', bare], game);
  writeFileSync(path.join(game, 'package.json'), '{"name":"state-test"}\n');
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
  const gameSha = git(['rev-parse', 'HEAD'], game);
  const kitSha = 'b'.repeat(40);
  const digest = 'c'.repeat(64);
  const initialLedger: PlatformVersionLedger = {
    schemaVersion: 2,
    platforms: { android: { versionCode: 40 }, ios: { buildNumber: 50 } },
    releaseRevision: { lastAllocated: 0 },
  };
  const firstInput = {
    gameRoot: game,
    releaseKey: 'beta-01',
    gameId: 'alpha',
    gameVersion: '1.0.0',
    sourceGitSha: gameSha,
    kitGitSha: kitSha,
    targetConfigDigest: digest,
    targets: [{ target: 'android' as const }, { target: 'ios' as const }],
    initialLedger,
    environment: { ...process.env, MPGD_API_TOKEN: gameSha[0] },
  };
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, targets: [{ target: 'web-preview' }] }),
    /require Android or iOS/u,
  );
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, initialLedger: undefined }),
    /explicit initial platform version ledger/u,
  );
  const first = await reserveNativeRelease(firstInput);
  assert.equal(first.reused, false);
  assert.equal(first.plan.targets.android?.versionCode, 41);
  assert.equal(first.plan.targets.ios?.buildNumber, 51);
  assert.equal(git(['rev-parse', 'refs/heads/release-state'], bare), first.stateCommit);
  const stateJson = git(['show', stateObject], bare);
  const stored = JSON.parse(stateJson);
  assert.equal(stored.games.alpha.ledger.platforms.android.versionCode, 41);
  assert.equal(stored.games.alpha.reservations['beta-01'].buildId, first.plan.buildId);

  const retried = await reserveNativeRelease(firstInput);
  assert.equal(retried.reused, true);
  assert.equal(retried.stateCommit, first.stateCommit);
  assert.deepEqual(retried.plan, first.plan);
  await assert.rejects(
    reserveNativeRelease({
      ...firstInput,
      targets: [{ target: 'android' }],
      initialLedger: undefined,
    }),
    /cannot change its target set/u,
  );
  writeFileSync(path.join(game, 'package.json'), '{"name":"state-test","revision":2}\n');
  git(['add', '.'], game);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'next game source',
    ],
    game,
  );
  const nextGameSha = git(['rev-parse', 'HEAD'], game);
  const second = await reserveNativeRelease({
    ...firstInput,
    releaseKey: 'beta-02',
    sourceGitSha: nextGameSha,
    initialLedger: undefined,
  });
  assert.equal(second.plan.targets.android?.versionCode, 42);
  assert.equal(second.plan.targets.ios?.buildNumber, 52);
  assert.notEqual(second.stateCommit, first.stateCommit);
  if (process.platform !== 'win32') {
    const realGit = gitBinaryPath();
    const fakeBin = path.join(fixture, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeGit = path.join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!/usr/bin/env node
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
const real = process.env.MPGD_REAL_GIT;
if (args[0] === 'push' && process.env.MPGD_FAKE_PUSH_MODE === 'conflict') {
  const rival = fs.mkdtempSync(path.join(os.tmpdir(), 'mpgd-rival-'));
  try {
    const run = (a) => {
      const result = cp.spawnSync(real, a, { stdio: 'ignore' });
      if (result.status !== 0) process.exit(9);
    };
    run(['clone', '-q', '-b', 'release-state', process.env.MPGD_STATE_REMOTE, rival]);
    fs.writeFileSync(path.join(rival, 'rival.txt'), 'concurrent writer');
    run(['-C', rival, 'add', 'rival.txt']);
    run(['-C', rival, '-c', 'user.name=rival', '-c', 'user.email=rival@example.invalid',
      'commit', '-qm', 'concurrent update']);
    run(['-C', rival, 'push', 'origin', 'HEAD:refs/heads/release-state']);
  } finally { fs.rmSync(rival, { recursive: true, force: true }); }
}
const result = cp.spawnSync(real, args, { stdio: 'inherit' });
if (args[0] === 'push' && process.env.MPGD_FAKE_PUSH_MODE === 'lost') process.exit(1);
process.exit(result.status ?? 1);
`);
    chmodSync(fakeGit, 0o755);
    const fakeEnvironment = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      MPGD_REAL_GIT: realGit,
      MPGD_STATE_REMOTE: bare,
    };
    await assert.rejects(
      reserveNativeRelease({
        ...firstInput,
        releaseKey: 'beta-03',
        sourceGitSha: nextGameSha,
        initialLedger: undefined,
        environment: { ...fakeEnvironment, MPGD_FAKE_PUSH_MODE: 'conflict' },
      }),
      /conflicted or has an uncertain result/u,
    );
    const afterConflictText = git(['show', stateObject], bare);
    const afterConflict = JSON.parse(afterConflictText);
    assert.equal(afterConflict.games.alpha.ledger.platforms.android.versionCode, 42);
    assert.equal(afterConflict.games.alpha.reservations['beta-03'], undefined);
    const recovered = await reserveNativeRelease({
      ...firstInput,
      releaseKey: 'beta-03',
      sourceGitSha: nextGameSha,
      initialLedger: undefined,
    });
    assert.equal(recovered.plan.targets.android?.versionCode, 43);
    const lostResponse = await reserveNativeRelease({
      ...firstInput,
      releaseKey: 'beta-04',
      sourceGitSha: nextGameSha,
      initialLedger: undefined,
      environment: {
        ...fakeEnvironment,
        MPGD_FAKE_PUSH_MODE: 'lost',
        GIT_DIR: path.join(fixture, 'not-a-git-repository'),
      },
    });
    assert.equal(lostResponse.plan.targets.android?.versionCode, 44);
    const retriedLost = await reserveNativeRelease({
      ...firstInput,
      releaseKey: 'beta-04',
      sourceGitSha: nextGameSha,
      initialLedger: undefined,
    });
    assert.equal(retriedLost.reused, true);
    assert.equal(retriedLost.plan.targets.android?.versionCode, 44);
  }
  const fetchMirror = path.join(fixture, 'read-only-fetch.git');
  const pushOrigin = path.join(fixture, 'writable-push.git');
  git(['clone', '--bare', '-q', bare, fetchMirror], fixture);
  git(['clone', '--bare', '-q', bare, pushOrigin], fixture);
  git(['config', 'remote.origin.url', fetchMirror], game);
  git(['config', 'remote.origin.pushurl', pushOrigin], game);
  const pushedSeparately = await reserveNativeRelease({
    ...firstInput,
    releaseKey: 'push-url-test',
    sourceGitSha: nextGameSha,
    initialLedger: undefined,
  });
  assert.equal(
    git(['rev-parse', 'refs/heads/release-state'], pushOrigin),
    pushedSeparately.stateCommit,
  );
  assert.notEqual(
    git(['rev-parse', 'refs/heads/release-state'], fetchMirror),
    pushedSeparately.stateCommit,
  );
  const secondPush = await reserveNativeRelease({
    ...firstInput,
    releaseKey: 'push-url-test-2',
    sourceGitSha: nextGameSha,
    initialLedger: undefined,
  });
  assert.equal(
    secondPush.plan.targets.android?.versionCode,
    Number(pushedSeparately.plan.targets.android?.versionCode) + 1,
  );
  assert.equal(git(['rev-parse', 'refs/heads/release-state'], pushOrigin), secondPush.stateCommit);
  git(['config', 'remote.origin.url', bare], game);
  git(['config', '--unset', 'remote.origin.pushurl'], game);
  const nestedGame = path.join(game, 'games', 'nested');
  mkdirSync(nestedGame, { recursive: true });
  git(['config', 'remote.origin.url', '../remote.git'], game);
  const nestedRelease = await reserveNativeRelease({
    ...firstInput,
    gameRoot: nestedGame,
    releaseKey: 'nested-relative-remote',
    sourceGitSha: nextGameSha,
    initialLedger: undefined,
  });
  assert.equal(git(['rev-parse', 'refs/heads/release-state'], bare), nestedRelease.stateCommit);
  git(['config', 'remote.origin.url', bare], game);
  const unsignedState = await reserveNativeRelease({
    ...firstInput,
    releaseKey: 'unsigned-state-commit',
    sourceGitSha: nextGameSha,
    initialLedger: undefined,
    environment: {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: path.join(fixture, 'unavailable-hook-directory'),
      GIT_DEFAULT_HASH: 'sha256',
      GIT_NAMESPACE: 'unrelated-test-namespace',
    },
  });
  assert.match(unsignedState.stateCommit, /^[a-f0-9]{40}$/u);
  assert.equal(git(['rev-parse', 'refs/heads/release-state'], bare), unsignedState.stateCommit);
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, gameVersion: '1.0.1', initialLedger: undefined }),
    /immutable|match|identity/u,
  );

  const artifactFile = path.join(fixture, 'game.aab');
  const releaseManifestFile = path.join(fixture, 'release-manifest.json');
  writeFileSync(artifactFile, 'signed candidate');
  writeFileSync(releaseManifestFile, `${JSON.stringify({
    releaseId: formatMpgdReleaseId(first.plan.releaseLabel, first.plan.buildId),
    gitSha: first.plan.sourceGitSha,
    kitGitSha: first.plan.kitGitSha,
    buildId: first.plan.buildId,
    gameVersion: first.plan.gameVersion,
    targetConfigVersion: '1',
    catalogVersion: '1',
    adPlacementVersion: '1',
    releaseIdentity: {
      gameVersion: first.plan.gameVersion,
      releaseRevision: first.plan.releaseRevision,
      label: first.plan.releaseLabel,
    },
    targets: {
      android: {
        artifact: 'game.aab',
        effectiveConfig: { path: 'effective.json', version: '1', digest },
        iconManifest: {
          path: 'icons.json', digest, sourceSha256: digest,
          sharedConfigSha256: digest, renderConfigSha256: digest,
          generatorVersion: '1', targetProfile: 'android', targetProfileVersion: '1',
        },
        profile: 'production',
        versionCode: first.plan.targets.android?.versionCode,
        versionName: first.plan.targets.android?.versionName,
        nativeDelivery: {
          platform: 'android',
          mode: 'signed-archive',
          signed: true,
          submissionCandidate: true,
        },
      },
    },
  })}\n`);
  const buildInput = {
    gameRoot: game,
    gameId: 'alpha',
    releaseKey: 'beta-01',
    target: 'android' as const,
    buildRunId: 'run-123',
    kitPackageVersion: '0.35.0',
    buildConfigDigest: 'f'.repeat(64),
    artifactFile,
    expectedArtifactSha256: sha256(artifactFile),
    artifactLocation: 'release-output/android/game.aab',
    releaseManifestFile,
    expectedReleaseManifestSha256: sha256(releaseManifestFile),
    inspectedAppId: 'dev.mpgd.alpha',
    inspectedSignerSha256: 'E'.repeat(64),
  };
  await assert.rejects(
    recordNativeReleaseBuild({ ...buildInput, kitPackageVersion: '  ' }),
    /missing a run ID/u,
  );
  const validManifestBytes = readFileSync(releaseManifestFile);
  assert.doesNotThrow(() => assertReleaseManifest(JSON.parse(validManifestBytes.toString('utf8'))));
  const incompleteManifest = JSON.parse(validManifestBytes.toString('utf8'));
  delete incompleteManifest.targets.android.iconManifest;
  assert.throws(() => assertReleaseManifest(incompleteManifest));
  writeFileSync(releaseManifestFile, `${JSON.stringify(incompleteManifest)}\n`);
  await assert.rejects(
    recordNativeReleaseBuild({
      ...buildInput,
      expectedReleaseManifestSha256: sha256(releaseManifestFile),
    }),
    /iconManifest|expected|property/u,
  );
  writeFileSync(releaseManifestFile, validManifestBytes);
  const built = await recordNativeReleaseBuild(buildInput);
  assert.match(built.record.artifactSha256, /^[a-f0-9]{64}$/u);
  assert.equal(built.record.inspectedSignerSha256, 'e'.repeat(64));
  assert.equal(built.record.gameVersion, '1.0.0');
  assert.equal(built.record.platformVersion.versionCode, 41);
  const repeated = await recordNativeReleaseBuild(buildInput);
  assert.deepEqual(repeated, built);
  const iosArtifactFile = path.join(fixture, 'game.ipa');
  const iosManifestFile = path.join(fixture, 'ios-release-manifest.json');
  writeFileSync(iosArtifactFile, 'signed iOS candidate');
  writeFileSync(iosManifestFile, `${JSON.stringify({
    releaseId: formatMpgdReleaseId(first.plan.releaseLabel, first.plan.buildId),
    gitSha: first.plan.sourceGitSha,
    kitGitSha: first.plan.kitGitSha,
    buildId: first.plan.buildId,
    gameVersion: first.plan.gameVersion,
    targetConfigVersion: '1',
    catalogVersion: '1',
    adPlacementVersion: '1',
    releaseIdentity: {
      gameVersion: first.plan.gameVersion,
      releaseRevision: first.plan.releaseRevision,
      label: first.plan.releaseLabel,
    },
    targets: {
      ios: {
        artifact: 'game.ipa',
        effectiveConfig: { path: 'effective.json', version: '1', digest },
        iconManifest: {
          path: 'icons.json', digest, sourceSha256: digest,
          sharedConfigSha256: digest, renderConfigSha256: digest,
          generatorVersion: '1', targetProfile: 'ios', targetProfileVersion: '1',
        },
        profile: 'production',
        buildNumber: String(first.plan.targets.ios?.buildNumber),
        marketingVersion: first.plan.targets.ios?.marketingVersion,
        nativeDelivery: {
          platform: 'ios',
          mode: 'store-export',
          signed: true,
          submissionCandidate: true,
        },
      },
    },
  })}\n`);
  const iosBuilt = await recordNativeReleaseBuild({
    ...buildInput,
    target: 'ios',
    artifactFile: iosArtifactFile,
    expectedArtifactSha256: sha256(iosArtifactFile),
    artifactLocation: 'release-output/ios/game.ipa',
    releaseManifestFile: iosManifestFile,
    expectedReleaseManifestSha256: sha256(iosManifestFile),
    inspectedAppId: 'dev.mpgd.alpha.ios',
    inspectedSignerSha256: undefined,
    inspectedTeamId: 'ABCDEFGHIJ',
  });
  assert.equal(iosBuilt.record.platformVersion.buildNumber, 51);
  assert.equal(iosBuilt.record.inspectedTeamId, 'ABCDEFGHIJ');
  writeFileSync(artifactFile, 'different bytes');
  await assert.rejects(recordNativeReleaseBuild(buildInput), /differs from the verified build/u);
  await assert.rejects(
    recordNativeReleaseBuild({ ...buildInput, expectedArtifactSha256: sha256(artifactFile) }),
    /cannot be replaced/u,
  );
  writeFileSync(artifactFile, 'signed candidate');
  await assert.rejects(
    recordNativeReleaseBuild({ ...buildInput, buildRunId: 'different-build' }),
    /cannot be replaced/u,
  );
  const recordState = JSON.parse(git(['show', stateObject], bare));
  assert.equal(Object.keys(recordState.games.alpha.builds).length, 2);
  assert.equal(
    recordState.games.alpha.builds['beta-01/android'].artifactSha256,
    built.record.artifactSha256,
  );
  assert.equal(
    readFileSync(path.join(game, 'package.json'), 'utf8'),
    '{"name":"state-test","revision":2}\n',
  );
  const stateEdit = path.join(fixture, 'state-edit');
  git(['clone', '-q', '--branch', 'release-state', bare, stateEdit], fixture);
  const stateFile = path.join(stateEdit, 'mpgd-release-state.json');
  const reordered = JSON.parse(readFileSync(stateFile, 'utf8'));
  const buildRecord = reordered.games.alpha.builds['beta-01/android'];
  reordered.games.alpha.builds['beta-01/android'] = Object.fromEntries(
    Object.entries(buildRecord).reverse(),
  );
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'reorder build record fields',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  const reorderedRetry = await recordNativeReleaseBuild(buildInput);
  assert.deepEqual(reorderedRetry.record, built.record);
  reordered.games.alpha.builds['beta-01/android'].kitPackageVersion = '';
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'corrupt stored Kit version',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  await assert.rejects(recordNativeReleaseBuild(buildInput), /invalid build record/u);
  reordered.games.alpha.builds['beta-01/android'].kitPackageVersion = '0.35.0';
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'restore stored Kit version',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  reordered.games.alpha.reservations['beta-01'].targets.ios.buildNumber = 50;
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'corrupt reserved iOS build number',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  await assert.rejects(recordNativeReleaseBuild(buildInput), /truncated ios history/u);
  reordered.games.alpha.reservations['beta-01'].targets.ios.buildNumber = 51;
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'restore reserved iOS build number',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  reordered.games.alpha.reservations['beta-01'].targets = null;
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'corrupt reservation shape',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, initialLedger: undefined }),
    /invalid reservation beta-01/u,
  );
  reordered.games.alpha.reservations = {};
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'drop all reservation history',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, initialLedger: undefined }),
    /no reservation history/u,
  );
  reordered.games.alpha.reservations = {
    'beta-02': recordState.games.alpha.reservations['beta-02'],
  };
  reordered.games.alpha.builds = {};
  writeFileSync(stateFile, `${JSON.stringify(reordered)}\n`);
  git(['add', '.'], stateEdit);
  git(
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'drop first reservation',
    ],
    stateEdit,
  );
  git(['push', 'origin', 'HEAD:release-state'], stateEdit);
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, initialLedger: undefined }),
    /truncated reservation history/u,
  );
  console.info('Git-backed release reservation and immutable build record passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function gitBinaryPath(): string {
  const result = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

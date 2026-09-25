import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PlatformVersionLedger } from '@mpgd/target-config';

import { recordNativeReleaseBuild, reserveNativeRelease } from './release-state.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-release-state-test-'));
const bare = path.join(fixture, 'remote.git');
const game = path.join(fixture, 'game');
const stateObject = 'refs/heads/release-state:mpgd-release-state.json';

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
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
  await assert.rejects(
    reserveNativeRelease({ ...firstInput, gameVersion: '1.0.1', initialLedger: undefined }),
    /immutable|match|identity/u,
  );

  const artifactFile = path.join(fixture, 'game.aab');
  const releaseManifestFile = path.join(fixture, 'release-manifest.json');
  writeFileSync(artifactFile, 'signed candidate');
  writeFileSync(releaseManifestFile, `${JSON.stringify({
    gitSha: first.plan.sourceGitSha,
    kitGitSha: first.plan.kitGitSha,
    buildId: first.plan.buildId,
    gameVersion: first.plan.gameVersion,
    releaseIdentity: {
      gameVersion: first.plan.gameVersion,
      releaseRevision: first.plan.releaseRevision,
      label: first.plan.releaseLabel,
    },
    targets: {
      android: {
        artifact: 'game.aab',
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
    inspectedSignerSha256: 'e'.repeat(64),
  };
  const built = await recordNativeReleaseBuild(buildInput);
  assert.match(built.record.artifactSha256, /^[a-f0-9]{64}$/u);
  assert.equal(built.record.gameVersion, '1.0.0');
  assert.equal(built.record.platformVersion.versionCode, 41);
  const repeated = await recordNativeReleaseBuild(buildInput);
  assert.deepEqual(repeated, built);
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
  assert.equal(Object.keys(recordState.games.alpha.builds).length, 1);
  assert.equal(
    recordState.games.alpha.builds['beta-01/android'].artifactSha256,
    built.record.artifactSha256,
  );
  assert.equal(
    readFileSync(path.join(game, 'package.json'), 'utf8'),
    '{"name":"state-test","revision":2}\n',
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

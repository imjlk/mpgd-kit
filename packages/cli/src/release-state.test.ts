import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PlatformVersionLedger } from '@mpgd/target-config';

import { recordNativeReleaseBuild, reserveNativeRelease } from './release-state.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-release-state-test-'));
const bare = path.join(fixture, 'remote.git');
const game = path.join(fixture, 'game');

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
  const stateJson = git(['show', 'refs/heads/release-state:mpgd-release-state.json'], bare);
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
  const second = await reserveNativeRelease({
    ...firstInput,
    releaseKey: 'beta-02',
    sourceGitSha: 'd'.repeat(40),
    initialLedger: undefined,
  });
  assert.equal(second.plan.targets.android?.versionCode, 42);
  assert.equal(second.plan.targets.ios?.buildNumber, 52);
  assert.notEqual(second.stateCommit, first.stateCommit);
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
  const recordState = JSON.parse(
    git(['show', 'refs/heads/release-state:mpgd-release-state.json'], bare),
  );
  assert.equal(Object.keys(recordState.games.alpha.builds).length, 1);
  assert.equal(
    recordState.games.alpha.builds['beta-01/android'].artifactSha256,
    built.record.artifactSha256,
  );
  assert.equal(readFileSync(path.join(game, 'package.json'), 'utf8'), '{"name":"state-test"}\n');
  console.info('Git-backed release reservation and immutable build record passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

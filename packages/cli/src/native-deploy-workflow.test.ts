import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeNativeDeployWorkflow } from './native-deploy-workflow.js';

const fixture = mkdtempSync(join(tmpdir(), 'mpgd-native-deploy-workflow-'));
try {
  const repo = join(fixture, 'multi-game');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const game = join(repo, 'games', 'alpha');
  createGame(game);
  const file = initializeNativeDeployWorkflow({
    game,
    profile: 'beta',
    releaseBranch: 'main',
    targets: ['android', 'ios'],
    approvalEnvironment: 'protected-beta',
  });
  const workflow = readFileSync(file, 'utf8');
  assert.match(file, /\.github\/workflows\/mpgd-native-games-alpha-[a-f0-9]{8}\.yml$/u);
  assert.match(workflow, /'games\/alpha\/\*\*'/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: 'protected-beta'/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /deploy_android:/u);
  assert.match(workflow, /deploy_ios:/u);
  assert.match(workflow, /runs-on: macos-26/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /actions\/download-artifact@v7/u);
  assert.match(workflow, /artifact_run_id:/u);
  assert.match(workflow, /MPGD_GAMES_ALPHA_[A-F0-9]{8}_ANDROID_KEYSTORE_B64/u);
  assert.match(workflow, /MPGD_GAMES_ALPHA_[A-F0-9]{8}_IOS_P12_B64/u);
  assert.match(workflow, /export MPGD_ANDROID_UPLOAD_KEYSTORE=/u);
  assert.match(workflow, /export MPGD_IOS_SIGNING_P12=/u);
  assert.match(workflow, /MPGD_DEPENDENCY_INSTALL_ENV_NAMES=NPM_TOKEN/u);
  assert.match(workflow, /GIT_CONFIG_VALUE_0=/u);
  assert.match(workflow, /retention-days: 30/u);
  assert.match(workflow, /retention-days: 90/u);
  assert.match(workflow, /include-hidden-files: true/u);
  assert.equal(workflow.split('  deploy_android:')[0]?.includes('secrets.'), false);
  assert.equal(workflow.includes('pull_request_target'), false);
  assert.equal(workflow.includes('cancel-in-progress: true'), false);
  assertGeneratedShellParses(workflow);
  const repeatedInput = {
    game,
    profile: 'beta',
    releaseBranch: 'main',
    targets: ['android', 'ios'] as const,
  };
  assert.throws(() => initializeNativeDeployWorkflow(repeatedInput), /EEXIST/u);
  const unsafeBranchInput = {
    game,
    profile: 'beta',
    releaseBranch: '../feature',
    targets: ['android'] as const,
  };
  const unsafeBranch = (): string => initializeNativeDeployWorkflow(unsafeBranchInput);
  assert.throws(unsafeBranch, /release branch is invalid/u);

  const singleRepo = join(fixture, 'single-game');
  mkdirSync(singleRepo);
  execFileSync('git', ['init', '-q', singleRepo]);
  createGame(singleRepo);
  const singleInput = {
    game: singleRepo,
    profile: 'beta',
    releaseBranch: 'release/main',
    targets: ['ios'] as const,
  };
  const singleFile = initializeNativeDeployWorkflow(singleInput);
  const singleWorkflow = readFileSync(singleFile, 'utf8');
  assert.match(singleWorkflow, /GAME_PATH: '\.'/u);
  assert.match(singleWorkflow, /github\.ref == 'refs\/heads\/release\/main'/u);
  assert.equal(singleWorkflow.includes('deploy_android:'), false);
  assertGeneratedShellParses(singleWorkflow);

  const linkedRepo = join(fixture, 'linked-workflow');
  mkdirSync(linkedRepo);
  execFileSync('git', ['init', '-q', linkedRepo]);
  createGame(linkedRepo);
  symlinkSync(fixture, join(linkedRepo, '.github'), 'dir');
  const linkedInput = {
    game: linkedRepo,
    profile: 'beta',
    releaseBranch: 'main',
    targets: ['android'] as const,
  };
  assert.throws(() => initializeNativeDeployWorkflow(linkedInput), /must not be symlinks/u);
  const reservedRepo = join(fixture, 'reserved-env');
  mkdirSync(reservedRepo);
  execFileSync('git', ['init', '-q', reservedRepo]);
  createGame(reservedRepo);
  const deployFile = join(reservedRepo, 'mpgd.deploy.json');
  const config = JSON.parse(readFileSync(deployFile, 'utf8'));
  config.profiles.beta.targets.android.signingCredential.env = 'PATH';
  writeFileSync(deployFile, `${JSON.stringify(config)}\n`);
  const reservedInput = {
    game: reservedRepo,
    profile: 'beta',
    releaseBranch: 'main',
    targets: ['android'] as const,
  };
  assert.throws(() => initializeNativeDeployWorkflow(reservedInput), /reserved by CI/u);
  console.info('Game-owned native deployment workflow scaffolding passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function createGame(game: string): void {
  mkdirSync(join(game, 'apps', 'mobile'), { recursive: true });
  writeFileSync(join(game, 'apps', 'mobile', 'package.json'), '{"name":"mobile"}\n');
  writeFileSync(join(game, 'mpgd.targets.json'), `${JSON.stringify({
    targets: {
      android: {
        kind: 'capacitor-android', adapter: 'capacitor', artifact: 'aab',
        gameApp: '.', shellApp: 'apps/mobile', webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.alpha' },
      },
      ios: {
        kind: 'capacitor-ios', adapter: 'capacitor', artifact: 'ipa',
        gameApp: '.', shellApp: 'apps/mobile', webDir: 'apps/mobile/www',
        metadata: { bundleId: 'dev.mpgd.alpha' },
      },
    },
  })}\n`);
  writeFileSync(join(game, 'mpgd.deploy.json'), `${JSON.stringify({
    schemaVersion: 1,
    profiles: {
      beta: {
        buildProfile: 'production', approval: 'manual',
        targets: {
          android: {
            destination: 'play-internal',
            signingCredential: { env: 'MPGD_ANDROID_UPLOAD_KEYSTORE' },
            submissionCredential: { env: 'MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT' },
          },
          ios: {
            destination: 'testflight', testGroup: 'group-1',
            signingCredential: { env: 'MPGD_IOS_SIGNING_P12' },
            submissionCredential: { env: 'MPGD_ASC_API_KEY' },
          },
        },
      },
    },
  })}\n`);
}

function assertGeneratedShellParses(workflow: string): void {
  const lines = workflow.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '        run: |') {
      continue;
    }
    const script: string[] = [];
    for (let line = index + 1; line < lines.length; line += 1) {
      const next = lines[line];
      if (next === undefined || !next.startsWith('          ')) {
        break;
      }
      script.push(next.slice(10));
    }
    const result = spawnSync('bash', ['-n'], { input: script.join('\n'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

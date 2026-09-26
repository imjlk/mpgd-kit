import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { planNativeDeployment } from './deploy-planning.js';
import {
  installPinnedReleaseDependencies,
  pinNativeDeploymentPlan,
  preparePinnedReleaseWorkspace,
  runPinnedNativeBuild,
  withPinnedReleaseWorkspace,
  type PinnedReleaseWorkspace,
} from './release-workspace.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-release-workspace-test-'));
const repository = path.join(fixture, 'repository');
const game = path.join(repository, 'games/alpha');
const workspaces = path.join(fixture, 'workspaces');

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

try {
  mkdirSync(game, { recursive: true });
  mkdirSync(path.join(repository, 'games/beta'), { recursive: true });
  mkdirSync(path.join(repository, 'packages/shared'), { recursive: true });
  mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
  mkdirSync(workspaces);
  writeJson(path.join(repository, 'package.json'), {
    name: 'game-workspace',
    private: true,
    version: '1.0.0',
  });
  writeFileSync(path.join(repository, 'pnpm-workspace.yaml'), [
    'packages:', "  - 'games/*'", "  - 'packages/*'", '',
  ].join('\n'));
  writeJson(path.join(repository, 'packages/shared/package.json'), {
    name: '@fixture/shared',
    version: '1.0.0',
    main: 'index.js',
  });
  writeFileSync(path.join(repository, 'packages/shared/index.js'), 'export const value = 1;\n');
  writeJson(path.join(game, 'package.json'), {
    name: 'alpha',
    version: '1.0.0',
    devDependencies: { '@fixture/shared': 'workspace:*' },
  });
  writeJson(path.join(game, 'apps/mobile/package.json'), {
    name: 'alpha-mobile',
    private: true,
  });
  writeJson(path.join(repository, 'games/beta/package.json'), {
    name: 'beta',
    version: '1.0.0',
  });
  writeJson(path.join(game, 'mpgd.targets.json'), {
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        artifact: 'aab',
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.alpha' },
      },
    },
  });
  writeJson(path.join(game, 'mpgd.deploy.json'), {
    schemaVersion: 1,
    profiles: {
      beta: {
        buildProfile: 'production',
        approval: 'manual',
        targets: {
          android: {
            destination: 'play-internal',
            signingCredential: { env: 'MPGD_ANDROID_UPLOAD_KEYSTORE' },
            submissionCredential: { env: 'MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT' },
          },
        },
      },
    },
  });
  run('pnpm', ['install', '--lockfile-only'], repository);
  run('git', ['init', '-q'], repository);
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'pinned fixture',
    ],
    repository,
  );
  const plan = planNativeDeployment({ game, profile: 'beta' });
  const committedTargets = readFileSync(path.join(game, 'mpgd.targets.json'));
  const input = await pinNativeDeploymentPlan(plan, {
    packageVersion: '0.35.0',
    gitSha: 'a'.repeat(40),
  });
  assert.equal(input.gameGitSha, run('git', ['rev-parse', 'HEAD'], repository));
  assert.equal(input.lockfileSha256, sha256(path.join(repository, 'pnpm-lock.yaml')));
  const first = await preparePinnedReleaseWorkspace(input, { temporaryParent: workspaces });
  const second = await preparePinnedReleaseWorkspace(input, { temporaryParent: workspaces });
  assert.notEqual(first.workspaceRoot, second.workspaceRoot);
  assert.equal(
    readFileSync(path.join(first.workspaceRoot, 'packages/shared/index.js'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(existsSync(path.join(first.workspaceRoot, 'games/beta/package.json')), true);
  const committedLockfile = readFileSync(path.join(repository, 'pnpm-lock.yaml'));
  writeFileSync(
    path.join(repository, 'pnpm-lock.yaml'),
    `${committedLockfile.toString('utf8')}# dirty\n`,
  );
  await assert.rejects(
    pinNativeDeploymentPlan(plan, { packageVersion: '0.35.0', gitSha: 'a'.repeat(40) }),
    /Pinned release inputs have uncommitted changes/u,
  );
  writeFileSync(path.join(repository, 'pnpm-lock.yaml'), committedLockfile);
  writeFileSync(path.join(repository, 'packages/shared/index.js'), 'export const value = 2;\n');
  await assert.rejects(
    pinNativeDeploymentPlan(plan, { packageVersion: '0.35.0', gitSha: 'a'.repeat(40) }),
    /Pinned release inputs have uncommitted changes/u,
  );
  writeFileSync(path.join(repository, 'packages/shared/index.js'), 'export const value = 1;\n');
  const untrackedSource = path.join(game, 'new-game-source.ts');
  writeFileSync(untrackedSource, 'export const newGameSource = true;\n');
  await assert.rejects(
    pinNativeDeploymentPlan(plan, { packageVersion: '0.35.0', gitSha: 'a'.repeat(40) }),
    /Pinned release inputs have uncommitted changes/u,
  );
  rmSync(untrackedSource);
  writeFileSync(path.join(repository, 'packages/shared/index.js'), 'export const value = 2;\n');
  writeFileSync(path.join(game, 'mpgd.targets.json'), '{"changed":true}\n');
  await assert.rejects(
    pinNativeDeploymentPlan(plan, { packageVersion: '0.35.0', gitSha: 'a'.repeat(40) }),
    /mpgd\.targets\.json|differs from the current/u,
  );
  assert.equal(
    readFileSync(path.join(first.workspaceRoot, 'packages/shared/index.js'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(sha256(path.join(first.gameRoot, 'mpgd.targets.json')), input.targetConfigSha256);
  await installPinnedReleaseDependencies(first, {
    environment: { ...process.env, npm_config_production: 'true' },
  });
  const cliRoot = path.join(first.gameRoot, 'node_modules/@mpgd/cli');
  mkdirSync(path.join(cliRoot, 'dist'), { recursive: true });
  writeJson(path.join(cliRoot, 'package.json'), {
    name: '@mpgd/cli',
    version: input.kitPackageVersion,
    exports: { '.': './dist/index.js' },
    bin: { mpgd: './dist/bin.js' },
  });
  writeFileSync(path.join(cliRoot, 'dist/index.js'), 'module.exports = {};\n');
  writeJson(path.join(cliRoot, 'dist/native-build-info.json'), {
    packageVersion: input.kitPackageVersion,
    kitGitSha: input.kitGitSha,
    kitDirty: false,
  });
  const targetConfigRoot = path.join(first.gameRoot, 'node_modules/@mpgd/target-config');
  mkdirSync(targetConfigRoot, { recursive: true });
  writeJson(path.join(targetConfigRoot, 'package.json'), {
    name: '@mpgd/target-config',
    exports: { './targets.json': './targets.json' },
  });
  writeJson(path.join(targetConfigRoot, 'targets.json'), { targets: {} });
  writeFileSync(path.join(cliRoot, 'dist/bin.js'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.MPGD_KIT_PATH || process.env.MPGD_CLI_ARGV
  || process.env.MPGD_NATIVE_BUILD_MODE !== 'signed-archive'
  || process.env.MPGD_SOURCE_GIT_SHA !== process.env.MPGD_FAKE_GAME_SHA) process.exit(4);
if (!process.env.TMPDIR.startsWith(process.env.MPGD_FAKE_WORKSPACE_ROOT)) process.exit(5);
fs.writeFileSync(path.join(process.env.TMPDIR, 'owned-temporary-file'), 'temporary');
if (process.env.MPGD_FAKE_NO_WRITE === '1') process.exit(0);
const target = process.argv[4];
const gameRoot = process.cwd();
const artifact = 'release-output/native/' + target + '/game.aab';
fs.mkdirSync(path.join(gameRoot, path.dirname(artifact)), { recursive: true });
fs.writeFileSync(path.join(gameRoot, artifact), 'signed test fixture');
const status = path.join(gameRoot, 'artifacts/native-build-status', target + '.json');
fs.mkdirSync(path.dirname(status), { recursive: true });
fs.writeFileSync(status, JSON.stringify({ target, status: 'success', runId: 'current-run', artifact }));
const manifest = path.join(gameRoot, 'artifacts/release-manifest.json');
fs.writeFileSync(manifest, JSON.stringify({
  gitSha: process.env.MPGD_FAKE_GAME_SHA,
  kitGitSha: process.env.MPGD_FAKE_KIT_SHA,
  targets: { [target]: { artifact, profile: 'production' } },
}));
`);
  const externalTemporary = path.join(fixture, 'external-temporary');
  mkdirSync(externalTemporary);
  const buildEnvironment = {
    ...process.env,
    TMPDIR: externalTemporary,
    TMP: externalTemporary,
    TEMP: externalTemporary,
    MPGD_KIT_PATH: '/invalid/checkout',
    MPGD_CLI_ARGV: '["deploy","run"]',
    MPGD_FAKE_GAME_SHA: input.gameGitSha,
    MPGD_FAKE_KIT_SHA: input.kitGitSha,
    MPGD_FAKE_WORKSPACE_ROOT: first.workspaceRoot,
  };
  const built = await runPinnedNativeBuild(first, {
    target: 'android',
    profile: 'production',
    mode: 'signed-archive',
    environment: buildEnvironment,
  });
  assert.equal(built.runId, 'current-run');
  assert.equal(existsSync(built.artifact), true);
  assert.deepEqual(readdirSync(externalTemporary), []);
  assert.deepEqual(
    readdirSync(first.workspaceRoot).filter((entry) => entry.startsWith('mpgd-native-tmp-')),
    [],
  );
  await assert.rejects(
    runPinnedNativeBuild(first, {
      target: 'android',
      profile: 'beta',
      mode: 'signed-archive',
      environment: buildEnvironment,
    }),
    /match the pinned deployment plan/u,
  );
  await assert.rejects(
    runPinnedNativeBuild(first, {
      target: 'ios',
      profile: 'production',
      mode: 'store-export',
      environment: buildEnvironment,
    }),
    /match the pinned deployment plan/u,
  );
  for (const override of [
    'MPGD_PRODUCT_CATALOG_FILE',
    'MPGD_AD_PLACEMENTS_FILE',
    'MPGD_TARGET_CONFIG_EXTENSIONS_FILE',
    'MPGD_RELEASE_MANIFEST_FILE',
    'MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR',
    'MPGD_ICON_MANIFEST_PATH',
    'MPGD_ICON_MANIFEST_ARTIFACT_PATH',
  ]) {
    await assert.rejects(
      runPinnedNativeBuild(first, {
        target: 'android',
        profile: 'production',
        mode: 'signed-archive',
        environment: { ...buildEnvironment, [override]: path.join(game, 'external.json') },
      }),
      /cannot use MPGD_/u,
    );
  }
  await assert.rejects(
    runPinnedNativeBuild(first, {
      target: 'android',
      profile: 'production',
      mode: 'signed-archive',
      environment: { ...buildEnvironment, MPGD_FAKE_NO_WRITE: '1' },
    }),
    /current attempt/u,
  );
  assert.deepEqual(
    readdirSync(first.workspaceRoot).filter((entry) => entry.startsWith('mpgd-native-tmp-')),
    [],
  );
  assert.equal(
    realpathSync(path.join(first.gameRoot, 'node_modules/@fixture/shared')),
    realpathSync(path.join(first.workspaceRoot, 'packages/shared')),
  );
  assert.equal(sha256(path.join(first.workspaceRoot, 'pnpm-lock.yaml')), input.lockfileSha256);
  writeFileSync(path.join(first.gameRoot, 'output.txt'), 'isolated output\n');
  assert.equal(existsSync(path.join(game, 'output.txt')), false);
  const externalMatrix = path.join(fixture, 'external-target-config');
  cpSync(targetConfigRoot, externalMatrix, { recursive: true });
  rmSync(targetConfigRoot, { recursive: true });
  symlinkSync(externalMatrix, targetConfigRoot, 'dir');
  await assert.rejects(
    runPinnedNativeBuild(first, {
      target: 'android',
      profile: 'production',
      mode: 'signed-archive',
      environment: buildEnvironment,
    }),
    /target-config matrix resolves outside the pinned checkout/u,
  );
  unlinkSync(targetConfigRoot);
  cpSync(externalMatrix, targetConfigRoot, { recursive: true });
  const externalCli = path.join(fixture, 'external-cli');
  cpSync(cliRoot, externalCli, { recursive: true });
  rmSync(cliRoot, { recursive: true });
  symlinkSync(externalCli, cliRoot, 'dir');
  await assert.rejects(
    runPinnedNativeBuild(first, {
      target: 'android',
      profile: 'production',
      mode: 'signed-archive',
      environment: buildEnvironment,
    }),
    /CLI package resolves outside the pinned checkout/u,
  );
  first.dispose();
  assert.equal(existsSync(first.workspaceRoot), false);
  assert.equal(existsSync(second.workspaceRoot), true);
  const outsideOutput = path.join(fixture, 'outside-output');
  mkdirSync(outsideOutput);
  for (const name of ['artifacts', 'release-output', 'dist']) {
    const link = path.join(second.gameRoot, name);
    symlinkSync(outsideOutput, link, 'dir');
    await assert.rejects(
      runPinnedNativeBuild(second, {
        target: 'android',
        profile: 'production',
        mode: 'signed-archive',
      }),
      /output path is symlinked/u,
    );
    unlinkSync(link);
  }
  const externalCatalog = path.join(fixture, 'external-catalog.json');
  writeFileSync(externalCatalog, '{}\n');
  for (const name of ['mpgd.catalog.json', 'mpgd.ad-placements.json']) {
    const link = path.join(second.gameRoot, name);
    symlinkSync(externalCatalog, link);
    await assert.rejects(
      runPinnedNativeBuild(second, {
        target: 'android',
        profile: 'production',
        mode: 'signed-archive',
      }),
      /input path is symlinked/u,
    );
    unlinkSync(link);
  }
  const externalGenerated = path.join(fixture, 'external-generated.json');
  writeFileSync(externalGenerated, 'untouched\n');
  const generatedLink = path.join(second.gameRoot, '.mpgd.targets.generated.json');
  symlinkSync(externalGenerated, generatedLink);
  await assert.rejects(
    runPinnedNativeBuild(second, {
      target: 'android',
      profile: 'production',
      mode: 'signed-archive',
    }),
    /output path is symlinked/u,
  );
  assert.equal(readFileSync(externalGenerated, 'utf8'), 'untouched\n');
  unlinkSync(generatedLink);
  mkdirSync(path.join(second.gameRoot, 'artifacts'));
  const nestedLink = path.join(second.gameRoot, 'artifacts', 'native-build-status');
  symlinkSync(outsideOutput, nestedLink, 'dir');
  await assert.rejects(
    runPinnedNativeBuild(second, {
      target: 'android',
      profile: 'production',
      mode: 'signed-archive',
    }),
    /output path is symlinked/u,
  );
  assert.deepEqual(readdirSync(outsideOutput), []);
  second.dispose();
  assert.deepEqual(readdirSync(workspaces), []);

  const failBuild = async (workspace: PinnedReleaseWorkspace): Promise<void> => {
    assert.equal(existsSync(workspace.gameRoot), true);
    throw new Error('simulated build failure');
  };
  const failedWorkspace = withPinnedReleaseWorkspace(input, failBuild, {
    temporaryParent: workspaces,
  });
  await assert.rejects(failedWorkspace, /simulated build failure/u);
  assert.deepEqual(readdirSync(workspaces), []);

  await assert.rejects(
    preparePinnedReleaseWorkspace(
      {
        ...input,
        lockfileSha256: 'b'.repeat(64),
      },
      { temporaryParent: workspaces },
    ),
    /pnpm-lock.yaml/u,
  );
  assert.deepEqual(readdirSync(workspaces), []);
  writeFileSync(path.join(game, 'mpgd.targets.json'), committedTargets);
  const linkedLockfile = path.join(fixture, 'linked-lockfile.yaml');
  writeFileSync(linkedLockfile, committedLockfile);
  unlinkSync(path.join(repository, 'pnpm-lock.yaml'));
  symlinkSync(linkedLockfile, path.join(repository, 'pnpm-lock.yaml'));
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'symlinked release lockfile',
    ],
    repository,
  );
  const linkedPlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  await assert.rejects(
    pinNativeDeploymentPlan(linkedPlan, {
      packageVersion: '0.35.0',
      gitSha: 'a'.repeat(40),
    }),
    /input path is symlinked/u,
  );
  await assert.rejects(
    preparePinnedReleaseWorkspace(
      { ...input, gameGitSha: run('git', ['rev-parse', 'HEAD'], repository) },
      { temporaryParent: workspaces },
    ),
    /input path is symlinked/u,
  );
  unlinkSync(path.join(repository, 'pnpm-lock.yaml'));
  writeFileSync(path.join(repository, 'pnpm-lock.yaml'), committedLockfile);
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'restore lockfile',
    ],
    repository,
  );
  symlinkSync(game, path.join(game, 'linked-app'), 'dir');
  writeJson(path.join(game, 'mpgd.targets.json'), {
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        artifact: 'aab',
        gameApp: 'linked-app',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.alpha' },
      },
    },
  });
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'absolute gameApp symlink',
    ],
    repository,
  );
  const symlinkPlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  const symlinkInput = await pinNativeDeploymentPlan(symlinkPlan, {
    packageVersion: '0.35.0',
    gitSha: 'a'.repeat(40),
  });
  await assert.rejects(
    preparePinnedReleaseWorkspace(symlinkInput, { temporaryParent: workspaces }),
    /gameApp must stay inside the game project/u,
  );
  assert.deepEqual(readdirSync(workspaces), []);
  unlinkSync(path.join(game, 'linked-app'));
  writeFileSync(path.join(game, 'mpgd.targets.json'), committedTargets);
  symlinkSync(externalCatalog, path.join(repository, 'packages/shared/outside-linked.js'));
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'external source symlink',
    ],
    repository,
  );
  const externalPlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  const externalInput = await pinNativeDeploymentPlan(externalPlan, {
    packageVersion: '0.35.0',
    gitSha: 'a'.repeat(40),
  });
  await assert.rejects(
    preparePinnedReleaseWorkspace(externalInput, { temporaryParent: workspaces }),
    /source symlink escapes its checkout/u,
  );
  assert.deepEqual(readdirSync(workspaces), []);
  await assert.rejects(
    preparePinnedReleaseWorkspace(externalInput, {
      temporaryParent: workspaces,
      environment: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.symlinks',
        GIT_CONFIG_VALUE_0: 'false',
      },
    }),
    /source symlink escapes its checkout/u,
  );
  assert.deepEqual(readdirSync(workspaces), []);
  run(
    'git',
    ['update-index', '--add', '--cacheinfo', `160000,${input.gameGitSha},packages/linked-module`],
    repository,
  );
  run(
    'git',
    [
      '-c',
      'user.name=mpgd-test',
      '-c',
      'user.email=mpgd-test@example.invalid',
      'commit',
      '-qm',
      'unsupported submodule',
    ],
    repository,
  );
  const submodulePlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  await assert.rejects(
    pinNativeDeploymentPlan(submodulePlan, {
      packageVersion: '0.35.0',
      gitSha: 'a'.repeat(40),
    }),
    /do not support Git submodules/u,
  );
  console.info('Pinned multi-game release workspace passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

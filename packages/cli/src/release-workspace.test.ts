import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  installPinnedReleaseDependencies,
  preparePinnedReleaseWorkspace,
  type PinnedReleaseInput,
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
    dependencies: { '@fixture/shared': 'workspace:*' },
  });
  writeJson(path.join(repository, 'games/beta/package.json'), {
    name: 'beta',
    version: '1.0.0',
  });
  writeJson(path.join(game, 'mpgd.targets.json'), {
    targets: { android: { kind: 'capacitor-android' } },
  });
  writeJson(path.join(game, 'mpgd.deploy.json'), { schemaVersion: 1 });
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
  const input: PinnedReleaseInput = {
    gameRoot: game,
    gameGitSha: run('git', ['rev-parse', 'HEAD'], repository),
    lockfileSha256: sha256(path.join(repository, 'pnpm-lock.yaml')),
    targetConfigSha256: sha256(path.join(game, 'mpgd.targets.json')),
    deployConfigSha256: sha256(path.join(game, 'mpgd.deploy.json')),
    kitPackageVersion: '0.35.0',
    kitGitSha: 'a'.repeat(40),
  };
  const first = await preparePinnedReleaseWorkspace(input, { temporaryParent: workspaces });
  const second = await preparePinnedReleaseWorkspace(input, { temporaryParent: workspaces });
  assert.notEqual(first.workspaceRoot, second.workspaceRoot);
  assert.equal(
    readFileSync(path.join(first.workspaceRoot, 'packages/shared/index.js'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(existsSync(path.join(first.workspaceRoot, 'games/beta/package.json')), true);
  writeFileSync(path.join(repository, 'packages/shared/index.js'), 'export const value = 2;\n');
  writeFileSync(path.join(game, 'mpgd.targets.json'), '{"changed":true}\n');
  assert.equal(
    readFileSync(path.join(first.workspaceRoot, 'packages/shared/index.js'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(sha256(path.join(first.gameRoot, 'mpgd.targets.json')), input.targetConfigSha256);
  await installPinnedReleaseDependencies(first);
  assert.equal(
    realpathSync(path.join(first.gameRoot, 'node_modules/@fixture/shared')),
    realpathSync(path.join(first.workspaceRoot, 'packages/shared')),
  );
  assert.equal(sha256(path.join(first.workspaceRoot, 'pnpm-lock.yaml')), input.lockfileSha256);
  writeFileSync(path.join(first.gameRoot, 'output.txt'), 'isolated output\n');
  assert.equal(existsSync(path.join(game, 'output.txt')), false);
  first.dispose();
  assert.equal(existsSync(first.workspaceRoot), false);
  assert.equal(existsSync(second.workspaceRoot), true);
  second.dispose();
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
  console.info('Pinned multi-game release workspace passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  describeForeignKitDependencyLinks,
  findForeignKitDependencyLinks,
  findKitDependencyLinks,
  findKitBuildInstallRoot,
  isKitDependencyLinkOwnedBy,
} from './kit-dependency-links.mjs';

test('only the exact install owner suppresses the warning', () => {
  const installRoot = join(tmpdir(), 'game');
  assert.equal(isKitDependencyLinkOwnedBy({ installRoot }, installRoot), true);
  assert.equal(isKitDependencyLinkOwnedBy({ installRoot }, join(installRoot, 'nested-game')), false);
  assert.equal(isKitDependencyLinkOwnedBy({ installRoot, broken: true }, installRoot), false);
  if (process.platform === 'win32') {
    assert.equal(isKitDependencyLinkOwnedBy({ installRoot: 'D:\\game' }, 'C:\\kit'), false);
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-kit-links-'));
  const kit = join(root, 'mpgd-kit');
  const game = join(root, 'game');
  const kitStore = join(kit, 'node_modules/.pnpm/dep@1/node_modules/dep');
  const gameStore = join(game, 'node_modules/.pnpm/@scope+dep@1/node_modules/@scope/dep');
  mkdirSync(kitStore, { recursive: true });
  mkdirSync(gameStore, { recursive: true });
  const nodeModules = join(kit, 'adapters/devvit/node_modules');
  mkdirSync(join(nodeModules, '@scope'), { recursive: true });
  symlinkSync(kitStore, join(nodeModules, 'dep'), 'junction');
  return { root, kit, game, gameStore, nodeModules };
}

test('kit-owned links are not reported', () => {
  const { root, kit } = fixture();
  try {
    assert.deepEqual(findForeignKitDependencyLinks(kit), []);
    assert.equal(describeForeignKitDependencyLinks(kit), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('links into a game install are reported with the fix command', () => {
  const { root, kit, game, gameStore, nodeModules } = fixture();
  try {
    symlinkSync(gameStore, join(nodeModules, '@scope/dep'), 'junction');
    const foreign = findForeignKitDependencyLinks(kit);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].link, join('adapters/devvit/node_modules/@scope/dep'));
    assert.equal(foreign[0].installRoot, realpathSync(game));
    const message = describeForeignKitDependencyLinks(kit, foreign);
    assert.match(message, /pnpm workspace:relink/u);
    assert.ok(message.includes(realpathSync(game)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('links into a game nested inside the kit are reported', () => {
  const { root, kit, nodeModules } = fixture();
  try {
    const nested = join(kit, 'examples/my-game');
    const store = join(nested, 'node_modules/.pnpm/x@1/node_modules/x');
    mkdirSync(store, { recursive: true });
    symlinkSync(store, join(nodeModules, 'x'), 'junction');
    const foreign = findForeignKitDependencyLinks(kit);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].installRoot, realpathSync(nested));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('broken links are reported', () => {
  const { root, kit, game, gameStore, nodeModules } = fixture();
  try {
    symlinkSync(gameStore, join(nodeModules, '@scope/dep'), 'junction');
    rmSync(game, { recursive: true, force: true });
    const foreign = findForeignKitDependencyLinks(kit);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].broken, true);
    assert.match(describeForeignKitDependencyLinks(kit, foreign), /workspace:relink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relink preserves independent apps and examples installs', () => {
  const { root, kit, nodeModules } = fixture();
  try {
    const scriptDir = join(kit, 'tools/workspace');
    mkdirSync(scriptDir, { recursive: true });
    for (const name of ['kit-dependency-links.mjs', 'relink-kit-workspace.mjs']) {
      copyFileSync(new URL(name, import.meta.url), join(scriptDir, name));
    }
    const markers = ['apps/independent', 'examples/independent'].map((game) => {
      const directory = join(kit, game, 'node_modules/local-data');
      mkdirSync(directory, { recursive: true });
      const marker = join(directory, 'keep.txt');
      writeFileSync(marker, 'independent install');
      return marker;
    });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const pnpm = join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    writeFileSync(
      pnpm,
      process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
    );
    chmodSync(pnpm, 0o755);
    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    environment[pathKey] = bin;
    const runRelink = () => spawnSync(process.execPath, [join(scriptDir, 'relink-kit-workspace.mjs')], {
      env: environment,
      encoding: 'utf8',
    });
    const failed = runRelink();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /no dependency link folders were removed/u);
    assert.equal(existsSync(join(nodeModules, 'dep')), true);
    writeFileSync(
      pnpm,
      process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
    );
    const result = runRelink();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(nodeModules), false);
    for (const marker of markers) {
      assert.equal(readFileSync(marker, 'utf8'), 'independent install');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested games use the nearest workspace install owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-workspace-owner-'));
  try {
    const game = join(root, 'games/puzzle-one');
    mkdirSync(game, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - games/*\n');
    writeFileSync(join(game, 'package.json'), '{"name":"puzzle-one"}');
    const entry = { installRoot: realpathSync(root) };
    assert.equal(isKitDependencyLinkOwnedBy(entry, findKitBuildInstallRoot(game)), true);
    writeFileSync(join(game, 'pnpm-workspace.yaml'), 'packages: []\n');
    assert.equal(findKitBuildInstallRoot(game), realpathSync(game));
    assert.equal(isKitDependencyLinkOwnedBy(entry, findKitBuildInstallRoot(game)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner relink rebuilds shared links from the game workspace and preserves unrelated packages', () => {
  const { root, kit, game, gameStore, nodeModules } = fixture();
  try {
    const scriptDir = join(kit, 'tools/workspace');
    mkdirSync(scriptDir, { recursive: true });
    for (const name of ['kit-dependency-links.mjs', 'relink-kit-workspace.mjs']) {
      copyFileSync(new URL(name, import.meta.url), join(scriptDir, name));
    }
    const nested = join(game, 'games/puzzle');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(game, 'pnpm-workspace.yaml'), 'packages: [games/*, ../mpgd-kit/adapters/*]\n');
    const unrelated = join(kit, 'packages/unlisted/node_modules/keep');
    mkdirSync(unrelated, { recursive: true });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'pnpm-stub.cjs');
    writeFileSync(stub, `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(fs.realpathSync(process.cwd()), ${JSON.stringify(realpathSync(game))});
      if (process.argv[2] === 'list') {
        console.log(JSON.stringify([{ path: ${JSON.stringify(join(kit, 'adapters/devvit'))} }]));
      } else if (!process.argv.includes('--ignore-scripts')) {
        assert.equal(fs.existsSync(${JSON.stringify(nodeModules)}), false);
        fs.mkdirSync(${JSON.stringify(nodeModules)}, { recursive: true });
        fs.symlinkSync(${JSON.stringify(gameStore)}, ${JSON.stringify(join(nodeModules, 'dep'))}, 'junction');
      }
    `);
    const pnpm = join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    writeFileSync(pnpm, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
    chmodSync(pnpm, 0o755);
    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    environment[pathKey] = bin;
    const result = spawnSync(process.execPath, [join(scriptDir, 'relink-kit-workspace.mjs'), '--owner', nested], {
      env: environment, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(unrelated), true);
    assert.equal(realpathSync(join(nodeModules, 'dep')), realpathSync(gameStore));
    assert.ok(findKitDependencyLinks(kit).every((entry) => isKitDependencyLinkOwnedBy(entry, realpathSync(game))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('selected workspace warnings include Kit stores but not shared source links', () => {
  const { root, kit, game, nodeModules } = fixture();
  try {
    const scriptDir = join(kit, 'tools/workspace');
    mkdirSync(scriptDir, { recursive: true });
    for (const name of ['kit-dependency-links.mjs', 'relink-kit-workspace.mjs']) {
      copyFileSync(new URL(name, import.meta.url), join(scriptDir, name));
    }
    const nested = join(game, 'games/puzzle-one');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(game, 'pnpm-workspace.yaml'), 'packages: [games/*]\n');
    writeFileSync(join(nested, 'package.json'), '{"name":"puzzle-one"}');
    const run = (...args) => spawnSync(process.execPath, [join(scriptDir, 'relink-kit-workspace.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(findKitDependencyLinks(kit).length, 1);
    const mismatched = run('--warn-unless-owner', nested);
    assert.equal(mismatched.status, 0, mismatched.stderr);
    assert.match(mismatched.stderr, /not owned by the selected build install/);
    assert.ok(mismatched.stderr.includes(realpathSync(game)));
    assert.match(mismatched.stderr, /workspace:relink --owner/);
    const kitCheck = run('--check');
    assert.equal(kitCheck.status, 0, kitCheck.stderr);
    assert.equal(kitCheck.stderr, '');

    const shared = join(kit, 'packages/shared');
    mkdirSync(shared, { recursive: true });
    symlinkSync(shared, join(nodeModules, '@scope/shared'), 'junction');
    assert.equal(findKitDependencyLinks(kit).length, 1, 'shared source is not a dependency install');
    const owned = join(game, 'node_modules/.pnpm/dep@1/node_modules/dep');
    mkdirSync(owned, { recursive: true });
    unlinkSync(join(nodeModules, 'dep'));
    symlinkSync(owned, join(nodeModules, 'dep'), 'junction');
    const matched = run('--warn-unless-owner', nested);
    assert.equal(matched.status, 0, matched.stderr);
    assert.equal(matched.stderr, '', 'the enclosing workspace owns this game install');
    writeFileSync(join(nested, 'pnpm-workspace.yaml'), 'packages: []\n');
    assert.match(run('--warn-unless-owner', nested).stderr, /not owned by the selected build install/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyKitUpgrade, planKitUpgrade, type LatestKitPackageLookup } from './kit-upgrade.js';

const lookup: LatestKitPackageLookup = async (name) => {
  if (name !== '@mpgd/cli' && name !== '@mpgd/adapter-ait') {
    throw new Error('Missing fixture for ' + name);
  }
  return { version: name === '@mpgd/cli' ? '0.34.0' : '0.13.0' };
};

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function gameFixture(name: string): { readonly root: string; readonly game: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), name)));
  const game = path.join(root, 'game');
  mkdirSync(game);
  writeJson(path.join(game, 'package.json'), {
    name: 'sample-game',
    devDependencies: { '@mpgd/cli': '0.33.2' },
  });
  writeFileSync(path.join(game, 'pnpm-lock.yaml'), 'lock before\n');
  return { root, game };
}

await test('does not follow a package.json swapped for a same-bytes symlink', async () => {
  const { root, game } = gameFixture('mpgd-upgrade-link-');
  const manifest = path.join(game, 'package.json');
  const outside = path.join(root, 'outside.json');
  try {
    const plan = await planKitUpgrade(game, lookup);
    const original = readFileSync(manifest, 'utf8');
    writeFileSync(outside, original);
    rmSync(manifest);
    symlinkSync(outside, manifest);
    let ran = false;
    assert.throws(
      () =>
        applyKitUpgrade(plan, () => {
          ran = true;
        }),
      /symbolic link/u,
    );
    assert.equal(ran, false);
    assert.equal(readFileSync(outside, 'utf8'), original);
    assert.equal(lstatSync(manifest).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('does not follow a manifest parent swapped for a symlink', async () => {
  const { root, game } = gameFixture('mpgd-upgrade-parent-link-');
  const wrapper = path.join(game, 'apps', 'target-a');
  const wrapperPackage = path.join(wrapper, 'package.json');
  const outside = path.join(root, 'outside-wrapper');
  try {
    mkdirSync(wrapper, { recursive: true });
    writeJson(wrapperPackage, {
      name: 'sample-wrapper',
      dependencies: { '@mpgd/adapter-ait': '0.12.0' },
    });
    writeJson(path.join(game, 'mpgd.targets.json'), {
      targets: { ait: { wrapperApp: 'apps/target-a' } },
    });
    const plan = await planKitUpgrade(game, lookup);
    const original = readFileSync(wrapperPackage, 'utf8');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'package.json'), original);
    rmSync(wrapper, { recursive: true });
    symlinkSync(outside, wrapper, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => applyKitUpgrade(plan, () => undefined), /symbolic link/u);
    assert.equal(readFileSync(path.join(outside, 'package.json'), 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('does not restore a lockfile through a symlink swapped during apply', async () => {
  const { root, game } = gameFixture('mpgd-upgrade-rollback-link-');
  const lockfile = path.join(game, 'pnpm-lock.yaml');
  const outside = path.join(root, 'outside.lock');
  try {
    const plan = await planKitUpgrade(game, lookup);
    const original = readFileSync(lockfile, 'utf8');
    writeFileSync(outside, 'outside lock\n');
    assert.throws(
      () =>
        applyKitUpgrade(plan, () => {
          rmSync(lockfile);
          symlinkSync(outside, lockfile);
          throw new Error('fixture lockfile failure');
        }),
      /symbolic link/u,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'outside lock\n');
    assert.equal(readFileSync(path.join(game, 'package.json'), 'utf8').includes('0.33.2'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

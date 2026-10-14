import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  describeForeignKitDependencyLinks,
  findForeignKitDependencyLinks,
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

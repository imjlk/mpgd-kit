import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  describeForeignKitDependencyLinks,
  findForeignKitDependencyLinks,
} from './kit-dependency-links.mjs';

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
  symlinkSync(kitStore, join(nodeModules, 'dep'));
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
    symlinkSync(gameStore, join(nodeModules, '@scope/dep'));
    const foreign = findForeignKitDependencyLinks(kit);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].link, join('adapters/devvit/node_modules/@scope/dep'));
    assert.equal(foreign[0].installRoot, game);
    const message = describeForeignKitDependencyLinks(kit, foreign);
    assert.match(message, /pnpm workspace:relink/u);
    assert.match(message, new RegExp(game.replaceAll('/', '\\/'), 'u'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveMiniGameBundleOutput } from './vite.minigame-output';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-minigame-vite-output-'));
const gameRoot = join(fixtureRoot, 'game');
const stagingRoot = join(fixtureRoot, 'staging');

try {
  mkdirSync(join(gameRoot, 'src'), { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  assert.equal(
    resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: join(stagingRoot, 'runtime'),
      stagingRoot,
    }),
    resolve(realpathSync(stagingRoot), 'runtime'),
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: '.',
      stagingRoot: gameRoot,
    }),
    /dedicated child|must not overlap/u,
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: join(gameRoot, 'src'),
      stagingRoot: gameRoot,
    }),
    /must not overlap/u,
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: stagingRoot,
      stagingRoot,
    }),
    /dedicated child/u,
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Mini-game Vite output safety tests passed.');

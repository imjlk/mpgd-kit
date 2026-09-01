import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveMiniGameBundleOutput } from './vite.minigame-output';
import { rewritePhaserMiniGameGlobalFallback } from './vite.minigame-phaser';

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

  const phaserFallback = "return this || new Function('return this')();";
  assert.equal(
    rewritePhaserMiniGameGlobalFallback(`before ${phaserFallback} after`),
    'before return globalThis; after',
  );
  assert.throws(
    () => rewritePhaserMiniGameGlobalFallback('return globalThis;'),
    /Expected exactly one Phaser 4\.2\.0 dynamic global fallback, found 0/u,
  );
  assert.throws(
    () => rewritePhaserMiniGameGlobalFallback(`${phaserFallback}\n${phaserFallback}`),
    /Expected exactly one Phaser 4\.2\.0 dynamic global fallback, found 2/u,
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Mini-game Vite output safety tests passed.');

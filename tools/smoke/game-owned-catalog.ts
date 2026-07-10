import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adPlacementsFilePath, productCatalogFilePath } from '../catalog-paths';
import {
  loadEffectiveTargetConfigMatrix,
  validateEffectiveTargetConfigMatrix,
} from '../target/effective-config';

const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-game-catalog-'));
const catalogFile = join(tempDir, 'mpgd.catalog.json');
const placementsFile = join(tempDir, 'mpgd.ad-placements.json');
const previousCatalogFile = process.env.MPGD_PRODUCT_CATALOG_FILE;
const previousPlacementsFile = process.env.MPGD_AD_PLACEMENTS_FILE;

try {
  writeFileSync(
    catalogFile,
    `${JSON.stringify({
      version: 'game-v1',
      products: [
        {
          id: 'SUDOKU_HINT_PACK',
          type: 'consumable',
          grant: {
            type: 'currency',
            currency: 'gem',
            amount: 5,
          },
          platformProductIds: {
            android: 'android_sudoku_hint_pack',
            ios: 'ios.sudoku.hint-pack',
            ait: 'ait_sudoku_hint_pack',
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    placementsFile,
    `${JSON.stringify({
      version: 'game-ads-v1',
      placements: [
        {
          id: 'SUDOKU_HINT_REWARDED',
          type: 'rewarded',
          reward: {
            type: 'currency',
            currency: 'gem',
            amount: 1,
          },
          frequencyCap: {
            cooldownSeconds: 60,
            maxPerSession: 3,
          },
          platformPlacementIds: {
            android: 'android_sudoku_hint_rewarded',
            ios: 'ios_sudoku_hint_rewarded',
            ait: 'ait_sudoku_hint_rewarded',
          },
        },
        {
          id: 'SUDOKU_STAGE_END_INTERSTITIAL',
          type: 'interstitial',
          frequencyCap: {
            cooldownSeconds: 120,
            minStageInterval: 3,
          },
          platformPlacementIds: {
            android: 'android_sudoku_stage_end',
            ios: 'ios_sudoku_stage_end',
            ait: 'ait_sudoku_stage_end',
          },
        },
      ],
    }, null, 2)}\n`,
  );

  process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
  process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;

  assert.equal(productCatalogFilePath(), catalogFile);
  assert.equal(adPlacementsFilePath(), placementsFile);
  assert.match(runValidator('tools/validate-product-catalog.ts'), /Product catalog game-v1/u);
  assert.match(runValidator('tools/validate-ad-placements.ts'), /Ad placements game-ads-v1/u);

  const matrix = validateEffectiveTargetConfigMatrix(loadEffectiveTargetConfigMatrix());

  assert.match(matrix.version, /catalog\.game-v1/u);
  assert.match(matrix.version, /ads\.game-ads-v1/u);
  const ait = matrix.targets.ait;

  assert.ok(ait !== undefined, 'Expected "ait" target in the config matrix');
  assert.deepEqual(ait.monetization.products, [
    {
      id: 'SUDOKU_HINT_PACK',
      type: 'consumable',
      grant: {
        type: 'currency',
        currency: 'gem',
        amount: 5,
      },
      enabled: true,
      reason: 'available',
      platformProductId: 'ait_sudoku_hint_pack',
    },
  ]);
  assert.deepEqual(ait.ads.placements, [
    {
      id: 'SUDOKU_HINT_REWARDED',
      type: 'rewarded',
      reward: {
        type: 'currency',
        currency: 'gem',
        amount: 1,
      },
      frequencyCap: {
        cooldownSeconds: 60,
        maxPerSession: 3,
      },
      enabled: true,
      reason: 'available',
      platformPlacementId: 'ait_sudoku_hint_rewarded',
    },
    {
      id: 'SUDOKU_STAGE_END_INTERSTITIAL',
      type: 'interstitial',
      frequencyCap: {
        cooldownSeconds: 120,
        minStageInterval: 3,
      },
      enabled: true,
      reason: 'available',
      platformPlacementId: 'ait_sudoku_stage_end',
    },
  ]);
} finally {
  restoreEnv('MPGD_PRODUCT_CATALOG_FILE', previousCatalogFile);
  restoreEnv('MPGD_AD_PLACEMENTS_FILE', previousPlacementsFile);
  rmSync(tempDir, { force: true, recursive: true });
}

console.log('Game-owned product catalog and ad placements smoke passed.');

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function runValidator(script: string): string {
  const result = spawnSync(process.execPath, ['tools/run-ttsx.mjs', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

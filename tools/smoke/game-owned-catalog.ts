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

writeFileSync(catalogFile, `${JSON.stringify({ version: 'game-v1', products: [] }, null, 2)}\n`);
writeFileSync(
  placementsFile,
  `${JSON.stringify({ version: 'game-ads-v1', placements: [] }, null, 2)}\n`,
);

try {
  process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
  process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;

  assert.equal(productCatalogFilePath(), catalogFile);
  assert.equal(adPlacementsFilePath(), placementsFile);
  assert.match(runValidator('tools/validate-product-catalog.ts'), /Product catalog game-v1/u);
  assert.match(runValidator('tools/validate-ad-placements.ts'), /Ad placements game-ads-v1/u);

  const matrix = validateEffectiveTargetConfigMatrix(loadEffectiveTargetConfigMatrix());

  assert.match(matrix.version, /catalog\.game-v1/u);
  assert.match(matrix.version, /ads\.game-ads-v1/u);
  assert.deepEqual(matrix.targets.ait?.monetization.products, []);
  assert.deepEqual(matrix.targets.ait?.ads.placements, []);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

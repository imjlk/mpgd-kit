import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReleaseManifest } from '@mpgd/release-manifest';

const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-release-manifest-'));
const firstCatalogFile = join(tempDir, 'catalog-v1.json');
const secondCatalogFile = join(tempDir, 'catalog-v2.json');
const placementsFile = join(tempDir, 'placements.json');
const manifestFile = join(tempDir, 'release-manifest.json');
const matchingManifestFile = join(tempDir, 'matching-release-manifest.json');
const effectiveConfigDir = join(tempDir, 'target-config');

try {
  writeFileSync(firstCatalogFile, catalogJson('game-v1'));
  writeFileSync(secondCatalogFile, catalogJson('game-v2'));
  writeFileSync(placementsFile, placementsJson('ads-v1'));

  runManifest('web-preview', firstCatalogFile, matchingManifestFile);
  runManifest('microsoft-store', firstCatalogFile, matchingManifestFile);

  const matchingManifest = readManifest(matchingManifestFile);

  assert.deepEqual(Object.keys(matchingManifest.targets).sort(), [
    'microsoft-store',
    'web-preview',
  ]);

  runManifest('web-preview', firstCatalogFile, manifestFile);
  runManifest('microsoft-store', secondCatalogFile, manifestFile);

  const manifest = readManifest(manifestFile);

  assert.equal(manifest.catalogVersion, 'game-v2');
  assert.equal(manifest.gitSha, 'game-source-sha');
  assert.deepEqual(Object.keys(manifest.targets), ['microsoft-store']);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

console.log('Release manifest merge resets when the monetization contract changes.');

function runManifest(target: string, catalogFile: string, outputFile: string): void {
  const result = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      'tools/target/generate-release-manifest.ts',
      target,
      'production',
      `artifacts/${target}`,
      outputFile,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_VERSION: '1.0.0',
        BUILD_ID: 'manifest-merge-smoke',
        MPGD_PRODUCT_CATALOG_FILE: catalogFile,
        MPGD_AD_PLACEMENTS_FILE: placementsFile,
        MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: effectiveConfigDir,
        MPGD_SOURCE_GIT_SHA: 'game-source-sha',
      },
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  assert.equal(
    result.status,
    0,
    `Manifest subprocess exited with status ${String(result.status)}:\n${result.stderr || result.stdout || '(no output)'}`,
  );
}

function readManifest(path: string): ReleaseManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
}

function catalogJson(version: string): string {
  return `${JSON.stringify({ version, products: [] }, null, 2)}\n`;
}

function placementsJson(version: string): string {
  return `${JSON.stringify({ version, placements: [] }, null, 2)}\n`;
}

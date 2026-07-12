import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { ReleaseManifest } from '@mpgd/release-manifest';

const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-release-manifest-'));
const firstCatalogFile = join(tempDir, 'catalog-v1.json');
const secondCatalogFile = join(tempDir, 'catalog-v2.json');
const placementsFile = join(tempDir, 'placements.json');
const manifestFile = join(tempDir, 'release-manifest.json');
const matchingManifestFile = join(tempDir, 'matching-release-manifest.json');
const kitMismatchManifestFile = join(tempDir, 'kit-mismatch-release-manifest.json');
const snapshotManifestFile = join(tempDir, 'snapshot-release-manifest.json');
const failedGitManifestFile = join(tempDir, 'failed-git-release-manifest.json');
const emptyGitManifestFile = join(tempDir, 'empty-git-release-manifest.json');
const effectiveConfigDir = join(tempDir, 'target-config');
const fakeGitDir = join(tempDir, 'bin');
const firstKitGitSha = '1111111111111111111111111111111111111111';
const secondKitGitSha = '2222222222222222222222222222222222222222';
let manifestRunCount = 0;

try {
  writeFakeGit();
  assertKitGitShaSchema();
  writeFileSync(firstCatalogFile, catalogJson('game-v1'));
  writeFileSync(secondCatalogFile, catalogJson('game-v2'));
  writeFileSync(placementsFile, placementsJson('ads-v1'));

  runManifest('web-preview', firstCatalogFile, matchingManifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, matchingManifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });

  const matchingManifest = readManifest(matchingManifestFile);

  assert.equal(matchingManifest.gitSha, 'game-source-sha');
  assert.equal(matchingManifest.kitGitSha, firstKitGitSha);
  assert.match(matchingManifest.kitGitSha, /^[0-9a-f]{40}$/u);
  assert.deepEqual(Object.keys(matchingManifest.targets).sort(), [
    'microsoft-store',
    'web-preview',
  ]);

  runManifest('web-preview', firstCatalogFile, manifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', secondCatalogFile, manifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });

  const manifest = readManifest(manifestFile);

  assert.equal(manifest.catalogVersion, 'game-v2');
  assert.equal(manifest.gitSha, 'game-source-sha');
  assert.equal(manifest.kitGitSha, firstKitGitSha);
  assert.deepEqual(Object.keys(manifest.targets), ['microsoft-store']);

  runManifest('web-preview', firstCatalogFile, kitMismatchManifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, kitMismatchManifestFile, {
    kitGitShas: [secondKitGitSha],
    sourceGitSha: 'game-source-sha',
  });

  const kitMismatchManifest = readManifest(kitMismatchManifestFile);

  assert.equal(kitMismatchManifest.gitSha, 'game-source-sha');
  assert.equal(kitMismatchManifest.kitGitSha, secondKitGitSha);
  assert.deepEqual(Object.keys(kitMismatchManifest.targets), ['microsoft-store']);

  const kitRevisionReadCount = runManifest('web-preview', firstCatalogFile, snapshotManifestFile, {
    kitGitShas: [firstKitGitSha, secondKitGitSha],
  });
  const snapshotManifest = readManifest(snapshotManifestFile);

  assert.equal(kitRevisionReadCount, 1);
  assert.equal(snapshotManifest.gitSha, firstKitGitSha);
  assert.equal(snapshotManifest.kitGitSha, firstKitGitSha);

  const failedGitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    failedGitManifestFile,
    {
      gitExitCode: 65,
      kitGitShas: [firstKitGitSha],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(failedGitOutput, /Failed to resolve the mpgd-kit Git revision\./u);
  assert.equal(existsSync(failedGitManifestFile), false);

  const emptyGitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    emptyGitManifestFile,
    {
      kitGitShas: [''],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(emptyGitOutput, /mpgd-kit Git revision must be a full 40-character SHA/u);
  assert.equal(existsSync(emptyGitManifestFile), false);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

console.log('Release manifest merge preserves matching targets and resets on contract changes.');

interface RunManifestOptions {
  readonly gitExitCode?: number;
  readonly kitGitShas: readonly [string, string?];
  readonly sourceGitSha?: string;
}

function runManifest(
  target: string,
  catalogFile: string,
  outputFile: string,
  options: RunManifestOptions,
): number {
  const { gitReadCount, result } = spawnManifest(target, catalogFile, outputFile, options);

  assert.equal(
    result.status,
    0,
    `Manifest subprocess exited with status ${String(result.status)}:\n${result.stderr || result.stdout || '(no output)'}`,
  );

  return gitReadCount;
}

function runManifestExpectFailure(
  target: string,
  catalogFile: string,
  outputFile: string,
  options: RunManifestOptions,
): string {
  const { result } = spawnManifest(target, catalogFile, outputFile, options);

  assert.notEqual(result.status, 0, 'Manifest subprocess unexpectedly succeeded.');
  return result.stderr || result.stdout || '(no output)';
}

function spawnManifest(
  target: string,
  catalogFile: string,
  outputFile: string,
  options: RunManifestOptions,
) {
  manifestRunCount += 1;
  const gitCounterFile = join(tempDir, `git-read-count-${manifestRunCount}.txt`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_VERSION: '1.0.0',
    BUILD_ID: 'manifest-merge-smoke',
    MPGD_PRODUCT_CATALOG_FILE: catalogFile,
    MPGD_AD_PLACEMENTS_FILE: placementsFile,
    MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: effectiveConfigDir,
    MPGD_TEST_GIT_COUNTER_FILE: gitCounterFile,
    MPGD_TEST_GIT_EXIT_CODE: String(options.gitExitCode ?? 0),
    MPGD_TEST_GIT_SHA_FIRST: options.kitGitShas[0],
    MPGD_TEST_GIT_SHA_LATER: options.kitGitShas[1] ?? options.kitGitShas[0],
    PATH: [fakeGitDir, process.env.PATH].filter(Boolean).join(delimiter),
  };

  if (options.sourceGitSha === undefined) {
    delete env.MPGD_SOURCE_GIT_SHA;
  } else {
    env.MPGD_SOURCE_GIT_SHA = options.sourceGitSha;
  }

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
      env,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  assert.equal(
    existsSync(gitCounterFile),
    true,
    'The fake git executable did not record a revision read.',
  );

  return {
    gitReadCount: Number.parseInt(readFileSync(gitCounterFile, 'utf8').trim(), 10),
    result,
  };
}

function writeFakeGit(): void {
  mkdirSync(fakeGitDir, { recursive: true });
  const fakeGitPath = join(fakeGitDir, 'git');

  writeFileSync(
    fakeGitPath,
    `#!/bin/sh
set -eu
if [ "$#" -ne 2 ] || [ "$1" != "rev-parse" ] || [ "$2" != "HEAD" ]; then
  exit 64
fi
count=0
if [ -f "$MPGD_TEST_GIT_COUNTER_FILE" ]; then
  count=$(cat "$MPGD_TEST_GIT_COUNTER_FILE")
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$MPGD_TEST_GIT_COUNTER_FILE"
if [ "$MPGD_TEST_GIT_EXIT_CODE" -ne 0 ]; then
  exit "$MPGD_TEST_GIT_EXIT_CODE"
fi
if [ "$count" -eq 1 ]; then
  printf '%s\\n' "$MPGD_TEST_GIT_SHA_FIRST"
else
  printf '%s\\n' "$MPGD_TEST_GIT_SHA_LATER"
fi
`,
  );
  chmodSync(fakeGitPath, 0o755);
}

function readManifest(path: string): ReleaseManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
}

function assertKitGitShaSchema(): void {
  const schema = JSON.parse(readFileSync('release.manifest.schema.json', 'utf8')) as {
    readonly required?: readonly string[];
    readonly properties?: {
      readonly kitGitSha?: {
        readonly type?: string;
        readonly pattern?: string;
      };
    };
  };
  const kitGitShaSchema = schema.properties?.kitGitSha;

  assert.equal(schema.required?.includes('kitGitSha'), true);
  assert.deepEqual(kitGitShaSchema, {
    type: 'string',
    pattern: '^[0-9a-f]{40}$',
  });

  const kitGitShaPattern = new RegExp(kitGitShaSchema.pattern, 'u');

  assert.match(firstKitGitSha, kitGitShaPattern);
  assert.doesNotMatch(firstKitGitSha.slice(1), kitGitShaPattern);
}

function catalogJson(version: string): string {
  return `${JSON.stringify({ version, products: [] }, null, 2)}\n`;
}

function placementsJson(version: string): string {
  return `${JSON.stringify({ version, placements: [] }, null, 2)}\n`;
}

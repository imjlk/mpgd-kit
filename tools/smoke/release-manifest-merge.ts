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

import { assertReleaseManifest, type ReleaseManifest } from '@mpgd/release-manifest';

const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-release-manifest-'));
const firstCatalogFile = join(tempDir, 'catalog-v1.json');
const secondCatalogFile = join(tempDir, 'catalog-v2.json');
const placementsFile = join(tempDir, 'placements.json');
const iconManifestFile = join(tempDir, 'icon-manifest.json');
const manifestFile = join(tempDir, 'release-manifest.json');
const matchingManifestFile = join(tempDir, 'matching-release-manifest.json');
const kitMismatchManifestFile = join(tempDir, 'kit-mismatch-release-manifest.json');
const iconMismatchManifestFile = join(tempDir, 'icon-mismatch-release-manifest.json');
const iconConfigMismatchManifestFile = join(tempDir, 'icon-config-mismatch-release-manifest.json');
const targetRenderOverrideManifestFile = join(
  tempDir,
  'target-render-override-release-manifest.json',
);
const snapshotManifestFile = join(tempDir, 'snapshot-release-manifest.json');
const failedGitManifestFile = join(tempDir, 'failed-git-release-manifest.json');
const emptyGitManifestFile = join(tempDir, 'empty-git-release-manifest.json');
const stagedGitManifestFile = join(tempDir, 'staged-git-release-manifest.json');
const untrackedGitManifestFile = join(tempDir, 'untracked-git-release-manifest.json');
const nestedKitManifestFile = join(tempDir, 'nested-kit-release-manifest.json');
const mismatchedKitPathManifestFile = join(tempDir, 'mismatched-kit-path-release-manifest.json');
const generatedBeforeProvenanceManifestFile = join(
  tempDir,
  'generated-before-provenance-release-manifest.json',
);
const effectiveConfigDir = join(tempDir, 'target-config');
const generatedBeforeProvenanceDir = join(tempDir, 'generated-before-provenance');
const nestedKitParent = join(tempDir, 'game-repository');
const fakeGitDir = join(tempDir, 'bin');
const firstKitGitSha = '1111111111111111111111111111111111111111';
const secondKitGitSha = '2222222222222222222222222222222222222222';
let manifestRunCount = 0;

try {
  writeFakeGit();
  assertKitGitShaSchema();
  mkdirSync(nestedKitParent);
  writeFileSync(firstCatalogFile, catalogJson('game-v1'));
  writeFileSync(secondCatalogFile, catalogJson('game-v2'));
  writeFileSync(placementsFile, placementsJson('ads-v1'));
  writeFileSync(iconManifestFile, iconManifestJson());

  runManifest('web-preview', firstCatalogFile, matchingManifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, matchingManifestFile, {
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });

  const matchingManifest = readManifest(matchingManifestFile);

  assertManifestMatchesTopLevelSchema(matchingManifest);
  assert.equal(matchingManifest.gitSha, 'game-source-sha');
  assert.equal(matchingManifest.kitGitSha, firstKitGitSha);
  assert.match(matchingManifest.kitGitSha, /^[0-9a-f]{40}$/u);
  for (const invalidKitGitSha of [
    'dirty',
    'a'.repeat(39),
    'a'.repeat(41),
    'g'.repeat(40),
    'A'.repeat(40),
    `${firstKitGitSha} `,
  ]) {
    assert.throws(
      () => assertReleaseManifest({ ...matchingManifest, kitGitSha: invalidKitGitSha }),
      /kitGitSha must be a lowercase 40-character SHA/u,
    );
  }
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

  runManifest('web-preview', firstCatalogFile, iconMismatchManifestFile, {
    iconSourceSha: 'a'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, iconMismatchManifestFile, {
    iconSourceSha: 'b'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  assert.deepEqual(Object.keys(readManifest(iconMismatchManifestFile).targets), [
    'microsoft-store',
  ]);

  runManifest('web-preview', firstCatalogFile, iconConfigMismatchManifestFile, {
    iconSharedConfigSha: 'c'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, iconConfigMismatchManifestFile, {
    iconSharedConfigSha: 'd'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  assert.deepEqual(Object.keys(readManifest(iconConfigMismatchManifestFile).targets), [
    'microsoft-store',
  ]);

  runManifest('web-preview', firstCatalogFile, targetRenderOverrideManifestFile, {
    iconRenderConfigSha: 'e'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  runManifest('microsoft-store', firstCatalogFile, targetRenderOverrideManifestFile, {
    iconRenderConfigSha: 'f'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  assert.deepEqual(Object.keys(readManifest(targetRenderOverrideManifestFile).targets).sort(), [
    'microsoft-store',
    'web-preview',
  ]);
  runManifest('web-preview', firstCatalogFile, targetRenderOverrideManifestFile, {
    iconRenderConfigSha: '1'.repeat(64),
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  assert.deepEqual(Object.keys(readManifest(targetRenderOverrideManifestFile).targets), [
    'web-preview',
  ]);

  const kitRevisionReadCount = runManifest('web-preview', firstCatalogFile, snapshotManifestFile, {
    kitGitShas: [firstKitGitSha, secondKitGitSha],
  });
  const snapshotManifest = readManifest(snapshotManifestFile);

  assert.equal(kitRevisionReadCount, 1);
  assert.equal(snapshotManifest.gitSha, firstKitGitSha);
  assert.equal(snapshotManifest.kitGitSha, firstKitGitSha);

  const generatedEffectiveConfigFile = join(generatedBeforeProvenanceDir, 'web-preview.json');

  runManifest('web-preview', firstCatalogFile, generatedBeforeProvenanceManifestFile, {
    dirtyWhenPathExists: generatedEffectiveConfigFile,
    effectiveConfigDir: generatedBeforeProvenanceDir,
    kitGitShas: [firstKitGitSha],
    sourceGitSha: 'game-source-sha',
  });
  assert.equal(existsSync(generatedEffectiveConfigFile), true);

  const failedGitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    failedGitManifestFile,
    {
      expectedGitReadCount: 1,
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
      expectedGitReadCount: 1,
      kitGitShas: [''],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(emptyGitOutput, /mpgd-kit Git revision must be a full 40-character SHA/u);
  assert.equal(existsSync(emptyGitManifestFile), false);

  const stagedGitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    stagedGitManifestFile,
    {
      expectedGitReadCount: 0,
      gitStatusOutput: 'M  packages/release-manifest/src/index.ts',
      kitGitShas: [firstKitGitSha],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(stagedGitOutput, /mpgd-kit Git worktree must be clean/u);
  assert.equal(existsSync(stagedGitManifestFile), false);

  const untrackedGitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    untrackedGitManifestFile,
    {
      expectedGitReadCount: 0,
      gitStatusOutput: '?? release-output/untracked-artifact.js',
      kitGitShas: [firstKitGitSha],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(untrackedGitOutput, /mpgd-kit Git worktree must be clean/u);
  assert.equal(existsSync(untrackedGitManifestFile), false);

  const nestedKitOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    nestedKitManifestFile,
    {
      expectedGitReadCount: 0,
      gitTopLevel: nestedKitParent,
      kitGitShas: [firstKitGitSha],
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(nestedKitOutput, /MPGD_KIT_PATH must point to the root of its own Git checkout/u);
  assert.equal(existsSync(nestedKitManifestFile), false);

  const mismatchedKitPathOutput = runManifestExpectFailure(
    'web-preview',
    firstCatalogFile,
    mismatchedKitPathManifestFile,
    {
      expectedGitReadCount: 0,
      kitGitShas: [firstKitGitSha],
      kitPath: nestedKitParent,
      sourceGitSha: 'game-source-sha',
    },
  );

  assert.match(mismatchedKitPathOutput, /MPGD_KIT_PATH must match the mpgd-kit execution root/u);
  assert.equal(existsSync(mismatchedKitPathManifestFile), false);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

console.log('Release manifest merge preserves matching targets and resets on contract changes.');

interface RunManifestOptions {
  readonly dirtyWhenPathExists?: string;
  readonly effectiveConfigDir?: string;
  readonly expectedGitReadCount?: number;
  readonly gitExitCode?: number;
  readonly gitStatusOutput?: string;
  readonly gitTopLevel?: string;
  readonly iconRenderConfigSha?: string;
  readonly iconSharedConfigSha?: string;
  readonly iconSourceSha?: string;
  readonly kitGitShas: readonly [string, string?];
  readonly kitPath?: string;
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
  const { gitReadCount, result } = spawnManifest(target, catalogFile, outputFile, options);

  assert.notEqual(result.status, 0, 'Manifest subprocess unexpectedly succeeded.');

  if (options.expectedGitReadCount !== undefined) {
    assert.equal(gitReadCount, options.expectedGitReadCount);
  }

  return result.stderr || result.stdout || '(no output)';
}

function spawnManifest(
  target: string,
  catalogFile: string,
  outputFile: string,
  options: RunManifestOptions,
) {
  manifestRunCount += 1;
  writeFileSync(
    iconManifestFile,
    iconManifestJson({
      renderConfigSha: options.iconRenderConfigSha,
      sharedConfigSha: options.iconSharedConfigSha,
      sourceSha: options.iconSourceSha,
    }),
  );
  const gitCounterFile = join(tempDir, `git-read-count-${manifestRunCount}.txt`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_VERSION: '1.0.0',
    BUILD_ID: 'manifest-merge-smoke',
    MPGD_PRODUCT_CATALOG_FILE: catalogFile,
    MPGD_AD_PLACEMENTS_FILE: placementsFile,
    MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: options.effectiveConfigDir ?? effectiveConfigDir,
    MPGD_ICON_MANIFEST_PATH: iconManifestFile,
    MPGD_KIT_PATH: options.kitPath ?? process.cwd(),
    MPGD_TEST_DIRTY_WHEN_PATH_EXISTS: options.dirtyWhenPathExists ?? '',
    MPGD_TEST_GIT_COUNTER_FILE: gitCounterFile,
    MPGD_TEST_GIT_EXIT_CODE: String(options.gitExitCode ?? 0),
    MPGD_TEST_GIT_STATUS_OUTPUT: options.gitStatusOutput ?? '',
    MPGD_TEST_GIT_TOP_LEVEL: options.gitTopLevel ?? process.cwd(),
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
      'nested/mpgd-icon-manifest.json',
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

  return {
    gitReadCount: existsSync(gitCounterFile)
      ? Number.parseInt(readFileSync(gitCounterFile, 'utf8').trim(), 10)
      : 0,
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
if [ "$#" -eq 2 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  printf '%s\\n' "$MPGD_TEST_GIT_TOP_LEVEL"
  exit 0
fi
if [ "$#" -eq 2 ] && [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then
  if [ -n "$MPGD_TEST_GIT_STATUS_OUTPUT" ]; then
    printf '%s\\n' "$MPGD_TEST_GIT_STATUS_OUTPUT"
  fi
  if [ -n "$MPGD_TEST_DIRTY_WHEN_PATH_EXISTS" ] && [ -e "$MPGD_TEST_DIRTY_WHEN_PATH_EXISTS" ]; then
    printf '?? %s\\n' "$MPGD_TEST_DIRTY_WHEN_PATH_EXISTS"
  fi
  exit 0
fi
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
  return assertReleaseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

function assertKitGitShaSchema(): void {
  const schema = JSON.parse(readFileSync('release.manifest.schema.json', 'utf8')) as {
    readonly required?: readonly string[];
    readonly properties?: {
      readonly kitGitSha?: {
        readonly type?: string;
        readonly pattern?: string;
      };
      readonly targetConfigVersion?: {
        readonly type?: string;
        readonly minLength?: number;
      };
    };
  };
  const kitGitShaSchema = schema.properties?.kitGitSha;

  assert.equal(schema.required?.includes('kitGitSha'), true);
  assert.equal(schema.required?.includes('targetConfigVersion'), true);
  assert.ok(kitGitShaSchema, 'kitGitSha schema must exist.');
  assert.deepEqual(kitGitShaSchema, {
    type: 'string',
    pattern: '^[0-9a-f]{40}$',
  });

  const kitGitShaPattern = new RegExp(kitGitShaSchema.pattern, 'u');

  assert.match(firstKitGitSha, kitGitShaPattern);
  assert.doesNotMatch(firstKitGitSha.slice(1), kitGitShaPattern);
  assert.doesNotMatch('A'.repeat(40), kitGitShaPattern);
  assert.deepEqual(schema.properties?.targetConfigVersion, {
    type: 'string',
    minLength: 1,
  });
}

function assertManifestMatchesTopLevelSchema(manifest: ReleaseManifest): void {
  const schema = JSON.parse(readFileSync('release.manifest.schema.json', 'utf8')) as {
    readonly required?: readonly string[];
    readonly properties?: Record<string, unknown>;
    readonly additionalProperties?: boolean;
  };

  assert.equal(schema.additionalProperties, false);

  for (const requiredProperty of schema.required ?? []) {
    assert.equal(requiredProperty in manifest, true, `Missing ${requiredProperty} in manifest.`);
  }

  for (const manifestProperty of Object.keys(manifest)) {
    assert.equal(
      schema.properties?.[manifestProperty] !== undefined,
      true,
      `Manifest property ${manifestProperty} is absent from the JSON schema.`,
    );
  }
}

function catalogJson(version: string): string {
  return `${JSON.stringify({ version, products: [] }, null, 2)}\n`;
}

function placementsJson(version: string): string {
  return `${JSON.stringify({ version, placements: [] }, null, 2)}\n`;
}

function iconManifestJson(options: {
  readonly renderConfigSha?: string | undefined;
  readonly sharedConfigSha?: string | undefined;
  readonly sourceSha?: string | undefined;
} = {}): string {
  const sourceSha = options.sourceSha ?? 'a'.repeat(64);

  return `${JSON.stringify({
    schemaVersion: 2,
    canonicalSource: { path: 'assets/icon.svg', sha256: sourceSha, format: 'svg' },
    renderSource: { path: 'assets/icon.svg', sha256: sourceSha, format: 'svg' },
    sharedConfigSha256: options.sharedConfigSha ?? 'b'.repeat(64),
    renderConfigSha256: options.renderConfigSha ?? 'c'.repeat(64),
    generatorVersion: '1.1.0',
    targetProfile: 'fixture',
    targetProfileVersion: '1.0.0',
    outputs: [],
    warnings: [],
  }, null, 2)}\n`;
}

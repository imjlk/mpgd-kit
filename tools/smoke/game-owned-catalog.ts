import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { adPlacementsFilePath, productCatalogFilePath } from '../catalog-paths';
import {
  loadEffectiveTargetConfigMatrix,
  validateEffectiveTargetConfigMatrix,
} from '../target/effective-config';
import { normalizeMonetizationCatalogEnv } from '../target/monetization-catalog-env';

const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-game-catalog-'));
const catalogFile = join(tempDir, 'mpgd.catalog.json');
const placementsFile = join(tempDir, 'mpgd.ad-placements.json');
const blankCatalogFile = join(tempDir, 'blank.catalog.json');
const blankPlacementsFile = join(tempDir, 'blank.ad-placements.json');
const paddedCatalogFile = join(tempDir, 'padded.catalog.json');
const paddedPlacementsFile = join(tempDir, 'padded.ad-placements.json');
const previousCatalogFile = process.env.MPGD_PRODUCT_CATALOG_FILE;
const previousPlacementsFile = process.env.MPGD_AD_PLACEMENTS_FILE;
const previousInitCwd = process.env.INIT_CWD;
const previousPwd = process.env.PWD;
const previousPlatformTargetsFile = process.env.MPGD_PLATFORM_TARGETS_FILE;
const previousConfigTarget = process.env.MPGD_CONFIG_TARGET;

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
            verse8: 'sudoku-hint-pack',
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
            verse8: 'verse8_sudoku_hint_rewarded',
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
            verse8: 'verse8_sudoku_stage_end',
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    blankCatalogFile,
    `${JSON.stringify({
      version: 'blank-products',
      products: [
        {
          id: '   ',
          type: 'consumable',
          grant: {
            type: 'currency',
            currency: 'gem',
            amount: 1,
          },
          platformProductIds: {
            ait: 'ait_blank_product',
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    blankPlacementsFile,
    `${JSON.stringify({
      version: 'blank-ads',
      placements: [
        {
          id: '   ',
          type: 'interstitial',
          frequencyCap: {
            cooldownSeconds: 120,
          },
          platformPlacementIds: {
            ait: 'ait_blank_placement',
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    paddedCatalogFile,
    `${JSON.stringify({
      version: 'padded-products',
      products: [
        {
          id: 'SUDOKU_HINT_PACK ',
          type: 'consumable',
          grant: {
            type: 'currency',
            currency: 'gem',
            amount: 1,
          },
          platformProductIds: {
            ait: 'ait_padded_product',
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    paddedPlacementsFile,
    `${JSON.stringify({
      version: 'padded-ads',
      placements: [
        {
          id: ' SUDOKU_HINT_REWARDED',
          type: 'interstitial',
          frequencyCap: {
            cooldownSeconds: 120,
          },
          platformPlacementIds: {
            ait: 'ait_padded_placement',
          },
        },
      ],
    }, null, 2)}\n`,
  );

  assertHalfConfiguredEnvThrows({
    ...process.env,
    MPGD_PRODUCT_CATALOG_FILE: catalogFile,
    MPGD_AD_PLACEMENTS_FILE: undefined,
  });
  assertHalfConfiguredEnvThrows({
    ...process.env,
    MPGD_PRODUCT_CATALOG_FILE: undefined,
    MPGD_AD_PLACEMENTS_FILE: placementsFile,
  });
  assertValidatorFailure(
    'tools/validate-product-catalog.ts',
    {
      ...process.env,
      MPGD_PRODUCT_CATALOG_FILE: blankCatalogFile,
      MPGD_AD_PLACEMENTS_FILE: placementsFile,
    },
    /Product id must be non-empty/u,
  );
  assertValidatorFailure(
    'tools/validate-ad-placements.ts',
    {
      ...process.env,
      MPGD_PRODUCT_CATALOG_FILE: catalogFile,
      MPGD_AD_PLACEMENTS_FILE: blankPlacementsFile,
    },
    /Ad placement id must be non-empty/u,
  );
  assertValidatorFailure(
    'tools/validate-product-catalog.ts',
    {
      ...process.env,
      MPGD_PRODUCT_CATALOG_FILE: paddedCatalogFile,
      MPGD_AD_PLACEMENTS_FILE: placementsFile,
    },
    /Product id has leading or trailing whitespace/u,
  );
  assertValidatorFailure(
    'tools/validate-ad-placements.ts',
    {
      ...process.env,
      MPGD_PRODUCT_CATALOG_FILE: catalogFile,
      MPGD_AD_PLACEMENTS_FILE: paddedPlacementsFile,
    },
    /Ad placement id has leading or trailing whitespace/u,
  );
  process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
  process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;

  assert.equal(productCatalogFilePath(), catalogFile);
  assert.equal(adPlacementsFilePath(), placementsFile);
  assert.match(runValidator('tools/validate-product-catalog.ts'), /Product catalog game-v1/u);
  assert.match(runValidator('tools/validate-ad-placements.ts'), /Ad placements game-ads-v1/u);
  await assertViteCatalogAliasesWithRelativeEnv();
  await assertViteCatalogAliasesFallBackWhenInitCwdMisses();
  await assertViteCatalogAliasesPreferGameRoot();
  await assertVitePlatformTargetMetadata();
  assertViteConfigsStayInSync();
  assertTargetBuildCatalogEnvUsesCallerBase();

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
  restoreEnv('INIT_CWD', previousInitCwd);
  restoreEnv('PWD', previousPwd);
  restoreEnv('MPGD_PLATFORM_TARGETS_FILE', previousPlatformTargetsFile);
  restoreEnv('MPGD_CONFIG_TARGET', previousConfigTarget);
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

function assertHalfConfiguredEnvThrows(env: NodeJS.ProcessEnv): void {
  assert.throws(
    () => productCatalogFilePath(env),
    /MPGD_PRODUCT_CATALOG_FILE and MPGD_AD_PLACEMENTS_FILE must be configured together/u,
  );
  assert.throws(
    () => adPlacementsFilePath(env),
    /MPGD_PRODUCT_CATALOG_FILE and MPGD_AD_PLACEMENTS_FILE must be configured together/u,
  );
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

function assertValidatorFailure(
  script: string,
  env: NodeJS.ProcessEnv,
  pattern: RegExp,
): void {
  const result = spawnSync(process.execPath, ['tools/run-ttsx.mjs', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  const output = result.stderr || result.stdout;

  if (result.error !== undefined) {
    throw result.error;
  }

  assert.notEqual(result.status, 0, `Expected ${script} to fail.`);
  assert.match(output, pattern);
}

async function assertViteCatalogAliases(
  configPath: string,
  expectedCatalogFile = catalogFile,
  expectedPlacementsFile = placementsFile,
): Promise<void> {
  const config = await loadViteConfig(configPath);
  const alias = config.resolve?.alias;

  assert.equal(
    readAlias(alias, '@mpgd/catalog/catalog.json'),
    expectedCatalogFile,
    `${configPath} product catalog alias`,
  );
  assert.equal(
    readAlias(alias, '@mpgd/catalog/placements.json'),
    expectedPlacementsFile,
    `${configPath} ad placements alias`,
  );
}

async function assertViteCatalogAliasesWithRelativeEnv(): Promise<void> {
  delete process.env.INIT_CWD;
  process.env.PWD = process.cwd();
  process.env.MPGD_PRODUCT_CATALOG_FILE = relative(process.cwd(), catalogFile);
  process.env.MPGD_AD_PLACEMENTS_FILE = relative(process.cwd(), placementsFile);

  try {
    await assertViteCatalogAliases('examples/phaser-starter/vite.config.ts');
    await assertViteCatalogAliases('packages/cli/templates/phaser-game/vite.config.ts');
  } finally {
    process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
    process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;
    restoreEnv('INIT_CWD', previousInitCwd);
    restoreEnv('PWD', previousPwd);
  }
}

async function assertViteCatalogAliasesFallBackWhenInitCwdMisses(): Promise<void> {
  process.env.INIT_CWD = join(tempDir, 'missing-init-cwd');
  process.env.PWD = process.cwd();
  process.env.MPGD_PRODUCT_CATALOG_FILE = relative(process.cwd(), catalogFile);
  process.env.MPGD_AD_PLACEMENTS_FILE = relative(process.cwd(), placementsFile);

  try {
    await assertViteCatalogAliases('examples/phaser-starter/vite.config.ts');
    await assertViteCatalogAliases('packages/cli/templates/phaser-game/vite.config.ts');
  } finally {
    process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
    process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;
    restoreEnv('INIT_CWD', previousInitCwd);
    restoreEnv('PWD', previousPwd);
  }
}

async function assertViteCatalogAliasesPreferGameRoot(): Promise<void> {
  const repoRoot = process.cwd();
  const gameRoot = join(tempDir, 'vite-game');
  const shadowRoot = join(tempDir, 'vite-shadow');

  mkdirSync(gameRoot);
  mkdirSync(shadowRoot);

  for (const root of [gameRoot, shadowRoot]) {
    writeFileSync(join(root, 'mpgd.catalog.json'), '{}\n');
    writeFileSync(join(root, 'mpgd.ad-placements.json'), '{}\n');
  }

  try {
    process.env.INIT_CWD = `  ${shadowRoot}  `;
    process.env.PWD = shadowRoot;
    process.env.MPGD_PRODUCT_CATALOG_FILE = 'mpgd.catalog.json';
    process.env.MPGD_AD_PLACEMENTS_FILE = 'mpgd.ad-placements.json';
    process.chdir(gameRoot);
    const resolvedGameRoot = process.cwd();

    await assertViteCatalogAliases(
      join(repoRoot, 'examples/phaser-starter/vite.config.ts'),
      join(resolvedGameRoot, 'mpgd.catalog.json'),
      join(resolvedGameRoot, 'mpgd.ad-placements.json'),
    );
    await assertViteCatalogAliases(
      join(repoRoot, 'packages/cli/templates/phaser-game/vite.config.ts'),
      join(resolvedGameRoot, 'mpgd.catalog.json'),
      join(resolvedGameRoot, 'mpgd.ad-placements.json'),
    );
  } finally {
    process.chdir(repoRoot);
    process.env.MPGD_PRODUCT_CATALOG_FILE = catalogFile;
    process.env.MPGD_AD_PLACEMENTS_FILE = placementsFile;
    restoreEnv('INIT_CWD', previousInitCwd);
    restoreEnv('PWD', previousPwd);
  }
}

async function assertVitePlatformTargetMetadata(): Promise<void> {
  const targetsFile = join(tempDir, 'runtime-platform-targets.json');
  const malformedTargetsFile = join(tempDir, 'malformed-runtime-platform-targets.json');
  const missingTargetsFile = join(tempDir, 'missing-runtime-platform-targets.json');
  const configPaths = [
    'examples/phaser-starter/vite.config.ts',
    'packages/cli/templates/phaser-game/vite.config.ts',
  ];
  const expectedMetadata = {
    kind: 'apps-in-toss',
    adapter: 'ait',
    integrations: {
      presentation: 'disabled',
      presentationMode: 'inline-expanded',
    },
  };

  writeFileSync(
    targetsFile,
    `${JSON.stringify({
      targets: {
        ait: {
          ...expectedMetadata,
          gameApp: '.',
          wrapperApp: 'apps/target-ait',
          webDir: 'apps/target-ait/public/game',
          artifact: '.ait',
        },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(malformedTargetsFile, '{ malformed json\n');
  process.env.MPGD_PLATFORM_TARGETS_FILE = targetsFile;
  process.env.MPGD_CONFIG_TARGET = 'ait';

  try {
    for (const configPath of configPaths) {
      const config = await loadViteConfig(configPath);
      const serializedMetadata = config.define?.['__MPGD_PLATFORM_TARGET__'];

      assert.ok(serializedMetadata !== undefined, `${configPath} platform target define`);
      assert.deepEqual(JSON.parse(serializedMetadata), expectedMetadata);
    }

    for (const [targetsPath, expectedPath] of [
      [missingTargetsFile, 'missing-runtime-platform-targets.json'],
      [malformedTargetsFile, 'malformed-runtime-platform-targets.json'],
    ] as const) {
      process.env.MPGD_PLATFORM_TARGETS_FILE = targetsPath;

      for (const configPath of configPaths) {
        await assert.rejects(
          loadViteConfig(configPath),
          new RegExp(
            `Failed to read or parse MPGD_PLATFORM_TARGETS_FILE at .*${expectedPath}:`,
            'u',
          ),
        );
      }
    }
  } finally {
    restoreEnv('MPGD_PLATFORM_TARGETS_FILE', previousPlatformTargetsFile);
    restoreEnv('MPGD_CONFIG_TARGET', previousConfigTarget);
  }
}

function assertViteConfigsStayInSync(): void {
  assert.equal(
    readFileSync('examples/phaser-starter/vite.config.ts', 'utf8'),
    readFileSync('packages/cli/templates/phaser-game/vite.config.ts', 'utf8'),
    'Starter and generated-template Vite target wiring must stay in sync.',
  );
}

function assertTargetBuildCatalogEnvUsesCallerBase(): void {
  const callerDir = join(tempDir, 'caller-game');
  const shadowDir = join(tempDir, 'shadow-caller');
  const callerCatalogFile = join(callerDir, 'mpgd.catalog.json');
  const callerPlacementsFile = join(callerDir, 'mpgd.ad-placements.json');
  const shadowCatalogFile = join(shadowDir, 'mpgd.catalog.json');
  const shadowPlacementsFile = join(shadowDir, 'mpgd.ad-placements.json');

  mkdirSync(callerDir);
  mkdirSync(shadowDir);
  writeFileSync(callerCatalogFile, '{}\n');
  writeFileSync(callerPlacementsFile, '{}\n');
  writeFileSync(shadowCatalogFile, '{}\n');
  writeFileSync(shadowPlacementsFile, '{}\n');

  const normalizedEnvFromPwd = normalizeMonetizationCatalogEnv({
    MPGD_PRODUCT_CATALOG_FILE: relative(callerDir, catalogFile),
    MPGD_AD_PLACEMENTS_FILE: relative(callerDir, placementsFile),
    PWD: callerDir,
  });
  const normalizedEnvFromTargetsBase = normalizeMonetizationCatalogEnv(
    {
      MPGD_PRODUCT_CATALOG_FILE: relative(callerDir, catalogFile),
      MPGD_AD_PLACEMENTS_FILE: relative(callerDir, placementsFile),
      PWD: process.cwd(),
    },
    callerDir,
  );
  const normalizedEnvFromConflictingBases = normalizeMonetizationCatalogEnv(
    {
      MPGD_PRODUCT_CATALOG_FILE: 'mpgd.catalog.json',
      MPGD_AD_PLACEMENTS_FILE: 'mpgd.ad-placements.json',
      PWD: shadowDir,
    },
    callerDir,
  );

  assert.equal(normalizedEnvFromPwd.MPGD_PRODUCT_CATALOG_FILE, catalogFile);
  assert.equal(normalizedEnvFromPwd.MPGD_AD_PLACEMENTS_FILE, placementsFile);
  assert.equal(normalizedEnvFromTargetsBase.MPGD_PRODUCT_CATALOG_FILE, catalogFile);
  assert.equal(normalizedEnvFromTargetsBase.MPGD_AD_PLACEMENTS_FILE, placementsFile);
  assert.equal(normalizedEnvFromConflictingBases.MPGD_PRODUCT_CATALOG_FILE, callerCatalogFile);
  assert.equal(normalizedEnvFromConflictingBases.MPGD_AD_PLACEMENTS_FILE, callerPlacementsFile);
}

interface ViteUserConfig {
  readonly define?: Record<string, string>;
  readonly resolve?: {
    readonly alias?: ViteAlias;
  };
}

type ViteAlias =
  | Record<string, string>
  | readonly {
      readonly find: string | RegExp;
      readonly replacement: string;
    }[];

async function loadViteConfig(configPath: string): Promise<ViteUserConfig> {
  const configModule = await import(pathToFileURL(resolve(configPath)).href) as {
    readonly default: unknown;
  };
  const configExport = configModule.default;
  const config = typeof configExport === 'function'
    ? await (configExport as (env: { readonly mode: string }) => unknown)({
      mode: 'production',
    })
    : configExport;

  assert.ok(
    typeof config === 'object' && config !== null && !Array.isArray(config),
    `${configPath} should export a Vite config object`,
  );

  return config as ViteUserConfig;
}

function readAlias(alias: ViteAlias | undefined, specifier: string): string | undefined {
  if (alias === undefined) {
    return undefined;
  }

  if (Array.isArray(alias)) {
    return alias.find((entry) => entry.find === specifier)?.replacement;
  }

  return (alias as Record<string, string>)[specifier];
}

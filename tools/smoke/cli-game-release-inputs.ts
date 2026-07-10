import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-game-release-inputs');
const gameRoot = join(fixtureRoot, 'game');
const kitRoot = join(fixtureRoot, 'kit');
const targetsFile = join(gameRoot, 'mpgd.targets.json');
const catalogFile = join(gameRoot, 'mpgd.catalog.json');
const placementsFile = join(gameRoot, 'mpgd.ad-placements.json');
const autoCaptureFile = join(fixtureRoot, 'captured-auto-env.json');
const explicitCaptureFile = join(fixtureRoot, 'captured-explicit-env.json');

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(gameRoot, { recursive: true });
  mkdirSync(kitRoot, { recursive: true });
  writeJson(join(gameRoot, 'package.json'), {
    name: '@fixture/game',
    version: '1.2.3',
  });
  writeJson(targetsFile, {
    targets: {
      reddit: {
        kind: 'devvit-web',
        gameApp: '.',
        wrapperApp: 'apps/target-devvit',
        adapter: 'devvit',
        webDir: 'apps/target-devvit/dist/client',
        artifact: 'devvit',
      },
    },
  });
  writeJson(catalogFile, { version: 'fixture-products', products: [] });
  writeJson(placementsFile, { version: 'fixture-ads', placements: [] });
  writeJson(join(kitRoot, 'package.json'), {
    name: 'mpgd-kit',
    private: true,
    scripts: {
      'build:target': 'node capture-env.mjs',
    },
  });
  writeFileSync(
    join(kitRoot, 'capture-env.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MPGD_CAPTURE_FILE, JSON.stringify({
  appVersion: process.env.APP_VERSION,
  sourceGitSha: process.env.MPGD_SOURCE_GIT_SHA,
  catalogFile: process.env.MPGD_PRODUCT_CATALOG_FILE,
  placementsFile: process.env.MPGD_AD_PLACEMENTS_FILE,
  targetsFile: process.env.MPGD_PLATFORM_TARGETS_FILE,
}));
`,
  );

  assertReleaseInputs(runCliCapture(autoCaptureFile), 'auto-detected');
  assertReleaseInputs(
    runCliCapture(explicitCaptureFile, {
      MPGD_PRODUCT_CATALOG_FILE: 'mpgd.catalog.json',
      MPGD_AD_PLACEMENTS_FILE: 'mpgd.ad-placements.json',
    }),
    'explicit relative',
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('CLI game-owned release input smoke passed.');

function runCliCapture(
  captureFile: string,
  overrides: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.APP_VERSION;
  delete env.MPGD_SOURCE_GIT_SHA;
  delete env.MPGD_PRODUCT_CATALOG_FILE;
  delete env.MPGD_AD_PLACEMENTS_FILE;
  Object.assign(env, overrides, { MPGD_CAPTURE_FILE: captureFile });

  const result = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'target',
      'build',
      'reddit',
      '--targets-file',
      targetsFile,
      '--kit-path',
      kitRoot,
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

  if (result.signal !== null) {
    throw new Error(
      `CLI fixture was killed by signal ${result.signal}:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }

  assert.equal(
    result.status,
    0,
    `CLI fixture exited with status ${String(result.status)}:\n${result.stderr || result.stdout || '(no output)'}`,
  );

  if (!existsSync(captureFile)) {
    throw new Error(
      `CLI fixture did not write ${captureFile}:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }

  return JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, string>;
}

function assertReleaseInputs(captured: Record<string, string>, source: string): void {
  assert.equal(captured.appVersion, '1.2.3', `${source} app version`);
  assert.equal(captured.sourceGitSha, currentGitSha(), `${source} source Git SHA`);
  assert.equal(captured.catalogFile, catalogFile, `${source} product catalog`);
  assert.equal(captured.placementsFile, placementsFile, `${source} ad placements`);
  assert.equal(
    captured.targetsFile,
    join(gameRoot, '.mpgd.targets.generated.json'),
    `${source} targets file`,
  );
}

function currentGitSha(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return result.status === 0 ? result.stdout.trim() : 'uncommitted';
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

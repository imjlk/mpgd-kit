import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveNativeCommandLaunch } from '../../packages/cli/src/command-launcher';
import { runMpgdCli } from '../../packages/cli/src/index';
import { parseIconRunArguments } from '../icons/run-arguments';

const iconActions = ['generate', 'verify', 'inspect'] as const;
const webPreviewTarget = {
  kind: 'web',
  gameApp: '.',
  adapter: 'browser',
  icon: { profile: 'web-preview' },
  output: 'artifacts/web-preview',
};
const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-game-release-inputs');
const gameRoot = join(fixtureRoot, 'game');
const kitRoot = join(fixtureRoot, 'kit');
const targetsFile = join(gameRoot, 'mpgd.targets.json');
const catalogFile = join(gameRoot, 'mpgd.catalog.json');
const placementsFile = join(gameRoot, 'mpgd.ad-placements.json');
const autoCaptureFile = join(fixtureRoot, 'captured-auto-env.json');
const explicitCaptureFile = join(fixtureRoot, 'captured-explicit-env.json');
const absoluteCaptureFile = join(fixtureRoot, 'captured-absolute-env.json');
const paddedCaptureFile = join(fixtureRoot, 'captured-padded-env.json');
const blankCaptureFile = join(fixtureRoot, 'captured-blank-env.json');

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
      'smoke:target': 'node capture-env.mjs',
      // The kit's own icon scripts; tools/run-ttsx.mjs below records what they pass on.
      ...readKitIconScripts(),
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
  mkdirSync(join(kitRoot, 'tools'), { recursive: true });
  writeFileSync(
    join(kitRoot, 'tools/run-ttsx.mjs'),
    `import { writeFileSync } from 'node:fs';
const runnerArgs = process.argv.slice(2);
const entry = runnerArgs.indexOf('tools/icons/run.ts');
writeFileSync(process.env.MPGD_CAPTURE_FILE, JSON.stringify({
  argv: entry === -1 ? null : runnerArgs.slice(entry + 1),
  cwd: process.cwd(),
  kitPath: process.env.MPGD_KIT_PATH,
  sourceGitSha: process.env.MPGD_SOURCE_GIT_SHA,
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
  assertReleaseInputs(
    runCliCapture(absoluteCaptureFile, {
      MPGD_PRODUCT_CATALOG_FILE: catalogFile,
      MPGD_AD_PLACEMENTS_FILE: placementsFile,
    }),
    'explicit absolute',
  );
  assertReleaseInputs(
    runCliCapture(paddedCaptureFile, {
      MPGD_PRODUCT_CATALOG_FILE: '  mpgd.catalog.json  ',
      MPGD_AD_PLACEMENTS_FILE: '  mpgd.ad-placements.json  ',
    }),
    'padded explicit relative',
  );
  assertReleaseInputs(
    runCliCapture(blankCaptureFile, {
      MPGD_PRODUCT_CATALOG_FILE: '   ',
      MPGD_AD_PLACEMENTS_FILE: '   ',
    }),
    'blank explicit fallback',
  );
  assertMissingGameRevisionFailsClosed();
  assertInvalidSourceGitShaFailsClosed();
  assertNonBuildCommandsDoNotRequireSourceRevision();
  await assertGameIconsPassBareOperands();
  await assertGameIconsWithoutTargetsFailClosed();
  assertGameIconsRunWithThisKit();
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
      timeout: 30_000,
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

function assertMissingGameRevisionFailsClosed(): void {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-game-sha-'));

  try {
    const outsideGame = join(outsideRoot, 'game');
    const outsideTargets = join(outsideGame, 'mpgd.targets.json');
    const captureFile = join(outsideRoot, 'captured.json');
    mkdirSync(outsideGame, { recursive: true });
    writeJson(join(outsideGame, 'package.json'), {
      name: '@fixture/game',
      version: '1.2.3',
    });
    writeJson(outsideTargets, {
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

    const output = runCliExpectFailure(captureFile, outsideTargets);
    assert.match(output, /game source Git revision/u);
    assert.equal(output.includes('uncommitted'), false);
    assert.equal(existsSync(captureFile), false);
  } finally {
    rmSync(outsideRoot, { force: true, recursive: true });
  }
}

function assertNonBuildCommandsDoNotRequireSourceRevision(): void {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-game-sha-smoke-'));

  try {
    const outsideGame = join(outsideRoot, 'game');
    const outsideTargets = join(outsideGame, 'mpgd.targets.json');
    mkdirSync(outsideGame, { recursive: true });
    writeJson(join(outsideGame, 'package.json'), {
      name: '@fixture/game',
      version: '1.2.3',
    });
    writeJson(outsideTargets, {
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

    const smokeCaptureFile = join(outsideRoot, 'captured-smoke.json');
    const smoke = runCliCommand(
      ['target', 'smoke', 'reddit', '--targets-file', outsideTargets, '--kit-path', kitRoot],
      smokeCaptureFile,
    );
    assert.equal(
      smoke.status,
      0,
      `target smoke should not require a game revision:\\n${smoke.output}`,
    );
    assert.equal(existsSync(smokeCaptureFile), true);
    const capturedSmoke = JSON.parse(readFileSync(smokeCaptureFile, 'utf8')) as Record<
      string,
      string | undefined
    >;
    assert.equal(capturedSmoke.sourceGitSha, undefined);

    const invalidSmokeCaptureFile = join(outsideRoot, 'captured-smoke-invalid.json');
    const invalidSmoke = runCliCommand(
      ['target', 'smoke', 'reddit', '--targets-file', outsideTargets, '--kit-path', kitRoot],
      invalidSmokeCaptureFile,
      { MPGD_SOURCE_GIT_SHA: 'uncommitted' },
    );
    assert.equal(
      invalidSmoke.status,
      0,
      `target smoke should not reject an explicit non-commit revision:\\n${invalidSmoke.output}`,
    );
    assert.equal(existsSync(invalidSmokeCaptureFile), true);

    const iconsCaptureFile = join(outsideRoot, 'captured-icons.json');
    const icons = runCliCommand(
      ['game', 'icons', 'inspect', outsideGame, '--kit-path', kitRoot],
      iconsCaptureFile,
    );
    assert.equal(
      icons.status,
      0,
      `game icons should not require a game revision:\\n${icons.output}`,
    );
    assert.equal(existsSync(iconsCaptureFile), true);
  } finally {
    rmSync(outsideRoot, { force: true, recursive: true });
  }
}

interface CapturedIconRun {
  readonly argv: readonly string[] | null;
  readonly cwd: string;
  readonly kitPath?: string;
  readonly sourceGitSha?: string;
  readonly targetsFile?: string;
}

/**
 * `mpgd game icons` runs the kit's `game:icons:<action>` script through pnpm.
 * pnpm 11 and 12 hand a `--` to the script, and kit runners before the
 * separator fix read their operands by position, so the target list and the
 * profile must arrive bare and non-empty.
 */
async function assertGameIconsPassBareOperands(): Promise<void> {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-game-icons-'));

  try {
    const outsideGame = join(outsideRoot, 'game');
    mkdirSync(outsideGame, { recursive: true });
    writeJson(join(outsideGame, 'package.json'), {
      name: '@fixture/game',
      version: '1.2.3',
    });
    writeJson(join(outsideGame, 'mpgd.targets.json'), {
      targets: {
        reddit: {
          kind: 'devvit-web',
          gameApp: '.',
          wrapperApp: 'apps/target-devvit',
          adapter: 'devvit',
          webDir: 'apps/target-devvit/dist/client',
          artifact: 'devvit',
        },
        'web-preview': webPreviewTarget,
      },
    });

    for (const action of iconActions) {
      const defaultProfile = action === 'verify' ? 'production' : 'development';
      const otherProfile = action === 'verify' ? 'development' : 'production';
      const cases = [
        { options: [], targets: 'reddit,web-preview', profile: defaultProfile },
        { options: ['--targets', 'web-preview'], targets: 'web-preview', profile: defaultProfile },
        {
          options: ['--profile', otherProfile],
          targets: 'reddit,web-preview',
          profile: otherProfile,
        },
        {
          options: ['--targets', 'web-preview,reddit', '--profile', otherProfile],
          targets: 'web-preview,reddit',
          profile: otherProfile,
        },
        // Empty values take the defaults: every configured target, the action's profile.
        {
          options: ['--targets', '', '--profile', ''],
          targets: 'reddit,web-preview',
          profile: defaultProfile,
        },
      ];

      for (const [index, { options, targets, profile }] of cases.entries()) {
        const label = ['game icons', action, ...options].join(' ');
        const captureFile = join(outsideRoot, `captured-${action}-${String(index)}.json`);
        await runCliInProcess(
          ['game', 'icons', action, outsideGame, ...options, '--kit-path', kitRoot],
          captureFile,
        );
        const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as CapturedIconRun;

        assert.deepEqual(captured.argv, [action, targets, profile], label);
        assert.deepEqual(
          parseIconRunArguments(captured.argv ?? []),
          { action, targets: targets.split(','), profile },
          label,
        );
        assert.equal(
          captured.targetsFile,
          join(outsideGame, '.mpgd.targets.generated.json'),
          label,
        );
        assert.equal(captured.kitPath, kitRoot, label);
        assert.equal(realpathSync(captured.cwd), realpathSync(kitRoot), label);
        assert.equal(captured.sourceGitSha, undefined, label);
      }
    }
  } finally {
    rmSync(outsideRoot, { force: true, recursive: true });
  }
}

async function assertGameIconsWithoutTargetsFailClosed(): Promise<void> {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-game-icons-empty-'));

  try {
    const outsideGame = join(outsideRoot, 'game');
    const captureFile = join(outsideRoot, 'captured.json');
    mkdirSync(outsideGame, { recursive: true });
    writeJson(join(outsideGame, 'package.json'), {
      name: '@fixture/game',
      version: '1.2.3',
    });
    writeJson(join(outsideGame, 'mpgd.targets.json'), { targets: {} });

    await assert.rejects(
      runCliInProcess(['game', 'icons', 'verify', outsideGame, '--kit-path', kitRoot], captureFile),
      /No targets are configured/u,
    );
    assert.equal(existsSync(captureFile), false);
  } finally {
    rmSync(outsideRoot, { force: true, recursive: true });
  }
}

/**
 * Runs the CLI in this process with the environment runCliCommand gives a
 * spawned CLI. Commands still spawn pnpm and the kit script for real.
 */
async function runCliInProcess(args: readonly string[], captureFile: string): Promise<void> {
  const names = [
    'APP_VERSION',
    'MPGD_SOURCE_GIT_SHA',
    'MPGD_PRODUCT_CATALOG_FILE',
    'MPGD_AD_PLACEMENTS_FILE',
    'MPGD_CAPTURE_FILE',
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);

  for (const name of names) {
    delete process.env[name];
  }
  process.env.MPGD_CAPTURE_FILE = captureFile;

  try {
    await runMpgdCli(args);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * Generates, verifies, and inspects real icons with this checkout as the kit:
 * through the current CLI, and through the command earlier CLIs spawn.
 */
function assertGameIconsRunWithThisKit(): void {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'mpgd-cli-game-icons-kit-'));
  // Real runs render through this checkout's tools, which ttsx compiles without a CI emit.
  const timeout = 180_000;

  try {
    const outsideGame = join(outsideRoot, 'game');
    const unusedCaptureFile = join(outsideRoot, 'unused-capture.json');
    mkdirSync(join(outsideGame, 'assets'), { recursive: true });
    writeFileSync(
      join(outsideGame, 'assets/icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#2563eb"/><circle cx="512" cy="512" r="256" fill="#ffffff"/></svg>',
    );
    writeJson(join(outsideGame, 'mpgd.game.json'), {
      brand: { appIcon: { source: 'assets/icon.svg', backgroundColor: '#ffffff' } },
    });
    writeJson(join(outsideGame, 'package.json'), {
      name: '@fixture/game',
      version: '1.2.3',
    });
    writeJson(join(outsideGame, 'mpgd.targets.json'), {
      targets: { 'web-preview': webPreviewTarget },
    });

    const generated = runCliCommand(
      ['game', 'icons', 'generate', outsideGame, '--kit-path', process.cwd()],
      unusedCaptureFile,
      {},
      timeout,
    );
    assert.equal(generated.status, 0, `game icons generate failed:\n${generated.output}`);
    assert.match(generated.stdout, /Generated web-preview icons at /u);

    const verified = runCliCommand(
      ['game', 'icons', 'verify', outsideGame, '--kit-path', process.cwd()],
      unusedCaptureFile,
      {},
      timeout,
    );
    assert.equal(verified.status, 0, `game icons verify failed:\n${verified.output}`);
    assert.match(verified.stdout, /Verified web-preview icons at /u);

    // Earlier CLIs ran this, with an empty list for every target. This case
    // depends on pnpm handing the `--` and the empty argument to the kit
    // script, as pnpm 11 and 12 do; that is the command those CLIs spawn.
    const launch = resolveNativeCommandLaunch({
      command: 'pnpm',
      args: ['game:icons:inspect', '--', '', 'development'],
      environment: process.env,
    });
    const legacy = spawnSync(launch.command, [...launch.args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MPGD_PLATFORM_TARGETS_FILE: join(outsideGame, '.mpgd.targets.generated.json'),
      },
      timeout,
    });

    if (legacy.error !== undefined) {
      throw legacy.error;
    }

    assert.equal(
      legacy.status,
      0,
      [
        'The command earlier CLIs ran, pnpm game:icons:inspect -- "" development, failed.',
        'Unknown target: development would mean pnpm dropped the empty argument.',
        legacy.stderr || legacy.stdout,
      ].join('\n'),
    );
    assert.match(legacy.stdout, /^web-preview: web-preview@/mu);
  } finally {
    rmSync(outsideRoot, { force: true, recursive: true });
  }
}

function runCliCommand(
  args: readonly string[],
  captureFile: string,
  overrides: NodeJS.ProcessEnv = {},
  timeout = 30_000,
): { readonly output: string; readonly status: number | null; readonly stdout: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.APP_VERSION;
  delete env.MPGD_SOURCE_GIT_SHA;
  delete env.MPGD_PRODUCT_CATALOG_FILE;
  delete env.MPGD_AD_PLACEMENTS_FILE;
  Object.assign(env, overrides, { MPGD_CAPTURE_FILE: captureFile });

  const result = spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
      timeout,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  return {
    output: result.stderr || result.stdout || '(no output)',
    status: result.status,
    stdout: result.stdout,
  };
}

function assertInvalidSourceGitShaFailsClosed(): void {
  const captureFile = join(fixtureRoot, 'captured-invalid-sha.json');
  const output = runCliExpectFailure(captureFile, targetsFile, {
    MPGD_SOURCE_GIT_SHA: 'uncommitted',
  });
  assert.match(output, /lowercase 40-character game source SHA/u);
  assert.equal(existsSync(captureFile), false);
}

function runCliExpectFailure(
  captureFile: string,
  selectedTargetsFile: string,
  overrides: NodeJS.ProcessEnv = {},
): string {
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
      selectedTargetsFile,
      '--kit-path',
      kitRoot,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
      timeout: 30_000,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  assert.notEqual(
    result.status,
    0,
    `CLI fixture unexpectedly succeeded:\\n${result.stderr || result.stdout || '(no output)'}`,
  );

  return result.stderr || result.stdout || '(no output)';
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
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return result.status === 0 ? result.stdout.trim() : 'uncommitted';
}

function readKitIconScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  const scripts: Record<string, string> = {};

  for (const action of iconActions) {
    const name = `game:icons:${action}`;
    const script = manifest.scripts?.[name];

    if (typeof script !== 'string' || !script.includes(`tools/icons/run.ts ${action}`)) {
      throw new Error(`The root ${name} script must run tools/icons/run.ts ${action}.`);
    }

    scripts[name] = script;
  }

  return scripts;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

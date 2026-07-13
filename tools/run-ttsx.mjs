import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(toolsDir);
const rootRequire = createRequire(join(repoRoot, 'package.json'));
const typescriptPackageJson = rootRequire.resolve('typescript/package.json');
const typescriptRequire = createRequire(typescriptPackageJson);
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const platformPackageJson = typescriptRequire.resolve(`${platformPackage}/package.json`);
const platformRoot = dirname(platformPackageJson);
const tsgoBinary = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const ttscPackageJson = rootRequire.resolve('ttsc/package.json');
const ttsxLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsx.js');
const userArgs = process.argv.slice(2);
const { project, passthroughArgs, cliArgv } = parseRunnerArgs(userArgs);
const generatedSourceRoots = [
  'adapters',
  'apps',
  'backend',
  'examples',
  'native-plugins',
  'packages',
  'tools',
].map((entry) => join(repoRoot, entry));
const paraglideDir = join(repoRoot, 'packages', 'i18n', 'src', 'paraglide');
const allowedGeneratedSourceFiles = new Set([
  join(repoRoot, 'packages', 'i18n', 'src', 'paraglideAdapter.js'),
  join(repoRoot, 'packages', 'i18n', 'src', 'paraglideAdapter.d.ts'),
]);
const skippedGeneratedSourceDirs = new Set([
  '.git',
  '.cache',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const generatedSourceSuffixes = [
  ['.d.mts.map', '.mts'],
  ['.d.cts.map', '.cts'],
  ['.d.ts.map', '.ts'],
  ['.mjs.map', '.mts'],
  ['.cjs.map', '.cts'],
  ['.jsx.map', '.tsx'],
  ['.js.map', '.ts'],
  ['.d.mts', '.mts'],
  ['.d.cts', '.cts'],
  ['.d.ts', '.ts'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts'],
  ['.jsx', '.tsx'],
  ['.js', '.ts'],
];

if (!existsSync(tsgoBinary)) {
  throw new Error(`TypeScript-Go binary not found: ${tsgoBinary}`);
}

// Plugin-backed ttsx dependency builds can leave emit beside sources whose owning
// project has no outDir. Remove those siblings so a later Node resolution cannot
// shadow the TypeScript source with untransformed JavaScript.
removeGeneratedSourceSiblings();

let result;
let cleanupError;

try {
  result = spawnSync(process.execPath, [
    ttsxLauncher,
    '--cwd',
    process.cwd(),
    '--project',
    project,
    ...passthroughArgs,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TTSC_TSGO_BINARY: tsgoBinary,
      ...(cliArgv === undefined ? {} : { MPGD_CLI_ARGV: JSON.stringify(cliArgv) }),
    },
  });
} finally {
  try {
    removeGeneratedSourceSiblings();
  } catch (error) {
    cleanupError = error;
  }
}

if (result.error !== undefined) {
  throw result.error;
}

const exitStatus = result.status ?? 1;

if (cleanupError !== undefined) {
  if (exitStatus !== 0) {
    process.stderr.write(`ttsx source cleanup also failed: ${formatError(cleanupError)}\n`);
  } else {
    throw new Error('ttsx source cleanup failed after a successful run.', {
      cause: cleanupError,
    });
  }
}

process.exit(exitStatus);

function removeGeneratedSourceSiblings() {
  for (const root of generatedSourceRoots) {
    if (existsSync(root)) {
      removeGeneratedSourceSiblingsIn(root);
    }
  }
}

function removeGeneratedSourceSiblingsIn(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        skippedGeneratedSourceDirs.has(entry.name)
        || path === paraglideDir
      ) {
        continue;
      }

      removeGeneratedSourceSiblingsIn(path);
      continue;
    }

    if (!entry.isFile() || isAllowedGeneratedSource(path)) {
      continue;
    }

    const sourceSibling = findSourceSibling(path);

    if (sourceSibling !== undefined && existsSync(sourceSibling)) {
      rmSync(path, { force: true });
    }
  }
}

function findSourceSibling(path) {
  for (const [artifactSuffix, sourceSuffix] of generatedSourceSuffixes) {
    if (!path.endsWith(artifactSuffix)) {
      continue;
    }

    const sourcePath = `${path.slice(0, -artifactSuffix.length)}${sourceSuffix}`;

    if (existsSync(sourcePath)) {
      return sourcePath;
    }
  }

  return undefined;
}

function isAllowedGeneratedSource(path) {
  return path.startsWith(`${paraglideDir}${sep}`) || allowedGeneratedSourceFiles.has(path);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseRunnerArgs(args) {
  let project = process.env.TTSC_PROJECT ?? 'tsconfig.tools.json';
  const passthroughArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--project' || arg === '-p') {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error(`${arg} requires a project path.`);
      }

      project = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      continue;
    }

    if (arg === '--mpgd-cli') {
      const entry = args[index + 1];

      if (entry === undefined) {
        throw new Error('--mpgd-cli requires a CLI entry path.');
      }

      return {
        project,
        passthroughArgs: [...passthroughArgs, entry],
        cliArgv: stripPnpmArgumentSeparator(args.slice(index + 2)),
      };
    }

    passthroughArgs.push(arg);
  }

  return {
    project,
    passthroughArgs,
    cliArgv: undefined,
  };
}

function stripPnpmArgumentSeparator(args) {
  const separatorIndex = args.indexOf('--');

  if (separatorIndex === -1) {
    return args;
  }

  return [...args.slice(0, separatorIndex), ...args.slice(separatorIndex + 1)];
}

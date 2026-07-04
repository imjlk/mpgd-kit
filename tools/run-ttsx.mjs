import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const rootRequire = createRequire(resolve('package.json'));
const typescriptPackageJson = rootRequire.resolve('typescript/package.json');
const typescriptRequire = createRequire(typescriptPackageJson);
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const platformPackageJson = typescriptRequire.resolve(`${platformPackage}/package.json`);
const platformRoot = dirname(platformPackageJson);
const tsgoBinary = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const ttscPackageJson = rootRequire.resolve('ttsc/package.json');
const ttsxLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsx.js');
const userArgs = process.argv.slice(2);
const { project, passthroughArgs } = parseProjectOverride(userArgs);

if (!existsSync(tsgoBinary)) {
  throw new Error(`TypeScript-Go binary not found: ${tsgoBinary}`);
}

const result = spawnSync(process.execPath, [
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
  },
});

if (result.error !== undefined) {
  throw result.error;
}

process.exit(result.status ?? 1);

function parseProjectOverride(args) {
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

    passthroughArgs.push(arg);
  }

  return {
    project,
    passthroughArgs,
  };
}

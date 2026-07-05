import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [entry, ...args] = process.argv.slice(2);

if (entry === undefined) {
  throw new Error('Usage: node tools/run-cli-ttsx.mjs <entry.ts> [...argv]');
}

const rootRequire = createRequire(resolve('package.json'));
const typescriptPackageJson = rootRequire.resolve('typescript/package.json');
const typescriptRequire = createRequire(typescriptPackageJson);
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const platformPackageJson = typescriptRequire.resolve(`${platformPackage}/package.json`);
const platformRoot = dirname(platformPackageJson);
const tsgoBinary = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const ttscPackageJson = rootRequire.resolve('ttsc/package.json');
const ttsxLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsx.js');

if (!existsSync(tsgoBinary)) {
  throw new Error(`TypeScript-Go binary not found: ${tsgoBinary}`);
}

const result = spawnSync(process.execPath, [
  ttsxLauncher,
  '--cwd',
  process.cwd(),
  '--project',
  process.env.TTSC_PROJECT ?? 'tsconfig.tools.json',
  entry,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MPGD_CLI_ARGV: JSON.stringify(args),
    TTSC_TSGO_BINARY: tsgoBinary,
  },
});

if (result.error !== undefined) {
  throw result.error;
}

process.exit(result.status ?? 1);

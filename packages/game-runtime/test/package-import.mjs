import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-game-runtime-package-'));
const consumer = join(fixture, 'consumer');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const compiler = join(repoRoot, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

try {
  const tarballs = new Map();
  packWorkspacePackage('@mpgd/game-runtime');
  mkdirSync(consumer);
  const manifest = {
    name: 'mpgd-game-runtime-package-smoke',
    private: true,
    type: 'module',
    packageManager: readJson(join(repoRoot, 'package.json')).packageManager,
    dependencies: {
      '@mpgd/game-runtime': tarballs.get('@mpgd/game-runtime'),
      '@mpgd/game-services': tarballs.get('@mpgd/game-services'),
    },
  };
  writeJson(join(consumer, 'package.json'), manifest);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []',
    'overrides:',
    ...[...tarballs].map(([name, tarball]) => `  '${name}': ${JSON.stringify(tarball)}`),
    '',
  ].join('\n'));
  install();

  const installed = readJson(join(consumer, 'node_modules/@mpgd/game-runtime/package.json'));
  assert.notEqual(installed.private, true);
  assert.equal(JSON.stringify(installed).includes('workspace:'), false);
  assert.equal(installed.peerDependenciesMeta?.phaser?.optional, true);
  assert.deepEqual(Object.keys(installed.exports).sort(), ['.', './actions', './phaser', './platform', './ui']);
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.throws(() => import.meta.resolve('phaser'), { code: 'ERR_MODULE_NOT_FOUND' });
  `], consumer);

  // The tarball must work without repo aliases, workspace links, a DOM, or Phaser.
  for (const file of ['dist-import.mjs', 'phaser-dist-import.mjs']) {
    copyFileSync(join(repoRoot, 'packages/game-runtime/test', file), join(consumer, file));
    run(process.execPath, [file], consumer);
  }
  copyFileSync(join(repoRoot, 'packages/game-runtime/test/types.ts'), join(consumer, 'types.ts'));
  const config = {
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      noEmit: true, types: [], lib: ['ES2022'], skipLibCheck: false,
    },
    include: ['types.ts'],
  };
  writeJson(join(consumer, 'tsconfig.json'), config);
  run(compiler, ['-p', 'tsconfig.json'], consumer);

  // Opting into the binding adds Phaser; the emitted declarations must accept a real Scene.
  manifest.dependencies.phaser = readJson(join(repoRoot, 'packages/game-runtime/node_modules/phaser/package.json')).version;
  writeJson(join(consumer, 'package.json'), manifest);
  install();
  copyFileSync(join(repoRoot, 'packages/game-runtime/test/phaser-types.ts'), join(consumer, 'phaser-types.ts'));
  config.compilerOptions.lib.push('DOM');
  // Phaser 4.2.0's own declarations require the starter's skipLibCheck setting.
  // Keep the headless pass above strict so DOM/schema leaks cannot hide behind it.
  config.compilerOptions.skipLibCheck = true;
  config.include.push('phaser-types.ts');
  writeJson(join(consumer, 'tsconfig.json'), config);
  run(compiler, ['-p', 'tsconfig.json'], consumer);
  console.info('@mpgd/game-runtime packed consumer passed with and without the optional Phaser peer.');

  function packWorkspacePackage(name) {
    if (tarballs.has(name)) return;
    const directory = join(repoRoot, 'packages', name.slice('@mpgd/'.length));
    const metadata = readJson(join(directory, 'package.json'));
    const packed = JSON.parse(run(pnpm, ['pack', '--json', '--pack-destination', fixture], directory, true).stdout);
    assert.equal(typeof packed.filename, 'string');
    tarballs.set(name, `file:${packed.filename}`);
    for (const [dependency, version] of Object.entries(metadata.dependencies ?? {})) {
      if (version.startsWith('workspace:')) packWorkspacePackage(dependency);
    }
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function install() {
  // pnpm install at the repo root already populated the store. No registry is needed.
  run(pnpm, ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env: process.env, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
}

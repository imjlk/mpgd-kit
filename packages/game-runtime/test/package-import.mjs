import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This contributor smoke fixture requires Unix tar and symlink semantics.
// Run it on macOS, Linux, or WSL; this does not constrain the runtime package.
if (process.platform === 'win32') {
  throw new Error('The packed consumer smoke test requires a Unix environment (macOS, Linux, or WSL).');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-game-runtime-package-'));
const consumer = join(fixture, 'consumer');
const pnpm = 'pnpm';
const compiler = join(repoRoot, 'node_modules/.bin/tsc');

try {
  const packages = new Map();
  const edges = new Map();
  const runtime = packInstalledPackage(join(repoRoot, 'packages/game-runtime'));
  const services = packInstalledPackage(join(repoRoot, 'packages/game-services'));
  mkdirSync(consumer);
  const manifest = {
    name: 'mpgd-game-runtime-package-smoke',
    private: true,
    type: 'module',
    packageManager: readJson(join(repoRoot, 'package.json')).packageManager,
    dependencies: {
      '@mpgd/game-runtime': runtime.tarball,
      '@mpgd/game-services': services.tarball,
    },
  };
  writeJson(join(consumer, 'package.json'), manifest);
  writeOverrides();
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
  const phaserDirectory = findInstalledDependency(join(repoRoot, 'packages/game-runtime'), 'phaser');
  assert.ok(phaserDirectory, 'Missing installed dev dependency phaser');
  manifest.dependencies.phaser = packInstalledPackage(phaserDirectory).tarball;
  writeJson(join(consumer, 'package.json'), manifest);
  writeOverrides();
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

  function packInstalledPackage(inputDirectory) {
    const directory = realpathSync(inputDirectory);
    const metadata = readJson(join(directory, 'package.json'));
    const id = `${metadata.name}@${metadata.version}`;
    if (packages.has(id)) return packages.get(id);
    let archive;
    if (metadata.name.startsWith('@mpgd/')) {
      const packed = JSON.parse(run(pnpm, ['pack', '--json', '--pack-destination', fixture], directory, true).stdout);
      assert.equal(typeof packed.filename, 'string');
      archive = resolve(fixture, packed.filename);
    } else {
      // These are already-published files installed by the locked workspace.
      // Archive them verbatim without invoking npm's publisher-side validation
      // or lifecycle hooks on third-party package manifests.
      archive = join(fixture, `dependency-${packages.size}.tgz`);
      const staging = mkdtempSync(join(fixture, 'dependency-'));
      try {
        cpSync(directory, join(staging, 'package'), { recursive: true, verbatimSymlinks: true });
        run('tar', ['-czf', archive, '-C', staging, 'package'], staging, true);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    const entry = { name: metadata.name, tarball: `file:${archive}` };
    packages.set(id, entry);
    for (const dependency of Object.keys({
      ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies,
    })) {
      // Optional peers are opt-ins; in particular do not add Phaser to the headless case.
      if (metadata.peerDependenciesMeta?.[dependency]?.optional && !metadata.dependencies?.[dependency]) continue;
      const installed = findInstalledDependency(directory, dependency);
      if (!installed && metadata.optionalDependencies?.[dependency]) continue;
      assert.ok(installed, `Missing installed dependency ${id} > ${dependency}`);
      edges.set(`${id}>${dependency}`, packInstalledPackage(installed).tarball);
    }
    return entry;
  }

  function writeOverrides() {
    // Snapshot the installed dependency closure as tarballs, including multiple
    // versions via parent-specific overrides. CI's frozen install does not need
    // registry metadata and therefore does not populate an offline metadata cache.
    const byName = Map.groupBy(packages.values(), (entry) => entry.name);
    const overrides = new Map([...byName].filter(([, entries]) => entries.length === 1)
      .map(([name, entries]) => [name, entries[0].tarball]));
    for (const edge of edges) overrides.set(...edge);
    writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
      'packages: []', 'overrides:',
      ...[...overrides].map(([selector, tarball]) => `  '${selector}': ${JSON.stringify(tarball)}`), '',
    ].join('\n'));
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function install() {
  // This isolated tarball consumer has no lockfile. Avoid CI's implicit
  // frozen install; pnpm 11 does not forward --no-frozen-lockfile reliably
  // when this smoke runs inside a recursive workspace test.
  run(pnpm, [
    'install', '--offline', '--ignore-scripts', '--store-dir', join(fixture, 'store'),
  ], consumer, false, { CI: 'false' });
}

function findInstalledDependency(from, name) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd, capture = false, envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...envOverrides }, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
}

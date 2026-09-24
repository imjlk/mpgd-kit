import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  throw new Error('The Capacitor packed consumer smoke requires a Unix environment.');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-capacitor-provider-'));
const consumer = join(fixture, 'consumer');
const packages = new Map();
const edges = new Map();

try {
  const adapter = packInstalledPackage(join(repoRoot, 'adapters/capacitor'));
  const targetConfig = packInstalledPackage(join(repoRoot, 'packages/target-config'));
  const platform = packInstalledPackage(join(repoRoot, 'packages/platform'));
  const capacitorCore = [...packages.values()].find((entry) => entry.name === '@capacitor/core');
  assert.ok(capacitorCore, 'Expected the installed Capacitor peer in the packed dependency closure.');
  mkdirSync(consumer);
  writeJson(join(consumer, 'package.json'), {
    name: 'mpgd-capacitor-provider-consumer',
    private: true,
    type: 'module',
    packageManager: readJson(join(repoRoot, 'package.json')).packageManager,
    dependencies: {
      '@mpgd/adapter-capacitor': adapter.tarball,
      '@mpgd/target-config': targetConfig.tarball,
      '@mpgd/platform': platform.tarball,
      '@capacitor/core': capacitorCore.tarball,
    },
  });
  const byName = Map.groupBy(packages.values(), (entry) => entry.name);
  const overrides = new Map([...byName].filter(([, entries]) => entries.length === 1)
    .map(([name, entries]) => [name, entries[0].tarball]));
  for (const edge of edges) overrides.set(...edge);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []', 'overrides:',
    ...[...overrides].map(([selector, tarball]) => `  '${selector}': ${JSON.stringify(tarball)}`), '',
  ].join('\n'));
  run('pnpm', [
    'install', '--offline', '--ignore-scripts', '--store-dir', join(fixture, 'store'),
  ], consumer, false, { CI: 'false' });

  for (const name of ['adapter-capacitor', 'target-config', 'platform']) {
    const metadata = readJson(join(consumer, `node_modules/@mpgd/${name}/package.json`));
    assert.equal(JSON.stringify(metadata).includes('workspace:'), false);
  }
  copyFileSync(join(repoRoot, 'adapters/capacitor/test/packed-runtime.mjs'), join(consumer, 'runtime.mjs'));
  copyFileSync(join(repoRoot, 'adapters/capacitor/test/packed-types.ts'), join(consumer, 'types.ts'));
  run(process.execPath, ['runtime.mjs'], consumer);
  writeJson(join(consumer, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, exactOptionalPropertyTypes: true, noEmit: true,
      types: [], lib: ['ES2022', 'DOM'], skipLibCheck: false,
    },
    include: ['types.ts'],
  });
  run(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], consumer);
  console.info('@mpgd/adapter-capacitor and @mpgd/target-config packed consumer passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function packInstalledPackage(inputDirectory) {
  const directory = realpathSync(inputDirectory);
  const metadata = readJson(join(directory, 'package.json'));
  const id = `${metadata.name}@${metadata.version}`;
  if (packages.has(id)) return packages.get(id);
  let archive;
  if (metadata.name.startsWith('@mpgd/')) {
    const packed = JSON.parse(run('pnpm', [
      'pack', '--json', '--pack-destination', fixture,
    ], directory, true).stdout);
    assert.equal(typeof packed.filename, 'string');
    archive = resolve(fixture, packed.filename);
  } else {
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
    if (metadata.peerDependenciesMeta?.[dependency]?.optional && !metadata.dependencies?.[dependency]) continue;
    const installed = findInstalledDependency(directory, dependency);
    if (!installed && metadata.optionalDependencies?.[dependency]) continue;
    assert.ok(installed, `Missing installed dependency ${id} > ${dependency}`);
    edges.set(`${id}>${dependency}`, packInstalledPackage(installed).tarball);
  }
  return entry;
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

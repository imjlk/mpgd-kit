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
  throw new Error('The packed runtime transport consumer requires a Unix environment (macOS, Linux, or WSL).');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-runtime-transport-'));
const consumer = join(fixture, 'consumer');
const packages = new Map();
const edges = new Map();

try {
  const services = packInstalledPackage(join(repoRoot, 'packages/game-services'));
  const platform = packInstalledPackage(join(repoRoot, 'packages/platform'));
  const telemetryDirectory = findInstalledDependency(join(repoRoot, 'packages/game-services'),
    '@opentelemetry/api');
  assert.ok(telemetryDirectory, 'Missing installed @opentelemetry/api test dependency.');
  const telemetry = packInstalledPackage(telemetryDirectory);
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'mpgd-runtime-transport-consumer',
    private: true,
    type: 'module',
    packageManager: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager,
    dependencies: {
      '@mpgd/game-services': services.tarball,
      '@mpgd/platform': platform.tarball,
      '@opentelemetry/api': telemetry.tarball,
    },
  }, null, 2)}\n`);
  const byName = Map.groupBy(packages.values(), (entry) => entry.name);
  const overrides = new Map([...byName].filter(([, entries]) => entries.length === 1)
    .map(([name, entries]) => [name, entries[0].tarball]));
  for (const edge of edges) overrides.set(...edge);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []', 'overrides:',
    ...[...overrides].map(([name, tarball]) => `  '${name}': ${JSON.stringify(tarball)}`),
    '',
  ].join('\n'));
  // CI's frozen install does not populate the registry metadata cache.
  run('pnpm', ['install', '--offline', '--ignore-scripts', '--store-dir', join(fixture, 'store')],
    consumer);
  for (const name of ['@mpgd/game-services', '@mpgd/platform']) {
    const metadata = readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8');
    assert.equal(metadata.includes('workspace:'), false);
  }
  copyFileSync(join(repoRoot, 'packages/game-services/test/runtime-transport-packed-runtime.mjs'),
    join(consumer, 'runtime.mjs'));
  copyFileSync(join(repoRoot, 'packages/game-services/test/runtime-transport-packed-types.ts'),
    join(consumer, 'types.ts'));
  run(process.execPath, ['runtime.mjs'], consumer);
  writeFileSync(join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, exactOptionalPropertyTypes: true, noEmit: true,
      types: [], lib: ['ES2022', 'DOM'], skipLibCheck: false,
    },
    include: ['types.ts'],
  }, null, 2)}\n`);
  run(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], consumer);
  console.info('Packed @mpgd/game-services runtime transport consumer passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function packInstalledPackage(inputDirectory) {
  const directory = realpathSync(inputDirectory);
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const id = `${metadata.name}@${metadata.version}`;
  if (packages.has(id)) return packages.get(id);
  let archive;
  if (metadata.name.startsWith('@mpgd/')) {
    const packed = JSON.parse(run('pnpm', [
      'pack', '--json', '--pack-destination', fixture,
    ], directory).stdout);
    assert.equal(typeof packed.filename, 'string');
    archive = resolve(fixture, packed.filename);
  } else {
    archive = join(fixture, `dependency-${packages.size}.tgz`);
    const staging = mkdtempSync(join(fixture, 'dependency-'));
    try {
      cpSync(directory, join(staging, 'package'), { recursive: true, verbatimSymlinks: true });
      run('tar', ['-czf', archive, '-C', staging, 'package'], staging);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const entry = { name: metadata.name, tarball: `file:${archive}` };
  packages.set(id, entry);
  for (const dependency of Object.keys({
    ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies,
  })) {
    if (metadata.peerDependenciesMeta?.[dependency]?.optional && !metadata.dependencies?.[dependency]) {
      continue;
    }
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

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, CI: 'false' }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
  }
  return result;
}

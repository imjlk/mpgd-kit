import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-runtime-transport-'));
const consumer = join(fixture, 'consumer');
const localPackages = new Map([
  ['@mpgd/game-services', 'packages/game-services'],
  ['@mpgd/analytics', 'packages/analytics'],
  ['@mpgd/catalog', 'packages/catalog'],
  ['@mpgd/platform', 'packages/platform'],
]);

try {
  const packed = new Map();
  for (const [name, path] of localPackages) {
    const result = JSON.parse(run('pnpm', [
      'pack', '--json', '--pack-destination', fixture,
    ], join(repoRoot, path)).stdout);
    assert.equal(typeof result.filename, 'string');
    packed.set(name, `file:${resolve(fixture, result.filename)}`);
  }
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'mpgd-runtime-transport-consumer',
    private: true,
    type: 'module',
    packageManager: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager,
    dependencies: {
      '@mpgd/game-services': packed.get('@mpgd/game-services'),
      '@mpgd/platform': packed.get('@mpgd/platform'),
      '@opentelemetry/api': '1.9.0',
    },
  }, null, 2)}\n`);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []', 'overrides:',
    ...[...packed].map(([name, tarball]) => `  '${name}': ${JSON.stringify(tarball)}`),
    '',
  ].join('\n'));
  run('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], consumer);
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

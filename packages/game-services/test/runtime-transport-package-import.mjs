import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPackedDependencyCloser,
  findInstalledDependency,
} from '../../../tools/package/packed-dependency-closure.mjs';

if (process.platform === 'win32') {
  throw new Error('The packed runtime transport consumer requires a Unix environment (macOS, Linux, or WSL).');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-runtime-transport-'));
const consumer = join(fixture, 'consumer');

try {
  const closer = createPackedDependencyCloser({ fixture });
  const services = closer.pack(join(repoRoot, 'packages/game-services'));
  const platform = closer.pack(join(repoRoot, 'packages/platform'));
  const telemetryDirectory = findInstalledDependency(join(repoRoot, 'packages/game-services'),
    '@opentelemetry/api');
  assert.ok(telemetryDirectory, 'Missing installed @opentelemetry/api test dependency.');
  const telemetry = closer.pack(telemetryDirectory);
  const appleDirectory = findInstalledDependency(join(repoRoot, 'packages/game-services'),
    '@apple/app-store-server-library');
  assert.ok(appleDirectory, 'Missing installed @apple/app-store-server-library optional peer.');
  const appleServer = closer.pack(appleDirectory);
  const appleNodeTypesDirectory = findInstalledDependency(appleDirectory, '@types/node');
  assert.ok(appleNodeTypesDirectory, 'Expected the Apple server library Node types.');
  const appleNodeTypes = closer.pack(appleNodeTypesDirectory);
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
      '@apple/app-store-server-library': appleServer.tarball,
      '@types/node': appleNodeTypes.tarball,
    },
  }, null, 2)}\n`);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []', closer.overridesYaml(), '',
  ].join('\n'));
  // CI's frozen install does not populate the registry metadata cache.
  run('pnpm', ['install', '--offline', '--ignore-scripts', '--store-dir', join(fixture, 'store')],
    consumer);
  for (const name of ['@mpgd/game-services', '@mpgd/platform']) {
    const metadata = readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8');
    assert.equal(metadata.includes('workspace:'), false);
  }
  const servicesDist = join(consumer, 'node_modules/@mpgd/game-services/dist');
  for (const file of readdirSync(servicesDist)) {
    if (file.endsWith('.js') && file !== 'app-store-server.js') {
      assert.equal(readFileSync(join(servicesDist, file), 'utf8')
        .includes("'@apple/app-store-server-library'"), false,
      `game-services artifact ${file} must not import the optional Apple server peer.`);
    }
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

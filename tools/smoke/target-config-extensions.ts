import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGameViteSharedConfig } from '../../examples/phaser-starter/vite.shared';
import { targetConfigMatrixJsonEnv } from '../../packages/cli/src/target-config-env';
import { appTargetForPlatformTarget } from '../target/platform-targets';
import { loadTargetConfigMatrix } from '../target/target-config-matrix';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-target-config-extensions-'));

try {
  assert.equal(
    appTargetForPlatformTarget({ kind: 'web', adapter: 'verse8' }, 'verse8-staging'),
    'verse8',
  );
  assert.equal(
    appTargetForPlatformTarget({ kind: 'web', adapter: 'browser' }, 'storefront'),
    'browser',
  );
  assert.equal(
    appTargetForPlatformTarget({ kind: 'devvit-web', adapter: 'devvit' }, 'reddit'),
    'reddit',
  );

  const extensionsFile = path.join(root, 'extensions.json');
  const base = loadTargetConfigMatrix();
  const webPreview = base.targets['web-preview'];

  if (webPreview === undefined) {
    throw new Error('Expected the built-in web-preview target config.');
  }

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: webPreview,
    },
  })}\n`);

  const extended = loadTargetConfigMatrix(undefined, extensionsFile);

  assert.deepEqual(extended.targets.storefront, webPreview);
  assert.match(extended.version, /\+extensions\.[a-f0-9]{16}$/u);
  assertViteRuntimeMatrix(extended);

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      index: webPreview,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /Invalid deployment target name: index/u,
  );

  const microsoftStore = base.targets['microsoft-store'];
  if (microsoftStore === undefined) {
    throw new Error('Expected the built-in microsoft-store target config.');
  }

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: microsoftStore,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot use the reserved Microsoft Store PWA runtime or release profile/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      'web-preview': webPreview,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot replace built-in targets: web-preview/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('Target config extensions smoke passed.');

function assertViteRuntimeMatrix(matrix: ReturnType<typeof loadTargetConfigMatrix>): void {
  const previous = process.env[targetConfigMatrixJsonEnv];

  try {
    process.env[targetConfigMatrixJsonEnv] = JSON.stringify(matrix);
    const viteConfig = createGameViteSharedConfig({
      gameRoot: path.resolve('examples/phaser-starter'),
      mode: 'production',
      project: path.resolve('examples/phaser-starter/tsconfig.json'),
    });
    const define = viteConfig.define as Record<string, unknown> | undefined;
    const encodedMatrix = define?.__MPGD_TARGET_CONFIG_MATRIX__;

    assert.equal(typeof encodedMatrix, 'string');
    assert.deepEqual(JSON.parse(encodedMatrix as string) as unknown, matrix);

    process.env[targetConfigMatrixJsonEnv] = '[]';
    assert.throws(
      () => createGameViteSharedConfig({
        gameRoot: path.resolve('examples/phaser-starter'),
        mode: 'production',
        project: path.resolve('examples/phaser-starter/tsconfig.json'),
      }),
      /validate its shape/u,
    );

    process.env[targetConfigMatrixJsonEnv] = '{invalid';
    assert.throws(
      () => createGameViteSharedConfig({
        gameRoot: path.resolve('examples/phaser-starter'),
        mode: 'production',
        project: path.resolve('examples/phaser-starter/tsconfig.json'),
      }),
      /Failed to parse MPGD_TARGET_CONFIG_MATRIX_JSON/u,
    );
  } finally {
    if (previous === undefined) {
      delete process.env[targetConfigMatrixJsonEnv];
    } else {
      process.env[targetConfigMatrixJsonEnv] = previous;
    }
  }
}

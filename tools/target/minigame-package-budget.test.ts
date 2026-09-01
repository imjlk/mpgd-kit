import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertMiniGameArtifactPathsPortable,
  assertMiniGameArtifactRelativePath,
  assertMiniGamePackageBudget,
  listMiniGameArtifactFiles,
} from './minigame-package-budget';

const root = mkdtempSync(join(tmpdir(), 'mpgd-minigame-budget-'));

try {
  writeBytes('game.js', 20);
  writeBytes('game.json', 30);
  mkdirSync(join(root, 'feature'), { recursive: true });
  writeBytes('feature/data.bin', 40);

  assert.deepEqual(
    assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature', independent: true }] },
      budget: { mainBytes: 50, totalBytes: 90, independentSubpackageBytes: 40 },
    }),
    {
      mainBytes: 50,
      totalBytes: 90,
      subpackages: [{ root: 'feature', independent: true, bytes: 40 }],
    },
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature', independent: true }] },
      budget: { mainBytes: 49, totalBytes: 90, independentSubpackageBytes: 40 },
    }),
    /main package exceeds/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature', independent: true }] },
      budget: { mainBytes: 50, totalBytes: 89, independentSubpackageBytes: 40 },
    }),
    /total package exceeds/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature', independent: true }] },
      budget: { mainBytes: 50, totalBytes: 90, independentSubpackageBytes: 39 },
    }),
    /independent subpackage feature exceeds/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature' }, { root: 'feature/nested' }] },
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /unique and non-overlapping/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'feature' }, { root: 'FEATURE' }] },
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /unique and non-overlapping/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: '../outside' }] },
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /safe artifact-relative path/u,
  );
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: { subpackages: [{ root: 'missing' }] },
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /does not exist/u,
  );

  writeBytes('game.js.map', 1);
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: {},
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /forbidden development or credential file/u,
  );
  rmSync(join(root, 'game.js.map'));

  for (const developmentFile of [
    '.NPMRC',
    '.env.LOCAL',
    'Credentials.JSON',
    'Project.Private.Config.JSON',
    'source.jsx',
  ]) {
    writeBytes(developmentFile, 1);
    assert.throws(
      () => assertMiniGamePackageBudget({
        artifactRoot: root,
        gameConfig: {},
        budget: { mainBytes: 100, totalBytes: 100 },
      }),
      /forbidden development or credential file/u,
    );
    rmSync(join(root, developmentFile));
  }

  for (const forbiddenDirectory of ['Node_Modules', 'TEST', '__macosx']) {
    writeBytes(`${forbiddenDirectory}/payload.js`, 1);
    assert.throws(
      () => assertMiniGamePackageBudget({
        artifactRoot: root,
        gameConfig: {},
        budget: { mainBytes: 100, totalBytes: 100 },
      }),
      /forbidden development path/u,
    );
    rmSync(join(root, forbiddenDirectory), { force: true, recursive: true });
  }

  symlinkSync(join(root, 'game.js'), join(root, 'linked.js'));
  assert.throws(
    () => assertMiniGamePackageBudget({
      artifactRoot: root,
      gameConfig: {},
      budget: { mainBytes: 100, totalBytes: 100 },
    }),
    /symbolic links/u,
  );

  for (const unsafe of [
    '',
    '/game.js',
    'C:/game.js',
    '../game.js',
    'assets//game.js',
    'assets\\game.js',
    'assets/trailing.',
    'assets/trailing ',
    'assets/invalid?.png',
    'assets/CON.png',
    'assets/CONIN$.txt',
    'assets/COM\u00b9.png',
    'assets/LPT\u00b2.bin',
  ]) {
    assert.throws(
      () => assertMiniGameArtifactRelativePath(unsafe, 'fixture'),
      /safe artifact-relative path/u,
    );
  }
  assert.throws(
    () => assertMiniGameArtifactPathsPortable(['assets/Foo.js', 'assets/foo.js']),
    /collide on portable filesystems/u,
  );

  writeBytes('order/z.png', 1);
  writeBytes('order/\u00e4.png', 1);
  assert.deepEqual(
    listMiniGameArtifactFiles(root)
      .map((file) => file.path)
      .filter((path) => path.startsWith('order/')),
    ['order/z.png', 'order/\u00e4.png'],
  );
  rmSync(join(root, 'order'), { force: true, recursive: true });
  assert.throws(
    () => assertMiniGameArtifactPathsPortable(['assets/caf\u00e9.png', 'assets/cafe\u0301.png']),
    /collide on portable filesystems/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('Mini-game package budget tests passed.');

function writeBytes(path: string, size: number): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.alloc(size));
}

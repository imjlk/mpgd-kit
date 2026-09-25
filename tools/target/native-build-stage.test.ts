import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNativeShellStage } from './native-build-stage';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-native-stage-test-'));
const shell = path.join(root, 'apps/mobile-capacitor');
const web = path.join(shell, 'www');
const packageRoot = path.join(root, 'node_modules/.pnpm/example');

try {
  mkdirSync(web, { recursive: true });
  mkdirSync(path.join(shell, 'android/app'), { recursive: true });
  mkdirSync(path.join(shell, 'android/build'), { recursive: true });
  mkdirSync(path.join(shell, 'node_modules/@example'), { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(web, 'index.html'), 'source-game');
  writeFileSync(path.join(shell, 'android/app/build.gradle'), 'source-native');
  writeFileSync(path.join(shell, 'android/build/stale.bin'), 'stale-output');
  writeFileSync(path.join(packageRoot, 'package.json'), '{}');
  symlinkSync(
    '../../../../node_modules/.pnpm/example',
    path.join(shell, 'node_modules/@example/example'),
    'dir',
  );

  const first = createNativeShellStage({ shellApp: shell, webDir: web });
  const second = createNativeShellStage({ shellApp: shell, webDir: web });
  try {
    assert.notEqual(first.shellApp, second.shellApp);
    assert.equal(readFileSync(path.join(first.webDir, 'index.html'), 'utf8'), 'source-game');
    assert.equal(existsSync(path.join(first.shellApp, 'android/build/stale.bin')), false);
    assert.equal(
      existsSync(path.join(first.shellApp, 'node_modules/@example/example/package.json')),
      true,
    );
    writeFileSync(path.join(first.webDir, 'index.html'), 'android-target');
    writeFileSync(path.join(second.webDir, 'index.html'), 'ios-target');
    assert.equal(readFileSync(path.join(web, 'index.html'), 'utf8'), 'source-game');
    assert.equal(readFileSync(path.join(first.webDir, 'index.html'), 'utf8'), 'android-target');
    assert.equal(readFileSync(path.join(second.webDir, 'index.html'), 'utf8'), 'ios-target');
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.equal(existsSync(first.shellApp), false);
  assert.equal(existsSync(second.shellApp), false);
  const missingWeb = path.join(shell, 'future-web');
  const missingStage = createNativeShellStage({ shellApp: shell, webDir: missingWeb });
  try {
    assert.equal(existsSync(missingStage.webDir), false);
  } finally {
    missingStage.dispose();
  }
  assert.throws(
    () =>
      createNativeShellStage({
        shellApp: shell,
        webDir: root,
      }),
    /inside/u,
  );
  mkdirSync(path.join(shell, 'android/app/src/main'), { recursive: true });
  symlinkSync(path.join(shell, 'android/app'), path.join(shell, 'android/app/src/main/res'), 'dir');
  assert.throws(
    () => createNativeShellStage({ shellApp: shell, webDir: web }),
    /symlink is unsupported/u,
  );
  console.info('Native shell staging isolation passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

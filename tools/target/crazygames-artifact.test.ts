import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCrazyGamesArtifact } from './crazygames-artifact';

const root = mkdtempSync(join(tmpdir(), 'mpgd-crazygames-'));
try {
  writeFileSync(join(root, 'index.html'), '<script src="./assets/game.js"></script>');
  assert.equal(assertCrazyGamesArtifact(root).files, 1);
  for (const path of [
    '/assets/game.js',
    '//external.test/game.js',
    'https://external.test/game.js',
  ]) {
    writeFileSync(join(root, 'index.html'), `<script src="${path}"></script>`);
    assert.throws(() => assertCrazyGamesArtifact(root), /relative paths/u);
    writeFileSync(join(root, 'index.html'), `<script SRC=${path}></script>`);
    assert.throws(() => assertCrazyGamesArtifact(root), /relative paths/u);
  }
  writeFileSync(join(root, 'index.html'), '<script src="./game.js"></script>');
  for (let i = 0; i < 1500; i += 1) {
    writeFileSync(join(root, `${i}.txt`), '');
  }
  assert.throws(() => assertCrazyGamesArtifact(root), /1500 files/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withReleaseManifestLock } from './release-manifest-lock';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-manifest-lock-'));
const manifest = path.join(root, 'artifacts/release-manifest.json');
const lock = `${manifest}.lock`;

try {
  withReleaseManifestLock(manifest, () => {
    assert.equal(existsSync(lock), true);
    writeFileSync(manifest, '{"targets":{"android":{}}}\n');
  });
  assert.equal(existsSync(lock), false);
  withReleaseManifestLock(manifest, () => {
    const old = JSON.parse(readFileSync(manifest, 'utf8')) as { targets: object };
    writeFileSync(manifest, `${JSON.stringify({
      targets: { ...old.targets, ios: {} },
    })}\n`);
  });
  assert.deepEqual(
    Object.keys((JSON.parse(readFileSync(manifest, 'utf8')) as { targets: object }).targets),
    ['android', 'ios'],
  );

  writeFileSync(lock, `${JSON.stringify({ pid: 99999999, token: 'dead-owner' })}\n`);
  withReleaseManifestLock(manifest, () => {
    assert.equal(existsSync(lock), true);
  });
  assert.equal(existsSync(lock), false);

  symlinkSync(manifest, lock);
  assert.throws(() => withReleaseManifestLock(manifest, () => undefined), /symbolic link/u);
  console.info('Release manifest atomic lock passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

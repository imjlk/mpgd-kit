import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadTargetConfigMatrix } from '../target/target-config-matrix';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-target-config-extensions-'));

try {
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

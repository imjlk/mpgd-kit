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
import { join, resolve, sep } from 'node:path';

import { buildAssetPacks } from './asset-pack-build.js';

const cache = resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });
const fixture = mkdtempSync(join(cache, 'asset-pack-paths-'));
const source = join(fixture, 'source files');
const configPath = join(fixture, 'packs.json');
try {
  mkdirSync(source);
  writeFileSync(join(source, 'data.json'), '{"value":1}');
  writeFileSync(
    configPath,
    JSON.stringify({
      root: './source files',
      packs: [
        {
          id: 'data',
          revision: '1',
          delivery: 'files',
          assets: [{ kind: 'json', key: 'data', file: 'data.json' }],
        },
      ],
    }),
  );
  const build = (outDir: string) => buildAssetPacks({ configPath, outDir });

  // Both paths have a parent traversal relative to the source, using the host's separator.
  for (const name of ['output files', 'source files-sibling']) {
    const result = build(join(fixture, name));
    assert.ok(existsSync(result.manifestPath), `sibling output ${name} must build`);
  }
  for (const outDir of [source, join(source, 'nested output'), fixture]) {
    assert.throws(() => build(outDir), /outside the pack source root/u);
  }

  // A literal backslash in a POSIX child name is not a parent separator.
  if (sep === '/') {
    assert.throws(() => build(join(source, '..\\child')), /outside the pack source root/u);
  }
  const link = join(fixture, 'source-link');
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => build(join(link, 'nested output')), /outside the pack source root/u);
  assert.equal(readFileSync(join(source, 'data.json'), 'utf8'), '{"value":1}');
  console.log(
    'Asset-pack path checks passed: sibling outputs, overlapping roots and symlink containment.',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

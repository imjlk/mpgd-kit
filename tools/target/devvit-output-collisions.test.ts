import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNoDevvitOutputCollisions,
  findDevvitOutputCollisions,
} from './devvit-output-collisions';

const root = mkdtempSync(join(tmpdir(), 'mpgd-devvit-collisions-'));
try {
  const publicDir = join(root, 'public');
  const outDir = join(root, 'dist/client');
  mkdirSync(join(publicDir, 'fonts'), { recursive: true });
  mkdirSync(join(outDir, 'fonts'), { recursive: true });

  // Copied verbatim: not a collision.
  writeFileSync(join(publicDir, 'fonts/a.woff2'), 'font');
  writeFileSync(join(outDir, 'fonts/a.woff2'), 'font');
  writeFileSync(join(outDir, 'game.js'), 'bundle');
  // A symlinked public directory is traversed, not read as a file.
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'shared/b.txt'), 'b');
  symlinkSync(join(root, 'shared'), join(publicDir, 'linked'), 'junction');
  mkdirSync(join(outDir, 'linked'));
  writeFileSync(join(outDir, 'linked/b.txt'), 'b');
  assert.deepEqual(findDevvitOutputCollisions(outDir, [publicDir]), []);
  assertNoDevvitOutputCollisions(outDir, [publicDir, join(root, 'missing')]);

  // A public file replaced by a bundle file of the same name.
  writeFileSync(join(publicDir, 'game.js'), '// public');
  const overwritten = findDevvitOutputCollisions(outDir, [publicDir]);
  assert.equal(overwritten.length, 1);
  assert.equal(overwritten[0]?.kind, 'public');
  assert.equal(overwritten[0]?.path, 'game.js');

  // Names that differ only by case (visible only on case-sensitive filesystems).
  writeFileSync(join(outDir, 'Game.JS'), 'other');
  const all = findDevvitOutputCollisions(outDir, [publicDir]);
  const caseSensitive = all.some((collision) => collision.kind === 'case');
  assert.deepEqual(
    all.map((collision) => collision.kind).sort(),
    caseSensitive ? ['case', 'public'] : ['public'],
  );
  assert.throws(
    () => assertNoDevvitOutputCollisions(outDir, [publicDir]),
    /conflicting file name\(s\)[\s\S]*game\.js/u,
  );

  assert.deepEqual(findDevvitOutputCollisions(join(root, 'nope'), [publicDir]), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.info('devvit output collision checks passed');

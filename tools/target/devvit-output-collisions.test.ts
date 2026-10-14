import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(findDevvitOutputCollisions(outDir, [publicDir]), []);
  assertNoDevvitOutputCollisions(outDir, [publicDir, join(root, 'missing')]);

  // A public file replaced by a bundle file of the same name.
  writeFileSync(join(publicDir, 'game.js'), '// public');
  const overwritten = findDevvitOutputCollisions(outDir, [publicDir]);
  assert.equal(overwritten.length, 1);
  assert.equal(overwritten[0]?.kind, 'public');
  assert.equal(overwritten[0]?.path, 'game.js');

  // Names that differ only by case.
  writeFileSync(join(outDir, 'Game.JS'), 'other');
  const all = findDevvitOutputCollisions(outDir, [publicDir]);
  assert.deepEqual(all.map((collision) => collision.kind).sort(), ['case', 'public']);
  assert.throws(
    () => assertNoDevvitOutputCollisions(outDir, [publicDir]),
    /2 conflicting file name\(s\)[\s\S]*game\.js[\s\S]*differ only by case/u,
  );

  assert.deepEqual(findDevvitOutputCollisions(join(root, 'nope'), [publicDir]), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.info('devvit output collision checks passed');

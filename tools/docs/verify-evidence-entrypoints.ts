import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const platformManifest: unknown = JSON.parse(
  readFileSync(new URL('../../packages/platform/package.json', import.meta.url), 'utf8'),
);
assert.ok(typeof platformManifest === 'object' && platformManifest !== null);
assert.ok('exports' in platformManifest);
const exports = platformManifest.exports;
assert.ok(typeof exports === 'object' && exports !== null);
assert.ok('./capability-conformance' in exports);

// Claim 1 in tools/config/lint.ts reads the source behind this published subpath.
// Fail if the package stops exporting it or repoints it without revisiting
// the Evidence population and its guide.
assert.deepEqual(
  exports['./capability-conformance'],
  {
    types: './dist/capability-conformance.d.ts',
    default: './dist/capability-conformance.js',
  },
  'Revisit the Evidence claim and guide if the published capability-conformance subpath changes.',
);

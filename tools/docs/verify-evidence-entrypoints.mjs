import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const platformManifest = JSON.parse(
  readFileSync(new URL('../../packages/platform/package.json', import.meta.url), 'utf8'),
);

// Claim 1 in lint.config.js reads the source behind this published subpath.
// Fail if the package stops exporting it or repoints it without revisiting
// the Evidence population and its guide.
assert.deepEqual(platformManifest.exports?.['./capability-conformance'], {
  types: './dist/capability-conformance.d.ts',
  default: './dist/capability-conformance.js',
});

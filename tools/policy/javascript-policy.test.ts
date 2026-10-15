import assert from 'node:assert/strict';
import test from 'node:test';

import { validateJavaScriptInventory, type JavaScriptEntry } from './javascript-policy.js';

const entry = {
  file: 'tools/bootstrap.mjs',
  disposition: 'runtime-exception',
  reason: 'Loads the compiler before typed tools can run.',
} satisfies JavaScriptEntry;
await test('JS policy rejects unregistered source while accepting reviewed legacy debt', () => {
  assert.deepEqual(validateJavaScriptInventory([entry.file], [entry]), []);
  assert.match(
    validateJavaScriptInventory([entry.file, 'tools/new.js'], [entry]).join('\n'),
    /Unregistered.*tools\/new.js/,
  );
  assert.deepEqual(
    validateJavaScriptInventory(
      ['tools/legacy.mjs'],
      [{ ...entry, file: 'tools/legacy.mjs', disposition: 'migration-backlog' }],
    ),
    [],
  );
});
await test('JS policy rejects stale, duplicate, broad and unexplained entries', () => {
  assert.match(validateJavaScriptInventory([], [entry]).join('\n'), /Stale/);
  assert.match(validateJavaScriptInventory([entry.file], [entry, entry]).join('\n'), /Duplicate/);
  assert.match(
    validateJavaScriptInventory(['tools/*.mjs'], [{ ...entry, file: 'tools/*.mjs' }]).join('\n'),
    /exact repository-relative/,
  );
  assert.match(
    validateJavaScriptInventory([entry.file], [{ ...entry, reason: ' ' }]).join('\n'),
    /Missing.*rationale/,
  );
});

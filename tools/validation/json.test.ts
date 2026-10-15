import assert from 'node:assert/strict';
import test from 'node:test';

import { manifest, parseObject } from './json.js';

await test('JSON boundaries reject arrays, nulls, and non-string dependency declarations', () => {
  for (const source of ['null', '[]', '42']) {
    assert.throws(() => parseObject(source, 'fixture'), /fixture must be an object/);
  }
  assert.throws(
    () => manifest('{"dependencies":null}', 'fixture'),
    /dependencies must be an object/,
  );
  assert.throws(
    () => manifest('{"dependencies":{"compiler":42}}', 'fixture'),
    /compiler must be a string/,
  );
  assert.deepEqual(manifest('{}', 'fixture').dependencies, {});
});

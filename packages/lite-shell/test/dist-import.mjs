// Consumer smoke test: import the built ESM output with plain Node.
import assert from 'node:assert/strict';
import * as lite from '@mpgd/lite-shell';

for (const name of ['createLiteShell', 'createCanvasRenderer', 'createFrameLoop', 'TapRecognizer', 'loadFontSubset', 'collectGlyphs']) {
  assert.equal(typeof lite[name], 'function', `${name} export`);
}
assert.equal(lite.collectGlyphs('넵넴', '넵'), '넴넵'.split('').sort().join(''));
console.log('lite-shell dist import ok');

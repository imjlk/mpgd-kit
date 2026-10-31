import assert from 'node:assert/strict';

import { decodeBase64, decodeBase64Url } from './base64.js';

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

assert.equal(text(decodeBase64('aGk=')), 'hi');
assert.equal(text(decodeBase64('aGk')), 'hi', 'padding is optional');
assert.equal(text(decodeBase64('/+8=')), text(Uint8Array.from([0xff, 0xef])));
assert.equal(decodeBase64(''), undefined, 'empty');
assert.equal(decodeBase64('aGk==='), undefined, 'more than two pad characters');
assert.equal(decodeBase64('aG k='), undefined, 'whitespace');
assert.equal(decodeBase64('a'), undefined, 'impossible length');
assert.equal(decodeBase64('aGk-'), undefined, 'base64url characters');
assert.equal(decodeBase64('a=Gk'), undefined, 'padding inside');

assert.equal(text(decodeBase64Url('aGk')), 'hi');
assert.deepEqual(decodeBase64Url('_-8'), Uint8Array.from([0xff, 0xef]));
assert.equal(decodeBase64Url(''), undefined, 'empty');
assert.equal(decodeBase64Url('aGk='), undefined, 'padded');
assert.equal(decodeBase64Url('aGk+'), undefined, 'standard characters');
assert.equal(decodeBase64Url('aGk.'), undefined);
assert.equal(decodeBase64Url('aaaaa'), undefined, 'impossible length');

console.log('base64 decoders passed.');

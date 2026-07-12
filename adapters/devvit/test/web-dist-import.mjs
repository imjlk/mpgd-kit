import assert from 'node:assert/strict';

globalThis.addEventListener = () => {};

const webAdapter = await import('../dist/web.js');

assert.equal(typeof webAdapter.startDevvitWebSurface, 'function');
assert.equal(typeof webAdapter.requestDevvitExpandedMode, 'function');
assert.equal(typeof webAdapter.presentDevvitShareSheet, 'function');

console.log('@mpgd/adapter-devvit/web browser-condition ESM import passed.');

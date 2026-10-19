import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The main entry must not load notifications runtime code: its client and
// validators come in their own chunk (`notifications-client.js`).
const mainEntry = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
for (const specifier of ['@mpgd/bridge/notifications', '@mpgd/platform/notifications', './notifications-client.js']) {
  const quoted = specifier.replaceAll('.', '\\.').replaceAll('/', '\\/');
  assert.doesNotMatch(
    mainEntry,
    new RegExp(`(?:from|import)\\s*["']${quoted}["']`, 'u'),
    `dist/index.js must not import ${specifier} statically`,
  );
}
assert.match(
  mainEntry,
  /import\(\s*["']\.\/notifications-client\.js["']\s*\)/u,
  'dist/index.js loads the notifications client with a dynamic import',
);

globalThis.addEventListener = () => {};

const webAdapter = await import('../dist/web.js');

assert.equal(typeof webAdapter.startDevvitWebSurface, 'function');
assert.equal(typeof webAdapter.startDevvitPreviewWebView, 'function');
assert.equal(typeof webAdapter.startDevvitWebView, 'function');
assert.equal(typeof webAdapter.requestDevvitExpandedMode, 'function');
assert.equal(typeof webAdapter.presentDevvitShareSheet, 'function');
assert.equal(typeof webAdapter.createDevvitWebLoginPrompt, 'function');

console.log('@mpgd/adapter-devvit/web browser-condition ESM import passed.');

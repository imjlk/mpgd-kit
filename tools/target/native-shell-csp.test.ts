import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyCapacitorShellCsp,
  capacitorShellContentSecurityPolicy,
  capacitorShellCspMetaTag,
  hasEnforcingCspMeta,
  injectCapacitorShellCsp,
} from './native-shell-csp';

const viteIndex = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>Game</title>',
  '    <script type="module" crossorigin src="/assets/index-abc123.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">',
  '  </head>',
  '  <body><div id="game"></div></body>',
  '</html>',
  '',
].join('\n');

const injected = injectCapacitorShellCsp(viteIndex);
const metaTags = injected.match(/http-equiv="Content-Security-Policy"/gu);
assert.equal(metaTags?.length, 1, 'exactly one CSP meta tag is injected');
assert.match(
  injected,
  /<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'self'; /u,
);
assert.ok(
  injected.indexOf('Content-Security-Policy') < injected.indexOf('/assets/index-abc123.js'),
  'the policy precedes the game bundle script',
);
assert.match(injected, /script-src 'self' 'wasm-unsafe-eval';/u);
assert.match(injected, /object-src 'none';/u);
assert.match(injected, /base-uri 'self';/u);
assert.match(injected, /connect-src 'self' https: wss:;/u);
assert.doesNotMatch(injected, /script-src[^;]*'unsafe-inline'/u, 'inline scripts stay blocked');
assert.doesNotMatch(injected, /script-src[^;]*'unsafe-eval'/u, 'eval stays blocked');
assert.doesNotMatch(injected, /frame-ancestors/u, 'frame-ancestors is ignored in meta policies');
assert.doesNotMatch(
  capacitorShellContentSecurityPolicy,
  /https?:\/\//u,
  'no remote hosts are allowed by default',
);
assert.equal(injectCapacitorShellCsp(injected), injected, 'injection is idempotent');

function withMeta(meta: string): string {
  return viteIndex.replace('<head>', `<head>${meta}`);
}

const enforcingMetas = [
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' https://cdn.example">',
  "<meta http-equiv='content-security-policy' content=\"default-src 'self'\">",
  '<meta http-equiv=Content-Security-Policy content="default-src \'self\' https://cdn.example">',
  '<meta content="default-src \'self\'" HTTP-EQUIV = "CONTENT-SECURITY-POLICY" />',
];
for (const meta of enforcingMetas) {
  const ownPolicy = withMeta(meta);
  assert.equal(hasEnforcingCspMeta(ownPolicy), true, `enforcing meta detected: ${meta}`);
  assert.equal(
    injectCapacitorShellCsp(ownPolicy),
    ownPolicy,
    `a game-owned CSP is preserved: ${meta}`,
  );
}

const nonEnforcingMetas = [
  '<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src \'none\'">',
  '<meta http-equiv=Content-Security-Policy-Report-Only content="default-src \'none\'">',
  '<meta http-equiv="Content-Security-Policy " content="default-src \'none\'">',
  '<meta http-equiv="X-Content-Security-Policy" content="default-src \'none\'">',
  '<meta name="Content-Security-Policy" content="default-src \'none\'">',
  '<meta http-equiv="refresh" content="0; url=/">',
];
for (const meta of nonEnforcingMetas) {
  const page = withMeta(meta);
  assert.equal(hasEnforcingCspMeta(page), false, `non-enforcing meta ignored: ${meta}`);
  const hardened = injectCapacitorShellCsp(page);
  assert.notEqual(hardened, page, `an enforcing CSP is still injected: ${meta}`);
  assert.ok(hardened.includes(meta), `the original meta tag is preserved: ${meta}`);
  assert.equal(
    hardened.split(capacitorShellCspMetaTag).length - 1,
    1,
    `exactly one enforcing CSP is injected: ${meta}`,
  );
  assert.equal(injectCapacitorShellCsp(hardened), hardened, `injection stays idempotent: ${meta}`);
}
assert.equal(hasEnforcingCspMeta(viteIndex), false);
assert.equal(hasEnforcingCspMeta(injected), true);
assert.match(
  injectCapacitorShellCsp('<html><HEAD lang="en"><title>x</title></HEAD></html>'),
  /<HEAD lang="en">\n<meta http-equiv="Content-Security-Policy"/u,
  'head tags with attributes and any casing are handled',
);
assert.throws(
  () => injectCapacitorShellCsp('<html><body></body></html>'),
  /must contain a <head> element/u,
);

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-native-shell-csp-'));
try {
  const webDir = path.join(root, 'www');
  assert.throws(() => applyCapacitorShellCsp(webDir), /regular index\.html/u);
  mkdirSync(webDir, { recursive: true });
  writeFileSync(path.join(webDir, 'index.html'), viteIndex);
  applyCapacitorShellCsp(webDir);
  const staged = readFileSync(path.join(webDir, 'index.html'), 'utf8');
  assert.equal(staged, injected, 'the staged bundle receives the shell CSP');
  applyCapacitorShellCsp(webDir);
  assert.equal(readFileSync(path.join(webDir, 'index.html'), 'utf8'), injected);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('Native shell Content-Security-Policy staging passed.');

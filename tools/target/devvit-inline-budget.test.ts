import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertDevvitInlineBudget, collectDevvitInlineGraph } from './devvit-inline-budget';

const root = mkdtempSync(join(tmpdir(), 'mpgd-devvit-inline-'));
try {
  mkdirSync(join(root, 'assets'));
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module" crossorigin src="/assets/preview.js"></script><link rel="stylesheet" href="./assets/preview.css">',
  );
  writeFileSync(
    join(root, 'assets/preview.js'),
    'import{a}from"./shared.js";const g=()=>import("./phaser.js");a(g);',
  );
  writeFileSync(join(root, 'assets/shared.js'), 'export const a=(x)=>x;');
  writeFileSync(join(root, 'assets/preview.css'), 'body{margin:0}');
  writeFileSync(join(root, 'assets/phaser.js'), 'console.log("Phaser v4.2.0");'.repeat(2000));

  const report = collectDevvitInlineGraph(root, 'index.html', ['assets/phaser*.js']);
  assert.deepEqual(report.files.map((file) => file.path).sort(), [
    'assets/preview.css',
    'assets/preview.js',
    'assets/shared.js',
    'index.html',
  ]);

  for (const html of [
    '<script src=/assets/preview.js></script><link rel=stylesheet href=./assets/preview.css>',
    '<script src = /assets/preview.js></script><link rel="alternate stylesheet" href=./assets/preview.css>',
    '<SCRIPT SRC="/assets/preview.js"></SCRIPT><LINK REL="STYLESHEET" HREF="./assets/preview.css">',
    '<ScRiPt SrC="/assets/preview.js"></ScRiPt><LiNk HrEf="./assets/preview.css" ReL="stylesheet">',
  ]) {
    writeFileSync(join(root, 'index.html'), html);
    assert.deepEqual(
      collectDevvitInlineGraph(root, 'index.html', ['assets/phaser*.js']).files.map((file) => file.path).sort(),
      report.files.map((file) => file.path).sort(),
    );
    assert.throws(
      () =>
        assertDevvitInlineBudget({
          target: 'reddit',
          clientDir: root,
          inlineEntry: 'index.html',
          budget: { forbidModules: ['phaser'] },
        }),
      /forbidden module\(s\): phaser/,
    );
  }

  // Dynamic imports are followed unless declared deferred.
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'] },
      }),
    /forbidden module\(s\): phaser/,
  );

  // A deferred (expanded-only) Phaser chunk is allowed.
  assert.doesNotThrow(() =>
    assertDevvitInlineBudget({
      target: 'reddit',
      clientDir: root,
      inlineEntry: 'index.html',
      budget: { maxGzipKb: 1, forbidModules: ['phaser'], deferredChunks: ['assets/phaser.js'] },
    }),
  );

  // A static Phaser import is rejected by name and by content signature.
  writeFileSync(join(root, 'assets/shared.js'), 'import"./phaser.js";export const a=(x)=>x;');
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'], deferredChunks: ['assets/phaser.js'] },
      }),
    /forbidden module\(s\): phaser in assets\/phaser\.js/,
  );

  writeFileSync(
    join(root, 'assets/shared.js'),
    `export const a=${JSON.stringify(randomBytes(8192).toString('base64'))};`,
  );
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { maxGzipKb: 1 },
      }),
    /exceeds inlineBudget\.maxGzipKb 1 KiB/,
  );

  // CSS imports are static first-load edges, even if listed as deferred.
  writeFileSync(join(root, 'assets/preview.css'), '@import url("./more.css");body{margin:0}');
  writeFileSync(join(root, 'assets/more.css'), '@import "./nested.css";');
  writeFileSync(join(root, 'assets/nested.css'), 'body{color:red}');
  const cssReport = collectDevvitInlineGraph(root, 'index.html', ['assets/*.css']);
  assert.ok(cssReport.files.some((file) => file.path === 'assets/more.css'));
  assert.ok(cssReport.files.some((file) => file.path === 'assets/nested.css'));
  writeFileSync(
    join(root, 'assets/preview.css'),
    '@font-face{src:url("./font.woff2")}body{background:url(./image.png);mask:url(#local)}',
  );
  writeFileSync(join(root, 'assets/font.woff2'), randomBytes(4096));
  writeFileSync(join(root, 'assets/image.png'), randomBytes(4096));
  const withAssets = collectDevvitInlineGraph(root, 'index.html', ['assets/phaser.js']);
  assert.ok(withAssets.files.some((file) => file.path === 'assets/font.woff2'));
  assert.ok(withAssets.files.some((file) => file.path === 'assets/image.png'));
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { maxGzipKb: 1, deferredChunks: ['assets/phaser.js'] },
      }),
    /exceeds inlineBudget/,
  );

  // HTML media and preload bytes are part of the first load even when named as deferred.
  writeFileSync(join(root, 'index.html'), [
    '<IMG SRC="./assets/image.png">',
    '<LINK HREF="./assets/font.woff2" AS="font" REL="PRELOAD">',
    '<video src="./assets/movie.mp4" poster="./assets/poster.png"></video>',
    '<img src="data:image/png;base64,AAAA">',
  ].join(''));
  writeFileSync(join(root, 'assets/movie.mp4'), randomBytes(4096));
  writeFileSync(join(root, 'assets/poster.png'), randomBytes(4096));
  const media = collectDevvitInlineGraph(root, 'index.html', ['assets/*']);
  assert.deepEqual(media.files.map((file) => file.path).sort(), [
    'assets/font.woff2',
    'assets/image.png',
    'assets/movie.mp4',
    'assets/poster.png',
    'index.html',
  ]);
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { maxGzipKb: 1 },
      }),
    /exceeds inlineBudget/,
  );

  // Responsive candidates include data URLs with commas, but only local files add bytes.
  writeFileSync(join(root, 'index.html'), [
    '<img srcset="data:image/png;base64,AAAA 1x, ./assets/image.png 2x">',
    '<source srcset="./assets/poster.png 300w, ./assets/image.png 600w">',
    '<link rel="preload" as="image" imagesrcset="./assets/movie.mp4 1x">',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/image.png', 'assets/movie.mp4', 'assets/poster.png', 'index.html'],
  );
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { maxGzipKb: 1 },
      }),
    /exceeds inlineBudget/,
  );

  // An HTML entry cannot defer a script or preload by giving its filename.
  writeFileSync(join(root, 'index.html'), '<script src="/assets/phaser.js"></script>');
  writeFileSync(join(root, 'assets/phaser.js'), 'export const opaque=1;');
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'], deferredChunks: ['assets/phaser.js'] },
      }),
    /forbidden module\(s\): phaser in assets\/phaser\.js/,
  );

  assert.throws(
    () =>
      assertDevvitInlineBudget({ target: 'reddit', clientDir: root, inlineEntry: 'missing.html' }),
    /does not exist/,
  );

  // The HTML response, including inline scripts and styles, is first-load content.
  writeFileSync(join(root, 'index.html'), '<script>console.log("Phaser v4.2.0")</script>');
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'] },
      }),
    /forbidden module\(s\): phaser in index\.html/,
  );
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module">import "./assets/phaser.js";</script>',
  );
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'] },
      }),
    /forbidden module\(s\): phaser in assets\/phaser\.js/,
  );
  writeFileSync(join(root, 'index.html'), '<style>@import "./assets/more.css";</style>');
  assert.ok(
    collectDevvitInlineGraph(root, 'index.html').files.some(
      (file) => file.path === 'assets/nested.css',
    ),
  );
  writeFileSync(join(root, 'index.html'), `<style>${randomBytes(4096).toString('base64')}</style>`);
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { maxGzipKb: 1 },
      }),
    /exceeds inlineBudget/,
  );

  // Parse actual syntax rather than code-shaped strings, comments or inert HTML.
  writeFileSync(join(root, 'assets/real.js'), 'export const value = 1;');
  writeFileSync(join(root, 'assets/syntax.js'), [
    '// import("./missing-comment.js")',
    'const tutorial = \'import("./missing-string.js")\';',
    'const template = `import("./missing-template.js")`;',
    'const pattern = /import\\(".\\/missing-regex.js"\\)/;',
    'export { value } from "./real.js";',
    'const lazy = import /* allowed comment */ ("./real.js?v=2");',
  ].join('\n'));
  writeFileSync(join(root, 'index.html'), [
    '<!-- <script src=./missing-comment.js></script> -->',
    '<template><script src=./missing-template.js></script></template>',
    '<script type=application/json>{"text":"import(\\"./missing-json.js\\")"}</script>',
    '<script src=./assets/syntax.js></script>',
    '<div style="background: url(&quot;./assets/image.png&quot;)"></div>',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/image.png', 'assets/real.js', 'assets/real.js?v=2', 'assets/syntax.js', 'index.html'],
  );

  // URL identities retain query strings; identical references still deduplicate.
  writeFileSync(join(root, 'index.html'), [
    '<script src="./assets/real.js?v=1&amp;x=2"></script>',
    '<script src="./assets/real.js?v=1&#38;x=2"></script>',
    '<script src="./assets/real.js?v=2"></script>',
  ].join(''));
  const queries = collectDevvitInlineGraph(root, 'index.html');
  assert.deepEqual(queries.files.map((file) => file.path).sort(), [
    'assets/real.js?v=1&x=2',
    'assets/real.js?v=2',
    'index.html',
  ]);
  assert.equal(queries.files[1]?.gzipBytes, queries.files[2]?.gzipBytes);

  // External bytes cannot be verified locally. Inspection reports them; enforcement rejects them.
  for (const html of [
    '<script src=https://example.invalid/game.js></script>',
    '<link rel=stylesheet href=//example.invalid/game.css>',
    '<div style="background:url(https://example.invalid/image.png)"></div>',
    '<style>@font-face{src:url(https://example.invalid/font.woff2)}</style>',
    '<img srcset="//example.invalid/image.png 2x">',
    '<script type=module>import "https://example.invalid/game.js";</script>',
  ]) {
    writeFileSync(join(root, 'index.html'), html);
    assert.equal(collectDevvitInlineGraph(root, 'index.html').externalReferences.length, 1);
    assert.throws(
      () =>
        assertDevvitInlineBudget({
          target: 'reddit',
          clientDir: root,
          inlineEntry: 'index.html',
          budget: { maxGzipKb: 40 },
        }),
      /cannot verify external/,
    );
  }
  writeFileSync(
    join(root, 'index.html'),
    '<base href="https://example.invalid/"><script src=assets/real.js></script>',
  );
  assert.throws(() => collectDevvitInlineGraph(root, 'index.html'), /base href/);

  assert.throws(() => collectDevvitInlineGraph(root, join(root, 'index.html')), /must be relative/);
  assert.throws(
    () => collectDevvitInlineGraph(root, '../index.html'),
    /escapes the client artifact/,
  );
  writeFileSync(join(root, 'index.html'), '<script src="../outside.js"></script>');
  assert.throws(() => collectDevvitInlineGraph(root, 'index.html'), /escapes the client artifact/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('devvit inline budget tests passed');

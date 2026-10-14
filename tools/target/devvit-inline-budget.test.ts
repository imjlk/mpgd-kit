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
    '<script type=module src=/assets/preview.js></script><link rel=stylesheet href=./assets/preview.css>',
    '<script type=module src = /assets/preview.js></script><link rel="alternate stylesheet" href=./assets/preview.css>',
    '<SCRIPT TYPE=module SRC="/assets/preview.js"></SCRIPT><LINK REL="STYLESHEET" HREF="./assets/preview.css">',
    '<ScRiPt TyPe=module SrC="/assets/preview.js"></ScRiPt><LiNk HrEf="./assets/preview.css" ReL="stylesheet">',
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
  writeFileSync(join(root, 'index.html'), '<script type=module src="/assets/phaser.js"></script>');
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
  writeFileSync(
    join(root, 'index.html'),
    `<style>/*${randomBytes(4096).toString('base64')}*/</style>`,
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
    '<!-- <script type=module src=./missing-comment.js></script> -->',
    '<template><script type=module src=./missing-template.js></script></template>',
    '<script type=application/json>{"text":"import(\\"./missing-json.js\\")"}</script>',
    '<script type=module src=./assets/syntax.js></script>',
    '<div style="background: url(&quot;./assets/image.png&quot;)"></div>',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/image.png', 'assets/real.js', 'assets/real.js?v=2', 'assets/syntax.js', 'index.html'],
  );

  // CSS comments and quoted examples do not create first-load edges.
  writeFileSync(join(root, 'index.html'), [
    '<style>/* url(https://example.invalid/comment.png) */',
    'div::after { content: "url(https://example.invalid/text.png)"; background: url(./assets/image.png) }</style>',
  ].join(''));
  const cssSyntax = assertDevvitInlineBudget({
    target: 'reddit',
    clientDir: root,
    inlineEntry: 'index.html',
    budget: { maxGzipKb: 40 },
  });
  assert.deepEqual(cssSyntax.files.map((file) => file.path).sort(), [
    'assets/image.png',
    'index.html',
  ]);
  assert.deepEqual(cssSyntax.externalReferences, []);

  // URL identities retain query strings; identical references still deduplicate.
  writeFileSync(join(root, 'index.html'), [
    '<script type=module src="./assets/real.js?v=1&amp;x=2"></script>',
    '<script type=module src="./assets/real.js?v=1&#38;x=2"></script>',
    '<script type=module src="./assets/real.js?v=2"></script>',
  ].join(''));
  const queries = collectDevvitInlineGraph(root, 'index.html');
  assert.deepEqual(queries.files.map((file) => file.path).sort(), [
    'assets/real.js?v=1&x=2',
    'assets/real.js?v=2',
    'index.html',
  ]);
  assert.equal(queries.files[1]?.gzipBytes, queries.files[2]?.gzipBytes);

  // Classic scripts retain sloppy syntax, while imported children are modules.
  const classic = 'with (Math) { console.log(010); } import("./real.js");';
  writeFileSync(join(root, 'assets/classic.js'), classic);
  writeFileSync(join(root, 'index.html'), '<script src="./assets/classic.js"></script>');
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/classic.js', 'assets/real.js', 'index.html'],
  );
  for (const type of ['', 'text/ecmascript', 'application/x-javascript', 'text/javascript1.5']) {
    writeFileSync(
      join(root, 'index.html'),
      `<script type="${type}">${classic.replace('./real.js', './assets/real.js')}</script>`,
    );
    assert.deepEqual(
      collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
      ['assets/real.js', 'index.html'],
    );
  }
  writeFileSync(
    join(root, 'index.html'),
    '<script type="application/json" src="./missing.json"></script>',
  );
  assert.equal(collectDevvitInlineGraph(root, 'index.html').files.length, 1);

  // Fragments never distinguish requests, including question marks within fragments.
  writeFileSync(join(root, 'index.html'), [
    '<script type=module src="./assets/real.js#preview?v=1"></script>',
    '<script type=module src="./assets/real.js#preview?v=2"></script>',
    '<script type=module src="./assets/real.js?v=3#preview?v=4"></script>',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/real.js', 'assets/real.js?v=3', 'index.html'],
  );

  // A namespace URL identifies a namespace; it is not fetched.
  writeFileSync(
    join(root, 'index.html'),
    '<style>@namespace svg url("http://www.w3.org/2000/svg");svg|a{background:url(./assets/image.png)}</style>',
  );
  const namespace = assertDevvitInlineBudget({
    target: 'reddit',
    clientDir: root,
    inlineEntry: 'index.html',
    budget: { maxGzipKb: 40 },
  });
  assert.deepEqual(namespace.externalReferences, []);
  assert.equal(namespace.files.length, 2);

  // HTTPS references without an authority resolve against the deployment URL.
  writeFileSync(join(root, 'index.html'), [
    '<script type=module src="https:./assets/real.js"></script>',
    '<script type=module src="https:/assets/real.js"></script>',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/real.js', 'index.html'],
  );

  // External bytes cannot be verified locally. Inspection reports them; enforcement rejects them.
  writeFileSync(
    join(root, 'index.html'),
    '<script src="data:text/javascript,console.log(5%2)"></script><iframe src="about:blank#preview"></iframe>',
  );
  assert.deepEqual(collectDevvitInlineGraph(root, 'index.html').externalReferences, []);
  writeFileSync(join(root, 'assets/later.js'), 'import "https://example.invalid/later.js";');
  writeFileSync(join(root, 'index.html'), '<link rel=preload as=script href="./assets/later.js">');
  assert.deepEqual(collectDevvitInlineGraph(root, 'index.html').externalReferences, []);
  writeFileSync(
    join(root, 'index.html'),
    '<script type=module src="./assets/later.js"></script><link rel=preload as=script href="./assets/later.js">',
  );
  const preloadedScript = collectDevvitInlineGraph(root, 'index.html');
  assert.equal(preloadedScript.externalReferences.length, 1);
  assert.equal(preloadedScript.files.length, 2);
  writeFileSync(
    join(root, 'index.html'),
    '<svg><image href="./assets/image.png"/><image xlink:href="./assets/poster.png"/></svg>',
  );
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/image.png', 'assets/poster.png', 'index.html'],
  );
  const externalImport = 'import "https://example.invalid/game.js";';
  const dataScript = `data:text/javascript,${encodeURIComponent(externalImport)}`;
  const dataBase64 = `data:text/javascript;base64,${Buffer.from(externalImport).toString('base64')}`;
  for (const html of [
    `<script type=module src="${dataScript}"></script>`,
    '<svg><image href="https://example.invalid/image.png"/></svg>',
    `<script type=module src="${dataBase64}"></script>`,
    '<link rel=stylesheet href="data:text/css,body%7Bbackground:url(https://example.invalid/image.png)%7D">',
    '<style>body{background:image-set("https://example.invalid/image.png" 1x)}</style>',
    '<iframe src="https://example.invalid/frame.html"></iframe>',
    '<script type=module src=https://example.invalid/game.js></script>',
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
  // Local image-set candidates and nested documents are counted; srcdoc overrides src.
  writeFileSync(join(root, 'frame.html'), '<script type=module src="./assets/real.js"></script>');
  writeFileSync(join(root, 'index.html'), [
    '<iframe src="./frame.html"></iframe>',
    '<iframe loading=lazy src="./missing-frame.html"></iframe>',
    '<iframe src="./missing-override.html" srcdoc="&lt;img src=./assets/poster.png&gt;"></iframe>',
    '<style>body{background:-webkit-image-set("./assets/image.png" 1x, url(./assets/poster.png) 2x)}</style>',
  ].join(''));
  assert.deepEqual(
    collectDevvitInlineGraph(root, 'index.html').files.map((file) => file.path).sort(),
    ['assets/image.png', 'assets/poster.png', 'assets/real.js', 'frame.html', 'index.html'],
  );
  // Script type attributes use essence matching, not Content-Type header parsing.
  writeFileSync(
    join(root, 'index.html'),
    '<script type="text/javascript; charset=utf-8" src="./missing-inert.js"></script>',
  );
  assert.equal(collectDevvitInlineGraph(root, 'index.html').files.length, 1);
  writeFileSync(
    join(root, 'index.html'),
    '<script type=module src="data:text/javascript,console.log(%27Phaser%20v4.2.0%27)"></script>',
  );
  assert.throws(
    () =>
      assertDevvitInlineBudget({
        target: 'reddit',
        clientDir: root,
        inlineEntry: 'index.html',
        budget: { forbidModules: ['phaser'] },
      }),
    /forbidden module/,
  );
  writeFileSync(
    join(root, 'index.html'),
    '<script type=module src="data:text/javascript,import%20%27./relative.js%27"></script>',
  );
  assert.throws(() => collectDevvitInlineGraph(root, 'index.html'), /Relative dependencies inside/);
  writeFileSync(
    join(root, 'index.html'),
    '<base href="https://example.invalid/"><script type=module src=assets/real.js></script>',
  );
  assert.throws(() => collectDevvitInlineGraph(root, 'index.html'), /base href/);

  assert.throws(() => collectDevvitInlineGraph(root, join(root, 'index.html')), /must be relative/);
  assert.throws(
    () => collectDevvitInlineGraph(root, '../index.html'),
    /escapes the client artifact/,
  );
  writeFileSync(join(root, 'index.html'), '<script type=module src="../outside.js"></script>');
  assert.throws(() => collectDevvitInlineGraph(root, 'index.html'), /escapes the client artifact/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('devvit inline budget tests passed');

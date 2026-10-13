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

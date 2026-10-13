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
  ]);

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
        budget: { forbidModules: ['phaser'] },
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

  assert.throws(
    () =>
      assertDevvitInlineBudget({ target: 'reddit', clientDir: root, inlineEntry: 'missing.html' }),
    /does not exist/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('devvit inline budget tests passed');

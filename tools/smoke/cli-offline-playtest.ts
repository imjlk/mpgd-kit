import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultOfflinePlaytestMaximumBytes,
  runOfflinePlaytestPackaging,
} from '../../packages/cli/src/index';

const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), 'mpgd-offline-playtest-'));
const outsideRoot = fs.mkdtempSync(path.join(tmpdir(), 'mpgd-offline-playtest-outside-'));
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

try {
  const gameRoot = createPreviewFixture('happy');
  const result = await runOfflinePlaytestPackaging({ gameRoot });
  const html = fs.readFileSync(result.entryFile, 'utf8');
  const readme = fs.readFileSync(result.readmeFile, 'utf8');
  const evidence = JSON.parse(
    fs.readFileSync(result.evidenceFile, 'utf8'),
  ) as Record<string, unknown>;

  assert.match(html, /mpgd-purpose" content="test-play-only/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /wasm-unsafe-eval/u);
  assert.match(html, /blocked network access/u);
  assert.match(html, /data:image\/png;base64,/u);
  assert.match(html, /data:application\/json;base64,/u);
  assert.match(html, /<style>/u);
  assert.match(html, /color:red/u);
  assert.doesNotMatch(html, /srcset="\/assets\//u);
  assert.doesNotMatch(html, /\/assets\/pixel\.png/u);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/u);
  assert.doesNotMatch(html, /<link\b[^>]*\brel=["']stylesheet/u);
  assert.match(html, /<script type="module">/u);
  assert.match(readme, /TEST PLAY ONLY/u);
  assert.match(readme, /not a release target/u);
  assert.equal(evidence.purpose, 'test-play-only');
  assert.equal(evidence.releaseTarget, false);
  assert.equal(evidence.sourceTarget, 'web-preview');
  assert.equal(evidence.networkPolicy, 'deny-network');
  assert.match(String(evidence.sha256), /^[a-f\d]{64}$/u);
  assert.equal(Number(evidence.inlinedAssetCount), 5);
  assert.equal(result.evidence.bytes, Buffer.byteLength(html));
  const repeatedResult = await runOfflinePlaytestPackaging({ gameRoot });
  assert.equal(repeatedResult.evidence.sha256, result.evidence.sha256);

  await assert.rejects(
    () => runOfflinePlaytestPackaging({
      gameRoot,
      artifactDir: 'artifacts/web-preview',
      outputDir: 'artifacts/web-preview/offline',
    }),
    /must not overlap/u,
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({
      gameRoot,
      artifactDir: 'artifacts/web-preview',
      outputDir: 'artifacts/web-preview',
    }),
    /must not overlap/u,
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot, outputDir: '../outside' }),
    /must be a child of the game root/u,
  );
  fs.mkdirSync(path.join(gameRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(gameRoot, 'src/keep.txt'), 'keep\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot, outputDir: 'src' }),
    /must stay under/u,
  );
  assert.equal(fs.readFileSync(path.join(gameRoot, 'src/keep.txt'), 'utf8'), 'keep\n');
  const occupiedOutput = path.join(gameRoot, 'artifacts/occupied-output');
  fs.mkdirSync(occupiedOutput, { recursive: true });
  fs.writeFileSync(path.join(occupiedOutput, 'keep.txt'), 'keep\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot, outputDir: 'artifacts/occupied-output' }),
    /containing non-generated content/u,
  );
  assert.equal(fs.readFileSync(path.join(occupiedOutput, 'keep.txt'), 'utf8'), 'keep\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot, maximumBytes: 100 }),
    /exceeding the 100-byte limit/u,
  );
  assert.equal(defaultOfflinePlaytestMaximumBytes, 25 * 1024 * 1024);

  const releaseArtifactGame = createPreviewFixture('release-artifact', {
    effectiveTarget: { target: 'web', runtime: 'web' },
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: releaseArtifactGame }),
    /accepts only a web-preview artifact/u,
  );

  const remoteStylesheetGame = createPreviewFixture('remote-stylesheet', {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="https://example.com/app.css"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: remoteStylesheetGame }),
    /cannot inline external URL/u,
  );

  const cssImportGame = createPreviewFixture('css-import');
  fs.writeFileSync(
    path.join(cssImportGame, 'artifacts/web-preview/assets/main.css'),
    '@import "./theme.css"; body { color: white; }',
  );
  fs.writeFileSync(
    path.join(cssImportGame, 'artifacts/web-preview/assets/theme.css'),
    'body { background: black; }',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: cssImportGame }),
    /does not support CSS @import rules/u,
  );

  const workerGame = createPreviewFixture('worker', {
    mainJs: 'new Worker("./worker.js");',
  });
  fs.writeFileSync(
    path.join(workerGame, 'artifacts/web-preview/assets/worker.js'),
    'self.close();',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: workerGame }),
    /does not support Worker/u,
  );

  const inlineWorkerGame = createPreviewFixture('inline-worker', {
    indexHtml: '<!doctype html><html><head><script>new Worker("worker.js");</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: inlineWorkerGame }),
    /does not support Worker/u,
  );

  const commonAssetGame = createPreviewFixture('common-phaser-assets', {
    mainJs: 'document.body.dataset.assets = [new URL("./sound.m4a", import.meta.url).href, new URL("./voice.opus", import.meta.url).href, new URL("./font.fnt", import.meta.url).href, new URL("./sprites.atlas", import.meta.url).href, new URL("./shader.glsl", import.meta.url).href, new URL("./scene.gltf", import.meta.url).href, new URL("./model.glb", import.meta.url).href].join(",");',
  });
  const commonAssets = [
    'sound.m4a',
    'voice.opus',
    'font.fnt',
    'sprites.atlas',
    'shader.glsl',
    'scene.gltf',
    'model.glb',
  ];

  for (const asset of commonAssets) {
    fs.writeFileSync(
      path.join(commonAssetGame, 'artifacts/web-preview/assets', asset),
      `fixture:${asset}\n`,
    );
  }

  const commonAssetResult = await runOfflinePlaytestPackaging({ gameRoot: commonAssetGame });
  const commonAssetHtml = fs.readFileSync(commonAssetResult.entryFile, 'utf8');
  assert.equal(commonAssetResult.evidence.inlinedAssetCount, 10);
  assert.match(commonAssetHtml, /data:audio\/mp4;base64,/u);
  assert.match(commonAssetHtml, /data:audio\/opus;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf\+json;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf-binary;base64,/u);

  const documentAssetGame = createPreviewFixture('document-relative-assets', {
    mainJs: 'document.body.dataset.assets = ["./assets/pixel.png", "assets/pixel.png", "/audio/theme.mp3"].join(",");',
  });
  fs.mkdirSync(path.join(documentAssetGame, 'artifacts/web-preview/audio'), { recursive: true });
  fs.writeFileSync(
    path.join(documentAssetGame, 'artifacts/web-preview/audio/theme.mp3'),
    'fixture:theme\n',
  );
  const documentAssetResult = await runOfflinePlaytestPackaging({ gameRoot: documentAssetGame });
  const documentAssetHtml = fs.readFileSync(documentAssetResult.entryFile, 'utf8');
  assert.doesNotMatch(documentAssetHtml, /(?:\.\/)?assets\/pixel\.png/u);
  assert.doesNotMatch(documentAssetHtml, /\/audio\/theme\.mp3/u);
  assert.match(documentAssetHtml, /data:audio\/mpeg;base64,/u);

  const rootAssetHtml = await packageAndReadFixture(
    'root-level-asset',
    { mainJs: 'document.body.dataset.theme = "/theme.mp3";' },
    [['artifacts/web-preview/theme.mp3', 'fixture:root-theme\n']],
  );
  assert.doesNotMatch(rootAssetHtml, /["']\/theme\.mp3["']/u);
  assert.match(rootAssetHtml, /data:audio\/mpeg;base64,/u);

  const existingCspHtml = await packageAndReadFixture('existing-csp', {
    indexHtml: '<!doctype html><html><head><meta content="default-src \'self\'" http-equiv=Content-Security-Policy><link rel="stylesheet" href="/assets/main.css"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(existingCspHtml, /default-src 'self'/u);
  const cspMetaTags = existingCspHtml.match(/http-equiv="Content-Security-Policy"/gu);
  assert.ok(
    cspMetaTags,
    `Expected the generated CSP meta tag. HTML: ${existingCspHtml.slice(0, 500)}`,
  );
  assert.equal(cspMetaTags.length, 1);

  const mixedSrcsetHtml = await packageAndReadFixture('mixed-srcset', {
    indexHtml: '<!doctype html><html><head></head><body><img srcset="data:image/png;base64,AAAA, /assets/pixel.png 2x, blob:fixture 3x"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(mixedSrcsetHtml, /data:image\/png;base64,AAAA/u);
  assert.match(mixedSrcsetHtml, /blob:fixture 3x/u);
  assert.doesNotMatch(mixedSrcsetHtml, /\/assets\/pixel\.png/u);

  const mediaStylesheetHtml = await packageAndReadFixture('media-stylesheet', {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css" media="(prefers-color-scheme: dark)"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(mediaStylesheetHtml, /<style media="\(prefers-color-scheme: dark\)">/u);

  const parenthesizedCssHtml = await packageAndReadFixture(
    'parenthesized-css-asset',
    {},
    [
      [
        'artifacts/web-preview/assets/main.css',
        'body { background-image: url("./sprite(2x).png"); }',
      ],
      ['artifacts/web-preview/assets/sprite(2x).png', onePixelPng],
    ],
  );
  assert.doesNotMatch(parenthesizedCssHtml, /sprite\(2x\)\.png/u);
  assert.match(parenthesizedCssHtml, /data:image\/png;base64,/u);

  const unquotedHtmlAssetHtml = await packageAndReadFixture('unquoted-html-asset', {
    indexHtml: '<!doctype html><html><head><link rel=stylesheet href=/assets/main.css></head><body><img src=/assets/pixel.png><main id=game></main><script type=module src=/assets/main.js></script></body></html>',
  });
  assert.doesNotMatch(unquotedHtmlAssetHtml, /src=\/assets\/pixel\.png/u);
  assert.match(unquotedHtmlAssetHtml, /src="data:image\/png;base64,/u);

  const fragmentedAssetHtml = await packageAndReadFixture('fragmented-asset', {}, [
    ['artifacts/web-preview/assets/main.css', 'body { mask-image: url("./icons.svg#mask"); }'],
    [
      'artifacts/web-preview/assets/icons.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><mask id="mask"/></svg>',
    ],
  ]);
  assert.match(fragmentedAssetHtml, /data:image\/svg\+xml;base64,[^"')]+#mask/u);

  const topLevelAwaitHtml = await packageAndReadFixture('top-level-await', {
    mainJs: 'await Promise.resolve(); document.body.dataset.ready = "true";',
  });
  assert.match(topLevelAwaitHtml, /<script type="module">.*await/su);

  const wasmHtml = await packageAndReadFixture('non-streaming-wasm', {
    mainJs: 'void WebAssembly.instantiate(new Uint8Array([0]));',
  });
  assert.match(wasmHtml, /wasm-unsafe-eval/u);

  const urlObjectHtml = await packageAndReadFixture('url-object', {
    mainJs: 'const asset = new URL("./config.json", import.meta.url); document.body.dataset.asset = asset.href;',
  });
  assert.match(urlObjectHtml, /new URL\("data:application\/json;base64,/u);

  const extendedHtmlAssetHtml = await packageAndReadFixture('extended-html-assets', {
    indexHtml: '<!doctype html><html><head></head><body><input type=image src=/assets/pixel.png><svg><image href="/assets/icon.png"></image></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    mainJs: 'document.body.dataset.ready = "true";',
  });
  assert.doesNotMatch(extendedHtmlAssetHtml, /\/assets\/(?:pixel|icon)\.png/u);
  const embeddedPngAssets = extendedHtmlAssetHtml.match(/data:image\/png;base64,/gu);
  assert.ok(
    embeddedPngAssets,
    `Expected embedded PNG assets. HTML: ${extendedHtmlAssetHtml.slice(0, 500)}`,
  );
  assert.equal(embeddedPngAssets.length, 2);

  const dynamicAssetGame = createPreviewFixture('dynamic-asset', {
    mainJs: 'const getPath = () => "pixel.png"; document.body.dataset.asset = new URL(getPath(), import.meta.url).href;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicAssetGame }),
    /runtime-computed import.meta asset URL/u,
  );

  const coincidentalLiteralGame = createPreviewFixture('coincidental-literal', {
    mainJs: 'const part = "player.png"; document.body.dataset.part = part;',
  });
  fs.writeFileSync(
    path.join(coincidentalLiteralGame, 'artifacts/web-preview/assets/player.png'),
    onePixelPng,
  );
  const coincidentalResult = await runOfflinePlaytestPackaging({
    gameRoot: coincidentalLiteralGame,
  });
  assert.match(fs.readFileSync(coincidentalResult.entryFile, 'utf8'), /player\.png/u);

  const symlinkOutputGame = createPreviewFixture('symlink-output');
  fs.symlinkSync(outsideRoot, path.join(symlinkOutputGame, 'artifacts/offline-playtest'), 'dir');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: symlinkOutputGame }),
    /cannot cross a symbolic link/u,
  );

  const symlinkParentGame = createPreviewFixture('symlink-output-parent');
  fs.symlinkSync(outsideRoot, path.join(symlinkParentGame, 'artifacts/linked-output'), 'dir');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({
      gameRoot: symlinkParentGame,
      outputDir: 'artifacts/linked-output/offline-playtest',
    }),
    /cannot cross a symbolic link/u,
  );

  const symlinkArtifactGame = createPreviewFixture('symlink-artifact');
  const artifactDir = path.join(symlinkArtifactGame, 'artifacts/web-preview');
  const realArtifactDir = path.join(symlinkArtifactGame, 'artifacts/web-preview-real');
  fs.renameSync(artifactDir, realArtifactDir);
  fs.symlinkSync(realArtifactDir, artifactDir, 'dir');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: symlinkArtifactGame }),
    /artifact directory cannot cross a symbolic link/u,
  );

  console.log('CLI offline playtest smoke tests passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
}

interface PreviewFixtureOptions {
  readonly effectiveTarget?: Readonly<Record<string, unknown>>;
  readonly indexHtml?: string;
  readonly mainJs?: string;
}

type PreviewFixtureFile = readonly [relativePath: string, content: string | Buffer];

async function packageAndReadFixture(
  name: string,
  options: PreviewFixtureOptions = {},
  files: readonly PreviewFixtureFile[] = [],
): Promise<string> {
  const gameRoot = createPreviewFixture(name, options);

  for (const [relativePath, content] of files) {
    const file = path.join(gameRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  const result = await runOfflinePlaytestPackaging({ gameRoot });
  return fs.readFileSync(result.entryFile, 'utf8');
}

function createPreviewFixture(name: string, options: PreviewFixtureOptions = {}): string {
  const gameRoot = path.join(fixtureRoot, name);
  const artifactRoot = path.join(gameRoot, 'artifacts/web-preview');
  const assetsDir = path.join(artifactRoot, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, 'mpgd-effective-target.json'),
    `${JSON.stringify(options.effectiveTarget ?? { target: 'web-preview', runtime: 'web-preview' })}\n`,
  );
  fs.writeFileSync(
    path.join(artifactRoot, 'index.html'),
    options.indexHtml
      ?? '<!doctype html><html><head><style>/* @import is ignored here */ .inline::after { content: "@import is text"; } .inline { background: url("./assets/pixel.png"); }</style><link rel="icon" href="/assets/icon.png"><link rel="stylesheet" href="/assets/main.css"><link rel="modulepreload" href="/assets/chunk.js"></head><body><img alt="fragment" src="#"><img alt="fixture" src="/assets/pixel.png" srcset="/assets/pixel.png 2x"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(assetsDir, 'main.js'),
    options.mainJs
      ?? 'import "./extra.css"; import { value } from "./chunk.js"; const image = "/assets/pixel.png"; const config = new URL("./config.json", import.meta.url).href; document.querySelector("#game").dataset.result = `${value}:${image}:${config}`;',
  );
  fs.writeFileSync(path.join(assetsDir, 'chunk.js'), 'export const value = "ready";');
  fs.writeFileSync(
    path.join(assetsDir, 'main.css'),
    'body { background-image: url("./pixel.png"); font-family: sans-serif; }',
  );
  fs.writeFileSync(path.join(assetsDir, 'extra.css'), '#game { color: red; }');
  fs.writeFileSync(path.join(assetsDir, 'config.json'), '{"offline":true}\n');
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), onePixelPng);
  fs.writeFileSync(path.join(assetsDir, 'pixel.png'), onePixelPng);
  return gameRoot;
}

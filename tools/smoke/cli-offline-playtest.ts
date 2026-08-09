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
  assert.match(html, /object-src data:/u);
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
  const oversizedAssetGame = createPreviewFixture('oversized-asset', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/large.bin"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    mainJs: 'document.body.dataset.ready = "true";',
  });
  fs.writeFileSync(
    path.join(oversizedAssetGame, 'artifacts/web-preview/assets/large.bin'),
    Buffer.alloc(101),
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: oversizedAssetGame, maximumBytes: 100 }),
    /Offline asset assets\/large\.bin is 101 bytes, exceeding the 100-byte limit/u,
  );
  assert.equal(defaultOfflinePlaytestMaximumBytes, 25 * 1024 * 1024);

  const tamperedOutputGame = createPreviewFixture('tampered-output');
  const tamperedOutput = await runOfflinePlaytestPackaging({ gameRoot: tamperedOutputGame });
  fs.appendFileSync(tamperedOutput.entryFile, '<!-- manually changed -->\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: tamperedOutputGame }),
    /refuses to overwrite a modified prior generated entry/u,
  );

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

  await assertWorkerRejected('worker', {
    mainJs: 'new Worker("./worker.js");',
  });

  await assertWorkerRejected('inline-worker', {
    indexHtml: '<!doctype html><html><head><script>new Worker("worker.js");</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });

  await assertWorkerRejected('parameterized-script-type-worker', {
    indexHtml: '<!doctype html><html><head><script type="text/javascript;charset=utf-8">new Worker("worker.js");</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });

  await assertWorkerRejected('qualified-window-worker', {
    mainJs: 'new /* preserved trivia */ window.Worker("./worker.js");',
  });

  await assertWorkerRejected('qualified-global-shared-worker', {
    mainJs: 'new globalThis.SharedWorker("./worker.js");',
  });

  const externalFallbackGame = createPreviewFixture('external-fallback', {
    indexHtml: '<!doctype html><html><head></head><body><script src="/assets/side.js">fallback()</script><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalFallbackGame }),
    /does not support additional external scripts/u,
  );

  const legacyFallbackHtml = await packageAndReadFixture('legacy-fallback', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script><script nomodule src="/assets/legacy.js">legacyFallback()</script></body></html>',
  });
  assert.doesNotMatch(legacyFallbackHtml, /legacy(?:\.js|Fallback)/u);

  const inlineScriptHtml = await packageAndReadFixture('inline-script-assets', {
    indexHtml: '<!doctype html><html><head><script>window.icon=\'/assets/icon.png\';window.markup=\'<img src="/assets/missing.png">\';</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(inlineScriptHtml, /window\.icon='data:image\/png;base64,/u);
  assert.match(inlineScriptHtml, /<img src="\/assets\/missing\.png">/u);

  const codeLikeTextHtml = await packageAndReadFixture('code-like-text', {
    mainJs: `const example = "new URL('./missing.png', import.meta.url)";
      // const commented = "/assets/missing-comment.png";
      document.body.dataset.example = example;`,
  });
  assert.match(codeLikeTextHtml, /new URL\(['"]\.\/missing\.png['"], import\.meta\.url\)/u);

  const regexThenAssetHtml = await packageAndReadFixture('regex-then-asset', {
    mainJs: 'const slashPattern = /\\/\\//g; document.body.dataset.icon = "/assets/icon.png"; void slashPattern;',
  });
  assert.match(regexThenAssetHtml, /data:image\/png;base64,/u);
  assert.doesNotMatch(regexThenAssetHtml, /["']\/assets\/icon\.png["']/u);

  await assertWorkerRejected('regex-then-worker', {
    mainJs: 'const slashPattern = /\\/\\//g; new Worker("./worker.js"); void slashPattern;',
  });

  await assertWorkerRejected('control-regex-then-worker', {
    mainJs: 'if (true) /\\/\\//g.test("//"); new Worker("./worker.js");',
  });

  await assertWorkerRejected('template-worker', {
    mainJs: 'const value = `${new Worker("./worker.js")}`; void value;',
  });

  const rawTemplateTextHtml = await packageAndReadFixture('raw-template-text', {
    mainJs: 'document.body.dataset.label = `new Worker("./not-code.js")`;',
  });
  assert.match(rawTemplateTextHtml, /new Worker\(["']\.\/not-code\.js["']\)/u);

  const templateAssetHtml = await packageAndReadFixture('template-asset', {
    mainJs: 'document.body.dataset.icon = `${new URL("./icon.png", import.meta.url).href}`;',
  });
  assert.match(templateAssetHtml, /data:image\/png;base64,/u);
  assert.doesNotMatch(templateAssetHtml, /\.\/icon\.png/u);

  await assertWorkerRejected('block-regex-then-worker', {
    mainJs: 'function noop() {} /\\/\\//g.test("//"); new Worker("./worker.js");',
  });

  await assertWorkerRejected('class-regex-then-worker', {
    mainJs: 'class Fixture {} /\\/\\//g.test("//"); new Worker("./worker.js"); void Fixture;',
  });

  await assertWorkerRejected('object-division-worker', {
    mainJs: 'const ratio = {} / new Worker("./worker.js") / 1; void ratio;',
  });

  await assertWorkerRejected('keyword-property-then-worker', {
    mainJs: 'const descriptor = { class: 1, function: 2 }; const ratio = {} / new Worker("./worker.js") / 1; void descriptor; void ratio;',
  });

  const nonJavaScriptTypeHtml = await packageAndReadFixture('non-javascript-script-type', {
    indexHtml: '<!doctype html><html><head><script type="text/template-javascript">window.icon="/assets/icon.png";</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(nonJavaScriptTypeHtml, /window\.icon="\/assets\/icon\.png"/u);

  const cssTextHtml = await packageAndReadFixture('css-code-like-text', {}, [
    [
      'artifacts/web-preview/assets/main.css',
      '/* url("./missing-comment.png") */ .sample::after { content: "url(./missing-string.png)"; background: url("./pixel.png"); }',
    ],
  ]);
  assert.match(cssTextHtml, /missing-comment\.png/u);
  assert.match(cssTextHtml, /missing-string\.png/u);
  assert.match(cssTextHtml, /data:image\/png;base64,/u);

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
      asset === 'scene.gltf' ? '{"asset":{"version":"2.0"}}\n' : `fixture:${asset}\n`,
    );
  }

  const commonAssetResult = await runOfflinePlaytestPackaging({ gameRoot: commonAssetGame });
  const commonAssetHtml = fs.readFileSync(commonAssetResult.entryFile, 'utf8');
  assert.equal(commonAssetResult.evidence.inlinedAssetCount, 10);
  assert.match(commonAssetHtml, /data:audio\/mp4;base64,/u);
  assert.match(commonAssetHtml, /data:audio\/opus;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf\+json;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf-binary;base64,/u);

  const externalGltfGame = createPreviewFixture('external-gltf', {
    mainJs: 'document.body.dataset.scene = new URL("./scene.gltf", import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(externalGltfGame, 'artifacts/web-preview/assets/scene.gltf'),
    '{"asset":{"version":"2.0"},"buffers":[{"uri":"scene.bin"}]}\n',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalGltfGame }),
    /requires self-contained glTF data URIs or GLB/u,
  );

  const deeplyNestedGltfGame = createPreviewFixture('deeply-nested-gltf', {
    mainJs: 'document.body.dataset.scene = new URL("./scene.gltf", import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(deeplyNestedGltfGame, 'artifacts/web-preview/assets/scene.gltf'),
    `{"asset":{"version":"2.0"},"extras":${'['.repeat(65)}0${']'.repeat(65)}}\n`,
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: deeplyNestedGltfGame }),
    /glTF JSON exceeds the maximum nesting depth/u,
  );

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

  const encodedPathHtml = await packageAndReadFixture(
    'encoded-path',
    {
      indexHtml: '<!doctype html><html><head></head><body><img src="/assets/space%20icon.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/space icon.png', onePixelPng]],
  );
  assert.doesNotMatch(encodedPathHtml, /space%20icon/u);
  assert.match(encodedPathHtml, /data:image\/png;base64,/u);

  const encodedSeparatorGame = createPreviewFixture('encoded-separator', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets%2Fpixel.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: encodedSeparatorGame }),
    /Unsafe URL-escaped local asset reference/u,
  );

  const encodedTraversalGame = createPreviewFixture('encoded-traversal', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/%2e%2e/pixel.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: encodedTraversalGame }),
    /Unsafe URL-escaped local asset reference/u,
  );

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

  const parenthesizedAssetDirectoryHtml = await packageAndReadFixture(
    'parenthesized-asset-directory',
    {
      mainJs: 'document.body.dataset.icon = "/assets(2x)/pixel.png";',
    },
    [['artifacts/web-preview/assets(2x)/pixel.png', onePixelPng]],
  );
  assert.doesNotMatch(parenthesizedAssetDirectoryHtml, /\/assets\(2x\)\/pixel\.png/u);
  assert.match(parenthesizedAssetDirectoryHtml, /data:image\/png;base64,/u);

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

  const preservedModuleOrderHtml = await packageAndReadFixture('preserved-module-order', {
    indexHtml: '<!doctype html><html><head></head><body><script type="module">console.info("mpgd-before-order-marker")</script><script type="module" src="/assets/main.js"></script><script type="module">console.info("mpgd-after-order-marker")</script></body></html>',
    mainJs: 'console.info("mpgd-entry-order-marker");',
  });
  const beforeModuleIndex = preservedModuleOrderHtml.indexOf('mpgd-before-order-marker');
  const entryModuleIndex = preservedModuleOrderHtml.indexOf('mpgd-entry-order-marker');
  const afterModuleIndex = preservedModuleOrderHtml.indexOf('mpgd-after-order-marker');
  assert.ok(beforeModuleIndex >= 0 && beforeModuleIndex < entryModuleIndex);
  assert.ok(entryModuleIndex < afterModuleIndex);

  const preservedNameHtml = await packageAndReadFixture('preserved-runtime-name', {
    mainJs: 'class NamedScene {}; document.body.dataset.sceneName = NamedScene.name;',
  });
  assert.match(preservedNameHtml, /NamedScene/u);

  const wasmHtml = await packageAndReadFixture('non-streaming-wasm', {
    mainJs: 'void WebAssembly.instantiate(new Uint8Array([0]));',
  });
  assert.match(wasmHtml, /wasm-unsafe-eval/u);

  const embeddedWasmHtml = await packageAndReadFixture(
    'embedded-wasm',
    { mainJs: 'void fetch(new URL("./module.wasm", import.meta.url));' },
    [['artifacts/web-preview/assets/module.wasm', Buffer.from([0, 97, 115, 109])]],
  );
  assert.match(embeddedWasmHtml, /data:application\/wasm;base64,/u);

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

  const objectAssetHtml = await packageAndReadFixture(
    'object-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><object data="/assets/icon.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']],
  );
  assert.match(objectAssetHtml, /object-src data:/u);
  assert.match(objectAssetHtml, /data:image\/svg\+xml;base64,/u);

  const charsetHtml = await packageAndReadFixture('charset-first', {
    indexHtml: '<!doctype html><html><head><meta charset="shift_jis"><script>window.label="한글";</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(charsetHtml, /<head>\s*<meta charset="utf-8">/u);
  assert.equal(charsetHtml.match(/<meta\b[^>]*charset=/giu)?.length, 1);
  assert.match(charsetHtml, /한글/u);

  const metaRefreshHtml = await packageAndReadFixture('meta-refresh', {
    indexHtml: '<!doctype html><html><head><meta http-equiv="refresh" content="0; url=https://example.com/offline-escape"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(metaRefreshHtml, /http-equiv=["']?refresh/iu);
  assert.doesNotMatch(metaRefreshHtml, /offline-escape/u);

  const inertHtmlComment = '<!-- <base href="./ignored/"><meta http-equiv="refresh"><link rel="manifest" href="ignored.webmanifest"> -->';
  const inertHtmlCommentOutput = await packageAndReadFixture('inert-html-comment', {
    indexHtml: `<!doctype html><html><head>${inertHtmlComment}</head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>`,
  });
  assert.match(inertHtmlCommentOutput, /<base href="\.\/ignored\/">/u);
  assert.match(inertHtmlCommentOutput, /http-equiv="refresh"/u);
  assert.match(inertHtmlCommentOutput, /rel="manifest"/u);

  const baseElementGame = createPreviewFixture('base-element', {
    indexHtml: '<!doctype html><html><head><base href="./app/"></head><body><main id="game"></main><script type="module" src="assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: baseElementGame }),
    /does not support HTML base elements/u,
  );

  const dynamicImportGame = createPreviewFixture('dynamic-import', {
    mainJs: 'const selectLevelModule = () => "./level.js"; void import(selectLevelModule());',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicImportGame }),
    /does not support dynamic import/u,
  );

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

  const outsideJsonGame = createPreviewFixture('outside-json', {
    mainJs: 'import data from "../../../outside.json"; document.body.dataset.data = data.value;',
  });
  fs.writeFileSync(path.join(outsideJsonGame, 'outside.json'), '{"value":"outside"}\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: outsideJsonGame }),
    /artifact escapes its root/u,
  );

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

async function assertWorkerRejected(
  name: string,
  options: PreviewFixtureOptions,
): Promise<void> {
  const gameRoot = createPreviewFixture(name, options);
  fs.writeFileSync(path.join(gameRoot, 'artifacts/web-preview/assets/worker.js'), 'self.close();');
  await assert.rejects(() => runOfflinePlaytestPackaging({ gameRoot }), /does not support Worker/u);
}

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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const cumulativeAssetsGame = createPreviewFixture('cumulative-assets', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/first.bin"><img src="/assets/second.bin"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    mainJs: 'document.body.dataset.ready = "true";',
  });
  fs.writeFileSync(
    path.join(cumulativeAssetsGame, 'artifacts/web-preview/assets/first.bin'),
    Buffer.alloc(400),
  );
  fs.writeFileSync(
    path.join(cumulativeAssetsGame, 'artifacts/web-preview/assets/second.bin'),
    Buffer.alloc(400),
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: cumulativeAssetsGame, maximumBytes: 1_000 }),
    /asset data URLs total .* exceeding the 1000-byte limit/u,
  );
  assert.equal(defaultOfflinePlaytestMaximumBytes, 25 * 1024 * 1024);

  const tamperedOutputGame = createPreviewFixture('tampered-output');
  const tamperedOutput = await runOfflinePlaytestPackaging({ gameRoot: tamperedOutputGame });
  fs.appendFileSync(tamperedOutput.entryFile, '<!-- manually changed -->\n');
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: tamperedOutputGame }),
    /refuses to overwrite a modified prior generated entry/u,
  );

  const atomicOutputGame = createPreviewFixture('atomic-output');
  const atomicFirstResult = await runOfflinePlaytestPackaging({ gameRoot: atomicOutputGame });
  const atomicFirstHash = atomicFirstResult.evidence.sha256;
  fs.writeFileSync(
    path.join(atomicOutputGame, 'artifacts/web-preview/assets/main.js'),
    'document.body.dataset.version = "second";',
  );
  const atomicSecondResult = await runOfflinePlaytestPackaging({ gameRoot: atomicOutputGame });
  assert.notEqual(atomicSecondResult.evidence.sha256, atomicFirstHash);
  assert.equal(
    atomicSecondResult.evidence.sha256,
    createHash('sha256').update(fs.readFileSync(atomicSecondResult.entryFile)).digest('hex'),
  );
  assert.deepEqual(
    fs.readdirSync(path.join(atomicOutputGame, 'artifacts'))
      .filter((name) => name.includes('.offline-playtest.')),
    [],
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

  const webRtcGame = createPreviewFixture('webrtc', {
    mainJs: 'const peer = new RTCPeerConnection(); peer.close();',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: webRtcGame }),
    /does not support WebRTC/u,
  );

  const assignedNavigationGame = createPreviewFixture('assigned-navigation', {
    mainJs: 'window.location.href = "https://example.com/escape";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: assignedNavigationGame }),
    /does not support script-driven navigation/u,
  );

  const methodNavigationGame = createPreviewFixture('method-navigation', {
    mainJs: 'document.location.replace("https://example.com/escape");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: methodNavigationGame }),
    /does not support script-driven navigation/u,
  );

  const openNavigationGame = createPreviewFixture('open-navigation', {
    mainJs: 'window.open("https://example.com/escape");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: openNavigationGame }),
    /does not support script-driven navigation/u,
  );

  const inlineEventHandlerGame = createPreviewFixture('inline-event-handler', {
    indexHtml: '<!doctype html><html><head></head><body><button onclick="fetch(\'/assets/config.json\')">load</button><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: inlineEventHandlerGame }),
    /does not support inline HTML event handlers/u,
  );

  const rdfaOntologyHtml = await packageAndReadFixture('rdfa-ontology', {
    indexHtml: '<!doctype html><html ontology="https://example.com/schema"><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(rdfaOntologyHtml, /ontology="https:\/\/example\.com\/schema"/u);

  const externalHyperlinkGame = createPreviewFixture('external-hyperlink', {
    indexHtml: '<!doctype html><html><head></head><body><a href="https://example.com/escape">escape</a><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalHyperlinkGame }),
    /does not support external hyperlink navigation/u,
  );

  const localHyperlinkGame = createPreviewFixture('local-hyperlink', {
    indexHtml: '<!doctype html><html><head></head><body><a href="./credits.html">credits</a><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: localHyperlinkGame }),
    /does not support non-fragment hyperlink navigation/u,
  );

  const fragmentHyperlinkHtml = await packageAndReadFixture('fragment-hyperlink', {
    indexHtml: '<!doctype html><html><head></head><body><a href="#game">game</a><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(fragmentHyperlinkHtml, /href="#game"/u);

  const svgScriptGame = createPreviewFixture('svg-script-href', {
    indexHtml: '<!doctype html><html><head></head><body><svg><script href="/assets/side.js"></script></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: svgScriptGame }),
    /does not support SVG external script references/u,
  );

  const inertTemplateHtml = await packageAndReadFixture('inert-template-navigation', {
    indexHtml: '<!doctype html><html><head></head><body><template><a href="./credits.html">credits</a><svg><script href="/assets/side.js"></script></svg></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(inertTemplateHtml, /<a href="\.\/credits\.html">credits<\/a>/u);
  assert.match(inertTemplateHtml, /<script href="\/assets\/side\.js"><\/script>/u);

  const activeTemplateHandlerGame = createPreviewFixture('active-template-handler', {
    indexHtml: '<!doctype html><html><head></head><body><template onclick="alert(1)"><span>inert</span></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: activeTemplateHandlerGame }),
    /does not support inline HTML event handlers/u,
  );

  const objectLocationHtml = await packageAndReadFixture('object-location-property', {
    mainJs: 'const frame = { location: "local" }; frame.location = "updated"; document.body.dataset.location = frame.location;',
  });
  assert.match(objectLocationHtml, /updated/u);

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

  const commentedEntryHtml = await packageAndReadFixture('commented-module-entry', {
    indexHtml: '<!doctype html><html><head><!-- <script type="module" src="/old.js"></script> --></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(
    commentedEntryHtml,
    /<!--\s*<script type="module" src="\/old\.js"><\/script>\s*-->/u,
  );
  assert.doesNotMatch(commentedEntryHtml, /MPGD_OFFLINE_PLAYTEST_ENTRY/u);

  const attributedEntryHtml = await packageAndReadFixture('attributed-module-entry', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game"></main><script id="game-entry" class="boot" data-note=">" type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(
    attributedEntryHtml,
    /<script id="game-entry" class="boot" data-note=">" type="module">/u,
  );
  assert.doesNotMatch(attributedEntryHtml, /<script[^>]*\bsrc=/u);

  const inlineScriptHtml = await packageAndReadFixture('inline-script-assets', {
    indexHtml: '<!doctype html><html><head><script>void fetch(\'/assets/icon.png\');window.markup=\'<style>body{background:url("/assets/missing.png")}</style><img src="/assets/missing.png">\';</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(inlineScriptHtml, /fetch\('data:image\/png;base64,/u);
  assert.match(
    inlineScriptHtml,
    /<style>body\{background:url\("\/assets\/missing\.png"\)\}<\/style>/u,
  );
  assert.match(inlineScriptHtml, /<img src="\/assets\/missing\.png">/u);

  const retainedInlineImportGame = createPreviewFixture('retained-inline-import', {
    indexHtml: '<!doctype html><html><head><script type="module">import"./assets/inline-extra.js";</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(retainedInlineImportGame, 'artifacts/web-preview/assets/inline-extra.js'),
    'document.body.dataset.extra = "loaded";',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: retainedInlineImportGame }),
    /does not support imports in retained inline modules/u,
  );

  const retainedInlineReExportGame = createPreviewFixture('retained-inline-re-export', {
    indexHtml: '<!doctype html><html><head><script type="module">export{value}from"./assets/inline-extra.js";</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(retainedInlineReExportGame, 'artifacts/web-preview/assets/inline-extra.js'),
    'export const value = "loaded";',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: retainedInlineReExportGame }),
    /does not support imports in retained inline modules/u,
  );

  const retainedImportMetaHtml = await packageAndReadFixture('retained-import-meta', {
    indexHtml: '<!doctype html><html><head><script type="module">document.body.dataset.moduleUrl = import.meta.url;</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(retainedImportMetaHtml, /import\.meta\.url/u);

  const codeLikeTextHtml = await packageAndReadFixture('code-like-text', {
    mainJs: `const example = "new URL('./missing.png', import.meta.url)";
      // const commented = "/assets/missing-comment.png";
      document.body.dataset.example = example;`,
  });
  assert.match(codeLikeTextHtml, /new URL\(['"]\.\/missing\.png['"], import\.meta\.url\)/u);

  const regexThenAssetHtml = await packageAndReadFixture('regex-then-asset', {
    mainJs: 'const slashPattern = /\\/\\//g; void fetch("/assets/icon.png"); void slashPattern;',
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

  await assertWorkerRejected('unicode-identifier-division-worker', {
    mainJs: 'const π = 1; void (π / new Worker("worker.js") / 1);',
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

  const escapedCssUrlHtml = await packageAndReadFixture('escaped-css-url', {}, [
    ['artifacts/web-preview/assets/main.css', 'body { background: url(./sprite\\).png); }'],
    ['artifacts/web-preview/assets/sprite).png', onePixelPng],
  ]);
  assert.match(escapedCssUrlHtml, /data:image\/png;base64,/u);
  assert.doesNotMatch(escapedCssUrlHtml, /sprite\\\)\.png/u);

  const cssNamespaceHtml = await packageAndReadFixture('css-namespace-url', {}, [
    [
      'artifacts/web-preview/assets/main.css',
      '@namespace svg url(http://www.w3.org/2000/svg); svg|a { fill: red; }',
    ],
  ]);
  assert.match(cssNamespaceHtml, /http:\/\/www\.w3\.org\/2000\/svg/u);

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
    let content: string | Buffer = `fixture:${asset}\n`;

    if (asset === 'scene.gltf') {
      content = '{"asset":{"version":"2.0"}}\n';
    } else if (asset === 'model.glb') {
      content = createGlb({ asset: { version: '2.0' } });
    }

    fs.writeFileSync(path.join(commonAssetGame, 'artifacts/web-preview/assets', asset), content);
  }

  const commonAssetResult = await runOfflinePlaytestPackaging({ gameRoot: commonAssetGame });
  const commonAssetHtml = fs.readFileSync(commonAssetResult.entryFile, 'utf8');
  assert.equal(commonAssetResult.evidence.inlinedAssetCount, 10);
  assert.match(commonAssetHtml, /data:audio\/mp4;base64,/u);
  assert.match(commonAssetHtml, /data:audio\/opus;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf\+json;base64,/u);
  assert.match(commonAssetHtml, /data:model\/gltf-binary;base64,/u);

  const jsonModuleAssetGame = createPreviewFixture('json-module-semantics', {
    mainJs: 'import config from "./asset-config.json"; document.body.dataset.expectedKey = config.expectedKey;',
  });
  fs.writeFileSync(
    path.join(jsonModuleAssetGame, 'artifacts/web-preview/assets/asset-config.json'),
    '{"expectedKey":"/assets/pixel.png","label":"fixture"}',
  );
  const jsonModuleAssetResult = await runOfflinePlaytestPackaging({
    gameRoot: jsonModuleAssetGame,
  });
  const jsonModuleAssetHtml = fs.readFileSync(jsonModuleAssetResult.entryFile, 'utf8');
  assert.match(jsonModuleAssetHtml, /\/assets\/pixel\.png/u);

  const phaserManifestHtml = await packageAndReadFixture('phaser-manifest-assets', {
    mainJs: 'const texture = "/assets/pixel.png"; const assets = [{ kind: "image", key: "hero", url: texture }, { key: "logo", path: "/assets/icon.png" }, { key: "atlas", textureURL: "/assets/pixel.png", atlasURL: "/assets/config.json" }]; const scene = { load: { bitmapFont() {}, image() {} } }; for (const asset of assets) scene.load.image(asset.key, asset.url ?? asset.path ?? asset.textureURL); scene.load.bitmapFont("font", "/assets/pixel.png", "/assets/config.json");',
  });
  assert.doesNotMatch(phaserManifestHtml, /["'`]\/assets\/(?:config\.json|icon\.png|pixel\.png)/u);

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

  const externalGlbGame = createPreviewFixture('external-glb', {
    mainJs: 'document.body.dataset.model = new URL("./external.glb", import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(externalGlbGame, 'artifacts/web-preview/assets/external.glb'),
    createGlb({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 4, uri: 'external.bin' }],
    }),
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalGlbGame }),
    /requires self-contained glTF data URIs or GLB/u,
  );

  const duplicateGlbGame = createPreviewFixture('duplicate-glb-json', {
    mainJs: 'document.body.dataset.model = new URL("./duplicate.glb", import.meta.url).href;',
  });
  const duplicateGlb = createGlb({ asset: { version: '2.0' } });
  const duplicateJsonChunk = duplicateGlb.subarray(12);
  const malformedDuplicateGlb = Buffer.concat([duplicateGlb, duplicateJsonChunk]);
  malformedDuplicateGlb.writeUInt32LE(malformedDuplicateGlb.length, 8);
  fs.writeFileSync(
    path.join(duplicateGlbGame, 'artifacts/web-preview/assets/duplicate.glb'),
    malformedDuplicateGlb,
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: duplicateGlbGame }),
    /duplicate JSON chunk/u,
  );

  const documentAssetGame = createPreviewFixture('document-relative-assets', {
    mainJs: 'void fetch("./assets/pixel.png"); void fetch("assets/pixel.png"); void fetch("/audio/theme.mp3");',
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
    { mainJs: 'void fetch("/theme.mp3");' },
    [['artifacts/web-preview/theme.mp3', 'fixture:root-theme\n']],
  );
  assert.doesNotMatch(rootAssetHtml, /["']\/theme\.mp3["']/u);
  assert.match(rootAssetHtml, /data:audio\/mpeg;base64,/u);

  const documentRelativeFetchHtml = await packageAndReadFixture(
    'document-relative-fetch-asset',
    { mainJs: 'void fetch("./level.json");' },
    [['artifacts/web-preview/level.json', '{"level":1}\n']],
  );
  assert.doesNotMatch(documentRelativeFetchHtml, /fetch\(["']\.\/level\.json/u);
  assert.match(documentRelativeFetchHtml, /fetch\(["']data:application\/json;base64,/u);

  const escapedJavaScriptAssetHtml = await packageAndReadFixture(
    'escaped-javascript-asset',
    {
      mainJs: 'const level = new URL("./level\\u002ejson", import.meta.url); void fetch("./icon\\x2epng"); document.body.dataset.level = level.href;',
    },
    [
      ['artifacts/web-preview/assets/level.json', '{"level":1}\n'],
      ['artifacts/web-preview/icon.png', onePixelPng],
    ],
  );
  assert.doesNotMatch(escapedJavaScriptAssetHtml, /level\\u002ejson|icon\\x2epng/u);
  assert.match(escapedJavaScriptAssetHtml, /data:application\/json;base64,/u);
  assert.match(escapedJavaScriptAssetHtml, /data:image\/png;base64,/u);

  const quotedJavaScriptAssetHtml = await packageAndReadFixture(
    'quoted-javascript-asset',
    {
      mainJs: "const portrait = new URL(\"./player's.png\", import.meta.url); void fetch('./player\\'s.json'); document.body.dataset.portrait = portrait.href;",
    },
    [
      ["artifacts/web-preview/assets/player's.png", onePixelPng],
      ["artifacts/web-preview/player's.json", '{"player":1}\n'],
    ],
  );
  assert.doesNotMatch(quotedJavaScriptAssetHtml, /player(?:\\'|')s\.(?:json|png)/u);
  assert.match(quotedJavaScriptAssetHtml, /data:application\/json;base64,/u);
  assert.match(quotedJavaScriptAssetHtml, /data:image\/png;base64,/u);

  const networkFetchGame = createPreviewFixture('network-fetch', {
    mainJs: 'void fetch("https://example.com/level.json");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: networkFetchGame }),
    /does not support network fetch URL/u,
  );

  const encodedPathHtml = await packageAndReadFixture(
    'encoded-path',
    {
      indexHtml: '<!doctype html><html><head></head><body><img src="/assets/space%20icon.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/space icon.png', onePixelPng]],
  );
  assert.doesNotMatch(encodedPathHtml, /space%20icon/u);
  assert.match(encodedPathHtml, /data:image\/png;base64,/u);

  const whitespaceUrlHtml = await packageAndReadFixture('url-whitespace', {
    indexHtml: '<!doctype html><html><head></head><body><img src=" \t/assets/pixel.png \n"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(whitespaceUrlHtml, /[\t ]\/assets\/pixel\.png/u);
  assert.match(whitespaceUrlHtml, /src="data:image\/png;base64,/u);

  const htmlEntityAssetHtml = await packageAndReadFixture(
    'html-entity-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><img src="/assets/player&amp;enemy&copy;.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/player&enemy©.png', onePixelPng]],
  );
  assert.doesNotMatch(htmlEntityAssetHtml, /player&amp;enemy&copy;/u);
  assert.match(htmlEntityAssetHtml, /data:image\/png;base64,/u);

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

  const statefulStylesheetHtml = await packageAndReadFixture('stateful-stylesheet', {
    indexHtml: '<!doctype html><html><head><link id="night-theme" class="theme" rel="preload stylesheet" href="/assets/main.css" media="screen" disabled/></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(
    statefulStylesheetHtml,
    /<style id="night-theme" class="theme" media="screen" disabled>/u,
  );
  assert.match(
    statefulStylesheetHtml,
    /document\.currentScript\.previousElementSibling\.disabled=true/u,
  );
  assert.doesNotMatch(statefulStylesheetHtml, /<link\b[^>]*night-theme/u);

  const quotedGreaterThanStylesheetHtml = await packageAndReadFixture(
    'quoted-greater-than-stylesheet',
    {
      indexHtml: '<!doctype html><html><head><link rel="stylesheet" media="(width > 600px)" href="/assets/main.css"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
  );
  assert.match(quotedGreaterThanStylesheetHtml, /<style media="\(width &gt; 600px\)">/u);

  const webVttHtml = await packageAndReadFixture(
    'webvtt-track',
    {
      indexHtml: '<!doctype html><html><head></head><body><video><track src="/assets/captions.vtt"></video><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/captions.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n']],
  );
  assert.doesNotMatch(webVttHtml, /\/assets\/captions\.vtt/u);
  assert.match(webVttHtml, /src="data:text\/vtt;base64,/u);

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

  const escapedCssFiles: readonly PreviewFixtureFile[] = [
    ['artifacts/web-preview/assets/main.css', 'body { background: url(./player\\ icon.png); }'],
    ['artifacts/web-preview/assets/player icon.png', onePixelPng],
  ];
  const escapedCssAssetHtml = await packageAndReadFixture('escaped-css-asset', {}, escapedCssFiles);
  assert.doesNotMatch(escapedCssAssetHtml, /player\\ icon\.png/u);
  assert.match(escapedCssAssetHtml, /data:image\/png;base64,/u);

  const imageSetFiles: readonly PreviewFixtureFile[] = [
    [
      'artifacts/web-preview/assets/main.css',
      'body { background-image: image-set("/assets/icon.png" 1x, "/assets/icon@2x.png" 2x); }',
    ],
    ['artifacts/web-preview/assets/icon@2x.png', onePixelPng],
  ];
  const imageSetHtml = await packageAndReadFixture('css-image-set', {}, imageSetFiles);
  assert.doesNotMatch(imageSetHtml, /\/assets\/icon(?:@2x)?\.png/u);
  assert.equal(imageSetHtml.match(/data:image\/png;base64,/gu)?.length, 2);

  const parenthesizedAssetDirectoryHtml = await packageAndReadFixture(
    'parenthesized-asset-directory',
    {
      mainJs: 'void fetch("assets(2x)/pixel.png");',
    },
    [['artifacts/web-preview/assets(2x)/pixel.png', onePixelPng]],
  );
  assert.doesNotMatch(parenthesizedAssetDirectoryHtml, /assets\(2x\)\/pixel\.png/u);
  assert.match(parenthesizedAssetDirectoryHtml, /data:image\/png;base64,/u);

  const unquotedHtmlAssetHtml = await packageAndReadFixture('unquoted-html-asset', {
    indexHtml: '<!doctype html><html><head><link rel=stylesheet href=/assets/main.css></head><body><img src=/assets/pixel.png><main id=game></main><script type=module src=/assets/main.js></script></body></html>',
  });
  assert.doesNotMatch(unquotedHtmlAssetHtml, /src=\/assets\/pixel\.png/u);
  assert.match(unquotedHtmlAssetHtml, /src="data:image\/png;base64,/u);

  const quotedAttributeTextHtml = await packageAndReadFixture('quoted-attribute-text', {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" title="not disabled theme" href="/assets/main.css"></head><body><img alt="label src=/assets/missing.png" src="/assets/pixel.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(quotedAttributeTextHtml, /alt="label src=\/assets\/missing\.png"/u);
  assert.match(quotedAttributeTextHtml, /src="data:image\/png;base64,/u);
  assert.doesNotMatch(quotedAttributeTextHtml, /previousElementSibling\.disabled=true/u);

  const trailingPunctuationTagHtml = await packageAndReadFixture('tag-name-punctuation', {
    indexHtml: '<!doctype html><html><head></head><body><foo- style="background-image:url(/assets/pixel.png)"></foo-><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(trailingPunctuationTagHtml, /url\(\/assets\/pixel\.png\)/u);
  assert.match(trailingPunctuationTagHtml, /url\(&quot;data:image\/png;base64,[^&]+&quot;\)/u);

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

  const preEmbeddedUrlHtml = await packageAndReadFixture('pre-embedded-url', {
    mainJs: 'const asset = new URL("data:image/png;base64,AAAA", import.meta.url); document.body.dataset.asset = asset.href;',
  });
  assert.match(preEmbeddedUrlHtml, /new URL\(["']data:image\/png;base64,AAAA["']\)/u);

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

  const styleAttributeHtml = await packageAndReadFixture('style-attribute-asset', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game" style="background-image:url(\'/assets/pixel.png\')"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(styleAttributeHtml, /\/assets\/pixel\.png/u);
  assert.match(styleAttributeHtml, /style="background-image:url\(&quot;data:image\/png;base64,/u);

  const objectAssetHtml = await packageAndReadFixture(
    'object-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><object data="/assets/icon.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']],
  );
  assert.match(objectAssetHtml, /object-src data:/u);
  assert.match(objectAssetHtml, /data:image\/svg\+xml;base64,/u);

  const nestedSvgGame = createPreviewFixture('nested-svg', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/nested.svg"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(nestedSvgGame, 'artifacts/web-preview/assets/nested.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="texture.png"/></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: nestedSvgGame }),
    /requires self-contained SVG data URIs and fragment references/u,
  );

  const svgPresentationUrlGame = createPreviewFixture('svg-presentation-url', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/presentation.svg"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(svgPresentationUrlGame, 'artifacts/web-preview/assets/presentation.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(theme.svg#gradient)"/></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: svgPresentationUrlGame }),
    /requires self-contained SVG data URIs and fragment references/u,
  );

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

  const quotedGreaterMetaHtml = await packageAndReadFixture('quoted-greater-meta-refresh', {
    indexHtml: '<!doctype html><html><head><meta content="0;url=https://example.com/?q=>x" http-equiv="refresh"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(quotedGreaterMetaHtml, /http-equiv=["']?refresh/iu);
  assert.doesNotMatch(quotedGreaterMetaHtml, /example\.com/u);

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

  const preHeadScriptGame = createPreviewFixture('pre-head-script', {
    indexHtml: '<!doctype html><html><script>fetch("https://example.com/escape")</script><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: preHeadScriptGame }),
    /does not support content before the head element/u,
  );

  const iframeGame = createPreviewFixture('iframe-document', {
    indexHtml: '<!doctype html><html><head></head><body><iframe src="./help.html"></iframe><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: iframeGame }),
    /does not support iframe documents/u,
  );

  const inertTemplateScriptHtml = await packageAndReadFixture('inert-template-script', {
    indexHtml: '<!doctype html><html><head><template><script type="module" src="/assets/template.js"></script></template></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(
    inertTemplateScriptHtml,
    /<template><script type="module" src="\/assets\/template\.js"><\/script><\/template>/u,
  );

  const importMapGame = createPreviewFixture('import-map', {
    indexHtml: '<!doctype html><html><head><script type="importmap">{"imports":{"game-lib":"./assets/lib.js"}}</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    mainJs: 'import "game-lib";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: importMapGame }),
    /does not support HTML import maps/u,
  );

  const dynamicImportGame = createPreviewFixture('dynamic-import', {
    mainJs: 'const selectLevelModule = () => "./level.js"; void import(selectLevelModule());',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicImportGame }),
    /does not support dynamic import/u,
  );

  const interpolatedTemplateAssetGame = createPreviewFixture('interpolated-template-asset', {
    mainJs: 'const mask = "mask"; document.body.dataset.asset = new URL(`./icons.svg#${mask}`, import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(interpolatedTemplateAssetGame, 'artifacts/web-preview/assets/icons.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><mask id="mask"/></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: interpolatedTemplateAssetGame }),
    /runtime-computed import.meta asset URL/u,
  );

  const dynamicAssetGame = createPreviewFixture('dynamic-asset', {
    mainJs: 'const getPath = () => "pixel.png"; document.body.dataset.asset = new URL(getPath(), import.meta.url).href;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicAssetGame }),
    /runtime-computed import.meta asset URL/u,
  );

  const coincidentalLiteralGame = createPreviewFixture('coincidental-literal', {
    mainJs: 'const key = "/assets/pixel.png"; document.body.dataset.key = key;',
  });
  const coincidentalResult = await runOfflinePlaytestPackaging({
    gameRoot: coincidentalLiteralGame,
  });
  assert.match(fs.readFileSync(coincidentalResult.entryFile, 'utf8'), /\/assets\/pixel\.png/u);

  const objectFetchHtml = await packageAndReadFixture('object-fetch-method', {
    mainJs: 'const client = { fetch: (value) => value }; document.body.dataset.value = client.fetch("/assets/pixel.png");',
  });
  assert.match(objectFetchHtml, /client\.fetch\(["']\/assets\/pixel\.png["']\)/u);

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

function createGlb(json: unknown): Buffer {
  const glbMagic = 0x4654_6C67;
  const jsonChunkType = 0x4E4F_534A;
  const source = Buffer.from(JSON.stringify(json), 'utf8');
  const padding = Buffer.alloc((4 - (source.length % 4)) % 4, 0x20);
  const jsonChunk = Buffer.concat([source, padding]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(glbMagic, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + jsonChunk.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(jsonChunkType, 16);
  return Buffer.concat([header, jsonChunk]);
}

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
      ?? 'import "./extra.css"; import { value } from "./chunk.js"; void fetch("/assets/pixel.png"); const config = new URL("./config.json", import.meta.url).href; document.querySelector("#game").dataset.result = `${value}:${config}`;',
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

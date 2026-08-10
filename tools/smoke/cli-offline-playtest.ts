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
  assert.match(html, /globalThis\.navigation/u);
  assert.match(html, /globalThis\.history/u);
  assert.match(html, /globalThis\.History\?\.prototype/u);
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

  const escapedCssImportGame = createPreviewFixture('escaped-css-import');
  fs.writeFileSync(
    path.join(escapedCssImportGame, 'artifacts/web-preview/assets/main.css'),
    '@\\69mport "/assets/theme.css"; body { color: white; }',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: escapedCssImportGame }),
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

  const shadowedInlineWorkerHtml = await packageAndReadFixture('shadowed-inline-workers', {
    indexHtml: '<!doctype html><html><head><script>class Worker {} class SharedWorker {} new Worker(); new SharedWorker();</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(shadowedInlineWorkerHtml, /class Worker/u);
  assert.match(shadowedInlineWorkerHtml, /class SharedWorker/u);

  const treeShakenWorkerGame = createPreviewFixture('tree-shaken-worker', {
    mainJs: 'import { used } from "./shared.js"; document.body.dataset.state = used;',
  });
  fs.writeFileSync(
    path.join(treeShakenWorkerGame, 'artifacts/web-preview/assets/shared.js'),
    'export const used = "ready"; export function makeWorker() { return new Worker("./worker.js"); }',
  );
  const treeShakenWorkerResult = await runOfflinePlaytestPackaging({
    gameRoot: treeShakenWorkerGame,
  });
  assert.doesNotMatch(fs.readFileSync(treeShakenWorkerResult.entryFile, 'utf8'), /new\s+Worker/u);

  const webRtcGame = createPreviewFixture('webrtc', {
    mainJs: 'const peer = new RTCPeerConnection(); peer.close();',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: webRtcGame }),
    /does not support WebRTC/u,
  );

  const shadowedServiceWorkerHtml = await packageAndReadFixture('shadowed-service-worker', {
    mainJs: 'const serviceWorker = { register() { return "local"; } }; document.body.dataset.state = serviceWorker.register();',
  });
  assert.match(shadowedServiceWorkerHtml, /local/u);

  const shadowedWebRtcHtml = await packageAndReadFixture('shadowed-webrtc', {
    mainJs: 'class RTCPeerConnection { close() { return "local"; } } const peer = new RTCPeerConnection(); document.body.dataset.state = peer.close();',
  });
  assert.match(shadowedWebRtcHtml, /local/u);

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

  const indirectMethodNavigationGame = createPreviewFixture('indirect-method-navigation', {
    mainJs: 'Reflect.apply(location.assign, location, ["https://example.com/escape"]);',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: indirectMethodNavigationGame }),
    /does not support script-driven navigation/u,
  );

  const openNavigationGame = createPreviewFixture('open-navigation', {
    mainJs: 'window.open("https://example.com/escape");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: openNavigationGame }),
    /does not support script-driven navigation/u,
  );

  for (const [name, mainJs] of [
    ['navigation-api', 'navigation.navigate("https://example.com/escape");'],
    ['qualified-navigation-api', 'globalThis.navigation.navigate("https://example.com/escape");'],
  ] as const) {
    const navigationApiGame = createPreviewFixture(name, { mainJs });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: navigationApiGame }),
      /does not support script-driven navigation/u,
    );
  }

  const shadowedNavigationApiHtml = await packageAndReadFixture('shadowed-navigation-api', {
    mainJs: 'function route(navigation) { navigation.navigate("/local"); } route({ navigate() {} });',
  });
  assert.match(shadowedNavigationApiHtml, /navigate/u);

  const shadowedQualifiedNavigationApiHtml = await packageAndReadFixture(
    'shadowed-qualified-navigation-api',
    {
      mainJs: 'function route(window) { window.navigation.navigate("/local"); } route({ navigation: { navigate() {} } });',
    },
  );
  assert.match(shadowedQualifiedNavigationApiHtml, /navigate/u);

  for (const [name, mainJs] of [
    ['history-api', 'history.back();'],
    ['qualified-history-api', 'window.history.go(-1);'],
  ] as const) {
    const historyApiGame = createPreviewFixture(name, { mainJs });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: historyApiGame }),
      /does not support script-driven navigation/u,
    );
  }

  const shadowedHistoryApiHtml = await packageAndReadFixture('shadowed-history-api', {
    mainJs: 'function route(history) { history.back(); } route({ back() {} });',
  });
  assert.match(shadowedHistoryApiHtml, /back/u);

  const shadowedQualifiedHistoryApiHtml = await packageAndReadFixture(
    'shadowed-qualified-history-api',
    {
      mainJs: 'function route(window) { window.history.forward(); } route({ history: { forward() {} } });',
    },
  );
  assert.match(shadowedQualifiedHistoryApiHtml, /forward/u);

  for (const [name, mainJs] of [
    ['history-prototype-api', 'History.prototype.back.call(history);'],
    ['qualified-history-prototype-api', 'window.History.prototype.go.call(window.history, -1);'],
  ] as const) {
    const historyPrototypeGame = createPreviewFixture(name, { mainJs });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: historyPrototypeGame }),
      /does not support script-driven navigation/u,
    );
  }

  const shadowedHistoryPrototypeHtml = await packageAndReadFixture('shadowed-history-prototype', {
    mainJs: 'function route(History, history) { History.prototype.back.call(history); } route({ prototype: { back() {} } }, {});',
  });
  assert.match(shadowedHistoryPrototypeHtml, /\.back\.call/u);

  const documentOpenHtml = await packageAndReadFixture('document-open-writer', {
    mainJs: 'document.open(/* local writer */); document.write("<main>offline</main>"); document.close();',
  });
  assert.match(documentOpenHtml, /document\.open\(\)/u);

  const documentOpenNavigationGame = createPreviewFixture('document-open-navigation', {
    mainJs: 'document.open("https://example.com/escape", "_blank", "noopener");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: documentOpenNavigationGame }),
    /does not support script-driven navigation/u,
  );

  for (const [name, mainJs] of [
    ['computed-location-assignment', 'window["location"]["href"] = "https://example.com";'],
    ['computed-location-method', 'location["assign"]("https://example.com");'],
    ['default-view-location', 'document.defaultView.location.href = "https://example.com";'],
  ] as const) {
    const computedNavigationGame = createPreviewFixture(name, { mainJs });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: computedNavigationGame }),
      /does not support script-driven navigation/u,
    );
  }

  const aliasedLocationGame = createPreviewFixture('aliased-location-navigation', {
    mainJs: 'const target = window.location; target.href = "https://example.com/escape";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: aliasedLocationGame }),
    /does not support script-driven navigation/u,
  );

  for (const [name, mainJs] of [
    [
      'destructured-aliased-location-navigation',
      'const { location: destination } = window; destination.href = "https://example.com/escape";',
    ],
    [
      'destructured-shorthand-location-navigation',
      'const { location } = window; location.replace("https://example.com/escape");',
    ],
  ] as const) {
    const destructuredLocationGame = createPreviewFixture(name, { mainJs });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: destructuredLocationGame }),
      /does not support script-driven navigation/u,
    );
  }

  const shadowedDestructuredLocationHtml = await packageAndReadFixture(
    'shadowed-destructured-location',
    {
      mainJs: 'function route(window) { const { location: destination } = window; destination.href = "/assets/local"; return destination.href; } document.body.dataset.route = route({ location: {} });',
    },
  );
  assert.match(shadowedDestructuredLocationHtml, /\/assets\/local/u);

  const nestedAliasedLocationGame = createPreviewFixture('nested-aliased-location-navigation', {
    mainJs: 'const first = document.location; const target = first; target.replace("https://example.com/escape");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: nestedAliasedLocationGame }),
    /does not support script-driven navigation/u,
  );

  const assignedAliasedLocationGame = createPreviewFixture('assigned-aliased-location-navigation', {
    mainJs: 'let first; let target; first = window.location; target = first; target.href = "https://example.com/escape";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: assignedAliasedLocationGame }),
    /does not support script-driven navigation/u,
    'expected assignment-derived location aliases to be rejected',
  );

  for (const [name, initialValue, operator] of [
    ['and-assigned-location-navigation', 'true', '&&='],
    ['or-assigned-location-navigation', 'false', '||='],
    ['nullish-assigned-location-navigation', 'null', '??='],
  ] as const) {
    const logicalAssignedLocationGame = createPreviewFixture(name, {
      mainJs: `let target = ${initialValue}; target ${operator} window.location; target.href = "https://example.com/escape";`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: logicalAssignedLocationGame }),
      /does not support script-driven navigation/u,
      `expected ${operator} location aliases to be rejected`,
    );
  }

  for (const [name, initialValue, operator] of [
    ['and-assignment-result-navigation', 'true', '&&='],
    ['or-assignment-result-navigation', 'false', '||='],
    ['nullish-assignment-result-navigation', 'null', '??='],
  ] as const) {
    const logicalAssignmentResultGame = createPreviewFixture(name, {
      mainJs: `function escape(target) { const alias = target ${operator} window.location; alias.href = "https://example.com/escape"; } escape(${initialValue});`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: logicalAssignmentResultGame }),
      /does not support script-driven navigation/u,
      `expected the ${operator} result alias to be rejected`,
    );
  }

  for (const [name, initialValue, operator] of [
    ['parenthesized-simple-assignment-result-navigation', 'undefined', '='],
    ['parenthesized-and-assignment-result-navigation', 'true', '&&='],
    ['parenthesized-or-assignment-result-navigation', 'false', '||='],
    ['parenthesized-nullish-assignment-result-navigation', 'null', '??='],
  ] as const) {
    const parenthesizedAssignmentResultGame = createPreviewFixture(name, {
      mainJs: `let target = ${initialValue}; const alias = (target ${operator} window.location); alias.href = "https://example.com/escape";`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: parenthesizedAssignmentResultGame }),
      /does not support script-driven navigation/u,
      `expected the parenthesized ${operator} result alias to be rejected`,
    );
  }

  const parenthesizedDirectLocationGame = createPreviewFixture(
    'parenthesized-direct-location-navigation',
    {
      mainJs: 'const alias = (((window.location))); alias.href = "https://example.com/escape";',
    },
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: parenthesizedDirectLocationGame }),
    /does not support script-driven navigation/u,
  );

  const sequenceLocationGame = createPreviewFixture('sequence-location-navigation', {
    mainJs: 'const alias = (0, window.location); alias.href = "https://example.com/escape";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: sequenceLocationGame }),
    /does not support script-driven navigation/u,
  );

  const nonLocationSequenceHtml = await packageAndReadFixture('non-location-sequence', {
    mainJs: 'const alias = (window.location, { href: "local" }); document.body.dataset.href = alias.href;',
  });
  assert.match(nonLocationSequenceHtml, /href:\s*"local"/u);

  const simpleAssignmentResultGame = createPreviewFixture('simple-assignment-result-navigation', {
    mainJs: 'let target; const alias = target = window.location; alias.href = "https://example.com/escape";',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: simpleAssignmentResultGame }),
    /does not support script-driven navigation/u,
    'expected a nested simple-assignment result alias to be rejected',
  );

  const parameterAliasedLocationGame = createPreviewFixture('parameter-aliased-location-navigation', {
    mainJs: 'function escape(target = window.location) { target.href = "https://example.com/escape"; } escape();',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: parameterAliasedLocationGame }),
    /does not support script-driven navigation/u,
  );

  const unqualifiedOpenHtml = await packageAndReadFixture('unqualified-open-guard', {
    mainJs: 'button.addEventListener("click", () => open("https://example.com"));',
  });
  assert.match(unqualifiedOpenHtml, /globalThis\.open=\(url\)=>\{throw denied\('open',url\)\}/u);

  const dynamicAnchorHtml = await packageAndReadFixture('dynamic-anchor-guard', {
    mainJs: 'const anchor = document.createElement("a"); anchor.href = "https://example.com/escape"; document.body.append(anchor); anchor.click();',
  });
  assert.match(dynamicAnchorHtml, /HTMLAnchorElement\.prototype\.click/u);
  assert.match(dynamicAnchorHtml, /closest\('a,area'\)/u);
  assert.match(dynamicAnchorHtml, /getAttribute\('xlink:href'\)/u);

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

  const externalSvgHyperlinkGame = createPreviewFixture('external-svg-hyperlink', {
    indexHtml: '<!doctype html><html><head></head><body><svg><a xlink:href="https://example.com/escape">escape</a></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalSvgHyperlinkGame }),
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

  const fragmentSvgHyperlinkHtml = await packageAndReadFixture('fragment-svg-hyperlink', {
    indexHtml: '<!doctype html><html><head></head><body><svg><a xlink:href="#game">game</a></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(fragmentSvgHyperlinkHtml, /xlink:href="#game"/u);

  const svgScriptGame = createPreviewFixture('svg-script-href', {
    indexHtml: '<!doctype html><html><head></head><body><svg><script href="/assets/side.js"></script></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: svgScriptGame }),
    /does not support SVG external script references/u,
  );

  const templateNavigationGame = createPreviewFixture('template-navigation', {
    indexHtml: '<!doctype html><html><head></head><body><template><a href="./credits.html">credits</a></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: templateNavigationGame }),
    /does not support non-fragment hyperlink navigation/u,
  );

  const templateSvgScriptGame = createPreviewFixture('template-svg-script', {
    indexHtml: '<!doctype html><html><head></head><body><template><svg><script href="/assets/side.js"></script></svg></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: templateSvgScriptGame }),
    /does not support SVG external script references/u,
  );

  const foreignSvgTemplateScriptGame = createPreviewFixture('foreign-svg-template-script', {
    indexHtml: '<!doctype html><html><head></head><body><svg><template><script>location.href="https://example.com/escape";</script></template></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: foreignSvgTemplateScriptGame }),
    /does not support script-driven navigation/u,
  );

  const activeTemplateHandlerGame = createPreviewFixture('active-template-handler', {
    indexHtml: '<!doctype html><html><head></head><body><template><button onclick="alert(1)">activate</button></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: activeTemplateHandlerGame }),
    /does not support inline HTML event handlers/u,
  );

  const templateStyleAsset = Buffer.from('template-style-asset');
  const templateStyleHtml = await packageAndReadFixture(
    'template-style-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><template><style>.icon{background:url("/assets/template.png")}</style></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/template.png', templateStyleAsset]],
  );
  assert.doesNotMatch(templateStyleHtml, /\/assets\/template\.png/u);
  assert.ok(
    templateStyleHtml.includes(`data:image/png;base64,${templateStyleAsset.toString('base64')}`),
    'expected the template style asset to be inlined as an exact data URL',
  );

  const templateLookalikeGame = createPreviewFixture('template-lookalike', {
    indexHtml: '<!doctype html><html><head></head><body><!-- <template> --><template-bar><iframe srcdoc="fixture"></iframe></template><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: templateLookalikeGame }),
    /does not support iframe documents/u,
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

  const integrityEntryGame = createPreviewFixture('integrity-entry', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js" integrity="sha256-invalid"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: integrityEntryGame }),
    /does not support integrity-protected entry scripts/u,
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

  const bareEntryImportMetaGame = createPreviewFixture('bare-entry-import-meta', {
    mainJs: 'const resolveAsset = (base) => new URL("asset.png", base).href; document.body.dataset.asset = resolveAsset(import.meta.url);',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: bareEntryImportMetaGame }),
    /does not support bare import\.meta in the bundled entry/u,
  );

  const aliasedEntryImportMetaGame = createPreviewFixture('aliased-entry-import-meta', {
    mainJs: 'const meta = import.meta; document.body.dataset.asset = new URL("./pixel.png", meta.url).href;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: aliasedEntryImportMetaGame }),
    /does not support bare import\.meta in the bundled entry/u,
  );

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

  const unicodePhaserAsset = Buffer.from('unicode-phaser-asset');
  const unicodePhaserHtml = await packageAndReadFixture(
    'unicode-phaser-identifier',
    {
      mainJs: 'const εικόνα = "/assets/unicode.png"; const scene = new Phaser.Scene(); scene.load.image("hero", εικόνα);',
    },
    [['artifacts/web-preview/assets/unicode.png', unicodePhaserAsset]],
  );
  assert.doesNotMatch(unicodePhaserHtml, /\/assets\/unicode\.png/u);
  assert.ok(
    unicodePhaserHtml.includes(`data:image/png;base64,${unicodePhaserAsset.toString('base64')}`),
    'expected the Unicode Phaser asset to be inlined as an exact data URL',
  );

  const asiPhaserAsset = Buffer.from('asi-phaser-asset');
  const asiPhaserHtml = await packageAndReadFixture(
    'asi-phaser-identifier',
    {
      mainJs: 'const scene = new Phaser.Scene(); const assetUrl = "/assets/asi.png"\nscene.load.image("hero", assetUrl)',
    },
    [['artifacts/web-preview/assets/asi.png', asiPhaserAsset]],
  );
  assert.doesNotMatch(asiPhaserHtml, /\/assets\/asi\.png/u);
  assert.ok(
    asiPhaserHtml.includes(`data:image/png;base64,${asiPhaserAsset.toString('base64')}`),
    'expected the ASI Phaser asset to be inlined as an exact data URL',
  );

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

  const commentedCssUrlHtml = await packageAndReadFixture('commented-css-url', {}, [
    [
      'artifacts/web-preview/assets/main.css',
      'body { background: url(/* preload */ "/assets/pixel.png" /* cache */); }',
    ],
  ]);
  assert.doesNotMatch(commentedCssUrlHtml, /\/assets\/pixel\.png/u);
  assert.match(commentedCssUrlHtml, /data:image\/png;base64,/u);

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

  const commentedCssNamespaceSource = '@namespace svg /* ignored ; { } */ url(http://www.w3.org/2000/svg); svg|a { fill: red; }';
  const commentedCssNamespaceFiles: readonly PreviewFixtureFile[] = [
    ['artifacts/web-preview/assets/main.css', commentedCssNamespaceSource],
  ];
  const commentedCssNamespaceHtml = await packageAndReadFixture(
    'commented-css-namespace-url',
    {},
    commentedCssNamespaceFiles,
  );
  assert.match(commentedCssNamespaceHtml, /http:\/\/www\.w3\.org\/2000\/svg/u);

  const escapedCssNamespaceSource = '@\\6e amespace svg url(http://www.w3.org/2000/svg); svg|a { fill: red; }';
  const escapedCssNamespaceFiles: readonly PreviewFixtureFile[] = [
    ['artifacts/web-preview/assets/main.css', escapedCssNamespaceSource],
  ];
  const escapedCssNamespaceHtml = await packageAndReadFixture(
    'escaped-css-namespace-url',
    {},
    escapedCssNamespaceFiles,
  );
  assert.match(escapedCssNamespaceHtml, /http:\/\/www\.w3\.org\/2000\/svg/u);

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

  const unusedJsonModuleGame = createPreviewFixture('unused-json-module', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    mainJs: 'import unused from "./config.json"; document.body.dataset.ready = "true";',
  });
  const unusedJsonModuleResult = await runOfflinePlaytestPackaging({
    gameRoot: unusedJsonModuleGame,
  });
  const unusedJsonModuleHtml = fs.readFileSync(unusedJsonModuleResult.entryFile, 'utf8');
  assert.doesNotMatch(unusedJsonModuleHtml, /data:application\/json;base64,/u);
  assert.equal(unusedJsonModuleResult.evidence.inlinedAssetCount, 0);

  const phaserManifestHtml = await packageAndReadFixture('phaser-manifest-assets', {
    mainJs: 'const texture = "/assets/pixel.png"; const assets = [{ kind: "image", key: "hero", url: texture }, { kind: "image", key: "logo", url: "/assets/icon.png" }, { kind: "atlas", key: "atlas", textureUrl: "/assets/pixel.png", atlasUrl: "/assets/config.json" }]; const scene = new Phaser.Scene(); for (const asset of assets) scene.load.image(asset.key, asset.url ?? asset.textureUrl); scene.load.bitmapFont("font", "/assets/pixel.png", "/assets/config.json");',
  });
  assert.doesNotMatch(phaserManifestHtml, /["'`]\/assets\/(?:config\.json|icon\.png|pixel\.png)/u);

  const phaserConfigObjectHtml = await packageAndReadFixture('phaser-config-object', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.image({ key: "hero", url: "/assets/pixel.png" }); scene.load.image([{ key: "logo", url: "/assets/icon.png" }]);',
  });
  assert.doesNotMatch(phaserConfigObjectHtml, /\/assets\/(?:icon|pixel)\.png/u);

  const phaserNormalMapHtml = await packageAndReadFixture('phaser-normal-map', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.image({ key: "hero", url: "/assets/pixel.png", normalMap: "/assets/icon.png" });',
  });
  assert.doesNotMatch(phaserNormalMapHtml, /\/assets\/(?:icon|pixel)\.png/u);

  const phaserSceneSubclassHtml = await packageAndReadFixture('phaser-scene-subclass', {
    mainJs: 'class BootScene extends Phaser.Scene { preload() { this.load.image("hero", "/assets/pixel.png"); } } document.body.dataset.scene = BootScene.name;',
  });
  assert.doesNotMatch(phaserSceneSubclassHtml, /\/assets\/pixel\.png/u);

  const unrelatedLoaderHtml = await packageAndReadFixture('unrelated-loader-api', {
    mainJs: 'const router = { load: { json(key, url) { document.body.dataset[key] = url; } } }; router.load.json("route", "/assets/config.json");',
  });
  assert.match(unrelatedLoaderHtml, /\/assets\/config\.json/u);

  const unrelatedSceneHtml = await packageAndReadFixture('unrelated-scene-loader-api', {
    mainJs: 'const Router = { Scene: class { load = { image() {} } } }; const scene = new Router.Scene(); scene.load.image("route", "/assets/not-a-phaser-asset.png");',
  });
  assert.match(unrelatedSceneHtml, /\/assets\/not-a-phaser-asset\.png/u);

  const unrelatedSceneSubclassHtml = await packageAndReadFixture(
    'unrelated-scene-subclass-loader-api',
    {
      mainJs: 'const Router = { Scene: class {} }; class RouteScene extends Router.Scene { load = { image() {} }; preload() { this.load.image("route", "/assets/not-a-phaser-asset.png"); } } document.body.dataset.scene = RouteScene.name;',
    },
  );
  assert.match(unrelatedSceneSubclassHtml, /\/assets\/not-a-phaser-asset\.png/u);

  const shadowedPhaserSceneHtml = await packageAndReadFixture('shadowed-phaser-scene-loader-api', {
    mainJs: 'const Phaser = { Scene: class { load = { image() {} } } }; const scene = new Phaser.Scene(); scene.load.image("route", "/assets/not-a-phaser-asset.png");',
  });
  assert.match(shadowedPhaserSceneHtml, /\/assets\/not-a-phaser-asset\.png/u);

  const phaserVariableConfigHtml = await packageAndReadFixture('phaser-variable-config', {
    mainJs: 'const config = { key: "hero", url: "/assets/pixel.png" }; const scene = new Phaser.Scene(); scene.load.image(config);',
  });
  assert.doesNotMatch(phaserVariableConfigHtml, /\/assets\/pixel\.png/u);

  const phaserShorthandConfigHtml = await packageAndReadFixture('phaser-shorthand-config', {
    mainJs: 'const key = "hero"; const url = "/assets/pixel.png"; const scene = new Phaser.Scene(); scene.load.image({ key, url });',
  });
  assert.doesNotMatch(phaserShorthandConfigHtml, /\/assets\/pixel\.png/u);

  const scopedPhaserIdentifierHtml = await packageAndReadFixture('scoped-phaser-identifier', {
    mainJs: 'function unrelated() { const url = "/api/route"; return url; } function preload() { const url = "/assets/pixel.png"; const scene = new Phaser.Scene(); scene.load.image({ key: "hero", url }); } document.body.dataset.route = unrelated(); preload();',
  });
  assert.match(scopedPhaserIdentifierHtml, /\/api\/route/u);
  assert.doesNotMatch(scopedPhaserIdentifierHtml, /\/assets\/pixel\.png/u);

  const unrelatedKeyedObjectHtml = await packageAndReadFixture(
    'unrelated-keyed-object',
    {
      mainJs: 'const route = { key: "route", url: "/assets/route.png" }; document.body.dataset.route = JSON.stringify(route);',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('unrelated-route')]],
  );
  assert.match(unrelatedKeyedObjectHtml, /\/assets\/route\.png/u);

  const provenLegacyManifestHtml = await packageAndReadFixture(
    'proven-legacy-manifest',
    {
      mainJs: 'const routes = [{ key: "route", path: "/assets/route.png" }]; const assets = [{ key: "logo", path: "/assets/icon.png" }]; const scene = new Phaser.Scene(); for (const asset of assets) scene.load.image(asset.key, asset.path); document.body.dataset.route = routes[0].path;',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('legacy-route')]],
  );
  assert.doesNotMatch(provenLegacyManifestHtml, /\/assets\/icon\.png/u);
  assert.match(provenLegacyManifestHtml, /\/assets\/route\.png/u);

  const nestedLegacyManifestHtml = await packageAndReadFixture(
    'nested-legacy-manifest',
    {
      mainJs: 'const outer = [{ key: "route", path: "/assets/route.png" }]; const inner = [{ key: "logo", path: "/assets/icon.png" }]; const scene = new Phaser.Scene(); for (const asset of outer) { for (const asset of inner) scene.load.image(asset.key, asset.path); } document.body.dataset.route = outer[0].path;',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('nested-legacy-route')]],
  );
  assert.doesNotMatch(nestedLegacyManifestHtml, /\/assets\/icon\.png/u);
  assert.match(nestedLegacyManifestHtml, /\/assets\/route\.png/u);

  const blockShadowManifestHtml = await packageAndReadFixture(
    'block-shadow-manifest',
    {
      mainJs: 'const manifests = [{ key: "route", path: "/assets/route.png" }]; const scene = new Phaser.Scene(); { const manifests = [{ key: "logo", path: "/assets/icon.png" }]; for (const asset of manifests) scene.load.image(asset.key, asset.path); } document.body.dataset.route = manifests[0].path;',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('block-shadow-route')]],
  );
  assert.doesNotMatch(blockShadowManifestHtml, /\/assets\/icon\.png/u);
  assert.match(blockShadowManifestHtml, /\/assets\/route\.png/u);

  const parameterShadowManifestHtml = await packageAndReadFixture(
    'parameter-shadow-manifest',
    {
      mainJs: 'const manifests = [{ key: "route", path: "/assets/route.png" }]; const scene = new Phaser.Scene(); function load(manifests) { for (const asset of manifests) scene.load.image(asset.key, asset.path); } void load; document.body.dataset.route = manifests[0].path;',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('parameter-shadow-route')]],
  );
  assert.match(parameterShadowManifestHtml, /\/assets\/route\.png/u);

  const destructuredShadowManifestHtml = await packageAndReadFixture(
    'destructured-shadow-manifest',
    {
      mainJs: 'const manifests = [{ key: "route", path: "/assets/route.png" }]; const config = { manifests: [] }; const scene = new Phaser.Scene(); { const { manifests } = config; for (const asset of manifests) scene.load.image(asset.key, asset.path); } document.body.dataset.route = manifests[0].path;',
    },
    [['artifacts/web-preview/assets/route.png', Buffer.from('destructured-shadow-route')]],
  );
  assert.match(destructuredShadowManifestHtml, /\/assets\/route\.png/u);

  const defaultParameterManifestHtml = await packageAndReadFixture('default-parameter-manifest', {
    mainJs: 'const manifests = [{ key: "logo", path: "/assets/icon.png" }]; const scene = new Phaser.Scene(); function load(options = manifests) { for (const asset of manifests) scene.load.image(asset.key, asset.path); } load();',
  });
  assert.doesNotMatch(defaultParameterManifestHtml, /\/assets\/icon\.png/u);

  const phaserHtmlAsset = '<section>offline panel fixture</section>';
  const phaserHtml = await packageAndReadFixture(
    'phaser-html-asset',
    {
      mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
    },
    [['artifacts/web-preview/assets/panel.html', phaserHtmlAsset]],
  );
  assert.doesNotMatch(phaserHtml, /\/assets\/panel\.html/u);
  assert.ok(
    phaserHtml.includes(`data:text/html;base64,${Buffer.from(phaserHtmlAsset).toString('base64')}`),
    'expected the Phaser HTML asset to be inlined as an exact data URL',
  );

  const rawTextPhaserHtmlAsset = '<textarea><script>example</script></textarea><title><img src="/assets/not-an-asset.png"></title><style>.label::before { content: "<script>example</script>"; }</style>';
  const rawTextPhaserHtml = await packageAndReadFixture(
    'raw-text-phaser-html-asset',
    {
      mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
    },
    [['artifacts/web-preview/assets/panel.html', rawTextPhaserHtmlAsset]],
  );
  assert.ok(
    rawTextPhaserHtml.includes(
      `data:text/html;base64,${Buffer.from(rawTextPhaserHtmlAsset).toString('base64')}`,
    ),
    'expected markup-like raw text to remain inert and be preserved',
  );

  const scriptedPhaserHtmlGame = createPreviewFixture('scripted-phaser-html', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
  });
  fs.writeFileSync(
    path.join(scriptedPhaserHtmlGame, 'artifacts/web-preview/assets/panel.html'),
    '<script>open("https://example.com")</script>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: scriptedPhaserHtmlGame }),
    /requires inert self-contained HTML assets.*contains <script>/u,
  );

  const externalPhaserHtmlGame = createPreviewFixture('external-phaser-html', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
  });
  fs.writeFileSync(
    path.join(externalPhaserHtmlGame, 'artifacts/web-preview/assets/panel.html'),
    '<section onclick="open(\'https://example.com\')"><img src="./panel.png"></section>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalPhaserHtmlGame }),
    /requires inert self-contained HTML assets/u,
  );

  const externalImageSetPhaserHtmlGame = createPreviewFixture('external-image-set-phaser-html', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
  });
  fs.writeFileSync(
    path.join(externalImageSetPhaserHtmlGame, 'artifacts/web-preview/assets/panel.html'),
    '<style>.panel { background-image: image-set("/assets/pixel.png" 1x); }</style><section class="panel">offline panel</section>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: externalImageSetPhaserHtmlGame }),
    /requires self-contained HTML assets.*references \/assets\/pixel\.png/u,
  );

  const refreshingPhaserHtmlGame = createPreviewFixture('refreshing-phaser-html', {
    mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
  });
  fs.writeFileSync(
    path.join(refreshingPhaserHtmlGame, 'artifacts/web-preview/assets/panel.html'),
    '<meta http-equiv="refresh" content="0;url=https://example.com/escape">',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: refreshingPhaserHtmlGame }),
    /contains meta refresh/u,
  );

  for (const [name, embeddedDocument] of [
    [
      'data-html-document-phaser-html',
      '<object data="data:text/html;base64,PHNjcmlwdD5vcGVuKCJodHRwczovL2V4YW1wbGUuY29tIik8L3NjcmlwdD4="></object>',
    ],
    [
      'data-svg-document-phaser-html',
      '<embed src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9Im9wZW4oJ2h0dHBzOi8vZXhhbXBsZS5jb20nKSIvPg==">',
    ],
  ] as const) {
    const activeNestedDocumentGame = createPreviewFixture(name, {
      mainJs: 'const scene = new Phaser.Scene(); scene.load.html("panel", "/assets/panel.html");',
    });
    fs.writeFileSync(
      path.join(activeNestedDocumentGame, 'artifacts/web-preview/assets/panel.html'),
      embeddedDocument,
    );
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: activeNestedDocumentGame }),
      /contains an embedded active data document/u,
    );
  }

  for (const method of ['setPath', 'setBaseURL']) {
    const prefixedPhaserGame = createPreviewFixture(`phaser-loader-${method.toLowerCase()}`, {
      mainJs: `const scene = new Phaser.Scene(); scene.load.${method}("/assets"); scene.load.image("hero", "hero.png");`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: prefixedPhaserGame }),
      /does not support Phaser loader base URL or path prefixes/u,
    );
  }

  for (const method of [
    'css',
    'multiatlas',
    'pack',
    'plugin',
    'sceneFile',
    'scenePlugin',
    'script',
    'scripts',
    'tilemapTiledJSON',
  ]) {
    const unsupportedLoaderGame = createPreviewFixture(`phaser-loader-${method.toLowerCase()}`, {
      mainJs: `const scene = new Phaser.Scene(); scene.load.${method}("asset", "/assets/fixture.json");`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: unsupportedLoaderGame }),
      new RegExp(`does not support Phaser ${method} loader assets`, 'u'),
    );
  }

  const computedUnsupportedLoaderGame = createPreviewFixture('phaser-loader-computed-css', {
    mainJs: 'const scene = new Phaser.Scene(); scene["load"]["css"]("asset", "/assets/main.css");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: computedUnsupportedLoaderGame }),
    /does not support Phaser css loader assets/u,
  );

  const binaryDatAsset = Buffer.from('phaser-binary-dat');
  const binaryDatHtml = await packageAndReadFixture(
    'phaser-binary-dat',
    {
      mainJs: 'const scene = new Phaser.Scene(); scene.load.binary("level", "/assets/level.dat");',
    },
    [['artifacts/web-preview/assets/level.dat', binaryDatAsset]],
  );
  assert.ok(
    binaryDatHtml.includes(
      `data:application/octet-stream;base64,${binaryDatAsset.toString('base64')}`,
    ),
    'expected the Phaser .dat binary to be inlined as an exact data URL',
  );

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

  const gltfExtrasUriGame = createPreviewFixture('gltf-extras-uri', {
    mainJs: 'document.body.dataset.scene = new URL("./extras.gltf", import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(gltfExtrasUriGame, 'artifacts/web-preview/assets/extras.gltf'),
    '{"asset":{"version":"2.0"},"extras":{"uri":"level-one"}}\n',
  );
  const gltfExtrasResult = await runOfflinePlaytestPackaging({ gameRoot: gltfExtrasUriGame });
  assert.match(
    fs.readFileSync(gltfExtrasResult.entryFile, 'utf8'),
    /data:model\/gltf\+json;base64,/u,
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

  const commentedFetchHtml = await packageAndReadFixture('commented-fetch-asset', {
    mainJs: 'void fetch(/* preload */ "/assets/config.json");',
  });
  assert.doesNotMatch(commentedFetchHtml, /\/assets\/config\.json/u);
  assert.match(commentedFetchHtml, /data:application\/json;base64,/u);

  const optionalFetchHtml = await packageAndReadFixture('optional-fetch-assets', {
    mainJs: 'void fetch?.("/assets/config.json"); void window.fetch?.("/assets/config.json");',
  });
  assert.doesNotMatch(optionalFetchHtml, /\/assets\/config\.json/u);
  assert.match(optionalFetchHtml, /data:application\/json;base64,/u);

  const unicodeFetchBoundaryHtml = await packageAndReadFixture('unicode-fetch-boundary', {
    mainJs: 'const πfetch = (value) => value; document.body.dataset.value = πfetch("/assets/not-an-asset.json");',
  });
  assert.match(unicodeFetchBoundaryHtml, /\/assets\/not-an-asset\.json/u);

  const escapedUnicodeFetchHtml = await packageAndReadFixture('escaped-unicode-fetch-boundary', {
    mainJs: 'const \\u{3c0}fetch = (value) => value; document.body.dataset.value = \\u{3c0}fetch("/assets/not-an-asset.json");',
  });
  assert.match(escapedUnicodeFetchHtml, /\/assets\/not-an-asset\.json/u);

  const shadowedFetchHtml = await packageAndReadFixture('shadowed-fetch-binding', {
    mainJs: 'const fetch = (value) => value; document.body.dataset.value = [fetch("/assets/not-an-asset.json"), fetch?.("/assets/not-an-asset.json")].join("|");',
  });
  assert.match(shadowedFetchHtml, /\/assets\/not-an-asset\.json/u);

  const importedFetchHtml = await packageAndReadFixture(
    'imported-fetch-binding',
    {
      mainJs: 'import { fetch } from "./fetch-helper.js"; document.body.dataset.value = fetch("/assets/not-an-asset.json");',
    },
    [['artifacts/web-preview/assets/fetch-helper.js', 'export const fetch = (value) => value;']],
  );
  assert.match(importedFetchHtml, /\/assets\/not-an-asset\.json/u);

  const browserAudioHtml = await packageAndReadFixture(
    'browser-audio-asset',
    { mainJs: 'const click = new Audio("/assets/click.mp3"); void click;' },
    [['artifacts/web-preview/assets/click.mp3', Buffer.from('browser-audio')]],
  );
  assert.doesNotMatch(browserAudioHtml, /\/assets\/click\.mp3/u);
  assert.match(browserAudioHtml, /data:audio\/mpeg;base64,/u);

  const fontFaceAsset = Buffer.from('font-face-asset');
  const browserFontFaceHtml = await packageAndReadFixture(
    'browser-font-face-asset',
    {
      mainJs: 'const face = new FontFace("Game", "local(\\"Game\\"), url(\\"/assets/game.woff2\\") format(\\"woff2\\")"); void face.load();',
    },
    [['artifacts/web-preview/assets/game.woff2', fontFaceAsset]],
  );
  assert.doesNotMatch(browserFontFaceHtml, /\/assets\/game\.woff2/u);
  assert.ok(
    browserFontFaceHtml.includes(`data:font/woff2;base64,${fontFaceAsset.toString('base64')}`),
    'expected the FontFace asset to be inlined as an exact data URL',
  );

  const shadowedFontFaceHtml = await packageAndReadFixture('shadowed-font-face', {
    mainJs: 'class FontFace { constructor(family, source) { this.source = source; } } const face = new FontFace("Game", "url(\\"/assets/not-a-font.woff2\\")"); document.body.dataset.source = face.source;',
  });
  assert.match(shadowedFontFaceHtml, /\/assets\/not-a-font\.woff2/u);

  const assignedBrowserAudioHtml = await packageAndReadFixture(
    'assigned-browser-audio-asset',
    { mainJs: 'const click = new Audio(); click.src = "/assets/click.mp3"; void click;' },
    [['artifacts/web-preview/assets/click.mp3', Buffer.from('assigned-browser-audio')]],
  );
  assert.doesNotMatch(assignedBrowserAudioHtml, /\/assets\/click\.mp3/u);
  assert.match(assignedBrowserAudioHtml, /data:audio\/mpeg;base64,/u);

  const browserImageHtml = await packageAndReadFixture('browser-image-asset', {
    mainJs: 'const splash = new Image(); splash.src = "/assets/pixel.png"; document.body.append(splash);',
  });
  assert.doesNotMatch(browserImageHtml, /\/assets\/pixel\.png/u);
  assert.match(browserImageHtml, /data:image\/png;base64,/u);

  const createdBrowserImageHtml = await packageAndReadFixture('created-browser-image-asset', {
    mainJs: 'const splash = document.createElement("img"); splash.src = "/assets/pixel.png"; document.body.append(splash);',
  });
  assert.doesNotMatch(createdBrowserImageHtml, /\/assets\/pixel\.png/u);
  assert.match(createdBrowserImageHtml, /data:image\/png;base64,/u);

  const commentedCreatedBrowserImageHtml = await packageAndReadFixture(
    'commented-created-browser-image-asset',
    {
      mainJs: 'const splash = document.createElement(/* fallback */ "img"); splash.src = "/assets/pixel.png"; document.body.append(splash);',
    },
  );
  assert.doesNotMatch(commentedCreatedBrowserImageHtml, /\/assets\/pixel\.png/u);
  assert.match(commentedCreatedBrowserImageHtml, /data:image\/png;base64,/u);

  const shadowedDocumentImageHtml = await packageAndReadFixture('shadowed-document-image', {
    mainJs: 'function render(document) { const image = document.createElement("img"); image.src = "/assets/custom-image.png"; return image.src; } document.body.dataset.src = render({ createElement() { return {}; } });',
  });
  assert.match(shadowedDocumentImageHtml, /\/assets\/custom-image\.png/u);

  const sizedBrowserImageHtml = await packageAndReadFixture('sized-browser-image-asset', {
    mainJs: 'const splash = new Image(64, 64); splash.src = "/assets/pixel.png"; document.body.append(splash);',
  });
  assert.doesNotMatch(sizedBrowserImageHtml, /\/assets\/pixel\.png/u);
  assert.match(sizedBrowserImageHtml, /data:image\/png;base64,/u);

  const reassignedBrowserImageGame = createPreviewFixture('reassigned-browser-image-asset', {
    mainJs: 'let splash = new Image(); splash = { src: "" }; splash.src = "/assets/pixel.png"; document.body.dataset.src = splash.src;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: reassignedBrowserImageGame }),
    /requires an immutable Image binding/u,
  );

  const browserImageWithoutParenthesesHtml = await packageAndReadFixture(
    'browser-image-without-parentheses-asset',
    {
      mainJs: 'const splash = new Image; splash.src = "/assets/pixel.png"; document.body.append(splash);',
    },
  );
  assert.doesNotMatch(browserImageWithoutParenthesesHtml, /\/assets\/pixel\.png/u);
  assert.match(browserImageWithoutParenthesesHtml, /data:image\/png;base64,/u);

  const qualifiedBrowserImageWithoutParenthesesHtml = await packageAndReadFixture(
    'qualified-browser-image-without-parentheses-asset',
    {
      mainJs: 'const splash = new window.Image; splash.src = "/assets/pixel.png"; document.body.append(splash);',
    },
  );
  assert.doesNotMatch(qualifiedBrowserImageWithoutParenthesesHtml, /\/assets\/pixel\.png/u);
  assert.match(qualifiedBrowserImageWithoutParenthesesHtml, /data:image\/png;base64,/u);

  const shadowedBrowserApiHtml = await packageAndReadFixture('shadowed-browser-apis', {
    mainJs: 'const Audio = class {}; const Image = class {}; const sound = new Audio("/assets/custom-audio.mp3"); const image = new Image(); image.src = "/assets/custom-image.png"; document.body.dataset.value = [sound, image.src].join("|");',
  });
  assert.match(shadowedBrowserApiHtml, /\/assets\/custom-audio\.mp3/u);
  assert.match(shadowedBrowserApiHtml, /\/assets\/custom-image\.png/u);

  const shadowedQualifiedBrowserApiHtml = await packageAndReadFixture(
    'shadowed-qualified-browser-apis',
    {
      mainJs: 'function route(window) { const sound = new window.Audio("/assets/custom-audio.mp3"); const image = new window.Image(); image.src = "/assets/custom-image.png"; const request = new window.XMLHttpRequest(); request.open("GET", "/assets/custom-level.json"); return [sound.src, image.src]; } const browser = { Audio: class { constructor(src) { this.src = src; } }, Image: class {}, XMLHttpRequest: class { open() {} } }; document.body.dataset.value = route(browser).join("|");',
    },
  );
  assert.match(shadowedQualifiedBrowserApiHtml, /\/assets\/custom-audio\.mp3/u);
  assert.match(shadowedQualifiedBrowserApiHtml, /\/assets\/custom-image\.png/u);
  assert.match(shadowedQualifiedBrowserApiHtml, /\/assets\/custom-level\.json/u);

  const staticNetworkConstructorHtml = await packageAndReadFixture(
    'network-constructor-static-properties',
    {
      mainJs: 'document.body.dataset.states = [WebSocket.OPEN, EventSource.CLOSED].join(",");',
    },
  );
  assert.match(staticNetworkConstructorHtml, /new Proxy/u);
  assert.match(staticNetworkConstructorHtml, /WebSocket\.OPEN/u);
  assert.match(staticNetworkConstructorHtml, /EventSource\.CLOSED/u);

  const shadowedDefaultViewHtml = await packageAndReadFixture('shadowed-default-view', {
    mainJs: 'function route(document) { document.defaultView.location.href = "/assets/helper.html"; return document.defaultView.location.href; } document.body.dataset.route = route({ defaultView: { location: {} } });',
  });
  assert.match(shadowedDefaultViewHtml, /\/assets\/helper\.html/u);

  const shadowedUrlGame = createPreviewFixture('shadowed-url-constructor', {
    mainJs: 'class URL { constructor(value) { this.href = value; } } const localUrl = new URL("/assets/custom-url.txt", import.meta.url); document.body.dataset.value = localUrl.href;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: shadowedUrlGame }),
    /does not support bare import\.meta in the bundled entry/u,
  );

  for (const qualifier of ['globalThis', 'self', 'window'] as const) {
    const qualifiedUrlHtml = await packageAndReadFixture(`qualified-${qualifier}-url`, {
      mainJs: `const asset = new ${qualifier}.URL("./config.json", import.meta.url); document.body.dataset.asset = asset.href;`,
    });
    assert.doesNotMatch(qualifiedUrlHtml, /\.\/config\.json/u);
    assert.match(qualifiedUrlHtml, /data:application\/json;base64,/u);
  }

  const locallyShadowedUrlHtml = await packageAndReadFixture('locally-shadowed-qualified-url', {
    mainJs: 'class URL {} const asset = new globalThis.URL("./config.json", import.meta.url); document.body.dataset.asset = asset.href;',
  });
  assert.doesNotMatch(locallyShadowedUrlHtml, /\.\/config\.json/u);
  assert.match(locallyShadowedUrlHtml, /data:application\/json;base64,/u);

  const shadowedQualifiedUrlGame = createPreviewFixture('shadowed-qualified-url-constructor', {
    mainJs: 'function resolve(globalThis) { return new globalThis.URL("./config.json", import.meta.url).href; } document.body.dataset.value = resolve({ URL });',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: shadowedQualifiedUrlGame }),
    /does not support bare import\.meta in the bundled entry/u,
  );

  const escapedLevelJson = '{"fixture":"escaped-level"}\n';
  const escapedIconPng = Buffer.from('escaped-icon-fixture');
  const escapedJavaScriptAssetHtml = await packageAndReadFixture(
    'escaped-javascript-asset',
    {
      mainJs: 'const level = new URL("./level\\u002ejson", import.meta.url); void fetch("./icon\\x2epng"); document.body.dataset.level = level.href;',
    },
    [
      ['artifacts/web-preview/assets/level.json', escapedLevelJson],
      ['artifacts/web-preview/icon.png', escapedIconPng],
    ],
  );
  assert.doesNotMatch(
    escapedJavaScriptAssetHtml,
    /(?:level\\u002ejson|level\.json|icon\\x2epng|icon\.png)/u,
  );
  const escapedLevelData = Buffer.from(escapedLevelJson).toString('base64');
  assert.ok(
    escapedJavaScriptAssetHtml.includes(`data:application/json;base64,${escapedLevelData}`),
    'expected the escaped JSON asset to be inlined as an exact data URL',
  );
  assert.ok(
    escapedJavaScriptAssetHtml.includes(
      `data:image/png;base64,${escapedIconPng.toString('base64')}`,
    ),
    'expected the escaped image asset to be inlined as an exact data URL',
  );

  const quotedPlayerJson = '{"fixture":"quoted-player"}\n';
  const quotedPlayerPng = Buffer.from('quoted-player-fixture');
  const quotedJavaScriptAssetHtml = await packageAndReadFixture(
    'quoted-javascript-asset',
    {
      mainJs: "const portrait = new URL(\"./player's.png\", import.meta.url); void fetch('./player\\'s.json'); document.body.dataset.portrait = portrait.href;",
    },
    [
      ["artifacts/web-preview/assets/player's.png", quotedPlayerPng],
      ["artifacts/web-preview/player's.json", quotedPlayerJson],
    ],
  );
  assert.doesNotMatch(quotedJavaScriptAssetHtml, /player(?:\\'|')s\.(?:json|png)/u);
  const quotedPlayerData = Buffer.from(quotedPlayerJson).toString('base64');
  assert.ok(
    quotedJavaScriptAssetHtml.includes(`data:application/json;base64,${quotedPlayerData}`),
    'expected the quoted JSON asset to be inlined as an exact data URL',
  );
  assert.ok(
    quotedJavaScriptAssetHtml.includes(
      `data:image/png;base64,${quotedPlayerPng.toString('base64')}`,
    ),
    'expected the quoted image asset to be inlined as an exact data URL',
  );

  const networkFetchGame = createPreviewFixture('network-fetch', {
    mainJs: 'void fetch("https://example.com/level.json");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: networkFetchGame }),
    /does not support network fetch URL/u,
  );

  const xmlHttpRequestHtml = await packageAndReadFixture(
    'xml-http-request-asset',
    {
      mainJs: 'const request = new XMLHttpRequest(); request.open("GET", "/assets/level.json"); request.send();',
    },
    [['artifacts/web-preview/assets/level.json', '{"level":1}\n']],
  );
  assert.doesNotMatch(xmlHttpRequestHtml, /\/assets\/level\.json/u);
  assert.match(xmlHttpRequestHtml, /data:application\/json;base64,/u);

  const shadowedXmlHttpRequestHtml = await packageAndReadFixture('shadowed-xml-http-request', {
    mainJs: 'class XMLHttpRequest { open(method, url) { document.body.dataset.url = url; } send() {} } const request = new XMLHttpRequest(); request.open("GET", "/assets/level.json"); request.send();',
  }, [['artifacts/web-preview/assets/level.json', '{"level":1}\n']]);
  assert.match(shadowedXmlHttpRequestHtml, /\/assets\/level\.json/u);

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

  const preloadHtml = await packageAndReadFixture('resource-preload', {
    indexHtml: '<!doctype html><html><head><link rel="preload" as="image" href="/assets/splash.png"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(preloadHtml, /(?:rel="preload"|\/assets\/splash\.png)/u);

  const integrityStylesheetGame = createPreviewFixture('integrity-stylesheet', {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css" integrity="sha256-invalid"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: integrityStylesheetGame }),
    /does not support integrity-protected stylesheets/u,
  );

  const alternateStylesheetGame = createPreviewFixture('alternate-stylesheet', {
    indexHtml: '<!doctype html><html><head><link rel="alternate stylesheet" title="dark" href="/assets/main.css"></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: alternateStylesheetGame }),
    /does not support alternate stylesheets/u,
  );

  const mixedSrcsetHtml = await packageAndReadFixture('mixed-srcset', {
    indexHtml: '<!doctype html><html><head></head><body><img srcset="data:image/png;base64,AAAA, /assets/pixel.png 2x"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(mixedSrcsetHtml, /data:image\/png;base64,AAAA/u);
  assert.doesNotMatch(mixedSrcsetHtml, /\/assets\/pixel\.png/u);

  const abruptCommentEndHtml = await packageAndReadFixture('abrupt-comment-end', {
    indexHtml: '<!doctype html><html><head></head><body><!-- first --!><img src="/assets/pixel.png"><!-- tail --><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(abruptCommentEndHtml, /\/assets\/pixel\.png/u);
  assert.match(abruptCommentEndHtml, /src="data:image\/png;base64,/u);

  const serializedBlobHtmlGame = createPreviewFixture('serialized-blob-html', {
    indexHtml: '<!doctype html><html><head></head><body><img src="blob:https://example.com/image"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: serializedBlobHtmlGame }),
    /cannot inline external URL.*blob:/u,
  );

  const serializedBlobJavaScriptGame = createPreviewFixture('serialized-blob-javascript', {
    mainJs: 'void fetch("blob:https://example.com/data");',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: serializedBlobJavaScriptGame }),
    /does not support network fetch URL: blob:/u,
  );

  const serializedBlobCssGame = createPreviewFixture('serialized-blob-css');
  fs.writeFileSync(
    path.join(serializedBlobCssGame, 'artifacts/web-preview/assets/main.css'),
    'body { background-image: url("blob:https://example.com/image"); }',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: serializedBlobCssGame }),
    /cannot inline external URL.*blob:/u,
  );

  const uppercaseDataHtml = await packageAndReadFixture('uppercase-data-scheme', {
    indexHtml: '<!doctype html><html><head></head><body><img src="DATA:image/png;base64,AAAA"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(uppercaseDataHtml, /src="DATA:image\/png;base64,AAAA"/u);

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
    /document\.currentScript\.previousElementSibling\.sheet\.disabled=true/u,
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

  const escapedUrlFunctionHtml = await packageAndReadFixture('escaped-css-url-function', {}, [
    [
      'artifacts/web-preview/assets/main.css',
      'body { background-image: \\75rl("/assets/pixel.png"); }',
    ],
  ]);
  assert.doesNotMatch(escapedUrlFunctionHtml, /\/assets\/pixel\.png/u);
  assert.match(escapedUrlFunctionHtml, /data:image\/png;base64,/u);

  const escapedImageSetFunctionHtml = await packageAndReadFixture(
    'escaped-css-image-set-function',
    {},
    [
      [
        'artifacts/web-preview/assets/main.css',
        'body { background-image: image-\\73 et("/assets/icon.png" 1x); }',
      ],
    ],
  );
  assert.doesNotMatch(escapedImageSetFunctionHtml, /\/assets\/icon\.png/u);
  assert.match(escapedImageSetFunctionHtml, /data:image\/png;base64,/u);

  const commentedUrlFunctionHtml = await packageAndReadFixture('commented-css-url-function', {}, [
    [
      'artifacts/web-preview/assets/main.css',
      'body { background-image: url(/* preload */ "/assets/pixel.png"); }',
    ],
  ]);
  assert.doesNotMatch(commentedUrlFunctionHtml, /\/assets\/pixel\.png/u);
  assert.match(commentedUrlFunctionHtml, /data:image\/png;base64,/u);

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

  const commentedImageSetFiles: readonly PreviewFixtureFile[] = [
    [
      'artifacts/web-preview/assets/main.css',
      'body { background-image: image-set(/* theme, local */ "/assets/icon.png" 1x, /* retina */ "/assets/icon@2x.png" 2x); }',
    ],
    ['artifacts/web-preview/assets/icon@2x.png', onePixelPng],
  ];
  const commentedImageSetHtml = await packageAndReadFixture(
    'commented-css-image-set',
    {},
    commentedImageSetFiles,
  );
  assert.doesNotMatch(commentedImageSetHtml, /\/assets\/icon(?:@2x)?\.png/u);
  assert.equal(commentedImageSetHtml.match(/data:image\/png;base64,/gu)?.length, 2);

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

  const legacyBodyBackgroundHtml = await packageAndReadFixture('legacy-body-background', {
    indexHtml: '<!doctype html><html><head></head><body background="/assets/pixel.png"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.doesNotMatch(legacyBodyBackgroundHtml, /background="\/assets\/pixel\.png"/u);
  assert.match(legacyBodyBackgroundHtml, /background="data:image\/png;base64,/u);

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

  const svgPresentationAssetHtml = await packageAndReadFixture(
    'inline-svg-presentation-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><svg><rect fill="url(/assets/paint.svg#gradient)"></rect></svg><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [
      [
        'artifacts/web-preview/assets/paint.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="gradient"/></svg>',
      ],
    ],
  );
  assert.doesNotMatch(svgPresentationAssetHtml, /\/assets\/paint\.svg/u);
  assert.match(svgPresentationAssetHtml, /data:image\/svg\+xml;base64,[^&]+#gradient/u);

  const objectAssetHtml = await packageAndReadFixture(
    'object-asset',
    {
      indexHtml: '<!doctype html><html><head></head><body><object data="/assets/icon.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [['artifacts/web-preview/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']],
  );
  assert.match(objectAssetHtml, /object-src data:/u);
  assert.match(objectAssetHtml, /data:image\/svg\+xml;base64,/u);

  const activeDataObjectGame = createPreviewFixture('active-data-object', {
    indexHtml: '<!doctype html><html><head></head><body><object data="data:text/html;base64,PHNjcmlwdD5vcGVuKCJodHRwczovL2V4YW1wbGUuY29tIik8L3NjcmlwdD4="></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: activeDataObjectGame }),
    /does not support embedded active data documents/u,
  );

  const safeXmlObjectHtml = await packageAndReadFixture(
    'safe-xml-object',
    {
      indexHtml: '<!doctype html><html><head></head><body><object data="/assets/level.xml"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
    },
    [
      [
        'artifacts/web-preview/assets/level.xml',
        '<?xml version="1.0"?><level><name>one</name></level>',
      ],
    ],
  );
  assert.doesNotMatch(safeXmlObjectHtml, /\/assets\/level\.xml/u);
  assert.match(safeXmlObjectHtml, /data:application\/xml;base64,/u);

  const styledXmlObjectGame = createPreviewFixture('styled-xml-object', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/active.xml"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(styledXmlObjectGame, 'artifacts/web-preview/assets/active.xml'),
    '<?xml version="1.0"?><?xml-stylesheet href="https://example.com/theme.xsl"?><level/>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: styledXmlObjectGame }),
    /requires inert self-contained XML assets/u,
  );

  const scriptedXmlObjectGame = createPreviewFixture('scripted-xml-object', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/active.xml"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(scriptedXmlObjectGame, 'artifacts/web-preview/assets/active.xml'),
    '<html xmlns="http://www.w3.org/1999/xhtml"><script>open("https://example.com")</script></html>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: scriptedXmlObjectGame }),
    /requires inert self-contained XML assets/u,
  );

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

  const activeSvgGame = createPreviewFixture('active-svg', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/active.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(activeSvgGame, 'artifacts/web-preview/assets/active.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="location.href=\'https://example.com\'"><script>open("https://example.com")</script></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: activeSvgGame }),
    /does not support active SVG content/u,
  );

  const styledSvgGame = createPreviewFixture('styled-svg', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/styled.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(styledSvgGame, 'artifacts/web-preview/assets/styled.svg'),
    '<?xml version="1.0"?><?xml-stylesheet href="https://example.com/theme.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: styledSvgGame }),
    /requires inert self-contained SVG assets/u,
  );

  const namespacedScriptSvgGame = createPreviewFixture('namespaced-script-svg', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/active.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(namespacedScriptSvgGame, 'artifacts/web-preview/assets/active.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>open("https://example.com")</svg:script></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: namespacedScriptSvgGame }),
    /does not support active SVG content/u,
  );

  const iframeSvgGame = createPreviewFixture('iframe-svg', {
    indexHtml: '<!doctype html><html><head></head><body><object data="/assets/active.svg"></object><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(iframeSvgGame, 'artifacts/web-preview/assets/active.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script>open(\'https://example.com\')&lt;/script>"></iframe></foreignObject></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: iframeSvgGame }),
    /does not support active SVG content/u,
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

  const svgSrcsetGame = createPreviewFixture('svg-srcset', {
    indexHtml: '<!doctype html><html><head></head><body><img src="/assets/srcset.svg"><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  fs.writeFileSync(
    path.join(svgSrcsetGame, 'artifacts/web-preview/assets/srcset.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" srcset="/assets/pixel.png 1x"/></foreignObject></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: svgSrcsetGame }),
    /requires self-contained SVG data URIs and fragment references.*references \/assets\/pixel\.png/u,
  );

  const charsetHtml = await packageAndReadFixture('charset-first', {
    indexHtml: '<!doctype html><html><head><meta charset="shift_jis"><script>window.label="한글";</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(charsetHtml, /<head>\s*<meta charset="utf-8">/u);
  assert.equal(charsetHtml.match(/<meta\b[^>]*charset=/giu)?.length, 1);
  assert.match(charsetHtml, /한글/u);

  const omittedBodyEndHtml = await packageAndReadFixture('omitted-body-end', {
    indexHtml: '<!doctype html><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></html>',
  });
  assert.match(omittedBodyEndHtml, /<body><main id="game"><\/main>/u);
  assert.doesNotMatch(omittedBodyEndHtml, /<\/body>/u);

  const commentedHeadHtml = await packageAndReadFixture('commented-head', {
    indexHtml: '<!doctype html><!-- <head> is generated below --><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  assert.match(commentedHeadHtml, /<!-- <head> is generated below -->/u);
  assert.match(commentedHeadHtml, /<head>\s*<meta charset="utf-8">/u);

  const lateCharsetGame = createPreviewFixture('late-charset', {
    indexHtml: `<!doctype html><!--${'x'.repeat(1_100)}--><html><head></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>`,
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: lateCharsetGame }),
    /requires the generated UTF-8 charset declaration within the first 1024 bytes/u,
  );

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

  const executableTemplateScriptGame = createPreviewFixture('executable-template-script', {
    indexHtml: '<!doctype html><html><head><template><script type="module" src="/assets/template.js"></script></template></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: executableTemplateScriptGame }),
    /does not support executable scripts inside templates/u,
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

  for (const [name, inlineScript] of [
    [
      'block-comment-dynamic-import',
      'void import /* retained block comment */ ("https://example.com/module.js");',
    ],
    [
      'line-comment-dynamic-import',
      'void import // retained line comment\n("https://example.com/module.js");',
    ],
  ] as const) {
    const commentedDynamicImportGame = createPreviewFixture(name, {
      indexHtml: `<!doctype html><html><head><script>${inlineScript}</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>`,
    });
    await assert.rejects(
      () => runOfflinePlaytestPackaging({ gameRoot: commentedDynamicImportGame }),
      /does not support dynamic import/u,
    );
  }

  const dynamicImportBeforeBlockGame = createPreviewFixture('dynamic-import-before-block', {
    indexHtml: '<!doctype html><html><head><script>import("/assets/lazy.js")\n{ document.body.dataset.lazy = "attempted"; }</script></head><body><main id="game"></main><script type="module" src="/assets/main.js"></script></body></html>',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicImportBeforeBlockGame }),
    /does not support dynamic import/u,
  );

  const importMethodHtml = await packageAndReadFixture('ordinary-import-methods', {
    mainJs: 'const loader = { import() { return "local"; } }; class ClassLoader { import() { return "class-local"; } } const classLoader = new ClassLoader(); document.body.dataset.value = [loader.import(), loader["import"](), loader. /* retained */ import(), classLoader.import()].join("|");',
  });
  assert.match(importMethodHtml, /loader\.import\(\)/u);

  const interpolatedTemplateAssetGame = createPreviewFixture('interpolated-template-asset', {
    mainJs: 'const mask = "mask"; document.body.dataset.asset = new URL(`./icons.svg#${mask}`, import.meta.url).href;',
  });
  fs.writeFileSync(
    path.join(interpolatedTemplateAssetGame, 'artifacts/web-preview/assets/icons.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><mask id="mask"/></svg>',
  );
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: interpolatedTemplateAssetGame }),
    /bare import\.meta in the bundled entry/u,
  );

  const dynamicAssetGame = createPreviewFixture('dynamic-asset', {
    mainJs: 'const getPath = () => "pixel.png"; document.body.dataset.asset = new URL(getPath(), import.meta.url).href;',
  });
  await assert.rejects(
    () => runOfflinePlaytestPackaging({ gameRoot: dynamicAssetGame }),
    /bare import\.meta in the bundled entry/u,
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

  const shadowedQualifiedFetchHtml = await packageAndReadFixture('shadowed-qualified-fetch', {
    mainJs: 'function route(window) { return window.fetch("/assets/helper.json"); } document.body.dataset.route = route({ fetch: (value) => value });',
  });
  assert.match(shadowedQualifiedFetchHtml, /\/assets\/helper\.json/u);

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

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

import { auditArtifacts } from './artifacts.mjs';
import { staticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, 'artifacts/browser');
const builds = join(root, 'artifacts/browser-build');
await mkdir(artifacts, { recursive: true });
const remote = await staticServer(join(root, 'artifacts/origin'), { cors: true });
const previousOrigin = process.env.ASSET_PACK_REMOTE_ORIGIN;
let browser;
const servers = [];
const evidence = [];
try {
  process.env.ASSET_PACK_REMOTE_ORIGIN = remote.url;
  for (const mode of ['bundled', 'hybrid']) await build({ root, configFile: join(root, 'vite.config.ts'), mode, build: { outDir: join(builds, mode) }, logLevel: 'warn' });
  const reports = await auditArtifacts(builds);
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const report of reports) for (const renderer of ['webgl', 'canvas']) {
    const app = await staticServer(join(builds, report.mode));
    servers.push(app);
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const expectedFailures = new Set();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (expectedFailures.has(message.location().url) && message.text().startsWith('Failed to load resource:')) return;
      errors.push(message.text());
    });
    const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
    const wait = async (phase) => page.waitForFunction((expected) => typeof window.render_game_to_text === 'function' && JSON.parse(window.render_game_to_text()).phase === expected, phase);
    const imagePath = (id) => '/' + report.packs.find((pack) => pack.id === id).files.find((file) => file.mediaType === 'image/png').path;
    const target = (id) => report.packs.find((pack) => pack.id === id).packaged ? app : remote;
    const count = (id) => target(id).requests.filter((path) => path === imagePath(id)).length;
    const empty = async () => {
      await page.click('#unload');
      await page.evaluate(() => window.advanceTime(17));
      const value = await state();
      assert.equal(value.phase, 'idle');
      assert.equal(value.textureCount, 0);
      assert.deepEqual(value.resources, []);
    };
    await page.goto(app.url + '?renderer=' + renderer);
    await wait('idle');
    assert.equal(app.requests.filter((path) => path.startsWith('/packs/')).length, 0, 'No speculative asset fetches before selecting a level');
    const sharedBefore = count('shared');
    const dunesBefore = count('dunes');
    await page.click('#grove');
    await wait('playing');
    let current = await state();
    assert.equal(current.current, 'grove');
    assert.equal(current.renderer, renderer);
    assert.equal(current.groundFrames, 2, 'Atlas frames are available at entry');
    assert.equal(current.pilotFrames, 4, 'Spritesheet frames are available at entry');
    assert.deepEqual([current.ready, current.total, current.textureCount], [2, 2, 2]);
    const sharedIdentity = current.resources.find((asset) => asset.pack === 'shared').identity;
    assert.equal(count('dunes'), dunesBefore, 'An unused theme stays unloaded');
    await page.click('#dunes');
    await wait('playing');
    current = await state();
    assert.equal(current.current, 'dunes');
    assert.deepEqual(current.resources.map((asset) => asset.pack).sort(), ['dunes', 'shared']);
    assert.equal(current.resources.find((asset) => asset.pack === 'shared').identity, sharedIdentity);
    assert.equal(current.textureCount, 2);
    assert.equal(count('shared') - sharedBefore, 1, 'Theme changes reuse the resident shared image');
    const requestsAtEntry = app.requests.length + remote.requests.length;
    const beforeMove = current.player.x;
    await page.keyboard.down('ArrowRight');
    await page.evaluate(() => window.advanceTime(200));
    await page.keyboard.up('ArrowRight');
    assert.ok((await state()).player.x > beforeMove);
    await page.waitForTimeout(100);
    assert.equal(app.requests.length + remote.requests.length, requestsAtEntry, 'Gameplay must not start deferred asset loads');
    await page.screenshot({ path: join(artifacts, `${report.mode}-${renderer}-dunes.png`), fullPage: true });
    evidence.push({ mode: report.mode, renderer, ready: await state(), packagedAssetBytes: report.packagedAssetBytes });
    await empty();

    // Transport failure handling is renderer-independent; exercise it once under WebGL.
    if (report.mode === 'hybrid' && renderer === 'webgl') {
      const path = imagePath('grove');
      const url = new URL(path, remote.url).href;
      // No CORS proxy or custom asset service: a separate ordinary static HTTP origin.
      assert.equal(app.requests.includes(path), false);
      remote.faults.set(path, { kind: 'status', status: 404 });
      expectedFailures.add(url);
      const beforeMissing = count('grove');
      await page.click('#grove');
      await wait('error');
      assert.match((await state()).error, /HTTP 404/);
      assert.equal(count('grove') - beforeMissing, 1, '404 is not retried automatically');
      assert.equal((await state()).current, null);
      assert.deepEqual((await state()).resources, []);
      await page.waitForTimeout(100);
      assert.equal((await state()).textureCount, 0);
      remote.faults.set(path, { kind: 'status', status: 500, remaining: 1 });
      const beforeTransient = count('grove');
      await page.click('#retry');
      await wait('playing');
      assert.equal(count('grove') - beforeTransient, 2, 'One bounded retry recovers a transient 500');
      remote.faults.clear();
      expectedFailures.clear();
      await empty();

      remote.faults.set(path, { kind: 'status', status: 500 });
      expectedFailures.add(url);
      const beforePersistent = count('grove');
      await page.click('#grove');
      await wait('error');
      assert.equal(count('grove') - beforePersistent, 2, 'Persistent failure stops after two attempts');
      remote.faults.clear();
      expectedFailures.clear();
      for (const [kind, error] of [['corrupt', /digest mismatch/i], ['oversize', /exceeds byte limit|size mismatch/i]]) {
        remote.faults.set(path, { kind });
        await page.click('#retry');
        await wait('error');
        assert.match((await state()).error, error);
        assert.equal((await state()).current, null);
        assert.deepEqual((await state()).resources, []);
      }
      remote.faults.set(path, { kind: 'stall' });
      const stalledBefore = count('grove');
      await page.click('#retry');
      await wait('error');
      assert.match((await state()).error, /request timed out/);
      assert.equal(count('grove') - stalledBefore, 2, 'Body deadline aborts each stalled attempt');
      remote.faults.clear();
      await page.click('#retry');
      await wait('playing');

      // A failed transition must leave the previous level's resources intact.
      const duneUrl = new URL(imagePath('dunes'), remote.url).href;
      expectedFailures.add(duneUrl);
      await context.setOffline(true);
      await page.click('#dunes');
      await wait('error');
      assert.equal((await state()).current, 'grove');
      assert.deepEqual((await state()).resources.map((asset) => asset.pack).sort(), ['grove', 'shared']);
      await context.setOffline(false);
      expectedFailures.clear();
      await page.click('#retry');
      await wait('playing');
      await empty();

      remote.delays.set(path, 350);
      const beforeCancel = count('grove');
      await page.click('#grove');
      await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'preparing');
      await page.waitForTimeout(70);
      assert.ok(count('grove') > beforeCancel);
      await page.click('#cancel');
      assert.equal((await state()).phase, 'idle');
      assert.deepEqual((await state()).resources, []);
      // Immediately acquiring a replacement must survive any late old work.
      await page.click('#dunes');
      await wait('playing');
      await page.waitForTimeout(450);
      assert.equal((await state()).current, 'dunes');
      assert.equal((await state()).textureCount, 2);
      assert.deepEqual((await state()).resources.map((asset) => asset.pack).sort(), ['dunes', 'shared']);
      remote.delays.clear();
      await empty();
      await page.screenshot({ path: join(artifacts, 'hybrid-unloaded.png'), fullPage: true });
    }
    if (report.mode === 'hybrid' && renderer === 'webgl') {
      // Opting into ordinary HTTP caching reuses immutable bytes after textures are released.
      await page.goto(app.url + '?renderer=webgl&http-cache=1');
      await wait('idle');
      await page.click('#grove');
      await wait('playing');
      const warmRequests = app.requests.length + remote.requests.length;
      await empty();
      await page.click('#grove');
      await wait('playing');
      assert.equal(app.requests.length + remote.requests.length, warmRequests, 'HTTP cache should avoid repeated downloads after release');
      assert.equal((await state()).textureCount, 2);
      await empty();
    }
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.shutdownSample());
    assert.equal((await state()).phase, 'booting');
    assert.deepEqual((await state()).resources, []);
    await page.waitForTimeout(50);
    assert.equal((await state()).current, null);
    await context.close();
  }
  // Real Phaser must reject a prepared but incorrectly named theme image without
  // falling back to its missing texture or sacrificing the existing level's lease.
  const invalidCatalog = structuredClone(reports.find((report) => report.mode === 'bundled').packs);
  invalidCatalog.find((pack) => pack.id === 'dunes').assets[0].key = 'wrong-ground';
  const invalidBuild = join(builds, 'invalid-theme');
  await build({ root, configFile: join(root, 'vite.config.ts'), mode: 'bundled',
    build: { outDir: invalidBuild }, define: { __ASSET_PACK_CATALOG__: JSON.stringify(invalidCatalog) }, logLevel: 'warn' });
  const invalidApp = await staticServer(invalidBuild);
  servers.push(invalidApp);
  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  const invalidErrors = [];
  invalidPage.on('pageerror', (error) => invalidErrors.push(error.message));
  invalidPage.on('console', (message) => { if (message.type() === 'error') invalidErrors.push(message.text()); });
  const invalidState = () => invalidPage.evaluate(() => JSON.parse(window.render_game_to_text()));
  await invalidPage.goto(invalidApp.url);
  await invalidPage.waitForFunction(() => typeof window.render_game_to_text === 'function' && JSON.parse(window.render_game_to_text()).phase === 'idle');
  await invalidPage.click('#grove');
  await invalidPage.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'playing');
  const beforeInvalid = await invalidState();
  await invalidPage.click('#dunes');
  await invalidPage.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'error');
  const afterInvalid = await invalidState();
  assert.match(afterInvalid.error, /Asset is not in this lease: dunes\/ground/);
  assert.equal(afterInvalid.current, 'grove');
  assert.deepEqual(afterInvalid.resources, beforeInvalid.resources);
  assert.deepEqual(afterInvalid.player, beforeInvalid.player);
  assert.equal(afterInvalid.textureCount, 2);
  await invalidPage.click('#unload');
  assert.deepEqual((await invalidState()).resources, []);
  assert.equal((await invalidState()).textureCount, 0);
  assert.deepEqual(invalidErrors, []);
  await invalidContext.close();
  evidence.push({ invalidTheme: afterInvalid });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.info('Asset pack browser checks passed: bundled/hybrid, exclusion, sharing, readiness, retries, integrity, offline failure, cancellation, release and invalid level rollback.');
} finally {
  if (previousOrigin === undefined) delete process.env.ASSET_PACK_REMOTE_ORIGIN;
  else process.env.ASSET_PACK_REMOTE_ORIGIN = previousOrigin;
  await browser?.close();
  for (const server of servers) await server.close();
  await remote.close();
}

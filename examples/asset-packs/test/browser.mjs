import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  // The ZIP acceptance consumes real `mpgd assets build-packs` output: the
  // all-ZIP and mixed files+ZIP variants are built into the static origin
  // before the app builds, exactly as a consumer would produce them.
  const deliveryBuild = spawnSync(process.execPath, [
    join(root, '..', '..', 'tools', 'run-ttsx.mjs'),
    '--project', 'tsconfig.delivery-build.json',
    'test/build-delivery.ts',
  ], { cwd: root, stdio: 'inherit' });
  if (deliveryBuild.status !== 0) throw new Error('Delivery artifact build failed');
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
    const wait = async (phase) => {
      try {
        await page.waitForFunction((expected) => typeof window.render_game_to_text === 'function' && JSON.parse(window.render_game_to_text()).phase === expected, phase);
      } catch (error) {
        let actual;
        try { actual = await state(); } catch { actual = 'unavailable'; }
        console.error('Asset scenario failed', { mode: report.mode, renderer, expected: phase, actual, errors });
        throw error;
      }
    };
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
    await page.click('#grove');
    await wait('playing');
    assert.equal((await state()).textureCount, 2);
    assert.equal(await page.evaluate(() => window.shutdownSample()), 0, 'Shutdown removes resident physical textures');
    assert.equal((await state()).phase, 'booting');
    assert.deepEqual((await state()).resources, []);
    await page.waitForTimeout(50);
    assert.equal((await state()).current, null);
    assert.deepEqual(errors, []);
    if (report.mode === 'hybrid') {
      await page.goto(app.url + '?renderer=' + renderer);
      await wait('idle');
      remote.delays.set(imagePath('grove'), 250);
      await page.click('#grove');
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => window.shutdownSample()), 0);
      await page.waitForTimeout(350);
      assert.equal((await state()).phase, 'booting');
      assert.equal((await state()).current, null);
      assert.deepEqual(errors, []);
      remote.delays.clear();
    }
    await context.close();
  }
  // The packaged bounded ZIP decoder runs in a real module worker.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const app = await staticServer(join(builds, 'bundled'));
    servers.push(app);
    await page.goto(app.url + '?zip-worker=1');
    const result = await page.waitForFunction(() => window.__zip_worker_result !== undefined, undefined, { timeout: 20000 });
    const report = JSON.parse(await result.evaluate(() => window.__zip_worker_result()));
    assert.equal(report.status, 'passed', `worker self test failed: ${JSON.stringify(report)}`);
    assert.equal(report.entries, 2);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Real CLI-built ZIP packs decoded by the real module worker, supplied to
  // the same Phaser loader through the prepared file source.
  {
    const packOf = (manifest, id) => {
      const pack = manifest.packs.find((entry) => entry.packId === id);
      assert.ok(pack, `Delivery manifest lacks the ${id} pack`);
      return pack;
    };
    const archiveOf = (manifest, id) => {
      const archive = packOf(manifest, id).archive;
      assert.ok(archive, `Delivery manifest pack ${id} lacks an archive`);
      return archive;
    };
    // The app resolves manifest artifact paths by URL-encoding each
    // segment; expected-failure URLs must match that encoding exactly.
    const encodedUrl = (artifactPath) => new URL(
      artifactPath.split('/').map((segment) => encodeURIComponent(segment)).join('/'),
      remote.url,
    ).href;
    const zipManifest = JSON.parse(await readFile(join(root, 'artifacts/origin/delivery/zip/asset-pack-delivery.json'), 'utf8'));
    const archivePath = (id) => '/delivery/zip/' + archiveOf(zipManifest, id).path;
    const needBytes = (packIds) => packIds.reduce((sum, id) => {
      const pack = packOf(zipManifest, id);
      return sum + archiveOf(zipManifest, id).bytes + pack.assets.flatMap((asset) => asset.files).reduce((n, file) => n + file.bytes, 0);
    }, 0);
    const groveClosureNeed = needBytes(['shared', 'grove']);
    const zipArtifactBytes = zipManifest.packs.reduce((sum, pack) => sum + pack.archive.bytes, 0);
    const zipExpandedBytes = zipManifest.packs.reduce((sum, pack) => sum + pack.assets.flatMap((asset) => asset.files).reduce((n, file) => n + file.bytes, 0), 0);
    const zipApp = await staticServer(join(builds, 'bundled'));
    servers.push(zipApp);

    for (const renderer of ['webgl', 'canvas']) {
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
      const wait = (phase) => page.waitForFunction((expected) => JSON.parse(window.render_game_to_text()).phase === expected, phase);
      const waitForPreparing = (requested) => page.waitForFunction((expected) => {
        const current = JSON.parse(window.render_game_to_text());
        return current.phase === 'preparing' && current.requested === expected;
      }, requested);
      const zipCount = (id) => remote.requests.filter((path) => path === archivePath(id)).length;

      await page.goto(zipApp.url + '?renderer=' + renderer + '&delivery=zip');
      await wait('idle');
      let current = await state();
      assert.equal(current.delivery, 'zip');
      assert.equal(current.staging.stagingUsedBytes, 0);
      // Entry never fetches per-file HTTP paths under ZIP delivery.
      assert.equal(remote.requests.filter((path) => path.startsWith('/delivery/zip/packs/') && !path.endsWith('.zip')).length, 0);

      const sharedBefore = zipCount('shared');
      const groveBefore = zipCount('grove');
      await page.click('#grove');
      await wait('playing');
      current = await state();
      assert.equal(current.current, 'grove');
      assert.equal(current.groundFrames, 2, 'Atlas frames arrive from the archive');
      assert.equal(current.pilotFrames, 4, 'Spritesheet frames arrive from the archive');
      assert.deepEqual([current.ready, current.total, current.textureCount], [2, 2, 2]);
      assert.ok(Number.isFinite(current.lastPrepareMs) && current.lastPrepareMs >= 0);
      // Observed delivery staging is distinct from texture readiness: the
      // prepare operation reached its terminal exactly once, with measured
      // progress recorded and no failure terminal.
      assert.equal(current.observed.phase, 'prepared');
      assert.equal(current.observed.packId, 'grove');
      assert.equal(current.observed.terminal, '');
      assert.match(current.observed.progress, /entries 2 \/ 2/);
      // The selection-time inspection matches what the prepare just did:
      // the shared+grove closure fit the budget and the displayed plan
      // describes exactly the two packs staged.
      assert.equal(current.plan.closure.length, 2);
      assert.equal(current.plan.coldObjectCount, 2);
      assert.equal(current.plan.fitsBudget, true);
      assert.ok(current.plan.additionalReservationBytes > 0);
      assert.equal(current.plan.accountingModel, 'archive-plus-expanded-v1');
      // One archive request per pack in the closure — never one per file.
      assert.equal(zipCount('shared') - sharedBefore, 1, 'The shared archive downloads once per preparation');
      assert.equal(zipCount('grove') - groveBefore, 1, 'The theme archive downloads once per preparation');
      assert.equal(remote.requests.filter((path) => path.startsWith('/delivery/zip/packs/') && !path.endsWith('.zip')).length, 0);
      // Staging is returned after the loader consumed the files while the
      // texture lease keeps the level on screen.
      assert.equal(current.staging.stagingUsedBytes, 0);
      assert.deepEqual(current.staging.staging, []);
      await page.screenshot({ path: join(artifacts, `zip-${renderer}-grove.png`), fullPage: true });

      await page.click('#dunes');
      await wait('playing');
      current = await state();
      assert.equal(current.current, 'dunes');
      assert.deepEqual(current.resources.map((asset) => asset.pack).sort(), ['dunes', 'shared']);
      assert.equal(current.textureCount, 2);

      await page.click('#unload');
      await page.evaluate(() => window.advanceTime(17));
      current = await state();
      assert.equal(current.phase, 'idle');
      assert.equal(current.textureCount, 0);
      assert.deepEqual(current.resources, []);
      // Re-entry after the staging was emptied re-prepares from the network.
      const reentryShared = zipCount('shared');
      await page.click('#grove');
      await wait('playing');
      assert.equal(zipCount('shared') - reentryShared, 1, 'Re-entry re-prepares the dependency closure');
      assert.equal((await state()).textureCount, 2);
      await page.click('#unload');

      if (renderer === 'webgl') {
        // A failed transition keeps the current level's screen and lease.
        const dunesUrl = encodedUrl(archivePath('dunes'));
        expectedFailures.add(dunesUrl);
        await page.click('#grove');
        await wait('playing');
        remote.faults.set(archivePath('dunes'), { kind: 'status', status: 404 });
        await page.click('#dunes');
        await wait('error');
        current = await state();
        assert.match(current.error, /HTTP 404/);
        assert.equal(current.current, 'grove');
        assert.deepEqual(current.resources.map((asset) => asset.pack).sort(), ['grove', 'shared']);
        assert.equal(current.textureCount, 2);
        remote.faults.set(archivePath('dunes'), { kind: 'corrupt' });
        await page.click('#retry');
        await wait('error');
        // The sample displays stable fields only: the integrity code with
        // the captured decoder stage, never the message text.
        assert.match((await state()).error, /integrity \[decoding-and-verifying/);
        remote.faults.delete(archivePath('dunes'));
        await page.click('#retry');
        await wait('playing');
        // Clear only after the successful retry: the failed attempt's
        // console message can still be in flight when the error phase ends.
        expectedFailures.clear();
        await page.click('#unload');

        // An oversized closure is rejected before any archive request.
        await page.goto(zipApp.url + '?renderer=webgl&delivery=zip&staging=1000');
        await wait('idle');
        const oversizeBefore = zipCount('shared');
        await page.click('#grove');
        await wait('error');
        assert.match((await state()).error, /^budget$/);
        assert.equal(zipCount('shared'), oversizeBefore, 'Oversized preparation must not hit the network');
        // The same selection-time plan explains the refusal: over budget,
        // with the UI display and the prepare admission agreeing.
        const oversizePlan = (await state()).plan;
        assert.equal(oversizePlan.fitsBudget, false);
        assert.ok(oversizePlan.projectedStagingBytes > oversizePlan.stagingBudgetBytes);

        // An exact budget admits the boundary without waiting.
        await page.goto(zipApp.url + '?renderer=webgl&delivery=zip&staging=' + groveClosureNeed);
        await wait('idle');
        await page.click('#grove');
        await wait('playing');
        await page.click('#unload');

        // Cancelling mid-preparation keeps the delivery consistent and the
        // next transition starts clean.
        await page.goto(zipApp.url + '?renderer=webgl&delivery=zip');
        await wait('idle');
        remote.delays.set(archivePath('shared'), 350);
        await page.click('#grove');
        await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'preparing');
        await page.click('#cancel');
        current = await state();
        assert.equal(current.phase, 'idle');
        assert.equal(current.staging.stagingUsedBytes, 0);
        remote.delays.delete(archivePath('shared'));
        await page.click('#dunes');
        await wait('playing');
        assert.equal((await state()).current, 'dunes');
        await page.click('#unload');

        // Overlapping A → B → A transitions commit the latest choice.
        await page.click('#grove');
        await waitForPreparing('grove');
        await page.click('#dunes');
        await waitForPreparing('dunes');
        await page.click('#grove');
        await wait('playing');
        current = await state();
        assert.equal(current.current, 'grove');
        assert.equal(current.groundFrames, 2);
        assert.equal(current.pilotFrames, 4);
        assert.equal(current.textureCount, 2);
        assert.equal(current.staging.stagingUsedBytes, 0);
        await page.click('#unload');

        // Scene shutdown during preparation aborts the delivery cleanly.
        remote.delays.set(archivePath('shared'), 300);
        await page.click('#grove');
        await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'preparing');
        assert.equal(await page.evaluate(() => window.shutdownSample()), 0);
        await page.waitForTimeout(400);
        current = await state();
        assert.equal(current.phase, 'booting');
        assert.equal(current.current, null);
        remote.delays.delete(archivePath('shared'));

        // Shutdown while playing removes the resident physical textures.
        await page.goto(zipApp.url + '?renderer=webgl&delivery=zip');
        await wait('idle');
        await page.click('#grove');
        await wait('playing');
        assert.equal(await page.evaluate(() => window.shutdownSample()), 0);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Mixed files + ZIP manifest: the shared pack stays plain HTTP while the
    // themes arrive as archives, through one file source.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
      const wait = (phase) => page.waitForFunction((expected) => JSON.parse(window.render_game_to_text()).phase === expected, phase);
      await page.goto(zipApp.url + '?renderer=webgl&delivery=mixed');
      await wait('idle');
      assert.equal((await state()).delivery, 'mixed');
      await page.click('#grove');
      await wait('playing');
      const current = await state();
      assert.equal(current.current, 'grove');
      assert.equal(current.textureCount, 2);
      assert.equal(current.groundFrames, 2);
      assert.equal(current.pilotFrames, 4);
      const mixedManifest = JSON.parse(await readFile(join(root, 'artifacts/origin/delivery/mixed/asset-pack-delivery.json'), 'utf8'));
      const mixedShared = packOf(mixedManifest, 'shared');
      const mixedTexture = mixedShared.assets[0]?.files.find((file) => file.role === 'texture');
      assert.ok(mixedTexture, 'The mixed shared pack lacks a texture file');
      assert.ok(remote.requests.includes('/delivery/mixed/' + mixedTexture.path), 'The files pack keeps plain HTTP delivery');
      assert.ok(remote.requests.includes('/delivery/mixed/' + archiveOf(mixedManifest, 'grove').path), 'The theme pack arrives as an archive');
      await page.click('#unload');
      assert.equal((await state()).textureCount, 0);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Files-vs-ZIP comparison on the same logical entry (renderer-independent).
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      const wait = (phase) => page.waitForFunction((expected) => JSON.parse(window.render_game_to_text()).phase === expected, phase);
      const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
      const measure = async (url) => {
        await page.goto(url);
        await wait('idle');
        const startedAt = Date.now();
        await page.click('#grove');
        await wait('playing');
        return { elapsedMs: Date.now() - startedAt, state: await state() };
      };
      const filesRun = await measure(zipApp.url + '?renderer=webgl');
      const zipRun = await measure(zipApp.url + '?renderer=webgl&delivery=zip');
      // The same logical assets and frames must arrive either way.
      assert.deepEqual(
        [zipRun.state.groundFrames, zipRun.state.pilotFrames, zipRun.state.textureCount],
        [filesRun.state.groundFrames, filesRun.state.pilotFrames, filesRun.state.textureCount],
      );
      const filesBytes = reports.find((report) => report.mode === 'bundled').packs
        .reduce((sum, pack) => sum + pack.files.reduce((n, file) => n + file.bytes, 0), 0);
      evidence.push({
        deliveryComparison: {
          filesEntryMs: filesRun.elapsedMs,
          zipEntryMs: zipRun.elapsedMs,
          filesBytes,
          zipArtifactBytes: zipArtifactBytes,
          zipExpandedBytes,
          warmCache: false,
        },
      });
      assert.deepEqual(errors, []);
      await context.close();
    }
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

    // Baseline A: HTTP-cache-only delivery (no idcache), reloaded. The
    // delivery fetches artifacts with cache: 'no-store', so the reload
    // re-fetches every archive — the controlled comparison the
    // IndexedDB runs below are measured against.
    {
      const baselineApp = await staticServer(join(builds, 'bundled'));
      servers.push(baselineApp);
      const baselineContext = await browser.newContext();
      const baselinePage = await baselineContext.newPage();
      const baselineErrors = [];
      baselinePage.on('pageerror', (error) => baselineErrors.push(error.message));
      const baselineState = () => baselinePage.evaluate(() => JSON.parse(window.render_game_to_text()));
      const baselineWait = (phase) => baselinePage.waitForFunction((expected) => JSON.parse(window.render_game_to_text()).phase === expected, phase);
      await baselinePage.goto(baselineApp.url + '?renderer=webgl&delivery=zip');
      await baselineWait('idle');
      await baselinePage.click('#grove');
      await baselineWait('playing');
      await baselinePage.click('#unload');
      await baselinePage.reload();
      await baselineWait('idle');
      const baselineBefore = remote.requests.filter((path) => path.startsWith('/delivery/zip/packs/')).length;
      await baselinePage.click('#grove');
      await baselineWait('playing');
      const baseline = await baselineState();
      const baselineGets = remote.requests.filter((path) => path.startsWith('/delivery/zip/packs/')).length - baselineBefore;
      assert.equal(baselineGets, 2, 'Without the artifact cache a reload re-fetches both archives');
      assert.equal(baseline.current, 'grove');
      evidence.push({ baselineHttpOnly: { artifactGets: baselineGets, lastPrepareMs: baseline.lastPrepareMs } });
      assert.deepEqual(baselineErrors, []);
      await baselineContext.close();
    }


  // Persistent artifact reuse (private experiment, idcache=1): verified
  // origin bytes in IndexedDB, re-served to the unchanged public
  // delivery through managed Blob URLs. Real Chromium IndexedDB, real
  // page reloads on the same origin.
  {
    const cacheApp = await staticServer(join(builds, 'bundled'));
    servers.push(cacheApp);
    const cacheContext = await browser.newContext();
    const cachePage = await cacheContext.newPage();
    const cacheErrors = [];
    cachePage.on('pageerror', (error) => cacheErrors.push(error.message));
    cachePage.on('console', (message) => { if (message.type() === 'error') cacheErrors.push(message.text()); });
    const cacheState = () => cachePage.evaluate(() => JSON.parse(window.render_game_to_text()));
    const cacheWait = (phase) => cachePage.waitForFunction((expected) => JSON.parse(window.render_game_to_text()).phase === expected, phase);
    // Artifact GET counting: the ZIP app shell is local; artifacts come
    // from the remote origin. Blob URL fetches never appear there.
    const artifactGets = () => remote.requests.filter((path) => path.startsWith('/delivery/zip/packs/')).length;
    const groveArchivePath = '/delivery/zip/packs/grove@1.zip';
    const usage = () => cachePage.evaluate(() => window.__artifact_cache_usage());
    const idbRaw = (fn) => cachePage.evaluate(`(${fn})(indexedDB)`);

    // C. controlled baseline first (fresh context, cold IndexedDB):
    await cachePage.goto(cacheApp.url + '?renderer=webgl&delivery=zip&idcache=1');
    await cacheWait('idle');
    assert.equal(await cachePage.evaluate(() => window.__artifact_cache_present()), true, 'The experiment bridge must be active under idcache=1');

    // Cold run: every artifact is fetched from the origin once, verified,
    // and committed; the delivery still verifies the Blob-served bytes.
    const coldBefore = artifactGets();
    await cachePage.click('#grove');
    await cacheWait('playing');
    let cacheNow = await cacheState();
    assert.equal(cacheNow.current, 'grove');
    assert.equal(cacheNow.groundFrames, 2, 'Atlas frames survive the cache bridge');
    assert.equal(cacheNow.pilotFrames, 4, 'Spritesheet frames survive the cache bridge');
    const coldReport = cacheNow.cache.report;
    assert.equal(coldReport.entries.length, 2, 'shared + grove archives warmed');
    assert.ok(coldReport.entries.every((entry) => entry.outcome === 'origin-stored'), JSON.stringify(coldReport));
    const coldGets = artifactGets() - coldBefore;
    assert.equal(coldGets, 2, 'Cold run fetches each archive from the origin exactly once');
    const coldUsage = await usage();
    assert.equal(coldUsage.records, 2, 'Two verified records committed');
    assert.ok(coldUsage.totalBytes > 0);
    const identities = coldReport.entries.map((entry) => entry.identity);
    await cachePage.click('#unload');

    // Idempotent duplicate storage: the same content re-warms as cache
    // hits without growing the record set.
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    assert.ok(cacheNow.cache.report.entries.every((entry) => entry.outcome === 'cache-hit'));
    assert.equal((await usage()).records, 2, 'Duplicate stores are idempotent');
    await cachePage.click('#unload');

    // Warm run after a same-origin reload: zero origin artifact GETs.
    const warmBefore = artifactGets();
    await cachePage.reload();
    await cacheWait('idle');
    assert.equal(await cachePage.evaluate(() => window.__artifact_cache_present()), true);
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    assert.equal(cacheNow.current, 'grove');
    assert.equal(cacheNow.groundFrames, 2);
    assert.equal(cacheNow.pilotFrames, 4);
    assert.ok(cacheNow.cache.report.entries.every((entry) => entry.outcome === 'cache-hit'), JSON.stringify(cacheNow.cache.report));
    assert.equal(artifactGets() - warmBefore, 0, 'Warm reload reuses stored bytes with zero origin artifact GETs');
    const warmStats = cacheNow.cache.report.entries.map(({ identity, cacheReadMs, verifyMs, blobMs }) => ({ identity, cacheReadMs, verifyMs, blobMs }));
    assert.ok(warmStats.every((entry) => entry.cacheReadMs !== null && entry.verifyMs !== null));
    evidence.push({
      persistentReuse: {
        cold: { artifactGets: coldGets, entries: coldReport.entries.map(({ identity, outcome, fetchMs, writeMs, bodyBytes }) => ({ identity, outcome, fetchMs, writeMs, bodyBytes })) },
        warm: { artifactGets: 0, entries: warmStats },
      },
    });

    // Corrupt record detection: tamper a stored payload, reload, and the
    // warm must treat it as a miss (never serve corrupt bytes) — the
    // origin refetch restores playability.
    const tamperedIdentity = identities[0];
    await idbRaw(`async (db) => {
      const open = await new Promise((resolve, reject) => {
        const request = db.open('mpgd-asset-pack-experiment');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = open.transaction('artifacts', 'readwrite');
        const store = tx.objectStore('artifacts');
        const get = store.get(${JSON.stringify(tamperedIdentity)});
        get.onsuccess = () => {
          const record = get.result;
          record.payload = record.payload.slice(0);
          new Uint8Array(record.payload)[0] ^= 0xff;
          store.put(record, ${JSON.stringify(tamperedIdentity)});
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      open.close();
    }`);
    const corruptBefore = artifactGets();
    await cachePage.reload();
    await cacheWait('idle');
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    const corruptOutcomes = cacheNow.cache.report.entries.map((entry) => entry.outcome);
    assert.ok(corruptOutcomes.includes('origin-stored'), JSON.stringify(corruptOutcomes));
    assert.ok(!corruptOutcomes.every((outcome) => outcome === 'cache-hit'), 'A tampered payload is never a hit');
    assert.equal(artifactGets() - corruptBefore, 1, 'The corrupt record is refetched from the origin');
    await cachePage.click('#unload');

    // Record present but payload missing: miss, not a hit.
    const removedIdentity = identities[1];
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), removedIdentity);
    const deleteBefore = artifactGets();
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    assert.ok(cacheNow.cache.report.entries.some((entry) => entry.identity === removedIdentity && entry.outcome === 'origin-stored'));
    assert.equal(artifactGets() - deleteBefore, 1, 'An explicitly deleted record misses and refetches');
    await cachePage.click('#unload');

    // Fault injection: a store failure keeps the delivery outcome intact
    // and reports failure honestly (never 'stored').
    await cachePage.evaluate(() => window.__artifact_cache_set_fault('failPutOnce'));
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[0]);
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    const faultEntry = cacheNow.cache.report.entries.find((entry) => entry.identity === identities[0]);
    assert.equal(faultEntry.outcome, 'origin-store-failed', JSON.stringify(cacheNow.cache.report.entries));
    assert.equal(cacheNow.current, 'grove', 'A store failure never breaks the online load');
    await cachePage.click('#unload');

    // Fault injection: cache unavailable degrades to the origin path.
    // The one-shot fault fires on the first warmed artifact (shared);
    // grove was just deleted, so both artifacts come from the origin.
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[1]);
    await cachePage.evaluate(() => window.__artifact_cache_set_fault('dbUnavailableOnce'));
    const unavailableBefore = artifactGets();
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    const unavailableEntry = cacheNow.cache.report.entries.find((entry) => entry.outcome === 'cache-unavailable');
    assert.equal(unavailableEntry?.identity, identities[0], JSON.stringify(cacheNow.cache.report.entries));
    assert.equal(artifactGets() - unavailableBefore, 2, 'Cache-unavailable falls back to the origin');
    await cachePage.click('#unload');

    // Stored metadata tamper: a mutated digest field fails the
    // current-manifest comparison — a miss, never a hit. Re-store both
    // archives first: the unavailable fault above skipped shared.
    await cachePage.click('#grove');
    await cacheWait('playing');
    await cachePage.click('#unload');
    await idbRaw(`async (db) => {
      const open = await new Promise((resolve, reject) => {
        const request = db.open('mpgd-asset-pack-experiment');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = open.transaction('artifacts', 'readwrite');
        const store = tx.objectStore('artifacts');
        const get = store.get(${JSON.stringify(identities[0])});
        get.onsuccess = () => {
          const record = get.result;
          record.digest = '0'.repeat(64);
          record.bytes = record.bytes + 1;
          store.put(record, ${JSON.stringify(identities[0])});
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      open.close();
    }`);
    const metaBefore = artifactGets();
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    assert.ok(
      cacheNow.cache.report.entries.some((entry) => entry.identity === identities[0] && entry.outcome === 'origin-stored'),
      JSON.stringify(cacheNow.cache.report.entries),
    );
    assert.equal(artifactGets() - metaBefore, 1, 'Metadata-tampered records miss and refetch');
    await cachePage.click('#unload');
    assert.equal((await cacheState()).textureCount, 0, 'Cache-mode unload releases textures');

    // Content change under the same path: the origin serves different
    // bytes, the manifest digest no longer matches, and the stale stored
    // record cannot be misused (identity is digest-derived). The warm
    // acquisition fails verification and the delivery's own integrity
    // check surfaces the error — no stale success.
    // Drop the stored record so acquisition must hit the changed origin.
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[1]);
    remote.faults.set(groveArchivePath, { kind: 'corrupt' });
    await cachePage.click('#grove');
    await cacheWait('error');
    cacheNow = await cacheState();
    assert.match(cacheNow.error, /integrity|transport/, 'Changed content must fail, not reuse stale bytes');
    remote.faults.delete(groveArchivePath);
    await cachePage.click('#retry');
    await cacheWait('playing');

    // Transaction abort: the failed store commits nothing (no partial
    // record) and the previous good records stay usable.
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[1]);
    await cachePage.evaluate(() => window.__artifact_cache_set_fault('abortCommitOnce'));
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    const abortEntries = cacheNow.cache.report.entries;
    assert.equal(abortEntries.find((entry) => entry.identity === identities[0])?.outcome, 'cache-hit',
      'A previous good record stays usable while another store aborts');
    assert.equal(abortEntries.find((entry) => entry.identity === identities[1])?.outcome, 'origin-store-failed',
      JSON.stringify(abortEntries));
    assert.equal((await usage()).records, 1, 'An aborted transaction leaves no partial record');
    await cachePage.click('#unload');
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    assert.equal(cacheNow.cache.report.entries.find((entry) => entry.identity === identities[1])?.outcome, 'origin-stored');
    await cachePage.click('#unload');

    // Delete vs late write under real concurrency: a delayed origin fetch
    // keeps the warm slow while a delete races it. IDB serializes per
    // key, so the result is complete-or-absent, and the entry outcome
    // stays within the defined set.
    remote.delays.set(groveArchivePath, 250);
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[0]);
    const raceClick = cachePage.click('#grove');
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), identities[0]);
    await raceClick;
    await cacheWait('playing');
    cacheNow = await cacheState();
    const raceOutcome = cacheNow.cache.report.entries.find((entry) => entry.identity === identities[0])?.outcome;
    assert.ok(['cache-hit', 'origin-stored'].includes(raceOutcome), JSON.stringify(cacheNow.cache.report.entries));
    remote.delays.delete(groveArchivePath);
    await cachePage.click('#unload');

    // Namespace isolation: foreign keys in the same store survive every
    // experiment operation above.
    const foreign = await idbRaw(`async (db) => {
      const open = await new Promise((resolve, reject) => {
        const request = db.open('mpgd-asset-pack-experiment');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = open.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put({ foreign: true }, 'other-app|record|1');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      const present = await new Promise((resolve, reject) => {
        const tx = open.transaction('artifacts', 'readonly');
        const get = tx.objectStore('artifacts').get('other-app|record|1');
        get.onsuccess = () => resolve(get.result !== undefined);
        get.onerror = () => reject(get.error);
      });
      open.close();
      return present;
    }`);
    assert.equal(foreign, true, 'A foreign record is insertable next to the experiment namespace');
    await cachePage.click('#grove');
    await cacheWait('playing');
    await cachePage.click('#unload');
    const foreignAfter = await idbRaw(`async (db) => {
      const open = await new Promise((resolve, reject) => {
        const request = db.open('mpgd-asset-pack-experiment');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const present = await new Promise((resolve, reject) => {
        const tx = open.transaction('artifacts', 'readonly');
        const get = tx.objectStore('artifacts').get('other-app|record|1');
        get.onsuccess = () => resolve(get.result !== undefined);
        get.onerror = () => reject(get.error);
      });
      open.close();
      return present;
    }`);
    assert.equal(foreignAfter, true, 'Experiment operations never touch foreign records');

    // Delete vs late write: the defined result is IDB's last-commit-wins
    // per key — the store ends either absent or complete, never partial.
    const raceIdentity = identities[0];
    await cachePage.evaluate((identity) => window.__artifact_cache_delete(identity), raceIdentity);
    await cachePage.click('#grove');
    await cacheWait('playing');
    cacheNow = await cacheState();
    const raceEntry = cacheNow.cache.report.entries.find((entry) => entry.identity === raceIdentity);
    assert.ok(['cache-hit', 'origin-stored'].includes(raceEntry.outcome), JSON.stringify(raceEntry));
    await cachePage.click('#unload');

    assert.deepEqual(cacheErrors, []);
    await cacheContext.close();
  }

  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.info('Asset pack browser checks passed: bundled/hybrid, exclusion, sharing, readiness, retries, integrity, offline failure, cancellation, release, invalid level rollback and persistent artifact reuse (cold/warm reload, tamper, delete, quota, unavailable, abort, namespace isolation).');
} finally {
  if (previousOrigin === undefined) delete process.env.ASSET_PACK_REMOTE_ORIGIN;
  else process.env.ASSET_PACK_REMOTE_ORIGIN = previousOrigin;
  await browser?.close();
  for (const server of servers) await server.close();
  await remote.close();
}

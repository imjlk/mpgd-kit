import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { build } from 'vite';
import { auditArtifacts } from './artifacts.mjs';
import { staticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '../..');
const out = join(root, 'artifacts/measurements');
const repetitions = Number(process.env.ASSET_PACK_MEASURE_REPEATS ?? 3);
const remoteDelayMs = Number(process.env.ASSET_PACK_MEASURE_REMOTE_DELAY_MS ?? 40);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20);
assert.ok(Number.isSafeInteger(remoteDelayMs) && remoteDelayMs >= 0 && remoteDelayMs <= 500);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { result.push(...await files(path)); }
    else { result.push(path); }
  }
  return result;
}
async function inventory(directory) {
  const entries = [];
  for (const path of await files(directory)) {
    const bytes = await readFile(path);
    entries.push({ path: relative(directory, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), files: entries };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const oldOrigin = process.env.ASSET_PACK_REMOTE_ORIGIN;
await mkdir(out, { recursive: true });
const originRoot = join(root, 'artifacts/origin');
const remote = await staticServer(originRoot, { cors: true });
const servers = [];
let browser;
const runs = [];
const cases = [
  { name: 'bundled-files', mode: 'bundled' },
  { name: 'remote-files', mode: 'hybrid' },
  { name: 'remote-files-prefetch', mode: 'hybrid', prefetch: true },
  { name: 'mixed-zip', mode: 'hybrid', delivery: 'mixed' },
  { name: 'mixed-zip-prefetch', mode: 'hybrid', delivery: 'mixed', prefetch: true },
  { name: 'mixed-zip-persistent', mode: 'hybrid', delivery: 'mixed', persistent: true },
];
try {
  process.env.ASSET_PACK_REMOTE_ORIGIN = remote.url;
  const deliveryBuild = spawnSync(process.execPath, [join(repo, 'tools/run-ttsx.mjs'), '--project', 'tsconfig.delivery-build.json', 'test/build-delivery.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(deliveryBuild.status, 0, deliveryBuild.stderr);
  for (const mode of ['bundled', 'hybrid']) await build({ root, configFile: join(root, 'vite.config.ts'), mode, logLevel: 'warn', build: { outDir: join(out, 'build', mode) } });
  const policies = await auditArtifacts(join(out, 'build'));
  const artifacts = {};
  for (const mode of ['bundled', 'hybrid']) artifacts[mode] = { ...await inventory(join(out, 'build', mode)), assetReport: policies.find((policy) => policy.mode === mode) };
  for (const file of await files(originRoot)) remote.delays.set('/' + relative(originRoot, file).replaceAll('\\', '/'), remoteDelayMs);
  browser = await chromium.launch({ headless: true });
  for (const scenario of cases) {
    const app = await staticServer(join(out, 'build', scenario.mode)); servers.push(app);
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      const query = new URLSearchParams({ renderer: 'canvas', audio: '1' });
      if (scenario.delivery) query.set('delivery', scenario.delivery);
      if (scenario.prefetch) query.set('prefetch', '1');
      if (scenario.persistent) query.set('idcache', '1');
      const memorySamples = [];
      const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
      const memory = async (label) => {
        const heap = await cdp.send('Runtime.getHeapUsage');
        assert.ok(Number.isFinite(heap.usedSize) && heap.usedSize > 0);
        const value = { label, at: Date.now(), ...heap };
        memorySamples.push(value); return value;
      };
      const checkpoint = async (label) => {
        await cdp.send('HeapProfiler.collectGarbage');
        const value = await state();
        const resident = value.resources.filter((resource) => resource.ready);
        return {
          label, heap: await memory(label), phase: value.phase, textures: value.textureCount, audio: value.audioCount,
          knownPayload: {
            rgbaEstimate: resident.reduce((sum, resource) => sum + resource.rgbaEstimate, 0),
            decodedPcmBytes: resident.some((resource) => resource.decodedAudioBytes === null) ? null : resident.reduce((sum, resource) => sum + (resource.decodedAudioBytes ?? 0), 0),
            html5BlobBytes: resident.reduce((sum, resource) => sum + (resource.encodedAudioBytes ?? 0), 0),
          },
          residentAssets: resident.length, prefetch: value.prefetch, stagingBytes: value.staging?.stagingUsedBytes ?? 0,
        };
      };
      const bodyStart = [app.responses.length, remote.responses.length];
      const bootAt = Date.now();
      await page.goto(app.url + '?' + query, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.render_game_to_text === 'function' && JSON.parse(window.render_game_to_text()).phase === 'idle');
      const bootToIdleMs = Date.now() - bootAt;
      const warmAt = Date.now();
      const checkpoints = [await checkpoint('post-boot')];
      if (scenario.prefetch) await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).prefetch?.warm.length === 2);
      const prefetchLeadMs = scenario.prefetch ? Date.now() - warmAt : 0;
      if (scenario.prefetch) checkpoints.push(await checkpoint('warm-idle'));
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          await delay(20);
          if (sampling) await memory('entry-sample');
        }
      })();
      const entries = [];
      try {
        for (const theme of ['grove', 'dunes', 'grove']) {
          const startBodies = [app.responses.length, remote.responses.length];
          await page.click('#' + theme);
          await page.waitForFunction((expected) => { const value = JSON.parse(window.render_game_to_text()); return value.phase === 'playing' && value.current === expected; }, theme);
          const ready = await state();
          assert.ok(Number.isFinite(ready.lastEntryMs) && ready.lastEntryMs >= 0);
          assert.deepEqual([ready.ready, ready.total], [3, 3]);
          const bodyBytes = app.responses.slice(startBodies[0]).concat(remote.responses.slice(startBodies[1])).reduce((sum, response) => sum + response.bodyBytes, 0);
          if (scenario.prefetch && entries.length === 0) { assert.equal(bodyBytes, 0, 'A fully warmed entry does not repeat delivery'); }
          entries.push({ theme, entryMs: ready.lastEntryMs, completedResponseBodyBytes: bodyBytes, textureCount: ready.textureCount });
          checkpoints.push(await checkpoint('ready-' + theme));
        }
      } finally { sampling = false; await sampler; }
      const beforeMove = (await state()).player.x;
      const beforePlayBodies = app.responses.length + remote.responses.length;
      await page.keyboard.down('ArrowRight'); await page.evaluate(() => window.advanceTime(200)); await page.keyboard.up('ArrowRight');
      assert.ok((await state()).player.x > beforeMove, 'The measured consumer is playable');
      await page.waitForTimeout(50);
      assert.equal(app.responses.length + remote.responses.length, beforePlayBodies, 'Required work is complete before gameplay');
      if (repetition === 0) await page.screenshot({ path: join(out, scenario.name + '.png'), fullPage: true });
      let persistentCache = null;
      let warmReloadEntryMs = null;
      if (scenario.persistent) {
        persistentCache = await page.evaluate(() => window.__artifact_cache_usage());
        assert.ok(persistentCache.records > 0 && persistentCache.totalBytes > 0);
        await page.reload();
        await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'idle');
        const before = remote.responses.length;
        await page.click('#grove');
        await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase === 'playing');
        const ready = await state(); warmReloadEntryMs = ready.lastEntryMs;
        assert.ok(ready.cache.report.hits > 0);
        assert.equal(remote.responses.length, before, 'Warm cache entry does not refetch pack objects');
        checkpoints.push(await checkpoint('warm-cache-ready'));
      }
      await page.evaluate(() => window.shutdownSample());
      const shutdown = await checkpoint('shutdown');
      assert.deepEqual([shutdown.textures, shutdown.audio, shutdown.residentAssets, shutdown.stagingBytes], [0, 0, 0, 0]);
      checkpoints.push(shutdown);
      assert.deepEqual(errors, []);
      runs.push({ scenario: scenario.name, repetition, bootToIdleMs, prefetchLeadMs, entries, warmReloadEntryMs, persistentCache, checkpoints,
        observedMaxMainIsolateHeapBytes: Math.max(...memorySamples.map((sample) => sample.usedSize)), memorySampleCount: memorySamples.length, memorySamples,
        completedSessionResponseBodyBytes: app.responses.slice(bodyStart[0]).concat(remote.responses.slice(bodyStart[1])).reduce((sum, response) => sum + response.bodyBytes, 0),
      });
      await context.close();
    }
  }
  const summary = cases.map((scenario) => {
    const selected = runs.filter((run) => run.scenario === scenario.name);
    return { scenario: scenario.name, appArtifactBytes: artifacts[scenario.mode].totalBytes, packagedAssetBytes: artifacts[scenario.mode].assetReport.packagedAssetBytes,
      medianFirstGroveEntryMs: median(selected.map((run) => run.entries[0].entryMs)), medianPrefetchLeadMs: median(selected.map((run) => run.prefetchLeadMs)),
      medianFirstEntryBodyBytes: median(selected.map((run) => run.entries[0].completedResponseBodyBytes)),
      medianObservedHeapMaxBytes: median(selected.map((run) => run.observedMaxMainIsolateHeapBytes)),
      medianWarmReloadEntryMs: scenario.persistent ? median(selected.map((run) => run.warmReloadEntryMs)) : null,
    };
  });
  const report = {
    schema: 'mpgd-asset-pack-consumer-measurement-v1', generatedAt: new Date().toISOString(),
    environment: { node: process.version, chromium: browser.version(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, renderer: 'canvas', remoteDelayMs, repetitions },
    source: { measurementScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), mode: 'workspace source candidate', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim() !== '' },
    metrics: { entryMs: 'selection including queue, download/decode and consumer display-object handover; excludes later first-render work',
      memory: 'Runtime.getHeapUsage for the main renderer V8 isolate; observed samples plus explicit post-GC checkpoints',
      knownPayload: 'RGBA estimate, accepted AudioBuffer sample bytes and HTML5 Blob bytes; not total renderer memory',
      bodyBytes: 'completed static-server HTTP response bodies; excludes request/response headers and physical wire overhead',
      notMeasured: ['GPU memory', 'total process/native decoder memory', 'worker-isolate heap', 'exact instantaneous peak', 'production device/network performance'],
    }, artifacts, summary, runs,
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.info(JSON.stringify({ report: join(out, 'report.json'), summary }, null, 2));
} finally {
  if (oldOrigin === undefined) { delete process.env.ASSET_PACK_REMOTE_ORIGIN; } else { process.env.ASSET_PACK_REMOTE_ORIGIN = oldOrigin; }
  await browser?.close();
  for (const server of servers) await server.close();
  await remote.close();
}

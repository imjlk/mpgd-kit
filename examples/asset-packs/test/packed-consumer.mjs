import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { staticServer } from './static-server.mjs';

if (process.platform === 'win32') {
  throw new Error('The packed consumer test requires a Unix environment (macOS, Linux, or WSL).');
}

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(exampleRoot, '..', '..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-packed-consumer-'));
const consumerRoot = join(fixtureRoot, 'consumer');
const tarballRoot = join(fixtureRoot, 'tarballs');
const webRoot = join(consumerRoot, 'web');
const webDist = join(webRoot, 'dist');

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}: ${result.error.message}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
      { cause: result.error },
    );
  }
  return result;
}

function packageTarball(directory) {
  mkdirSync(tarballRoot, { recursive: true });
  const before = new Set(readdirSync(tarballRoot));
  const packed = run('pnpm', ['pack', '--silent', '--pack-destination', tarballRoot], join(repoRoot, directory));
  assert.equal(packed.status, 0, `pnpm pack failed for ${directory}: ${packed.stdout}\n${packed.stderr}`);
  const added = readdirSync(tarballRoot).filter((name) => !before.has(name) && name.endsWith('.tgz'));
  assert.equal(added.length, 1, `expected exactly one tarball for ${directory}`);
  return join(tarballRoot, added[0]);
}

function packsConfig(delivery) {
  const config = JSON.parse(readFileSync(join(exampleRoot, 'delivery-configs', `${delivery}.json`), 'utf8'));
  return { ...config, root: 'src' };
}

function runInstalledCli(consumer, cliBin, args) {
  return run(process.execPath, [cliBin, ...args], consumer);
}

function verifyDelivery(consumer, cliBin, outputName, expectedStatus) {
  const result = runInstalledCli(consumer, cliBin, [
    'assets',
    'verify-delivery',
    '--manifest',
    join(outputName, 'asset-pack-delivery.json'),
    '--root',
    outputName,
    '--json',
  ]);
  assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`verify-delivery emitted non-JSON stdout: ${result.stdout}\n${result.stderr}`, { cause: error });
  }
  assert.equal(typeof report.ok, 'boolean');
  return report;
}

function appSource() {
  return `
import Phaser from 'phaser';
import { createPhaserAssetPackLoader } from '@mpgd/phaser-assets/packs';
import { createPhaserPackDelivery } from '@mpgd/phaser-assets/delivery';
import workerUrl from '@mpgd/phaser-assets/archive-worker?worker&url';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') === 'zip' ? 'zip' : 'mixed';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function execute(scene) {
  const deliveryRoot = new URL('/delivery/' + mode + '/', location.href);
  const manifestResponse = await fetch(new URL('asset-pack-delivery.json', deliveryRoot));
  check(manifestResponse.ok, 'delivery manifest request failed');
  const manifest = await manifestResponse.json();
  const delivery = createPhaserPackDelivery(manifest, {
    resolveURL: (path) => new URL(path, deliveryRoot).href,
    createWorker: () => new Worker(workerUrl, { type: 'module' }),
    prepareTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    stagingBudgetBytes: 64 * 1024 * 1024,
  });

  let cancelled = false;
  if (query.has('cancel')) {
    const controller = new AbortController();
    const attempt = delivery.prepare('grove', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    try {
      await attempt;
      throw new Error('cancellation unexpectedly completed');
    } catch (error) {
      check(error?.code === 'cancelled', 'in-flight cancellation did not return cancelled');
      cancelled = true;
    }
    await fetch('/__packed-consumer/release');
    await wait(25);
  }

  const prepared = await delivery.prepare('grove');
  const loader = createPhaserAssetPackLoader(scene, delivery.catalog, {
    fileSource: delivery.fileSource,
    timeoutMs: 5_000,
    maxConcurrentDownloads: 2,
    maxConcurrentDecodes: 1,
    maxBufferedBytes: 16 * 1024 * 1024,
  });
  const lease = await loader.acquire('grove');
  const pilotKey = lease.key('shared', 'pilot');
  const groundKey = lease.key('grove', 'ground');
  check(scene.textures.exists(pilotKey), 'installed loader did not register the spritesheet');
  check(scene.textures.exists(groundKey), 'installed loader did not register the atlas');
  check(scene.textures.get(pilotKey).has('0') && scene.textures.get(pilotKey).has('3'), 'spritesheet frames are missing');
  check(scene.textures.get(groundKey).has('ground') && scene.textures.get(groundKey).has('stone'), 'atlas frames are missing');
  const image = scene.add.image(1, 1, groundKey, 'ground');
  check(image.texture.key === groundKey, 'Phaser display object did not use the installed texture');
  const frames = {
    pilot: scene.textures.get(pilotKey).getFrameNames().length,
    ground: scene.textures.get(groundKey).getFrameNames().length,
  };
  image.destroy();
  lease.release();
  prepared.release();
  check(loader.snapshot().length === 0, 'loader retained a released resource');
  check(!scene.textures.exists(pilotKey) && !scene.textures.exists(groundKey), 'released textures were not removed');
  check(loader.takeCleanupErrors().length === 0, 'texture cleanup reported an error');
  const staging = delivery.snapshot();
  check(staging.stagingUsedBytes === 0 && staging.staging.length === 0, 'delivery staging was not released');
  loader.dispose();
  delivery.dispose();
  window.__packed_consumer_result__ = {
    ok: true,
    mode,
    cancelled,
    workerUrl: String(workerUrl),
    frames,
    fileRequests: staging.fileRequests,
    archiveRequests: staging.archiveRequests,
  };
}

class ConsumerScene extends Phaser.Scene {
  constructor() { super('packed-consumer'); }
  create() {
    window.__packed_consumer_ready__ = true;
    void execute(this).catch((error) => {
      window.__packed_consumer_result__ = { ok: false, error: error?.stack ?? String(error) };
    });
  }
}

new Phaser.Game({
  type: Phaser.CANVAS,
  width: 16,
  height: 16,
  parent: 'game',
  scene: [ConsumerScene],
  audio: { noAudio: true },
  banner: false,
});
`;
}

async function runBrowser(serverUrl) {
  const browser = await chromium.launch({ headless: true });
  const evidenceRoot = join(exampleRoot, 'artifacts/browser/packed-consumer');
  rmSync(evidenceRoot, { force: true, recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  try {
    for (const scenario of [{ mode: 'zip', cancel: true }, { mode: 'mixed', cancel: false }]) {
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
      const page = await context.newPage();
      const errors = [];
      let traceStarted = false;
      let completed = false;
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      try {
        const query = new URLSearchParams({ mode: scenario.mode });
        if (scenario.cancel) query.set('cancel', '1');
        await page.goto(`${serverUrl}?${query}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__packed_consumer_ready__ === true, null, { timeout: 15_000 });
        await page.waitForFunction(() => window.__packed_consumer_result__ !== undefined, null, { timeout: 30_000 });
        const result = await page.evaluate(() => window.__packed_consumer_result__);
        assert.equal(result.ok, true, `${scenario.mode} packaged browser consumer failed: ${result.error ?? errors.join('\n')}`);
        assert.equal(result.mode, scenario.mode);
        assert.equal(result.cancelled, scenario.cancel);
        assert.ok(result.workerUrl.includes('archive-worker'), `unexpected worker URL: ${result.workerUrl}`);
        assert.deepEqual(result.frames, { pilot: 4, ground: 2 });
        assert.ok(result.archiveRequests > 0, `${scenario.mode} never fetched a ZIP archive`);
        if (scenario.mode === 'mixed') assert.ok(result.fileRequests > 0, 'mixed mode never fetched a loose file');
        else assert.equal(result.fileRequests, 0, 'zip mode fetched a loose file outside the archives');
        assert.equal(errors.length, 0, `${scenario.mode} packaged browser console errors: ${errors.join('\n')}`);
        completed = true;
      } catch (error) {
        await page.screenshot({ path: join(evidenceRoot, `${scenario.mode}-failure.png`), fullPage: true }).catch(() => undefined);
        throw error;
      } finally {
        if (traceStarted) {
          await context.tracing.stop({
            ...(completed ? {} : { path: join(evidenceRoot, `${scenario.mode}-failure-trace.zip`) }),
          }).catch(() => undefined);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

try {
  mkdirSync(consumerRoot, { recursive: true });
  const cliTarball = packageTarball('packages/cli');
  const assetsTarball = packageTarball('packages/phaser-assets');
  const examplePackage = JSON.parse(readFileSync(join(exampleRoot, 'package.json'), 'utf8'));
  const sourceCliPackage = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  const expectedCliDependencyVersions = Object.entries(sourceCliPackage.dependencies)
    .filter(([, spec]) => !spec.startsWith('workspace:'))
    .map(([name]) => {
      const manifestPath = join(repoRoot, 'packages/cli/node_modules', name, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(`Missing ${manifestPath}; run a full 'pnpm install' at the repo root before test/packed-consumer.mjs.`);
      }
      return [name, JSON.parse(readFileSync(manifestPath, 'utf8')).version];
    });
  cpSync(join(exampleRoot, 'asset-source'), join(consumerRoot, 'src'), { recursive: true });
  writeJson(join(consumerRoot, 'package.json'), {
    name: 'mpgd-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    overrides: Object.fromEntries(expectedCliDependencyVersions),
  });
  for (const mode of ['zip', 'mixed']) writeJson(join(consumerRoot, `${mode}.config.json`), packsConfig(mode));

  const installed = run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
    cliTarball,
    assetsTarball,
    `phaser@${examplePackage.dependencies.phaser}`,
  ], consumerRoot);
  assert.equal(installed.status, 0, `packed consumer install failed: ${installed.stdout}\n${installed.stderr}`);
  const cliPackage = JSON.parse(readFileSync(join(consumerRoot, 'node_modules/@mpgd/cli/package.json'), 'utf8'));
  const assetsPackage = JSON.parse(readFileSync(join(consumerRoot, 'node_modules/@mpgd/phaser-assets/package.json'), 'utf8'));
  assert.equal(cliPackage.dependencies['@mpgd/phaser-assets'], assetsPackage.version);
  assert.ok(!JSON.stringify(cliPackage).includes('workspace:'), 'CLI tarball retained a workspace dependency');
  assert.ok(!JSON.stringify(assetsPackage).includes('workspace:'), 'phaser-assets tarball retained a workspace dependency');
  for (const [name, expectedVersion] of expectedCliDependencyVersions) {
    const installedManifestPath = [
      join(consumerRoot, 'node_modules', name, 'package.json'),
      join(consumerRoot, 'node_modules/@mpgd/cli/node_modules', name, 'package.json'),
    ].find((path) => existsSync(path));
    assert.ok(installedManifestPath, `installed CLI dependency is missing: ${name}`);
    const installedVersion = JSON.parse(readFileSync(installedManifestPath, 'utf8')).version;
    assert.equal(installedVersion, expectedVersion, `${name} resolved outside the repository lock state`);
  }

  const cliBin = join(consumerRoot, 'node_modules/@mpgd/cli', cliPackage.bin?.mpgd ?? './dist/bin.js');
  for (const mode of ['zip', 'mixed']) {
    const built = runInstalledCli(consumerRoot, cliBin, [
      'assets',
      'build-packs',
      '--config',
      `${mode}.config.json`,
      '--out',
      `out-${mode}`,
    ]);
    assert.equal(built.status, 0, `installed CLI build-packs failed for ${mode}: ${built.stdout}\n${built.stderr}`);
    const report = verifyDelivery(consumerRoot, cliBin, `out-${mode}`, 0);
    assert.equal(report.ok, true);
  }

  const corruptRoot = join(consumerRoot, 'out-corrupt');
  cpSync(join(consumerRoot, 'out-zip'), corruptRoot, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(corruptRoot, 'asset-pack-delivery.json'), 'utf8'));
  const zipPack = manifest.packs.find((pack) => pack.delivery === 'zip');
  assert.ok(zipPack?.archive, 'delivery manifest has no zip pack with an archive');
  const archive = zipPack.archive.path;
  const corrupted = Buffer.from(readFileSync(join(corruptRoot, archive)));
  corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
  writeFileSync(join(corruptRoot, archive), corrupted);
  const corruptReport = verifyDelivery(consumerRoot, cliBin, 'out-corrupt', 1);
  assert.equal(corruptReport.ok, false);

  mkdirSync(join(webRoot, 'public/delivery'), { recursive: true });
  cpSync(join(consumerRoot, 'out-zip'), join(webRoot, 'public/delivery/zip'), { recursive: true });
  cpSync(join(consumerRoot, 'out-mixed'), join(webRoot, 'public/delivery/mixed'), { recursive: true });
  mkdirSync(join(webRoot, 'src'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><html><body><div id="game"></div><script type="module" src="/src/main.js"></script></body></html>\n');
  writeFileSync(join(webRoot, 'src/main.js'), appSource());
  const webBuild = run(process.execPath, [
    join(exampleRoot, 'node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    'dist',
    '--logLevel',
    'warn',
  ], webRoot);
  assert.equal(webBuild.status, 0, `consumer Vite build failed: ${webBuild.stdout}\n${webBuild.stderr}`);
  assert.ok(existsSync(join(webDist, 'index.html')));
  const server = await staticServer(webDist, {
    gate: { prefix: '/delivery/zip/packs/', releasePath: '/__packed-consumer/release' },
  });
  const serverUrl = server.url;
  try {
    await runBrowser(serverUrl);
  } finally {
    await server.close();
  }
  console.info('Packaged asset consumer checks passed: installed CLI build-packs/verify-delivery, corrupt ZIP rejection, package-only Vite imports, module Worker decode, files+ZIP delivery, cancellation re-entry, Phaser frames and texture/staging cleanup.');
} finally {
  rmSync(fixtureRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}

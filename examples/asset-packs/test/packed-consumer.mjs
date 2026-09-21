import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(exampleRoot, '..', '..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-packed-consumer-'));
const consumerRoot = join(fixtureRoot, 'consumer');
const tarballRoot = join(fixtureRoot, 'tarballs');
const webRoot = join(consumerRoot, 'web');
const webDist = join(webRoot, 'dist');

function fileURLToPath(url) {
  return decodeURIComponent(new URL(url).pathname);
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.error) throw result.error;
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
  return {
    root: 'src',
    packs: [
      {
        id: 'shared',
        revision: '1',
        delivery: delivery === 'mixed' ? 'files' : 'zip',
        assets: [{
          kind: 'spritesheet',
          key: 'pilot',
          file: 'pilot.png',
          frameConfig: { frameWidth: 64, frameHeight: 64 },
        }],
      },
      {
        id: 'grove',
        revision: '1',
        dependsOn: ['shared'],
        delivery: 'zip',
        assets: [{ kind: 'atlas', key: 'ground', texture: 'grove.png', atlas: 'grove.json' }],
      },
      {
        id: 'dunes',
        revision: '1',
        dependsOn: ['shared'],
        delivery: 'zip',
        assets: [{ kind: 'image', key: 'ground', file: 'dunes.png' }],
      },
    ],
  };
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
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.ok, 'boolean');
  return report;
}

function createConsumerServer(directory) {
  let slowZipArtifacts = true;
  const waiters = new Set();
  const types = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
  };
  let root;
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (path === '/__packed-consumer/release') {
      slowZipArtifacts = false;
      for (const resolveWaiter of waiters) resolveWaiter();
      waiters.clear();
      response.writeHead(204).end();
      return;
    }
    if (slowZipArtifacts && path.startsWith('/delivery/zip/packs/')) {
      await Promise.race([
        new Promise((resolveWaiter) => waiters.add(resolveWaiter)),
        delay(10_000),
      ]);
      if (response.destroyed) return;
    }
    try {
      const candidate = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = readFileSync(candidate);
      response.setHeader('Content-Type', types[extname(candidate)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      if (!response.destroyed) response.writeHead(404).end('Not found');
    }
  });
  return {
    async listen() {
      root = await realpath(directory);
      await new Promise((yes, no) => {
        server.once('error', no);
        server.listen(0, '127.0.0.1', yes);
      });
      return `http://127.0.0.1:${server.address().port}/`;
    },
    async close() {
      for (const resolveWaiter of waiters) resolveWaiter();
      waiters.clear();
      server.closeAllConnections();
      await new Promise((yes, no) => server.close((error) => error ? no(error) : yes()));
    },
  };
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
  let delivery;
  delivery = createPhaserPackDelivery(manifest, {
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
  try {
    for (const scenario of [{ mode: 'zip', cancel: true }, { mode: 'mixed', cancel: false }]) {
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
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
      assert.equal(errors.length, 0, `${scenario.mode} packaged browser console errors: ${errors.join('\n')}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  mkdirSync(consumerRoot, { recursive: true });
  const cliTarball = packageTarball('packages/cli');
  const assetsTarball = packageTarball('packages/phaser-assets');
  cpSync(join(exampleRoot, 'asset-source'), join(consumerRoot, 'src'), { recursive: true });
  writeJson(join(consumerRoot, 'package.json'), {
    name: 'mpgd-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  });
  for (const mode of ['zip', 'mixed']) writeJson(join(consumerRoot, `${mode}.config.json`), packsConfig(mode));

  const installed = run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
    cliTarball,
    assetsTarball,
    'phaser@4.2.0',
  ], consumerRoot);
  assert.equal(installed.status, 0, `packed consumer install failed: ${installed.stdout}\n${installed.stderr}`);
  const cliPackage = JSON.parse(readFileSync(join(consumerRoot, 'node_modules/@mpgd/cli/package.json'), 'utf8'));
  const assetsPackage = JSON.parse(readFileSync(join(consumerRoot, 'node_modules/@mpgd/phaser-assets/package.json'), 'utf8'));
  assert.equal(cliPackage.dependencies['@mpgd/phaser-assets'], assetsPackage.version);
  assert.ok(!JSON.stringify(cliPackage).includes('workspace:'), 'CLI tarball retained a workspace dependency');
  assert.ok(!JSON.stringify(assetsPackage).includes('workspace:'), 'phaser-assets tarball retained a workspace dependency');

  const cliBin = join(consumerRoot, 'node_modules/@mpgd/cli/dist/bin.js');
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
  const archive = manifest.packs.find((pack) => pack.delivery === 'zip').archive.path;
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
  const server = createConsumerServer(webDist);
  const serverUrl = await server.listen();
  try {
    await runBrowser(serverUrl);
  } finally {
    await server.close();
  }
  console.info('Packaged asset consumer checks passed: installed CLI build-packs/verify-delivery, corrupt ZIP rejection, package-only Vite imports, module Worker decode, files+ZIP delivery, cancellation re-entry, Phaser frames and texture/staging cleanup.');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

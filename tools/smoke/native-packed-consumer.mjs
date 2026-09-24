import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-native-packed-'));
const packRoot = join(fixtureRoot, 'packs');
const consumerRoot = join(fixtureRoot, 'consumer');
const entryPackages = [
  '@mpgd/adapter-capacitor',
  '@mpgd/capacitor-game-services',
  '@mpgd/game-services',
  '@mpgd/platform',
  '@mpgd/cli',
];

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed in ${cwd}`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout ?? '';
}

function workspacePackages() {
  const packages = new Map();
  for (const root of ['packages', 'adapters', 'native-plugins']) {
    for (const name of readdirSync(join(repoRoot, root))) {
      const directory = join(repoRoot, root, name);
      const manifestPath = join(directory, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name?.startsWith('@mpgd/')) {
        packages.set(manifest.name, { directory, manifest });
      }
    }
  }
  return packages;
}

function packageClosure(packages) {
  const selected = new Map();
  function visit(name) {
    if (selected.has(name)) return;
    const entry = packages.get(name);
    assert.ok(entry, `Workspace package ${name} is missing`);
    assert.notEqual(entry.manifest.private, true, `${name} is not publishable`);
    selected.set(name, entry);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (dependency.startsWith('@mpgd/')) visit(dependency);
    }
  }
  for (const name of entryPackages) visit(name);
  return selected;
}

function packPackages(selected) {
  const packed = new Map();
  for (const [name, entry] of selected) {
    assert.ok(existsSync(join(entry.directory, 'dist/index.js')), `${name} is not built`);
    assert.ok(existsSync(join(entry.directory, 'dist/index.d.ts')), `${name} types are not built`);
    const destination = join(packRoot, name.replaceAll('/', '_'));
    mkdirSync(destination, { recursive: true });
    run('pnpm', ['--dir', entry.directory, 'pack', '--silent', '--pack-destination', destination], repoRoot);
    const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `${name} must produce exactly one tarball`);
    packed.set(name, join(destination, tarballs[0]));
  }
  return packed;
}

function verifyNativeTarball(tarball) {
  const entries = new Set(run('tar', ['-tzf', tarball], repoRoot).trim().split('\n'));
  for (const required of [
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/Package.swift',
    'package/android/src/main/AndroidManifest.xml',
    'package/android/src/main/java/dev/mpgd/capacitor/CapacitorGameServicesPlugin.java',
    'package/android/src/main/java/dev/mpgd/capacitor/LocalJsonStorage.java',
    'package/android/src/main/java/dev/mpgd/capacitor/SecureCredentialStorage.java',
    'package/ios/Sources/CapacitorGameServices/CapacitorGameServicesPlugin.swift',
    'package/ios/Sources/CapacitorGameServices/LocalJsonStorage.swift',
    'package/ios/Sources/CapacitorGameServices/SecureCredentialStorage.swift',
    'package/ios/Sources/CapacitorGameServices/PrivacyInfo.xcprivacy',
  ]) {
    assert.ok(entries.has(required), `Published native plugin is missing ${required}`);
  }
  const packageSwift = run('tar', ['-xOf', tarball, 'package/Package.swift'], repoRoot);
  assert.match(packageSwift, /\.process\("PrivacyInfo\.xcprivacy"\)/u);
  const privacy = run('tar', ['-xOf', tarball,
    'package/ios/Sources/CapacitorGameServices/PrivacyInfo.xcprivacy'], repoRoot);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults/u);
  assert.match(privacy, /CA92\.1/u);
  const java = run('tar', ['-xOf', tarball,
    'package/android/src/main/java/dev/mpgd/capacitor/CapacitorGameServicesPlugin.java'], repoRoot);
  assert.match(java, /@CapacitorPlugin\(name = "CapacitorGameServices"\)/u);
  const swift = run('tar', ['-xOf', tarball,
    'package/ios/Sources/CapacitorGameServices/CapacitorGameServicesPlugin.swift'], repoRoot);
  assert.match(swift, /@objc\(CapacitorGameServicesPlugin\)/u);
  const js = run('tar', ['-xOf', tarball, 'package/dist/index.js'], repoRoot);
  assert.match(js, /registerPlugin\(['"]CapacitorGameServices['"]\)/u);
  const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], repoRoot));
  assert.equal(manifest.capacitor.android.src, 'android');
  assert.equal(manifest.capacitor.ios.src, 'ios');
}

function writeConsumer(packed) {
  mkdirSync(consumerRoot, { recursive: true });
  const overrides = Object.fromEntries([...packed].map(([name, file]) => [name, `file:${file}`]));
  const dependencies = Object.fromEntries(entryPackages.map((name) => [name, overrides[name]]));
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'mpgd-native-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      ...dependencies,
      '@capacitor/core': '8.5.2',
      '@capacitor/app': '8.1.1',
    },
    devDependencies: {
      ttsc: '0.30.4',
      typescript: '7.0.2',
      vite: '8.1.3',
    },
  }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'allowBuilds:',
    '  esbuild: true',
    'overrides:',
    ...Object.entries(overrides).map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}`),
    '',
  ].join('\n'));
  writeFileSync(join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    files: ['consumer.ts'],
  }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, 'consumer.ts'), `
import { createCapacitorNativeJsonTransport, createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import type { GameServicesBackendTransport } from '@mpgd/game-services/client';
import type { PlatformGateway } from '@mpgd/platform';

const gateway: PlatformGateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1.0.0', buildId: 'packed', visibility: null,
});
const transport: GameServicesBackendTransport = createCapacitorNativeJsonTransport({
  target: 'android', baseUrl: 'https://api.example.com',
  allowedOrigin: 'https://api.example.com',
});
const runtime = createGameServicesRuntime({
  gateway, playerId: 'guest', authorityMode: 'production',
  baseUrl: 'https://api.example.com', httpTransport: transport,
});
if (runtime.mode !== 'http') throw new Error('Packed runtime lost native transport injection');
void gateway.storage.load({ key: 'slot' });
void gateway.lifecycle.onPause(() => {});
`);
  writeFileSync(join(consumerRoot, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createCapacitorNativeJsonTransport, createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';
import { CapacitorGameServices } from '@mpgd/capacitor-game-services';

assert.ok(CapacitorGameServices);
const listeners = new Map();
const app = {
  async addListener(name, callback) {
    listeners.set(name, callback);
    return { async remove() { listeners.delete(name); } };
  },
  async getState() { return { isActive: true }; },
  async getLaunchUrl() { return null; },
  async exitApp() {},
};
const storage = new Map();
const bridge = {
  async request({ id, method, payload }) {
    let data;
    if (method === 'runtime.getCapabilities') data = {};
    else if (method === 'storage.save') {
      storage.set(payload.key, payload.value);
      data = { saved: true };
    } else if (method === 'storage.load') {
      data = storage.has(payload.key)
        ? { __mpgdBridgeProtocol: 'mpgd.storage.load.v1', found: true, value: storage.get(payload.key) }
        : { __mpgdBridgeProtocol: 'mpgd.storage.load.v1', found: false };
    } else if (method === 'leaderboard.submitScore') data = { submitted: true };
    else throw new Error('Unexpected bridge method: ' + method);
    return { id, ok: true, data };
  },
};
const gateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1.0.0', buildId: 'packed',
  app, visibility: null, bridge,
});
const capabilities = await gateway.getCapabilities();
for (const feature of ['nativeIap', 'subscriptionIap', 'rewardedAds', 'bannerAds', 'nativeLeaderboard']) {
  assert.equal(capabilities.providerAvailability[feature], 'unsupported', feature);
}
const unconfiguredGateway = createCapacitorPlatformGateway({
  target: 'android', appVersion: '1.0.0', buildId: 'packed',
  app, visibility: null, bridge,
  providers: [{
    id: 'banner-test', features: ['bannerAds'],
    methods: ['ads.mountBanner', 'ads.unmountBanner'],
    bridge: { async request() { throw new Error('Unconfigured provider was called'); } },
    async getAvailability() { return { bannerAds: 'configuration-required' }; },
  }],
});
const unconfigured = await unconfiguredGateway.getCapabilities();
assert.equal(unconfigured.providerAvailability.bannerAds, 'configuration-required');
assert.equal(unconfigured.bannerAds, false);
await assert.rejects(() => unconfiguredGateway.ads.mountBanner({ surfaceId: 'banner' }),
  (error) => error?.code === 'NATIVE_PROVIDER_CONFIGURATION_REQUIRED');
await unconfiguredGateway.lifecycle.dispose();
await gateway.storage.save({ key: 'slot', value: { score: 7 } });
assert.deepEqual(await gateway.storage.load({ key: 'slot' }), { value: { score: 7 } });
let paused = 0;
let resumed = 0;
gateway.lifecycle.onPause(() => { paused += 1; });
gateway.lifecycle.onResume(() => { resumed += 1; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(listeners.has('appStateChange'), 'packed adapter registered native lifecycle listener');
listeners.get('appStateChange')({ isActive: false });
listeners.get('appStateChange')({ isActive: true });
assert.equal(paused, 1);
assert.equal(resumed, 1);
const calls = [];
const transport = createCapacitorNativeJsonTransport({
  target: 'android', baseUrl: 'https://api.example.com',
  allowedOrigin: 'https://api.example.com', getPlatform: () => 'android',
  http: { async request(options) {
    calls.push(options);
    return {
      status: 200, url: options.url,
      data: { submitted: true, ledgerEntryId: 'entry-1', alreadyProcessed: false, rank: 1 },
    };
  } },
});
const runtime = createGameServicesRuntime({
  gateway, playerId: 'guest', authorityMode: 'production',
  baseUrl: 'https://api.example.com', httpTransport: transport,
});
assert.equal(runtime.mode, 'http');
assert.ok(runtime.client);
const score = await runtime.client.submitLeaderboardScore({
  leaderboardId: 'board', score: 7, runId: 'run-1', submittedAt: new Date().toISOString(),
});
assert.equal(score.ledgerEntryId, 'entry-1');
assert.equal(calls.length, 1);
assert.equal(calls[0].url, 'https://api.example.com/game-services/leaderboard/record');
await gateway.lifecycle.dispose();
assert.equal(listeners.size, 0);
console.log('Packed native JS, storage, lifecycle, and transport consumer passed.');
`);
  writeFileSync(join(consumerRoot, 'index.html'), [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"></head><body>',
    '<script type="module" src="/main.js"></script>',
    '</body></html>',
    '',
  ].join('\n'));
  writeFileSync(join(consumerRoot, 'main.js'), [
    "import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';",
    "import { createGameServicesRuntime } from '@mpgd/game-services/runtime';",
    'document.body.dataset.packedNative =',
    "  String(typeof createCapacitorPlatformGateway === 'function'",
    "    && typeof createGameServicesRuntime === 'function');",
    '',
  ].join('\n'));
}

try {
  const selected = packageClosure(workspacePackages());
  const packed = packPackages(selected);
  verifyNativeTarball(packed.get('@mpgd/capacitor-game-services'));
  writeConsumer(packed);
  run('pnpm', ['install', '--no-frozen-lockfile'], consumerRoot);
  const lockfile = readFileSync(join(consumerRoot, 'pnpm-lock.yaml'), 'utf8');
  for (const [name, tarball] of packed) {
    assert.ok(lockfile.includes(basename(tarball)), `${name} resolved outside the local tarball set`);
  }
  run('pnpm', ['exec', 'ttsc', '--noEmit', '-p', 'tsconfig.json'], consumerRoot);
  run('node', ['consumer.mjs'], consumerRoot);
  run('pnpm', ['exec', 'vite', 'build'], consumerRoot);
  assert.ok(existsSync(join(consumerRoot, 'dist/index.html')), 'External packed Vite build is missing');
  run('pnpm', ['exec', 'mpgd', '--help'], consumerRoot);
  console.log(`Packed native consumer passed with ${packed.size} unpublished local tarballs.`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

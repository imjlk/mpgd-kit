import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { resolveNativeCommandLaunch } from '../../packages/cli/dist/command-launcher.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const template = process.env.MPGD_WINDOWS_SMOKE_TEMPLATE ?? 'phaser';
assert.ok(['phaser', 'lite'].includes(template), `Unsupported starter template: ${template}`);
const outputRoot = process.env.MPGD_WINDOWS_SMOKE_ROOT
  ? resolve(process.env.MPGD_WINDOWS_SMOKE_ROOT)
  : mkdtempSync(join(tmpdir(), 'mpgd-windows-starter-'));
// Exercise quoted paths as well as Windows process launching.
const gameRoot = join(outputRoot, 'path with spaces', 'game');
const packRoot = join(outputRoot, 'path with spaces', 'packs');
mkdirSync(packRoot, { recursive: true });
console.log(`Windows starter consumer evidence: ${outputRoot}`);

function run(command, args, cwd = repoRoot, environment = process.env) {
  const launch = resolveNativeCommandLaunch({ command, args, environment });
  console.log(`Running ${command} ${args.join(' ')} in ${cwd}`);
  const result = spawnSync(launch.command, [...launch.args], {
      cwd, env: environment, encoding: 'utf8', timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  const log = `${command} ${args.join(' ')}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`;
  appendFileSync(join(outputRoot, 'commands.log'), log);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, log);
  return result;
}

run(process.execPath, [join(repoRoot, 'packages/cli/dist/bin.js'),
  'game', 'create', gameRoot, '--kit-path', repoRoot, '--microsoft-store',
  ...(template === 'lite' ? ['--template', 'lite', '--workspace'] : [])]);
if (template === 'lite') {
  const manifest = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@mpgd/lite-shell'], 'workspace:*');
  assert.equal(manifest.dependencies.phaser, undefined, 'Lite consumer must not depend on Phaser');
}

// Install the current PR's publishable artifacts, without workspace links or
// depending on their versions already existing in the public registry.
// lite-shell is private: exercise its supported workspace consumer instead.
const overrides = [];
for (const root of template === 'lite' ? [] : ['packages', 'adapters', 'native-plugins', 'backend']) {
  if (!existsSync(join(repoRoot, root))) continue;
  for (const entry of readdirSync(join(repoRoot, root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(repoRoot, root, entry.name);
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private || !manifest.name.startsWith('@mpgd/')) continue;
    run('pnpm', ['--dir', packageRoot, 'pack', '--silent', '--pack-destination', packRoot]);
    const tarball = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
    assert.ok(existsSync(join(packRoot, tarball)), `Missing tarball: ${tarball}`);
    overrides.push(`  '${manifest.name}': 'file:../packs/${tarball}'`);
  }
}
appendFileSync(join(gameRoot, 'pnpm-workspace.yaml'), `${overrides.join('\n')}\n`);
run('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
// A second frozen install checks that the standalone lockfile is usable.
run('pnpm', ['install', '--frozen-lockfile'], gameRoot);
const requireFromGame = createRequire(join(gameRoot, 'package.json'));
const nativeTools = await import(pathToFileURL(requireFromGame.resolve('@mpgd/cli/windows-native-tools')).href);
const nativeModule = nativeTools.getMicrosoftStoreNativeAcceptanceModulePath();
const nativeToolingRoot = join(outputRoot, 'native', 'native-tooling');
mkdirSync(nativeToolingRoot, { recursive: true });
copyFileSync(nativeModule, join(nativeToolingRoot, 'WindowsMsixAcceptance.psm1'));
cpSync(nativeTools.getMicrosoftStoreNativeHostSourceDirectory(), join(nativeToolingRoot, 'windows-host'), { recursive: true });
run('pnpm', ['check'], gameRoot);
const acceptanceHelp = run('pnpm', ['accept', '--help'], gameRoot);
assert.match(acceptanceHelp.stdout, /mpgd game accept/, 'Installed starter must run application help through ttsx');
run('pnpm', ['build'], gameRoot);
assert.ok(existsSync(join(gameRoot, 'dist/index.html')), 'Missing web entry point');
assert.ok(existsSync(join(gameRoot, 'dist/assets/game.js')), 'Missing web game bundle');
run('git', ['init', '-q'], gameRoot);
run('git', ['add', '.'], gameRoot);
run('git', ['-c', 'user.name=mpgd-ci', '-c', 'user.email=mpgd-ci@example.invalid',
  'commit', '-qm', 'Windows starter fixture'], gameRoot);
// The Windows job already built packages; match the other prepared target CI
// jobs instead of repeating the repository-wide preflight and package build.
run('pnpm', ['build:microsoft-store'], gameRoot, {
  ...process.env,
  MPGD_SKIP_BUILD_TARGET_PREFLIGHT: '1',
});
run('pnpm', ['smoke:microsoft-store'], gameRoot);
// Add a CI-only native bridge probe after the PWA acceptance has finished.
// Resolve its public web client from this standalone consumer's installed package.
const fixtureEntry = join(gameRoot, '.native-bridge-fixture.mjs');
copyFileSync(join(repoRoot, 'tools/smoke/windows-native/bridge-fixture.mjs'), fixtureEntry);
buildSync({
  entryPoints: [fixtureEntry], bundle: true, platform: 'browser', format: 'esm',
  outfile: join(gameRoot, 'dist/native-bridge-fixture.js'),
});
writeFileSync(join(outputRoot, 'result.json'), `${JSON.stringify({
  platform: process.platform,
  template,
  dependencyMode: template === 'lite' ? 'workspace' : 'packed',
  node: process.version,
  checks: ['create', `${template === 'lite' ? 'workspace' : 'packed'}-install`, 'frozen-install', 'consumer-native-tooling', 'typecheck', 'web-build',
    'microsoft-store-pwa-build', 'microsoft-store-pwa-smoke'],
  scope: 'KIT generated consumer and Microsoft Store PWA; CI packages this game in a WinUI host for native x64/ARM64 launch checks.',
}, null, 2)}\n`);
console.log('Windows starter and Microsoft Store PWA consumer: passed');

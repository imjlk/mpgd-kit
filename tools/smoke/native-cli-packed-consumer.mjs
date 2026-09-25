import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-native-cli-consumer-'));
const packRoot = join(fixtureRoot, 'packs');
const gameRoot = join(fixtureRoot, 'game');
const syncIos = process.argv.includes('--sync-ios');

function run(command, args, cwd, env = process.env, timeout = 300_000) {
  const pnpmScript = command === 'pnpm' && process.platform === 'win32'
    ? process.env.npm_execpath
    : undefined;
  if (command === 'pnpm' && process.platform === 'win32') {
    assert.match(pnpmScript ?? '', /\.[cm]?js$/u,
      'On Windows, launch this smoke through pnpm.');
  }
  const executable = pnpmScript === undefined ? command : process.execPath;
  const commandArgs = pnpmScript === undefined ? args : [pnpmScript, ...args];
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  return result;
}

function mustRun(command, args, cwd, env = process.env, timeout = 300_000) {
  const result = run(command, args, cwd, env, timeout);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed in ${cwd}`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout ?? '';
}

try {
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(gameRoot, { recursive: true });
  mustRun('pnpm', [
    '--dir', join(repoRoot, 'packages/cli'), 'pack', '--silent', '--pack-destination', packRoot,
  ], repoRoot);
  const tarballs = readdirSync(packRoot).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'expected one @mpgd/cli tarball');
  const tarball = join(packRoot, tarballs[0]);
  const adapterVersion = JSON.parse(readFileSync(
    join(repoRoot, 'adapters/capacitor/package.json'), 'utf8',
  )).version;
  writeFileSync(join(gameRoot, 'package.json'), `${JSON.stringify({
    name: 'mpgd-external-native-consumer',
    private: true,
    version: '1.2.3',
    type: 'module',
    dependencies: {
      '@capacitor/app': '8.1.1',
      '@capacitor/core': '8.5.2',
      '@mpgd/adapter-capacitor': adapterVersion,
    },
    devDependencies: {
      '@capacitor/cli': '8.5.2',
      '@mpgd/cli': `file:${tarball}`,
      vite: '8.1.3',
    },
  }, null, 2)}\n`);
  writeFileSync(join(gameRoot, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    "  - 'apps/*'",
    'allowBuilds:',
    '  esbuild: true',
    '  sharp: true',
    '',
  ].join('\n'));
  writeFileSync(join(gameRoot, '.gitignore'), [
    'node_modules/', 'dist/', 'artifacts/', 'release-output/',
    '.mpgd.targets.generated.json', 'apps/*/node_modules/', '',
  ].join('\n'));
  writeFileSync(join(gameRoot, 'index.html'), [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"></head>',
    '<body><div id="game">external native consumer</div></body></html>',
    '',
  ].join('\n'));
  mkdirSync(join(gameRoot, 'public'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/cli/templates/phaser-game/public/icon.svg'),
    join(gameRoot, 'public/icon.svg'),
  );
  copyFileSync(
    join(repoRoot, 'packages/cli/templates/phaser-game/mpgd.game.json'),
    join(gameRoot, 'mpgd.game.json'),
  );
  copyFileSync(join(repoRoot, 'packages/catalog/catalog.json'), join(gameRoot, 'mpgd.catalog.json'));
  copyFileSync(
    join(repoRoot, 'packages/catalog/placements.json'),
    join(gameRoot, 'mpgd.ad-placements.json'),
  );
  writeFileSync(join(gameRoot, 'mpgd.targets.json'), `${JSON.stringify({
    targets: {
      android: {
        kind: 'capacitor-android',
        gameApp: '.',
        shellApp: 'apps/mobile-capacitor',
        webDir: 'apps/mobile-capacitor/www',
        adapter: 'capacitor',
        artifact: 'aab',
        icon: { profile: 'android' },
        metadata: { appName: 'External Game', packageId: 'dev.mpgd.externalgame' },
      },
      ios: {
        kind: 'capacitor-ios',
        gameApp: '.',
        shellApp: 'apps/mobile-capacitor',
        webDir: 'apps/mobile-capacitor/www',
        adapter: 'capacitor',
        artifact: 'ipa',
        icon: { profile: 'ios' },
        metadata: { appName: 'External Game', bundleId: 'dev.mpgd.externalgame' },
      },
    },
  }, null, 2)}\n`);
  mustRun('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
  const cliDist = join(gameRoot, 'node_modules/@mpgd/cli/dist');
  const ascPin = JSON.parse(readFileSync(join(cliDist, 'asc-pin.json'), 'utf8'));
  assert.equal(ascPin.version, '5.5.0');
  assert.equal(existsSync(join(cliDist, 'ios-ipa-inspection.js')), true);
  const installedCli = await import(pathToFileURL(join(cliDist, 'index.js')).href);
  assert.equal(typeof installedCli.submitVerifiedIosBuild, 'function');
  mustRun('git', ['init', '-q'], gameRoot);
  mustRun('git', ['add', '.'], gameRoot);
  mustRun('git', [
    '-c', 'user.name=mpgd-test', '-c', 'user.email=mpgd-test@example.invalid',
    'commit', '-qm', 'external game fixture',
  ], gameRoot);
  const env = { ...process.env };
  delete env.MPGD_KIT_PATH;
  delete env.MPGD_NATIVE_BUILD_MODE;
  const result = run('pnpm', [
    'exec', 'mpgd', 'target', 'build', 'ios', 'production',
    '--targets-file', join(gameRoot, 'mpgd.targets.json'),
  ], gameRoot, env);
  assert.notEqual(result.status, 0, 'production build without an explicit mode must fail');
  assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    /Production native builds require an explicit MPGD_NATIVE_BUILD_MODE/u);
  assert.doesNotMatch(`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    /Could not detect an mpgd-kit checkout|Expected an mpgd-kit checkout/u);
  const installedInfo = JSON.parse(readFileSync(join(
    gameRoot, 'node_modules/@mpgd/cli/dist/native-build-info.json',
  ), 'utf8'));
  assert.match(installedInfo.kitGitSha, /^[0-9a-f]{40}$/u);
  assert.equal(installedInfo.kitDirty, false, 'packed native builds require a clean Kit commit');
  assert.equal(existsSync(join(gameRoot, '.mpgd.targets.generated.json')), true);

  const invalidTargets = JSON.parse(readFileSync(join(gameRoot, 'mpgd.targets.json'), 'utf8'));
  invalidTargets.targets.ios.shellApp = '${MPGD_GAME_ROOT}/../outside-shell';
  const invalidTargetsFile = join(gameRoot, 'mpgd.invalid.targets.json');
  writeFileSync(invalidTargetsFile, `${JSON.stringify(invalidTargets, null, 2)}\n`);
  const escapedShell = run('pnpm', [
    'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
    '--targets-file', invalidTargetsFile,
  ], gameRoot, env);
  assert.notEqual(escapedShell.status, 0, 'a shell outside the game must be rejected');
  assert.match(`${escapedShell.stdout ?? ''}\n${escapedShell.stderr ?? ''}`,
    /shellApp must stay inside its game project/u);
  if (process.platform !== 'win32') {
    const linkedShell = join(gameRoot, 'linked-shell');
    symlinkSync(fixtureRoot, linkedShell, 'dir');
    invalidTargets.targets.ios.shellApp = 'linked-shell/not-created-yet';
    writeFileSync(invalidTargetsFile, `${JSON.stringify(invalidTargets, null, 2)}\n`);
    const symlinkEscape = run('pnpm', [
      'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
      '--targets-file', invalidTargetsFile,
    ], gameRoot, env);
    assert.notEqual(symlinkEscape.status, 0, 'a symlink ancestor outside the game must be rejected');
    assert.match(`${symlinkEscape.stdout ?? ''}\n${symlinkEscape.stderr ?? ''}`,
      /shellApp must stay inside its game project/u);
    unlinkSync(linkedShell);
  }

  if (syncIos) {
    if (process.platform !== 'darwin') {
      throw new Error('--sync-ios requires a macOS host.');
    }
    mustRun('pnpm', [
      'exec', 'mpgd', 'target', 'init', 'capacitor',
      '--game', gameRoot,
      '--app-id', 'dev.mpgd.externalgame',
      '--display-name', 'External Game',
    ], gameRoot);
    mustRun('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
    mustRun('git', ['add', '.'], gameRoot);
    mustRun('git', [
      '-c', 'user.name=mpgd-test', '-c', 'user.email=mpgd-test@example.invalid',
      'commit', '-qm', 'game-owned shell',
    ], gameRoot);
    mustRun('pnpm', [
      'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
      '--targets-file', join(gameRoot, 'mpgd.targets.json'),
    ], gameRoot, { ...env, MPGD_NATIVE_BUILD_MODE: 'sync' }, 600_000);
    const manifest = JSON.parse(readFileSync(
      join(gameRoot, 'artifacts/release-manifest.json'), 'utf8',
    ));
    assert.equal(manifest.kitGitSha, installedInfo.kitGitSha);
    assert.ok(manifest.targets?.ios);
    assert.ok(existsSync(join(gameRoot, manifest.targets.ios.artifact)));
    mustRun('pnpm', ['exec', 'mpgd', 'deploy', 'init', '--game', gameRoot], gameRoot);
    const deployPlanFile = join(gameRoot, 'release-plan.json');
    mustRun('pnpm', [
      'exec', 'mpgd', 'deploy', 'plan', '--game', gameRoot,
      '--profile', 'beta', '--targets', 'android', '--out', deployPlanFile,
    ], gameRoot);
    const deployPlan = JSON.parse(readFileSync(deployPlanFile, 'utf8'));
    assert.equal(deployPlan.targets[0]?.target, 'android');
    assert.equal(deployPlan.targets[0]?.appId, 'dev.mpgd.externalgame');
    assert.equal(JSON.stringify(deployPlan).includes('MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT'), false);
  }
  console.info(`External @mpgd/cli native ${syncIos ? 'iOS sync' : 'validation'} passed.`);
} finally {
  if (process.env.MPGD_KEEP_NATIVE_CONSUMER !== '1') {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } else {
    console.info(`Kept external native consumer at ${fixtureRoot}`);
  }
}

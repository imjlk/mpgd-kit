import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const kitRoot = path.resolve('.');
const gameRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-consumer-'));
const shell = path.join(gameRoot, 'apps/mobile-capacitor');

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command} failed to start: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
  return result.stdout ?? '';
}

function assertNoKitReferences(directory: string): void {
  const textFile = /\.(?:gradle|groovy|java|kt|m|h|swift|pbxproj|plist|xml|json|ts|md|properties|sh|txt)$/u;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.gradle'
      || entry.name === 'build' || entry.name === 'Pods') {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assertNoKitReferences(file);
    } else if (entry.isFile() && textFile.test(entry.name) && statSync(file).size < 1_000_000) {
      const contents = readFileSync(file, 'utf8');
      assert.equal(contents.includes(kitRoot), false, `${file} references the kit checkout.`);
      assert.equal(contents.includes('${MPGD_KIT_PATH}'), false, `${file} retains a kit token.`);
    }
  }
}

try {
  writeFileSync(path.join(gameRoot, 'package.json'), `${JSON.stringify({
    name: 'external-capacitor-game',
    private: true,
    version: '0.0.0',
    dependencies: {
      '@capacitor/app': '8.1.1',
      '@capacitor/core': '8.5.2',
      '@mpgd/adapter-capacitor': '0.4.12',
    },
  }, null, 2)}\n`);
  writeFileSync(
    path.join(gameRoot, 'pnpm-workspace.yaml'),
    "packages:\n  - '.'\nallowBuilds:\n  esbuild: true\n",
  );
  writeFileSync(path.join(gameRoot, 'mpgd.targets.json'), `${JSON.stringify({
    targets: {
      android: {
        kind: 'capacitor-android',
        gameApp: '.',
        adapter: 'capacitor',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
      },
      ios: {
        kind: 'capacitor-ios',
        gameApp: '.',
        adapter: 'capacitor',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
      },
    },
  }, null, 2)}\n`);
  run('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
  const packedCli = process.env.MPGD_PACKED_CLI_TARBALL;
  if (packedCli !== undefined) {
    run('pnpm', ['add', '--workspace-root', '--save-dev', path.resolve(packedCli)], gameRoot);
  }
  const command = packedCli === undefined ? 'node' : 'pnpm';
  const prefix = packedCli === undefined
    ? ['tools/run-ttsx.mjs', 'packages/cli/src/bin.ts']
    : ['exec', 'mpgd'];
  const args = [
    ...prefix,
    'target',
    'init',
    'capacitor',
    '--game',
    gameRoot,
    '--app-id',
    'dev.example.externalgame',
    '--display-name',
    'External Game',
  ];
  const first = run(command, args, packedCli === undefined ? kitRoot : gameRoot);
  assert.match(first, /Updated game-owned Capacitor shell/u);
  assert.ok(existsSync(path.join(shell, 'android/app/build.gradle')));
  assert.ok(existsSync(path.join(shell, 'ios/App/App.xcodeproj/project.pbxproj')));
  assertNoKitReferences(shell);
  const targetsBefore = readFileSync(path.join(gameRoot, 'mpgd.targets.json'), 'utf8');
  const manifestBefore = readFileSync(path.join(shell, 'mpgd.native-shell.json'), 'utf8');
  const second = run(command, args, packedCli === undefined ? kitRoot : gameRoot);
  assert.match(second, /0 file\(s\)/u);
  assert.equal(readFileSync(path.join(gameRoot, 'mpgd.targets.json'), 'utf8'), targetsBefore);
  assert.equal(readFileSync(path.join(shell, 'mpgd.native-shell.json'), 'utf8'), manifestBefore);
  assert.doesNotMatch(targetsBefore, /MPGD_KIT_PATH/u);
  console.info('External game-owned Capacitor shell materialization passed.');
} finally {
  rmSync(gameRoot, { recursive: true, force: true });
}

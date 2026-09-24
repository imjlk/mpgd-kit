import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyCapacitorShellStarter,
  materializeCapacitorShellStarter,
  planCapacitorShellStarter,
} from '../src/capacitor-shell-starter.js';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-shell-'));

function writeJson(relative: string, value: unknown): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
}

try {
  writeJson('package.json', {
    name: '@game/puzzle',
    private: true,
    dependencies: { '@capacitor/core': '8.5.2', '@capacitor/app': '8.1.1' },
  });
  writeJson('node_modules/@mpgd/adapter-capacitor/package.json', {
    name: '@mpgd/adapter-capacitor',
    dependencies: { '@mpgd/capacitor-game-services': 'workspace:*' },
  });
  writeJson(
    'node_modules/@mpgd/adapter-capacitor/node_modules/@mpgd/capacitor-game-services/package.json',
    { name: '@mpgd/capacitor-game-services', version: '0.5.4' },
  );
  writeJson('mpgd.targets.json', {
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        gameApp: '.',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
        webDir: '${MPGD_KIT_PATH}/apps/mobile-capacitor/www',
        artifact: 'aab',
        icon: { profile: 'android' },
      },
      ios: {
        kind: 'capacitor-ios',
        adapter: 'capacitor',
        gameApp: '.',
        shellApp: '${MPGD_KIT_PATH}/apps/mobile-capacitor',
        webDir: '${MPGD_KIT_PATH}/apps/mobile-capacitor/www',
        artifact: 'ipa',
        icon: { profile: 'ios' },
      },
    },
  });
  mkdirSync(path.join(root, 'public'));
  writeFileSync(path.join(root, 'public/icon.svg'), '<svg/>');
  const options = {
    gameRoot: root,
    appId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
    iconSource: 'public/icon.svg',
    backendUrl: 'https://api.example.com',
    providerIds: ['game-platform', 'identity', 'identity'],
  } as const;

  const dryRun = planCapacitorShellStarter(options);
  assert.ok(dryRun.changedFiles.includes('mpgd.targets.json'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/capacitor.config.ts'));
  assert.ok(dryRun.changedFiles.includes('apps/mobile-capacitor/www/index.html'));
  assert.equal(existsSync(path.join(root, 'apps/mobile-capacitor')), false);
  applyCapacitorShellStarter(dryRun);

  const targets = readJson('mpgd.targets.json').targets as Record<string, Record<string, unknown>>;
  assert.equal(targets.android?.shellApp, 'apps/mobile-capacitor');
  assert.equal(targets.ios?.webDir, 'apps/mobile-capacitor/www');
  assert.deepEqual(targets.android?.metadata, {
    packageId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
  });
  assert.deepEqual(targets.ios?.metadata, {
    bundleId: 'dev.example.puzzle',
    displayName: 'Puzzle Game',
  });
  assert.deepEqual(targets.android?.icon, {
    profile: 'android',
    source: 'public/icon.svg',
  });
  const shellPackage = readJson('apps/mobile-capacitor/package.json');
  assert.ok(readFileSync(path.join(root, 'apps/mobile-capacitor/www/index.html'), 'utf8')
    .includes('Native shell setup'));
  assert.equal(shellPackage.private, true);
  assert.equal((shellPackage.devDependencies as Record<string, string>).typescript, '7.0.2');
  assert.equal(
    (shellPackage.dependencies as Record<string, string>)['@mpgd/capacitor-game-services'],
    '0.5.4',
  );
  assert.deepEqual(readJson('apps/mobile-capacitor/mpgd.native-shell.json').requestedProviderIds, [
    'game-platform',
    'identity',
  ]);
  assert.equal(
    readFileSync(path.join(root, '.env.production'), 'utf8'),
    'VITE_MPGD_GAME_SERVICES_URL=https://api.example.com\n',
  );

  const repeat = planCapacitorShellStarter(options);
  assert.deepEqual(repeat.changedFiles, []);
  assert.deepEqual(repeat.nativePlatformsToAdd, ['android', 'ios']);
  const omittedSelections = planCapacitorShellStarter({
    gameRoot: root,
    appId: options.appId,
    displayName: options.displayName,
  });
  assert.deepEqual(omittedSelections.changedFiles, []);
  const commands: string[] = [];
  materializeCapacitorShellStarter(repeat, {
    run(command, args, cwd) {
      assert.equal(cwd, realpathSync(root));
      commands.push(`${command} ${args.join(' ')}`);
      if (args.at(-2) === 'add') {
        const platform = String(args.at(-1));
        const sentinel = platform === 'android'
          ? 'android/app/build.gradle'
          : 'ios/App/App.xcodeproj/project.pbxproj';
        const file = path.join(root, 'apps/mobile-capacitor', sentinel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'generated-native-project');
      }
    },
  });
  assert.deepEqual(commands, [
    'pnpm install --no-frozen-lockfile',
    'pnpm --dir apps/mobile-capacitor cap add android',
    'pnpm --dir apps/mobile-capacitor cap add ios',
  ]);
  writeFileSync(path.join(root, 'apps/mobile-capacitor/ios/CustomViewController.swift'), 'custom');
  const withNativeProjects = planCapacitorShellStarter(options);
  assert.deepEqual(withNativeProjects.changedFiles, []);
  assert.deepEqual(withNativeProjects.nativePlatformsToAdd, []);
  const iosProjectFile = path.join(
    root,
    'apps/mobile-capacitor/ios/App/App.xcodeproj/project.pbxproj',
  );
  renameSync(iosProjectFile, `${iosProjectFile}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /ios project is incomplete/u);
  renameSync(`${iosProjectFile}.saved`, iosProjectFile);
  applyCapacitorShellStarter(withNativeProjects);
  assert.equal(
    readFileSync(path.join(root, 'apps/mobile-capacitor/ios/CustomViewController.swift'), 'utf8'),
    'custom',
  );

  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'dev.other.puzzle' }),
    /conflicts|differs/u,
  );
  const configFile = path.join(root, 'apps/mobile-capacitor/capacitor.config.ts');
  const originalConfig = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, originalConfig.replace('Puzzle Game', 'Other Game'));
  assert.throws(() => planCapacitorShellStarter(options), /display name differs/u);
  writeFileSync(configFile, originalConfig);
  writeFileSync(configFile, originalConfig.replace("webDir: 'www'", "webDir: 'other-www'"));
  assert.throws(() => planCapacitorShellStarter(options), /webDir differs/u);
  writeFileSync(configFile, originalConfig);
  const quotedName = 'King\'s "Quest" \\ Game';
  const quotedConfig = originalConfig.replace(
    JSON.stringify(options.displayName),
    JSON.stringify(quotedName),
  );
  writeFileSync(configFile, quotedConfig);
  const quotedTargets = readJson('mpgd.targets.json');
  const quotedTargetMap = quotedTargets.targets as Record<string, Record<string, unknown>>;
  for (const target of Object.values(quotedTargetMap)) {
    const metadata = target.metadata as Record<string, unknown>;
    metadata.displayName = quotedName;
  }
  writeJson('mpgd.targets.json', quotedTargets);
  const manifestFile = path.join(root, 'apps/mobile-capacitor/mpgd.native-shell.json');
  const originalManifest = readFileSync(manifestFile, 'utf8');
  const quotedManifest = JSON.parse(originalManifest) as Record<string, unknown>;
  quotedManifest.displayName = quotedName;
  writeJson('apps/mobile-capacitor/mpgd.native-shell.json', quotedManifest);
  assert.deepEqual(
    planCapacitorShellStarter({ ...options, displayName: quotedName }).changedFiles,
    [],
  );
  writeFileSync(manifestFile, originalManifest);
  for (const target of Object.values(quotedTargetMap)) {
    const metadata = target.metadata as Record<string, unknown>;
    metadata.displayName = options.displayName;
  }
  writeJson('mpgd.targets.json', quotedTargets);
  writeFileSync(configFile, originalConfig);
  const customShellTargets = readJson('mpgd.targets.json');
  const customShellTargetMap = customShellTargets.targets as Record<string, Record<string, unknown>>;
  assert.ok(customShellTargetMap.android);
  customShellTargetMap.android.shellApp = '${MPGD_KIT_PATH}/apps/company-shell';
  writeJson('mpgd.targets.json', customShellTargets);
  assert.throws(() => planCapacitorShellStarter(options), /another shell/u);
  customShellTargetMap.android.shellApp = 'apps/mobile-capacitor';
  writeJson('mpgd.targets.json', customShellTargets);
  assert.throws(
    () => planCapacitorShellStarter({ ...options, backendUrl: 'http://api.example.com' }),
    /HTTPS/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, backendUrl: 'https://localhost' }),
    /public HTTPS hostname/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, appId: 'dev.example.my_game' }),
    /app ID/u,
  );
  assert.throws(
    () => planCapacitorShellStarter({ ...options, iconSource: '../outside.svg' }),
    /ENOENT|game-owned/u,
  );
  const targetsWithConflictingName = readJson('mpgd.targets.json');
  const androidTarget = (targetsWithConflictingName.targets as Record<string, Record<string, unknown>>).android;
  assert.ok(androidTarget);
  (androidTarget.metadata as Record<string, unknown>).displayName = 'Other Game';
  writeJson('mpgd.targets.json', targetsWithConflictingName);
  assert.throws(() => planCapacitorShellStarter(options), /display name conflicts/u);
  (androidTarget.metadata as Record<string, unknown>).displayName = options.displayName;
  writeJson('mpgd.targets.json', targetsWithConflictingName);

  const envFile = path.join(root, '.env.production');
  const originalEnv = readFileSync(envFile, 'utf8');
  writeFileSync(envFile, 'VITE_MPGD_GAME_SERVICES_URL="https://api.example.com/"\r\n');
  assert.deepEqual(planCapacitorShellStarter(options).changedFiles, []);
  writeFileSync(envFile, originalEnv);
  const backupFile = path.join(root, '.env.production.saved');
  renameSync(envFile, backupFile);
  symlinkSync(path.join(root, 'missing.env'), envFile);
  assert.throws(() => planCapacitorShellStarter(options), /symbolic link/u);
  unlinkSync(envFile);
  renameSync(backupFile, envFile);

  const adapterFile = path.join(root, 'node_modules/@mpgd/adapter-capacitor/package.json');
  renameSync(adapterFile, `${adapterFile}.saved`);
  assert.throws(() => planCapacitorShellStarter(options), /Install game dependencies/u);
  renameSync(`${adapterFile}.saved`, adapterFile);

  console.info('Game-owned Capacitor shell planning and preservation passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertProductionTargetReadiness } from '../../packages/cli/src/index';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mpgd-production-readiness-')));
const gameRoot = join(fixtureRoot, 'game');
const outsideRoot = join(fixtureRoot, 'outside');
const targetsFile = join(gameRoot, '.mpgd.targets.generated.json');
const publicBackend = 'https://services.example.com';

try {
  mkdirSync(join(gameRoot, 'apps', 'target-ait'), { recursive: true });
  mkdirSync(join(gameRoot, 'apps', 'mobile-capacitor'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });

  writeTargets({
    ait: { wrapperApp: 'apps/target-ait', webDir: 'apps/target-ait/public/game' },
    android: { shellApp: 'apps/mobile-capacitor', webDir: 'apps/mobile-capacitor/www' },
    ios: { shellApp: 'apps/mobile-capacitor', webDir: 'apps/mobile-capacitor/www' },
  });

  for (const target of ['ait', 'android', 'ios']) {
    assertProductionTargetReadiness({
      target,
      profile: 'production',
      targetsFile,
      gameRoot,
      gameServicesUrl: publicBackend,
    });
  }

  assertProductionTargetReadiness({
    target: 'ait',
    profile: 'staging',
    targetsFile: join(gameRoot, 'does-not-exist.json'),
    gameRoot,
  });
  assertProductionTargetReadiness({
    target: 'web-preview',
    profile: 'production',
    targetsFile: join(gameRoot, 'does-not-exist.json'),
    gameRoot,
  });

  expectReadinessError(
    { target: 'ait', profile: ' production ', gameServicesUrl: publicBackend },
    'without surrounding whitespace',
  );
  expectReadinessError(
    { target: 'ait', profile: 'production' },
    'requires VITE_MPGD_GAME_SERVICES_URL',
  );

  for (const url of [
    'http://services.example.com',
    'https://user:secret@services.example.com',
    'https://localhost',
    'https://api.localhost',
    'https://service.local',
    'https://10.0.0.1',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.1.1',
    'https://172.16.0.1',
    'https://192.168.0.1',
    'https://198.18.0.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[ff00::1]',
    'https://[2001:db8::1]',
    'https://[::ffff:10.0.0.1]',
    'https://[::10.0.0.1]',
    'https://[::192.168.0.1]',
  ]) {
    expectReadinessError(
      { target: 'ait', profile: 'production', gameServicesUrl: url },
      'requires a public HTTPS game-services URL',
    );
  }

  for (const url of [
    'https://services.example.com.',
    'https://8.8.8.8',
    'https://[2606:4700:4700::1111]',
    'https://[::8.8.8.8]',
  ]) {
    assertProductionTargetReadiness({
      target: 'ait',
      profile: 'production',
      targetsFile,
      gameRoot,
      gameServicesUrl: url,
    });
  }

  writeTargets({ ait: { wrapperApp: '.', webDir: 'public/game' } });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must use a game-owned wrapperApp',
  );

  writeTargets({ ait: { wrapperApp: '../outside', webDir: '../outside/www' } });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must use a game-owned wrapperApp',
  );

  symlinkSync(outsideRoot, join(gameRoot, 'apps', 'escaped-wrapper'));
  writeTargets({
    ait: { wrapperApp: 'apps/escaped-wrapper', webDir: 'apps/escaped-wrapper/public/game' },
  });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must use a game-owned wrapperApp',
  );

  writeTargets({
    ait: { wrapperApp: 'apps/missing-wrapper', webDir: 'apps/missing-wrapper/public/game' },
  });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must exist',
  );

  writeTargets({
    ait: { wrapperApp: 'apps/target-ait', webDir: '../outside' },
  });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must keep webDir inside',
  );

  symlinkSync(outsideRoot, join(gameRoot, 'apps', 'target-ait', 'escaped-web'));
  writeTargets({
    ait: { wrapperApp: 'apps/target-ait', webDir: 'apps/target-ait/escaped-web/game' },
  });
  expectReadinessError(
    { target: 'ait', profile: 'production', gameServicesUrl: publicBackend },
    'must keep webDir inside',
  );

  writeTargets({
    ait: { wrapperApp: 'apps/target-ait', webDir: 'apps/target-ait/generated/game' },
  });
  assertProductionTargetReadiness({
    target: 'ait',
    profile: 'production',
    targetsFile,
    gameRoot,
    gameServicesUrl: publicBackend,
  });

  writeTargets({ android: {} });
  expectReadinessError(
    { target: 'android', profile: 'production', gameServicesUrl: publicBackend },
    'is missing shellApp',
  );

  writeTargets({});
  expectReadinessError(
    { target: 'ios', profile: 'production', gameServicesUrl: publicBackend },
    'Missing target configuration',
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Production target readiness smoke passed.');

interface ReadinessOverrides {
  readonly target: string;
  readonly profile: string;
  readonly gameServicesUrl?: string;
}

function expectReadinessError(overrides: ReadinessOverrides, message: string): void {
  assert.throws(
    () => {
      assertProductionTargetReadiness({
        target: overrides.target,
        profile: overrides.profile,
        targetsFile,
        gameRoot,
        ...(overrides.gameServicesUrl === undefined
          ? {}
          : { gameServicesUrl: overrides.gameServicesUrl }),
      });
    },
    (error: unknown) => error instanceof Error && error.message.includes(message),
  );
}

function writeTargets(targets: Record<string, Record<string, unknown>>): void {
  writeFileSync(targetsFile, `${JSON.stringify({ targets }, null, 2)}\n`);
}

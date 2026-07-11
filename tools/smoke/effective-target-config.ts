import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EffectiveTargetConfig, TargetIntegrationConfig } from '@mpgd/target-config';

// Runtime source import is intentional: smoke runs before package dist is rebuilt.
import { targetIntegrations } from '../../packages/target-config/src/runtime';
import {
  validateEffectiveTargetConfigMatrix,
  writeEffectiveTargetConfigs,
} from '../target/effective-config';
import { assertPlatformTargetsConfig } from '../target/schemas';

const matrix = validateEffectiveTargetConfigMatrix();
const webStoreIntegrationConfig = {
  identityUpgrade: 'disabled',
  presentation: 'available',
  sharing: 'available',
  inboundShare: 'available',
  notifications: 'unsupported',
  presentationMode: 'fullscreen',
} as const satisfies TargetIntegrationConfig;
const expectedIntegrations: Record<string, TargetIntegrationConfig> = {
  'web-preview': webStoreIntegrationConfig,
  'microsoft-store': webStoreIntegrationConfig,
  android: {
    identityUpgrade: 'configuration-required',
    presentation: 'available',
    sharing: 'configuration-required',
    inboundShare: 'configuration-required',
    notifications: 'configuration-required',
    presentationMode: 'fullscreen',
  },
  ios: {
    identityUpgrade: 'configuration-required',
    presentation: 'available',
    sharing: 'configuration-required',
    inboundShare: 'configuration-required',
    notifications: 'configuration-required',
    presentationMode: 'fullscreen',
  },
  ait: {
    identityUpgrade: 'configuration-required',
    presentation: 'available',
    sharing: 'available',
    inboundShare: 'available',
    notifications: 'configuration-required',
    presentationMode: 'fullscreen',
  },
  reddit: {
    identityUpgrade: 'configuration-required',
    presentation: 'configuration-required',
    sharing: 'configuration-required',
    inboundShare: 'configuration-required',
    notifications: 'approval-required',
    presentationMode: 'inline-expanded',
  },
};

for (const [target, config] of Object.entries(matrix.targets)) {
  verifyEffectiveConfig(target, config);
}

for (const expectedTarget of Object.keys(expectedIntegrations)) {
  if (matrix.targets[expectedTarget] === undefined) {
    throw new Error(`Stale integration expectation for removed target ${expectedTarget}.`);
  }
}

verifyGameOwnedIntegrationOverrides();

console.log(`Effective target config smoke passed: ${Object.keys(matrix.targets).join(', ')}`);

function verifyGameOwnedIntegrationOverrides(): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'mpgd-target-integrations-'));
  const targetsPath = join(tempDir, 'mpgd.targets.json');
  const outputDir = join(tempDir, 'artifacts');
  const previousTargetsPath = process.env.MPGD_PLATFORM_TARGETS_FILE;
  const platformTargets = {
    targets: {
      reddit: {
        kind: 'devvit-web',
        gameApp: '.',
        wrapperApp: '.',
        adapter: 'devvit',
        webDir: '.',
        artifact: 'devvit',
        integrations: {
          notifications: 'disabled',
          presentationMode: 'fullscreen',
        },
      },
    },
  } as const;

  assertPlatformTargetsConfig(platformTargets);
  const invalidPlatformTargets = {
    targets: {
      reddit: {
        ...platformTargets.targets.reddit,
        integrations: {
          notifications: 'not-a-readiness-state',
        },
      },
    },
  } as const;

  assertThrows(() => assertPlatformTargetsConfig(invalidPlatformTargets));

  writeFileSync(targetsPath, `${JSON.stringify(invalidPlatformTargets, null, 2)}\n`);
  process.env.MPGD_PLATFORM_TARGETS_FILE = targetsPath;
  assertThrows(() => writeEffectiveTargetConfigs({ targets: ['reddit'], outputDir }));

  writeFileSync(targetsPath, `${JSON.stringify(platformTargets, null, 2)}\n`);

  try {
    writeEffectiveTargetConfigs({
      targets: ['reddit'],
      outputDir,
    });
    const artifact = JSON.parse(
      readFileSync(join(outputDir, 'reddit.json'), 'utf8'),
    ) as EffectiveTargetConfig;

    assertEqual(
      artifact.integrations.identityUpgrade,
      'configuration-required',
      'reddit identity upgrade should inherit the generic target config',
    );
    assertEqual(
      artifact.integrations.sharing,
      'configuration-required',
      'reddit sharing should inherit the generic target config',
    );
    assertEqual(
      artifact.integrations.notifications,
      'disabled',
      'reddit notifications should use the game-owned target override',
    );
    assertEqual(
      artifact.integrations.presentationMode,
      'fullscreen',
      'reddit presentation mode should use the game-owned target override',
    );
  } finally {
    if (previousTargetsPath === undefined) {
      delete process.env.MPGD_PLATFORM_TARGETS_FILE;
    } else {
      process.env.MPGD_PLATFORM_TARGETS_FILE = previousTargetsPath;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyEffectiveConfig(target: string, config: EffectiveTargetConfig): void {
  const expectedIntegrationConfig = expectedIntegrations[target];

  if (expectedIntegrationConfig === undefined) {
    throw new Error(`Missing expected integration config for ${target}.`);
  }

  for (const integration of targetIntegrations) {
    assertEqual(
      config.integrations[integration],
      expectedIntegrationConfig[integration],
      `${target} ${integration} state should match readiness`,
    );
  }

  assertEqual(
    config.integrations.presentationMode,
    expectedIntegrationConfig.presentationMode,
    `${target} presentation mode should match its runtime surface`,
  );

  if (target === 'web-preview' || target === 'microsoft-store') {
    assertEqual(
      config.monetization.products.every((product) => !product.enabled),
      true,
      `${target} products should be disabled`,
    );
    assertEqual(
      config.ads.placements.every((placement) => !placement.enabled),
      true,
      `${target} ads should be disabled`,
    );
    assertEqual(config.localization.enabled, true, `${target} localization should be enabled`);
    assertEqual(config.storage.support, 'local', `${target} should use local storage`);
    return;
  }

  if (target === 'reddit') {
    assertEqual(
      config.monetization.products.every((product) => !product.enabled),
      true,
      'reddit products should be disabled until Devvit payments are wired',
    );
    assertEqual(
      config.ads.placements.every((placement) => !placement.enabled),
      true,
      'reddit ads should be disabled until Devvit ad rewards are wired',
    );
    assertEqual(config.leaderboard.enabled, true, 'reddit leaderboard should be enabled');
    assertEqual(
      config.leaderboard.defaultLeaderboardId,
      'default',
      'reddit leaderboard id should be stable',
    );
    assertEqual(config.storage.support, 'native', 'reddit should use Devvit server storage');
    assertEqual(config.localization.enabled, true, 'reddit localization should be enabled');
    return;
  }

  assertEqual(
    config.monetization.products.every((product) => product.enabled),
    true,
    `${target} products should all be mapped and enabled`,
  );
  assertEqual(
    config.ads.placements.every((placement) => placement.enabled),
    true,
    `${target} ad placements should all be mapped and enabled`,
  );
  assertEqual(config.leaderboard.enabled, true, `${target} leaderboard should be enabled`);
  assertEqual(
    config.leaderboard.defaultLeaderboardId,
    'default',
    `${target} leaderboard id should be stable`,
  );

  if (target === 'ait') {
    assertEqual(config.storage.support, 'none', 'ait should not rely on native storage');
  } else {
    assertEqual(config.storage.support, 'native', `${target} should use native storage`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function assertThrows(callback: () => void): void {
  try {
    callback();
  } catch {
    return;
  }

  throw new Error('Expected callback to throw.');
}

import type { EffectiveTargetConfig, TargetIntegrationConfig } from '@mpgd/target-config';

// Runtime source import is intentional: smoke runs before package dist is rebuilt.
import { targetIntegrations } from '../../packages/target-config/src/runtime';
import { validateEffectiveTargetConfigMatrix } from '../target/effective-config';

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

console.log(`Effective target config smoke passed: ${Object.keys(matrix.targets).join(', ')}`);

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

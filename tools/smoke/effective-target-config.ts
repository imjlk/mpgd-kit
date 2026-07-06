import type { EffectiveTargetConfig } from '@mpgd/target-config';

import { validateEffectiveTargetConfigMatrix } from '../target/effective-config';

const matrix = validateEffectiveTargetConfigMatrix();

for (const [target, config] of Object.entries(matrix.targets)) {
  verifyEffectiveConfig(target, config);
}

console.log(`Effective target config smoke passed: ${Object.keys(matrix.targets).join(', ')}`);

function verifyEffectiveConfig(target: string, config: EffectiveTargetConfig): void {
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

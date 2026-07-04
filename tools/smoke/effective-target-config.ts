import type { EffectiveTargetConfig } from '@mpgd/target-config';

import { validateEffectiveTargetConfigMatrix } from '../target/effective-config';

const matrix = validateEffectiveTargetConfigMatrix();

for (const [target, config] of Object.entries(matrix.targets)) {
  verifyEffectiveConfig(target, config);
}

console.log(`Effective target config smoke passed: ${Object.keys(matrix.targets).join(', ')}`);

function verifyEffectiveConfig(target: string, config: EffectiveTargetConfig): void {
  if (target === 'web-preview') {
    assertEqual(
      config.monetization.products.every((product) => !product.enabled),
      true,
      'web-preview products should be disabled',
    );
    assertEqual(
      config.ads.placements.every((placement) => !placement.enabled),
      true,
      'web-preview ads should be disabled',
    );
    assertEqual(config.localization.enabled, true, 'web-preview localization should be enabled');
    assertEqual(config.storage.support, 'local', 'web-preview should use local storage');
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

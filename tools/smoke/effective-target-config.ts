import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EffectiveTargetConfig, TargetIntegrationConfig } from '@mpgd/target-config';

// Runtime source import is intentional: smoke runs before package dist is rebuilt.
import {
  integrationAvailabilityStates,
  presentationModes,
  targetIntegrations,
} from '../../packages/target-config/src/runtime';
import {
  validateEffectiveTargetConfigMatrix,
  writeEffectiveTargetConfigs,
} from '../target/effective-config';
import { loadPlatformTargetsConfig } from '../target/platform-targets';
import { assertPlatformTargetsConfig } from '../target/schemas';
import { validateTargetConfigMatrixFile } from '../validate-target-config';

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
  const target = {
    kind: 'devvit-web',
    gameApp: '.',
    wrapperApp: '.',
    adapter: 'devvit',
    webDir: '.',
    artifact: 'devvit',
  } as const;
  const withIntegrations = (integrations: unknown): unknown => ({
    targets: {
      reddit: {
        ...target,
        integrations,
      },
    },
  });
  const platformTargets = withIntegrations({
    notifications: 'disabled',
    presentationMode: 'fullscreen',
  });
  const invalidPlatformTargets = withIntegrations({
    notifications: 'not-a-readiness-state',
  });
  const invalidInputs = [
    {
      description: 'an invalid availability state',
      config: invalidPlatformTargets,
      expectedMessage: 'notifications has an unsupported value',
    },
    {
      description: 'an unknown integration key',
      config: withIntegrations({ presntation: 'available' }),
      expectedMessage: 'not a recognized integration key',
    },
    {
      description: 'an invalid presentation mode',
      config: withIntegrations({ presentationMode: 'windowed' }),
      expectedMessage: 'presentationMode has an unsupported value',
    },
    {
      description: 'an object availability value',
      config: withIntegrations({ notifications: {} }),
      expectedMessage: 'notifications has an unsupported value',
    },
    {
      description: 'a string integrations value',
      config: withIntegrations('available'),
      expectedMessage: 'integrations must be an object',
    },
    {
      description: 'a number integrations value',
      config: withIntegrations(1),
      expectedMessage: 'integrations must be an object',
    },
    {
      description: 'a boolean integrations value',
      config: withIntegrations(true),
      expectedMessage: 'integrations must be an object',
    },
    {
      description: 'a null integrations value',
      config: withIntegrations(null),
      expectedMessage: 'integrations must be an object',
    },
    {
      description: 'an array integrations value',
      config: withIntegrations([]),
      expectedMessage: 'integrations must be an object',
    },
  ] as const;

  try {
    assertPlatformTargetsConfig(platformTargets);
    assertThrows(
      () => assertPlatformTargetsConfig(invalidPlatformTargets),
      'typia should reject an invalid game-owned integration state',
      'notifications',
    );

    process.env.MPGD_PLATFORM_TARGETS_FILE = targetsPath;
    for (const invalidInput of invalidInputs) {
      writeFileSync(targetsPath, `${JSON.stringify(invalidInput.config, null, 2)}\n`);
      assertThrows(
        () => writeEffectiveTargetConfigs({ targets: ['reddit'], outputDir }),
        `the effective config path should reject ${invalidInput.description}`,
        invalidInput.expectedMessage,
      );
      assertThrows(
        () => validateTargetConfigMatrixFile('packages/target-config/targets.json', targetsPath),
        `the standard target-config validator should reject ${invalidInput.description}`,
        invalidInput.expectedMessage,
      );
    }

    for (const availability of integrationAvailabilityStates) {
      const integrations = Object.fromEntries(
        targetIntegrations.map((integration) => [integration, availability]),
      );
      const config = withIntegrations({
        ...integrations,
        presentationMode: presentationModes[0],
      });

      assertValidPlatformTargetsFile(config, targetsPath, `availability state "${availability}"`);
    }

    for (const presentationMode of presentationModes) {
      const config = withIntegrations({
        notifications: integrationAvailabilityStates[0],
        presentationMode,
      });

      assertValidPlatformTargetsFile(
        config,
        targetsPath,
        `presentation mode "${presentationMode}"`,
      );
    }

    writeFileSync(targetsPath, `${JSON.stringify(platformTargets, null, 2)}\n`);
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
      artifact.integrations.presentation,
      'configuration-required',
      'reddit presentation readiness should be independent from presentation mode',
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
      'reddit products without app-owned Devvit SKUs should be disabled',
    );
    assertEqual(
      config.ads.placements.every((placement) => !placement.enabled),
      true,
      'reddit ads should be disabled until Devvit ad rewards are wired',
    );
    assertEqual(
      config.leaderboard.enabled,
      false,
      'reddit platform leaderboard should be disabled',
    );
    assertEqual(
      config.leaderboard.native,
      false,
      'reddit should not advertise a native leaderboard',
    );
    assertEqual(
      config.leaderboard.defaultLeaderboardId,
      undefined,
      'reddit should not expose a generic platform leaderboard id',
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

function assertValidPlatformTargetsFile(
  config: unknown,
  targetsPath: string,
  description: string,
): void {
  try {
    assertPlatformTargetsConfig(config);
    writeFileSync(targetsPath, `${JSON.stringify(config, null, 2)}\n`);
    loadPlatformTargetsConfig(targetsPath);
  } catch (error) {
    throw new Error(`Valid integration override rejected for ${description}.`, {
      cause: error,
    });
  }
}

function assertThrows(
  callback: () => unknown,
  message: string,
  expectedMessage: string,
): void {
  try {
    callback();
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error);

    if (!actualMessage.includes(expectedMessage)) {
      throw new Error(
        `${message}. Expected an error containing "${expectedMessage}", got "${actualMessage}".`,
        { cause: error },
      );
    }

    return;
  }

  throw new Error(`${message}. Expected callback to throw.`);
}

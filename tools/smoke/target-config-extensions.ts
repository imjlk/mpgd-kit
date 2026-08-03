import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGameViteSharedConfig } from '../../examples/phaser-starter/vite.shared';
import { targetConfigMatrixFileEnv } from '../../packages/cli/src/target-config-env';
import { appTargetForPlatformTarget } from '../target/platform-targets';
import { loadTargetConfigMatrix } from '../target/target-config-matrix';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-target-config-extensions-'));

try {
  assert.equal(
    appTargetForPlatformTarget({ kind: 'web', adapter: 'verse8' }, 'verse8-staging'),
    'verse8',
  );
  assert.equal(
    appTargetForPlatformTarget({ kind: 'web', adapter: 'browser' }, 'storefront'),
    'browser',
  );
  assert.equal(
    appTargetForPlatformTarget({ kind: 'devvit-web', adapter: 'devvit' }, 'reddit'),
    'reddit',
  );

  const extensionsFile = path.join(root, 'extensions.json');
  const base = loadTargetConfigMatrix();
  const webPreview = base.targets['web-preview'];
  const verse8 = base.targets.verse8;

  if (webPreview === undefined || verse8 === undefined) {
    throw new Error('Expected the built-in web-preview and verse8 target configs.');
  }

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: webPreview,
    },
  })}\n`);

  const extended = loadTargetConfigMatrix(undefined, extensionsFile);

  assert.deepEqual(extended.targets.storefront, webPreview);
  assert.match(extended.version, /\+extensions\.[a-f0-9]{16}$/u);
  assertViteRuntimeMatrix(extended, root);

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      index: webPreview,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /Invalid deployment target name: index/u,
  );

  const microsoftStore = base.targets['microsoft-store'];
  if (microsoftStore === undefined) {
    throw new Error('Expected the built-in microsoft-store target config.');
  }

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: microsoftStore,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot use the reserved Microsoft Store PWA runtime or release profile/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        release: { profile: 'google-play' },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /runtime web-preview requires release profile web-preview; received google-play/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        runtime: 'verse8-web',
        integrations: verse8.integrations,
        release: { profile: 'app-store' },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /runtime verse8-web requires release profile verse8; received app-store/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        runtime: 'capacitor-android',
        capabilities: {
          ...webPreview.capabilities,
          storage: 'native',
        },
        release: { profile: 'google-play' },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot use non-web runtime capacitor-android/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        capabilities: {
          ...webPreview.capabilities,
          storage: 'native',
        },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /runtime web-preview requires local storage; received native/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        features: {
          ...webPreview.features,
          iap: true,
        },
        monetization: {
          ...webPreview.monetization,
          iap: true,
        },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot enable in-app purchases for web-preview runtime/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        features: {
          ...webPreview.features,
          rewardedAds: true,
        },
        monetization: {
          ...webPreview.monetization,
          rewardedAds: true,
        },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot enable rewarded ads for web-preview runtime/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        features: {
          ...webPreview.features,
          interstitialAds: true,
        },
        monetization: {
          ...webPreview.monetization,
          interstitialAds: true,
        },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot enable interstitial ads for web-preview runtime/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        features: {
          ...webPreview.features,
          leaderboard: true,
        },
        leaderboard: { native: true },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot enable leaderboard for web-preview runtime/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        runtime: 'verse8-web',
        integrations: verse8.integrations,
        features: {
          ...webPreview.features,
          leaderboard: true,
        },
        leaderboard: { native: true },
        release: { profile: 'verse8' },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot enable leaderboard for verse8-web runtime/u,
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...webPreview,
        runtime: 'verse8-web',
        integrations: verse8.integrations,
        capabilities: {
          ...webPreview.capabilities,
          storage: 'none',
        },
        release: { profile: 'verse8' },
      },
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /runtime verse8-web requires local storage; received none/u,
  );

  for (const integration of [
    'identityUpgrade',
    'sharing',
    'inboundShare',
    'notifications',
  ] as const) {
    writeFileSync(extensionsFile, `${JSON.stringify({
      schemaVersion: 1,
      targets: {
        storefront: {
          ...verse8,
          integrations: {
            ...verse8.integrations,
            [integration]: 'available',
          },
        },
      },
    })}\n`);

    const expected = new RegExp(
      `cannot configure ${integration} as available for verse8-web runtime`,
      'u',
    );

    assert.throws(() => loadTargetConfigMatrix(undefined, extensionsFile), expected);
  }

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      storefront: {
        ...verse8,
        integrations: {
          ...verse8.integrations,
          presentation: 'disabled',
        },
      },
    },
  })}\n`);
  assert.equal(
    loadTargetConfigMatrix(undefined, extensionsFile).targets.storefront?.integrations?.presentation,
    'disabled',
  );

  writeFileSync(extensionsFile, `${JSON.stringify({
    schemaVersion: 1,
    targets: {
      'web-preview': webPreview,
    },
  })}\n`);

  assert.throws(
    () => loadTargetConfigMatrix(undefined, extensionsFile),
    /cannot replace built-in targets: web-preview/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('Target config extensions smoke passed.');

function assertViteRuntimeMatrix(
  matrix: ReturnType<typeof loadTargetConfigMatrix>,
  directory: string,
): void {
  const previous = process.env[targetConfigMatrixFileEnv];
  const matrixFile = path.join(directory, 'runtime-target-config-matrix.json');

  try {
    writeFileSync(matrixFile, JSON.stringify(matrix));
    process.env[targetConfigMatrixFileEnv] = matrixFile;
    const viteConfig = createGameViteSharedConfig({
      gameRoot: path.resolve('examples/phaser-starter'),
      mode: 'production',
      project: path.resolve('examples/phaser-starter/tsconfig.json'),
    });
    const define = viteConfig.define as Record<string, unknown> | undefined;
    const encodedMatrix = define?.__MPGD_TARGET_CONFIG_MATRIX__;

    assert.equal(typeof encodedMatrix, 'string');
    assert.deepEqual(JSON.parse(encodedMatrix as string) as unknown, matrix);

    writeFileSync(matrixFile, '[]');
    assert.throws(
      () => createGameViteSharedConfig({
        gameRoot: path.resolve('examples/phaser-starter'),
        mode: 'production',
        project: path.resolve('examples/phaser-starter/tsconfig.json'),
      }),
      /validate its shape/u,
    );

    writeFileSync(matrixFile, '{invalid');
    assert.throws(
      () => createGameViteSharedConfig({
        gameRoot: path.resolve('examples/phaser-starter'),
        mode: 'production',
        project: path.resolve('examples/phaser-starter/tsconfig.json'),
      }),
      /Failed to read or validate MPGD_TARGET_CONFIG_MATRIX_FILE/u,
    );
  } finally {
    if (previous === undefined) {
      delete process.env[targetConfigMatrixFileEnv];
    } else {
      process.env[targetConfigMatrixFileEnv] = previous;
    }
  }
}

import assert from 'node:assert/strict';

import {
  assertPlatformTargetBuildEmitterAvailable,
  assertPlatformTargetsConfigShape,
} from './platform-targets';

const validConfig = {
  targets: {
    wechat: {
      kind: 'wechat-minigame',
      gameApp: '.',
      adapter: 'wechat',
      output: 'artifacts/wechat',
      renderer: 'canvas',
      orientation: 'landscape',
      experimental: true,
      remoteAssetOrigins: ['https://assets.example.test'],
      packageBudget: {
        mainBytes: 4_194_304,
        totalBytes: 20_971_520,
      },
    },
    tiktok: {
      kind: 'tiktok-minigame',
      gameApp: '.',
      adapter: 'tiktok',
      output: 'artifacts/tiktok',
      renderer: 'canvas',
      orientation: 'portrait',
      experimental: true,
      packageBudget: {
        mainBytes: 4_194_304,
        totalBytes: 31_457_280,
        independentSubpackageBytes: 4_194_304,
      },
    },
  },
} as const;

assert.deepEqual(assertPlatformTargetsConfigShape(validConfig), validConfig);
assert.doesNotThrow(() =>
  assertPlatformTargetBuildEmitterAvailable(validConfig.targets.wechat, 'wechat'));
assert.throws(
  () => assertPlatformTargetBuildEmitterAvailable(validConfig.targets.tiktok, 'tiktok'),
  /cannot be built until its native artifact emitter is installed/u,
);

assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatOverride({ renderer: 'webgl' })),
  /wechat\.renderer must be canvas/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatOverride({ experimental: false })),
  /wechat\.experimental must be true/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatOverride({ adapter: 'browser' })),
  /wechat\.adapter must be wechat/u,
);
const insecureWechatOrigins = withWechatOverride({
  remoteAssetOrigins: ['http://assets.example.test'],
});
const nonOriginWechatUrl = withWechatOverride({
  remoteAssetOrigins: ['https://assets.example.test/path'],
});
const duplicateWechatOrigins = withWechatOverride({
  remoteAssetOrigins: ['https://assets.example.test', 'https://assets.example.test'],
});
const runtimeIncompatibleWechatOrigins = ['https://[::1]', 'https://assets.example.test.'];
assert.throws(
  () => assertPlatformTargetsConfigShape(insecureWechatOrigins),
  /must be an exact HTTPS origin/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(nonOriginWechatUrl),
  /must be an exact HTTPS origin/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(duplicateWechatOrigins),
  /must not contain duplicate origins/u,
);
for (const origin of runtimeIncompatibleWechatOrigins) {
  const runtimeIncompatibleWechatOrigin = withWechatOverride({ remoteAssetOrigins: [origin] });
  assert.throws(
    () => assertPlatformTargetsConfigShape(runtimeIncompatibleWechatOrigin),
    /must be an exact HTTPS origin/u,
  );
}
assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatBudget({ mainBytes: 20_971_521 })),
  /mainBytes must not exceed totalBytes/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatBudget({ mainBytes: 1.5 })),
  /mainBytes must be a positive safe integer/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(withWechatBudget({ mainBytes: 4_194_305 })),
  /mainBytes must not exceed 4194304 bytes/u,
);
assert.throws(
  () => assertPlatformTargetsConfigShape(
    withTikTokBudget({ independentSubpackageBytes: 31_457_281 }),
  ),
  /independentSubpackageBytes must not exceed totalBytes/u,
);

function withWechatOverride(override: Readonly<Record<string, unknown>>): unknown {
  return {
    ...validConfig,
    targets: {
      ...validConfig.targets,
      wechat: {
        ...validConfig.targets.wechat,
        ...override,
      },
    },
  };
}

function withWechatBudget(override: Readonly<Record<string, unknown>>): unknown {
  return withWechatOverride({
    packageBudget: {
      ...validConfig.targets.wechat.packageBudget,
      ...override,
    },
  });
}

function withTikTokBudget(override: Readonly<Record<string, unknown>>): unknown {
  return {
    ...validConfig,
    targets: {
      ...validConfig.targets,
      tiktok: {
        ...validConfig.targets.tiktok,
        packageBudget: {
          ...validConfig.targets.tiktok.packageBudget,
          ...override,
        },
      },
    },
  };
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { assertMiniGameRuntimeAssetOrigins } from './minigame-artifact';
import {
  assertDevvitInternalEndpoint,
  assertDevvitPaymentsReadiness,
  assertDevvitRealtimePermission,
  assertMicrosoftStorePwaManifestSourceContract,
  assertWebArtifactInstallability,
  verifyDevvitWebManifest,
  verifyEnabledDevvitPayments,
} from './verify-target-artifacts';

const webArtifactRoot = mkdtempSync(join(tmpdir(), 'mpgd-target-smoke-installability-'));

for (const permission of [undefined, false, true]) {
  assert.doesNotThrow(() =>
    assertDevvitRealtimePermission(permission, 'reddit permissions.realtime'),
  );
}
for (const permission of [null, 'true', 'false', 0, 1, {}, []]) {
  assert.throws(
    () => assertDevvitRealtimePermission(permission, 'reddit permissions.realtime'),
    /reddit permissions\.realtime must be a boolean or omitted/u,
  );
}

const manifestArtifactRoot = mkdtempSync(join(tmpdir(), 'mpgd-devvit-realtime-manifest-'));
try {
  const artifact = join(manifestArtifactRoot, 'dist');
  mkdirSync(join(artifact, 'client'), { recursive: true });
  mkdirSync(join(artifact, 'server'), { recursive: true });
  writeFileSync(join(artifact, 'client', 'index.html'), '<html></html>');
  writeFileSync(join(artifact, 'client', 'game.html'), '<html></html>');
  writeFileSync(join(artifact, 'server', 'index.cjs'), 'module.exports = {};');
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } })
    .png().toFile(join(manifestArtifactRoot, 'icon.png'));
  const effectiveConfig = join(manifestArtifactRoot, 'effective.json');
  writeFileSync(
    effectiveConfig,
    JSON.stringify({
      features: { iap: false },
      monetization: { iap: false, products: [] },
    }),
  );
  const verifyManifest = (realtime: unknown) => {
    writeFileSync(
      join(manifestArtifactRoot, 'devvit.json'),
      JSON.stringify({
        name: 'realtime-fixture',
        marketingAssets: { icon: 'icon.png' },
        post: {
          dir: 'dist/client',
          entrypoints: { default: { entry: 'index.html' }, game: { entry: 'game.html' } },
        },
        server: { dir: 'dist/server', entry: 'index.cjs' },
        permissions: {
          redis: true,
          reddit: true,
          payments: false,
          ...(realtime === undefined ? {} : { realtime }),
        },
        menu: {
          items: [
            { location: 'subreddit', label: 'Create game', endpoint: '/internal/menu/create-post' },
          ],
        },
      }),
    );
    verifyDevvitWebManifest(
      'reddit',
      {
        kind: 'devvit-web',
        gameApp: '.',
        adapter: 'devvit',
        wrapperApp: manifestArtifactRoot,
      },
      artifact,
      effectiveConfig,
    );
  };
  for (const realtime of [undefined, false, true]) {
    assert.doesNotThrow(() => verifyManifest(realtime));
  }
  for (const realtime of [null, 'true', 'false', 0, 1, {}, []]) {
    assert.throws(
      () => verifyManifest(realtime),
      /permissions\.realtime must be a boolean or omitted/u,
    );
  }
} finally {
  rmSync(manifestArtifactRoot, { recursive: true, force: true });
}

const expectedMiniGameOrigins = ['https://assets.example.test'];
const exactMiniGameOriginDeclaration = createMiniGameOriginDeclaration(expectedMiniGameOrigins);
assert.doesNotThrow(() =>
  assertMiniGameRuntimeAssetOrigins(
    `${exactMiniGameOriginDeclaration},globalThis.runtime = true;\n`,
    expectedMiniGameOrigins,
  ),
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    `${createMiniGameOriginDeclaration([
      ...expectedMiniGameOrigins,
      'https://unexpected.example.test',
    ])}\n`,
    expectedMiniGameOrigins,
  ),
  /asset origins differ from target configuration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins('globalThis.runtime = true;\n', []),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () =>
    assertMiniGameRuntimeAssetOrigins(
      createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'metadata'),
      expectedMiniGameOrigins,
    ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () =>
    assertMiniGameRuntimeAssetOrigins(
      createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'globalThis.Object', 'metadata'),
      expectedMiniGameOrigins,
    ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    '(() => { const Object = { defineProperty() {} }; '
      + `${createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'Object', 'Object')}; })();`,
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    `${exactMiniGameOriginDeclaration};\n(() => { `
      + `${createMiniGameOriginDeclaration(['https://unexpected.example.test'])}; })();`,
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
for (const shadow of [
  'const globalThis = { Object: { defineProperty() {}, freeze(value) { return value; } } };',
  'const Object = { defineProperty() {}, freeze(value) { return value; } };',
]) {
  assert.throws(
    () =>
      assertMiniGameRuntimeAssetOrigins(
        `${shadow}\n${exactMiniGameOriginDeclaration}`,
        expectedMiniGameOrigins,
      ),
    /must not shadow the globalThis or Object intrinsic binding/u,
  );
}
for (const unsafeDescriptor of [
  '{configurable:true,enumerable:false,writable:false,'
    + `value:globalThis.Object.freeze(${JSON.stringify(expectedMiniGameOrigins)})}`,
  '{configurable:false,enumerable:false,writable:false,'
    + `value:globalThis.Object.freeze(${JSON.stringify(expectedMiniGameOrigins)}),`
    + 'value:globalThis.Object.freeze(["https://unexpected.example.test"])}',
  '{configurable:false,enumerable:false,writable:false,'
    + `value:globalThis.Object.freeze(${JSON.stringify(expectedMiniGameOrigins)}),`
    + '...{value:globalThis.Object.freeze(["https://unexpected.example.test"])}}',
]) {
  assert.throws(
    () =>
      assertMiniGameRuntimeAssetOrigins(
        createMiniGameOriginDeclarationFromDescriptor(unsafeDescriptor),
        expectedMiniGameOrigins,
      ),
    /exactly one executable asset-origin declaration/u,
  );
}
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    'globalThis.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__ = '
      + '["https://unexpected.example.test"];\n'
      + exactMiniGameOriginDeclaration,
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);

try {
  writeFileSync(join(webArtifactRoot, 'manifest.webmanifest'), '{}\n');
  writeFileSync(
    join(webArtifactRoot, 'index.html'),
    '<html><head><link rel="manifest" href="./manifest.webmanifest"></head></html>',
  );
  assert.doesNotThrow(() => assertWebArtifactInstallability(webArtifactRoot, undefined));
  assert.throws(
    () => assertWebArtifactInstallability(webArtifactRoot, false),
    /Non-installable web artifact contains a web app manifest/u,
  );

  rmSync(join(webArtifactRoot, 'manifest.webmanifest'));
  writeFileSync(join(webArtifactRoot, 'index.html'), '<html><head></head></html>');
  assert.doesNotThrow(() => assertWebArtifactInstallability(webArtifactRoot, false));
  assert.throws(
    () => assertWebArtifactInstallability(webArtifactRoot, true),
    /Installable web artifact has no web app manifest/u,
  );
} finally {
  rmSync(webArtifactRoot, { force: true, recursive: true });
}

const enabledConfig = {
  features: { iap: true },
  monetization: {
    iap: true,
    products: [{ enabled: true, platformProductId: 'cosmetic_1' }],
  },
};
const disabledConfig = {
  features: { iap: false },
  monetization: {
    iap: false,
    products: [{ enabled: false, platformProductId: 'cosmetic_1' }],
  },
};
const capabilityReadyConfig = {
  features: { iap: true },
  monetization: {
    iap: true,
    products: [{ enabled: false, platformProductId: undefined }],
  },
};

assert.deepEqual(assertDevvitPaymentsReadiness(true, enabledConfig, 'reddit Devvit manifest'), [
  'cosmetic_1',
]);
assert.deepEqual(
  assertDevvitPaymentsReadiness(false, disabledConfig, 'reddit Devvit manifest'),
  [],
);
assert.deepEqual(
  assertDevvitPaymentsReadiness(false, capabilityReadyConfig, 'reddit Devvit manifest'),
  [],
);
assert.throws(
  () => assertDevvitPaymentsReadiness(false, enabledConfig, 'reddit Devvit manifest'),
  /must not expose enabled products/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(undefined, enabledConfig, 'reddit Devvit manifest'),
  /must not expose enabled products/u,
);
assert.throws(
  () => assertDevvitPaymentsReadiness(true, disabledConfig, 'reddit Devvit manifest'),
  /features\.iap must be true/u,
);

assert.doesNotThrow(() =>
  assertDevvitInternalEndpoint('/internal/payments/fulfill', 'fulfillOrder'),
);
assert.throws(
  () => assertDevvitInternalEndpoint('/api/payments/fulfill', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);
assert.throws(
  () => assertDevvitInternalEndpoint('/internal/', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);

const paymentArtifactRoot = mkdtempSync(join(tmpdir(), 'mpgd-devvit-payment-catalog-'));
const historicalPaymentsManifest = {
  payments: {
    productsFile: 'products.json',
    endpoints: {
      fulfillOrder: '/internal/payments/fulfill',
      refundOrder: '/internal/payments/refund',
    },
  },
};
try {
  const productsPath = join(paymentArtifactRoot, 'products.json');
  const verify = (skus: readonly string[]) =>
    verifyEnabledDevvitPayments(historicalPaymentsManifest, paymentArtifactRoot, skus, 'reddit');
  writeFileSync(productsPath, JSON.stringify({ products: [] }));
  const noSalesSkus = assertDevvitPaymentsReadiness(true, capabilityReadyConfig, 'reddit');
  assert.doesNotThrow(() => verify(noSalesSkus));
  assert.throws(() => verify(['cosmetic_1']), /SKUs must match/u);
  assert.throws(
    () =>
      verifyEnabledDevvitPayments(
        { payments: { ...historicalPaymentsManifest.payments, endpoints: {} } },
        paymentArtifactRoot,
        [],
        'reddit',
      ),
    /fulfillOrder/u,
  );
  assert.throws(
    () =>
      verifyEnabledDevvitPayments(
        {
          payments: {
            ...historicalPaymentsManifest.payments,
            endpoints: {
              ...historicalPaymentsManifest.payments.endpoints,
              refundOrder: '/api/refund',
            },
          },
        },
        paymentArtifactRoot,
        [],
        'reddit',
      ),
    /refundOrder must be a Devvit internal endpoint path/u,
  );
  writeFileSync(productsPath, JSON.stringify({ products: [{ sku: 'cosmetic_1' }] }));
  assert.doesNotThrow(() => verify(['cosmetic_1']));
  assert.throws(() => verify([]), /SKUs must match/u);
  writeFileSync(productsPath, JSON.stringify({ products: [{ sku: 'same' }, { sku: 'same' }] }));
  assert.throws(() => verify(['same']), /duplicate SKU/u);
  writeFileSync(productsPath, JSON.stringify({ products: null }));
  assert.throws(() => verify([]), /must be an array/u);
  rmSync(productsPath);
  assert.throws(() => verify([]), /products file/u);
} finally {
  rmSync(paymentArtifactRoot, { recursive: true, force: true });
}

const sourcePwaManifest = {
  lang: 'en-US',
  name: 'Fixture',
  short_name: 'Fixture',
  description: 'Fixture game',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'landscape',
  background_color: '#020617',
  theme_color: '#0f172a',
  categories: ['games', 'entertainment'],
  icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml' }],
};

assert.doesNotThrow(() =>
  assertMicrosoftStorePwaManifestSourceContract(
    {
      ...sourcePwaManifest,
      icons: [
        {
          src: './icons/icon-any-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
      ],
    },
    sourcePwaManifest,
  ),
);
assert.throws(
  () =>
    assertMicrosoftStorePwaManifestSourceContract(
      { ...sourcePwaManifest, description: 'Stale description' },
      sourcePwaManifest,
    ),
  /manifest description differs from public\/manifest\.webmanifest/u,
);
assert.throws(
  () =>
    assertMicrosoftStorePwaManifestSourceContract(
      { ...sourcePwaManifest, categories: ['games'] },
      sourcePwaManifest,
    ),
  /manifest categories differs from public\/manifest\.webmanifest/u,
);

console.log('Target artifact readiness tests passed.');

function createMiniGameOriginDeclaration(
  origins: readonly string[],
  definePropertyOwner = 'globalThis.Object',
  freezeOwner = 'globalThis.Object',
): string {
  return `${definePropertyOwner}.defineProperty(globalThis,`
    + '"__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__",'
    + '{configurable:false,enumerable:false,writable:false,'
    + `value:${freezeOwner}.freeze(`
    + 'globalThis.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__??'
    + `${JSON.stringify(origins)})})`;
}

function createMiniGameOriginDeclarationFromDescriptor(descriptor: string): string {
  return 'globalThis.Object.defineProperty(globalThis,'
    + '"__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__",'
    + `${descriptor});`;
}

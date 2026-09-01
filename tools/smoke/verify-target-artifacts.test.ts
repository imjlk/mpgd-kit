import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertMiniGameRuntimeAssetOrigins } from './minigame-artifact';
import {
  assertDevvitInternalEndpoint,
  assertDevvitPaymentsReadiness,
  assertMicrosoftStorePwaManifestSourceContract,
  assertWebArtifactInstallability,
} from './verify-target-artifacts';

const webArtifactRoot = mkdtempSync(join(tmpdir(), 'mpgd-target-smoke-installability-'));

const expectedMiniGameOrigins = ['https://assets.example.test'];
const exactMiniGameOriginDeclaration = createMiniGameOriginDeclaration(expectedMiniGameOrigins);
assert.doesNotThrow(
  () => assertMiniGameRuntimeAssetOrigins(
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
  () => assertMiniGameRuntimeAssetOrigins(
    createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'metadata'),
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'globalThis.Object', 'metadata'),
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    '(() => { const Object = { defineProperty() {} }; '
      + `${createMiniGameOriginDeclaration(expectedMiniGameOrigins, 'Object', 'Object')} })();`,
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
assert.throws(
  () => assertMiniGameRuntimeAssetOrigins(
    `${exactMiniGameOriginDeclaration}\n(() => { `
      + `${createMiniGameOriginDeclaration(['https://unexpected.example.test'])} })();`,
    expectedMiniGameOrigins,
  ),
  /exactly one executable asset-origin declaration/u,
);
for (const shadow of [
  'const globalThis = { Object: { defineProperty() {}, freeze(value) { return value; } } };',
  'const Object = { defineProperty() {}, freeze(value) { return value; } };',
]) {
  assert.throws(
    () => assertMiniGameRuntimeAssetOrigins(
      `${shadow}\n${exactMiniGameOriginDeclaration}`,
      expectedMiniGameOrigins,
    ),
    /must not shadow the globalThis or Object intrinsic binding/u,
  );
}

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
  assertDevvitInternalEndpoint('/internal/payments/fulfill', 'fulfillOrder'));
assert.throws(
  () => assertDevvitInternalEndpoint('/api/payments/fulfill', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);
assert.throws(
  () => assertDevvitInternalEndpoint('/internal/', 'fulfillOrder'),
  /must be a Devvit internal endpoint path/u,
);

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

assert.doesNotThrow(() => assertMicrosoftStorePwaManifestSourceContract(
  {
    ...sourcePwaManifest,
    icons: [{
      src: './icons/icon-any-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    }],
  },
  sourcePwaManifest,
));
assert.throws(
  () => assertMicrosoftStorePwaManifestSourceContract(
    { ...sourcePwaManifest, description: 'Stale description' },
    sourcePwaManifest,
  ),
  /manifest description differs from public\/manifest\.webmanifest/u,
);
assert.throws(
  () => assertMicrosoftStorePwaManifestSourceContract(
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
    + `{value:${freezeOwner}.freeze(${JSON.stringify(origins)})});`;
}

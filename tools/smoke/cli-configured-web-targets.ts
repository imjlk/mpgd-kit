import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeBuildTarget,
  normalizeConfiguredBuildTargets,
} from '../../packages/cli/src/build-targets';
import { runMpgdCli } from '../../packages/cli/src/index';

const configuredTargets = {
  'web-preview': {
    kind: 'web',
  },
  storefront: {
    kind: 'web',
  },
  unsupportedCustomNative: {
    kind: 'custom-native',
  },
} as const;

assert.equal(normalizeBuildTarget('web', configuredTargets), 'web-preview');
assert.equal(normalizeBuildTarget('browser', configuredTargets), 'web-preview');
assert.equal(normalizeBuildTarget('storefront', configuredTargets), 'storefront');
assert.equal(normalizeBuildTarget('web', { web: { kind: 'web' } }), 'web');
const configuredBuildTargets = normalizeConfiguredBuildTargets(configuredTargets);
assert.deepEqual(configuredBuildTargets, ['web-preview', 'storefront']);
assert.throws(
  () => normalizeBuildTarget('unsupportedCustomNative', configuredTargets),
  /Unsupported target: unsupportedCustomNative/u,
);
assert.throws(
  () => normalizeBuildTarget('missing', configuredTargets),
  /Unsupported target: missing/u,
);
assert.throws(
  () => normalizeBuildTarget('index', { index: { kind: 'web' } }),
  /Invalid deployment target name: index/u,
);
assert.throws(
  () => normalizeConfiguredBuildTargets({ '../escape': { kind: 'web' } }),
  /Invalid deployment target name: \.\.\/escape/u,
);
for (const alias of ['browser', 'msstore', 'devvit', 'constructor', 'prototype']) {
  assert.throws(
    () => normalizeConfiguredBuildTargets({ [alias]: { kind: 'web' } }),
    new RegExp(`Invalid deployment target name: ${alias}`, 'u'),
  );
}

const staleTargetsRoot = mkdtempSync(join(tmpdir(), 'mpgd-stale-targets-env-'));
const staleTargetsFile = join(staleTargetsRoot, 'mpgd.targets.json');
const previousTargetsFile = process.env.MPGD_PLATFORM_TARGETS_FILE;

try {
  writeFileSync(staleTargetsFile, '{invalid');
  process.env.MPGD_PLATFORM_TARGETS_FILE = staleTargetsFile;

  await assert.rejects(
    runMpgdCli([
      'target',
      'generate-package',
      'android',
      '--pwa-url',
      'https://example.com/game/',
      '--manifest-url',
      'https://example.com/game/manifest.webmanifest',
      '--package-version',
      '1.0.0.0',
      '--classic-version',
      '0.9.0.0',
    ]),
    /Package generation is not available for target: android/u,
  );
  await assert.rejects(
    runMpgdCli(['target', 'preflight', 'android']),
    /Submission preflight is not available for target: android/u,
  );
  await assert.rejects(
    runMpgdCli(['target', 'accept-package', 'android', '--packages', 'fixture.msix']),
    /Package acceptance is not available for target: android/u,
  );
} finally {
  if (previousTargetsFile === undefined) {
    delete process.env.MPGD_PLATFORM_TARGETS_FILE;
  } else {
    process.env.MPGD_PLATFORM_TARGETS_FILE = previousTargetsFile;
  }
  rmSync(staleTargetsRoot, { force: true, recursive: true });
}

console.log('Configured web target CLI smoke passed.');

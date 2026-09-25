import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyKitUpgrade,
  parsePublishedKitPackageResponse,
  planKitUpgrade,
  type LatestKitPackageLookup,
} from '../../packages/cli/src/kit-upgrade';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mpgd-kit-upgrade-')));
const workspace = path.join(root, 'workspace');
const game = path.join(workspace, 'sample-game');
const wrapper = path.join(game, 'apps', 'target-a');
const mobile = path.join(game, 'apps', 'target-mobile');
const rootLock = path.join(workspace, 'pnpm-lock.yaml');
const gameLock = path.join(game, 'pnpm-lock.yaml');
const gamePackage = path.join(game, 'package.json');
const wrapperPackage = path.join(wrapper, 'package.json');
const writeJson = (file: string, value: unknown): void => {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const lookup: LatestKitPackageLookup = async (name) => {
  const packages = {
    '@mpgd/cli': { version: '0.34.0' },
    '@mpgd/adapter-browser': { version: '0.8.0' },
    '@mpgd/adapter-ait': {
      version: '0.13.0',
      peerDependencies: { '@apps-in-toss/web-framework': '>=3 <4' },
    },
    '@mpgd/adapter-capacitor': {
      version: '0.4.12',
      peerDependencies: { '@capacitor/core': '^8.5.1' },
    },
    '@mpgd/target-config': { version: '0.15.2' },
  };
  const published = packages[name as keyof typeof packages];
  if (published === undefined) {
    throw new Error('Missing fixture for ' + name);
  }
  return published;
};

try {
  assert.deepEqual(parsePublishedKitPackageResponse('"0.8.0"', '@mpgd/adapter-browser'), {
    version: '0.8.0',
    peerDependencies: {},
  });
  assert.deepEqual(
    parsePublishedKitPackageResponse(
      '{"version":"0.13.0","peerDependencies":{"phaser":">=4 <5"}}',
      '@mpgd/example-adapter',
    ),
    { version: '0.13.0', peerDependencies: { phaser: '>=4 <5' } },
  );
  assert.throws(
    () => parsePublishedKitPackageResponse('not json', '@mpgd/adapter-browser'),
    /Invalid npm view JSON/,
  );
  assert.throws(
    () => parsePublishedKitPackageResponse('{"peerDependencies":{}}', '@mpgd/adapter-browser'),
    /Registry did not return a latest version/,
  );
  assert.deepEqual(
    parsePublishedKitPackageResponse(
      '{"version":"0.4.12","peerDependencies":{"@capacitor/core":"^8.5.1","legacy":7},'
        + '"peerDependenciesMeta":{"@capacitor/core":{"optional":true}}}',
      '@mpgd/adapter-capacitor',
    ),
    {
      version: '0.4.12',
      peerDependencies: { '@capacitor/core': '^8.5.1' },
      optionalPeerDependencies: ['@capacitor/core'],
    },
  );
  assert.deepEqual(
    parsePublishedKitPackageResponse(
      '{"version":"0.8.0","peerDependencies":{"phaser":">=4 <5","invalid":7}}',
      '@mpgd/adapter-browser',
    ),
    { version: '0.8.0', peerDependencies: { phaser: '>=4 <5' } },
  );
  mkdirSync(path.join(workspace, '.git'), { recursive: true });
  mkdirSync(wrapper, { recursive: true });
  mkdirSync(mobile, { recursive: true });
  writeJson(path.join(workspace, 'package.json'), {
    name: 'sample-workspace',
    private: true,
    devDependencies: { '@mpgd/cli': '0.33.2' },
  });
  writeFileSync(rootLock, 'root lock before\n');
  writeFileSync(gameLock, 'game lock before\n');
  writeJson(gamePackage, {
    name: 'sample-game',
    dependencies: {
      '@apps-in-toss/web-framework': '3.1.1',
      '@mpgd/adapter-browser': '0.7.0',
      '@mpgd/adapter-capacitor': '0.4.10',
      '@mpgd/target-config': '0.15.2',
    },
    devDependencies: { '@mpgd/cli': '0.33.2', '@mpgd/local-helper': 'workspace:*' },
  });
  writeJson(wrapperPackage, {
    name: 'sample-wrapper',
    dependencies: { '@mpgd/adapter-ait': '0.12.0' },
  });
  writeJson(path.join(mobile, 'package.json'), {
    name: 'sample-mobile-shell',
    dependencies: { '@capacitor/core': '8.5.1' },
  });
  writeJson(path.join(game, 'mpgd.targets.json'), {
    targets: {
      web: { kind: 'web', gameApp: '.' },
      ait: { kind: 'apps-in-toss', wrapperApp: '${MPGD_GAME_ROOT}/apps/target-a' },
      android: {
        kind: 'capacitor-android',
        shellApp: 'apps/target-mobile',
        authoritativeGameServices: false,
      },
      ios: { kind: 'capacitor-ios', shellApp: '$' + '{MPGD_KIT_PATH}/apps/mobile-capacitor' },
    },
  });
  writeJson(path.join(game, 'mpgd.catalog.json'), {
    version: 'test',
    products: [
      {
        id: 'COIN_PACK',
        type: 'consumable',
        grant: { type: 'currency', currency: 'coin', amount: 10 },
        platformProductIds: { ait: 'coins-ait' },
      },
    ],
  });
  writeJson(path.join(game, 'mpgd.ad-placements.json'), {
    version: 'test',
    placements: [
      {
        id: 'REVIVE',
        type: 'rewarded',
        reward: { type: 'continue', amount: 1 },
        frequencyCap: { cooldownSeconds: 30 },
        platformPlacementIds: { ait: 'revive-ait' },
      },
    ],
  });

  const before = readFileSync(gamePackage, 'utf8');
  const wrapperBefore = readFileSync(wrapperPackage, 'utf8');
  const plan = await planKitUpgrade(game, lookup);
  assert.equal(readFileSync(gamePackage, 'utf8'), before, 'planning must not edit sources');
  assert.equal(plan.blockers.length, 0, plan.blockers.join('\n'));
  assert.equal(plan.updates.length, 4);
  assert.deepEqual(plan.updates.map((update) => update.packageName).sort(), [
    '@mpgd/adapter-ait',
    '@mpgd/adapter-browser',
    '@mpgd/adapter-capacitor',
    '@mpgd/cli',
  ]);
  assert.ok(plan.notes.some((note) => note.includes('external target')));
  assert.ok(plan.notes.some((note) => note.includes('workspace:*')));
  assert.ok(!plan.notes.some((note) => note.includes('requires peer @capacitor/core')));
  assert.ok(plan.targetAdvisories.some((advisory) =>
    advisory.target === 'ios'
      && advisory.kind === 'missing-product-id'
      && advisory.logicalId === 'COIN_PACK'));
  assert.ok(plan.targetAdvisories.some((advisory) =>
    advisory.target === 'ios'
      && advisory.kind === 'missing-placement-id'
      && advisory.logicalId === 'REVIVE'));
  assert.ok(!plan.targetAdvisories.some((advisory) => advisory.target === 'android'));
  assert.ok(!plan.targetAdvisories.some((advisory) => advisory.target === 'ait'));
  assert.ok(plan.targetAdvisories.some((advisory) =>
    advisory.target === 'web' && advisory.kind === 'not-assessed'));
  assert.deepEqual(plan.workspaceRoots, [workspace, game]);
  const previousCatalogOverride = process.env.MPGD_PRODUCT_CATALOG_FILE;
  process.env.MPGD_PRODUCT_CATALOG_FILE = 'custom-catalog.json';
  try {
    const customCatalogReadiness = await planKitUpgrade(game, lookup);
    assert.equal(customCatalogReadiness.blockers.length, 0);
    assert.ok(customCatalogReadiness.targetAdvisories.some((advisory) =>
      advisory.kind === 'not-assessed' && advisory.message.includes('Custom catalog')));
  } finally {
    if (previousCatalogOverride === undefined) {
      delete process.env.MPGD_PRODUCT_CATALOG_FILE;
    } else {
      process.env.MPGD_PRODUCT_CATALOG_FILE = previousCatalogOverride;
    }
  }

  const configuredTargetsFile = path.join(game, 'mpgd.targets.json');
  const configuredTargetsBefore = readFileSync(configuredTargetsFile, 'utf8');
  const malformedTargets = readJson(configuredTargetsFile);
  (malformedTargets.targets as Record<string, unknown>).android = 'malformed';
  writeJson(configuredTargetsFile, malformedTargets);
  try {
    const partialReadiness = await planKitUpgrade(game, lookup);
    assert.ok(partialReadiness.targetAdvisories.some((advisory) =>
      advisory.target === 'android' && advisory.kind === 'not-assessed'));
    assert.ok(partialReadiness.targetAdvisories.some((advisory) =>
      advisory.target === 'ios' && advisory.kind === 'missing-product-id'));
  } finally {
    writeFileSync(configuredTargetsFile, configuredTargetsBefore);
  }

  const catalogFile = path.join(game, 'mpgd.catalog.json');
  const placementsFile = path.join(game, 'mpgd.ad-placements.json');
  const catalogBefore = readFileSync(catalogFile, 'utf8');
  const placementsBefore = readFileSync(placementsFile, 'utf8');
  unlinkSync(catalogFile);
  try {
    const incompleteReadiness = await planKitUpgrade(game, lookup);
    assert.equal(incompleteReadiness.blockers.length, 0);
    assert.ok(incompleteReadiness.targetAdvisories.some((advisory) =>
      advisory.kind === 'not-assessed' && advisory.message.includes('mpgd.catalog.json')));
    unlinkSync(placementsFile);
    const nonMonetizedReadiness = await planKitUpgrade(game, lookup);
    assert.equal(nonMonetizedReadiness.blockers.length, 0);
    assert.ok(nonMonetizedReadiness.targetAdvisories.some((advisory) =>
      advisory.target === 'web' && advisory.kind === 'not-assessed'));
    assert.ok(!nonMonetizedReadiness.targetAdvisories.some((advisory) =>
      advisory.target === '*'));
    assert.ok(!nonMonetizedReadiness.targetAdvisories.some((advisory) =>
      advisory.kind === 'missing-product-id' || advisory.kind === 'missing-placement-id'));
  } finally {
    writeFileSync(catalogFile, catalogBefore);
    writeFileSync(placementsFile, placementsBefore);
  }

  const basePolicies = readJson(path.join('packages', 'target-config', 'targets.json'));
  const baseTargets = basePolicies.targets as Record<string, Record<string, unknown>>;
  const webPreview = baseTargets['web-preview'];
  assert.ok(webPreview);
  const extensionFile = path.join(game, 'mpgd.target-config.json');
  writeJson(extensionFile, {
    schemaVersion: 1,
    targets: {
      web: {
        ...webPreview,
        runtime: 'web',
        release: { profile: 'web' },
        features: { ...webPreview.features as Record<string, unknown>, rewardedAds: true },
        monetization: { ...webPreview.monetization as Record<string, unknown>, rewardedAds: true },
      },
    },
  });
  try {
    const extendedReadiness = await planKitUpgrade(game, lookup);
    assert.ok(extendedReadiness.targetAdvisories.some((advisory) =>
      advisory.target === 'web' && advisory.kind === 'not-assessed'));
    assert.ok(!extendedReadiness.targetAdvisories.some((advisory) =>
      advisory.target === 'web' && advisory.kind === 'missing-placement-id'));
  } finally {
    unlinkSync(extensionFile);
  }

  const alternateTargets = path.join(game, 'config', 'alternate.targets.json');
  mkdirSync(path.dirname(alternateTargets), { recursive: true });
  writeJson(alternateTargets, {
    targets: {
      ait: { wrapperApp: '../apps/target-a' },
      android: { shellApp: '${MPGD_GAME_APP_ROOT}/../apps/target-mobile' },
    },
  });
  const alternatePlan = await planKitUpgrade(game, lookup, 'config/alternate.targets.json');
  assert.ok(alternatePlan.updates.some((update) => update.manifest === wrapperPackage));
  assert.ok(
    alternatePlan.manifestDigests[path.join(mobile, 'package.json')],
    alternatePlan.notes.join('\n'),
  );
  assert.ok(!alternatePlan.notes.some((note) => note.includes('external target')));
  assert.equal(
    (readJson(path.join(workspace, 'package.json')).devDependencies as Record<string, string>)['@mpgd/cli'],
    '0.33.2',
    'a different workspace owner must not be changed',
  );

  const refreshed = await planKitUpgrade(game, lookup);
  writeFileSync(gamePackage, before + '\n');
  assert.throws(() => applyKitUpgrade(refreshed), /File changed after upgrade planning/);
  writeFileSync(gamePackage, before);

  const staleTargets = await planKitUpgrade(game, lookup);
  const targetsFile = path.join(game, 'mpgd.targets.json');
  const targetsBefore = readFileSync(targetsFile, 'utf8');
  writeFileSync(targetsFile, targetsBefore + '\n');
  assert.throws(() => applyKitUpgrade(staleTargets), /File changed after upgrade planning/);
  writeFileSync(targetsFile, targetsBefore);

  writeJson(path.join(mobile, 'package.json'), {
    name: 'sample-mobile-shell',
    dependencies: { '@capacitor/core': '^7.5.0' },
  });
  const incompatibleRange = await planKitUpgrade(game, lookup);
  assert.ok(incompatibleRange.blockers.some((issue) => issue.includes('@capacitor/core')));
  writeJson(path.join(mobile, 'package.json'), {
    name: 'sample-mobile-shell',
    dependencies: { '@capacitor/core': '8.5.1' },
  });

  const unchangedPeerLookup: LatestKitPackageLookup = async (name, directory) => {
    const published = await lookup(name, directory);
    return name === '@mpgd/target-config'
      ? {
          version: '0.15.2',
          peerDependencies: { '@mpgd/adapter-browser': '^0.7.0' },
        }
      : published;
  };
  const unchangedPeerConflict = await planKitUpgrade(game, unchangedPeerLookup);
  assert.ok(
    unchangedPeerConflict.blockers.some((issue) => issue.includes('@mpgd/adapter-browser')),
  );
  assert.throws(() => applyKitUpgrade(unchangedPeerConflict), /blocked/);

  const failed = await planKitUpgrade(game, lookup);
  assert.throws(
    () =>
      applyKitUpgrade(failed, (directory) => {
        if (directory === game) {
          unlinkSync(gameLock);
          throw new Error('fixture lockfile failure');
        }
        writeFileSync(rootLock, 'partially updated\n');
      }),
    /rolled back/,
  );
  assert.equal(readFileSync(gamePackage, 'utf8'), before);
  assert.equal(readFileSync(wrapperPackage, 'utf8'), wrapperBefore);
  assert.equal(readFileSync(rootLock, 'utf8'), 'root lock before\n');
  assert.equal(readFileSync(gameLock, 'utf8'), 'game lock before\n');

  const applied = await planKitUpgrade(game, lookup);
  const result = applyKitUpgrade(applied, (directory) => {
    writeFileSync(path.join(directory, 'pnpm-lock.yaml'), 'updated lock\n');
  });
  assert.equal(result.manifests.length, 2);
  assert.equal(result.lockfiles.length, 2);
  assert.equal(
    (readJson(gamePackage).devDependencies as Record<string, string>)['@mpgd/cli'],
    '0.34.0',
  );
  assert.equal(
    (readJson(wrapperPackage).dependencies as Record<string, string>)['@mpgd/adapter-ait'],
    '0.13.0',
  );
  assert.equal(
    (readJson(gamePackage).dependencies as Record<string, string>)['@apps-in-toss/web-framework'],
    '3.1.1',
  );
  assert.equal(
    (readJson(path.join(mobile, 'package.json')).dependencies as Record<string, string>)['@capacitor/core'],
    '8.5.1',
  );
  assert.equal(readFileSync(rootLock, 'utf8'), 'updated lock\n');
  assert.equal(readFileSync(gameLock, 'utf8'), 'updated lock\n');

  const lockfileDrift = await planKitUpgrade(game, async (name, directory) => {
    const published = await lookup(name, directory);
    return name === '@mpgd/cli' ? { version: '0.35.0' } : published;
  });
  writeFileSync(gameLock, 'drifted lock\n');
  assert.throws(() => applyKitUpgrade(lockfileDrift), /File changed after upgrade planning/);
  writeFileSync(gameLock, 'updated lock\n');

  const blocked = await planKitUpgrade(game, async (name, directory) => {
    const published = await lookup(name, directory);
    return name === '@mpgd/adapter-ait'
      ? { version: '0.14.0', peerDependencies: { '@apps-in-toss/web-framework': '>=4' } }
      : published;
  });
  assert.ok(blocked.blockers.some((issue) => issue.includes('web-framework')));
  assert.throws(() => applyKitUpgrade(blocked), /blocked/);

  const optionalPeerLookup: LatestKitPackageLookup = async (name, directory) => {
    const published = await lookup(name, directory);
    return name === '@mpgd/adapter-capacitor'
      ? {
          version: '0.4.13',
          peerDependencies: { '@capacitor/core': '^9.0.0' },
          optionalPeerDependencies: ['@capacitor/core'],
        }
      : published;
  };
  const optionalPeerConflict = await planKitUpgrade(game, optionalPeerLookup);
  assert.ok(optionalPeerConflict.blockers.some((issue) => issue.includes('@capacitor/core')));
  writeJson(path.join(mobile, 'package.json'), { name: 'sample-mobile-shell' });
  const absentOptionalPeer = await planKitUpgrade(game, optionalPeerLookup);
  assert.ok(!absentOptionalPeer.blockers.some((issue) => issue.includes('@capacitor/core')));
  assert.ok(
    !absentOptionalPeer.notes.some((note) => note.includes('requires peer @capacitor/core')),
  );
  writeJson(path.join(mobile, 'package.json'), {
    name: 'sample-mobile-shell',
    dependencies: { '@capacitor/core': '8.5.1' },
  });

  const standalone = path.join(root, 'standalone');
  const standaloneGame = path.join(standalone, 'game');
  mkdirSync(standaloneGame, { recursive: true });
  writeJson(path.join(standaloneGame, 'package.json'), {
    name: 'standalone-game',
    devDependencies: { '@mpgd/cli': '0.33.2' },
  });
  writeFileSync(path.join(standalone, 'pnpm-lock.yaml'), 'foreign lock\n');
  writeFileSync(path.join(standaloneGame, 'pnpm-lock.yaml'), 'owned lock\n');
  const noGitPlan = await planKitUpgrade(standaloneGame, lookup);
  assert.deepEqual(noGitPlan.workspaceRoots, [standaloneGame]);
  assert.ok(noGitPlan.notes.some((note) => note.includes('No git boundary')));
  const createdTargets = path.join(standaloneGame, 'mpgd.targets.json');
  writeJson(createdTargets, { targets: {} });
  assert.throws(() => applyKitUpgrade(noGitPlan), /File changed after upgrade planning/);
  unlinkSync(createdTargets);

  writeJson(gamePackage, {
    name: 'sample-game',
    dependencies: { '@mpgd/adapter-browser&echo': '0.1.0' },
  });
  const invalidName = await planKitUpgrade(game, lookup);
  assert.ok(invalidName.blockers.some((issue) => issue.includes('Invalid Kit package name')));

  writeJson(gamePackage, {
    name: 'sample-game',
    dependencies: { '@mpgd/adapter-browser': '>=0.7.0' },
  });
  const unsupportedRange = await planKitUpgrade(game, lookup);
  assert.ok(
    unsupportedRange.blockers.some((issue) => issue.includes('Unsupported Kit version range')),
  );

  writeJson(gamePackage, { name: 'sample-game', dependencies: { phaser: '4.2.1' } });
  writeJson(wrapperPackage, { name: 'sample-wrapper', dependencies: {} });
  const command = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'kit',
      'upgrade',
      '--game',
      game,
      '--targets-file',
      'config/alternate.targets.json',
      '--json',
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
  );
  assert.ifError(command.error);
  assert.equal(command.status, 0, command.stderr);
  assert.doesNotMatch(command.stdout, /^mpgd /m, 'JSON output must not include a banner');
  const output = JSON.parse(command.stdout) as {
    plan: { updates: unknown[]; targetAdvisories: unknown[] };
    result: unknown;
  };
  assert.equal(output.plan.updates.length, 0);
  assert.ok(Array.isArray(output.plan.targetAdvisories));
  assert.equal(output.result, null);
  const textCommand = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'kit',
      'upgrade',
      '--game',
      game,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
  );
  assert.ifError(textCommand.error);
  assert.equal(textCommand.status, 0, textCommand.stderr);
  assert.match(textCommand.stdout, /Target advisory \[ios\]: Product COIN_PACK/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Kit consumer upgrade planning, rollback, peer and CLI smoke passed');

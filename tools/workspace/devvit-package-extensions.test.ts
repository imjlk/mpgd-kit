import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

import {
  checkDevvitPackageExtensions,
  devvitPackageExtensions,
  devvitProtosLongVersion,
  selectorPackageName,
} from './devvit-package-extensions';

const workspaceFiles = [
  'pnpm-workspace.yaml',
  'packages/cli/templates/phaser-game/pnpm-workspace.yaml',
] as const;

// Run from the repository root (`pnpm test:tooling`). CI may run the emitted
// copy of this file, so paths are not taken from import.meta.url.
function readRepositoryFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function pinnedDevvitVersion(): string {
  const manifest = JSON.parse(readRepositoryFile('apps/target-devvit/package.json')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const version = manifest.dependencies?.['@devvit/web'];
  assert.ok(version !== undefined, 'apps/target-devvit pins @devvit/web');
  return version;
}

function check(packageExtensions: unknown, devvitVersion = '0.15.4'): string[] {
  return checkDevvitPackageExtensions({
    path: 'pnpm-workspace.yaml',
    workspace: { packages: ['apps/*'], packageExtensions },
    devvitVersion,
  });
}

await test('the extensions for the pinned version pass', () => {
  assert.deepEqual(check(devvitPackageExtensions('0.15.4')), []);
  assert.deepEqual(Object.keys(devvitPackageExtensions('0.15.4')).sort(), [
    '@devvit/build-pack@0.15.4',
    '@devvit/media@0.15.4',
    '@devvit/protos@0.15.4',
  ]);
});

await test('a workspace without them fails for each entry', () => {
  const failures = checkDevvitPackageExtensions({
    path: 'pnpm-workspace.yaml',
    workspace: { packages: ['apps/*'] },
    devvitVersion: '0.15.4',
  });
  assert.equal(failures.length, 3);
  for (const selector of Object.keys(devvitPackageExtensions('0.15.4'))) {
    assert.ok(
      failures.some((failure) => failure.includes(`must declare '${selector}'`)),
      selector,
    );
  }
  assert.deepEqual(check([]), ['pnpm-workspace.yaml: packageExtensions must be a mapping.']);
});

await test('a Devvit bump that leaves the keys behind fails', () => {
  const previous = devvitPackageExtensions('0.15.4');
  const failures = check(previous, '0.15.5').join('\n');
  for (const name of ['@devvit/build-pack', '@devvit/media', '@devvit/protos']) {
    assert.match(failures, new RegExp(`must declare '${name}@0\\.15\\.5'`, 'u'));
    assert.match(failures, new RegExp(`'${name}@0\\.15\\.4' is not an extension Devvit`, 'u'));
  }
  // Adding the new keys next to the old ones still leaves stale keys.
  const both = check({ ...previous, ...devvitPackageExtensions('0.15.5') }, '0.15.5');
  assert.equal(both.length, 3);
  assert.ok(both.every((failure) => /@0\.15\.4' is not an extension Devvit 0\.15\.5/u.test(failure)));
});

await test('a range key or another dependency version fails', () => {
  const pinned = devvitPackageExtensions('0.15.4');
  const range = { dependencies: { '@devvit/shared-types': '0.15.4' } };
  assert.match(
    check({ ...pinned, '@devvit/media@0.15.x': range }).join('\n'),
    /'@devvit\/media@0\.15\.x' is not an extension/u,
  );
  assert.match(
    check({ ...pinned, devvit: { dependencies: { '@devvit/cli': '0.15.4' } } }).join('\n'),
    /'devvit' is not an extension/u,
  );
  assert.match(
    check({
      ...pinned,
      '@devvit/media@0.15.4': { dependencies: { '@devvit/shared-types': '0.15.3' } },
    }).join('\n'),
    /'@devvit\/media@0\.15\.4' must be .*0\.15\.4.*not .*0\.15\.3/u,
  );
  assert.match(
    check({ ...pinned, '@devvit/protos@0.15.4': { dependencies: { long: '^5.0.0' } } }).join('\n'),
    /'@devvit\/protos@0\.15\.4' must be/u,
  );
});

await test('extensions of other packages are not checked', () => {
  assert.deepEqual(
    check({
      ...devvitPackageExtensions('0.15.4'),
      '@astryxdesign/core@0.7.10': { peerDependencies: { '@types/react': '>=19.0.0' } },
      'devvit-like@1.0.0': { dependencies: { long: '5.3.2' } },
    }),
    [],
  );
});

await test('selectors name their package', () => {
  assert.equal(selectorPackageName('devvit'), 'devvit');
  assert.equal(selectorPackageName('devvit@0.15.4'), 'devvit');
  assert.equal(selectorPackageName('@devvit/media'), '@devvit/media');
  assert.equal(selectorPackageName('@devvit/media@0.15.x'), '@devvit/media');
  assert.equal(selectorPackageName('@devvitx/media@1.0.0'), '@devvitx/media');
});

await test('the kit root and the game template declare the pinned extensions', () => {
  const pinned = pinnedDevvitVersion();
  for (const path of workspaceFiles) {
    // The template renders this placeholder to extra workspace globs or nothing.
    const source = readRepositoryFile(path).replaceAll('__PNPM_WORKSPACE_KIT_PACKAGES__', '');
    assert.deepEqual(
      checkDevvitPackageExtensions({ path, workspace: parseYaml(source), devvitVersion: pinned }),
      [],
    );
  }
});

await test('the kit lockfile resolves every extension, and protos shares long with protobufjs', () => {
  const lock = parseYaml(readRepositoryFile('pnpm-lock.yaml')) as {
    readonly snapshots: Readonly<
      Record<string, { readonly dependencies?: Readonly<Record<string, string>> } | null>
    >;
  };
  const pinned = pinnedDevvitVersion();
  const withoutPeers = (version: string | undefined) => version?.replace(/\(.*$/u, '');
  const snapshotsOf = (selector: string) =>
    Object.entries(lock.snapshots).filter(
      ([key]) => key === selector || key.startsWith(`${selector}(`),
    );
  for (const [selector, extension] of Object.entries(devvitPackageExtensions(pinned))) {
    const snapshots = snapshotsOf(selector);
    assert.ok(snapshots.length > 0, `${selector} is not in pnpm-lock.yaml`);
    for (const [key, snapshot] of snapshots) {
      for (const [name, version] of Object.entries(extension.dependencies)) {
        assert.equal(withoutPeers(snapshot?.dependencies?.[name]), version, `${key} ${name}`);
      }
    }
  }
  for (const [key, snapshot] of snapshotsOf(`@devvit/protos@${pinned}`)) {
    const protobufjs = withoutPeers(snapshot?.dependencies?.protobufjs);
    assert.ok(protobufjs !== undefined, `${key} declares protobufjs`);
    const runtimes = snapshotsOf(`protobufjs@${protobufjs}`);
    assert.ok(runtimes.length > 0, `protobufjs@${protobufjs} is not in pnpm-lock.yaml`);
    for (const [runtimeKey, runtime] of runtimes) {
      assert.equal(withoutPeers(runtime?.dependencies?.long), devvitProtosLongVersion, runtimeKey);
    }
  }
});

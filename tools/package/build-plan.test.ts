import assert from 'node:assert/strict';
import { planPackageShard, selectBuildablePackages } from './build-plan';
import { discoverBuildablePackages, type WorkspacePackage } from './workspace';

const fixture = (name: string): WorkspacePackage => ({
  name,
  dir: `packages/${name.split('/')[1]}`,
  packageJsonPath: `packages/${name.split('/')[1]}/package.json`,
  packageJson: { name },
});
const core = fixture('@mpgd/core');
const dev = fixture('@mpgd/dev');
const peer = fixture('@mpgd/peer');
const create = {
  ...fixture('@mpgd/create-game'),
  packageJson: {
    dependencies: { '@mpgd/core': 'workspace:*', external: '1.0.0' },
    devDependencies: { '@mpgd/dev': 'workspace:*' },
    peerDependencies: { '@mpgd/peer': 'workspace:*' },
  },
};
const extra = {
  ...fixture('@mpgd/extra'),
  packageJson: { dependencies: { '@mpgd/core': 'workspace:*' } },
};
const available = [create, extra, core, dev, peer];
const names = (items: readonly WorkspacePackage[]) => items.map((item) => item.name).sort();
assert.deepEqual(
  names(selectBuildablePackages(available, [create.name])),
  names([create, core, dev, peer]),
);
assert.deepEqual(selectBuildablePackages(available, []), []);
assert.throws(() => selectBuildablePackages(available, ['missing']), /Unknown buildable/);
assert.throws(() => planPackageShard(available, 'unknown'), /Unknown package shard/);
assert.throws(() => planPackageShard([core], 'starter'), /Unknown buildable/);

const starter = planPackageShard(available, 'starter');
const remaining = planPackageShard(available, 'remaining');
assert.deepEqual(names(starter.packages), names([create, core, dev, peer]));
assert.deepEqual(names(remaining.packages), names([extra, core]));
assert.deepEqual(remaining.manifest.owned, ['packages/extra/dist']);
assert.ok(
  !remaining.manifest.owned.includes('packages/core/dist'),
  'shared dependencies have one artifact owner',
);
assert.deepEqual(starter.manifest.inventory, remaining.manifest.inventory);

// New packages automatically enter one shard; a new dependency of the starter
// moves ownership without changing exhaustive coverage or transfer collisions.
const extended = [...available, fixture('@mpgd/new-package')];
assert.ok(
  planPackageShard(extended, 'remaining').manifest.owned.includes('packages/new-package/dist'),
);
const moved = available.map((item) =>
  item === create
    ? {
        ...create,
        packageJson: { ...create.packageJson, dependencies: { '@mpgd/extra': 'workspace:*' } },
      }
    : item,
);
assert.ok(planPackageShard(moved, 'starter').manifest.owned.includes('packages/extra/dist'));
assert.deepEqual(planPackageShard(moved, 'remaining').packages, []);

const actual = discoverBuildablePackages();
const actualStarter = planPackageShard(actual, 'starter');
const actualRemaining = planPackageShard(actual, 'remaining');
const owned = [...actualStarter.manifest.owned, ...actualRemaining.manifest.owned];
assert.equal(new Set(owned).size, owned.length, 'no dist is transferred twice');
assert.deepEqual([...owned].sort(), [...actualStarter.manifest.inventory].sort());
assert.equal(owned.length, actual.length, 'every buildable package is transferred');
assert.ok(actualStarter.manifest.owned.includes('packages/cli/dist'));
for (const plan of [actualStarter, actualRemaining]) {
  assert.ok(
    plan.manifest.owned.every((path) =>
      plan.packages.some((item) => `${item.dir.replaceAll('\\', '/')}/dist` === path),
    ),
  );
}
process.stdout.write('Package shard plan tests passed.\n');

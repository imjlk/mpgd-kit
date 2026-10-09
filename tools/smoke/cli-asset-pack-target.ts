import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertAssetPackTargetPolicy,
  createAssetPackTargetURLResolver,
  resolveAssetPackLocations,
  type AssetPackTargetPolicy,
} from '@mpgd/target-config/asset-packs';
import {
  assertAssetPackTargetArtifact,
  assertAssetPackTargetOutput,
  assetPackTargetNamespace,
  buildAssetPackTarget,
} from '../../packages/cli/src/asset-pack-target';
import { assertAssetPackNativeArtifact } from '../../packages/cli/src/asset-pack-native-audit';
import { createDeterministicZip } from '../../packages/cli/src/asset-pack-zip';
import { createEffectiveTargetConfig } from '../../packages/target-config/src/effective';
import { readFileSync } from 'node:fs';
import type { TargetConfigMatrix } from '../../packages/target-config/src/runtime';
import type { AdPlacements, ProductCatalog } from '../../packages/catalog/src/index';

const root = await mkdtemp(join(tmpdir(), 'mpgd-asset-target-smoke-'));
const fixtureConfig = resolve('examples/asset-packs/delivery-configs/mixed.json');
const policy: AssetPackTargetPolicy = {
  buildConfig: fixtureConfig,
  defaultLocation: 'remote',
  offlineRequired: ['grove'],
  remoteBaseUrl: 'https://cdn.example.test/release-1/',
  maxPackagedBytes: 1024 * 1024,
};
try {
  const bundled = await buildAssetPackTarget({
    policy: { ...policy, defaultLocation: 'packaged' },
    baseDir: '.',
    outDir: join(root, 'bundled'),
  });
  const mixed = await buildAssetPackTarget({ policy, baseDir: '.', outDir: join(root, 'mixed') });
  assert.deepEqual(
    { ...mixed.locations },
    { shared: 'packaged', sound: 'remote', grove: 'packaged', dunes: 'remote' },
  );
  assert.ok(mixed.packagedBytes < bundled.packagedBytes);
  assert.equal(mixed.packagedAssetBytes + mixed.remoteBytes, bundled.packagedAssetBytes);
  const manifest = JSON.parse(
    await readFile(join(mixed.packagedDir, 'asset-pack-delivery.json'), 'utf8'),
  );
  const runtimePolicy = JSON.parse(
    await readFile(join(mixed.packagedDir, 'target-policy.json'), 'utf8'),
  );
  assert.equal(
    runtimePolicy.buildConfig,
    undefined,
    'Deployment metadata contains no local source paths',
  );
  const url = createAssetPackTargetURLResolver(
    runtimePolicy,
    manifest.packs,
    'capacitor://localhost/mpgd-asset-packs/',
  );
  assert.equal(
    url('packs/grove/a%20%23%3F.png', {
      packId: 'grove',
      revision: manifest.packs.find((p: { packId: string }) => p.packId === 'grove').revision,
    }),
    'capacitor://localhost/mpgd-asset-packs/packs/grove/a%20%23%3F.png',
  );
  const dunes = manifest.packs.find((p: { packId: string }) => p.packId === 'dunes');
  assert.equal(
    url('packs/dunes/a.png', dunes),
    'https://cdn.example.test/release-1/packs/dunes/a.png',
  );
  for (const path of ['../a', '%2e%2e/a', 'https:evil', '//evil/a', 'a?secret', 'a/%2foutside']) {
    assert.throws(() => url(path, dunes), /relative artifact path/);
  }
  assert.throws(() => url('a.png', { ...dunes, revision: 'old' }), /revision/);
  assert.throws(
    () => resolveAssetPackLocations({ ...policy, packs: { shared: 'remote' } }, manifest.packs),
    /Offline-required dependency/,
  );
  assert.throws(
    () => resolveAssetPackLocations({ ...policy, packs: { missing: 'packaged' } }, manifest.packs),
    /Unknown asset pack override/,
  );
  assert.throws(
    () => resolveAssetPackLocations({ defaultLocation: 'remote' }, manifest.packs),
    /remoteBaseUrl/,
  );
  assert.throws(
    () => assertAssetPackTargetPolicy({ ...policy, credentials: 'never-client' }),
    /unknown field/,
  );
  for (const remoteBaseUrl of [
    'http://cdn.example.test/',
    'https://user:secret@cdn.example.test/',
    'https://cdn.example.test/?token=secret',
    'https://cdn.example.test/assets',
  ]) {
    assert.throws(() => assertAssetPackTargetPolicy({ ...policy, remoteBaseUrl }));
  }
  assertAssetPackTargetPolicy({ ...policy, remoteBaseUrl: 'http://127.0.0.1:9000/assets/' });
  await assert.rejects(
    buildAssetPackTarget({
      policy: { ...policy, maxPackagedBytes: 1 },
      baseDir: '.',
      outDir: join(root, 'too-big'),
    }),
    /exceeds its budget/,
  );
  await assert.rejects(
    buildAssetPackTarget({ policy, baseDir: '.', outDir: mixed.outDir }),
    /already exists/,
  );
  await assert.rejects(
    buildAssetPackTarget({
      policy,
      baseDir: '.',
      outDir: resolve('examples/asset-packs/asset-source/new-deployment'),
    }),
    /original asset source root/,
  );
  await symlink(root, join(root, 'link'));
  await assert.rejects(
    buildAssetPackTarget({ policy, baseDir: '.', outDir: join(root, 'link', 'symlink-output') }),
    /symbolic link/,
  );
  const artifact = join(root, 'artifact');
  await mkdir(artifact);
  await cp(mixed.packagedDir, join(artifact, assetPackTargetNamespace), { recursive: true });
  await assertAssetPackTargetArtifact(mixed, artifact);
  const wideRoot = join(root, 'wide-source');
  await mkdir(wideRoot);
  const wideConfig = join(wideRoot, 'packs.json');
  await writeFile(
    wideConfig,
    JSON.stringify({ ...JSON.parse(await readFile(fixtureConfig, 'utf8')), root: '.' }),
  );
  const marker = join(wideRoot, 'source-marker');
  await writeFile(marker, 'preserve');
  await assert.rejects(
    assertAssetPackTargetOutput({
      policy: { ...policy, buildConfig: wideConfig },
      baseDir: '.',
      outDir: join(wideRoot, 'artifacts/asset-packs/preview'),
    }),
    /original asset source root/,
  );
  assert.equal(await readFile(marker, 'utf8'), 'preserve');

  const nativeEntries = [];
  for (const object of mixed.objects.filter((object) => object.location === 'packaged')) {
    nativeEntries.push({
      path: object.path,
      data: await readFile(join(mixed.packagedDir, object.path)),
      method: 'deflate' as const,
    });
  }
  for (const name of ['asset-pack-delivery.json', 'target-policy.json']) {
    nativeEntries.push({
      path: name,
      data: await readFile(join(mixed.packagedDir, name)),
      method: 'deflate' as const,
    });
  }
  for (const [extension, prefix] of [
    ['apk', 'assets/public'],
    ['aab', 'base/assets/public'],
    ['ipa', 'Payload/Example.app/public'],
  ] as const) {
    const file = join(root, `native.${extension}`);
    const entries = nativeEntries.map((entry) => ({
      ...entry,
      path: `${prefix}/${assetPackTargetNamespace}/${entry.path}`,
    }));
    await writeFile(file, createDeterministicZip(entries));
    await assertAssetPackNativeArtifact(mixed, file);
    const remoteObject = mixed.objects.find((object) => object.location === 'remote')!;
    await writeFile(
      file,
      createDeterministicZip([
        ...entries,
        {
          path: 'res/raw/remote-copy.bin',
          data: await readFile(join(mixed.remoteDir, remoteObject.path)),
          method: 'store',
        },
      ]),
    );
    await assert.rejects(assertAssetPackNativeArtifact(mixed, file), /Remote-only/);
    await writeFile(
      file,
      createDeterministicZip(entries.map((entry) => ({ ...entry, path: 'wrong/' + entry.path }))),
    );
    await assert.rejects(assertAssetPackNativeArtifact(mixed, file), /outside the platform/);
  }
  const embedded = join(root, 'embedded');
  await mkdir(join(embedded, 'game'), { recursive: true });
  await cp(mixed.packagedDir, join(embedded, 'game', assetPackTargetNamespace), {
    recursive: true,
  });
  await assertAssetPackTargetArtifact(mixed, embedded, `game/${assetPackTargetNamespace}`);
  await assert.rejects(
    assertAssetPackTargetArtifact(mixed, embedded, '../outside'),
    /inside the target artifact/,
  );
  const remote = mixed.objects.find((object) => object.location === 'remote')!;
  await cp(join(mixed.remoteDir, remote.path), join(artifact, 'unexpected-copy.bin'));
  await assert.rejects(assertAssetPackTargetArtifact(mixed, artifact), /Remote-only/);
  await rm(join(artifact, 'unexpected-copy.bin'));
  const local = mixed.objects.find((object) => object.location === 'packaged')!;
  await writeFile(join(artifact, assetPackTargetNamespace, local.path), Buffer.alloc(local.bytes));
  await assert.rejects(assertAssetPackTargetArtifact(mixed, artifact), /object changed/);

  const matrix = JSON.parse(
    readFileSync('packages/target-config/targets.json', 'utf8'),
  ) as TargetConfigMatrix;
  const effective = createEffectiveTargetConfig({
    target: 'web-preview',
    targetConfigVersion: matrix.version,
    config: matrix.targets['web-preview']!,
    catalog: { version: '1', products: [] } as ProductCatalog,
    adPlacements: { version: '1', placements: [] } as AdPlacements,
    platformTarget: { kind: 'web', adapter: 'browser', assetPacks: policy },
  });
  assert.deepEqual(effective.assetPacks, policy);
  const targetsFile = join(root, 'mpgd.targets.json');
  await writeFile(targetsFile, JSON.stringify({ targets: { browser: { assetPacks: policy } } }));
  const cli = spawnSync(
    process.execPath,
    [
      resolve('packages/cli/dist/bin.js'),
      'assets',
      'stage-target',
      '--targets-file',
      targetsFile,
      '--target',
      'browser',
      '--out',
      join(root, 'installed-cli'),
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).packagedBytes, mixed.packagedBytes);
  console.info(
    'Asset target policy smoke passed: dependency closure, bytes, actual exclusion, revision routing, bounded stage and installed CLI.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

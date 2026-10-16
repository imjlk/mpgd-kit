import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { test } from 'node:test';
import packageArg from 'npm-package-arg';
import { parse as parseYaml } from 'yaml';

import {
  assertOutsideKit,
  assertConsumerMetadata,
  assertRegistryOnly,
  consumerEnvironment,
  exactVersion,
  isWithin,
  publishedMetadata,
} from './published-starter-consumer.mjs';

await test('consumer drops source loaders, credentials and checkout executables', () => {
  const checkout = resolve('fixture-kit');
  const external = resolve('toolchain');
  const cleaned = consumerEnvironment(
    {
      PATH: [resolve(checkout, 'node_modules/.bin'), external].join(delimiter),
      MPGD_KIT_PATH: checkout,
      MPGD_CI_EMIT_ROOT: checkout,
      TTSC_RUNNER_PROJECT: 'tsconfig.json',
      TTSC_GO_BINARY: resolve(external, 'go'),
      NPM_CONFIG_REGISTRY: 'https://private.invalid',
      npm_config_workspace_dir: checkout,
      NODE_OPTIONS: '--import source-loader',
      NODE_PATH: checkout,
      NODE_AUTH_TOKEN: 'fixture-token',
      npm_token: 'fixture-token',
      INIT_CWD: checkout,
      GITHUB_RUN_ID: '123',
    },
    checkout,
  );
  assert.deepEqual(cleaned, {
    PATH: external,
    TTSC_GO_BINARY: resolve(external, 'go'),
    GITHUB_RUN_ID: '123',
  });
});

await test('only immutable stable versions are accepted', () => {
  assert.equal(exactVersion('0.50.0'), '0.50.0');
  for (const version of ['latest', '^0.50.0', '0.50.0;echo nope', '../local', '01.2.3', '1.0.0-beta.1']) {
    assert.throws(() => exactVersion(version));
  }
});

await test('publication waits for both full and abbreviated install metadata', async () => {
  const name = '@mpgd/cli';
  const version = '0.50.1';
  const dist = { integrity: 'sha512-fixture', tarball: 'https://registry.npmjs.org/cli.tgz' };
  let pauses = 0;
  const requests: string[] = [];
  const metadata = await publishedMetadata(name, version, async (input, init) => {
      assert.equal(String(input), 'https://registry.npmjs.org/@mpgd%2Fcli');
    const accept = new Headers(init?.headers).get('accept') ?? '';
    requests.push(accept);
    const visible = accept === 'application/json' || pauses > 0;
    return Response.json({
      name,
      'dist-tags': { latest: version },
      versions: visible ? { [version]: { name, version, dist } } : {},
    });
  }, () => {
    pauses++;
    return Promise.resolve();
  });
  assert.equal(pauses, 1);
  assert.deepEqual(new Set(requests), new Set(['application/json', 'application/vnd.npm.install-v1+json']));
  assert.deepEqual(metadata, { name, version, ...dist });
});

await test('checkout executable aliases are removed from the consumer PATH', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'mpgd-consumer-path-'));
  try {
    const checkout = resolve(fixture, 'checkout');
    const external = resolve(fixture, 'toolchain');
    const alias = resolve(fixture, 'checkout-alias');
    mkdirSync(checkout);
    mkdirSync(external);
    symlinkSync(checkout, alias, 'junction');
    const cleaned = consumerEnvironment({ PATH: [alias, external].join(delimiter) }, checkout);
    assert.equal(cleaned.PATH, external);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

await test('consumer dependencies cannot be replaced with local or remote source', () => {
  for (const spec of ['0.9.12', '^1.2.3', '>=1 <3', 'latest', 'npm:@mpgd/cli@0.50.1']) {
    assertRegistryOnly({ '@mpgd/cli': spec }, packageArg.resolve);
  }
  for (const spec of [
    'workspace:*', 'file:../packs/a.tgz', 'link:C:/kit', 'portal:../kit', 'patch:pkg@1.0.0',
    'github:imjlk/mpgd-kit', 'gitlab:org/pkg', 'bitbucket:org/pkg', 'org/pkg#main',
    'git://github.com/org/pkg.git', 'git+https://github.com/org/pkg.git',
    'git@github.com:org/pkg.git', 'ssh://git@github.com/org/pkg.git',
    'https://example.com/a.tgz', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
    '../pkg', './pkg', '/tmp/pkg', 'C:\\kit', '\\\\server\\share', '~/pkg', 'pkg.tgz',
    'npm:pkg@file:../pkg',
  ]) {
    assert.throws(() => assertRegistryOnly({ '@mpgd/cli': spec }, packageArg.resolve), spec);
  }
});

await test('workspace overrides, catalogs and extensions cannot inject other sources', () => {
  assertConsumerMetadata(parseYaml("packages: ['.', 'apps/*']\nallowBuilds: { esbuild: true }\noverrides: { '@xmldom/xmldom': '0.9.12' }"), packageArg.resolve);
  for (const metadata of [
    { dependencies: { pkg: '../pkg' } },
    { devDependencies: { pkg: 'org/pkg' } },
    { optionalDependencies: { pkg: 'gitlab:org/pkg' } },
    { peerDependencies: { pkg: 'file:../pkg' } },
    { pnpm: { overrides: { 'parent>pkg': 'git://github.com/org/pkg.git' } } },
    { catalog: { pkg: 'bitbucket:org/pkg' } },
    { catalogs: { test: { pkg: '../pkg' } } },
    { packageExtensions: { 'parent@*': { dependencies: { pkg: 'link:../pkg' } } } },
    { patchedDependencies: { 'pkg@1.0.0': 'patches/pkg.patch' } },
  ]) {
    assert.throws(() => assertConsumerMetadata(metadata, packageArg.resolve));
  }
  assert.throws(() => assertConsumerMetadata(parseYaml('overrides:\n  pkg: "gitlab:org/pkg"\n'), packageArg.resolve));
});

await test('containment distinguishes siblings and ancestors', () => {
  const root = resolve('consumer');
  assert.equal(isWithin(root, resolve(root, 'node_modules')), true);
  assert.equal(isWithin(root, resolve('consumer-other')), false);
  assert.equal(isWithin(root, resolve(root, '..')), false);
});

await test('consumer cannot discover a different Kit checkout through its ancestors', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'mpgd-consumer-parent-'));
  try {
    const child = resolve(fixture, 'nested');
    mkdirSync(child);
    assertOutsideKit(child);
    writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ name: 'mpgd-kit' }));
    assert.throws(() => assertOutsideKit(child), /adjacent Kit checkout/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

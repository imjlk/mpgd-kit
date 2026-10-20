import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { test } from 'node:test';
import packageArg from 'npm-package-arg';
import { parse as parseYaml } from 'yaml';

import {
  assertConsumerMetadata,
  assertGeneratedManifests,
  assertOutsideKit,
  assertRegistryOnly,
  awaitPublishedPackageSpecs,
  collectPublishedPackageSpecs,
  consumerEnvironment,
  exactVersion,
  isWithin,
  publishedMetadata,
  retryTransientTarball404,
  selectPublishedVersion,
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
    if (String(input) === dist.tarball) {
      return new Response('', { status: 200 });
    }
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

await test('publication retries until the registry tarball is fetchable', async () => {
  const name = '@mpgd/adapter-browser';
  const version = '0.11.4';
  const tarball = 'https://registry.npmjs.org/@mpgd/adapter-browser/-/adapter-browser-0.11.4.tgz';
  const dist = { integrity: 'sha512-fixture', tarball };
  let pauses = 0;
  let tarballMisses = 0;
  const metadata = await publishedMetadata(name, version, async (input) => {
    if (String(input) === tarball) {
      tarballMisses++;
      if (tarballMisses < 3) {
        return new Response('', { status: 404 });
      }
      return new Response('', { status: 200 });
    }
    return Response.json({ name, versions: { [version]: { name, version, dist } } });
  }, () => {
    pauses++;
    return Promise.resolve();
  });
  assert.ok(tarballMisses >= 3, 'metadata visibility must not skip a missing tarball');
  assert.ok(pauses >= 1, 'a tarball 404 must use the publication backoff');
  assert.equal(metadata.tarball, tarball);
});

await test('publication retries when disposing a tarball response fails', async () => {
  const name = '@mpgd/cli';
  const version = '0.50.1';
  const tarball = 'https://registry.npmjs.org/cli.tgz';
  const dist = { integrity: 'sha512-fixture', tarball };
  let tarballProbes = 0;
  const metadata = await publishedMetadata(name, version, async (input) => {
    if (String(input) === tarball) {
      tarballProbes += 1;
      if (tarballProbes === 1) {
        return new Response(new ReadableStream({
          cancel() {
            return Promise.reject(new TypeError('socket closed while cancelling tarball'));
          },
        }), { status: 200 });
      }
      return new Response('', { status: 200 });
    }
    return Response.json({ name, versions: { [version]: { name, version, dist } } });
  }, () => Promise.resolve());
  assert.ok(tarballProbes >= 2, 'a cancel failure must not skip the next tarball probe');
  assert.equal(metadata.tarball, tarball);
});

await test('publication retries network timeouts and transient registry responses', async () => {
  const name = '@mpgd/cli';
  const version = '0.50.1';
  const dist = { integrity: 'sha512-fixture', tarball: 'https://registry.npmjs.org/cli.tgz' };
  let pauses = 0;
  const metadata = await publishedMetadata(name, version, async () => {
    if (pauses === 0) {
      throw new TypeError('fetch failed: socket closed');
    }
    if (pauses === 1) {
      return new Response('', { status: 500 });
    }
    if (pauses === 2) {
      return new Response('', { status: 502 });
    }
    if (pauses === 3) {
      throw new DOMException('request timed out', 'TimeoutError');
    }
    if (pauses === 4) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError('socket closed while reading metadata'));
        },
      }));
    }
    return Response.json({ name, versions: { [version]: { name, version, dist } } });
  }, () => {
    pauses++;
    return Promise.resolve();
  });
  assert.equal(pauses, 5);
  assert.deepEqual(metadata, { name, version, ...dist });
  await assert.rejects(publishedMetadata(name, version, async () => new Response('', { status: 401 })), /npm metadata failed: 401/);
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

await test('all generated workspace manifests are validated before installation', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'mpgd-consumer-manifests-'));
  try {
    const app = resolve(fixture, 'apps/target-ait');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      resolve(fixture, 'package.json'),
      JSON.stringify({ dependencies: { pkg: '^1.0.0' } }),
    );
    writeFileSync(
      resolve(app, 'package.json'),
      JSON.stringify({ devDependencies: { pkg: '2.0.0' } }),
    );
    assertGeneratedManifests(fixture, packageArg.resolve);
    for (const spec of ['gitlab:org/pkg', '../pkg', 'https://example.com/pkg.tgz']) {
      writeFileSync(resolve(app, 'package.json'), JSON.stringify({ dependencies: { pkg: spec } }));
      assert.throws(() => assertGeneratedManifests(fixture, packageArg.resolve));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

await test('containment distinguishes siblings and ancestors', () => {
  const root = resolve('consumer');
  assert.equal(isWithin(root, resolve(root, 'node_modules')), true);
  assert.equal(isWithin(root, resolve('consumer-other')), false);
  assert.equal(isWithin(root, resolve(root, '..')), false);
});

await test('install retries only transient npm tarball 404s', async () => {
  let pauses = 0;
  let calls = 0;
  const recovered = await retryTransientTarball404(async () => {
    calls++;
    if (calls < 3) {
      return {
        status: 1,
        stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@mpgd/adapter-browser/-/adapter-browser-0.11.4.tgz',
      };
    }
    return { status: 0, stdout: 'ok' };
  }, async () => {
    pauses++;
  });
  assert.equal(calls, 3);
  assert.equal(pauses, 2);
  assert.equal(recovered.status, 0);
  const fatalCalls = calls;
  const fatal = await retryTransientTarball404(async () => {
    calls++;
    return { status: 1, stderr: 'ERR_PNPM_UNEXPECTED_STORE' };
  }, async () => {
    pauses++;
  });
  assert.equal(calls, fatalCalls + 1);
  assert.equal(pauses, 2);
  assert.equal(fatal.status, 1);
});

await test('generated caret specs wait for the highest matching tarball', async () => {
  assert.equal(selectPublishedVersion(['0.11.3', '0.11.4', '0.12.0'], '^0.11.4'), '0.11.4');
  assert.equal(selectPublishedVersion(['1.2.3', '1.9.0', '2.0.0'], '^1.2.3'), '1.9.0');
  assert.equal(selectPublishedVersion(['0.0.4', '0.0.5'], '^0.0.4'), '0.0.4');
  assert.equal(selectPublishedVersion(['0.11.3'], '0.11.4'), undefined);
  const fixture = mkdtempSync(resolve(tmpdir(), 'mpgd-published-specs-'));
  try {
    const app = resolve(fixture, 'apps/target-web');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({
      dependencies: { '@mpgd/adapter-browser': '^0.11.4', phaser: '^4.0.0' },
    }));
    writeFileSync(resolve(app, 'package.json'), JSON.stringify({
      devDependencies: { '@mpgd/cli': '0.52.0' },
    }));
    assert.deepEqual(collectPublishedPackageSpecs(fixture), [
      { name: '@mpgd/adapter-browser', spec: '^0.11.4' },
      { name: '@mpgd/cli', spec: '0.52.0' },
    ]);
    const tarball = 'https://registry.npmjs.org/@mpgd/adapter-browser/-/adapter-browser-0.11.4.tgz';
    let misses = 0;
    await awaitPublishedPackageSpecs(collectPublishedPackageSpecs(fixture).filter((spec) => spec.name === '@mpgd/adapter-browser'), async (input) => {
      if (String(input) === tarball) {
        misses++;
        return new Response('', { status: misses < 2 ? 404 : 200 });
      }
      return Response.json({
        name: '@mpgd/adapter-browser',
        versions: {
          '0.11.3': {
            name: '@mpgd/adapter-browser',
            version: '0.11.3',
            dist: { integrity: 'sha512-old', tarball: 'https://registry.npmjs.org/old.tgz' },
          },
          '0.11.4': {
            name: '@mpgd/adapter-browser',
            version: '0.11.4',
            dist: { integrity: 'sha512-new', tarball },
          },
        },
      });
    }, async () => undefined);
    assert.ok(misses >= 2, 'caret resolution must probe the selected dist.tarball');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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

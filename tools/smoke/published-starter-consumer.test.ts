import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertOutsideKit,
  assertRegistryOnly,
  consumerEnvironment,
  exactVersion,
  isWithin,
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
  assertRegistryOnly("overrides:\n  '@xmldom/xmldom': '0.9.12'\n");
  for (const spec of ['workspace:*', 'file:../packs/a.tgz', 'link:C:/kit', 'github:imjlk/mpgd-kit', 'https://example.com/a.tgz']) {
    assert.throws(() => assertRegistryOnly(JSON.stringify({ '@mpgd/cli': spec })));
  }
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

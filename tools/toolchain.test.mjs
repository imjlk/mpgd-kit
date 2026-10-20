import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectNodePins, inspectToolchain } from './validate-toolchain.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-toolchain-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('package.json', { devDependencies: { ttsc: '1.2.3', '@ttsc/graph': '1.2.3' } });
  return { root, write };
}

test('checks shipped nested target templates while excluding installed and built files', (t) => {
  const { root, write } = fixture(t);
  write('packages/cli/templates/phaser-game/apps/target-ait/package.json', {
    devDependencies: { ttsc: '1.2.3', '@ttsc/unplugin': '1.2.3' },
  });
  for (const ignored of ['node_modules', 'dist', 'output']) {
    write(`packages/cli/${ignored}/nested/package.json`, { devDependencies: { ttsc: '0.1.0' } });
  }
  const result = inspectToolchain(root);
  assert.deepEqual(result.failures, []);
  assert.equal(result.declarations, 4);
  assert.equal(result.manifests, 2);
});

test('fails the command for a stale generated target or native package age exception', (t) => {
  const { root, write } = fixture(t);
  write('packages/cli/templates/phaser-game/apps/target-devvit/package.json', {
    devDependencies: { ttsc: '0.18.4', '@ttsc/unplugin': '^1.2.3' },
  });
  write('pnpm-workspace.yaml', "minimumReleaseAgeExclude:\n  - '@ttsc/darwin-arm64@0.18.4'\n  - 'other@0.18.4'\n");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./validate-toolchain.mjs', import.meta.url)), root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /target-devvit.*ttsc is 0\.18\.4/);
  assert.match(result.stderr, /@ttsc\/unplugin is \^1\.2\.3/);
  assert.match(result.stderr, /@ttsc\/darwin-arm64@0\.18\.4/);
  assert.doesNotMatch(result.stderr, /other@/);
});

test('rejects a floating root version instead of treating it as the baseline', (t) => {
  const { root, write } = fixture(t);
  write('package.json', { devDependencies: { ttsc: '^1.2.3' } });
  assert.throws(() => inspectToolchain(root), /exact.*ttsc version/);
});

test('requires CI setup-node to use the exact mise node pin', (t) => {
  const { root, write } = fixture(t);
  write('.mise.toml', '[tools]\nnode = "24.22.0"\n');
  write('package.json', { engines: { node: '>=24.0.0' }, devDependencies: { ttsc: '1.2.3' } });
  write('.github/workflows/ci.yml', 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@example\n        with:\n          node-version: 24\n');
  assert.match(inspectNodePins(root).failures.join('\n'), /ci\.yml:6 node-version is 24; expected 24\.22\.0/);
  write('.github/workflows/ci.yml', 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@example\n        with:\n          node-version: 24.22.0\n');
  assert.deepEqual(inspectNodePins(root).failures, []);
  write('package.json', { engines: { node: '>=24.23.0' }, devDependencies: { ttsc: '1.2.3' } });
  assert.match(inspectNodePins(root).failures.join('\n'), /engines\.node >=24\.23\.0/);
  write('package.json', { devDependencies: { ttsc: '1.2.3' } });
  assert.match(inspectNodePins(root).failures.join('\n'), /engines\.node must be a string range/);
  write('package.json', { engines: { node: 24 }, devDependencies: { ttsc: '1.2.3' } });
  assert.match(inspectNodePins(root).failures.join('\n'), /engines\.node must be a string range/);
});

test('rejects setup-node steps that omit node-version or use a non-literal value', (t) => {
  const { root, write } = fixture(t);
  write('.mise.toml', '[tools]\nnode = "24.22.0"\n');
  write('package.json', { engines: { node: '>=24.0.0' }, devDependencies: { ttsc: '1.2.3' } });
  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/setup-node@example',
    '        with:',
    '          cache: pnpm',
    '      - run: |',
    '          echo keep',
    '          node-version: 24.22.0',
    '',
  ].join('\n'));
  assert.match(
    inspectNodePins(root).failures.join('\n'),
    /ci\.yml:4 actions\/setup-node omits node-version; expected 24\.22\.0/,
  );

  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/checkout@example',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@example',
    '        with:',
    '          cache: pnpm',
    '',
  ].join('\n'));
  assert.match(
    inspectNodePins(root).failures.join('\n'),
    /ci\.yml:7 actions\/setup-node omits node-version; expected 24\.22\.0/,
  );

  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/setup-node@example',
    '        with:',
    '          cache-dependency-path: |',
    '            node-version: 24.22.0',
    '          cache: pnpm',
    '',
  ].join('\n'));
  assert.match(
    inspectNodePins(root).failures.join('\n'),
    /ci\.yml:4 actions\/setup-node omits node-version; expected 24\.22\.0/,
  );

  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Setup Node',
    '        uses: actions/setup-node@example',
    '        with:',
    '          node-version: ${{ matrix.node }}',
    '',
  ].join('\n'));
  assert.match(
    inspectNodePins(root).failures.join('\n'),
    /ci\.yml:7 node-version is \$\{?\{ matrix\.node \}\}; expected 24\.22\.0/,
  );

  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/setup-node@example',
    '        with:',
    "          node-version: '${{ env.NODE_VERSION }}'",
    '',
  ].join('\n'));
  assert.match(
    inspectNodePins(root).failures.join('\n'),
    /ci\.yml:6 node-version is \$\{?\{ env\.NODE_VERSION \}\}; expected 24\.22\.0/,
  );

  write('.github/workflows/ci.yml', [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/checkout@example',
    '        with:',
    '          persist-credentials: false',
    '      - name: Setup Node',
    '        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
    "        if: ${{ steps.meta.outputs.docs_only != 'true' }}",
    '        with:',
    "          node-version: '24.22.0'",
    '          cache: pnpm',
    '      - uses: jdx/mise-action@example',
    '',
  ].join('\n'));
  assert.deepEqual(inspectNodePins(root).failures, []);
});

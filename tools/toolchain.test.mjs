import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectToolchain } from './validate-toolchain.mjs';

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

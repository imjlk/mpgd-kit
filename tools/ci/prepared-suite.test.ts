import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { isObject } from '../validation/json.js';

import { preparedGroups, requiresTtsx, resolvePreparedScript } from './prepared-suite.js';

const packageJson: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
assert.ok(isObject(packageJson) && isObject(packageJson.scripts));
const packageScripts = packageJson.scripts;

await test('typed suite entry lists groups and rejects unknown groups through the runner', () => {
  const launch = (group: string) =>
    spawnSync(process.execPath, ['tools/run-ttsx.mjs', 'tools/ci/prepared-suite.ts', group], {
      encoding: 'utf8',
      timeout: 120_000,
    });
  const listed = launch('--list');
  assert.ifError(listed.error);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), preparedGroups);
  const rejected = launch('unknown-group');
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unknown prepared test group/);
});

await test('prepared groups retain all 64 commands exactly once', () => {
  const scripts = Object.values(preparedGroups).flat();
  assert.equal(scripts.length, 64);
  assert.ok(preparedGroups.cli.includes('smoke:cli-asset-pack-publish'));
  assert.ok(preparedGroups.cli.includes('smoke:cli-asset-pack-target'));
  assert.ok(preparedGroups.cli.includes('test:template-tools'));
  assert.ok(preparedGroups.cli.includes('test:devvit-sdk'));
  assert.ok(preparedGroups.cli.includes('smoke:cli-notifications-starter'));
  assert.ok(preparedGroups.cli.includes('smoke:cli-notifications-game'));
  assert.equal(new Set(scripts).size, scripts.length);
  assert.deepEqual(Object.keys(preparedGroups), ['contracts', 'cli', 'services']);
  for (const script of scripts) {
    assert.ok(packageScripts[script], `missing package script: ${script}`);
    assert.ok(
      packageScripts[resolvePreparedScript(script, true)],
      `missing checked script: ${script}`,
    );
  }
});

await test('worker checks and tests run once in both local and CI paths', () => {
  assert.equal(resolvePreparedScript('test:workspaces', false), 'test:workspaces:prepared');
  assert.equal(resolvePreparedScript('test:workspaces', true), 'test:workspaces:prepared');
  assert.equal(
    resolvePreparedScript('smoke:game-services:worker:prepared', false),
    'smoke:game-services:worker:prepared',
  );
  assert.equal(
    resolvePreparedScript('smoke:game-services:worker:prepared', true),
    'smoke:game-services:worker:checked',
  );
  assert.equal(
    resolvePreparedScript('smoke:game-identity:worker:prepared', true),
    'smoke:game-identity:worker:checked',
  );
});

await test('dynamic TypeScript config import and assertion canary keep ttsx hooks', () => {
  assert.equal(requiresTtsx('test:ttsx-assertions'), true);
  assert.equal(requiresTtsx('smoke:game-config'), true);
  assert.equal(requiresTtsx('smoke:target-config'), false);
});

await test('prepared workspace tests run mutating builds first, then the disjoint remainder', () => {
  const script = packageScripts['test:workspaces:prepared'];
  assert.ok(typeof script === 'string');
  const [mutating, remainder] = script.split(' && ');
  assert.ok(mutating && remainder);
  assert.match(mutating, /--workspace-concurrency=1/);
  const filters = (part: string): string[] =>
    [...part.matchAll(/--filter '?(\S+?)'?(?=\s|$)/g)].map((match) => {
      assert.ok(match[1]);
      return match[1].replace(/'$/, '');
    });
  const selectedNames = (part: string): string[] => {
    const args = [
      '-r',
      ...filters(part).flatMap((filter) => ['--filter', filter]),
      'list',
      '--depth',
      '-1',
      '--json',
    ];
    const pnpmEntry = process.platform === 'win32' ? process.env.npm_execpath : undefined;
    if (process.platform === 'win32') {
      assert.match(pnpmEntry ?? '', /\.(?:exe|[cm]?js)$/u);
    }
    const pnpmScript = pnpmEntry && /\.[cm]?js$/u.test(pnpmEntry) ? pnpmEntry : undefined;
    const selected = spawnSync(
      pnpmScript ? process.execPath : (pnpmEntry ?? 'pnpm'),
      pnpmScript ? [pnpmScript, ...args] : args,
      { encoding: 'utf8' },
    );
    assert.ifError(selected.error);
    assert.equal(selected.status, 0, selected.stderr);
    const workspaces: unknown = JSON.parse(selected.stdout);
    assert.ok(Array.isArray(workspaces));
    return workspaces.map((workspace: unknown) => {
      assert.ok(isObject(workspace) && typeof workspace.name === 'string');
      return workspace.name;
    });
  };
  const first = selectedNames(mutating);
  const second = selectedNames(remainder);
  assert.deepEqual(
    first.sort(),
    ['@mpgd/adapter-wechat', '@mpgd/game-runtime', '@mpgd/i18n', '@mpgd/phaser-minigame-runtime', '@mpgd/target-config'].sort(),
  );
  assert.ok(second.length > 0);
  assert.ok(!second.includes('mpgd-kit'));
  assert.ok(!second.includes('@mpgd/app-game-services-worker'));
  assert.ok(!second.includes('@mpgd/app-game-identity-worker'));
  assert.ok(first.every((name) => !second.includes(name)));
  const all = selectedNames(
    "--filter '!@mpgd/app-game-services-worker' --filter '!@mpgd/app-game-identity-worker' --filter '!{.}'",
  );
  assert.deepEqual([...first, ...second].sort(), all.sort());
});

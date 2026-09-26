import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { preparedGroups, requiresTtsx, resolvePreparedScript } from './prepared-suite.mjs';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

test('prepared groups retain all 52 commands exactly once', () => {
  const scripts = Object.values(preparedGroups).flat();
  assert.equal(scripts.length, 52);
  assert.equal(new Set(scripts).size, scripts.length);
  assert.deepEqual(Object.keys(preparedGroups), ['contracts', 'cli', 'services']);
  for (const script of scripts) {
    assert.ok(packageJson.scripts[script], `missing package script: ${script}`);
    assert.ok(packageJson.scripts[resolvePreparedScript(script, true)], `missing checked script: ${script}`);
  }
});

test('worker checks and tests run once in both local and CI paths', () => {
  assert.equal(resolvePreparedScript('test:workspaces', false), 'test:workspaces:prepared');
  assert.equal(resolvePreparedScript('test:workspaces', true), 'test:workspaces:prepared');
  assert.equal(resolvePreparedScript('smoke:game-services:worker:prepared', false), 'smoke:game-services:worker:prepared');
  assert.equal(resolvePreparedScript('smoke:game-services:worker:prepared', true), 'smoke:game-services:worker:checked');
});

test('dynamic TypeScript config import and assertion canary keep ttsx hooks', () => {
  assert.equal(requiresTtsx('test:ttsx-assertions'), true);
  assert.equal(requiresTtsx('smoke:game-config'), true);
  assert.equal(requiresTtsx('smoke:target-config'), false);
});

test('prepared workspace tests run mutating builds first, then the disjoint remainder', () => {
  const script = packageJson.scripts['test:workspaces:prepared'];
  const [mutating, remainder] = script.split(' && ');
  assert.ok(mutating && remainder);
  assert.match(mutating, /--workspace-concurrency=1/);
  const filters = (part) => [...part.matchAll(/--filter '?(\S+?)'?(?=\s|$)/g)].map((match) => match[1].replace(/'$/, ''));
  const selectedNames = (part) => {
    const args = ['-r', ...filters(part).flatMap((filter) => ['--filter', filter]), 'list', '--depth', '-1', '--json'];
    const selected = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    return JSON.parse(selected.stdout).map((workspace) => workspace.name);
  };
  const first = selectedNames(mutating);
  const second = selectedNames(remainder);
  assert.deepEqual(first.sort(), ['@mpgd/adapter-wechat', '@mpgd/game-runtime', '@mpgd/i18n', '@mpgd/phaser-minigame-runtime'].sort());
  assert.ok(second.length > 0);
  assert.ok(!second.includes('mpgd-kit'));
  assert.ok(!second.includes('@mpgd/app-game-services-worker'));
  assert.ok(first.every((name) => !second.includes(name)));
  const all = selectedNames("--filter '!@mpgd/app-game-services-worker' --filter '!{.}'");
  assert.deepEqual([...first, ...second].sort(), all.sort());
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { preparedGroups, resolvePreparedScript } from './prepared-suite.mjs';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

test('prepared groups retain the 43 legacy commands exactly once', () => {
  const scripts = Object.values(preparedGroups).flat();
  assert.equal(scripts.length, 43);
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

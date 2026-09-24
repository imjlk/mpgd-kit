import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isNativeOnlyChange } from './native-scope.mjs';

test('native source, package metadata, and its Sampo changeset stay native-only', () => {
  assert.equal(isNativeOnlyChange([
    'adapters/capacitor/src/index.ts',
    'native-plugins/capacitor-game-services/ios/Plugin.swift',
    'apps/mobile-capacitor/android/build.gradle',
    'adapters/capacitor/package.json',
    '.sampo/changesets/native-fix.md',
  ]), true);
});

test('a changeset or empty diff alone never qualifies', () => {
  assert.equal(isNativeOnlyChange([]), false);
  assert.equal(isNativeOnlyChange(['.sampo/changesets/native-fix.md']), false);
});

test('shared contracts, lockfiles, workflow, other adapters, and docs require broader CI', () => {
  for (const file of [
    'packages/platform/src/index.ts',
    'packages/bridge/src/index.ts',
    'pnpm-lock.yaml',
    'package.json',
    '.github/workflows/ci.yml',
    'adapters/ait/src/index.ts',
    'native-plugins/other/index.ts',
    'docs/guides/native.md',
  ]) {
    assert.equal(isNativeOnlyChange(['adapters/capacitor/src/index.ts', file]), false, file);
  }
});

test('lookalike paths cannot qualify', () => {
  assert.equal(isNativeOnlyChange(['adapters/capacitor-extra/src/index.ts']), false);
  assert.equal(isNativeOnlyChange(['apps/mobile-capacitor-extra/src/index.ts']), false);
});

test('CI wires native classification to both platform jobs and the required gate', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /run_native: \$\{\{ steps\.release-pr-meta\.outputs\.run_native \}\}/);
  assert.match(workflow, /node tools\/ci\/native-scope\.mjs "\$\{changed_files\[@\]\}"/);
  assert.match(workflow, /EVENT_NAME\}" == "pull_request" && "\$\{metadata_only\}" == "false"/);
  for (const name of ['build-android', 'build-ios']) {
    const job = workflow.split(new RegExp(`\\r?\\n  ${name}:\\r?\\n`))[1]?.split(/\r?\n  [a-z0-9][a-z0-9_-]*:\r?\n/)[0];
    assert.match(job ?? '', /needs\.prepare\.outputs\.run_native == 'true'/);
  }
  assert.match(workflow, /RUN_NATIVE: \$\{\{ needs\.prepare\.outputs\.run_native \}\}/);
  assert.match(workflow, /Verify native adapter contracts[\s\S]*?pnpm pack:packages:prepared/);
  assert.match(workflow, /run: node tools\/ci\/verify-coverage\.mjs/);
});

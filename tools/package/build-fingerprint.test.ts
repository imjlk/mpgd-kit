import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInputFingerprints,
  isReusableBuild,
  recordBuild,
  workspaceDependencyNames,
} from './build-fingerprint';
import type { WorkspacePackage } from './workspace';

const root = mkdtempSync(join(tmpdir(), 'mpgd-build-fingerprint-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

// Cases run in order and share the fixture packages below.
function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new Error(`Package build fingerprint case failed: ${name}`, { cause: error });
  }
}

function workspacePackage(
  name: string,
  dependencies: Record<string, string> = {},
): WorkspacePackage {
  const dir = join(root, name.replace(/[@/]/g, '_'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), `export const name = '${name}';\n`);
  const packageJson = { name, dependencies };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
  return { dir, name, packageJson, packageJsonPath: join(dir, 'package.json') };
}

const toolchainFile = join(root, 'toolchain.txt');
writeFileSync(toolchainFile, 'v1');
const core = workspacePackage('@mpgd/core');
const feature = workspacePackage('@mpgd/feature', { '@mpgd/core': 'workspace:*', zod: '4.0.0' });
const cli = workspacePackage('@mpgd/cli', { '@mpgd/feature': 'workspace:*' });
const packages = [core, feature, cli];

// `null` stands for a dirty Kit checkout (no reusable CLI state).
function fingerprints(kitHead: string | null = 'a'.repeat(40)) {
  return createInputFingerprints(packages, {
    toolchainFiles: [toolchainFile],
    kitHead: () => kitHead ?? undefined,
    runtime: 'node-test',
  });
}

check('fingerprints are stable and follow workspace dependencies only', () => {
  assert.deepEqual(workspaceDependencyNames(feature), ['@mpgd/core']);
  const first = fingerprints();
  const again = fingerprints();
  for (const { name } of packages) {
    assert.equal(first(name), again(name));
    assert.match(first(name) ?? '', /^[0-9a-f]{64}$/u);
  }

  writeFileSync(join(core.dir, 'src', 'index.ts'), 'export const name = 1;\n');
  const changed = fingerprints();
  assert.notEqual(changed('@mpgd/core'), first('@mpgd/core'));
  assert.notEqual(changed('@mpgd/feature'), first('@mpgd/feature'), 'dependents must change');
  assert.notEqual(changed('@mpgd/cli'), first('@mpgd/cli'));
});

check('dist and node_modules do not affect the input fingerprint', () => {
  const before = fingerprints()('@mpgd/core');
  mkdirSync(join(core.dir, 'dist'), { recursive: true });
  writeFileSync(join(core.dir, 'dist', 'index.js'), 'built');
  mkdirSync(join(core.dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(core.dir, 'node_modules', 'x', 'index.js'), 'dependency');
  assert.equal(fingerprints()('@mpgd/core'), before);
});

check('toolchain changes invalidate every package', () => {
  const before = fingerprints();
  writeFileSync(toolchainFile, 'v2');
  const after = fingerprints();
  for (const { name } of packages) {
    assert.notEqual(after(name), before(name));
  }
});

check('the CLI is only reusable from a clean Kit HEAD', () => {
  assert.equal(fingerprints(null)('@mpgd/cli'), undefined);
  assert.notEqual(fingerprints(null)('@mpgd/feature'), undefined);
  assert.notEqual(fingerprints('b'.repeat(40))('@mpgd/cli'), fingerprints()('@mpgd/cli'));
});

check('a recorded build is reused only with the same input and an untouched dist', () => {
  const distDir = join(feature.dir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.js'), 'export {};\n');
  const recordFile = join(root, 'feature.json');
  const input = fingerprints()('@mpgd/feature');

  assert.equal(isReusableBuild(recordFile, input, distDir), false, 'no record yet');
  recordBuild(recordFile, input, distDir);
  assert.equal(isReusableBuild(recordFile, input, distDir), true);
  assert.equal(isReusableBuild(recordFile, 'other', distDir), false);
  assert.equal(isReusableBuild(recordFile, undefined, distDir), false);

  writeFileSync(join(distDir, 'index.js'), 'export const edited = true;\n');
  assert.equal(isReusableBuild(recordFile, input, distDir), false, 'edited dist must rebuild');
  rmSync(distDir, { recursive: true });
  assert.equal(isReusableBuild(recordFile, input, distDir), false, 'missing dist must rebuild');
});

console.log('Package build fingerprint tests passed.');

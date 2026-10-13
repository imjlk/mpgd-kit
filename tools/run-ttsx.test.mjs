import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertEntryInProject,
  resolveProjectConfigPath,
  resolveProjectRootFiles,
  resolveTsgoBinary,
} from './ttsx-project-entry.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runner = fileURLToPath(new URL('./run-ttsx.mjs', import.meta.url));
const tsgoBinary = resolveTsgoBinary(repoRoot);

// A project that selects `src/**` next to a same-named file it does not select.
// Without the runner's gate, ttsx answers the out-of-project entry with the
// emit of the in-project file (trailing-path-stem recovery) and runs that file
// under the requested entry's URL.
function stemCollisionFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-run-ttsx-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('tsconfig.json', {
    compilerOptions: { module: 'esnext', target: 'es2022', strict: true },
    include: ['src/**/*.ts'],
  });
  write('src/commerce-provider.test.ts', "console.log('STEM_MATCHED_FILE_RAN');\n");
  write('other/commerce-provider.test.ts', "console.log('REQUESTED_ENTRY_RAN');\n");
  return {
    root,
    write,
    project: join(root, 'tsconfig.json'),
    included: join(root, 'src', 'commerce-provider.test.ts'),
    outside: join(root, 'other', 'commerce-provider.test.ts'),
  };
}

function runnerEnv() {
  // The prepared suite's compiled emit and any caller project must not leak in.
  const env = { ...process.env };
  delete env.MPGD_CI_EMIT_ROOT;
  delete env.MPGD_TOOLS_EMIT_SOURCE_ROOT;
  delete env.TTSC_PROJECT;
  return env;
}

test('resolves the root file set of a project through tsgo --showConfig', (t) => {
  const fixture = stemCollisionFixture(t);
  const { configPath, count, keys } = resolveProjectRootFiles({ tsgoBinary, project: fixture.project, cwd: fixture.root });
  assert.equal(configPath, fixture.project);
  assert.equal(count, 1);
  const comparisonPath = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  assert.equal(keys.has(comparisonPath(fixture.included)), true);
  assert.equal(keys.has(comparisonPath(fixture.outside)), false);
});

test('a directory project stands for its tsconfig.json, as with tsc -p', (t) => {
  const fixture = stemCollisionFixture(t);
  assert.equal(resolveProjectConfigPath(fixture.root, fixture.root), fixture.project);
  assert.equal(resolveProjectConfigPath('.', fixture.root), fixture.project);
  assert.doesNotThrow(() => assertEntryInProject({ tsgoBinary, project: '.', entry: fixture.included, cwd: fixture.root }));
  assert.throws(
    () => assertEntryInProject({ tsgoBinary, project: fixture.root, entry: fixture.outside, cwd: fixture.root }),
    /not part of the selected project/,
  );
  const storekit = join('native-plugins', 'capacitor-storekit');
  assert.doesNotThrow(() => assertEntryInProject({
    tsgoBinary,
    project: storekit,
    entry: join(storekit, 'src', 'commerce-provider.test.ts'),
    cwd: repoRoot,
  }));
});

test('accepts an entry the project selects', (t) => {
  const fixture = stemCollisionFixture(t);
  assert.doesNotThrow(() => assertEntryInProject({
    tsgoBinary,
    project: fixture.project,
    entry: fixture.included,
    cwd: fixture.root,
  }));
});

test('accepts a relative project and entry from a cwd away from the repository root', () => {
  // The examples/asset-packs build:delivery script shape.
  const cwd = join(repoRoot, 'examples', 'asset-packs');
  assert.doesNotThrow(() => assertEntryInProject({
    tsgoBinary,
    project: 'tsconfig.delivery-build.json',
    entry: join('test', 'build-delivery.ts'),
    cwd,
  }));
});

test('rejects an entry outside the project even when an included file shares its stem', (t) => {
  const fixture = stemCollisionFixture(t);
  assert.throws(
    () => assertEntryInProject({ tsgoBinary, project: fixture.project, entry: fixture.outside, cwd: fixture.root }),
    (error) => {
      assert.ok(
        error.message.includes(`not part of the selected project: ${relative(fixture.root, fixture.outside)}`),
        error.message,
      );
      assert.match(error.message, /project: tsconfig\.json \(1 root file\)/);
      assert.match(error.message, /--project/);
      return true;
    },
  );
});

test('fails closed when the project cannot be resolved', (t) => {
  const fixture = stemCollisionFixture(t);
  assert.throws(
    () => assertEntryInProject({
      tsgoBinary,
      project: join(fixture.root, 'missing.tsconfig.json'),
      entry: fixture.outside,
      cwd: fixture.root,
    }),
    /Could not resolve the file set/,
  );
});

test('blames the project, not the entry, when it selects zero root files', (t) => {
  const fixture = stemCollisionFixture(t);
  // tsgo --showConfig exits 0 and omits `files` when the globs match nothing.
  // (Unreadable JSON or a missing `extends` target still expand `include`, or
  // the default one; ttsx reports those errors when it builds the project.)
  fixture.write('empty.tsconfig.json', { include: ['nothing/**/*.ts'] });
  assert.throws(
    () => assertEntryInProject({ tsgoBinary, project: 'empty.tsconfig.json', entry: fixture.included, cwd: fixture.root }),
    /selected zero root files; check the tsconfig/,
  );
});

test('run-ttsx.mjs refuses an out-of-project entry before ttsx can stem-match another file', (t) => {
  const fixture = stemCollisionFixture(t);
  const result = spawnSync(process.execPath, [runner, '--project', fixture.project, fixture.outside], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: runnerEnv(),
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'an out-of-project entry must fail');
  assert.match(result.stderr, /ttsx entry is not part of the selected project/);
  assert.doesNotMatch(result.stdout, /STEM_MATCHED_FILE_RAN/, 'the same-named project file must not run');
  assert.doesNotMatch(result.stdout, /REQUESTED_ENTRY_RAN/);
});

test('a refused entry records a refused row in the CI timing summary', (t) => {
  const fixture = stemCollisionFixture(t);
  const summary = join(fixture.root, 'summary.md');
  const result = spawnSync(process.execPath, [runner, '--project', fixture.project, fixture.outside], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...runnerEnv(), GITHUB_STEP_SUMMARY: summary },
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  const rows = readFileSync(summary, 'utf8').split('\n').filter((line) => line.startsWith('| refused |'));
  assert.equal(rows.length, 1, 'exactly one refused row');
  assert.match(rows[0], /\| 1 \|$/, 'the refused row carries exit code 1');
});

test('the compiled lane runs an entry present in the inherited emit without consulting the gate', (t) => {
  // The prepared CI lane (MPGD_CI_EMIT_ROOT) serves the entry's own mirrored
  // path, which is exact by construction. An entry outside the tools project
  // proves the bypass: the gate would refuse it, the compiled lane runs it.
  const emitRoot = mkdtempSync(join(tmpdir(), 'mpgd-run-ttsx-emit-'));
  t.after(() => rmSync(emitRoot, { recursive: true, force: true }));
  const entry = join('native-plugins', 'capacitor-storekit', 'src', 'zz-compiled-lane-probe.test.ts');
  const emitted = join(emitRoot, entry.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(emitted), { recursive: true });
  writeFileSync(emitted, "console.log('COMPILED_LANE_RAN');\n");
  const result = spawnSync(process.execPath, [runner, entry], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...runnerEnv(), MPGD_CI_EMIT_ROOT: emitRoot, MPGD_TOOLS_EMIT_SOURCE_ROOT: repoRoot },
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COMPILED_LANE_RAN/);
  assert.doesNotMatch(result.stderr, /not part of the selected project/);
});

test('native plugin test entries belong to their own tsconfig, not the tools project', () => {
  for (const plugin of ['capacitor-storekit', 'capacitor-play-billing']) {
    const entry = join(repoRoot, 'native-plugins', plugin, 'src', 'commerce-provider.test.ts');
    assert.throws(
      () => assertEntryInProject({ tsgoBinary, project: 'tsconfig.tools.json', entry, cwd: repoRoot }),
      /not part of the selected project/,
      `${plugin} entries are outside tsconfig.tools.json and must be run with --project`,
    );
    const project = join('native-plugins', plugin, 'tsconfig.json');
    assert.doesNotThrow(() => assertEntryInProject({ tsgoBinary, project, entry, cwd: repoRoot }));
    const { keys } = resolveProjectRootFiles({ tsgoBinary, project, cwd: repoRoot });
    const fixturePath = join(repoRoot, 'native-plugins', plugin, 'test', sep);
    const fixtureDir = process.platform === 'win32' ? fixturePath.toLowerCase() : fixturePath;
    const fixtures = [...keys].filter((file) => file.startsWith(fixtureDir));
    assert.ok(fixtures.length > 0, `${plugin} tsconfig must select its test/ fixtures`);
  }
});

test('tools entries stay inside the default project', () => {
  for (const entry of ['tools/validate-product-catalog.ts', 'packages/cli/src/bin.ts', 'tools/fixtures/ttsx-assertion-canary.ts']) {
    assert.doesNotThrow(() => assertEntryInProject({ tsgoBinary, project: 'tsconfig.tools.json', entry, cwd: repoRoot }));
  }
});

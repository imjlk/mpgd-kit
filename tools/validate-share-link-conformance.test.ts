import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findShareLinkConformanceGaps } from './validate-share-link-conformance';

const runnerImport = "import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';\n";

function writeAdapters(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

await test('finds an adapter that defines a share but runs no share link conformance', () => {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-share-link-conformance-'));

  try {
    writeAdapters(root, {
      'covered/src/index.ts': 'export const sharing = { async share(intent) { return host(intent); } };\n',
      'covered/src/share-link.conformance.test.ts': `${runnerImport}await runShareLinkConformance({ name: 'covered' });\n`,
      'covered-in-test-dir/src/sharing.ts': 'export const sharing = { share(intent) { return host(intent); } };\n',
      'covered-in-test-dir/test/share-link.conformance.test.ts': `${runnerImport}await runShareLinkConformance(fixture);\n`,
      // Other ways to define a share.
      'shorthand/src/index.ts': 'const share = async (intent) => host(intent);\nexport const sharing = { share };\n',
      'quoted-key/src/index.ts': "export const sharing = { 'share': async (intent) => host(intent) };\n",
      'computed-key/src/index.ts': "export const sharing = { ['share'](intent) { return host(intent); } };\n",
      'class-field/src/index.ts': 'export class Sharing {\n  readonly share = async (intent) => host(intent);\n}\n',
      // Runs that run nothing: commented out, skipped, or without the runner's import.
      'commented-run/src/index.ts': 'export const sharing = { async share(intent) { return host(intent); } };\n',
      'commented-run/src/share.test.ts': `${runnerImport}// await runShareLinkConformance(fixture);\n/* runShareLinkConformance(fixture) */\n`,
      'skipped-run/src/index.ts': 'export const sharing = { async share(intent) { return host(intent); } };\n',
      'skipped-run/src/share.test.ts': `${runnerImport}it.skip('shares', () => runShareLinkConformance(fixture));\n`,
      'local-runner/src/index.ts': 'export const sharing = { async share(intent) { return host(intent); } };\n',
      'local-runner/src/share.test.ts': 'const runShareLinkConformance = () => {};\nrunShareLinkConformance(fixture);\n',
      'forwarding/src/index.ts': "export const sharing = { share: (payload) => request('share.share', payload) };\n",
      'forwarding/src/index.test.ts': "it('shares', async () => share(intent));\n",
      'forwarding/dist/index.js': 'runShareLinkConformance(fixture);\n',
      'no-share/src/index.ts': [
        'interface Options { readonly share?: (data: ShareData) => Promise<void> }',
        'const share = options.share ?? navigator.share;',
        'api.shareAppMessage(options);',
        'export const gateway = { sharing: {} };',
      ].join('\n'),
      'linkless/src/sharing.ts': 'export const sharing = { async share(intent) { card(intent.title); } };\n',
    });

    const gaps = (exemptions: ReadonlyMap<string, string>) => findShareLinkConformanceGaps(root, exemptions)
      .map((gap) => gap.adapter)
      .sort();

    assert.deepEqual(gaps(new Map([['linkless', 'its card carries no link']])), [
      'class-field',
      'commented-run',
      'computed-key',
      'forwarding',
      'local-runner',
      'quoted-key',
      'shorthand',
      'skipped-run',
    ]);
    assert.ok(gaps(new Map()).includes('linkless'));
    assert.deepEqual(
      findShareLinkConformanceGaps(root).find((gap) => gap.adapter === 'forwarding'),
      { adapter: 'forwarding', files: ['src/index.ts'] },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('every repository adapter that defines a share runs the share link conformance', () => {
  assert.deepEqual(
    findShareLinkConformanceGaps(fileURLToPath(new URL('../adapters', import.meta.url))),
    [],
  );
});

await test('the TypeScript CLI executes its check and preserves its diagnostic output', () => {
  const result = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--project',
      'tsconfig.maintenance-tools.json',
      'tools/validate-share-link-conformance.ts',
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 180_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Every adapter that defines a share runs the share link conformance/u);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findShareLinkConformanceGaps } from './validate-share-link-conformance.mjs';

function writeAdapters(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

test('finds an adapter that defines a share but runs no share link conformance', () => {
  const root = mkdtempSync(join(tmpdir(), 'mpgd-share-link-conformance-'));

  try {
    writeAdapters(root, {
      'covered/src/index.ts': 'export const sharing = { async share(intent) { return host(intent); } };\n',
      'covered/src/share-link.conformance.test.ts': "await runShareLinkConformance({ name: 'covered' });\n",
      'covered-in-test-dir/src/sharing.ts': 'export const sharing = { share(intent) { return host(intent); } };\n',
      'covered-in-test-dir/test/share-link.conformance.test.ts': 'await runShareLinkConformance(fixture);\n',
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

    assert.deepEqual(
      findShareLinkConformanceGaps(root, new Map([['linkless', 'its card carries no link']])),
      [{ adapter: 'forwarding', files: ['src/index.ts'] }],
    );
    assert.deepEqual(
      findShareLinkConformanceGaps(root, new Map()).map((gap) => gap.adapter).sort(),
      ['forwarding', 'linkless'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every repository adapter that defines a share runs the share link conformance', () => {
  assert.deepEqual(
    findShareLinkConformanceGaps(fileURLToPath(new URL('../adapters', import.meta.url))),
    [],
  );
});

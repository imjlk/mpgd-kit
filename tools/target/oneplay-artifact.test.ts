import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnePlayArtifact, writeOnePlayHostingHeaders } from './oneplay-artifact';

const root = mkdtempSync(join(tmpdir(), 'mpgd-oneplay-'));
try {
  writeFileSync(join(root, 'index.html'), '<html><body>game</body></html>');
  writeOnePlayHostingHeaders(root);
  assert.match(readFileSync(join(root, '_headers'), 'utf8'), /onestore\.co\.kr/u);
  assertOnePlayArtifact(root);
  writeFileSync(join(root, '_headers'), '/*\n  X-Frame-Options: DENY\n');
  assert.throws(() => assertOnePlayArtifact(root), /both ONE store/u);
  // Do not overwrite a game-owned header file with an incompatible policy.
  assert.throws(() => writeOnePlayHostingHeaders(root), /both ONE store/u);
  writeFileSync(
    join(root, '_headers'),
    '/*\n  Content-Security-Policy: frame-ancestors https://*.onestore.co.kr https://*.onestore.net\n  X-Frame-Options: SAMEORIGIN\n',
  );
  assert.throws(() => assertOnePlayArtifact(root), /conflicting/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}

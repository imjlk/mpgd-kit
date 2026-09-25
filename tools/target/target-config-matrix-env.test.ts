import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { targetConfigMatrixFileEnv } from '../../packages/cli/src/target-config-env';
import { loadTargetConfigMatrix } from './target-config-matrix';

const originalDirectory = process.cwd();
const originalOverride = process.env[targetConfigMatrixFileEnv];
const externalGame = mkdtempSync(join(tmpdir(), 'mpgd-target-config-external-'));

try {
  process.env[targetConfigMatrixFileEnv] = resolve(
    originalDirectory,
    'packages/target-config/targets.json',
  );
  process.chdir(externalGame);
  assert.ok(loadTargetConfigMatrix().targets.android);
  console.info('Target matrix resolves from installed-package override outside Kit cwd.');
} finally {
  process.chdir(originalDirectory);
  if (originalOverride === undefined) {
    delete process.env[targetConfigMatrixFileEnv];
  } else {
    process.env[targetConfigMatrixFileEnv] = originalOverride;
  }
  rmSync(externalGame, { recursive: true, force: true });
}

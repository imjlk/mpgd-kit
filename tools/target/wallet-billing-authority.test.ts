import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TargetConfigMatrix } from '@mpgd/target-config';

import { readJsonFile } from '../io';
import { validateTargetConfigMatrixFile } from '../validate-target-config';

// RFC "Billing authority and memberships": a Google Play or App Store build
// cannot declare host billing (D-02), while web and host platforms may.
const matrix = readJsonFile('packages/target-config/targets.json') as TargetConfigMatrix;
const directory = mkdtempSync(join(tmpdir(), 'mpgd-wallet-billing-authority-'));
const targetsPath = 'examples/phaser-starter/mpgd.targets.json';

function withBillingAuthority(
  target: string,
  billingAuthority: 'store' | 'host',
): string {
  const config = matrix.targets[target];
  assert.ok(config, `target ${target} exists in the matrix`);
  const path = join(directory, `${target}-${billingAuthority}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...matrix,
      targets: {
        ...matrix.targets,
        [target]: { ...config, release: { ...config.release, billingAuthority } },
      },
    }),
  );
  return path;
}

try {
  assert.ok(
    validateTargetConfigMatrixFile(withBillingAuthority('web-preview', 'host'), targetsPath).targets['web-preview'],
  );
  assert.ok(
    validateTargetConfigMatrixFile(withBillingAuthority('android', 'store'), targetsPath).targets.android,
  );
  assert.throws(
    () => validateTargetConfigMatrixFile(withBillingAuthority('android', 'host'), targetsPath),
    /Target android release\.billingAuthority is invalid: .*google-play/u,
  );
  assert.throws(
    () => validateTargetConfigMatrixFile(withBillingAuthority('ios', 'host'), targetsPath),
    /Target ios release\.billingAuthority is invalid: .*app-store/u,
  );
  console.info('Target config rejects host billing authority on store-billed profiles.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

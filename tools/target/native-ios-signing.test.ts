import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveIosSigningPlan } from './native-ios-signing';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-signing-test-'));
const exportFile = path.join(root, 'ExportOptions.plist');

try {
  writeFileSync(exportFile, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>method</key><string>app-store-connect</string>',
    '</dict></plist>',
  ].join('\n'));
  const automatic = resolveIosSigningPlan(
    {
      MPGD_IOS_TEAM_ID: 'TEAM123456',
    },
    'signed-archive',
  );
  assert.deepEqual(automatic.archiveBuildSettings, [
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGN_STYLE=Automatic',
    'DEVELOPMENT_TEAM=TEAM123456',
  ]);
  assert.equal(automatic.exportOptionsPlist, undefined);
  const manual = resolveIosSigningPlan(
    {
      MPGD_IOS_TEAM_ID: 'TEAM123456',
      MPGD_IOS_SIGNING_STYLE: 'Manual',
      MPGD_IOS_SIGNING_IDENTITY: 'Apple Distribution',
      MPGD_IOS_PROVISIONING_PROFILE_SPECIFIER: 'Game App Store',
      MPGD_IOS_EXPORT_OPTIONS_PLIST: exportFile,
      MPGD_IOS_SIGNING_KEYCHAIN: path.join(root, 'temporary signing.keychain-db'),
    },
    'store-export',
  );
  assert.equal(manual.exportOptionsPlist, exportFile);
  assert.equal(manual.archiveBuildSettings.includes('CODE_SIGNING_ALLOWED=YES'), true);
  const expectedKeychain = path.join(root, 'temporary signing.keychain-db');
  const expectedFlag = `OTHER_CODE_SIGN_FLAGS=--keychain ${JSON.stringify(expectedKeychain)}`;
  assert.equal(manual.archiveBuildSettings.includes(expectedFlag), true);
  assert.throws(() => resolveIosSigningPlan({}, 'signed-archive'), /TEAM_ID/u);
  assert.throws(
    () =>
      resolveIosSigningPlan(
        {
          MPGD_IOS_TEAM_ID: 'TEAM123456',
        },
        'store-export',
      ),
    /EXPORT_OPTIONS_PLIST/u,
  );
  assert.throws(
    () =>
      resolveIosSigningPlan(
        {
          MPGD_IOS_TEAM_ID: 'TEAM123456',
          MPGD_IOS_SIGNING_STYLE: 'Manual',
        },
        'signed-archive',
      ),
    /Manual iOS signing/u,
  );
  writeFileSync(exportFile, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>method</key><string>ad-hoc</string>',
    '</dict></plist>',
  ].join('\n'));
  assert.throws(
    () =>
      resolveIosSigningPlan(
        {
          MPGD_IOS_TEAM_ID: 'TEAM123456',
          MPGD_IOS_EXPORT_OPTIONS_PLIST: exportFile,
        },
        'store-export',
      ),
    /App Store distribution method/u,
  );
  console.info('iOS signing environment selection passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

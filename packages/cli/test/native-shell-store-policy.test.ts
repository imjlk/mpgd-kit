import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyIosInfoPlistStorePolicy,
  inspectIosInfoPlistStorePolicy,
  readPlistTopLevelValue,
  setPlistTopLevelValue,
} from '../src/native-shell-store-policy.js';
import {
  inspectNativeStorePolicy,
  reportNativeStorePolicy,
} from '../../../tools/target/native-store-policy.js';

/** The reference shell lives in the checkout, not next to the compiled test (prepared CI lane). */
function resolveKitRoot(): string {
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0
      && existsSync(path.join(root, 'apps/mobile-capacitor/ios/App/App/Info.plist'))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

const referenceShell = path.join(resolveKitRoot(), 'apps/mobile-capacitor');

const capacitorTemplatePlist = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>CFBundleDisplayName</key>',
  '\t<string>My App</string>',
  '\t<key>UIApplicationSceneManifest</key>',
  '\t<dict>',
  '\t\t<key>UIApplicationSupportsMultipleScenes</key>',
  '\t\t<false/>',
  '\t</dict>',
  '\t<key>UIRequiredDeviceCapabilities</key>',
  '\t<array>',
  '\t\t<string>armv7</string>',
  '\t</array>',
  '\t<key>UIViewControllerBasedStatusBarAppearance</key>',
  '\t<true/>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

const applied = applyIosInfoPlistStorePolicy(capacitorTemplatePlist);
assert.equal(readPlistTopLevelValue(applied, 'ITSAppUsesNonExemptEncryption')?.xml, '<false/>');
assert.match(
  applied,
  /<key>ITSAppUsesNonExemptEncryption<\/key>\n\t<false\/>\n<\/dict>\n<\/plist>\n$/u,
);
assert.equal(
  readPlistTopLevelValue(applied, 'UIRequiredDeviceCapabilities')?.xml,
  '<array>\n\t\t<string>arm64</string>\n\t</array>',
);
assert.equal(applyIosInfoPlistStorePolicy(applied), applied, 'idempotent');
assert.deepEqual(inspectIosInfoPlistStorePolicy(applied), []);
const issues = inspectIosInfoPlistStorePolicy(capacitorTemplatePlist);
assert.equal(issues.length, 2);
assert.ok(issues.every((issue) => issue.level === 'warning'));
assert.match(issues[0]?.message ?? '', /ITSAppUsesNonExemptEncryption/u);
assert.match(issues[1]?.message ?? '', /armv7/u);

// A game that declares its own encryption keeps its answer.
const ownEncryption = setPlistTopLevelValue(
  capacitorTemplatePlist,
  'ITSAppUsesNonExemptEncryption',
  '<true/>',
);
assert.equal(
  readPlistTopLevelValue(applyIosInfoPlistStorePolicy(ownEncryption), 'ITSAppUsesNonExemptEncryption')
    ?.xml,
  '<true/>',
);
// armv7 next to arm64 is dropped rather than duplicated.
const both = capacitorTemplatePlist.replace(
  '<string>armv7</string>',
  '<string>armv7</string>\n\t\t<string>arm64</string>',
);
assert.equal(
  readPlistTopLevelValue(applyIosInfoPlistStorePolicy(both), 'UIRequiredDeviceCapabilities')?.xml,
  '<array>\n\t\t<string>arm64</string>\n\t</array>',
);
// A commented-out key is not a value.
assert.equal(
  readPlistTopLevelValue(
    '<plist><dict><!-- <key>ITSAppUsesNonExemptEncryption</key><false/> --></dict></plist>',
    'ITSAppUsesNonExemptEncryption',
  ),
  undefined,
);
assert.throws(
  () => setPlistTopLevelValue('<plist><array/></plist>', 'Key', '<true/>'),
  /root <\/dict><\/plist>/u,
);

// The build preflight reads the shell's release Info.plist through its project.
const shell = mkdtempSync(path.join(tmpdir(), 'mpgd-store-policy-'));
try {
  mkdirSync(path.join(shell, 'ios/App/App.xcodeproj'), { recursive: true });
  mkdirSync(path.join(shell, 'ios/App/App'), { recursive: true });
  const reference = readFileSync(
    path.join(referenceShell, 'ios/App/App.xcodeproj/project.pbxproj'),
    'utf8',
  );
  writeFileSync(path.join(shell, 'ios/App/App.xcodeproj/project.pbxproj'), reference);
  writeFileSync(path.join(shell, 'ios/App/App/Info.plist'), capacitorTemplatePlist);
  const found = inspectNativeStorePolicy({ platform: 'ios', shellApp: shell });
  assert.equal(found.length, 2);
  const printed: string[] = [];
  reportNativeStorePolicy(found, true, (message) => printed.push(message));
  assert.equal(printed.length, 2, 'warnings never fail the build');
  assert.throws(
    () =>
      reportNativeStorePolicy(
        [{ level: 'error', message: 'missing app id' }],
        true,
        () => undefined,
      ),
    /not ready for store release:\n- missing app id/u,
  );
  assert.doesNotThrow(() => reportNativeStorePolicy(
    [{ level: 'error', message: 'missing app id' }],
    false,
    () => undefined,
  ));
  writeFileSync(path.join(shell, 'ios/App/App/Info.plist'), applied);
  assert.deepEqual(inspectNativeStorePolicy({ platform: 'ios', shellApp: shell }), []);
  // The kit's reference shell ships the policy.
  assert.deepEqual(
    inspectIosInfoPlistStorePolicy(
      readFileSync(
        new URL('../../../apps/mobile-capacitor/ios/App/App/Info.plist', import.meta.url),
        'utf8',
      ),
    ),
    [],
  );
} finally {
  rmSync(shell, { recursive: true, force: true });
}

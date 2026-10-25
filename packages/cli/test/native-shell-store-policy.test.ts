import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyAndroidManifestOrientation,
  applyIosInfoPlistOrientation,
  applyIosInfoPlistStorePolicy,
  applyIosProjectDeviceFamily,
  inspectAndroidManifestOrientation,
  inspectIosInfoPlistOrientation,
  inspectIosInfoPlistStorePolicy,
  inspectIosProjectDeviceFamily,
  readGameNativeOrientation,
  readIosAppReleaseDeviceFamily,
  readIosDeviceFamily,
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
      readFileSync(path.join(referenceShell, 'ios/App/App/Info.plist'), 'utf8'),
    ),
    [],
  );
} finally {
  rmSync(shell, { recursive: true, force: true });
}

// Orientation and device family.
{
  assert.equal(readGameNativeOrientation({}), undefined);
  assert.equal(readGameNativeOrientation({ native: { orientation: 'portrait' } }), 'portrait');
  assert.throws(() => readGameNativeOrientation({ native: { orientation: 'up' } }), /must be/u);
  assert.throws(() => readGameNativeOrientation({ native: { lock: true } }), /not supported/u);
  assert.equal(readIosDeviceFamily({ iosDeviceFamily: 'iphone' }), 'iphone');
  assert.equal(readIosDeviceFamily(undefined), undefined);
  assert.throws(() => readIosDeviceFamily({ iosDeviceFamily: 'ipad' }), /must be/u);

  const template = readFileSync(path.join(referenceShell, 'ios/App/App/Info.plist'), 'utf8');
  const landscape = applyIosInfoPlistOrientation(template, 'landscape');
  assert.deepEqual(
    [...(readPlistTopLevelValue(landscape, 'UISupportedInterfaceOrientations')?.xml ?? '')
      .matchAll(/<string>([^<]+)<\/string>/gu)].map((match) => match[1]),
    ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  );
  assert.equal(
    (readPlistTopLevelValue(landscape, 'UISupportedInterfaceOrientations~ipad')?.xml.match(/<string>/gu) ?? [])
      .length,
    4,
    'iPad keeps every orientation (TN3192)',
  );
  assert.equal(applyIosInfoPlistOrientation(landscape, 'landscape'), landscape);
  assert.deepEqual(inspectIosInfoPlistOrientation(landscape, 'landscape', 'universal'), []);
  assert.deepEqual(inspectIosInfoPlistOrientation(template, undefined, 'universal'), []);
  assert.equal(
    inspectIosInfoPlistOrientation(template, 'landscape', 'universal')[0]?.level,
    'error',
  );
  assert.equal(
    inspectIosInfoPlistOrientation(template, 'portrait', 'universal')[0]?.level,
    'error',
  );
  assert.deepEqual(inspectIosInfoPlistOrientation(template, 'any', 'universal'), []);
  const portraitOnlyIpad = setPlistTopLevelValue(
    applyIosInfoPlistOrientation(template, 'portrait'),
    'UISupportedInterfaceOrientations~ipad',
    '<array><string>UIInterfaceOrientationPortrait</string></array>',
  );
  assert.deepEqual(
    inspectIosInfoPlistOrientation(portraitOnlyIpad, 'portrait', 'universal').map(
      (issue) => issue.level,
    ),
    ['warning'],
  );
  assert.deepEqual(inspectIosInfoPlistOrientation(portraitOnlyIpad, 'portrait', 'iphone'), []);

  const project = readFileSync(
    path.join(referenceShell, 'ios/App/App.xcodeproj/project.pbxproj'),
    'utf8',
  );
  assert.equal(readIosAppReleaseDeviceFamily(project), '1,2');
  assert.deepEqual(inspectIosProjectDeviceFamily(project, undefined), []);
  assert.deepEqual(inspectIosProjectDeviceFamily(project, 'universal'), []);
  assert.equal(inspectIosProjectDeviceFamily(project, 'iphone')[0]?.level, 'error');
  const iphoneOnly = applyIosProjectDeviceFamily(project, 'iphone');
  assert.equal(readIosAppReleaseDeviceFamily(iphoneOnly), '1');
  assert.equal(
    (iphoneOnly.match(/TARGETED_DEVICE_FAMILY = "1";/gu) ?? []).length,
    2,
    'Debug and Release',
  );
  assert.deepEqual(inspectIosProjectDeviceFamily(iphoneOnly, 'iphone'), []);
  // A target without the setting gets one; project-level settings are untouched.
  const unset = project.replace(/\n\s*TARGETED_DEVICE_FAMILY = "1,2";/gu, '');
  assert.equal(readIosAppReleaseDeviceFamily(unset), undefined);
  assert.equal(
    readIosAppReleaseDeviceFamily(applyIosProjectDeviceFamily(unset, 'universal')),
    '1,2',
  );

  const manifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <application',
    '        android:label="@string/app_name">',
    '        <!-- <activity android:name=".Old"><intent-filter><category android:name="android.intent.category.LAUNCHER" /></intent-filter></activity> -->',
    '        <activity',
    '            android:name=".MainActivity"',
    '            android:exported="true">',
    '            <intent-filter>',
    '                <action android:name="android.intent.action.MAIN" />',
    '                <category android:name="android.intent.category.LAUNCHER" />',
    '            </intent-filter>',
    '        </activity>',
    '    </application>',
    '</manifest>',
  ].join('\n');
  const androidLandscape = applyAndroidManifestOrientation(manifest, 'landscape');
  assert.match(
    androidLandscape,
    /android:exported="true"\n {12}android:screenOrientation="sensorLandscape">/u,
  );
  assert.match(
    androidLandscape,
    /android:label="@string\/app_name"\n {8}android:appCategory="game">/u,
  );
  assert.equal(applyAndroidManifestOrientation(androidLandscape, 'landscape'), androidLandscape);
  assert.deepEqual(inspectAndroidManifestOrientation(androidLandscape, 'landscape'), []);
  const androidPortrait = applyAndroidManifestOrientation(androidLandscape, 'portrait');
  assert.match(androidPortrait, /android:screenOrientation="portrait">/u);
  assert.doesNotMatch(androidPortrait, /sensorLandscape/u);
  assert.doesNotMatch(
    applyAndroidManifestOrientation(androidLandscape, 'any'),
    /screenOrientation/u,
  );
  assert.equal(inspectAndroidManifestOrientation(manifest, 'landscape')[0]?.level, 'error');
  assert.deepEqual(
    inspectAndroidManifestOrientation(
      manifest.replace('android:exported="true">', 'android:exported="true" android:screenOrientation="landscape">'),
      'landscape',
    ).map((issue) => issue.level),
    ['warning'],
    'a missing appCategory is a warning',
  );
  assert.deepEqual(inspectAndroidManifestOrientation(manifest, undefined), []);
  // A self-closing activity or an alias before the launcher is never oriented.
  const siblings = manifest.replace(
    '        <activity\n',
    '        <activity android:name=".Other" android:exported="false" />\n'
      + '        <activity-alias android:name=".Alias" android:targetActivity=".MainActivity" />\n'
      + '        <activity\n',
  );
  const orientedSiblings = applyAndroidManifestOrientation(siblings, 'portrait');
  assert.match(orientedSiblings, /<activity android:name="\.Other" android:exported="false" \/>/u);
  assert.match(
    orientedSiblings,
    /<activity-alias android:name="\.Alias" android:targetActivity="\.MainActivity" \/>/u,
  );
  assert.match(
    orientedSiblings,
    /android:exported="true"\n {12}android:screenOrientation="portrait">/u,
  );
  assert.deepEqual(inspectAndroidManifestOrientation(orientedSiblings, 'portrait'), []);
  // A `>` or `/>` inside an attribute value does not end the tag.
  const quoted = manifest.replace(
    '        <activity\n',
    '        <activity android:name=".A" android:label="a>b" />\n        <activity android:label="x/>y"\n',
  );
  const orientedQuoted = applyAndroidManifestOrientation(quoted, 'portrait');
  assert.match(orientedQuoted, /<activity android:name="\.A" android:label="a>b" \/>/u);
  assert.match(
    orientedQuoted,
    /android:exported="true"\n {12}android:screenOrientation="portrait">/u,
  );
  // Without the key, iOS allows every orientation.
  const noIphoneKey = template.replace(
    /<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<\/array>/u,
    '',
  );
  assert.deepEqual(inspectIosInfoPlistOrientation(noIphoneKey, 'any', 'universal'), []);
  assert.equal(
    inspectIosInfoPlistOrientation(noIphoneKey, 'portrait', 'universal')[0]?.level,
    'error',
  );
  // Configuration IDs come from the list entries, not from their comments.
  const hexNamed = project.replace(
    /(buildConfigurations = \(\s*\n\s*[A-F0-9]+ \/\* )Debug( \*\/)/u,
    '$1ADD$2',
  );
  assert.notEqual(hexNamed, project);
  const commaNamed = project.replace(
    /(buildConfigurations = \(\s*\n\s*[A-F0-9]+ \/\* )Debug( \*\/)/u,
    '$1Debug, ADD$2',
  );
  assert.equal(
    readIosAppReleaseDeviceFamily(applyIosProjectDeviceFamily(commaNamed, 'iphone')),
    '1',
  );
  assert.equal(readIosAppReleaseDeviceFamily(applyIosProjectDeviceFamily(hexNamed, 'iphone')), '1');

  // The build preflight reads native.orientation and iosDeviceFamily from the game.
  const game = mkdtempSync(path.join(tmpdir(), 'mpgd-store-policy-game-'));
  try {
    const gameShell = path.join(game, 'apps/mobile-capacitor');
    mkdirSync(path.join(gameShell, 'ios/App/App.xcodeproj'), { recursive: true });
    mkdirSync(path.join(gameShell, 'ios/App/App'), { recursive: true });
    mkdirSync(path.join(gameShell, 'android/app/src/main'), { recursive: true });
    writeFileSync(path.join(gameShell, 'ios/App/App.xcodeproj/project.pbxproj'), project);
    writeFileSync(path.join(gameShell, 'ios/App/App/Info.plist'), template);
    writeFileSync(path.join(gameShell, 'android/app/src/main/AndroidManifest.xml'), manifest);
    writeFileSync(path.join(game, 'mpgd.game.json'), '{"native":{"orientation":"landscape"}}');
    const iosIssues = inspectNativeStorePolicy({
      platform: 'ios',
      shellApp: gameShell,
      gameRoot: game,
      metadata: { iosDeviceFamily: 'iphone' },
    });
    assert.deepEqual(
      iosIssues.map((issue) => issue.level),
      ['error', 'error'],
      'device family and iPhone orientations both contradict the game',
    );
    assert.equal(
      inspectNativeStorePolicy({ platform: 'android', shellApp: gameShell, gameRoot: game })[0]?.level,
      'error',
    );
    assert.deepEqual(inspectNativeStorePolicy({ platform: 'android', shellApp: gameShell }), []);
    writeFileSync(path.join(game, 'mpgd.game.json'), '{"native":');
    assert.throws(
      () => inspectNativeStorePolicy({ platform: 'android', shellApp: gameShell, gameRoot: game }),
      /mpgd\.game\.json is not valid JSON/u,
    );
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      applyAndroidManifestOrientation(
        '<manifest><application></application></manifest>',
        'portrait',
      ),
    /no launcher activity/u,
  );
}

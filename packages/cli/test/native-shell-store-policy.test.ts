import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addIosAppResource,
  applyAndroidManifestAdId,
  applyAndroidManifestOrientation,
  applyIosInfoPlistOrientation,
  applyIosInfoPlistStorePolicy,
  applyIosProjectDeviceFamily,
  inspectAndroidManifestAds,
  inspectAndroidManifestOrientation,
  inspectIosAppPrivacyManifest,
  inspectIosInfoPlistAds,
  inspectIosInfoPlistOrientation,
  inspectIosInfoPlistStorePolicy,
  inspectIosProjectDeviceFamily,
  iosAppBundlesResource,
  iosAppPrivacyManifestFile,
  iosAppPrivacyManifestXml,
  readAndroidAdIdDeclaration,
  readGameAdvertisingIdPolicy,
  readGameNativeOrientation,
  readIosAppReleaseDeviceFamily,
  readIosDeviceFamily,
  readPlistTopLevelValue,
  setPlistTopLevelValue,
  shellUsesAdMob,
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
  // Without the ~ipad key iPad falls back to the iPhone list.
  const noIpadKey = applyIosInfoPlistOrientation(template, 'portrait').replace(
    /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>[\s\S]*?<\/array>/u,
    '',
  );
  assert.deepEqual(
    inspectIosInfoPlistOrientation(noIpadKey, 'portrait', 'universal').map((issue) => issue.level),
    ['warning'],
  );

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
  // A launcher <activity-alias> orients its target activity.
  const aliased = manifest
    .replace(/\n {12}<intent-filter>\n[\s\S]*? {12}<\/intent-filter>/u, '')
    .replace(
      '    </application>',
      '        <activity-alias android:name=".Launcher" android:targetActivity=".MainActivity" android:exported="true">\n'
        + '            <intent-filter><action android:name="android.intent.action.MAIN" />'
        + '<category android:name="android.intent.category.LAUNCHER" /></intent-filter>\n'
        + '        </activity-alias>\n    </application>',
    );
  const orientedAlias = applyAndroidManifestOrientation(aliased, 'landscape');
  assert.match(
    orientedAlias,
    /android:name="\.MainActivity"\n {12}android:exported="true"\n {12}android:screenOrientation="sensorLandscape">/u,
  );
  assert.deepEqual(inspectAndroidManifestOrientation(orientedAlias, 'landscape'), []);
  assert.equal(inspectAndroidManifestOrientation(aliased, 'landscape')[0]?.level, 'error');
  // A fully qualified or dotless target matches a relative activity name; a
  // differently named class (including a dot-boundary near miss) does not.
  const qualified = aliased.replace(
    'android:targetActivity=".MainActivity"',
    'android:targetActivity="dev.example.puzzle.MainActivity"',
  );
  assert.match(
    applyAndroidManifestOrientation(qualified, 'portrait'),
    /android:screenOrientation="portrait"/u,
  );
  assert.throws(
    () =>
      applyAndroidManifestOrientation(
        aliased.replace(
          'android:targetActivity=".MainActivity"',
          'android:targetActivity="com.other.Main"',
        ),
        'portrait',
      ),
    /no launcher activity/u,
  );
  assert.match(
    applyAndroidManifestOrientation(
      aliased.replace(
        'android:targetActivity=".MainActivity"',
        'android:targetActivity="MainActivity"',
      ),
      'portrait',
    ),
    /android:screenOrientation="portrait"/u,
  );
  assert.throws(
    () =>
      applyAndroidManifestOrientation(
        aliased.replace(
          'android:targetActivity=".MainActivity"',
          'android:targetActivity="dev.example.SubMainActivity"',
        ),
        'portrait',
      ),
    /no launcher activity/u,
  );
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
    assert.deepEqual(
      inspectNativeStorePolicy({ platform: 'android', shellApp: gameShell })
        .map((issue) => issue.message.includes('AD_ID')),
      [true],
      'without a game config only the advertising ID warning remains',
    );
    writeFileSync(
      path.join(gameShell, 'package.json'),
      JSON.stringify({ dependencies: { '@capacitor-community/admob': '8.1.0' } }),
    );
    assert.deepEqual(
      inspectNativeStorePolicy({ platform: 'android', shellApp: gameShell }).map(
        (issue) => issue.level,
      ),
      ['error'],
      'a shell with AdMob needs its application ID',
    );
    // The release source set may carry the production application ID.
    mkdirSync(path.join(gameShell, 'android/app/src/release'), { recursive: true });
    writeFileSync(
      path.join(gameShell, 'android/app/src/release/AndroidManifest.xml'),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>'
        + '<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-0000000000000000~0000000000" />'
        + '<uses-permission android:name="com.google.android.gms.permission.AD_ID" />'
        + '</application></manifest>',
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

// App privacy manifest.
{
  const project = readFileSync(
    path.join(referenceShell, 'ios/App/App.xcodeproj/project.pbxproj'),
    'utf8',
  );
  assert.equal(iosAppBundlesResource(project, iosAppPrivacyManifestFile), true);
  assert.deepEqual(inspectIosAppPrivacyManifest(project), []);
  assert.equal(addIosAppResource(project, iosAppPrivacyManifestFile), project, 'idempotent');
  const without = project
    .split('\n')
    .filter((line) => !line.includes('PrivacyInfo.xcprivacy'))
    .join('\n');
  assert.equal(iosAppBundlesResource(without, iosAppPrivacyManifestFile), false);
  assert.deepEqual(
    inspectIosAppPrivacyManifest(without).map((issue) => issue.level),
    ['warning'],
  );
  const added = addIosAppResource(without, iosAppPrivacyManifestFile) ?? '';
  assert.equal(iosAppBundlesResource(added, iosAppPrivacyManifestFile), true);
  assert.equal(
    (added.match(/PrivacyInfo\.xcprivacy/gu) ?? []).length,
    6,
    'file, build file, group, phase',
  );
  assert.match(
    added,
    /\/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.xml; path = PrivacyInfo\.xcprivacy; sourceTree = "<group>"; \};/u,
  );
  const ids = [...added.matchAll(/\b([A-F0-9]{24}) \/\* PrivacyInfo\.xcprivacy(?: in Resources)? \*\/ = /gu)]
    .map((match) => match[1]);
  assert.equal(new Set(ids).size, 2);
  assert.equal(addIosAppResource(added, iosAppPrivacyManifestFile), added);
  assert.equal(
    addIosAppResource('// !$*UTF8*$!\n{ objects = { }; }', iosAppPrivacyManifestFile),
    undefined,
  );
  // A `)` inside a comment does not end a list.
  const parenthesized = without.replace('/* Info.plist */,\n', '/* Info (1).plist */,\n');
  assert.notEqual(parenthesized, without);
  const addedAfterParen = addIosAppResource(parenthesized, iosAppPrivacyManifestFile) ?? '';
  assert.match(addedAfterParen, /\/\* Info \(1\)\.plist \*\/,\n/u);
  assert.equal(iosAppBundlesResource(addedAfterParen, iosAppPrivacyManifestFile), true);
  // Only the App group of the main group is used, not a nested folder also called App.
  const nested = without.replace(
    '/* Begin PBXGroup section */\n',
    '/* Begin PBXGroup section */\n\t\t000000000000000000000001 /* App */ = {\n\t\t\tisa = PBXGroup;\n'
      + '\t\t\tchildren = (\n\t\t\t);\n\t\t\tpath = App;\n\t\t\tsourceTree = "<group>";\n\t\t};\n',
  );
  const addedNested = addIosAppResource(nested, iosAppPrivacyManifestFile) ?? '';
  assert.match(
    addedNested,
    /000000000000000000000001 \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\);/u,
  );
  assert.match(
    addedNested,
    /\/\* public \*\/,\n\t\t\t\t[A-F0-9]{24} \/\* PrivacyInfo\.xcprivacy \*\/,/u,
  );
  // Referenced in the group but not bundled: left to the game.
  const groupOnly = added.replace(
    /\n\t+[A-F0-9]{24} \/\* PrivacyInfo\.xcprivacy in Resources \*\/,/u,
    '',
  );
  assert.equal(addIosAppResource(groupOnly, iosAppPrivacyManifestFile), undefined);
  assert.match(iosAppPrivacyManifestXml, /<key>NSPrivacyTracking<\/key>\n\t<false\/>/u);
  assert.equal(
    readFileSync(path.join(referenceShell, 'ios/App/App', iosAppPrivacyManifestFile), 'utf8'),
    iosAppPrivacyManifestXml,
    'the reference shell ships the same manifest the initializer writes',
  );
}

// Advertising declarations.
{
  assert.equal(shellUsesAdMob({ dependencies: { '@capacitor-community/admob': '8.1.0' } }), true);
  assert.equal(shellUsesAdMob({ dependencies: { '@capacitor/core': '8.5.2' } }), false);
  assert.equal(shellUsesAdMob(undefined), false);
  const manifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <application android:label="Game">',
    '    </application>',
    '    <uses-permission android:name="android.permission.INTERNET" />',
    '</manifest>',
    '',
  ].join('\n');
  assert.equal(readAndroidAdIdDeclaration(manifest), 'absent');
  const removed = applyAndroidManifestAdId(manifest, false);
  assert.equal(readAndroidAdIdDeclaration(removed), 'removed');
  assert.match(
    removed,
    /<manifest xmlns:android="[^"]+" xmlns:tools="http:\/\/schemas\.android\.com\/tools">/u,
  );
  assert.match(
    removed,
    /INTERNET" \/>\n {4}<uses-permission android:name="com\.google\.android\.gms\.permission\.AD_ID" tools:node="remove" \/>\n<\/manifest>/u,
  );
  assert.equal(applyAndroidManifestAdId(removed, false), removed, 'idempotent');
  const reference = readFileSync(
    path.join(referenceShell, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert.equal(
    applyAndroidManifestAdId(reference, false),
    reference,
    'an existing removal stays in place',
  );
  // `uses-permission-sdk-23` is a different element.
  assert.equal(
    readAndroidAdIdDeclaration(manifest.replace(
      '</manifest>',
      '    <uses-permission-sdk-23 android:name="com.google.android.gms.permission.AD_ID" />\n</manifest>',
    )),
    'absent',
  );
  const declared = applyAndroidManifestAdId(removed, true);
  assert.equal(readAndroidAdIdDeclaration(declared), 'declared');
  assert.equal((declared.match(/AD_ID/gu) ?? []).length, 1, 'the removal is replaced');
  assert.deepEqual(inspectAndroidManifestAds(removed, false), []);
  assert.deepEqual(
    inspectAndroidManifestAds(manifest, false).map((issue) => issue.level),
    ['warning'],
  );
  assert.deepEqual(
    inspectAndroidManifestAds(declared, true).map((issue) => issue.level),
    ['error'],
    'AdMob without its application ID meta-data crashes at launch',
  );
  const withAppId = declared.replace(
    '<application android:label="Game">',
    '<application android:label="Game">\n        <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-0000000000000000~0000000000" />',
  );
  assert.deepEqual(inspectAndroidManifestAds(withAppId, true), []);
  assert.deepEqual(
    inspectAndroidManifestAds(applyAndroidManifestAdId(withAppId, false), true).map(
      (issue) => issue.level,
    ),
    ['error'],
    'AdMob with the advertising ID removed fails a production build',
  );
  assert.deepEqual(
    inspectAndroidManifestAds(applyAndroidManifestAdId(withAppId, false), true, 'removed'),
    [],
    'unless the game records a no-advertising-ID policy',
  );
  assert.deepEqual(
    inspectAndroidManifestAds(withAppId, true, 'removed').map((issue) => issue.level),
    ['error'],
    'a recorded no-advertising-ID policy needs the removal in the manifest',
  );
  assert.equal(
    readGameAdvertisingIdPolicy({ ads: { admob: { advertisingId: 'removed' } } }),
    'removed',
  );
  assert.equal(readGameAdvertisingIdPolicy(undefined), 'declared');
  assert.throws(
    () => readGameAdvertisingIdPolicy({ ads: { admob: { advertisingId: 'off' } } }),
    /must be/u,
  );
  // A mixed manifest is normalised in both directions.
  const mixed = removed.replace(
    '</manifest>',
    '    <uses-permission android:name="com.google.android.gms.permission.AD_ID" />\n</manifest>',
  );
  assert.equal((applyAndroidManifestAdId(mixed, false).match(/AD_ID/gu) ?? []).length, 1);
  assert.equal(readAndroidAdIdDeclaration(applyAndroidManifestAdId(mixed, false)), 'removed');
  // A commented-out declaration does not count.
  assert.equal(
    readAndroidAdIdDeclaration(manifest.replace(
      '</manifest>',
      '<!-- <uses-permission android:name="com.google.android.gms.permission.AD_ID" tools:node="remove" /> --></manifest>',
    )),
    'absent',
  );
  // The reference shell shows no ads and removes the permission.
  assert.equal(
    readAndroidAdIdDeclaration(
      readFileSync(path.join(referenceShell, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
    ),
    'removed',
  );

  const plist = readFileSync(path.join(referenceShell, 'ios/App/App/Info.plist'), 'utf8');
  assert.deepEqual(inspectIosInfoPlistAds(plist, false), []);
  assert.deepEqual(
    inspectIosInfoPlistAds(plist, true).map((issue) => issue.level),
    ['error', 'warning'],
  );
  const withAdMob = setPlistTopLevelValue(
    setPlistTopLevelValue(
      plist,
      'GADApplicationIdentifier',
      '<string>ca-app-pub-0000000000000000~0000000000</string>',
    ),
    'SKAdNetworkItems',
    '<array><dict><key>SKAdNetworkIdentifier</key><string>cstr6suwn9.skadnetwork</string></dict></array>',
  );
  assert.deepEqual(inspectIosInfoPlistAds(withAdMob, true), []);
}

// The pinned Capacitor CLI's own native templates: what `cap add` generates.
{
  const assets = path.join(referenceShell, 'node_modules/@capacitor/cli/assets');
  const templatesPresent = existsSync(path.join(assets, 'ios-spm-template.tar.gz'))
    && existsSync(path.join(assets, 'android-template.tar.gz'));
  assert.ok(
    templatesPresent || process.env.CI === undefined,
    `CI must test the Capacitor CLI templates in ${assets}.`,
  );
  if (templatesPresent) {
    const extracted = mkdtempSync(path.join(tmpdir(), 'mpgd-capacitor-template-'));
    try {
      for (const [archive, directory] of [
        ['ios-spm-template.tar.gz', 'ios'],
        ['android-template.tar.gz', 'android'],
      ] as const) {
        mkdirSync(path.join(extracted, directory));
        const result = spawnSync('tar', [
          '-xzf',
          path.join(assets, archive),
          '-C',
          path.join(extracted, directory),
        ]);
        assert.equal(result.status, 0, `extract ${archive}`);
      }
      const project = readFileSync(
        path.join(extracted, 'ios/App/App.xcodeproj/project.pbxproj'),
        'utf8',
      );
      const added = addIosAppResource(project, iosAppPrivacyManifestFile);
      assert.ok(added !== undefined, 'the generated iOS layout takes the privacy manifest');
      assert.equal(iosAppBundlesResource(added, iosAppPrivacyManifestFile), true);
      assert.equal(
        readIosAppReleaseDeviceFamily(applyIosProjectDeviceFamily(added, 'iphone')),
        '1',
      );
      const plist = applyIosInfoPlistOrientation(
        applyIosInfoPlistStorePolicy(
          readFileSync(path.join(extracted, 'ios/App/App/Info.plist'), 'utf8'),
        ),
        'portrait',
      );
      assert.deepEqual(inspectIosInfoPlistStorePolicy(plist), []);
      assert.deepEqual(inspectIosInfoPlistOrientation(plist, 'portrait', 'universal'), []);
      const manifest = applyAndroidManifestAdId(
        applyAndroidManifestOrientation(
          readFileSync(path.join(extracted, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
          'landscape',
        ),
        false,
      );
      assert.deepEqual(inspectAndroidManifestOrientation(manifest, 'landscape'), []);
      assert.deepEqual(inspectAndroidManifestAds(manifest, false), []);
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  }
}

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  inspectSignedIosApplication,
  inspectSignedIosArchive,
  inspectSignedIosIpa,
  iosStorePushEntitlementError,
  readSignedApsEnvironment,
  type IosInspectionInput,
} from './native-ios-inspection';
import { nativeInspectionEnvironment } from './native-inspection-environment';
import { shellInstallsFirebaseMessaging } from './native-store-policy';

/** `codesign -d --entitlements - --xml` output of a store-signed app, with `extra` in its dict. */
const signedEntitlements = (extra: string): string => [
  '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ',
  '"https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>',
  '<key>application-identifier</key><string>TEAM123456.dev.example.game</string>',
  extra,
  '<key>com.apple.developer.team-identifier</key><string>TEAM123456</string>',
  '<key>get-task-allow</key><false/></dict></plist>',
].join('');

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-inspection-test-'));
const app = path.join(root, 'App.app');

try {
  const inspectionEnvironment = nativeInspectionEnvironment({
    PATH: '/usr/bin',
    DEVELOPER_DIR: '/Applications/Xcode.app',
    GITHUB_TOKEN: 'private-git-token',
    MPGD_IOS_SIGNING_P12_PASSWORD: 'private-password',
  });
  assert.deepEqual(inspectionEnvironment, {
    PATH: '/usr/bin',
    DEVELOPER_DIR: '/Applications/Xcode.app',
  });
  mkdirSync(app);
  writeFileSync(path.join(app, 'Info.plist'), 'fixture');
  writeFileSync(path.join(app, 'Assets.car'), 'release icons');
  writeFileSync(path.join(app, 'capacitor.config.json'), '{"server":{"iosScheme":"https"}}');
  const fields: Record<string, string> = {
    CFBundleIdentifier: 'dev.example.game',
    CFBundleShortVersionString: '1.4.0',
    CFBundleVersion: '42',
  };
  const input: IosInspectionInput = {
    expectedBundleId: 'dev.example.game',
    expectedMarketingVersion: '1.4.0',
    expectedBuildNumber: '42',
    expectedTeamId: 'TEAM123456',
    runner: {
      run(command, args) {
        if (command === 'codesign') {
          return args[0] === '-dv'
            ? { status: 0, stdout: '', stderr: 'TeamIdentifier=TEAM123456\n' }
            : { status: 0, stdout: '', stderr: '' };
        }
        const key = args[1]?.replace('Print :', '') ?? '';
        return { status: 0, stdout: `${fields[key] ?? ''}\n`, stderr: '' };
      },
    },
  };
  assert.deepEqual(inspectSignedIosApplication(app, input), {
    bundleId: 'dev.example.game',
    marketingVersion: '1.4.0',
    buildNumber: '42',
    teamId: 'TEAM123456',
    signed: true,
  });
  const archive = path.join(root, 'App.xcarchive');
  const archivedApp = path.join(archive, 'Products/Applications/App.app');
  mkdirSync(path.dirname(archivedApp), { recursive: true });
  cpSync(app, archivedApp, { recursive: true });
  assert.equal(inspectSignedIosArchive(archive, input).signed, true);
  const ipa = path.join(root, 'App.ipa');
  writeFileSync(ipa, 'fixture');
  const ipaInput: IosInspectionInput = {
    ...input,
    runner: {
      run(command, args) {
        if (command === 'unzip' && args[0] === '-Z1') {
          return { status: 0, stdout: 'Payload/App.app/Info.plist\n', stderr: '' };
        }
        if (command === 'unzip' && args[0] === '-q') {
          const destination = args[3];
          assert.ok(destination);
          const extractedApp = path.join(destination, 'Payload/App.app');
          mkdirSync(path.dirname(extractedApp), { recursive: true });
          cpSync(app, extractedApp, { recursive: true });
          return { status: 0, stdout: '', stderr: '' };
        }
        return input.runner?.run(command, args) ?? { status: 1, stdout: '', stderr: '' };
      },
    },
  };
  assert.equal(inspectSignedIosIpa(ipa, ipaInput).signed, true);
  assert.throws(
    () =>
      inspectSignedIosIpa(ipa, {
        ...input,
        runner: { run: () => ({ status: 0, stdout: '../escape\n', stderr: '' }) },
      }),
    /unsafe path/u,
  );
  assert.throws(
    () =>
      inspectSignedIosApplication(app, {
        ...input,
        expectedTeamId: 'OTHERTEAM',
      }),
    /expected development team/u,
  );
  rmSync(path.join(app, 'capacitor.config.json'));
  assert.throws(() => inspectSignedIosApplication(app, input), /configuration is missing/u);
  writeFileSync(path.join(app, 'capacitor.config.json'), '{"server":{"iosScheme":"https"}}');
  writeFileSync(path.join(app, 'Info-Smoke.plist'), 'smoke');
  assert.throws(() => inspectSignedIosApplication(app, input), /smoke assets/u);
  rmSync(path.join(app, 'Info-Smoke.plist'));
  writeFileSync(
    path.join(app, 'capacitor.config.json'),
    JSON.stringify({
      server: { url: 'http://localhost:5173' },
    }),
  );
  assert.throws(() => inspectSignedIosApplication(app, input), /debug bridge/u);
  writeFileSync(path.join(app, 'capacitor.config.json'), '{"server":{"iosScheme":"https"}}');

  // aps-environment of a store build whose shell installs the messaging plugin.
  const production = signedEntitlements('<key>aps-environment</key><string>production</string>');
  const development = signedEntitlements('<key>aps-environment</key><string>development</string>');
  assert.equal(readSignedApsEnvironment(production), 'production');
  assert.equal(readSignedApsEnvironment(development), 'development');
  assert.equal(readSignedApsEnvironment(signedEntitlements('')), undefined);
  assert.equal(
    readSignedApsEnvironment(''),
    undefined,
    'an unsigned-entitlements app prints nothing',
  );
  assert.equal(
    readSignedApsEnvironment(`úÞqq\u0000\u0000\u0001\u0000${production}`),
    'production',
    'a legacy blob header before the plist is skipped',
  );
  // A pretty-printed plist, as `codesign` prints on some releases.
  assert.equal(readSignedApsEnvironment(production.replaceAll('><', '>\n\t<')), 'production');
  assert.equal(readSignedApsEnvironment('Executable=/tmp/App.app'), null);
  assert.equal(
    readSignedApsEnvironment(signedEntitlements('<key>aps-environment</key><true/>')),
    null,
  );
  assert.equal(
    readSignedApsEnvironment(signedEntitlements('<key>aps-environment</key><string>')),
    null,
  );
  assert.equal(iosStorePushEntitlementError('production'), undefined);
  assert.match(
    iosStorePushEntitlementError(undefined) ?? '',
    /no aps-environment entitlement[\s\S]*lacks the Push Notifications capability[\s\S]*regenerate the App Store provisioning profile/u,
  );
  assert.match(
    iosStorePushEntitlementError('development') ?? '',
    /aps-environment = development[\s\S]*export used a development provisioning profile/u,
  );
  assert.match(iosStorePushEntitlementError(null) ?? '', /is unreadable, not production/u);

  const entitlementCalls: string[][] = [];
  const pushInput = (entitlements: { status: number; stdout: string }): IosInspectionInput => ({
    ...input,
    expectedApsEnvironment: 'production',
    runner: {
      run(command, args) {
        if (command === 'codesign' && args.includes('--entitlements')) {
          entitlementCalls.push([...args]);
          return { ...entitlements, stderr: 'Executable=App.app\n' };
        }
        return input.runner?.run(command, args) ?? { status: 1, stdout: '', stderr: '' };
      },
    },
  });
  assert.equal(
    inspectSignedIosApplication(app, pushInput({ status: 0, stdout: production })).signed,
    true,
  );
  assert.deepEqual(entitlementCalls.at(-1), ['-d', '--entitlements', '-', '--xml', app]);
  assert.throws(
    () => inspectSignedIosApplication(app, pushInput({ status: 0, stdout: development })),
    /development provisioning profile/u,
  );
  assert.throws(
    () => inspectSignedIosApplication(app, pushInput({ status: 0, stdout: signedEntitlements('') })),
    /lacks the Push Notifications capability/u,
  );
  assert.throws(
    () => inspectSignedIosApplication(app, pushInput({ status: 1, stdout: '' })),
    /entitlements could not be read/u,
  );
  assert.equal(inspectSignedIosIpa(ipa, { ...ipaInput, expectedApsEnvironment: 'production', runner: {
    run(command, args) {
      if (command === 'codesign' && args.includes('--entitlements')) {
        return { status: 0, stdout: production, stderr: '' };
      }
      return ipaInput.runner?.run(command, args) ?? { status: 1, stdout: '', stderr: '' };
    },
  } }).signed, true);
  // Without the messaging plugin the entitlements are never read, so never fail.
  const callsBefore = entitlementCalls.length;
  assert.equal(inspectSignedIosApplication(app, input).signed, true);
  assert.equal(entitlementCalls.length, callsBefore);
  const shell = path.join(root, 'shell');
  mkdirSync(shell);
  assert.equal(shellInstallsFirebaseMessaging(shell), false, 'no package.json');
  writeFileSync(
    path.join(shell, 'package.json'),
    JSON.stringify({ dependencies: { '@capacitor/core': '8.5.2' } }),
  );
  assert.equal(shellInstallsFirebaseMessaging(shell), false);
  writeFileSync(
    path.join(shell, 'package.json'),
    JSON.stringify({ dependencies: { '@capacitor-firebase/messaging': '8.5.2' } }),
  );
  assert.equal(shellInstallsFirebaseMessaging(shell), true);
  console.info('Signed iOS app inspection passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

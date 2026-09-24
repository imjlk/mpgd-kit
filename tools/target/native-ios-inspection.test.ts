import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  inspectSignedIosApplication,
  inspectSignedIosArchive,
  inspectSignedIosIpa,
  type IosInspectionInput,
} from './native-ios-inspection';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-inspection-test-'));
const app = path.join(root, 'App.app');

try {
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
  console.info('Signed iOS app inspection passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

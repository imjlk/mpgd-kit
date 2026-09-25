import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  inspectSignedAndroidBundle,
  type NativeInspectionCommandRunner,
} from './native-android-inspection';

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-aab-inspection-'));
const bundle = path.join(root, 'game.aab');
const calls: string[] = [];
const signerFingerprint = 'A1'.repeat(32);

try {
  writeFileSync(bundle, 'fixture');
  const runner: NativeInspectionCommandRunner = {
    run(command, args) {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'jarsigner') {
        return { status: 0, stdout: 'jar verified.\n', stderr: '' };
      }
      if (command === 'keytool') {
        return {
          status: 0,
          stdout: `Signer #1:\nSHA256: ${signerFingerprint.match(/../gu)?.join(':')}\n`,
          stderr: '',
        };
      }
      if (command === 'unzip') {
        return { status: 0, stdout: '{"server":{"androidScheme":"https"}}', stderr: '' };
      }
      const xpath = args.find((argument) => argument.startsWith('--xpath='));
      const value = xpath?.endsWith('@package')
        ? 'dev.example.game'
        : xpath?.endsWith('@android:versionCode')
          ? '42'
          : '1.4.0';
      return { status: 0, stdout: `${value}\n`, stderr: '' };
    },
  };
  const expected = {
    bundle,
    expectedPackageId: 'dev.example.game',
    expectedVersionCode: '42',
    expectedVersionName: '1.4.0',
    expectedSignerSha256: signerFingerprint,
  };
  assert.deepEqual(inspectSignedAndroidBundle({ ...expected, runner }), {
    packageId: 'dev.example.game',
    versionCode: '42',
    versionName: '1.4.0',
    signed: true,
  });
  assert.equal(calls.length, 6);
  assert.throws(
    () =>
      inspectSignedAndroidBundle({
        ...expected,
        expectedSignerSha256: 'B2'.repeat(32),
        runner,
      }),
    /signer does not match/u,
  );
  assert.throws(
    () =>
      inspectSignedAndroidBundle({
        ...expected,
        expectedSignerSha256: '',
        runner,
      }),
    /fingerprint is missing or invalid/u,
  );
  assert.throws(
    () =>
      inspectSignedAndroidBundle({
        ...expected,
        expectedVersionCode: '43',
        runner,
      }),
    /versionCode does not match/u,
  );
  assert.throws(
    () =>
      inspectSignedAndroidBundle({
        ...expected,
        runner: { run: () => ({ status: 0, stdout: 'jar is unsigned.', stderr: '' }) },
      }),
    /not verifiably signed/u,
  );
  assert.throws(
    () => inspectSignedAndroidBundle({
      ...expected,
      runner: {
        run(command, args) {
          if (command === 'unzip') {
            return { status: 0, stdout: '{"server":{"url":"http://localhost:5173"}}', stderr: '' };
          }
          return runner.run(command, args);
        },
      },
    }),
    /live-reload bridge/u,
  );
  assert.throws(
    () =>
      inspectSignedAndroidBundle({
        ...expected,
        runner: {
          run(command, args) {
            if (command === 'unzip') {
              return {
                status: 0,
                stdout: '{"android":{"webContentsDebuggingEnabled":true}}',
                stderr: '',
              };
            }
            return runner.run(command, args);
          },
        },
      }),
    /enables WebView debugging/u,
  );
  console.info('Signed Android app bundle inspection passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

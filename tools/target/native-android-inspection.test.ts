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

try {
  writeFileSync(bundle, 'fixture');
  const runner: NativeInspectionCommandRunner = {
    run(command, args) {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'jarsigner') {
        return { status: 0, stdout: 'jar verified.\n', stderr: '' };
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
  };
  assert.deepEqual(inspectSignedAndroidBundle({ ...expected, runner }), {
    packageId: 'dev.example.game',
    versionCode: '42',
    versionName: '1.4.0',
    signed: true,
  });
  assert.equal(calls.length, 4);
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
  console.info('Signed Android app bundle inspection passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

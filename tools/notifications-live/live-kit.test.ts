import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertLiveWorkerOrigin,
  developmentSessionAuthorization,
  hasTestEnvironmentLabel,
  LiveDriverUsageError,
  redactLiveSecrets,
} from './driver';
import { checkLiveEmulator, type AdbResult } from './emulator';
import { assertLiveReadablePath, formatLiveEnvValue } from './worker-env';

// The live kit's pure parts. The driver itself runs against the in-process
// Worker in apps/game-services-worker/src/notificationsLiveDriver.test.ts.

await test('the driver calls this machine, or a --staging host with a test label, and nothing else', () => {
  for (const local of [
    'http://127.0.0.1:8787',
    'http://localhost:8787/',
    'http://[::1]:8787',
    'https://game.localhost',
  ]) {
    assert.equal(assertLiveWorkerOrigin(local).local, true, local);
  }
  assert.deepEqual(
    assertLiveWorkerOrigin('https://mpgd-game-services-staging.example.workers.dev', 'mpgd-game-services-staging.example.workers.dev'),
    { origin: 'https://mpgd-game-services-staging.example.workers.dev', local: false },
  );
  assert.equal(assertLiveWorkerOrigin('https://qa.games.example.com', 'QA.games.example.com').local, false);
  const refusals: readonly (readonly [string, string | undefined, RegExp])[] = [
    ['https://game-services.example.com', undefined, /--staging/u],
    ['https://game-services.example.com', 'game-services.example.com', /no label/u],
    // The top-level domain is not a test label.
    ['https://game-services.example.dev', 'game-services.example.dev', /no label/u],
    ['https://staging.example.com', 'other-staging.example.com', /does not name/u],
    ['http://staging.example.com', 'staging.example.com', /https only/u],
    ['https://10.0.0.5', '10.0.0.5', /no label/u],
    ['http://127.0.0.1:8787/game-services', undefined, /origin only/u],
    ['http://user:secret@127.0.0.1:8787', undefined, /credentials/u],
    ['ftp://127.0.0.1', undefined, /http or https/u],
    ['not a url', undefined, /not a URL/u],
  ];
  for (const [url, staging, message] of refusals) {
    assert.throws(() => assertLiveWorkerOrigin(url, staging), (error: unknown) =>
      error instanceof LiveDriverUsageError && message.test(error.message), url);
  }
  assert.equal(hasTestEnvironmentLabel('preview-123.pages.example.com'), true);
  assert.equal(hasTestEnvironmentLabel('devices.example.com'), false);
});

await test('a development session token is built only from short, plain ids', () => {
  assert.equal(
    developmentSessionAuthorization({
      playerId: 'p-1',
      sessionId: 's_1',
      installationId: 'device-1',
    }),
    'Bearer mpgd-dev.p-1.s_1.device-1',
  );
  for (const bad of ['', 'a.b', 'a b', 'x'.repeat(65), 'p/1']) {
    assert.throws(
      () => developmentSessionAuthorization({ playerId: bad, sessionId: 's', installationId: 'i' }),
      LiveDriverUsageError,
      JSON.stringify(bad),
    );
  }
});

await test('log lines never carry a secret', () => {
  assert.equal(
    redactLiveSecrets('Authorization: Bearer abc.def token=tok-12345', ['Bearer abc.def', 'abc.def', 'tok-12345']),
    'Authorization: <redacted> token=<redacted>',
  );
  // Too short to redact without mangling the log.
  assert.equal(redactLiveSecrets('a b c', ['a']), 'a b c');
});

await test('env file values survive wrangler dotenv parsing and expansion', () => {
  assert.equal(formatLiveEnvValue('{"a":"b"}'), `'{"a":"b"}'`);
  assert.equal(formatLiveEnvValue(`{"copy":"Today's run"}`), '`{"copy":"Today\'s run"}`');
  assert.equal(formatLiveEnvValue('cost $5 and ${HOME}'), String.raw`'cost \$5 and \${HOME}'`);
  assert.throws(() => formatLiveEnvValue("both ' and `"), LiveDriverUsageError);
  assert.throws(() => formatLiveEnvValue('two\nlines'), LiveDriverUsageError);
});

await test('the kit never reads the mise secrets directory', () => {
  const home = join('/', 'home', 'maintainer');
  assert.throws(
    () => assertLiveReadablePath(join(home, '.config', 'mise', 'config.local.toml'), home),
    /does not read/u,
  );
  assert.throws(() => assertLiveReadablePath(join(home, '.config', 'mise'), home), /does not read/u);
  assert.equal(
    assertLiveReadablePath(join(home, 'keys', 'firebase.json'), home),
    join(home, 'keys', 'firebase.json'),
  );
});

/** A fake adb: answers by the arguments after `-s <serial>`. */
function fakeAdb(answers: Readonly<Record<string, string>>, calls: string[][]) {
  return (args: readonly string[]): AdbResult => {
    calls.push([...args]);
    const key = (args[0] === '-s' ? args.slice(2) : args).join(' ');
    const stdout = answers[key];
    return stdout === undefined ? { status: 0, stdout: '' } : { status: 0, stdout };
  };
}

await test('the emulator check reads the device and sets only the port forward', () => {
  const ready = {
    devices: 'List of devices attached\nemulator-5554\tdevice\n\n',
    'shell getprop ro.build.version.sdk': '34\n',
    'shell pm list packages com.google.android.gms': 'package:com.google.android.gms\npackage:com.google.android.gms.policy_sidecar_aps\n',
    'shell pm list packages com.android.vending': 'package:com.android.vending\n',
    'shell pm list packages dev.example.live': 'package:dev.example.live\n',
    'shell dumpsys package dev.example.live':
      '    runtime permissions:\n      android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]\n',
  };
  const calls: string[][] = [];
  let reversed = false;
  const adb = fakeAdb(ready, calls);
  const report = checkLiveEmulator(
    { appId: 'dev.example.live', port: 8787, reverse: true },
    (args) => {
      if (args.join(' ') === '-s emulator-5554 reverse tcp:8787 tcp:8787') {
        reversed = true;
      }
      if (args.join(' ') === '-s emulator-5554 reverse --list') {
        return { status: 0, stdout: reversed ? 'emulator-5554 tcp:8787 tcp:8787\n' : '' };
      }
      return adb(args);
    },
  );
  assert.ok(report.ok, JSON.stringify(report.lines));
  assert.equal(report.serial, 'emulator-5554');
  assert.deepEqual(report.lines.map((line) => `${line.result} ${line.check}`), [
    'pass device',
    'pass android-version',
    'pass google-play-services',
    'pass google-play-store',
    'pass app',
    'pass notification-permission',
    'pass reverse',
  ]);
  assert.ok(reversed);
  // Only reads, and the one forward it was asked for.
  const writes = calls.filter((args) => !['devices', 'shell', 'reverse'].includes(args[0] === '-s' ? (args[2] ?? '') : (args[0] ?? '')));
  assert.deepEqual(writes, []);

  // An image without Play services, the app missing, and two devices online.
  const bare = checkLiveEmulator(
    { appId: 'dev.example.live', serial: 'emulator-5556', port: 8787, reverse: false },
    fakeAdb({
      devices: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\nR58M\tunauthorized\n',
      'shell getprop ro.build.version.sdk': '35',
      'shell pm list packages com.google.android.gms': '',
      'shell pm list packages dev.example.live': 'package:dev.example.live.debug\n',
    }, []),
  );
  assert.equal(bare.ok, false);
  assert.deepEqual(bare.lines.map((line) => `${line.result} ${line.check}`), [
    'pass device',
    'pass android-version',
    'fail google-play-services',
    'warn google-play-store',
    'fail app',
    'warn reverse',
  ]);
  const ambiguous = checkLiveEmulator(
    { appId: 'dev.example.live', port: 8787, reverse: false },
    fakeAdb({ devices: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n' }, []),
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.lines[0]?.detail ?? '', /--serial/u);
  assert.throws(() => checkLiveEmulator({ appId: 'not an id', port: 8787, reverse: false }, fakeAdb({}, [])));
});

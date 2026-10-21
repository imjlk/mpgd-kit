import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  assertLiveWorkerOrigin,
  developmentSessionAuthorization,
  hasTestEnvironmentLabel,
  LiveDriverUsageError,
  parseDevelopmentSessionAuthorization,
  redactLiveSecrets,
  runNotificationsLiveDriver,
  type LiveDriverDependencies,
  type LiveDriverFetch,
  type LiveDriverOptions,
} from './driver';
import { parseRunArguments } from './cli';
import { checkLiveEmulator, onlineAdbSerials, type AdbResult } from './emulator';
import { assertLiveReadablePath, formatLiveEnvValue, writeLiveWorkerEnvFile } from './worker-env';

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
  // A trailing dot would make the TLD look like an inner label.
  assert.throws(
    () => assertLiveWorkerOrigin('https://svc.example.dev.', 'svc.example.dev.'),
    /ends with a dot/u,
  );
  assert.equal(hasTestEnvironmentLabel('svc.example.dev.'), false);
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
  assert.deepEqual(parseDevelopmentSessionAuthorization('Bearer mpgd-dev.p-1.s_1.device-1'), {
    playerId: 'p-1',
    sessionId: 's_1',
    installationId: 'device-1',
  });
  for (const bad of ['Bearer mpgd-dev.p.s', 'Bearer mpgd-dev.p.s.i.x', 'mpgd-dev.p.s.i', `Bearer mpgd-dev.${'x'.repeat(65)}.s.i`]) {
    assert.equal(parseDevelopmentSessionAuthorization(bad), undefined, bad);
  }
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
  // JSON carries a quote as \u0027, which JSON.parse reads back as '.
  const copy = JSON.stringify({ copy: "Today's run, `quoted`" });
  const quoted = formatLiveEnvValue(copy, { json: true });
  assert.equal(quoted, String.raw`'{"copy":"Today\u0027s run, ` + '`quoted`' + `"}'`);
  assert.deepEqual(JSON.parse(quoted.slice(1, -1)), { copy: "Today's run, `quoted`" });
  assert.equal(formatLiveEnvValue('cost $5 and ${HOME}'), String.raw`'cost \$5 and \${HOME}'`);
  assert.throws(() => formatLiveEnvValue("it's"), LiveDriverUsageError);
  assert.throws(() => formatLiveEnvValue('ends with \\'), LiveDriverUsageError);
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

/**
 * A fake adb: answers by the arguments after `-s <serial>`; an unknown call
 * answers empty, and each call in `failing` exits non-zero with adb's own
 * complaint on stderr.
 */
function fakeAdb(answers: Readonly<Record<string, string>>, calls: string[][], failing: readonly string[] = []) {
  return (args: readonly string[]): AdbResult => {
    calls.push([...args]);
    const key = (args[0] === '-s' ? args.slice(2) : args).join(' ');
    if (failing.includes(key)) {
      return { status: 1, stdout: '', stderr: 'error: device offline\n' };
    }
    return { status: 0, stdout: answers[key] ?? '' };
  };
}

/** Every adb call any check in this file made, for the allow-list. */
const everyAdbCall: string[][] = [];

/** Every adb call the check may make: reads, and the one forward it was asked for. */
function isAllowedAdbCall(args: readonly string[]): boolean {
  const call = (args[0] === '-s' ? args.slice(2) : args).join(' ');
  return [
    /^devices$/u,
    /^shell getprop (?:sys\.boot_completed|ro\.build\.version\.sdk)$/u,
    /^shell pm list packages [A-Za-z0-9_.]+$/u,
    /^shell true$/u,
    /^shell dumpsys package [A-Za-z0-9_.]+$/u,
    /^reverse --list$/u,
    /^reverse tcp:(\d+) tcp:\1$/u,
  ].some((pattern) => pattern.test(call));
}

const readyDevice: Readonly<Record<string, string>> = {
  devices: '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\r\nemulator-5554\tdevice\r\n\r\n',
  'shell getprop sys.boot_completed': '1\n',
  'shell getprop ro.build.version.sdk': '34\n',
  'shell pm list packages com.google.android.gms':
    'package:com.google.android.gms\npackage:com.google.android.gms.policy_sidecar_aps\n',
  'shell pm list packages com.android.vending': 'package:com.android.vending\n',
  'shell pm list packages dev.example.live': 'package:dev.example.live\n',
  'shell dumpsys package dev.example.live': [
    '    runtime permissions:',
    '      dev.example.live.android.permission.POST_NOTIFICATIONS: granted=false',
    '      android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]',
    '',
  ].join('\n'),
};

await test('the emulator check reads the device and sets only the port forward', () => {
  const calls: string[][] = [];
  let reversed = false;
  const adb = fakeAdb(readyDevice, calls);
  const report = checkLiveEmulator(
    { appId: 'dev.example.live', port: 8787, reverse: true },
    (args) => {
      if (args.join(' ') === '-s emulator-5554 reverse tcp:8787 tcp:8787') {
        reversed = true;
      }
      if (args.join(' ') === '-s emulator-5554 reverse --list') {
        calls.push([...args]);
        return { status: 0, stdout: reversed ? 'emulator-5554 tcp:18787 tcp:8787\nemulator-5554 tcp:8787 tcp:8787\n' : '' };
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
  // Reads, and the one forward it was asked for: nothing grants, installs, or changes settings.
  assert.deepEqual(calls.filter((args) => !isAllowedAdbCall(args)), []);
  assert.ok(!isAllowedAdbCall(['-s', 'emulator-5554', 'shell', 'pm', 'grant', 'dev.example.live', 'android.permission.POST_NOTIFICATIONS']));

  // Without --reverse nothing is set, and a forward to another host port does not count.
  const unset: string[][] = [];
  const noReverse = checkLiveEmulator(
    { appId: 'dev.example.live', port: 8787, reverse: false },
    fakeAdb({ ...readyDevice, 'reverse --list': 'emulator-5554 tcp:8787 tcp:9999\n' }, unset),
  );
  assert.equal(noReverse.lines.at(-1)?.result, 'warn');
  assert.ok(unset.every((args) => !args.includes('tcp:8787') || args.includes('--list')));
});

await test('the emulator check names what is missing, and an adb failure as an adb failure', () => {
  // An image without Play services, the app missing, and two devices online.
  const bare = checkLiveEmulator(
    { appId: 'dev.example.live', serial: 'emulator-5556', port: 8787, reverse: false },
    fakeAdb(
      {
        devices: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\nR58M\tunauthorized\nemulator-5558\toffline\n',
        'shell getprop sys.boot_completed': '1',
        'shell getprop ro.build.version.sdk': '35',
        'shell pm list packages dev.example.live': 'package:dev.example.live.debug\n',
      },
      [],
    ),
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
  const lines = (
    answers: Readonly<Record<string, string>>,
    options: { serial?: string } = {},
    failing: readonly string[] = [],
  ) =>
    checkLiveEmulator({ appId: 'dev.example.live', port: 8787, reverse: true, ...options }, fakeAdb(answers, everyAdbCall, failing))
      .lines.map((line) => `${line.result} ${line.check}: ${line.detail}`);
  assert.match(
    lines({ devices: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n' })[0] ?? '',
    /--serial/u,
  );
  assert.match(lines(readyDevice, { serial: 'emulator-5558' })[0] ?? '', /emulator-5558 is not online/u);
  assert.match(lines({ devices: 'List of devices attached\n' })[0] ?? '', /no emulator or device is online/u);
  assert.match(lines({ ...readyDevice, 'shell getprop sys.boot_completed': '' }).at(-1) ?? '', /fail boot/u);
  // A device that drops mid-check is an adb failure, not a missing Play services; adb's own words come along.
  assert.match(
    lines(readyDevice, {}, ['shell pm list packages com.google.android.gms', 'shell true']).at(-1) ?? '',
    /^fail adb: .*pm list packages com\.google\.android\.gms failed \(exit 1: error: device offline\)/u,
  );
  // A pm that exits non-zero for no match on a device that still answers: not installed.
  assert.ok(
    lines(readyDevice, {}, ['shell pm list packages com.google.android.gms']).some((line) =>
      line.startsWith('fail google-play-services')),
  );
  assert.match(
    lines(readyDevice, {}, ['reverse tcp:8787 tcp:8787']).at(-1) ?? '',
    /^fail adb: .*reverse tcp:8787 tcp:8787 failed .*reverse --remove tcp:8787/u,
  );
  assert.match(
    lines({ ...readyDevice, devices: '' }, {}, ['devices'])[0] ?? '',
    /^fail adb: adb devices failed \(error: device offline\)/u,
  );
  // Output without the device list header lists no device.
  assert.deepEqual(onlineAdbSerials('* daemon not running\nemulator-5554\tdevice\n'), []);
  // The permission line: refused, never requested, or skipped below API 33 and when the level is unknown.
  assert.ok(lines({
    ...readyDevice,
    'shell dumpsys package dev.example.live': '      android.permission.POST_NOTIFICATIONS: granted=false\n',
  }).includes("warn notification-permission: POST_NOTIFICATIONS is not granted yet: turn notifications on from the game's settings screen (a tap), not with adb."));
  assert.ok(lines({ ...readyDevice, 'shell dumpsys package dev.example.live': '' }).some((line) =>
    line.startsWith('warn notification-permission: POST_NOTIFICATIONS is not in the app')));
  assert.ok(!lines({ ...readyDevice, 'shell getprop ro.build.version.sdk': '32' }).some((line) =>
    line.includes('notification-permission')));
  assert.ok(lines({ ...readyDevice, 'shell getprop ro.build.version.sdk': '' }).includes(
    'warn android-version: could not read ro.build.version.sdk; the permission check is skipped.',
  ));
  assert.throws(
    () => checkLiveEmulator({ appId: 'not an id', port: 8787, reverse: false }, fakeAdb({}, [])),
    LiveDriverUsageError,
  );
  assert.throws(
    () => checkLiveEmulator({ appId: 'dev.example.live', port: 65_536, reverse: false }, fakeAdb({}, [])),
    LiveDriverUsageError,
  );
  // Across every branch above, only reads and the one forward.
  assert.deepEqual(everyAdbCall.filter((args) => !isAllowedAdbCall(args)), []);
});

await test('run arguments: the session, the guard, and numbers are checked, and no secret is echoed', () => {
  const now = () => new Date('2026-10-21T12:34:56.000Z');
  const parse = (args: readonly string[], env: Readonly<Record<string, string>> = {}) =>
    parseRunArguments(args, { env, readTokenFile: () => ' token-from-file \n', now });
  const local = parse(['--player', 'live-1']);
  assert.equal(local.authorization, 'Bearer mpgd-dev.live-1.live-driver.live-driver');
  assert.equal(local.worker.origin, 'http://127.0.0.1:8787');
  assert.equal(local.runId, '20261021123456');
  assert.equal(local.fireInSeconds, 5);
  assert.equal(local.triggerScheduler, true);
  assert.equal(parse(['--player', 'live-1', '--no-scheduler']).triggerScheduler, false);
  assert.equal(parse(['--player', 'live-1', '--fcm-token-file', '/tmp/token']).fcmToken, 'token-from-file');
  const staged = parse(
    ['--worker', 'https://svc-staging.example.com', '--staging', 'svc-staging.example.com', '--auth-env', 'LIVE_AUTH'],
    { LIVE_AUTH: '  Bearer real-session  ' },
  );
  assert.equal(staged.authorization, 'Bearer real-session');
  assert.equal(staged.triggerScheduler, false);
  assert.equal(staged.playerId, undefined);
  const secret = 'Bearer pasted-secret';
  for (const [args, message] of [
    [['--auth-env', secret], /name of an environment variable/u],
    [['--auth-env', 'EMPTY'], /\$EMPTY is empty/u],
    [['--auth-env', 'LIVE_AUTH', '--player', 'p'], /development one/u],
    [['--auth-env', 'LIVE_AUTH', '--session', 's'], /development one/u],
    [['--staging', 'svc-staging.example.com', '--player', 'p'], /pass --worker/u],
    [['--worker', 'http://127.0.0.1:8787', '--staging', 'x-staging.example.com', '--player', 'p'], /needs no --staging/u],
    [['--player', 'p', '--fire-in', ''], /--fire-in "" is not a whole number/u],
    [['--player', 'p', '--fire-in', '1e3'], /not a whole number/u],
    [['--player', 'p', '--fire-in', '9999'], /at most 3600/u],
    [['--player', 'p', '--fire-in', '72000000'], /at most 3600/u],
    [[], /--player or --auth-env is required/u],
  ] as const) {
    let thrown: unknown;
    try {
      parse(args, { LIVE_AUTH: 'Bearer real-session', EMPTY: ' ' });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof LiveDriverUsageError, `${args.join(' ')}: ${String(thrown)}`);
    assert.match(thrown.message, message, args.join(' '));
    assert.ok(!thrown.message.includes('pasted-secret'));
  }
  // An unquoted pasted token is a stray positional: refused without quoting it.
  assert.throws(() => parse(['--auth-env', 'Bearer', 'tok-pasted-value']), (error: unknown) =>
    error instanceof LiveDriverUsageError && /unexpected argument/u.test(error.message)
    && !error.message.includes('tok-pasted-value'));
  // An opaque value that happens to look like a name is not repeated when it is unset.
  assert.throws(() => parse(['--auth-env', 'abc123opaque']), (error: unknown) =>
    error instanceof LiveDriverUsageError && !error.message.includes('abc123opaque'));
  assert.throws(() => parse(['--player', '']), /--player or --auth-env is required/u);
  assert.throws(() => parse(['--player', 'p', '--unknown']), (error: unknown) =>
    (error as { readonly code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
});

await test('the env file never lands in a repository, through a link, or under a wider mode', (context) => {
  if (insideGitCheckout(tmpdir())) {
    context.skip('the temporary directory is inside a git checkout');
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'mpgd-live-kit-'));
  try {
    const repository = join(scratch, 'kit');
    mkdirSync(join(repository, '..hidden'), { recursive: true });
    const outside = join(scratch, 'out');
    mkdirSync(outside);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = join(scratch, 'key.json');
    writeFileSync(key, JSON.stringify({
      type: 'service_account',
      project_id: 'mpgd-live-kit',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'sender@mpgd-live-kit.iam.gserviceaccount.com',
    }));
    const overlay = join('packages', 'cli', 'templates', 'notifications-overlay', 'common', 'notifications');
    const catalog = join(scratch, 'topics.json');
    writeFileSync(catalog, readFileSync(join(overlay, 'topics.json'), 'utf8').replaceAll('__GAME_TITLE__', 'Kit'));
    const deployment = join(scratch, 'deployment.json');
    writeFileSync(deployment, JSON.stringify({ advertisingRules: 'kr', advertisingSender: { name: 'Kit', contact: '080-000-0000' } }));
    const input = { catalogPath: catalog, deploymentPath: deployment, serviceAccountPath: key, repositoryRoot: repository };

    // A directory whose name starts with two dots is still inside.
    assert.throws(() => writeLiveWorkerEnvFile({ ...input, outPath: join(repository, '..hidden', 'live.env') }), /inside the git checkout/u);
    // So is any other checkout.
    const other = join(scratch, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    mkdirSync(join(other, 'sub'));
    assert.throws(() => writeLiveWorkerEnvFile({ ...input, outPath: join(other, 'sub', 'live.env') }), /inside the git checkout/u);
    // A link would write the key where it points.
    symlinkSync(join(repository, 'target.env'), join(outside, 'link.env'));
    assert.throws(() => writeLiveWorkerEnvFile({ ...input, outPath: join(outside, 'link.env') }), /symbolic link/u);
    // A key file that cannot be read is named by its code, not called "not JSON".
    assert.throws(
      () => writeLiveWorkerEnvFile({ ...input, serviceAccountPath: join(scratch, 'missing.json'), outPath: join(outside, 'a.env') }),
      /could not be read \(ENOENT\)/u,
    );
    assert.throws(
      () => writeLiveWorkerEnvFile({ ...input, projectId: 'Bad\\', outPath: join(outside, 'a.env') }),
      /--project-id is not a Firebase project id/u,
    );
    // An existing directory is not replaced, with or without --force.
    mkdirSync(join(outside, 'dir.env'));
    assert.throws(
      () => writeLiveWorkerEnvFile({ ...input, outPath: join(outside, 'dir.env'), overwrite: true }),
      /not a file/u,
    );
    // Replacing a file recreates it with mode 0600.
    const out = join(outside, 'live.env');
    writeFileSync(out, 'old', { mode: 0o644 });
    const result = writeLiveWorkerEnvFile({ ...input, outPath: out, overwrite: true, projectId: 'mpgd-live-other' });
    assert.deepEqual(result.variables.slice(-1), ['FCM_PROJECT_ID']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(out).mode & 0o777, 0o600);
    }
    // Every line is one quoted value wrangler reads back.
    for (const line of readFileSync(out, 'utf8').split('\n').filter((entry) => entry.length > 0 && !entry.startsWith('#'))) {
      assert.match(line, /^[A-Z_]+='[^'\n]*'$/u);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

await test('the mise directory is refused through links and case', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mpgd-live-kit-'));
  try {
    const home = join(scratch, 'home');
    mkdirSync(join(home, '.config', 'mise'), { recursive: true });
    writeFileSync(join(home, '.config', 'mise', 'config.local.toml'), 'secret = "x"');
    symlinkSync(join(home, '.config', 'mise', 'config.local.toml'), join(scratch, 'innocent.json'));
    assert.throws(
      () => assertLiveReadablePath(join(scratch, 'innocent.json'), home),
      /does not read/u,
    );
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.throws(
        () => assertLiveReadablePath(join(home, '.config', 'MISE', 'config.local.toml'), home),
        /does not read/u,
      );
    }
    // mise's other homes.
    assert.throws(
      () => assertLiveReadablePath(join(scratch, 'xdg', 'mise', 'config.toml'), home, { XDG_CONFIG_HOME: join(scratch, 'xdg') }),
      /does not read/u,
    );
    assert.throws(
      () => assertLiveReadablePath(join(scratch, 'm', 'x.toml'), home, { MISE_CONFIG_DIR: join(scratch, 'm') }),
      /does not read/u,
    );
    assert.equal(assertLiveReadablePath(join(scratch, 'key.json'), home, {}), join(scratch, 'key.json'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** Whether a directory is inside a git checkout (the env file refuses to be written there). */
function insideGitCheckout(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      return true;
    }
    if (dirname(current) === current) {
      return false;
    }
  }
}

/** A scripted Worker for the driver's own branches; the real one runs in the dry run. */
function scriptedWorker(script: {
  readonly scheduledStatus?: number;
  readonly providersBody?: string;
} = {}): { readonly fetch: LiveDriverFetch; readonly calls: string[] } {
  const calls: string[] = [];
  let scheduled = false;
  const answer = (status: number, body: unknown) => ({
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return {
    calls,
    fetch: async (url, init) => {
      const path = new URL(url).pathname.replace('/game-services/notifications', '');
      calls.push(`${init.method} ${path}`);
      const authorized = init.headers['authorization'] !== undefined;
      const body = init.body === undefined ? {} : JSON.parse(init.body) as Record<string, unknown>;
      switch (`${init.method} ${path}`) {
        case 'GET /providers':
          return answer(
            200,
            script.providersBody ?? { protocolVersion: '2', targets: { android: 'fcm' } },
          );
        case 'GET /consent':
          return authorized
            ? answer(200, { records: [{ kind: 'delivery-permission', state: 'granted' }] })
            : answer(401, { error: 'UNAUTHORIZED' });
        case 'POST /consent':
          return answer(200, { record: body['record'] });
        case 'POST /reminders':
          return answer(200, { status: 'scheduled' });
        case 'POST /reminders/cancel':
          return answer(200, { cancelled: !scheduled });
        case 'GET /cdn-cgi/handler/scheduled':
          scheduled = true;
          return answer(script.scheduledStatus ?? 200, 'ok');
        case 'GET /notices':
          return answer(200, { notices: [] });
        default:
          return answer(404, { error: 'UNKNOWN_ENDPOINT' });
      }
    },
  };
}

const scriptedOptions: LiveDriverOptions = {
  worker: { origin: 'http://127.0.0.1:8787', local: true },
  authorization: 'Bearer mpgd-dev.p-kit.s-kit.i-kit',
  sessionLabel: 'development session for player p-kit',
  playerId: 'p-kit',
  target: 'android',
  topic: 'daily-ready',
  runId: 'kit',
  fireInSeconds: 3,
  triggerScheduler: true,
};

await test('the driver waits for the reminder, flags a replayed send, and stops on a broken scheduler route', async () => {
  const lines: string[] = [];
  const slept: number[] = [];
  let clock = 1_800_000_000_000;
  const dependencies = (fetch: LiveDriverFetch): LiveDriverDependencies => ({
    fetch,
    log: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    deliver: async () => ({ status: 'delivered', alreadyProcessed: true }),
  });
  const passed = await runNotificationsLiveDriver(
    { ...scriptedOptions, deliver: { topic: 'friend-challenge' } },
    dependencies(scriptedWorker().fetch),
  );
  assert.ok(passed.ok, lines.join('\n'));
  assert.deepEqual(slept, [4000]);
  assert.deepEqual(passed.steps.find((step) => step.name === 'deliver')?.result, 'warn');

  // Without the RPC (a wrangler dev run) the send is skipped, not failed.
  const { deliver: _deliver, ...withoutDeliver } = dependencies(scriptedWorker().fetch);
  const skipped = await runNotificationsLiveDriver({ ...scriptedOptions, deliver: { topic: 'friend-challenge' } }, withoutDeliver);
  assert.equal(skipped.steps.find((step) => step.name === 'deliver')?.result, 'skip');

  const broken = await runNotificationsLiveDriver(scriptedOptions, dependencies(scriptedWorker({ scheduledStatus: 404 }).fetch));
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.steps.find((step) => step.result === 'fail'), {
    name: 'scheduler',
    result: 'fail',
    detail: 'the scheduled route answered 404: is this wrangler dev 4.x?',
  });
  // The failed run cancels the reminder it left pending, so no push arrives later.
  assert.deepEqual(broken.steps.at(-1), { name: 'cancel-leftover-reminder', result: 'pass', detail: 'answered 200' });

  // A clean-up that cannot reach the Worker warns; it never fails a run that passed.
  const flaky = scriptedWorker();
  const report = await runNotificationsLiveDriver(
    { ...scriptedOptions, fcmToken: 'fcm-token-for-cleanup-0123', fireInSeconds: 0 },
    dependencies(async (url, init) => {
      if (url.endsWith('/endpoints/unregister')) {
        throw new Error('connection reset');
      }
      return url.endsWith('/endpoints') ? { status: 200, text: async () => '{}' } : await flaky.fetch(url, init);
    }),
  );
  assert.ok(report.ok, lines.join('\n'));
  assert.equal(report.steps.at(-1)?.name, 'unregister-endpoint');
  assert.equal(report.steps.at(-1)?.result, 'warn');

  await assert.rejects(
    runNotificationsLiveDriver({ ...scriptedOptions, fireInSeconds: Number.NaN }, dependencies(scriptedWorker().fetch)),
    LiveDriverUsageError,
  );
  await assert.rejects(
    runNotificationsLiveDriver(
      { ...scriptedOptions, worker: { origin: 'https://qa.example.com', local: false } },
      dependencies(scriptedWorker().fetch),
    ),
    /local wrangler dev/u,
  );
});

await test('an answer that echoes a secret is redacted before it is cut', async () => {
  const lines: string[] = [];
  const token = 'fcm-token-that-must-not-print-0123456789';
  // The token straddles the 600-character cut of the printed answer.
  const providersBody = `${'x'.repeat(590)}${token}${scriptedOptions.authorization}`;
  const report = await runNotificationsLiveDriver(
    { ...scriptedOptions, fcmToken: token },
    {
      fetch: scriptedWorker({ providersBody }).fetch,
      log: (line) => lines.push(line),
      now: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(report.ok, false);
  const log = lines.join('\n');
  // The 600-character cut falls inside the token: only the redaction marker may stand there.
  assert.ok(log.includes(`${'x'.repeat(590)}<redacted>`), log);
  for (const secret of [token.slice(0, 10), 'mpgd-dev.p-kit', scriptedOptions.authorization]) {
    assert.ok(!log.includes(secret), `the log shows ${secret}`);
  }
  assert.ok(report.steps.every((step) => !step.detail.includes(token)));
});

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { checkLiveEmulator, type AdbResult } from './emulator';
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

await test('the env file never lands in a repository, through a link, or under a wider mode', () => {
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
    assert.throws(() => writeLiveWorkerEnvFile({ ...input, outPath: join(repository, '..hidden', 'live.env') }), /inside the repository/u);
    // So is any other checkout.
    const other = join(scratch, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    mkdirSync(join(other, 'sub'));
    assert.throws(() => writeLiveWorkerEnvFile({ ...input, outPath: join(other, 'sub', 'live.env') }), /inside the repository/u);
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
      /--project-id/u,
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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
  assert.deepEqual(broken.steps.at(-1), {
    name: 'scheduler',
    result: 'fail',
    detail: 'the scheduled route answered 404: is this wrangler dev 4.x?',
  });

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
  for (const secret of [token.slice(0, 12), 'mpgd-dev.p-kit', scriptedOptions.authorization]) {
    assert.ok(!log.includes(secret), `the log shows ${secret}`);
  }
  assert.ok(report.steps.every((step) => !step.detail.includes(token)));
});

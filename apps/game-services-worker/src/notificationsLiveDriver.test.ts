import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertLiveWorkerOrigin,
  developmentSessionAuthorization,
  runNotificationsLiveDriver,
  wranglerDevScheduledRoute,
  type LiveDriverDependencies,
  type LiveDriverOptions,
} from '../../../tools/notifications-live/driver';
import { writeLiveWorkerEnvFile } from '../../../tools/notifications-live/worker-env';
import { createWorkerFetchHandler, type GameServicesWorkerEnv } from './handler.js';
import { deliverWorkerNotification, runScheduledNotifications } from './notificationsHandler.js';

/**
 * The live-test kit's dry run (docs/NOTIFICATIONS_LIVE_TEST.md): the env
 * file `pnpm notifications:live env` writes is read back the way
 * `wrangler dev --env-file` reads it, becomes the Worker's env, and the
 * driver runs every live step against the real Worker handler in process.
 * The wrangler dev scheduled route runs the Worker's `scheduled` handler,
 * and FCM answers through a stubbed `fetch`. Nothing leaves the process and
 * no real credential is used.
 *
 * Local development sessions (`MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS`)
 * are D1's: until that lands, a stand-in `GAME_SERVICES_NOTIFICATIONS_AUTH`
 * binding accepts the same `Bearer mpgd-dev.<player>.<session>.<installation>`
 * token. The Worker uses a bound session binding before the flag, so this run
 * stays the same after D1.
 */

/** The checkout: the worker's test script runs from the repository root. */
function kitRoot(): string {
  const marker = join(
    'packages',
    'cli',
    'templates',
    'notifications-overlay',
    'common',
    'notifications',
  );
  for (const root of [process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT, process.cwd()]) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, marker))) {
      return root;
    }
  }
  throw new Error('Run this from the repository root.');
}

/**
 * What wrangler 4's `--env-file` makes of the file: dotenv's line rule
 * (quotes stripped, no unescaping inside ' or `), then dotenv-expand
 * (`$NAME` and `${NAME}` expanded, `\$` turned into `$`).
 */
function readEnvFileAsWrangler(text: string): Record<string, string> {
  const line = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gmu;
  const parsed: Record<string, string> = {};
  for (const match of text.matchAll(line)) {
    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gmu, '$2');
    if (quote === '"') {
      value = value.replaceAll('\\n', '\n').replaceAll('\\r', '\r');
    }
    parsed[key] = value;
  }
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const result = value.replace(
      /(?<!\\)\$\{([^{}]+)\}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      (_whole, braced: string | undefined, bare: string | undefined) => expanded[braced ?? bare ?? ''] ?? '',
    );
    expanded[key] = result.replace(/\\\$/gu, '$');
  }
  return expanded;
}

const root = kitRoot();
const scratch = mkdtempSync(join(tmpdir(), 'mpgd-notifications-live-'));
const realFetch = globalThis.fetch;
try {
  // A service-account key generated for this run: no real Firebase credential.
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const label = ['PRIVATE', 'KEY'].join(' ');
  const privateKey = `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END ${label}-----\n`;
  const keyFile = join(scratch, 'service-account.json');
  writeFileSync(
    keyFile,
    JSON.stringify(
      {
        type: 'service_account',
        project_id: 'mpgd-live-dry-run',
        private_key_id: 'dry-run-key',
        private_key: privateKey,
        client_email: 'sender@mpgd-live-dry-run.iam.gserviceaccount.com',
      },
      null,
      2,
    ),
  );

  // The starter's catalog and deployment, as a generated game ships them,
  // with the sender filled in. Quiet hours and the daily cap are dropped so
  // the run does not depend on the time of day, and the reminder copy keeps
  // a quote and dollar signs the env file must carry through literally.
  const overlay = join(
    root,
    'packages',
    'cli',
    'templates',
    'notifications-overlay',
    'common',
    'notifications',
  );
  const title = 'Live Test';
  const catalog = JSON.parse(
    readFileSync(join(overlay, 'topics.json'), 'utf8').replaceAll('__GAME_TITLE__', title),
  ) as { topics: { id: string; quietHours?: unknown; frequency?: unknown; copy: Record<string, { body: string }> }[] };
  const reminderBody = "It's ready: $HOME and ${HOME} stay literal.";
  for (const topic of catalog.topics) {
    delete topic.quietHours;
    delete topic.frequency;
    if (topic.id === 'daily-ready') {
      for (const copy of Object.values(topic.copy)) {
        copy.body = reminderBody;
      }
    }
  }
  const catalogFile = join(scratch, 'topics.json');
  writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  const deploymentFile = join(scratch, 'deployment.json');
  writeFileSync(
    deploymentFile,
    JSON.stringify({
      advertisingRules: 'kr',
      advertisingSender: { name: title, contact: '080-000-0000' },
      timeZone: 'Asia/Seoul',
    }),
  );

  // The env file: outside the repository, mode 0600, never inside the checkout.
  const envFile = join(scratch, 'live.env');
  const written = writeLiveWorkerEnvFile({
    catalogPath: catalogFile,
    deploymentPath: deploymentFile,
    serviceAccountPath: keyFile,
    outPath: envFile,
    repositoryRoot: root,
  });
  assert.equal(written.projectId, 'mpgd-live-dry-run');
  assert.deepEqual(written.variables, [
    'MPGD_STORE',
    'MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS',
    'MPGD_NOTIFICATIONS_CATALOG',
    'MPGD_NOTIFICATIONS_DEPLOYMENT',
    'FCM_SERVICE_ACCOUNT',
  ]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  }
  assert.throws(
    () =>
      writeLiveWorkerEnvFile({
        catalogPath: catalogFile,
        deploymentPath: deploymentFile,
        serviceAccountPath: keyFile,
        outPath: envFile,
        repositoryRoot: root,
      }),
    /EEXIST/u,
    'an existing env file is not overwritten without --force',
  );
  assert.throws(
    () =>
      writeLiveWorkerEnvFile({
        catalogPath: catalogFile,
        deploymentPath: deploymentFile,
        serviceAccountPath: keyFile,
        outPath: join(root, 'apps', 'game-services-worker', '.live.env'),
        repositoryRoot: root,
      }),
    /inside the repository/u,
  );
  const vars = readEnvFileAsWrangler(readFileSync(envFile, 'utf8'));
  assert.deepEqual(
    JSON.parse(vars.FCM_SERVICE_ACCOUNT ?? ''),
    JSON.parse(readFileSync(keyFile, 'utf8')),
  );
  assert.deepEqual(JSON.parse(vars.MPGD_NOTIFICATIONS_CATALOG ?? ''), catalog);

  // FCM stands in through the global fetch, which only the Worker's FCM provider uses.
  const sends: { token: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'dry-run-access-token', expires_in: 3600 });
    }
    if (url === 'https://fcm.googleapis.com/v1/projects/mpgd-live-dry-run/messages:send') {
      const { message } = JSON.parse(String(init?.body)) as {
        readonly message: { readonly token: string; readonly notification: { readonly body: string } };
      };
      sends.push({ token: message.token, body: message.notification.body });
      return Response.json({ name: `projects/mpgd-live-dry-run/messages/${sends.length}` });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  /** D1's development session, until it lands: `Bearer mpgd-dev.<player>.<session>.<installation>`. */
  const developmentSessions = {
    async authenticateNotificationSession({ authorization }: { readonly authorization: string }) {
      const match = /^Bearer mpgd-dev\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})$/u.exec(
        authorization,
      );
      return match === null
        ? null
        : { playerId: match[1] ?? '', sessionId: match[2] ?? '', installationId: match[3] ?? '' };
    },
  };
  assert.equal(vars.MPGD_STORE, 'memory');
  assert.equal(vars.MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS, 'true');
  const env: GameServicesWorkerEnv = {
    MPGD_STORE: 'memory',
    MPGD_NOTIFICATIONS_CATALOG: vars.MPGD_NOTIFICATIONS_CATALOG,
    MPGD_NOTIFICATIONS_DEPLOYMENT: vars.MPGD_NOTIFICATIONS_DEPLOYMENT,
    FCM_SERVICE_ACCOUNT: vars.FCM_SERVICE_ACCOUNT,
    GAME_SERVICES_NOTIFICATIONS_AUTH: developmentSessions,
  };

  /** The local Worker as `wrangler dev` serves it, including its scheduled route. */
  const workerFetch = (workerEnv: GameServicesWorkerEnv): LiveDriverDependencies['fetch'] => {
    const handler = createWorkerFetchHandler(workerEnv);
    return async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === wranglerDevScheduledRoute) {
        await runScheduledNotifications(workerEnv, {
          cron: parsed.searchParams.get('cron') ?? '* * * * *',
        });
        return new Response('ok');
      }
      return await handler(new Request(url, init));
    };
  };
  const lines: string[] = [];
  // The Worker reads the real clock, so the test reminder is due at once
  // (--fire-in 0) and the driver never waits.
  const dependencies = (workerEnv: GameServicesWorkerEnv): LiveDriverDependencies => ({
    fetch: workerFetch(workerEnv),
    log: (line) => lines.push(line),
    now: () => Date.now(),
    sleep: async (ms) => {
      throw new Error(`The dry run does not wait (asked for ${ms} ms).`);
    },
    deliver: async (input) => await deliverWorkerNotification(workerEnv, input),
  });
  const deviceToken = 'dry-run-device-token-0123456789';
  const authorization = developmentSessionAuthorization({
    playerId: 'p-live',
    sessionId: 'live-driver',
    installationId: 'live-driver',
  });
  const options: LiveDriverOptions = {
    worker: assertLiveWorkerOrigin('http://127.0.0.1:8787'),
    authorization,
    sessionLabel: 'development session for player p-live',
    playerId: 'p-live',
    target: 'android',
    topic: 'daily-ready',
    runId: 'dry-run',
    fireInSeconds: 0,
    fcmToken: deviceToken,
    triggerScheduler: true,
    advertisingTextVersion: '1',
    deliver: { topic: 'friend-challenge', templateData: { friend: 'Dry Run' } },
  };

  const report = await runNotificationsLiveDriver(options, dependencies(env));
  assert.ok(report.ok, lines.join('\n'));
  assert.deepEqual(
    report.steps.map((step) => `${step.result} ${step.name}`),
    [
      'pass providers',
      'pass session-required',
      'pass session',
      'pass register-endpoint',
      'pass report-permission',
      'pass topic-preference',
      'pass reminder-cancel',
      'pass reminder',
      'pass scheduler',
      'pass deliver',
      'pass notices',
      'pass advertising-notice',
      'pass unregister-endpoint',
    ],
  );
  // The reminder went out through the scheduler with the env file's copy intact, then the send.
  assert.deepEqual(sends, [
    { token: deviceToken, body: reminderBody },
    { token: deviceToken, body: 'Dry Run 님이 도전장을 보냈어요.' },
  ]);
  // The log carries neither the session token, the device token, nor the key.
  const log = lines.join('\n');
  for (const secret of [
    authorization,
    authorization.slice('Bearer '.length),
    deviceToken,
    privateKey,
    'BEGIN PRIVATE',
  ]) {
    assert.ok(!log.includes(secret), `the log shows ${secret.slice(0, 12)}…`);
  }

  // A device that registered nothing: the first reminder is refused with the reason, and the run stops there.
  lines.length = 0;
  const { fcmToken: _token, ...withoutDevice } = options;
  const unregistered = await runNotificationsLiveDriver(
    {
      ...withoutDevice,
      runId: 'no-device',
      playerId: 'p-nodevice',
      authorization: developmentSessionAuthorization({
        playerId: 'p-nodevice',
        sessionId: 'live-driver',
        installationId: 'live-driver',
      }),
    },
    dependencies(env),
  );
  assert.equal(unregistered.ok, false);
  assert.deepEqual(unregistered.steps.map((step) => `${step.result} ${step.name}`).slice(2), [
    'pass session',
    'warn device-permission',
    'pass topic-preference',
    'fail reminder-cancel',
  ]);
  assert.match(lines.join('\n'), /permission-required/u);

  // A Worker without session routes: the run stops at the second step and says how to turn them on.
  lines.length = 0;
  const { GAME_SERVICES_NOTIFICATIONS_AUTH: _auth, ...withoutSessions } = env;
  const closed = await runNotificationsLiveDriver(
    { ...options, runId: 'closed' },
    dependencies(withoutSessions),
  );
  assert.equal(closed.ok, false);
  assert.deepEqual(
    closed.steps.map((step) => `${step.result} ${step.name}`),
    ['pass providers', 'fail session-required'],
  );
  assert.match(lines.join('\n'), /MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS/u);

  console.info('notifications live driver dry run against the in-process Worker passed');
} finally {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
}

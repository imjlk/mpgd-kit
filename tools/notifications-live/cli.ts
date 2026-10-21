import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assertLiveWorkerOrigin,
  developmentSessionAuthorization,
  LiveDriverUsageError,
  runNotificationsLiveDriver,
  type LiveDriverOptions,
} from './driver';
import { isCliEntrypoint } from '../io';
import { checkLiveEmulator } from './emulator';
import { assertLiveReadablePath, writeLiveWorkerEnvFile } from './worker-env';

/**
 * `pnpm notifications:live <command>`: the notifications v2 live-test kit
 * (docs/NOTIFICATIONS_LIVE_TEST.md).
 *
 * - `env`: writes the env file for `wrangler dev --env-file`, outside the
 *   repository, from the game's catalog and the Firebase key file.
 * - `emulator`: checks the Android emulator, and with `--reverse` forwards
 *   the Worker port to it.
 * - `run`: the server half against a local Worker (or a `--staging` one).
 * - `dry-run`: the same driver against the in-process Worker and a fake FCM.
 *
 * It never prints a secret and never reads ~/.config/mise.
 */

const usage = `Usage: pnpm notifications:live <command> [options]

  env       --service-account <key.json> --out <file outside the repo>
            (--game <dir> | --catalog <topics.json> --deployment <deployment.json>)
            [--project-id <id>] [--force]
  emulator  --app-id <android.package> [--serial <serial>] [--port 8787] [--reverse]
  run       [--worker http://127.0.0.1:8787] [--staging <host>]
            (--player <id> [--session live-driver] [--installation live-driver] | --auth-env <VAR>)
            [--target android] [--topic daily-ready] [--fire-in 5] [--fcm-token-file <file>]
            [--advertising <text-version>] [--no-scheduler]
  dry-run   runs the driver against the in-process Worker with a fake FCM endpoint
`;

/**
 * The Worker as `vite build` emits it, relative to apps/game-services-worker.
 * `wrangler dev` on the sources does not run the typia transform the kit's
 * packages need, so the live run serves the built Worker.
 */
const liveWorkerBuildConfig = 'dist/mpgd_game_services/wrangler.json';

function resolveKitRoot(): string {
  const marker = join('apps', 'game-services-worker', 'wrangler.toml');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, marker))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

function androidAdb(): string {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
  const bundled = join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  return existsSync(bundled) ? bundled : 'adb';
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new LiveDriverUsageError(`${flag} is required.\n\n${usage}`);
  }
  return value;
}

function commandEnv(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      'service-account': { type: 'string' },
      out: { type: 'string' },
      game: { type: 'string' },
      catalog: { type: 'string' },
      deployment: { type: 'string' },
      'project-id': { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const game = values.game;
  const result = writeLiveWorkerEnvFile({
    catalogPath: values.catalog ?? (game === undefined ? required(undefined, '--game or --catalog') : join(game, 'notifications', 'topics.json')),
    deploymentPath: values.deployment
      ?? (game === undefined ? required(undefined, '--game or --deployment') : join(game, 'notifications', 'deployment.json')),
    serviceAccountPath: required(values['service-account'], '--service-account'),
    outPath: required(values.out, '--out'),
    repositoryRoot: resolveKitRoot(),
    ...(values['project-id'] === undefined ? {} : { projectId: values['project-id'] }),
    overwrite: values.force,
  });
  console.info(`Wrote ${result.outPath} (mode 0600): ${result.variables.join(', ')}.`);
  console.info(
    `Firebase project ${result.projectId}; ${result.topics} topics; advertising rules ${result.advertisingRules}.`,
  );
  console.info(
    'Build the Worker and start it with:\n'
      + '  pnpm build:packages && pnpm --dir apps/game-services-worker build\n'
      + `  pnpm --dir apps/game-services-worker exec wrangler dev -c ${liveWorkerBuildConfig} --env-file ${result.outPath} `
      + '--ip 127.0.0.1 --port 8787',
  );
  console.info('Delete the file after the test; it holds the service-account key.');
}

function commandEmulator(args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      'app-id': { type: 'string' },
      serial: { type: 'string' },
      port: { type: 'string', default: '8787' },
      reverse: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const adb = androidAdb();
  const report = checkLiveEmulator(
    {
      appId: required(values['app-id'], '--app-id'),
      ...(values.serial === undefined ? {} : { serial: values.serial }),
      port: Number(values.port),
      reverse: values.reverse,
    },
    (adbArgs) => {
      const result = spawnSync(adb, [...adbArgs], { encoding: 'utf8', timeout: 30_000 });
      return { status: result.status ?? 1, stdout: result.stdout ?? '' };
    },
  );
  for (const line of report.lines) {
    console.info(`${line.result.toUpperCase().padEnd(4)} ${line.check}: ${line.detail}`);
  }
  if (report.serial !== undefined) {
    console.info(
      `Watch the app with: ${adb} -s ${report.serial} logcat -v time Capacitor:V Capacitor/Console:V FirebaseMessaging:V '*:S'`,
    );
  }
  return report.ok ? 0 : 1;
}

async function commandRun(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      worker: { type: 'string', default: 'http://127.0.0.1:8787' },
      staging: { type: 'string' },
      player: { type: 'string' },
      session: { type: 'string', default: 'live-driver' },
      installation: { type: 'string', default: 'live-driver' },
      'auth-env': { type: 'string' },
      target: { type: 'string', default: 'android' },
      topic: { type: 'string', default: 'daily-ready' },
      'fire-in': { type: 'string', default: '5' },
      'fcm-token-file': { type: 'string' },
      advertising: { type: 'string' },
      'no-scheduler': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const worker = assertLiveWorkerOrigin(values.worker, values.staging);
  if (values.player !== undefined && values['auth-env'] !== undefined) {
    throw new LiveDriverUsageError(
      'Pass --player (a development session) or --auth-env, not both.',
    );
  }
  let authorization: string;
  let sessionLabel: string;
  if (values['auth-env'] !== undefined) {
    const name = values['auth-env'];
    const value = process.env[name];
    if (value === undefined || value.trim().length === 0) {
      throw new LiveDriverUsageError(
        `$${name} is empty; it holds the session's Authorization header value.`,
      );
    }
    authorization = value.trim();
    sessionLabel = `the session in $${name}`;
  } else {
    const playerId = required(values.player, '--player or --auth-env');
    authorization = developmentSessionAuthorization({
      playerId,
      sessionId: values.session,
      installationId: values.installation,
    });
    sessionLabel = `development session for player ${playerId}`;
  }
  const fireIn = Number(values['fire-in']);
  if (!Number.isInteger(fireIn) || fireIn < 0 || fireIn > 3600) {
    throw new LiveDriverUsageError('--fire-in is whole seconds from 0 to 3600.');
  }
  let fcmToken: string | undefined;
  if (values['fcm-token-file'] !== undefined) {
    fcmToken = readFileSync(assertLiveReadablePath(values['fcm-token-file']), 'utf8').trim();
    if (fcmToken.length === 0) {
      throw new LiveDriverUsageError('--fcm-token-file is empty.');
    }
  }
  const options: LiveDriverOptions = {
    worker,
    authorization,
    sessionLabel,
    ...(values.player === undefined ? {} : { playerId: values.player }),
    target: values.target,
    topic: values.topic,
    runId: new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14),
    fireInSeconds: fireIn,
    ...(fcmToken === undefined ? {} : { fcmToken }),
    triggerScheduler: worker.local && !values['no-scheduler'],
    ...(values.advertising === undefined ? {} : { advertisingTextVersion: values.advertising }),
  };
  const report = await runNotificationsLiveDriver(options, {
    fetch: async (url, init) => await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    log: (line) => console.info(line),
    now: () => Date.now(),
    sleep: async (ms) => await new Promise<void>((done) => setTimeout(done, ms)),
  });
  return report.ok ? 0 : 1;
}

function commandDryRun(): number {
  const root = resolveKitRoot();
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'tools', 'run-ttsx.mjs'),
      '--project',
      'apps/game-services-worker/tsconfig.json',
      'apps/game-services-worker/src/notificationsLiveDriver.test.ts',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  return result.status ?? 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'env':
      commandEnv(rest);
      return 0;
    case 'emulator':
      return commandEmulator(rest);
    case 'run':
      return await commandRun(rest);
    case 'dry-run':
      return commandDryRun();
    default:
      console.error(usage);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Usage, argument, and file errors: the message says what to fix. None
    // carries a secret (the key file's parse errors are replaced above).
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

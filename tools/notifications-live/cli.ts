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

function missing(flag: string): never {
  throw new LiveDriverUsageError(`${flag} is required.`);
}

/** A whole number from an option, or a usage error naming the option. */
function wholeNumber(text: string, flag: string): number {
  if (!/^\d{1,6}$/u.test(text)) {
    throw new LiveDriverUsageError(`${flag} ${JSON.stringify(text)} is not a whole number.`);
  }
  return Number(text);
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
    catalogPath: values.catalog
      ?? (game === undefined ? missing('--game or --catalog') : join(game, 'notifications', 'topics.json')),
    deploymentPath: values.deployment
      ?? (game === undefined ? missing('--game or --deployment') : join(game, 'notifications', 'deployment.json')),
    serviceAccountPath: values['service-account'] ?? missing('--service-account'),
    outPath: values.out ?? missing('--out'),
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
      appId: values['app-id'] ?? missing('--app-id'),
      ...(values.serial === undefined ? {} : { serial: values.serial }),
      port: wholeNumber(values.port, '--port'),
      reverse: values.reverse,
    },
    (adbArgs) => {
      const result = spawnSync(adb, [...adbArgs], { encoding: 'utf8', timeout: 30_000 });
      return {
        status: result.error === undefined ? (result.status ?? 1) : 1,
        stdout: result.stdout ?? '',
      };
    },
  );
  for (const line of report.lines) {
    console.info(`${line.result.toUpperCase().padEnd(4)} ${line.check}: ${line.detail}`);
  }
  if (report.serial !== undefined) {
    console.info(
      `Watch the app with: ${JSON.stringify(adb)} -s ${report.serial} logcat -v time Capacitor:V Capacitor/Console:V FirebaseMessaging:V '*:S'`,
    );
  }
  return report.ok ? 0 : 1;
}

const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The driver's options from `run`'s arguments: the Worker URL guard, the
 * session (a development session from --player, or a real one from the
 * variable --auth-env names), and the numbers checked. `readTokenFile`
 * reads --fcm-token-file. Never echoes a secret in an error.
 */
export function parseRunArguments(
  args: readonly string[],
  input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly readTokenFile: (path: string) => string;
    readonly now: () => Date;
  },
): LiveDriverOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      worker: { type: 'string' },
      staging: { type: 'string' },
      player: { type: 'string' },
      session: { type: 'string' },
      installation: { type: 'string' },
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
  if (values.staging !== undefined && values.worker === undefined) {
    throw new LiveDriverUsageError(
      '--staging names the host of --worker; pass --worker https://<host> too.',
    );
  }
  const worker = assertLiveWorkerOrigin(values.worker ?? 'http://127.0.0.1:8787', values.staging);
  if (values.staging !== undefined && worker.local) {
    throw new LiveDriverUsageError(
      '--staging is for a deployed Worker; a local --worker needs no --staging.',
    );
  }
  let authorization: string;
  let sessionLabel: string;
  const name = values['auth-env'];
  if (name !== undefined) {
    if (values.player !== undefined || values.session !== undefined || values.installation !== undefined) {
      throw new LiveDriverUsageError(
        '--auth-env is a real session; --player, --session, and --installation are for a development one.',
      );
    }
    if (!environmentVariableName.test(name)) {
      // Never echoed: a value pasted here instead of a name would be the secret itself.
      throw new LiveDriverUsageError(
        '--auth-env takes the name of an environment variable that holds the Authorization value.',
      );
    }
    const value = input.env[name]?.trim();
    if (value === undefined || value.length === 0) {
      throw new LiveDriverUsageError(
        `$${name} is empty; it holds the session's Authorization header value.`,
      );
    }
    authorization = value;
    sessionLabel = `the session in $${name}`;
  } else {
    const playerId = values.player ?? missing('--player or --auth-env');
    authorization = developmentSessionAuthorization({
      playerId,
      sessionId: values.session ?? 'live-driver',
      installationId: values.installation ?? 'live-driver',
    });
    sessionLabel = `development session for player ${playerId}`;
  }
  const fireIn = wholeNumber(values['fire-in'], '--fire-in');
  if (fireIn > 3600) {
    throw new LiveDriverUsageError('--fire-in is at most 3600 seconds.');
  }
  let fcmToken: string | undefined;
  if (values['fcm-token-file'] !== undefined) {
    fcmToken = input.readTokenFile(assertLiveReadablePath(values['fcm-token-file'])).trim();
    if (fcmToken.length === 0) {
      throw new LiveDriverUsageError('--fcm-token-file is empty.');
    }
  }
  return {
    worker,
    authorization,
    sessionLabel,
    ...(values.player === undefined ? {} : { playerId: values.player }),
    target: values.target,
    topic: values.topic,
    runId: input.now().toISOString().replace(/[^0-9]/gu, '').slice(0, 14),
    fireInSeconds: fireIn,
    ...(fcmToken === undefined ? {} : { fcmToken }),
    triggerScheduler: worker.local && !values['no-scheduler'],
    ...(values.advertising === undefined ? {} : { advertisingTextVersion: values.advertising }),
  };
}

async function commandRun(args: readonly string[]): Promise<number> {
  const options = parseRunArguments(args, {
    env: process.env,
    readTokenFile: (path) => readFileSync(path, 'utf8'),
    now: () => new Date(),
  });
  const report = await runNotificationsLiveDriver(options, {
    // A redirect is refused: the URL guard checked this origin, not another.
    fetch: async (url, init) =>
      await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }),
    log: (line) => console.info(line),
    now: () => Date.now(),
    sleep: async (ms) => await new Promise<void>((done) => setTimeout(done, ms)),
  });
  return report.ok ? 0 : 1;
}

function commandDryRun(args: readonly string[]): number {
  if (args.length > 0) {
    throw new LiveDriverUsageError(`dry-run takes no arguments (got ${args.join(' ')}).`);
  }
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
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function main(argv: readonly string[]): Promise<number> {
  // `pnpm notifications:live -- run ...` passes the separator through.
  const [command, ...rest] = argv[0] === '--' ? argv.slice(1) : argv;
  if (command === undefined || command === 'help' || rest.includes('--help') || ['--help', '-h'].includes(command)) {
    console.info(usage);
    return 0;
  }
  switch (command) {
    case 'env':
      commandEnv(rest);
      return 0;
    case 'emulator':
      return commandEmulator(rest);
    case 'run':
      return await commandRun(rest);
    case 'dry-run':
      return commandDryRun(rest);
    default:
      throw new LiveDriverUsageError(`Unknown command ${JSON.stringify(command)}.`);
  }
}

/** Errors the user fixes by changing the command: printed with the usage, exit 2. */
function isUsageError(error: unknown): boolean {
  if (error instanceof LiveDriverUsageError) {
    return true;
  }
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // No message here carries a secret: the kit's own errors never quote
    // one, and the key file's parse errors are replaced before they get here.
    if (isUsageError(error)) {
      console.error(`${(error as Error).message}\n\n${usage}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      if (process.env.MPGD_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
        console.error(error.stack);
      }
      process.exitCode = 1;
    }
  }
}

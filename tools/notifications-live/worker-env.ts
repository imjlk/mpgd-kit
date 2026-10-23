import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  createFcmProviderRegistration,
  parseFcmServiceAccount,
} from '@mpgd/game-services/notifications';

import {
  readNotificationDeploymentFile,
  referenceNotificationTargetRegistry,
  validateNotificationTopicsFile,
} from '../validate-notification-topics';
import { LiveDriverUsageError } from './driver';

/**
 * Writes the env file a local `wrangler dev --env-file <file>` run of the
 * game-services Worker reads for the live test: the memory store, the local
 * development session flag, the game's topic catalog and deployment
 * settings, and the Firebase service-account key. The key is read from the
 * maintainer's own file and written only to a file outside the repository,
 * created with mode 0600; nothing here prints it.
 */

export interface LiveWorkerEnvInput {
  /** The game's notification topic catalog (`notifications/topics.json`). */
  readonly catalogPath: string;
  /** The game's deployment settings (`notifications/deployment.json`). */
  readonly deploymentPath: string;
  /** The Firebase service-account key file. */
  readonly serviceAccountPath: string;
  /** Where the env file goes: outside `repositoryRoot`, and not an existing file unless `overwrite`. */
  readonly outPath: string;
  /** The checkout the file must stay out of. */
  readonly repositoryRoot: string;
  /** Overrides the key's `project_id` (`FCM_PROJECT_ID`). */
  readonly projectId?: string;
  readonly overwrite?: boolean;
  /** `dev-vars` (the default) for `.dev.vars`, `env-file` for `wrangler dev --env-file`. */
  readonly format?: LiveEnvFileFormat;
}

export interface LiveWorkerEnvResult {
  readonly outPath: string;
  readonly projectId: string;
  readonly topics: number;
  /** The deployment's `advertisingRules`, or `none` when it sets none. */
  readonly advertisingRules: string;
  /** The variable names written, never their values. */
  readonly variables: readonly string[];
}

/**
 * Which file wrangler 4 (4.107 bundles dotenv 16 and dotenv-expand 12)
 * reads: a `.dev.vars` file, which `pnpm --dir apps/game-services-worker
 * dev` (the Cloudflare Vite plugin) and `wrangler dev` read with dotenv
 * alone, or an `--env-file` file, which `wrangler dev --env-file` also
 * expands (`$NAME`, `${NAME}`; `\$` turns back into `$`).
 */
export type LiveEnvFileFormat = 'dev-vars' | 'env-file';

/**
 * The dotenv value wrangler reads back as `value`: single-quoted, so dotenv
 * leaves `\n` escapes alone, with `$` kept for `dev-vars` (the default)
 * and escaped for an `env-file`. A `'` cannot be escaped inside single
 * quotes: JSON text (`json: true`) carries it as `\u0027`, which JSON reads
 * back as `'`; any other value with one is refused.
 */
export function formatLiveEnvValue(
  value: string,
  options: { readonly json?: boolean; readonly format?: LiveEnvFileFormat } = {},
): string {
  if (/[\r\n]/u.test(value)) {
    throw new LiveDriverUsageError('An env file value must be one line.');
  }
  if (value.endsWith('\\')) {
    throw new LiveDriverUsageError('An env file value must not end with a backslash.');
  }
  let escaped = options.format === 'dev-vars' ? value : value.replaceAll('$', '\\$');
  if (escaped.includes("'")) {
    if (options.json !== true) {
      throw new LiveDriverUsageError("An env file value must not hold a '.");
    }
    escaped = escaped.replaceAll("'", '\\u0027');
  }
  return `'${escaped}'`;
}

/** Whether `child` is `parent` or inside it (both absolute). */
function isWithin(parent: string, child: string): boolean {
  const inside = relative(parent, child);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** Folds a path the way macOS and Windows compare names: Unicode NFC, and case there. */
function folded(path: string): string {
  const normal = path.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normal.toLowerCase()
    : normal;
}

/** A path through its symbolic links when it exists, else as given, folded. */
function canonical(path: string): string {
  return folded(existsSync(path) ? realpathSync.native(path) : path);
}

/**
 * Refuses a path the live kit must never read: the maintainer's mise
 * configuration and secrets (`~/.config/mise`, `$XDG_CONFIG_HOME/mise`,
 * `$MISE_CONFIG_DIR`), which hold release credentials, not test ones. Both
 * the path and each directory are compared as given and through their
 * symbolic links.
 */
export function assertLiveReadablePath(
  path: string,
  home = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const absolute = resolve(path);
  const forbidden = [
    join(home, '.config', 'mise'),
    ...(env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === '' ? [] : [join(env.XDG_CONFIG_HOME, 'mise')]),
    ...(env.MISE_CONFIG_DIR === undefined || env.MISE_CONFIG_DIR === '' ? [] : [resolve(env.MISE_CONFIG_DIR)]),
  ];
  const candidates = [folded(absolute), canonical(absolute)];
  const hit = forbidden.find((directory) =>
    [folded(directory), canonical(directory)].some((root) =>
      candidates.some((candidate) => isWithin(root, candidate)),
    ),
  );
  if (hit !== undefined) {
    throw new LiveDriverUsageError(`The live kit does not read ${hit}; pass the test file itself.`);
  }
  return absolute;
}

/** A JSON file on one line, as the game ships it; a file that went away is a usage error. */
function oneLineJson(path: string, flag: string): string {
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw new LiveDriverUsageError(
      `${flag} ${path} could not be read as JSON (${typeof code === 'string' ? code : 'not JSON'}).`,
    );
  }
}

/** The nearest directory at or above `directory` that holds a `.git`, if any. */
function enclosingRepository(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}

function assertOutsideRepository(outPath: string, repositoryRoot: string): string {
  const absolute = resolve(outPath);
  // The directory must exist; it is compared through its symbolic links.
  const directory = dirname(absolute);
  if (!existsSync(directory)) {
    throw new LiveDriverUsageError(`--out directory ${directory} does not exist.`);
  }
  const realDirectory = realpathSync.native(directory);
  const repository = isWithin(canonical(repositoryRoot), canonical(realDirectory))
    ? repositoryRoot
    : enclosingRepository(realDirectory);
  if (repository !== undefined) {
    throw new LiveDriverUsageError(
      `--out ${absolute} is inside the git checkout ${repository} (a dotfiles repository counts too); `
        + 'the env file holds the service-account key. Write it outside every checkout.',
    );
  }
  const existing = lstatSync(absolute, { throwIfNoEntry: false });
  // A link would write the key wherever it points.
  if (existing?.isSymbolicLink() === true) {
    throw new LiveDriverUsageError(`--out ${absolute} is a symbolic link; name the file itself.`);
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new LiveDriverUsageError(`--out ${absolute} exists and is not a file.`);
  }
  return join(realDirectory, basename(absolute));
}

export function writeLiveWorkerEnvFile(input: LiveWorkerEnvInput): LiveWorkerEnvResult {
  const outPath = assertOutsideRepository(input.outPath, input.repositoryRoot);
  if (input.overwrite !== true && existsSync(outPath)) {
    throw new LiveDriverUsageError(`--out ${outPath} exists (EEXIST); pass --force to replace it.`);
  }
  const catalogPath = assertLiveReadablePath(input.catalogPath);
  const deploymentPath = assertLiveReadablePath(input.deploymentPath);
  const serviceAccountPath = assertLiveReadablePath(input.serviceAccountPath);
  const deployment = readNotificationDeploymentFile(deploymentPath);
  const catalog = validateNotificationTopicsFile(
    catalogPath,
    referenceNotificationTargetRegistry(),
    deployment,
  );
  let raw: string;
  try {
    raw = readFileSync(serviceAccountPath, 'utf8');
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw new LiveDriverUsageError(
      `--service-account ${serviceAccountPath} could not be read (${typeof code === 'string' ? code : 'error'}).`,
    );
  }
  let account: ReturnType<typeof parseFcmServiceAccount>;
  let accountText: string;
  try {
    account = parseFcmServiceAccount(raw);
    // One line: the key's private_key keeps its \n escapes inside the JSON string.
    accountText = JSON.stringify(JSON.parse(raw));
  } catch (error) {
    // parseFcmServiceAccount names a missing field, never a value; a JSON
    // parse error may quote the file, so it is not repeated.
    throw new LiveDriverUsageError(
      `--service-account is not a Firebase service-account key: ${
        error instanceof TypeError && error.message.startsWith('The FCM') ? error.message : 'not JSON'
      }`,
    );
  }
  try {
    // The provider the Worker builds checks the project id (the key's, or
    // --project-id) by the kit's own rule; building it sends nothing.
    createFcmProviderRegistration({
      serviceAccount: account,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  } catch {
    throw new LiveDriverUsageError(
      input.projectId === undefined
        ? "The key's project_id is not a Firebase project id; pass the Firebase project's id with --project-id."
        : '--project-id is not a Firebase project id.',
    );
  }
  const format = input.format ?? 'dev-vars';
  /** Name, value, and whether the value is JSON text (which may carry a quote as \u0027). */
  const variables: readonly (readonly [string, string, boolean])[] = [
    ['MPGD_STORE', 'memory', false],
    ['MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS', 'true', false],
    // The files as the game ships them (validated above), on one line.
    ['MPGD_NOTIFICATIONS_CATALOG', oneLineJson(catalogPath, '--catalog'), true],
    ['MPGD_NOTIFICATIONS_DEPLOYMENT', oneLineJson(deploymentPath, '--deployment'), true],
    ['FCM_SERVICE_ACCOUNT', accountText, true],
    ...(input.projectId === undefined ? [] : [['FCM_PROJECT_ID', input.projectId, false] as const]),
  ];
  const text = [
    `# Written by \`pnpm notifications:live env\` (${format}) for one local game-services Worker run.`,
    '# It holds a Firebase service-account key: keep it out of every repository and delete it after the test.',
    ...variables.map(([name, value, json]) => `${name}=${formatLiveEnvValue(value, { json, format })}`),
    '',
  ].join('\n');
  // Written to a new 0600 file beside it, then renamed over it: the key is
  // never under an older, wider mode, and a failed write keeps the old file.
  const staged = join(dirname(outPath), `.${basename(outPath)}.${process.pid}.tmp`);
  try {
    writeFileSync(staged, text, { mode: 0o600, flag: 'wx' });
    renameSync(staged, outPath);
  } catch (error) {
    rmSync(staged, { force: true });
    const code = (error as { readonly code?: unknown }).code;
    throw new LiveDriverUsageError(
      `--out ${outPath} could not be written (${typeof code === 'string' ? code : 'error'}).`,
    );
  }
  return {
    outPath,
    projectId: input.projectId ?? account.projectId,
    topics: catalog.topics.length,
    advertisingRules: deployment.advertisingRules ?? 'none',
    variables: variables.map(([name]) => name),
  };
}

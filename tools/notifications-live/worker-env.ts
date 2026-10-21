import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseFcmServiceAccount } from '@mpgd/game-services/notifications';

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
 * The dotenv value wrangler 4 reads back as `value` (wrangler 4.107 bundles
 * dotenv 16 and dotenv-expand 12): single-quoted, so dotenv leaves `\n`
 * escapes alone, with `$` escaped, since dotenv-expand expands `$NAME` and
 * `${NAME}` in every value and turns `\$` back into `$`. A `'` cannot be
 * escaped inside single quotes: JSON text (`json: true`) carries it as
 * `\u0027`, which JSON reads back as `'`; any other value with one is
 * refused.
 */
export function formatLiveEnvValue(value: string, options: { readonly json?: boolean } = {}): string {
  if (/[\r\n]/u.test(value)) {
    throw new LiveDriverUsageError('An env file value must be one line.');
  }
  if (value.endsWith('\\')) {
    throw new LiveDriverUsageError('An env file value must not end with a backslash.');
  }
  let escaped = value.replaceAll('$', '\\$');
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

/** A path through its symbolic links when it exists, else as given; the case-folded file systems compare folded. */
function canonical(path: string): string {
  const real = existsSync(path) ? realpathSync.native(path) : path;
  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Refuses a path the live kit must never read: the maintainer's mise
 * secrets (`~/.config/mise`), which hold release credentials, not test ones.
 * Both the path and the directory are compared through their symbolic links.
 */
export function assertLiveReadablePath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const forbidden = join(home, '.config', 'mise');
  const candidates = [absolute, canonical(absolute)];
  const roots = [forbidden, canonical(forbidden)];
  const folded = process.platform === 'darwin' || process.platform === 'win32';
  if (candidates.some((candidate) =>
    roots.some((root) =>
      isWithin(folded ? root.toLowerCase() : root, folded ? candidate.toLowerCase() : candidate),
    ),
  )) {
    throw new LiveDriverUsageError(
      `The live kit does not read ${forbidden}; pass the test file itself.`,
    );
  }
  return absolute;
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
      `--out ${absolute} is inside the repository ${repository}; the env file holds the service-account key. `
        + 'Write it outside every checkout, for example under ~/.mpgd/.',
    );
  }
  // A link would write the key wherever it points.
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new LiveDriverUsageError(`--out ${absolute} is a symbolic link; name the file itself.`);
  }
  return join(realDirectory, basename(absolute));
}

const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

export function writeLiveWorkerEnvFile(input: LiveWorkerEnvInput): LiveWorkerEnvResult {
  const outPath = assertOutsideRepository(input.outPath, input.repositoryRoot);
  if (input.projectId !== undefined && !projectIdPattern.test(input.projectId)) {
    throw new LiveDriverUsageError(
      '--project-id is not a Firebase project id (6 to 30 a-z, 0-9, -).',
    );
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
  const variables: readonly (readonly [string, string])[] = [
    ['MPGD_STORE', 'memory'],
    ['MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS', 'true'],
    // The files as the game ships them (validated above), on one line.
    ['MPGD_NOTIFICATIONS_CATALOG', JSON.stringify(JSON.parse(readFileSync(catalogPath, 'utf8')))],
    ['MPGD_NOTIFICATIONS_DEPLOYMENT', JSON.stringify(JSON.parse(readFileSync(deploymentPath, 'utf8')))],
    ['FCM_SERVICE_ACCOUNT', accountText],
    ...(input.projectId === undefined ? [] : [['FCM_PROJECT_ID', input.projectId] as const]),
  ];
  const text = [
    '# Written by `pnpm notifications:live env` for one local `wrangler dev --env-file` run.',
    '# It holds a Firebase service-account key: keep it out of every repository and delete it after the test.',
    ...variables.map(([name, value]) => `${name}=${formatLiveEnvValue(value, { json: true })}`),
    '',
  ].join('\n');
  if (input.overwrite === true && existsSync(outPath)) {
    // Created again rather than truncated, so the key is never under an older, wider mode.
    unlinkSync(outPath);
  }
  writeFileSync(outPath, text, { mode: 0o600, flag: 'wx' });
  return {
    outPath,
    projectId: input.projectId ?? account.projectId,
    topics: catalog.topics.length,
    advertisingRules: deployment.advertisingRules ?? 'none',
    variables: variables.map(([name]) => name),
  };
}

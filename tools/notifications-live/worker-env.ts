import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
 * The dotenv value wrangler 4 reads back as `value`: quoted with `'` (or
 * `` ` `` when the text has a `'`), with `$` escaped, since wrangler expands
 * `$NAME` and `${NAME}` in every value and turns `\$` back into `$`.
 */
export function formatLiveEnvValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new LiveDriverUsageError('An env file value must be one line.');
  }
  const escaped = value.replaceAll('$', '\\$');
  for (const quote of ["'", '`']) {
    if (!escaped.includes(quote)) {
      return `${quote}${escaped}${quote}`;
    }
  }
  throw new LiveDriverUsageError("A value holds both ' and `; the env file cannot quote it.");
}

/**
 * Refuses a path the live kit must never read: the maintainer's mise
 * secrets (`~/.config/mise`), which hold release credentials, not test ones.
 */
export function assertLiveReadablePath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
  for (const forbidden of [join(home, '.config', 'mise')]) {
    const inside = relative(forbidden, real);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      throw new LiveDriverUsageError(
        `The live kit does not read ${forbidden}; pass the test file itself.`,
      );
    }
  }
  return absolute;
}

function assertOutsideRepository(outPath: string, repositoryRoot: string): string {
  const absolute = resolve(outPath);
  // The directory must exist; resolve it through symbolic links.
  const directory = dirname(absolute);
  if (!existsSync(directory)) {
    throw new LiveDriverUsageError(`--out directory ${directory} does not exist.`);
  }
  const target = join(realpathSync(directory), absolute.slice(directory.length + 1));
  const inside = relative(realpathSync(repositoryRoot), target);
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    throw new LiveDriverUsageError(
      `--out ${absolute} is inside the repository; the env file holds the service-account key. `
        + 'Write it outside the checkout, for example under ~/.mpgd/.',
    );
  }
  return absolute;
}

export function writeLiveWorkerEnvFile(input: LiveWorkerEnvInput): LiveWorkerEnvResult {
  const outPath = assertOutsideRepository(input.outPath, input.repositoryRoot);
  const catalogPath = assertLiveReadablePath(input.catalogPath);
  const deploymentPath = assertLiveReadablePath(input.deploymentPath);
  const serviceAccountPath = assertLiveReadablePath(input.serviceAccountPath);
  const deployment = readNotificationDeploymentFile(deploymentPath);
  const catalog = validateNotificationTopicsFile(
    catalogPath,
    referenceNotificationTargetRegistry(),
    deployment,
  );
  let account: ReturnType<typeof parseFcmServiceAccount>;
  let accountText: string;
  try {
    const raw = readFileSync(serviceAccountPath, 'utf8');
    account = parseFcmServiceAccount(raw);
    // One line: the key's private_key keeps its \n escapes inside the JSON string.
    accountText = JSON.stringify(JSON.parse(raw));
  } catch (error) {
    // parseFcmServiceAccount names a missing field, never a value.
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
    ...variables.map(([name, value]) => `${name}=${formatLiveEnvValue(value)}`),
    '',
  ].join('\n');
  writeFileSync(outPath, text, { mode: 0o600, flag: input.overwrite === true ? 'w' : 'wx' });
  // An overwritten file keeps its old mode; the key is for this user only.
  chmodSync(outPath, 0o600);
  return {
    outPath,
    projectId: input.projectId ?? account.projectId,
    topics: catalog.topics.length,
    advertisingRules: deployment.advertisingRules ?? 'none',
    variables: variables.map(([name]) => name),
  };
}

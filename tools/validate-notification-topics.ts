import { existsSync } from 'node:fs';

import {
  validateNotificationTopicCatalog,
  type NotificationTopicCatalog,
  type NotificationTopicCatalogIssue,
} from '@mpgd/catalog';
import {
  assertNotificationDeployment,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
  type NotificationDeployment,
  type NotificationProviderRegistryEntry,
} from '@mpgd/platform/notifications';

import { readConfiguredPath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

/** Where a game keeps its notification topic catalog unless it names another file. */
export const defaultNotificationTopicsFile = 'packages/catalog/notifications.json';

/** Where a game keeps the backend's notification deployment settings unless it names another file. */
export const defaultNotificationDeploymentFile = 'packages/catalog/notification-deployment.json';

export interface NotificationTopicsFileSelection {
  readonly path: string;
  /** Whether the path was named by an argument or an environment variable. */
  readonly explicit: boolean;
}

/** The catalog file: the first argument, else `MPGD_NOTIFICATION_TOPICS_FILE`, else the default. */
export function selectNotificationTopicsFile(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): NotificationTopicsFileSelection {
  const named = readConfiguredPath(argv[0]) ?? readConfiguredPath(env.MPGD_NOTIFICATION_TOPICS_FILE);
  return named === undefined
    ? { path: defaultNotificationTopicsFile, explicit: false }
    : { path: named, explicit: true };
}

/**
 * The deployment settings file: the second argument, else
 * `MPGD_NOTIFICATION_DEPLOYMENT_FILE`, else the default.
 */
export function selectNotificationDeploymentFile(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): NotificationTopicsFileSelection {
  const named = readConfiguredPath(argv[1]) ?? readConfiguredPath(env.MPGD_NOTIFICATION_DEPLOYMENT_FILE);
  return named === undefined
    ? { path: defaultNotificationDeploymentFile, explicit: false }
    : { path: named, explicit: true };
}

/** Reads and validates a deployment settings file (RFC "Vector format" `deployment`). */
export function readNotificationDeploymentFile(path: string): NotificationDeployment {
  return assertNotificationDeployment(readJsonFile(path));
}

/** The reference provider registry entry each reference target name enables. */
export function referenceNotificationTargetRegistry(): Readonly<
  Record<string, NotificationProviderRegistryEntry>
> {
  return Object.fromEntries(
    Object.entries(referenceNotificationTargetProviders).map(([target, provider]) => [
      target,
      referenceNotificationProviders[provider],
    ]),
  );
}

export class NotificationTopicsValidationError extends Error {
  override readonly name = 'NotificationTopicsValidationError';
  readonly path: string;
  readonly issues: readonly NotificationTopicCatalogIssue[];

  constructor(path: string, issues: readonly NotificationTopicCatalogIssue[]) {
    super(
      `${path} is not a valid notification topic catalog:\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
    this.path = path;
    this.issues = issues;
  }
}

/**
 * Validates a topic catalog file against the notifications v2 RFC rules, the
 * providers its target names enable (the reference registry by default), and
 * the deployment settings it is released with.
 */
export function validateNotificationTopicsFile(
  path: string,
  targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>> =
    referenceNotificationTargetRegistry(),
  deployment?: NotificationDeployment,
): NotificationTopicCatalog {
  const result = validateNotificationTopicCatalog(readJsonFile(path), {
    targetProviders,
    ...(deployment === undefined ? {} : { deployment }),
  });
  if (!result.valid) {
    throw new NotificationTopicsValidationError(path, result.issues);
  }
  return result.catalog;
}

if (isCliEntrypoint(import.meta.url)) {
  const { path, explicit } = selectNotificationTopicsFile();
  if (!explicit && !existsSync(path)) {
    console.info(
      `No notification topic catalog at ${path}; nothing to validate. Pass a catalog file or set `
        + 'MPGD_NOTIFICATION_TOPICS_FILE.',
    );
  } else {
    try {
      const deploymentFile = selectNotificationDeploymentFile();
      const deployment = deploymentFile.explicit || existsSync(deploymentFile.path)
        ? readNotificationDeploymentFile(deploymentFile.path)
        : undefined;
      const catalog = validateNotificationTopicsFile(
        path,
        referenceNotificationTargetRegistry(),
        deployment,
      );
      const purposes = [...new Set(catalog.topics.map((topic) => topic.purpose))].sort().join(', ');
      console.info(
        `Notification topics ${catalog.version} (${path}): ${catalog.topics.length} topics; `
          + `default locale ${catalog.defaultLocale}; purposes: ${purposes || 'none'}; `
          + `advertising rules: ${deployment?.advertisingRules ?? 'no deployment settings'}`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

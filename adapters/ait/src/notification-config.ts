import type { AitNotificationTopicMapping } from './notifications-provider.js';

export type { AitNotificationTopicMapping } from './notifications-provider.js';

/** The catalog target whose topic mapping is the Apps in Toss template. */
export const defaultAitNotificationTarget = 'ait';

export interface ExtractAitNotificationTopicConfigOptions {
  /** Defaults to `ait`. */
  readonly target?: string;
  /** Label for error messages, for example the catalog file path. */
  readonly sourceLabel?: string;
}

/**
 * Reads the `notificationTopics` of `installAitHostBridge` from a
 * notification topic catalog (the `@mpgd/catalog` `NotificationTopicCatalog`
 * as parsed JSON): one `{ templateSetCode, agreement }` per topic whose
 * `targets[target]` maps it, keyed by the topic id. The catalog is the single
 * source of the template codes, so the wrapper and the backend agree on them;
 * a topic without a mapping for the target is not offered there, and the
 * host bridge then exposes no notifications at all when no topic is mapped.
 *
 * It checks only what the bridge needs and refuses, with the source label,
 * what would reach a player wrongly: a malformed catalog, a duplicate or
 * `__proto__` topic id, `targets` or a mapping that is not an object, a blank `templateSetCode`, an
 * `agreement` other than `required` or `none`, and an `advertising` topic,
 * which Apps in Toss cannot deliver. `pnpm validate:notifications` (or
 * `validateNotificationTopicCatalog` from `@mpgd/catalog`) checks the rest of
 * the catalog. Like `extractAitIapProductConfig`, this runs in the wrapper's
 * build config, so it imports no SDK.
 */
export function extractAitNotificationTopicConfig(
  input: unknown,
  options: ExtractAitNotificationTopicConfigOptions = {},
): Readonly<Record<string, AitNotificationTopicMapping>> {
  const target = options.target ?? defaultAitNotificationTarget;
  const sourceLabel = options.sourceLabel ?? 'notification topic catalog';
  if (!isRecord(input) || !Array.isArray(input.topics)) {
    throw new Error(`AIT notification topic catalog is invalid: ${sourceLabel}`);
  }
  const topics: readonly unknown[] = input.topics;
  const seen = new Set<string>();
  const mappings: Record<string, AitNotificationTopicMapping> = {};

  for (const [index, topic] of topics.entries()) {
    if (!isRecord(topic) || typeof topic.id !== 'string' || topic.id.trim().length === 0
      || topic.id === '__proto__') {
      throw new Error(`AIT notification topic at index ${index} is invalid: ${sourceLabel}`);
    }
    if (seen.has(topic.id)) {
      throw new Error(
        `Duplicate notification topic "${topic.id}" at index ${index}: ${sourceLabel}`,
      );
    }
    seen.add(topic.id);
    const targets = topic.targets;
    if (targets === undefined) {
      continue;
    }
    if (!isRecord(targets)) {
      throw new Error(`Notification topic "${topic.id}" has invalid targets: ${sourceLabel}`);
    }
    if (!Object.prototype.hasOwnProperty.call(targets, target)) {
      continue;
    }
    const mapping = targets[target];
    if (!isRecord(mapping)) {
      throw new Error(
        `Notification topic "${topic.id}" has an invalid ${target} mapping: ${sourceLabel}`,
      );
    }
    if (topic.purpose === 'advertising') {
      throw new Error(
        `Notification topic "${topic.id}" is advertising, which Apps in Toss cannot deliver; `
          + `remove its ${target} mapping: ${sourceLabel}`,
      );
    }
    const templateSetCode = typeof mapping.templateSetCode === 'string'
      ? mapping.templateSetCode.trim()
      : '';
    if (templateSetCode.length === 0) {
      throw new Error(
        `Notification topic "${topic.id}" needs a non-empty ${target} templateSetCode: ${sourceLabel}`,
      );
    }
    if (mapping.agreement !== 'required' && mapping.agreement !== 'none') {
      throw new Error(
        `Notification topic "${topic.id}" needs ${target} agreement 'required' or 'none': ${sourceLabel}`,
      );
    }
    mappings[topic.id] = { templateSetCode, agreement: mapping.agreement };
  }

  return mappings;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file system and path calls `readAitNotificationTopicsFile` makes (node's in a build config). */
export interface AitNotificationTopicsFileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  resolve(...paths: string[]): string;
}

export interface ReadAitNotificationTopicsFileInput extends ExtractAitNotificationTopicConfigOptions {
  /** `MPGD_NOTIFICATION_TOPICS_FILE`, as set; blank counts as unset. */
  readonly configured: string | undefined;
  /**
   * The game root (the kit root for the kit wrapper): a relative configured
   * path resolves against it, as `pnpm validate:notifications` reads it, not
   * against the wrapper directory the build runs in.
   */
  readonly rootDir: string;
  /** The catalog read when nothing is configured and it exists, relative to `rootDir`. */
  readonly defaultFile: string;
}

/**
 * Reads the wrapper's `notificationTopics` from the catalog file:
 * `configured` (resolved against `rootDir`), which must exist, else
 * `defaultFile` when it exists, else no topics. An unreadable file or
 * invalid JSON throws with the resolved path; the catalog's own refusals
 * are `extractAitNotificationTopicConfig`'s.
 */
export function readAitNotificationTopicsFile(
  input: ReadAitNotificationTopicsFileInput,
  fs: AitNotificationTopicsFileSystem,
): Readonly<Record<string, AitNotificationTopicMapping>> {
  const configured = input.configured?.trim();
  let file: string;
  if (configured !== undefined && configured.length > 0) {
    file = fs.resolve(input.rootDir, configured);
  } else {
    file = fs.resolve(input.rootDir, input.defaultFile);
    if (!fs.existsSync(file)) {
      return {};
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`AIT notification topic catalog is unreadable or invalid JSON: ${file}`, {
      cause: error,
    });
  }

  return extractAitNotificationTopicConfig(parsed, {
    ...(input.target === undefined ? {} : { target: input.target }),
    sourceLabel: input.sourceLabel ?? file,
  });
}

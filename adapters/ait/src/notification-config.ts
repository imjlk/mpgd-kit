import {
  resolveNotificationTopicsForTarget,
  validateNotificationTopicCatalog,
} from '@mpgd/catalog';
import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import { aitNotificationProviderId } from './notifications-provider-id.js';
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
 * The catalog goes through `validateNotificationTopicCatalog` from
 * `@mpgd/catalog`, with the Apps in Toss registry entry for `target` (which
 * requires a non-blank `templateSetCode` and an `agreement` of `required` or
 * `none`), and `resolveNotificationTopicsForTarget` picks the mapped topics,
 * so for the Apps in Toss target the wrapper refuses what
 * `pnpm validate:notifications` refuses: the shape, each topic's rules, the
 * copy, the notices, and the target's mappings, including an `advertising`
 * topic mapped to it, which Apps in Toss cannot deliver. It does not check
 * other targets' mappings or the deployment, which the wrapper builds
 * without (`pnpm validate:notifications` reads the backend's settings). It
 * trims the template code. Like `extractAitIapProductConfig`, this runs in the
 * wrapper's build config, so it imports no SDK.
 */
export function extractAitNotificationTopicConfig(
  input: unknown,
  options: ExtractAitNotificationTopicConfigOptions = {},
): Readonly<Record<string, AitNotificationTopicMapping>> {
  const target = options.target ?? defaultAitNotificationTarget;
  const sourceLabel = options.sourceLabel ?? 'notification topic catalog';
  const result = validateNotificationTopicCatalog(input, {
    targetProviders: { [target]: referenceNotificationProviders[aitNotificationProviderId] },
    // The deployment's own checks are `pnpm validate:notifications`'s, with
    // the backend's settings. `none` adds no check here, and the Apps in
    // Toss entry refuses an advertising topic under any rules.
    deployment: { advertisingRules: 'none' },
  });
  if (!result.valid) {
    throw new Error(
      `AIT notification topic catalog is invalid: ${sourceLabel}\n${result.issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const mappings: Record<string, AitNotificationTopicMapping> = {};
  for (const topic of resolveNotificationTopicsForTarget(result.catalog, target)) {
    // Defence in depth: the registry entry above already refuses this, and
    // the host bridge must never offer an advertising topic.
    if (topic.purpose === 'advertising') {
      throw new Error(
        `Notification topic "${topic.id}" is advertising, which Apps in Toss cannot deliver; `
          + `remove its ${target} mapping: ${sourceLabel}`,
      );
    }
    const templateSetCode = typeof topic.mapping?.templateSetCode === 'string'
      ? topic.mapping.templateSetCode.trim()
      : '';
    const agreement = topic.mapping?.agreement;
    if (templateSetCode.length === 0) {
      throw new Error(
        `Notification topic "${topic.id}" needs a non-empty ${target} templateSetCode: ${sourceLabel}`,
      );
    }
    // The registry entry's rules already passed; checked again for the type.
    if (agreement !== 'required' && agreement !== 'none') {
      throw new Error(
        `Notification topic "${topic.id}" needs ${target} agreement 'required' or 'none': ${sourceLabel}`,
      );
    }
    mappings[topic.id] = { templateSetCode, agreement };
  }
  return mappings;
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
  const trimmed = input.configured?.trim();
  // One predicate decides both the file and the error's label.
  const configured = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
  let file: string;
  if (configured !== undefined) {
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
    const source = configured === undefined ? '' : ' (MPGD_NOTIFICATION_TOPICS_FILE)';
    throw new Error(
      `AIT notification topic catalog is unreadable or invalid JSON: ${file}${source}`,
      {
        cause: error,
      },
    );
  }

  return extractAitNotificationTopicConfig(parsed, {
    ...(input.target === undefined ? {} : { target: input.target }),
    sourceLabel: input.sourceLabel ?? file,
  });
}

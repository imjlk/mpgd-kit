import {
  assertNotificationTopicCatalog,
  resolveNotificationTopicsForTarget,
  type NotificationTopicCatalog,
} from '@mpgd/catalog';
import {
  assertNotificationDeliveryProviderEntry,
  assertNotificationDeployment,
  referenceNotificationTargetProviders,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationNoticeSettings,
  type NotificationProviderRegistryEntry,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import type {
  NotificationDeviceAddress,
  NotificationRemoteDeliveryProvider,
} from './delivery-provider.js';

/**
 * The server-side provider registry (notifications v2 RFC, "Provider
 * registry"): each delivery provider's registry entry, which is the policy
 * gate's only capability input, the provider that sends for it, and the
 * catalog targets whose mappings it reads.
 */

/** Days a delivery stays in the gate's history; no provider limit may count further back. */
export const notificationHistoryRetentionDays = 30;

export interface NotificationProviderRegistration {
  /**
   * The registry entry, as the backend publishes it. A
   * `NotificationProviderRegistryEntry` also carries the mapping rules the
   * catalog validator checks.
   */
  readonly entry: NotificationDeliveryProviderEntry | NotificationProviderRegistryEntry;
  readonly delivery: NotificationRemoteDeliveryProvider;
  /**
   * The catalog targets this provider serves, in preference order. Each
   * target's mapping is what the gate reads for a recipient on that target;
   * two targets may share one provider (FCM on `android` and `ios`). Defaults
   * to the reference targets of the entry's provider id
   * (`referenceNotificationTargetProviders`).
   */
  readonly targets?: readonly string[];
  /** For a device provider: the address kinds it can send to. Defaults to both FCM kinds. */
  readonly addressKinds?: readonly NotificationDeviceAddress['kind'][];
}

export interface RegisteredNotificationProvider {
  readonly entry: NotificationDeliveryProviderEntry;
  readonly delivery: NotificationRemoteDeliveryProvider;
  readonly targets: readonly string[];
  readonly addressKinds: readonly NotificationDeviceAddress['kind'][];
  /** The entry with mapping rules, for the catalog validator; empty rules when none were given. */
  readonly validation: NotificationProviderRegistryEntry;
}

/** What the backend publishes, so a runtime can compare its provider's capabilities at start. */
export interface NotificationProviderRegistrySnapshot {
  readonly providers: readonly NotificationDeliveryProviderEntry[];
  /** Each served target and the provider id that delivers to it. */
  readonly targets: Readonly<Record<string, string>>;
}

export interface NotificationProviderRegistry {
  readonly providers: readonly RegisteredNotificationProvider[];
  provider(id: string): RegisteredNotificationProvider | undefined;
  /** The provider a catalog target enables, if this backend serves the target. */
  providerForTarget(target: string): RegisteredNotificationProvider | undefined;
  /** A fresh copy of the published entries and targets. */
  snapshot(): NotificationProviderRegistrySnapshot;
}

const deviceAddressKinds = ['fcm-token', 'fcm-installation'] as const;
const maxHistoryWindowSeconds = notificationHistoryRetentionDays * 86_400;

/**
 * Builds the registry and checks it once: one registration per provider id
 * and per target, an entry that passes `assertNotificationDeliveryProviderEntry`,
 * a delivery provider whose `id` equals the entry's `provider`, a
 * `readPermission` for a server-readable entry, provider limits no longer
 * than the delivery history keeps, and no `per-send` entry.
 *
 * Per-send providers (WeChat one-time subscriptions, not planned) need the
 * acceptance reserved in the same atomic step that claims the delivery, which
 * this backend does not implement, so they are refused rather than served
 * without the reservation.
 */
export function createNotificationProviderRegistry(
  registrations: readonly NotificationProviderRegistration[],
): NotificationProviderRegistry {
  const byId = new Map<string, RegisteredNotificationProvider>();
  const byTarget = new Map<string, RegisteredNotificationProvider>();
  for (const [index, registration] of registrations.entries()) {
    const at = `providers[${index}]`;
    const { mapping, ...plain } = registration.entry as NotificationProviderRegistryEntry;
    let entry: NotificationDeliveryProviderEntry;
    try {
      entry = structuredClone(assertNotificationDeliveryProviderEntry(plain));
    } catch (error) {
      throw new TypeError(`${at}.entry is not a provider registry entry: ${describe(error)}`, {
        cause: error,
      });
    }
    if (registration.delivery.id !== entry.provider) {
      throw new TypeError(
        `${at}: the delivery provider ${registration.delivery.id} is registered for entry ${entry.provider}.`,
      );
    }
    if (byId.has(entry.provider)) {
      throw new TypeError(`${at}: provider ${entry.provider} is registered twice.`);
    }
    if (entry.permission.allowance === 'per-send') {
      throw new TypeError(
        `${at}: provider ${entry.provider} is per-send; this backend cannot reserve an acceptance atomically with the delivery claim.`,
      );
    }
    if (entry.permission.serverReadable && registration.delivery.readPermission === undefined) {
      throw new TypeError(
        `${at}: provider ${entry.provider} is server-readable but its delivery provider has no readPermission.`,
      );
    }
    for (const limit of entry.limits ?? []) {
      if (limit.windowSeconds > maxHistoryWindowSeconds) {
        throw new TypeError(
          `${at}: a limit window of ${limit.windowSeconds} seconds is longer than the ${notificationHistoryRetentionDays}-day delivery history.`,
        );
      }
    }
    const targets = registration.targets
      ?? Object.entries(referenceNotificationTargetProviders)
        .filter(([, provider]) => provider === entry.provider)
        .map(([target]) => target);
    if (targets.length === 0 || new Set(targets).size !== targets.length) {
      throw new TypeError(
        `${at}: provider ${entry.provider} needs its catalog targets, each once (no reference targets name it).`,
      );
    }
    const addressKinds = registration.addressKinds ?? deviceAddressKinds;
    if (entry.addressing === 'device' && addressKinds.length === 0) {
      throw new TypeError(`${at}: device provider ${entry.provider} accepts no address kind.`);
    }
    const registered: RegisteredNotificationProvider = {
      entry,
      delivery: registration.delivery,
      targets: [...targets],
      addressKinds: [...addressKinds],
      validation: { ...structuredClone(entry), mapping: structuredClone(mapping ?? {}) },
    };
    for (const target of targets) {
      const other = byTarget.get(target);
      if (other !== undefined) {
        throw new TypeError(
          `${at}: target ${target} is served by both ${other.entry.provider} and ${entry.provider}.`,
        );
      }
      byTarget.set(target, registered);
    }
    byId.set(entry.provider, registered);
  }
  const providers = [...byId.values()];
  return {
    providers,
    provider: (id) => byId.get(id),
    providerForTarget: (target) => byTarget.get(target),
    snapshot: () => ({
      providers: providers.map((provider) => structuredClone(provider.entry)),
      targets: Object.fromEntries(
        [...byTarget].map(([target, provider]) => [target, provider.entry.provider]),
      ),
    }),
  };
}

/**
 * The catalog as the notifications service reads it: the topics resolved for
 * one target, with that target's mapping, the default locale, and the
 * catalog's `notices` block taken as is.
 */
export interface NotificationServiceCatalog {
  readonly defaultLocale: string;
  readonly notices?: NotificationNoticeSettings;
  topicsFor(target: string): readonly NotificationTopicDeclaration[];
}

/**
 * Validates a topic catalog against the registry's providers and the
 * deployment (`assertNotificationTopicCatalog` from `@mpgd/catalog`, with
 * each served target checked against its provider's mapping rules), and
 * resolves it per target. An invalid catalog throws one error listing every
 * issue, so a deployment never starts on a catalog the release validator
 * would refuse.
 */
export function createNotificationServiceCatalog(
  catalog: unknown,
  options: {
    readonly registry: NotificationProviderRegistry;
    readonly deployment?: NotificationDeployment;
  },
): NotificationServiceCatalog {
  const deployment = options.deployment === undefined
    ? undefined
    : assertNotificationDeployment(options.deployment);
  const targetProviders: Record<string, NotificationProviderRegistryEntry> = {};
  for (const provider of options.registry.providers) {
    for (const target of provider.targets) {
      targetProviders[target] = provider.validation;
    }
  }
  const validated: NotificationTopicCatalog = assertNotificationTopicCatalog(catalog, {
    targetProviders,
    ...(deployment === undefined ? {} : { deployment }),
  });
  const resolved = new Map<string, readonly NotificationTopicDeclaration[]>();
  return {
    defaultLocale: validated.defaultLocale,
    ...(validated.notices === undefined ? {} : { notices: validated.notices }),
    topicsFor(target) {
      let topics = resolved.get(target);
      if (topics === undefined) {
        topics = resolveNotificationTopicsForTarget(validated, target);
        resolved.set(target, topics);
      }
      return topics;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

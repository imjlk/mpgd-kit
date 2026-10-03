import {
  bridgeStorageLoadProtocol,
  createBridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStorageLoadData,
} from '@mpgd/bridge';

export const maxStorageKeyLength = 128;
export const maxEncodedStorageKeyLength = 384;
export const maxStorageValueBytes = 262_144;
/**
 * Hard cap on distinct `storage.save` keys per authenticated player. Combined with
 * `maxStorageValueBytes` this bounds the Redis footprint one Reddit account can
 * create inside the installation's shared quota.
 */
export const maxStorageKeysPerPlayer = 32;
/**
 * Optional expiry applied to every saved value and to the per-player key index on
 * each save. Cloud saves are expected to persist for the lifetime of the player,
 * so the default is no expiry. Set a positive number of seconds to let idle saves
 * fall out of Redis; the index is refreshed on every save, so stale index fields
 * for expired values still count toward `maxStorageKeysPerPlayer` until the
 * player writes to those keys again.
 */
export const storageEntryTtlSeconds: number | undefined = undefined;
/** Redis key namespace used when `storageKeyNamespace` is not injected. */
export const defaultStorageKeyNamespace = 'mpgd';
const storageIndexTransactionAttempts = 3;

export interface DevvitBridgeRedisTransactionLike {
  multi(): Promise<void>;
  discard(): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  hSet(key: string, fieldValues: Readonly<Record<string, string>>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  exec(): Promise<readonly unknown[] | null>;
  unwatch(): Promise<unknown>;
}

/** Subset of the Devvit server Redis client used by the bridge storage handlers. */
export interface DevvitBridgeRedisLike {
  get(key: string): Promise<string | undefined>;
  exists(...keys: readonly string[]): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hLen(key: string): Promise<number>;
  watch(...keys: readonly string[]): Promise<DevvitBridgeRedisTransactionLike>;
}

export interface DevvitBridgeHandlerDependencies {
  readonly redis: DevvitBridgeRedisLike;
  /** Authenticated Reddit user ID from the Devvit request context, never from the payload. */
  readonly currentPlayerId: () => string | undefined;
  readonly currentDisplayName: (playerId: string) => Promise<string>;
  /**
   * Prefix for the per-player value and index keys. Generated games pass their
   * game name so saves stay namespaced per game inside the shared Redis.
   */
  readonly storageKeyNamespace?: string | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

export type DevvitBridgeHandler = (input: BridgeRequest) => Promise<BridgeResponse>;

export function createDevvitBridgeHandler(
  dependencies: DevvitBridgeHandlerDependencies,
): DevvitBridgeHandler {
  const warn = dependencies.warn ?? ((message) => {
    console.warn(message);
  });
  const storageKeyNamespace = dependencies.storageKeyNamespace ?? defaultStorageKeyNamespace;

  if (storageKeyNamespace.length === 0) {
    throw new TypeError('Devvit bridge storageKeyNamespace must not be empty.');
  }

  return async function handleBridgeRequest(input: BridgeRequest): Promise<BridgeResponse> {
    switch (input.method) {
      case 'runtime.getCapabilities':
        return ok(input, {
          nativeIap: false,
          nativeAds: false,
          rewardedAds: false,
          interstitialAds: false,
          nativeLeaderboard: false,
          remoteLeaderboard: false,
          achievements: false,
          cloudSave: true,
          socialShare: false,
          haptics: false,
          localizedContent: true,
        });

      case 'identity.getPlayer': {
        const playerId = dependencies.currentPlayerId();

        if (playerId === undefined) {
          return ok(input, null);
        }

        return ok(input, {
          playerId,
          displayName: await dependencies.currentDisplayName(playerId),
        });
      }

      case 'identity.getSession': {
        const playerId = dependencies.currentPlayerId();

        return ok(
          input,
          playerId === undefined
            ? {
                identityLevel: 'guest',
                trustLevel: 'local',
              }
            : {
                identityLevel: 'authenticated',
                playerId,
                trustLevel: 'server-verified',
              },
        );
      }

      case 'identity.requestUpgrade': {
        const authenticated = dependencies.currentPlayerId() !== undefined;

        return ok(input, {
          status: authenticated ? 'completed' : 'unavailable',
          reloadExpected: false,
        });
      }

      case 'presentation.getLaunchIntent':
        return ok(input, { entry: 'home' });

      case 'presentation.requestGameSurface':
        return ok(input, 'unavailable');

      case 'share.share':
        return ok(input, { status: 'unavailable' });

      case 'share.readInboundShare':
        return ok(input, null);

      case 'notifications.getStatus':
        return ok(input, 'approval-required');

      case 'notifications.requestSubscription':
        return ok(input, 'unavailable');

      case 'commerce.getProducts':
      case 'commerce.getEntitlements':
        return ok(input, []);

      case 'commerce.purchase':
        return ok(input, {
          status: 'cancelled',
          entitlementIds: [],
        });

      case 'commerce.restore':
        return ok(input, {
          restoredEntitlements: [],
        });

      case 'ads.preload':
        return ok(input, {});

      case 'leaderboard.open':
        return createBridgeError(
          input.id,
          'DEVVIT_LEADERBOARD_OPEN_UNAVAILABLE',
          'Devvit leaderboard display is not implemented yet.',
        );

      case 'ads.showRewarded':
        return ok(input, {
          status: 'unavailable',
          rewardGranted: false,
        });

      case 'ads.showInterstitial':
        return ok(input, {
          status: 'unavailable',
        });

      case 'leaderboard.submitScore':
        return ok(input, {
          submitted: false,
        });

      case 'storage.load':
        return loadStorage(input, dependencies, storageKeyNamespace, warn);

      case 'storage.save':
        return saveStorage(input, dependencies, storageKeyNamespace, warn);

      default:
        return createBridgeError(
          input.id,
          'UNSUPPORTED_METHOD',
          `Unsupported Devvit bridge method: ${input.method}`,
        );
    }
  };
}

async function loadStorage(
  input: BridgeRequest,
  dependencies: DevvitBridgeHandlerDependencies,
  storageKeyNamespace: string,
  warn: (message: string) => void,
): Promise<BridgeResponse> {
  const playerId = dependencies.currentPlayerId();

  if (playerId === undefined) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_IDENTITY_REQUIRED',
      'A current Reddit player is required to load storage.',
    );
  }

  const location = storageLocation(input, playerId, storageKeyNamespace);

  if (!('valueKey' in location)) {
    return location;
  }

  let stored: string | null | undefined;

  try {
    stored = await dependencies.redis.get(location.valueKey);
  } catch (error) {
    warn(`devvit storage load failed: ${errorMessage(error)}`);
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_LOAD_FAILED',
      'Devvit storage could not be loaded.',
      true,
    );
  }

  if (stored === undefined || stored === null) {
    return ok(input, {
      __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
      found: false,
    } satisfies BridgeStorageLoadData);
  }

  try {
    return ok(
      input,
      {
        __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
        found: true,
        value: JSON.parse(stored),
      } satisfies BridgeStorageLoadData,
    );
  } catch {
    return createBridgeError(input.id, 'CORRUPTED_STORAGE_VALUE', 'Stored data is not valid JSON.');
  }
}

async function saveStorage(
  input: BridgeRequest,
  dependencies: DevvitBridgeHandlerDependencies,
  storageKeyNamespace: string,
  warn: (message: string) => void,
): Promise<BridgeResponse> {
  const playerId = dependencies.currentPlayerId();

  if (playerId === undefined) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_IDENTITY_REQUIRED',
      'A current Reddit player is required to save storage.',
    );
  }

  const location = storageLocation(input, playerId, storageKeyNamespace);

  if (!('valueKey' in location)) {
    return location;
  }

  const payload = optionalObjectPayload(input.payload) as { readonly value?: unknown };
  let serialized: string;

  try {
    const candidate = JSON.stringify(payload.value);

    if (typeof candidate !== 'string') {
      throw new Error('JSON serialization did not produce a string.');
    }

    serialized = candidate;
  } catch {
    return createBridgeError(
      input.id,
      'INVALID_STORAGE_VALUE',
      'Storage values must be JSON serializable.',
    );
  }

  if (new TextEncoder().encode(serialized).length > maxStorageValueBytes) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_QUOTA_EXCEEDED',
      `Storage values must not exceed ${String(maxStorageValueBytes)} UTF-8 bytes.`,
    );
  }

  let persisted: boolean;

  try {
    persisted = await writeIndexedStorageValue(dependencies.redis, location, serialized);
  } catch (error) {
    warn(`devvit storage save was not persisted: ${errorMessage(error)}`);
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_SAVE_FAILED',
      'Devvit storage could not be saved.',
      true,
    );
  }

  if (!persisted) {
    return createBridgeError(
      input.id,
      'DEVVIT_STORAGE_KEY_LIMIT',
      `Players may store at most ${String(maxStorageKeysPerPlayer)} distinct storage keys.`,
    );
  }

  return ok(input, {
    saved: true,
    playerId,
  });
}

/**
 * Writes the value and registers its key in the per-player index inside one
 * WATCH/MULTI/EXEC transaction. The cap check reads the index while it is
 * watched, so a concurrent save that changes the index aborts EXEC and the
 * attempt is retried with fresh counts instead of overshooting the cap.
 *
 * The Devvit Redis client (`@devvit/redis` `TxClient.exec()`) never resolves
 * `null` for an aborted transaction; it maps the server reply to an array, so a
 * WATCH abort surfaces as an empty array. An EXEC result with fewer entries than
 * the commands queued after MULTI is therefore treated as a conflict, and `null`
 * is kept as a conflict too for clients that follow the classic Redis contract.
 *
 * Returns `false` when the key is new and the player already holds
 * `maxStorageKeysPerPlayer` keys.
 */
async function writeIndexedStorageValue(
  redis: DevvitBridgeRedisLike,
  location: StorageLocation,
  serialized: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < storageIndexTransactionAttempts; attempt += 1) {
    const transaction = await redis.watch(location.indexKey, location.valueKey);
    let multiStarted = false;

    try {
      if (!(await playerOwnsStorageKey(redis, location))) {
        const indexedKeyCount = await redis.hLen(location.indexKey);

        if (indexedKeyCount >= maxStorageKeysPerPlayer) {
          await transaction.unwatch();
          return false;
        }
      }

      await transaction.multi();
      multiStarted = true;
      let queuedCommandCount = 0;
      await transaction.set(location.valueKey, serialized);
      queuedCommandCount += 1;
      await transaction.hSet(location.indexKey, { [location.indexField]: '1' });
      queuedCommandCount += 1;

      if (storageEntryTtlSeconds !== undefined) {
        await transaction.expire(location.valueKey, storageEntryTtlSeconds);
        queuedCommandCount += 1;
        await transaction.expire(location.indexKey, storageEntryTtlSeconds);
        queuedCommandCount += 1;
      }

      const results = await transaction.exec();

      if (results === null) {
        continue;
      }

      if (!Array.isArray(results)) {
        throw new Error('Devvit Redis transaction returned an unsupported response.');
      }

      if (results.length < queuedCommandCount) {
        continue;
      }

      return true;
    } catch (error) {
      await bestEffortReset(transaction, multiStarted);
      throw error;
    }
  }

  throw new Error(
    `Devvit Redis transaction contention exceeded ${String(storageIndexTransactionAttempts)} attempts for key: ${location.valueKey}`,
  );
}

async function playerOwnsStorageKey(
  redis: DevvitBridgeRedisLike,
  location: StorageLocation,
): Promise<boolean> {
  if ((await redis.hGet(location.indexKey, location.indexField)) !== undefined) {
    return true;
  }

  // Values written before the index existed are still owned by the player; they
  // are backfilled into the index on their next save instead of counting as new.
  return (await redis.exists(location.valueKey)) > 0;
}

async function bestEffortReset(
  transaction: DevvitBridgeRedisTransactionLike,
  multiStarted: boolean,
): Promise<void> {
  try {
    if (multiStarted) {
      await transaction.discard();
    } else {
      await transaction.unwatch();
    }
  } catch {
    // Preserve the original Redis failure; this cleanup is best-effort.
  }
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return {
    id: input.id,
    ok: true,
    data,
  };
}

interface StorageLocation {
  readonly valueKey: string;
  readonly indexKey: string;
  readonly indexField: string;
}

export function storageValueKey(
  playerId: string,
  clientKey: string,
  namespace: string = defaultStorageKeyNamespace,
): string {
  return `${namespace}:save:${encodeURIComponent(playerId)}:${encodeURIComponent(clientKey)}`;
}

export function storageIndexKey(
  playerId: string,
  namespace: string = defaultStorageKeyNamespace,
): string {
  return `${namespace}:save-keys:${encodeURIComponent(playerId)}`;
}

function storageLocation(
  input: BridgeRequest,
  playerId: string,
  namespace: string,
): StorageLocation | BridgeResponse {
  const payload = optionalObjectPayload(input.payload);

  if (typeof payload.key !== 'string' || payload.key.length === 0) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Storage key is required.');
  }

  if (payload.key.length > maxStorageKeyLength) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Storage key is too long.');
  }

  const encodedKey = encodeURIComponent(payload.key);

  if (encodedKey.length > maxEncodedStorageKeyLength) {
    return createBridgeError(input.id, 'INVALID_STORAGE_KEY', 'Encoded storage key is too long.');
  }

  return {
    valueKey: storageValueKey(playerId, payload.key, namespace),
    indexKey: storageIndexKey(playerId, namespace),
    indexField: encodedKey,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalObjectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  return payload as Record<string, unknown>;
}

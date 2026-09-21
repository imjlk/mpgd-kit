/**
 * Example IndexedDB implementation of the public persistent cache contract.
 * The package owns the acquisition boundary; this module only supplies
 * storage and remains example-only.
 *
 * What is stored: original bytes of files-delivery files and ZIP
 * archives. Never stored: expanded entries (the delivery stages them
 * in memory), images/audio/textures, code, tokens or personal data.
 *
 * Identity is content-derived and host independent:
 * `${namespace}|${digestAlgorithm}|${expectedDigest}|${expectedBytes}`.
 * Pack paths, CDN hosts and expiring queries are never the key, so the
 * same artifact fetched from another host resolves to the same record.
 * MIME and file roles always come from the CURRENT manifest — a stored
 * record's media type is never reused across manifests.
 */

import type {
  PhaserPackCacheContext,
  PhaserPackCacheKey,
  PhaserPackCacheEventOutcome,
  PhaserPackCacheUsage,
  PhaserPackPersistentCache,
} from '@mpgd/phaser-assets/delivery';

/** Finite limits: a single object and the total retained bytes are both
 * capped; over-cap stores abort and surface as store failures. No
 * LRU/GC/pin policy exists in this experiment. */
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
/** Every DB operation is bounded; the web platform offers no request
 * deadlines here, so a late timer resolves the whole session to
 * 'unavailable' and the origin path takes over. */
const IO_TIMEOUT_MS = 5_000;

const DB_NAME = 'mpgd-asset-pack-experiment';
const STORE_NAME = 'artifacts';
/** Records owned by this experiment live under this prefix; anything
 * else in the store belongs to other data and is never touched. */
const KEY_PREFIX = 'mpgd-asset-experiment|';
const USAGE_KEY = KEY_PREFIX + '__usage__';
const MIGRATION_KEY = KEY_PREFIX + '__public-cache-migrated__';
const SCHEMA_VERSION = 1;

/** Compact evidence outcomes used by the example's render/test surface. */
export type WarmOutcome =
  | 'cache-hit'
  | 'origin-downloaded'
  | 'origin-store-failed';

type StoreOutcome = 'origin-stored' | 'origin-store-failed';

export interface WarmEntry {
  readonly artifactLabel: string;
  readonly identity: string;
  readonly outcome: WarmOutcome;
  readonly bodyBytes: number;
}

export interface WarmDiagnostic {
  readonly identity: string;
  readonly outcome: PhaserPackCacheEventOutcome;
}

export interface WarmReport {
  readonly entries: readonly WarmEntry[];
  readonly hits: number;
  readonly downloaded: number;
  readonly failures: number;
  readonly diagnostics: readonly WarmDiagnostic[];
}

/** Test-only fault injection, set from page evaluation in the browser
 * acceptance. Faults fire once and clear themselves. */
export interface ArtifactCacheFaults {
  failPutOnce?: boolean;
  abortCommitOnce?: boolean;
  dbUnavailableOnce?: boolean;
}

interface CacheRecord {
  readonly schemaVersion: number;
  readonly digest: string;
  readonly bytes: number;
  readonly storedAt: number;
  readonly payload: ArrayBuffer;
}

interface StoredArtifact {
  readonly sha256: string;
  readonly bytes: number;
}

export const artifactCacheIdentity = (key: PhaserPackCacheKey): string =>
  `${KEY_PREFIX}${key.namespace}|sha256|${key.sha256}|${key.bytes}`;

/** A bounded promise wrapper: DB work must never hang the prepare. */
const withDeadline = async <T>(
  operation: (
    finish: (value: T) => void,
    fail: (error: unknown) => void,
    registerAbort: (abort: () => void) => void,
  ) => void,
  label: string,
  signal?: AbortSignal,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortWork: (() => void) | undefined;
  let abortTriggered = false;
  let onAbort: (() => void) | undefined;
  const abortReason = (): unknown => signal?.reason
    ?? new DOMException('The operation was aborted', 'AbortError');
  try {
    return await new Promise<T>((resolve, reject) => {
      const runAbortWork = (): void => {
        if (abortTriggered) {
          return;
        }
        abortTriggered = true;
        abortWork?.();
      };
      timer = setTimeout(() => {
        runAbortWork();
        reject(new Error(`artifact cache ${label} timed out`));
      }, IO_TIMEOUT_MS);
      onAbort = (): void => {
        runAbortWork();
        reject(abortReason());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      operation(
        (value) => resolve(value),
        reject,
        (abort) => {
          abortWork = abort;
          if (signal?.aborted) {
            runAbortWork();
          }
        },
      );
      if (signal?.aborted) {
        onAbort();
      }
    });
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
};

const bytesOfIdentity = (identity: string): number | undefined => {
  const bytes = Number(identity.slice(identity.lastIndexOf('|') + 1));
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

const isLegacyIdentity = (identity: string): boolean => {
  if (!identity.startsWith(KEY_PREFIX)) {
    return false;
  }
  const parts = identity.split('|');
  return parts.length === 4 && parts[1] === 'sha256';
};

/** Delete matching owned records and repair the aggregate quota marker in the
 * same transaction. A migration marker can make the scan idempotent. */
const repairOwnedRecords = async (
  db: IDBDatabase,
  shouldDelete: (identity: string) => boolean,
  label: string,
  signal?: AbortSignal,
  markerKey?: string,
): Promise<void> => {
  await withDeadline<void>((finish, fail, registerAbort) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    registerAbort(() => tx.abort());
    const store = tx.objectStore(STORE_NAME);
    const scan = (): void => {
      const request = store.getAllKeys();
      request.onsuccess = () => {
        let remaining = 0;
        for (const key of request.result) {
          if (typeof key !== 'string' || key === USAGE_KEY || key === MIGRATION_KEY) {
            continue;
          }
          if (shouldDelete(key)) {
            store.delete(key);
            continue;
          }
          if (key.startsWith(KEY_PREFIX)) {
            remaining += bytesOfIdentity(key) ?? 0;
          }
        }
        store.put({ total: remaining }, USAGE_KEY);
        if (markerKey !== undefined) {
          store.put({ version: 1 }, markerKey);
        }
      };
      request.onerror = () => fail(request.error ?? new Error(`artifact cache ${label} failed`));
    };
    if (markerKey === undefined) {
      scan();
    } else {
      const marker = store.get(markerKey);
      marker.onsuccess = () => {
        if (marker.result !== undefined) {
          finish(undefined);
          return;
        }
        scan();
      };
      marker.onerror = () => fail(marker.error ?? new Error(`artifact cache ${label} failed`));
    }
    tx.oncomplete = () => finish(undefined);
    tx.onabort = () => fail(tx.error ?? new Error(`artifact cache ${label} aborted`));
    tx.onerror = () => undefined;
  }, label, signal);
};

/** Remove records written by the pre-public Blob-URL experiment and repair
 * the aggregate quota marker in the same transaction. */
const sweepLegacyRecords = async (db: IDBDatabase): Promise<void> => {
  await repairOwnedRecords(db, isLegacyIdentity, 'migration', undefined, MIGRATION_KEY);
};

export class ArtifactCache implements PhaserPackPersistentCache {
  private constructor(private readonly db: IDBDatabase) {}

  readonly faults: ArtifactCacheFaults = {};

  static async open(): Promise<ArtifactCache | 'unavailable'> {
    if (typeof indexedDB === 'undefined') {
      return 'unavailable';
    }
    let openSettled = false;
    try {
      const db = await withDeadline<IDBDatabase>((finish, fail) => {
        const request = indexedDB.open(DB_NAME);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => {
          // The deadline can settle before IndexedDB delivers success. A
          // connection arriving after that point is not owned by a cache
          // instance and must be closed immediately.
          if (openSettled) {
            request.result.close();
            return;
          }
          finish(request.result);
        };
        request.onerror = () => fail(request.error ?? new Error('artifact cache open failed'));
        request.onblocked = () => undefined;
      }, 'open');
      openSettled = true;
      // A version bump elsewhere closes our handle promptly; later
      // operations fail into 'unavailable' rather than hanging.
      db.onversionchange = () => db.close();
      try {
        await sweepLegacyRecords(db);
      } catch {
        // A slow or temporarily blocked migration must not disable the
        // otherwise usable cache forever. The failed transaction rolled back;
        // keep this connection usable and retry the marker-gated sweep on the
        // next open.
      }
      return new ArtifactCache(db);
    } catch {
      openSettled = true;
      return 'unavailable';
    }
  }

  close(): void {
    this.db.close();
  }

  /** Public acquisition-boundary storage. The package re-checks the payload
   * digest; this adapter also rejects records whose stored metadata no longer
   * matches the requested identity. */
  async get(key: PhaserPackCacheKey, context: PhaserPackCacheContext = {}): Promise<ArrayBuffer | undefined> {
    context.signal?.throwIfAborted();
    if (this.faults.dbUnavailableOnce) {
      this.faults.dbUnavailableOnce = false;
      throw new Error('artifact cache database unavailable');
    }
    const record = await this.readRecord(artifactCacheIdentity(key), context.signal);
    context.signal?.throwIfAborted();
    if (record === null || record.schemaVersion !== SCHEMA_VERSION
      || record.digest !== key.sha256 || record.bytes !== key.bytes
      || !(record.payload instanceof ArrayBuffer) || record.payload.byteLength !== key.bytes) {
      if (record !== null) {
        await this.deleteRecord(artifactCacheIdentity(key), context.signal);
      }
      context.signal?.throwIfAborted();
      return undefined;
    }
    return record.payload;
  }

  async put(key: PhaserPackCacheKey, bytes: ArrayBuffer, context: PhaserPackCacheContext = {}): Promise<void> {
    context.signal?.throwIfAborted();
    if (bytes.byteLength !== key.bytes) {
      throw new Error('artifact cache store bytes do not match the declared key');
    }
    if (key.bytes > MAX_OBJECT_BYTES) {
      throw new Error(`artifact cache object exceeds its cap: ${key.bytes}`);
    }
    const outcome = await this.storeRecord(
      { sha256: key.sha256, bytes: key.bytes },
      artifactCacheIdentity(key),
      bytes,
      context.signal,
    );
    context.signal?.throwIfAborted();
    if (outcome !== 'origin-stored') {
      throw new Error(`artifact cache store ${outcome}`);
    }
  }

  async delete(key: PhaserPackCacheKey, context: PhaserPackCacheContext = {}): Promise<boolean> {
    context.signal?.throwIfAborted();
    const removed = await this.deleteRecord(artifactCacheIdentity(key), context.signal);
    context.signal?.throwIfAborted();
    return removed;
  }

  async clear(namespace: string, context: PhaserPackCacheContext = {}): Promise<void> {
    context.signal?.throwIfAborted();
    const prefix = `${KEY_PREFIX}${namespace}|`;
    await repairOwnedRecords(this.db, (identity) => identity.startsWith(prefix), 'clear', context.signal);
    context.signal?.throwIfAborted();
  }

  async usage(namespace: string, context: PhaserPackCacheContext = {}): Promise<PhaserPackCacheUsage> {
    context.signal?.throwIfAborted();
    const prefix = `${KEY_PREFIX}${namespace}|`;
    const usage = await withDeadline<PhaserPackCacheUsage>((finish, fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      registerAbort(() => tx.abort());
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        let records = 0;
        let totalBytes = 0;
        for (const key of request.result) {
          if (typeof key !== 'string' || !key.startsWith(prefix)) {
            continue;
          }
          const bytes = bytesOfIdentity(key);
          if (bytes === undefined) {
            continue;
          }
          records++;
          totalBytes += bytes;
        }
        finish({ records, totalBytes });
      };
      request.onerror = () => fail(request.error ?? new Error('artifact cache usage failed'));
      tx.onerror = () => undefined;
    }, 'usage', context.signal);
    context.signal?.throwIfAborted();
    return usage;
  }

  private readRecord(identity: string, signal?: AbortSignal): Promise<CacheRecord | null> {
    return withDeadline<CacheRecord | null>((finish, fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      registerAbort(() => tx.abort());
      const request = tx.objectStore(STORE_NAME).get(identity);
      request.onsuccess = () => finish(request.result ?? null);
      request.onerror = () => fail(request.error ?? new Error('artifact cache read failed'));
    }, 'read', signal);
  }

  /** Short readwrite transaction: bytes are already fetched and verified
   * above, so the commit itself never waits on network or crypto. The
   * stored marker requires the transaction's complete event — a request
   * onsuccess alone is not a commit. An abort (fault or quota) leaves
   * the previous good record untouched. */
  private async storeRecord(
    artifact: StoredArtifact,
    identity: string,
    data: ArrayBuffer,
    signal?: AbortSignal,
  ): Promise<StoreOutcome> {
    return withDeadline<StoreOutcome>((finish, _fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      registerAbort(() => tx.abort());
      const store = tx.objectStore(STORE_NAME);
      const usageRequest = store.get(USAGE_KEY);
      usageRequest.onsuccess = () => {
        const usage = usageRequest.result as { total: number } | undefined;
        const total = usage?.total ?? 0;
        // The identity includes the byte count, so a replacement has the
        // same size and adds no usage. The existing record is counted inside
        // the same transaction as the writes.
        const existingRequest = store.count(identity);
        existingRequest.onsuccess = () => {
          const delta = existingRequest.result > 0 ? 0 : artifact.bytes;
          if (delta > 0 && total + delta > MAX_TOTAL_BYTES) {
            tx.abort();
            return;
          }
          const record: CacheRecord = {
            schemaVersion: SCHEMA_VERSION,
            digest: artifact.sha256,
            bytes: artifact.bytes,
            storedAt: Date.now(),
            payload: data,
          };
          const put = store.put(record, identity);
          if (this.faults.failPutOnce) {
            this.faults.failPutOnce = false;
            queueMicrotask(() => {
              try {
                (put as unknown as { error: DOMException }).error
                  = new DOMException('injected store failure', 'QuotaExceededError');
                put.dispatchEvent(new Event('error'));
              } catch {
                tx.abort();
              }
            });
          }
          store.put({ total: total + delta }, USAGE_KEY);
        };
      };
      tx.oncomplete = () => finish('origin-stored');
      tx.onabort = () => finish('origin-store-failed');
      tx.onerror = () => undefined;
      if (this.faults.abortCommitOnce) {
        this.faults.abortCommitOnce = false;
        queueMicrotask(() => tx.abort());
      }
    }, 'write', signal);
  }

  /** Remove one record (corrupt cleanup, explicit deletion tests). Only
   * keys under the experiment prefix are ever touched. */
  async deleteRecord(identity: string, signal?: AbortSignal): Promise<boolean> {
    if (!identity.startsWith(KEY_PREFIX) || identity === USAGE_KEY || identity === MIGRATION_KEY) {
      return false;
    }
    return withDeadline<boolean>((finish, fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      registerAbort(() => tx.abort());
      const store = tx.objectStore(STORE_NAME);
      const usageRequest = store.get(USAGE_KEY);
      let existed = false;
      usageRequest.onsuccess = () => {
        const usage = usageRequest.result as { total: number } | undefined;
        const recordRequest = store.count(identity);
        recordRequest.onsuccess = () => {
          existed = recordRequest.result > 0;
          if (existed) {
            const bytes = bytesOfIdentity(identity) ?? 0;
            const total = Math.max(0, (usage?.total ?? bytes) - bytes);
            store.put({ total }, USAGE_KEY);
          }
          store.delete(identity);
        };
      };
      tx.oncomplete = () => finish(existed);
      tx.onabort = () => fail(tx.error ?? new Error('artifact cache delete aborted'));
      tx.onerror = () => undefined;
    }, 'delete', signal);
  }

}

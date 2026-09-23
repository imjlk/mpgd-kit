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
 * `${namespace}|${digestAlgorithm}|${expectedDigest}|${expectedBytes}` for
 * legacy records, or `v2:<encodedNamespace>:<expectedDigest>:<expectedBytes>`
 * for new records. The v2 form has no legacy `|sha256|` marker, so namespace
 * matching remains unambiguous even when a namespace contains separators.
 * Pack paths, CDN hosts and expiring queries are never the key, so the
 * same artifact fetched from another host resolves to the same record.
 * MIME and file roles always come from the CURRENT manifest — a stored
 * record's media type is never reused across manifests.
 */

import type {
  PhaserPackCacheContext,
  PhaserPackCacheEventOutcome,
  PhaserPackCacheKey,
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

/** Namespaces containing `|` use an unambiguous v2 identity and retain their
 * legacy twin only while an older record is being migrated. */
const encodedNamespaceOf = (namespace: string): string | undefined => {
  if (!namespace.includes('|')) {
    return undefined;
  }
  try {
    const encoded = encodeURIComponent(namespace);
    // Modern engines encode lone surrogates as U+FFFD instead of throwing;
    // only use the v2 form when it decodes back to the exact namespace.
    return decodeURIComponent(encoded) === namespace ? encoded : undefined;
  } catch {
    return undefined;
  }
};

const usesV2Identity = (key: PhaserPackCacheKey): boolean =>
  encodedNamespaceOf(key.namespace) !== undefined;

/** Convert a public content identity to this adapter's namespaced key. */
export const artifactCacheIdentity = (key: PhaserPackCacheKey): string => {
  const encodedNamespace = encodedNamespaceOf(key.namespace);
  return encodedNamespace === undefined
    ? `${KEY_PREFIX}${key.namespace}|sha256|${key.sha256}|${key.bytes}`
    : `${KEY_PREFIX}v2:${encodedNamespace}:${key.sha256}:${key.bytes}`;
};

interface V2IdentityParts {
  readonly namespace: string;
  readonly sha256: string;
  readonly bytes: number;
}

const v2IdentityPartsOf = (identity: string): V2IdentityParts | undefined => {
  if (!identity.startsWith(KEY_PREFIX)) {
    return undefined;
  }
  const current = /^v2:([^:]*):([0-9a-f]{64}):(\d+)$/iu.exec(identity.slice(KEY_PREFIX.length));
  if (current === null) {
    return undefined;
  }
  try {
    return {
      namespace: decodeURIComponent(current[1]!),
      // Preserve the matched case: legacyTwinOf must stay byte-identical to
      // legacyArtifactCacheIdentity, which interpolates key.sha256 verbatim
      // (the package factory lowercases, but the raw debug-hook key in
      // main.ts can still carry uppercase hex).
      sha256: current[2]!,
      bytes: Number(current[3]),
    };
  } catch {
    return undefined;
  }
};

/** Decode the namespace from current and pre-public content identities. */
const namespaceOfIdentity = (identity: string): string | undefined => {
  if (!identity.startsWith(KEY_PREFIX)) {
    return undefined;
  }
  const current = v2IdentityPartsOf(identity);
  if (current !== undefined) {
    return current.namespace;
  }
  const rest = identity.slice(KEY_PREFIX.length);
  // The old public form ends with `|sha256|<64 hex>|<bytes>`; the greedy
  // group anchors to the last marker plus a validated tail, so a namespace
  // embedding `|sha256|` or a line terminator still decodes exactly.
  const legacy = /^(.*)\|sha256\|[0-9a-f]{64}\|\d+$/isu.exec(rest);
  return legacy === null ? undefined : legacy[1]!;
};

const legacyArtifactCacheIdentity = (key: PhaserPackCacheKey): string =>
  `${KEY_PREFIX}${key.namespace}|sha256|${key.sha256}|${key.bytes}`;

/** Return the old-form twin of one parsed v2 identity. */
const legacyTwinOfParts = (current: V2IdentityParts): string => {
  return `${KEY_PREFIX}${current.namespace}|sha256|${current.sha256}|${current.bytes}`;
};

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)!.get!;

/** Accept ArrayBuffers supplied by another same-origin realm. Keep this
 * adapter-local twin aligned with the package boundary check in
 * packages/phaser-assets/src/pack-cache.ts; the example must validate records
 * before it can call the public storage contract. */
const isArrayBuffer = (value: unknown): value is ArrayBuffer => {
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
};

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

/** Read the byte-count suffix used by the adapter's accounting marker. */
const bytesOfIdentity = (identity: string): number | undefined => {
  const suffix = /[|:](\d+)$/u.exec(identity)?.[1];
  const bytes = Number(suffix);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

/** Recognize the digest-only keys written by the retired private experiment. */
const isLegacyIdentity = (identity: string): boolean => {
  if (!identity.startsWith(KEY_PREFIX)) {
    return false;
  }
  const parts = identity.split('|');
  return parts.length === 4 && parts[1] === 'sha256';
};

/** Apply owned-record deletions and recompute the aggregate quota marker. */
const finishOwnedRecordRepair = (
  store: IDBObjectStore,
  keys: Iterable<string>,
  deleted: ReadonlySet<string>,
  markerKey?: string,
): void => {
  let remaining = 0;
  for (const key of keys) {
    if (key === USAGE_KEY || key === MIGRATION_KEY) {
      continue;
    }
    if (deleted.has(key)) {
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
        const keys = request.result.filter((key): key is string => typeof key === 'string');
        const deleted = new Set(keys.filter(
          (key) => key !== USAGE_KEY && key !== MIGRATION_KEY && shouldDelete(key),
        ));
        finishOwnedRecordRepair(store, keys, deleted, markerKey);
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

/** Remove a legacy pipe-namespace twin after a v2 copy survived a reload. */
const reconcileLegacyTwins = async (db: IDBDatabase): Promise<void> => {
  await withDeadline<void>((finish, fail, registerAbort) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    registerAbort(() => tx.abort());
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      const keys = new Set(request.result.filter((key): key is string => typeof key === 'string'));
      const candidates = [...keys].flatMap((key) => {
        const current = v2IdentityPartsOf(key);
        if (current === undefined) {
          return [];
        }
        const twin = legacyTwinOfParts(current);
        return keys.has(twin) ? [{ key, twin, current }] : [];
      });
      const deleted = new Set<string>();
      if (candidates.length === 0) {
        finish(undefined);
        return;
      }
      let pending = candidates.length;
      for (const candidate of candidates) {
        const currentRequest = store.get(candidate.key);
        currentRequest.onsuccess = () => {
          const record = currentRequest.result as CacheRecord | undefined;
          const intact = record !== undefined
            && record.schemaVersion === SCHEMA_VERSION
            && record.digest === candidate.current.sha256
            && record.bytes === candidate.current.bytes
            && isArrayBuffer(record.payload)
            && record.payload.byteLength === candidate.current.bytes;
          deleted.add(intact ? candidate.twin : candidate.key);
          pending--;
          if (pending === 0) {
            finishOwnedRecordRepair(store, keys, deleted);
          }
        };
        currentRequest.onerror = () => fail(
          currentRequest.error ?? new Error('artifact cache twin record read failed'),
        );
      }
    };
    request.onerror = () => fail(request.error ?? new Error('artifact cache twin reconciliation failed'));
    tx.oncomplete = () => finish(undefined);
    tx.onabort = () => fail(tx.error ?? new Error('artifact cache twin reconciliation aborted'));
    tx.onerror = () => undefined;
  }, 'twin-reconciliation');
};

export class ArtifactCache implements PhaserPackPersistentCache {
  private constructor(private readonly db: IDBDatabase) {}

  readonly faults: ArtifactCacheFaults = {};

  /** Open the bounded store and reconcile legacy records and identity twins. */
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
        await reconcileLegacyTwins(db);
      } catch {
        // Twin cleanup is optional; the failed transaction rolled back and
        // the next open will retry it.
      }
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

  /** Close the IndexedDB connection owned by this adapter instance. */
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
    const identity = artifactCacheIdentity(key);
    let recordIdentity = identity;
    const readValid = async (candidateIdentity: string): Promise<CacheRecord | undefined> => {
      const candidate = await this.readRecord(candidateIdentity, context.signal);
      if (candidate === null) {
        return undefined;
      }
      const valid = candidate.schemaVersion === SCHEMA_VERSION
        && candidate.digest === key.sha256
        && candidate.bytes === key.bytes
        && isArrayBuffer(candidate.payload)
        && candidate.payload.byteLength === key.bytes;
      if (!valid) {
        await this.deleteRecord(candidateIdentity, context.signal);
        return undefined;
      }
      return candidate;
    };
    let record = await readValid(identity);
    if (record === undefined && usesV2Identity(key)) {
      recordIdentity = legacyArtifactCacheIdentity(key);
      record = await readValid(recordIdentity);
    }
    context.signal?.throwIfAborted();
    if (record === undefined) {
      return undefined;
    }
    if (recordIdentity !== identity) {
      // Keep a valid legacy hit usable even if migration fails. A successful
      // copy replaces the legacy twin atomically, so usage stays size-neutral
      // and cache reuse never depends on the migration completing.
      try {
        await this.storeRecord(
          { sha256: key.sha256, bytes: key.bytes },
          identity,
          record.payload,
          context.signal,
          recordIdentity,
        );
      } catch (error) {
        context.signal?.throwIfAborted();
        console.warn('Artifact cache legacy migration failed; retaining the legacy record', error);
      }
    }
    return record.payload;
  }

  /** Persist one verified artifact or reject with a bounded store failure. */
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

  /** Delete one public identity and report whether a record existed. */
  async delete(key: PhaserPackCacheKey, context: PhaserPackCacheContext = {}): Promise<boolean> {
    context.signal?.throwIfAborted();
    const identities = [artifactCacheIdentity(key)];
    if (usesV2Identity(key)) {
      identities.push(legacyArtifactCacheIdentity(key));
    }
    const removed = await this.deleteRecords(identities, context.signal);
    context.signal?.throwIfAborted();
    return removed;
  }

  /** Remove only records belonging to one public namespace. */
  async clear(namespace: string, context: PhaserPackCacheContext = {}): Promise<void> {
    context.signal?.throwIfAborted();
    await repairOwnedRecords(
      this.db,
      (identity) => namespaceOfIdentity(identity) === namespace,
      'clear',
      context.signal,
    );
    context.signal?.throwIfAborted();
  }

  /** Recompute public usage from owned identity keys. */
  async usage(namespace: string, context: PhaserPackCacheContext = {}): Promise<PhaserPackCacheUsage> {
    context.signal?.throwIfAborted();
    const usage = await withDeadline<PhaserPackCacheUsage>((finish, fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      registerAbort(() => tx.abort());
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        let records = 0;
        let totalBytes = 0;
        for (const key of request.result) {
          if (typeof key !== 'string' || namespaceOfIdentity(key) !== namespace) {
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
    return withDeadline<CacheRecord | null>(
      (finish, fail, registerAbort) => {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        registerAbort(() => tx.abort());
        const request = tx.objectStore(STORE_NAME).get(identity);
        request.onsuccess = () => finish(request.result ?? null);
        request.onerror = () => fail(request.error ?? new Error('artifact cache read failed'));
      },
      'read',
      signal,
    );
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
    replacedIdentity?: string,
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
        // same size and adds no usage. A legacy-to-v2 migration can replace
        // its twin atomically, so the same transaction counts both records
        // before writing the new usage marker.
        const existingRequest = store.count(identity);
        existingRequest.onsuccess = () => {
          const replacementRequest = replacedIdentity !== undefined && replacedIdentity !== identity
            ? store.count(replacedIdentity)
            : undefined;
          const commit = (): void => {
            const existing = existingRequest.result > 0;
            const replacement = (replacementRequest?.result ?? 0) > 0;
            let delta: number;
            if (existing && replacement) {
              // Two counted records collapse into one; drop the twin's bytes.
              delta = -artifact.bytes;
            } else if (existing || replacement) {
              delta = 0;
            } else {
              delta = artifact.bytes;
            }
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
            if (replacement && replacedIdentity !== undefined) {
              store.delete(replacedIdentity);
            }
            store.put({ total: Math.max(0, total + delta) }, USAGE_KEY);
          };
          if (replacementRequest === undefined) {
            commit();
          } else {
            replacementRequest.onsuccess = commit;
            replacementRequest.onerror = () => tx.abort();
          }
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

  /** Delete a public identity and any legacy twin in one transaction. */
  private deleteRecords(identities: readonly string[], signal?: AbortSignal): Promise<boolean> {
    const owned = [...new Set(identities.filter(
      (identity) => identity.startsWith(KEY_PREFIX)
        && identity !== USAGE_KEY && identity !== MIGRATION_KEY,
    ))];
    if (owned.length === 0) {
      return Promise.resolve(false);
    }
    return withDeadline<boolean>((finish, fail, registerAbort) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      registerAbort(() => tx.abort());
      const store = tx.objectStore(STORE_NAME);
      const usageRequest = store.get(USAGE_KEY);
      let existed = false;
      usageRequest.onsuccess = () => {
        const usage = usageRequest.result as { total: number } | undefined;
        const requests = owned.map((identity) => ({ identity, request: store.count(identity) }));
        let pending = requests.length;
        const finishCounts = (): void => {
          if (--pending !== 0) {
            return;
          }
          let removedBytes = 0;
          for (const { identity, request } of requests) {
            if (request.result > 0) {
              existed = true;
              removedBytes += bytesOfIdentity(identity) ?? 0;
            }
            store.delete(identity);
          }
          if (existed) {
            if (usage === undefined) {
              const allKeys = store.getAllKeys();
              allKeys.onsuccess = () => {
                let remaining = 0;
                for (const key of allKeys.result) {
                  if (typeof key === 'string' && key.startsWith(KEY_PREFIX)
                    && key !== USAGE_KEY && key !== MIGRATION_KEY && !owned.includes(key)) {
                    remaining += bytesOfIdentity(key) ?? 0;
                  }
                }
                store.put({ total: remaining }, USAGE_KEY);
              };
              allKeys.onerror = () => fail(allKeys.error ?? new Error('artifact cache usage repair failed'));
            } else {
              store.put({ total: Math.max(0, usage.total - removedBytes) }, USAGE_KEY);
            }
          }
        };
        for (const { request } of requests) {
          request.onsuccess = finishCounts;
          request.onerror = () => fail(request.error ?? new Error('artifact cache delete failed'));
        }
      };
      usageRequest.onerror = () => fail(usageRequest.error ?? new Error('artifact cache delete failed'));
      tx.oncomplete = () => finish(existed);
      tx.onabort = () => fail(tx.error ?? new Error('artifact cache delete aborted'));
      tx.onerror = () => undefined;
    }, 'delete-many', signal);
  }
}

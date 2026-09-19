/**
 * Private experiment: persist verified artifact bytes in IndexedDB and
 * re-serve them to the existing public delivery through managed Blob
 * URLs. This module is example-only scaffolding for the reuse
 * acceptance — it is deliberately NOT a public cache API (that comes in
 * a later PR, wired at the acquisition boundary instead of Blob URLs).
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

/** Finite limits: a single object and the total retained bytes are both
 * capped; over-cap stores are skipped explicitly, never silently. No
 * LRU/GC/pin policy exists in this experiment. */
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
/** Every DB operation is bounded; the web platform offers no request
 * deadlines here, so a late timer resolves the whole session to
 * 'unavailable' and the origin path takes over. */
const IO_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 8_000;

const DB_NAME = 'mpgd-asset-pack-experiment';
const STORE_NAME = 'artifacts';
/** Records owned by this experiment live under this prefix; anything
 * else in the store belongs to other data and is never touched. */
const KEY_PREFIX = 'mpgd-asset-experiment|';
const USAGE_KEY = KEY_PREFIX + '__usage__';
const SCHEMA_VERSION = 1;

/** One artifact to warm, derived from the CURRENT manifest (digest,
 * bytes, media type) plus its once-encoded delivery path. */
export interface WarmArtifact {
  /** Manifest artifact path, already URL-encoded exactly once. */
  readonly encodedPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  /** Absolute origin URL used on a cache miss. */
  readonly originUrl: string;
}

/** Why this artifact resolved the way it did. 'unavailable' means the
 * cache store could not be used at all (open failure/timeout) — a
 * distinct condition from a miss, a corrupt record or a store failure. */
export type WarmOutcome =
  | 'cache-hit'
  | 'origin-stored'
  | 'origin-store-failed'
  | 'origin-store-skipped'
  | 'cache-unavailable'
  /** The experiment's own acquisition failed; no Blob URL exists and
   * the delivery's own origin fetch (with its retries and limits) owns
   * the outcome. Local acquisition failure and delivery failure stay
   * separate conditions. */
  | 'origin-fetch-failed';

export interface WarmEntry {
  readonly encodedPath: string;
  readonly identity: string;
  readonly outcome: WarmOutcome;
  readonly bodyBytes: number;
  readonly cacheReadMs: number | null;
  readonly verifyMs: number | null;
  readonly fetchMs: number | null;
  readonly writeMs: number | null;
  readonly blobMs: number;
}

export interface WarmReport {
  readonly entries: readonly WarmEntry[];
  readonly hits: number;
  readonly stored: number;
  readonly failures: number;
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
  readonly mediaType: string;
  readonly storedAt: number;
  readonly payload: ArrayBuffer;
}

const identityOf = (artifact: { readonly sha256: string; readonly bytes: number }): string =>
  `${KEY_PREFIX}sha256|${artifact.sha256}|${artifact.bytes}`;

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** A bounded promise wrapper: DB work must never hang the prepare. */
const withDeadline = async <T>(operation: (finish: (value: T) => void) => void, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`artifact cache ${label} timed out`)), IO_TIMEOUT_MS);
      operation((value) => resolve(value));
    });
  } finally {
    clearTimeout(timer);
  }
};

export class ArtifactCache {
  private constructor(private readonly db: IDBDatabase) {}

  /** Blob URLs for the current selection; revoked wholesale on the next
   * warm, unload or shutdown. The URL is never the data identity — the
   * content digest is. */
  private readonly urls = new Map<string, string>();
  readonly stats: WarmEntry[] = [];
  readonly faults: ArtifactCacheFaults = {};

  static async open(): Promise<ArtifactCache | 'unavailable'> {
    if (typeof indexedDB === 'undefined') {
      return 'unavailable';
    }
    try {
      const db = await withDeadline<IDBDatabase>((finish) => {
        const request = indexedDB.open(DB_NAME);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => finish(request.result);
        request.onerror = () => request.transaction?.abort() ?? undefined;
        request.onblocked = () => undefined;
      }, 'open');
      // A version bump elsewhere closes our handle promptly; later
      // operations fail into 'unavailable' rather than hanging.
      db.onversionchange = () => db.close();
      return new ArtifactCache(db);
    } catch {
      return 'unavailable';
    }
  }

  /** Synchronous Blob URL lookup for the delivery's resolveURL: every
   * mapping was prepared by a completed warm() in the async phase. */
  resolve(encodedPath: string): string | undefined {
    return this.urls.get(encodedPath);
  }

  /** Drop every Blob URL for the finished/cancelled selection. */
  revokeAll(): void {
    for (const url of this.urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }

  close(): void {
    this.revokeAll();
    this.db.close();
  }

  /** Warm the current selection: cache lookups, verification, origin
   * fetches for misses, bounded stores. Sequential by design — the
   * experiment measures per-artifact costs without interleaving. */
  async warm(artifacts: readonly WarmArtifact[]): Promise<WarmReport> {
    const entries: WarmEntry[] = [];
    for (const artifact of artifacts) {
      // Per-artifact isolation: one failed acquisition never blocks the
      // rest of the closure from warming or the delivery from running.
      try {
        entries.push(await this.warmOne(artifact));
      } catch {
        entries.push({
          encodedPath: artifact.encodedPath,
          identity: identityOf(artifact),
          outcome: 'origin-fetch-failed',
          bodyBytes: 0,
          cacheReadMs: null,
          verifyMs: null,
          fetchMs: null,
          writeMs: null,
          blobMs: 0,
        });
      }
    }
    return {
      entries,
      hits: entries.filter((entry) => entry.outcome === 'cache-hit').length,
      stored: entries.filter((entry) => entry.outcome === 'origin-stored').length,
      failures: entries.filter(
        (entry) => entry.outcome === 'origin-store-failed' || entry.outcome === 'cache-unavailable',
      ).length,
    };
  }

  private async warmOne(artifact: WarmArtifact): Promise<WarmEntry> {
    const identity = identityOf(artifact);
    const blobStart = performance.now();
    const makeBlobUrl = (data: ArrayBuffer): string => {
      const blob = new Blob([data], { type: artifact.mediaType });
      const url = URL.createObjectURL(blob);
      this.urls.set(artifact.encodedPath, url);
      return url;
    };
    // The store session itself can fail late (versionchange, quota
    // surfaced at open): reads degrade to unavailable, never to a hit.
    if (this.faults.dbUnavailableOnce) {
      this.faults.dbUnavailableOnce = false;
      const fetchStarted = performance.now();
      const data = await this.fetchOrigin(artifact);
      const fetchMs = performance.now() - fetchStarted;
      makeBlobUrl(data);
      return {
        encodedPath: artifact.encodedPath, identity, outcome: 'cache-unavailable',
        bodyBytes: data.byteLength, cacheReadMs: null, verifyMs: null, fetchMs, writeMs: null,
        blobMs: performance.now() - blobStart - fetchMs,
      };
    }
    const readStarted = performance.now();
    const record = await this.readRecord(identity);
    const cacheReadMs = performance.now() - readStarted;
    if (record !== null) {
      // Cache hits are re-verified against the CURRENT manifest before
      // use: size and digest mismatches are corrupt records, not data.
      const verifyStarted = performance.now();
      const digest = await sha256Hex(record.payload);
      const verifyMs = performance.now() - verifyStarted;
      if (record.bytes === artifact.bytes && record.digest === artifact.sha256 && digest === artifact.sha256) {
        makeBlobUrl(record.payload);
        this.stats.push({
          encodedPath: artifact.encodedPath, identity, outcome: 'cache-hit',
          bodyBytes: record.payload.byteLength, cacheReadMs, verifyMs, fetchMs: null, writeMs: null,
          blobMs: performance.now() - blobStart - cacheReadMs - verifyMs,
        });
        return this.stats[this.stats.length - 1]!;
      }
      // Corrupt record: never served; removed best-effort so the next
      // warm stores fresh bytes instead of re-reading corruption.
      await this.deleteRecord(identity);
    }
    const fetchStarted = performance.now();
    const data = await this.fetchOrigin(artifact);
    const fetchMs = performance.now() - fetchStarted;
    makeBlobUrl(data);
    const writeStarted = performance.now();
    const outcome = await this.storeRecord(artifact, identity, data);
    const writeMs = performance.now() - writeStarted;
    const entry: WarmEntry = {
      encodedPath: artifact.encodedPath, identity, outcome,
      bodyBytes: data.byteLength, cacheReadMs, verifyMs: null, fetchMs, writeMs,
      blobMs: performance.now() - blobStart - fetchMs - writeMs,
    };
    this.stats.push(entry);
    return entry;
  }

  /** Miss acquisition keeps the delivery's disciplines: finite size cap
   * and a request deadline. The delivery re-verifies whatever this
   * returns — storing never bypasses integrity checks. */
  private async fetchOrigin(artifact: WarmArtifact): Promise<ArrayBuffer> {
    if (artifact.bytes > MAX_OBJECT_BYTES) {
      throw new Error(`artifact exceeds the cache object cap: ${artifact.bytes}`);
    }
    const response = await fetch(artifact.originUrl, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`artifact fetch failed with HTTP ${response.status}`);
    }
    const data = await response.arrayBuffer();
    const digest = await sha256Hex(data);
    if (data.byteLength !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error('artifact bytes failed manifest verification at acquisition');
    }
    return data;
  }

  private readRecord(identity: string): Promise<CacheRecord | null> {
    return withDeadline<CacheRecord | null>((finish) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(identity);
      request.onsuccess = () => finish(request.result ?? null);
      request.onerror = () => finish(null);
    }, 'read');
  }

  /** Short readwrite transaction: bytes are already fetched and verified
   * above, so the commit itself never waits on network or crypto. The
   * stored marker requires the transaction's complete event — a request
   * onsuccess alone is not a commit. An abort (fault or quota) leaves
   * the previous good record untouched. */
  private async storeRecord(
    artifact: WarmArtifact,
    identity: string,
    data: ArrayBuffer,
  ): Promise<Exclude<WarmOutcome, 'cache-hit'>> {
    if (artifact.bytes > MAX_OBJECT_BYTES) {
      return 'origin-store-skipped';
    }
    return withDeadline<Exclude<WarmOutcome, 'cache-hit'>>((finish) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const usageRequest = store.get(USAGE_KEY);
      usageRequest.onsuccess = () => {
        const usage = usageRequest.result as { total: number } | undefined;
        const total = usage?.total ?? 0;
        if (total + artifact.bytes > MAX_TOTAL_BYTES) {
          finish('origin-store-skipped');
          tx.abort();
          return;
        }
        const record: CacheRecord = {
          schemaVersion: SCHEMA_VERSION,
          digest: artifact.sha256,
          bytes: artifact.bytes,
          // Informational only: readers always take media types from the
          // current manifest, never from this record.
          mediaType: artifact.mediaType,
          storedAt: Date.now(),
          payload: data,
        };
        const put = store.put(record, identity);
        if (this.faults.failPutOnce) {
          this.faults.failPutOnce = false;
          put.addEventListener('error', () => {
            /* the transaction aborts below via the error default path */
          });
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
        store.put({ total: total + artifact.bytes }, USAGE_KEY);
      };
      tx.oncomplete = () => {
        if (this.faults.abortCommitOnce) {
          // Too late to abort a completed transaction; the fault fires
          // before completion in the abort path below instead.
        }
        finish('origin-stored');
      };
      tx.onabort = () => finish(this.faults.abortCommitOnce ? 'origin-store-failed' : 'origin-store-failed');
      tx.onerror = () => undefined;
      if (this.faults.abortCommitOnce) {
        this.faults.abortCommitOnce = false;
        queueMicrotask(() => tx.abort());
      }
    }, 'write');
  }

  /** Remove one record (corrupt cleanup, explicit deletion tests). Only
   * keys under the experiment prefix are ever touched. */
  async deleteRecord(identity: string): Promise<boolean> {
    if (!identity.startsWith(KEY_PREFIX) || identity === USAGE_KEY) {
      return false;
    }
    return withDeadline<boolean>((finish) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const usageRequest = store.get(USAGE_KEY);
      usageRequest.onsuccess = () => {
        const usage = usageRequest.result as { total: number } | undefined;
        const recordRequest = store.get(identity);
        recordRequest.onsuccess = () => {
          const record = recordRequest.result as CacheRecord | undefined;
          if (record !== undefined) {
            const total = Math.max(0, (usage?.total ?? record.bytes) - record.bytes);
            store.put({ total }, USAGE_KEY);
          }
          store.delete(identity);
        };
      };
      tx.oncomplete = () => finish(true);
      tx.onabort = () => finish(false);
      tx.onerror = () => undefined;
    }, 'delete');
  }

  /** Count experiment-owned records and their retained bytes. */
  async usage(): Promise<{ records: number; totalBytes: number }> {
    return withDeadline<{ records: number; totalBytes: number }>((finish) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const records = (request.result as CacheRecord[]).filter(
          (record) => typeof record.digest === 'string' && typeof record.payload?.byteLength === 'number',
        );
        finish({
          records: records.length,
          totalBytes: records.reduce((sum, record) => sum + (record.payload?.byteLength ?? 0), 0),
        });
      };
      request.onerror = () => finish({ records: -1, totalBytes: -1 });
    }, 'usage');
  }
}

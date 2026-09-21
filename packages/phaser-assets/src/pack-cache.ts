import { digestOf } from './archive-digest.js';

/** Stable identity for one verified original artifact. Paths and URLs are
 * deliberately absent: a signed URL or CDN hostname must not create a new
 * copy of the same manifest-declared bytes. */
export interface PhaserPackCacheKey {
  readonly namespace: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Cache operations receive the active loader/delivery signal. Implementors
 * must stop waiting and avoid committing work after it is aborted. */
export interface PhaserPackCacheContext {
  readonly signal?: AbortSignal;
}

/** Storage supplied by an application. The package never imports IndexedDB,
 * filesystem APIs or a platform SDK; applications own the persistence
 * policy and lifecycle. */
export interface PhaserPackPersistentCache {
  /** Return a defensive snapshot of the stored bytes, or undefined on miss. */
  get(key: PhaserPackCacheKey, context?: PhaserPackCacheContext): Promise<ArrayBuffer | undefined>;
  /** Persist a verified original artifact. Reject on quota or storage failure. */
  put(key: PhaserPackCacheKey, bytes: ArrayBuffer, context?: PhaserPackCacheContext): Promise<void>;
  /** Delete one identity. Returns whether an entry was removed. */
  delete(key: PhaserPackCacheKey, context?: PhaserPackCacheContext): Promise<boolean>;
  /** Delete only entries owned by one namespace. */
  clear(namespace: string, context?: PhaserPackCacheContext): Promise<void>;
  /** Return usage for one namespace, excluding other applications' entries. */
  usage(namespace: string, context?: PhaserPackCacheContext): Promise<PhaserPackCacheUsage>;
}

export interface PhaserPackCacheUsage {
  readonly records: number;
  readonly totalBytes: number;
}

/** Injection and observation options shared by the direct loader and
 * prepared delivery APIs. */
export interface PhaserPackPersistentCacheOptions {
  readonly storage: PhaserPackPersistentCache;
  readonly namespace: string;
  readonly onEvent?: (event: PhaserPackCacheEvent) => void;
}

/** Shared runtime validation for both public acquisition entry points. */
export function assertPhaserPackPersistentCacheOptions(
  value: unknown,
  message: string,
): asserts value is PhaserPackPersistentCacheOptions | undefined {
  if (value === undefined) {
    return;
  }
  const candidate = value as Partial<PhaserPackPersistentCacheOptions>;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(message);
  }
  const storage = candidate.storage as Partial<PhaserPackPersistentCache> | undefined;
  if (typeof candidate.namespace !== 'string' || candidate.namespace.length === 0
    || !storage || typeof storage.get !== 'function'
    || typeof storage.put !== 'function'
    || typeof storage.delete !== 'function'
    || typeof storage.clear !== 'function'
    || typeof storage.usage !== 'function'
    || (candidate.onEvent !== undefined && typeof candidate.onEvent !== 'function')) {
    throw new Error(message);
  }
}

export type PhaserPackCacheArtifactKind = 'file' | 'archive';

export type PhaserPackCacheEventOutcome =
  | 'cache-hit'
  | 'cache-read-failed'
  | 'cache-corrupt'
  | 'cache-unverifiable'
  | 'cache-delete-failed'
  | 'origin-download'
  | 'cache-store-failed';

/** Cache telemetry contains logical identities and pack context, never URLs.
 * A cache hit reports storage reuse only; it is emitted before the existing
 * loader/decoder verification and texture preparation. */
export interface PhaserPackCacheEvent {
  readonly kind: PhaserPackCacheArtifactKind;
  readonly outcome: PhaserPackCacheEventOutcome;
  readonly key: PhaserPackCacheKey;
  readonly packId: string;
  readonly revision: string;
  readonly assetKey?: string;
  readonly role?: string;
  readonly error?: unknown;
}

export interface PhaserPackCacheArtifactContext {
  readonly kind: PhaserPackCacheArtifactKind;
  readonly packId: string;
  readonly revision: string;
  readonly assetKey?: string;
  readonly role?: string;
}

/** Build the public identity used by both files and ZIP archive acquisition. */
export function createPhaserPackCacheKey(
  namespace: string,
  integrity: { readonly bytes: number; readonly sha256: string },
): PhaserPackCacheKey {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('Asset pack cache namespace must be a non-empty string');
  }
  if (!Number.isSafeInteger(integrity.bytes) || integrity.bytes <= 0
    || typeof integrity.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(integrity.sha256)) {
    throw new Error('Asset pack cache identity requires a positive byte count and SHA-256 digest');
  }
  return {
    namespace,
    bytes: integrity.bytes,
    sha256: integrity.sha256.toLowerCase(),
  };
}

const abortReason = (signal: AbortSignal): unknown => signal.reason
  ?? new DOMException('The operation was aborted', 'AbortError');

/** Await a storage call without allowing an implementation that ignores the
 * signal to hold a delivery or loader operation past its deadline. The
 * rejection handler remains attached so a late provider rejection is not
 * left unhandled. */
const awaitCacheOperation = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      // Keep a late provider rejection handled even on this early exit.
      operation.catch((): void => undefined);
      onAbort();
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });

const emit = (
  options: PhaserPackPersistentCacheOptions,
  artifact: PhaserPackCacheArtifactContext,
  key: PhaserPackCacheKey,
  outcome: PhaserPackCacheEventOutcome,
  error?: unknown,
): void => {
  try {
    options.onEvent?.({
      ...artifact,
      key,
      outcome,
      ...(error === undefined ? {} : { error }),
    });
  } catch {
    // Cache observation is diagnostic only and must never change delivery.
  }
};

const verificationOf = async (
  bytes: ArrayBuffer,
  key: PhaserPackCacheKey,
  signal: AbortSignal,
): Promise<'verified' | 'mismatch' | 'unverifiable'> => {
  signal.throwIfAborted();
  if (bytes.byteLength !== key.bytes) {
    return 'mismatch';
  }
  try {
    return (await digestOf(new Uint8Array(bytes))) === key.sha256 ? 'verified' : 'mismatch';
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    // The loader or ZIP decoder owns the authoritative verification. If the
    // optional cache cannot verify in this environment, use origin and keep
    // the default failure behavior at that existing boundary.
    return 'unverifiable';
  }
};

export interface PhaserPackArtifactRead {
  readonly bytes: ArrayBuffer;
  /** Commit only after the caller's authoritative verification succeeds. */
  readonly commit?: (verified: boolean, options?: PhaserPackArtifactCommitOptions) => Promise<void>;
}

export interface PhaserPackArtifactCommitOptions {
  /** The caller no longer needs the origin buffer after verification. */
  readonly transferOwnership?: boolean;
}

/** Adapt a deferred artifact commit to the file-body persistence hook. */
export const commitCacheOf = (
  read: PhaserPackArtifactRead,
): { readonly commitCache: () => Promise<void> } | Record<string, never> => {
  const commit = read.commit;
  if (commit === undefined) {
    return {};
  }
  return {
    commitCache: () => commit(true, { transferOwnership: true }),
  };
};

export interface PhaserPackArtifactReadOptions {
  readonly persistentCache?: PhaserPackPersistentCacheOptions | undefined;
  readonly integrity?: { readonly bytes: number; readonly sha256: string } | undefined;
  readonly artifact: PhaserPackCacheArtifactContext;
  readonly signal: AbortSignal;
  /** Signal for a deferred store after the read signal's scope ends. */
  readonly commitSignal?: AbortSignal | undefined;
  readonly fetchOrigin: () => Promise<ArrayBuffer>;
}

/** Read-through helper used at the original file/archive acquisition
 * boundary. Cache errors and invalid records degrade to origin; only the
 * active cancellation/deadline is allowed to abort the caller. The deferred
 * variant lets the existing loader/decoder verify origin bytes before the
 * optional store commit. */
export async function readPhaserPackArtifactWithCommit(
  options: PhaserPackArtifactReadOptions,
): Promise<PhaserPackArtifactRead> {
  const persistent = options.persistentCache;
  const integrity = options.integrity;
  if (persistent === undefined || integrity === undefined) {
    return { bytes: await options.fetchOrigin() };
  }
  const key = createPhaserPackCacheKey(persistent.namespace, integrity);
  let cached: ArrayBuffer | undefined;
  try {
    options.signal.throwIfAborted();
    cached = await awaitCacheOperation(
      persistent.storage.get(key, { signal: options.signal }),
      options.signal,
    );
  } catch (error) {
    if (options.signal.aborted) {
      throw error;
    }
    emit(persistent, options.artifact, key, 'cache-read-failed', error);
  }
  if (cached !== undefined && !(cached instanceof ArrayBuffer)) {
    emit(
      persistent,
      options.artifact,
      key,
      'cache-read-failed',
      new Error('Persistent cache returned a non-ArrayBuffer record'),
    );
    cached = undefined;
  }
  if (cached !== undefined) {
    const cachedVerification = await verificationOf(cached, key, options.signal);
    if (cachedVerification === 'verified') {
      options.signal.throwIfAborted();
      emit(persistent, options.artifact, key, 'cache-hit');
      return { bytes: cached };
    }
    if (cachedVerification === 'unverifiable') {
      options.signal.throwIfAborted();
      // Keep the record: it may be valid and become usable again when this
      // environment can verify SHA-256. This intentionally retries the
      // diagnostic path rather than destructively discarding good bytes.
      emit(persistent, options.artifact, key, 'cache-unverifiable');
    } else {
      const invalid = new Error('Persistent asset cache record failed manifest verification');
      options.signal.throwIfAborted();
      emit(persistent, options.artifact, key, 'cache-corrupt', invalid);
      try {
        options.signal.throwIfAborted();
        await awaitCacheOperation(
          persistent.storage.delete(key, { signal: options.signal }),
          options.signal,
        );
      } catch (error) {
        if (options.signal.aborted) {
          throw error;
        }
        emit(persistent, options.artifact, key, 'cache-delete-failed', error);
      }
    }
  }

  const origin = await options.fetchOrigin();
  options.signal.throwIfAborted();
  emit(persistent, options.artifact, key, 'origin-download');
  return {
    bytes: origin,
    commit: async (
      verified: boolean,
      commitOptions: PhaserPackArtifactCommitOptions = {},
    ): Promise<void> => {
      if (!verified) {
        return;
      }
      const commitSignal = options.commitSignal ?? options.signal;
      try {
        // A provider must not retain or mutate the buffer used by the caller.
        commitSignal.throwIfAborted();
        const payload = commitOptions.transferOwnership === true
          ? origin
          : origin.slice(0);
        await awaitCacheOperation(
          persistent.storage.put(key, payload, { signal: commitSignal }),
          commitSignal,
        );
      } catch (error) {
        if (commitSignal.aborted) {
          throw error;
        }
        emit(persistent, options.artifact, key, 'cache-store-failed', error);
      }
    },
  };
}

/** Compatibility wrapper for callers that do not have a later authoritative
 * verification boundary. */
export async function readPhaserPackArtifact(
  options: PhaserPackArtifactReadOptions,
): Promise<ArrayBuffer> {
  const result = await readPhaserPackArtifactWithCommit(options);
  if (result.commit === undefined) {
    return result.bytes;
  }
  // commit is only defined when both cache options and integrity were present.
  const key = createPhaserPackCacheKey(options.persistentCache!.namespace, options.integrity!);
  await result.commit((await verificationOf(result.bytes, key, options.signal)) === 'verified');
  return result.bytes;
}

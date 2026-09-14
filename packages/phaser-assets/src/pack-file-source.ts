import { fetchPackFile } from './pack-fetch.js';
/** Optional verification of encoded file bytes, before browser decoding. */
export interface PhaserPackFileIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}
/** Which manifest slot a requested file fills; atlas assets request both roles. */
export type PhaserPackFileRole = 'texture' | 'atlas';
/** One file the loader wants from a source. Logical identity, never a transfer URL. */
export interface PhaserPackFileRequest {
  readonly packId: string;
  readonly revision: string;
  readonly assetKey: string;
  readonly role: PhaserPackFileRole;
  /** The original manifest file reference, before any location resolution. */
  readonly url: string;
  /** Verification the loader applies to the returned bytes after reading. */
  readonly integrity?: PhaserPackFileIntegrity | undefined;
}
/** Weighted preparation budgets shared with the loader's own reservations. */
export interface PhaserPackFileBudgets {
  /** One permit per concurrent file transfer; hold it for the whole transfer. */
  readonly transfers: {
    acquire(signal: AbortSignal): Promise<() => void>;
  };
  /** Encoded-byte budget the loader also reserves declared asset sizes from. */
  readonly bytes: {
    acquire(weight: number, signal: AbortSignal): Promise<() => void>;
  };
}
/** Cancellation and shared preparation budgets for one asset preparation. */
export interface PhaserPackFileContext {
  /** Aborts with caller cancellation or the asset's preparation deadline. */
  readonly signal: AbortSignal;
  readonly budgets: PhaserPackFileBudgets;
}
/** File bytes handed to the loader, with an explicit return. */
export interface PhaserPackFileBody {
  /** Encoded file body as the platform delivered it to the application. */
  readonly bytes: Blob;
  /** Return the bytes after decoding/parsing; registered textures survive. */
  release(): void;
}
/** Source-side ownership of one file, acquired before its body transfer. */
export interface PhaserPackOpenedFile {
  /** Transfer the body. Runs only after the loader approved the byte budget. */
  read(): Promise<PhaserPackFileBody>;
  /** Return source ownership once read settled or was abandoned. Cancellation
   * of an in-flight read flows through the context signal, not through close. */
  close(): void;
}
/**
 * Supplies encoded pack files. Sources identify, locate and return file bytes;
 * they never initialize scene.load or register textures. Key shared work on
 * `{ packId, revision, assetKey, role }`; temporary blob or expirable URLs must
 * not become logical identity.
 */
export interface PhaserPackFileSource {
  /** Acquire ownership of one file. Must not transfer its body. */
  open(request: PhaserPackFileRequest, context: PhaserPackFileContext): Promise<PhaserPackOpenedFile>;
}
/** Default URL transport: one HTTP request per file through the shared budgets. */
export function createPackUrlFileSource(transport: {
  readonly resolveURL: (url: string, context: {
    readonly packId: string;
    readonly revision: string;
  }) => string;
  readonly retries: number;
  readonly requestTimeoutMs: number;
  readonly requestCache: RequestCache;
  readonly maxFileBytes: number;
}): PhaserPackFileSource {
  const { resolveURL, retries, requestTimeoutMs, requestCache, maxFileBytes } = transport;
  return {
    async open(request, context) {
      // Ownership is just the resolved request; the body transfer waits for read().
      // Closing revokes that ownership even if a caller left a read in flight.
      const closeController = new AbortController();
      const signal = AbortSignal.any([context.signal, closeController.signal]);
      let readStarted = false;
      return {
        async read() {
          if (readStarted) {
            throw new Error('Pack file body was already read');
          }
          readStarted = true;
          const releaseTransfer = await context.budgets.transfers.acquire(signal);
          try {
            const blob = await fetchPackFile(
              resolveURL(request.url, {
                packId: request.packId, revision: request.revision,
              }),
              {
                signal,
                retries,
                requestTimeoutMs,
                maxFileBytes,
                cache: requestCache,
                declaredBytes: request.integrity?.bytes,
              },
            );
            // Fetched Blobs need no source-side storage, so release is a no-op.
            return {
              bytes: blob, release() {
              },
            };
          } finally {
            releaseTransfer();
          }
        },
        close() {
          closeController.abort();
        },
      };
    },
  };
}

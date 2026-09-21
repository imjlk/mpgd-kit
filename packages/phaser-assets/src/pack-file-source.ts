import {
  commitCacheOf,
  readPhaserPackArtifactWithCommit,
  type PhaserPackPersistentCacheOptions,
} from './pack-cache.js';
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
  /** Optional manifest or catalog hint used to preserve Blob.type on cache hits. */
  readonly mediaType?: string | undefined;
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
  /** Optional persistence commit, called after the loader verifies the body. */
  readonly commitCache?: () => Promise<void>;
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
  /** Optional verified persistent storage for files with integrity metadata. */
  readonly persistentCache?: PhaserPackPersistentCacheOptions | undefined;
}): PhaserPackFileSource {
  const {
    resolveURL, retries, requestTimeoutMs, requestCache, maxFileBytes, persistentCache,
  } = transport;
  return {
    async open(request, context) {
      // Ownership is just the resolved request; the body transfer waits for
      // read(). A completed read is single-use; a failed one stays retryable.
      let readLatched = false;
      return {
        async read() {
          if (readLatched) {
            throw new Error('Pack file body was already read');
          }
          readLatched = true;
          try {
            const fetchBlob = async (): Promise<Blob> => {
              const releaseTransfer = await context.budgets.transfers.acquire(context.signal);
              try {
                return await fetchPackFile(
                  resolveURL(request.url, {
                    packId: request.packId, revision: request.revision,
                  }),
                  {
                    signal: context.signal,
                    retries,
                    requestTimeoutMs,
                    maxFileBytes,
                    cache: requestCache,
                    declaredBytes: request.integrity?.bytes,
                  },
                );
              } finally {
                releaseTransfer();
              }
            };
            if (persistentCache === undefined || request.integrity === undefined
              || request.integrity.bytes > maxFileBytes) {
              return {
                bytes: await fetchBlob(), release() {
                },
              };
            }
            // Cache hits cannot observe the HTTP content type; prefer a
            // manifest/catalog media type threaded through the request.
            // Unknown texture extensions intentionally fall back to
            // application/octet-stream on hits because the cache stores only
            // bytes and the authoritative loader sniffs the content.
            const originType = request.mediaType ?? 'application/octet-stream';
            let originBlob: Blob | undefined;
            const read = await readPhaserPackArtifactWithCommit({
              persistentCache,
              integrity: request.integrity,
              artifact: {
                kind: 'file',
                packId: request.packId,
                revision: request.revision,
                assetKey: request.assetKey,
                role: request.role,
              },
              signal: context.signal,
              commitSignal: context.signal,
              fetchOrigin: async (): Promise<ArrayBuffer> => {
                originBlob = await fetchBlob();
                return originBlob.arrayBuffer();
              },
            });
            const bytes = read.bytes;
            // Reuse the fetched Blob on an origin miss; only cache hits need
            // a reconstructed Blob from the stored bytes.
            return {
              bytes: originBlob ?? new Blob([bytes], { type: originType }), release() {
              },
              ...commitCacheOf(read),
            };
          } catch (error) {
            readLatched = false;
            throw error;
          }
        },
        close() {
        },
      };
    },
  };
}

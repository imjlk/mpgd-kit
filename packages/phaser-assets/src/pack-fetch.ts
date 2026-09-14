import type { PhaserPackFileIntegrity } from './packs.js';
class FileFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
/** Internal bounded transport. Never include URLs (possibly signed) in errors. */
export async function fetchPackFile(url: string, options: {
  signal: AbortSignal;
  retries: number;
  maxFileBytes: number;
  requestTimeoutMs?: number;
  cache?: RequestCache;
  integrity?: PhaserPackFileIntegrity | undefined;
}): Promise<Blob> {
  const { signal, integrity } = options;
  signal.throwIfAborted();
  if (integrity && integrity.bytes > options.maxFileBytes) {
    throw new FileFailure('Declared file exceeds byte limit');
  }
  if (integrity && !globalThis.crypto?.subtle) {
    throw new FileFailure('Asset integrity requires HTTPS or localhost');
  }
  for (let attempt = 0; ; attempt++) {
    let retryAfterMs = 0;
    const attemptController = new AbortController();
    const cancelAttempt = (): void => attemptController.abort(signal.reason);
    signal.addEventListener('abort', cancelAttempt, {
      once: true,
    });
    const timer = setTimeout(
      () => attemptController.abort(new FileFailure('Asset request timed out', true)),
      options.requestTimeoutMs ?? 10000,
    );
    try {
      signal.throwIfAborted();
      const response = await fetch(url, {
        signal: attemptController.signal,
        credentials: 'omit',
        cache: options.cache ?? 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => { });
        const hint = response.headers?.get('retry-after');
        const retryAfter = hint
          ? /^\d+$/.test(hint)
            ? Number(hint) * 1000
            : Date.parse(hint) - Date.now()
          : 0;
        throw new FileFailure(
          `Asset HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
          Number.isFinite(retryAfter) ? Math.max(0, Math.min(retryAfter, 2147483647)) : 0,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new FileFailure('Empty asset response');
      }
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) {
            break;
          }
          size += value.value.byteLength;
          if (integrity && size > integrity.bytes) {
            throw new FileFailure('Asset size mismatch');
          }
          if (size > options.maxFileBytes) {
            throw new FileFailure('Asset exceeds byte limit');
          }
          parts.push(new Uint8Array(value.value));
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
        } finally {
          reader.releaseLock();
        }
      }
      // The HTTP window ends with the body. Non-abortable hashing belongs to the
      // outer preparation deadline, and must not cause a successful download retry.
      clearTimeout(timer);
      attemptController.signal.throwIfAborted();
      const blob = new Blob(parts, {
        type: response.headers.get('content-type') ?? 'application/octet-stream',
      });
      if (integrity) {
        if (size !== integrity.bytes) {
          throw new FileFailure('Asset size mismatch');
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
        );
        if ([...digest].map((n) => n.toString(16).padStart(2, '0')).join(
          '',
        ) !== integrity.sha256.toLowerCase()) {
          throw new FileFailure('Asset digest mismatch');
        }
      }
      attemptController.signal.throwIfAborted();
      return blob;
    } catch (caught) {
      const error: unknown = attemptController.signal.aborted
        ? attemptController.signal.reason
        : caught;
      if (signal.aborted) {
        throw signal.reason;
      }
      retryAfterMs = error instanceof FileFailure ? error.retryAfterMs : 0;
      if (attempt >= options.retries || !(error instanceof TypeError || error instanceof FileFailure && error.retryable)) {
        // Browser URL errors may embed credentials or signed query strings.
        if (error instanceof TypeError) {
          throw new FileFailure('Asset network request failed');
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelAttempt);
    }
    const baseDelay = 100 * 2 ** attempt;
    const backoff = Math.max(retryAfterMs, baseDelay + Math.random() * baseDelay);
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        clearTimeout(delay);
        reject(signal.reason);
      };
      const delay = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, backoff);
      signal.addEventListener('abort', cancel, {
        once: true,
      });
      if (signal.aborted) {
        cancel();
      }
    });
  }
}

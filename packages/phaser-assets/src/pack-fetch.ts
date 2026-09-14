import type { PhaserPackFileIntegrity } from './packs.js';

class FileFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message); }
}
/** Internal bounded transport. Never include URLs (possibly signed) in errors. */
export async function fetchPackFile(url: string, options: { signal: AbortSignal; retries: number; maxFileBytes: number; integrity?: PhaserPackFileIntegrity | undefined }): Promise<Blob> {
  const { signal, integrity } = options;
  if (integrity && integrity.bytes > options.maxFileBytes) {
    throw new FileFailure('Declared file exceeds byte limit');
  }
  for (let attempt = 0; ; attempt++) {
    try {
      signal.throwIfAborted();
      const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new FileFailure(
          `Asset HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
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
          if (size > (integrity?.bytes ?? options.maxFileBytes)) {
            throw new FileFailure('Asset exceeds byte limit');
          }
          parts.push(new Uint8Array(value.value));
        }
      } finally {
        try {
          await reader.cancel(); } catch {} finally {
          reader.releaseLock(); } }
      const blob = new Blob(parts, {
        type: response.headers.get('content-type') ?? 'application/octet-stream',
      });
      if (integrity) {
        if (size !== integrity.bytes) {
          throw new FileFailure('Asset size mismatch');
        }
        if (!globalThis.crypto?.subtle) {
          throw new FileFailure('Asset integrity requires HTTPS or localhost');
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
      signal.throwIfAborted();
      return blob;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (attempt >= options.retries || !(error instanceof TypeError || error instanceof FileFailure && error.retryable)) {
        // Browser URL errors may embed credentials or signed query strings.
        if (error instanceof TypeError) {
          throw new FileFailure('Asset network request failed');
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

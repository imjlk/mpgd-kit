import { cancelled } from './leases.js';
import type { PlannedImage } from './packs.js';

class AssetFailure extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 100;

/** Exact encoded-byte bound and digest check before any renderer sees the image. */
export async function verifiedImage(url: URL, image: PlannedImage, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw cancelled();
  const digest = globalThis.crypto?.subtle;
  if (!digest) throw new AssetFailure('Image verification requires a secure context (HTTPS or localhost).');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (signal.aborted) throw cancelled();
      const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AssetFailure(`HTTP ${response.status}: ${image.packId}/${image.id}`, response.status >= 500 || response.status === 429);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AssetFailure(`Empty response: ${image.id}`);
      const bytes = new Uint8Array(image.bytes);
      let offset = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > bytes.length) throw new AssetFailure(`Size mismatch: ${image.id}`);
          bytes.set(chunk.value, offset);
          offset += chunk.value.length;
        }
      } finally {
        // Errored streams may reject cancellation; preserve the read error and
        // always release the lock, including on abort and bounded-size rejection.
        try { await reader.cancel(); } catch {} finally { reader.releaseLock(); }
      }
      if (offset !== image.bytes) throw new AssetFailure(`Size mismatch: ${image.id}`);
      const hash = [...new Uint8Array(await digest.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== image.sha256) throw new AssetFailure(`Digest mismatch: ${image.id}`);
      if (signal.aborted) throw cancelled();
      return new Blob([bytes], { type: image.mediaType });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      const retryable = error instanceof TypeError || (error instanceof AssetFailure && error.retryable);
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw error;
      // One bounded retry; the next fetch observes abort even during this short delay.
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw new Error('Unreachable retry state');
}

import { cancelled } from './leases.js';
import type { PlannedImage } from './packs.js';

class AssetFailure extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

/** Exact encoded-byte bound and digest check before any renderer sees the image. */
export async function verifiedImage(url: URL, image: PlannedImage, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (signal.aborted) throw cancelled();
      const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
      if (!response.ok) {
        await response.body?.cancel();
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
        await reader.cancel();
        reader.releaseLock();
      }
      if (offset !== image.bytes) throw new AssetFailure(`Size mismatch: ${image.id}`);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== image.sha256) throw new AssetFailure(`Digest mismatch: ${image.id}`);
      if (signal.aborted) throw cancelled();
      return new Blob([bytes], { type: 'image/svg+xml' });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      const retryable = error instanceof TypeError || (error instanceof AssetFailure && error.retryable);
      if (!retryable || attempt === 1) throw error;
      // One bounded retry; the next fetch observes abort even during this short delay.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Unreachable retry state');
}

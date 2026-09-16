import { ZipDecodeError } from './archive-errors.js';

/** Shared SHA-256 hex digest. Browser-safe: WebCrypto only, never Node
 * crypto. Requires a secure context where `crypto.subtle` exists. */
export const digestOf = async (data: Uint8Array): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new ZipDecodeError(
      'unsupported',
      'SHA-256 verification requires WebCrypto (crypto.subtle), available only in secure contexts',
    );
  }
  // Exact-fit ArrayBuffer-backed views hash directly; sub-views and shared
  // buffers copy into a plain exact-fit buffer first.
  const source: ArrayBuffer = data.buffer instanceof ArrayBuffer
    && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer
    : new Uint8Array(data).buffer;
  const digest = new Uint8Array(await subtle.digest('SHA-256', source));
  return [...digest].map((n) => n.toString(16).padStart(2, '0')).join('');
};

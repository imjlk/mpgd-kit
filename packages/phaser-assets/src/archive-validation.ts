import { ZipDecodeError } from './archive-errors.js';
import {
  decodeZipV1Entries,
  type ExpectedZipArchive,
  type ZipDecodeLimits,
} from './archive-zip-core.js';

/** Statistics a successful archive verification reports. */
export interface ZipV1VerificationStats {
  /** Verified entries (STORE and DEFLATE) inside the archive. */
  readonly entries: number;
  /** Uncompressed entry bytes actually produced and verified. */
  readonly expandedBytes: number;
}

/**
 * Verify a ZIP v1 delivery archive against its expected manifest
 * description, discarding entry bytes after each digest check. This is the
 * narrow execution entry for read-only consumers (the verify-delivery CLI);
 * it exposes no worker protocol and no incremental consumption. The archive
 * digest, structure, per-entry method/size/CRC/SHA-256 and every configured
 * limit are enforced by the shared pure core, so failures surface as
 * `ZipDecodeError` with the core's existing codes.
 */
export async function verifyZipV1Archive(
  archive: Uint8Array,
  expected: ExpectedZipArchive,
  limits: ZipDecodeLimits,
): Promise<ZipV1VerificationStats> {
  if (!(archive instanceof Uint8Array)) {
    throw new ZipDecodeError('invalid-structure', 'ZIP archive bytes must be a Uint8Array');
  }
  let entries = 0;
  let expandedBytes = 0;
  // Entry bytes are discarded as soon as the core verified them: the
  // generator holds at most one entry resident, never the whole map.
  for await (const entry of decodeZipV1Entries(archive, expected, limits)) {
    entries++;
    expandedBytes += entry.bytes.byteLength;
  }
  return { entries, expandedBytes };
}

export { ZipDecodeError };
export type { ZipDecodeFailureCode } from './archive-errors.js';
export type { ExpectedZipArchive, ExpectedZipEntry, ZipDecodeLimits } from './archive-zip-core.js';

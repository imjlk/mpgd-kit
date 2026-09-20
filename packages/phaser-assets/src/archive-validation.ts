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
  // ArrayBuffer.isView reads the [[ViewedArrayBuffer]] internal slot, but it
  // also accepts DataView and every typed-array element width. Read the
  // intrinsic typed-array brand getter directly so cross-realm Uint8Arrays
  // work while Uint16Array/Float32Array/DataView inputs cannot be reinterpreted
  // as a byte archive. The intrinsic getter ignores spoofed own tags.
  let isUint8Array = false;
  try {
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const getTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
    isUint8Array = ArrayBuffer.isView(archive) && getTag?.call(archive) === 'Uint8Array';
  } catch {
    isUint8Array = false;
  }
  if (!isUint8Array) {
    throw new ZipDecodeError('invalid-structure', 'ZIP archive bytes must be a Uint8Array view');
  }
  // A subclass, a cross-realm view, or a view with shadowed accessors can
  // expose inherited/own length or buffer values that are not the intrinsic
  // view span. Snapshot those views through the typed-array constructor;
  // clean same-realm Uint8Arrays take the core's existing single snapshot.
  let bytes: Uint8Array;
  try {
    bytes = Object.getPrototypeOf(archive) !== Uint8Array.prototype
      || Object.hasOwn(archive, 'length') || Object.hasOwn(archive, 'buffer')
      || Object.hasOwn(archive, 'byteOffset') || Object.hasOwn(archive, 'byteLength')
      ? new Uint8Array(archive)
      : archive;
  } catch (error) {
    throw new ZipDecodeError(
      'invalid-structure',
      `ZIP archive bytes cannot be snapshotted: ${String(error)}`,
    );
  }
  let entries = 0;
  let expandedBytes = 0;
  // Entry bytes are discarded as soon as the core verified them: the
  // generator holds at most one entry resident, never the whole map.
  for await (const entry of decodeZipV1Entries(bytes, expected, limits)) {
    entries++;
    expandedBytes += entry.bytes.byteLength;
  }
  return { entries, expandedBytes };
}

export { ZipDecodeError };
export type { ZipDecodeFailureCode } from './archive-errors.js';
export type { ExpectedZipArchive, ExpectedZipEntry, ZipDecodeLimits } from './archive-zip-core.js';

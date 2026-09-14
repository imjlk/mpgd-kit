import { Inflate } from 'fflate';

import { ZipDecodeError, type ZipDecodeFailureCode } from './archive-errors.js';
import type { ArchiveWorkerLimits } from './archive-protocol.js';
import { parsePhaserPackEntryPath, PHASER_PACK_DELIVERY_VERSION } from './pack-format.js';

/**
 * Pure bounded decoder for the ZIP v1 delivery profile produced by
 * `mpgd assets build-packs`: STORE and DEFLATE entries only, no ZIP64, no
 * split archives, no encryption, no directory or symlink entries, no extra
 * fields or comments, and the writer's fixed metadata. This is not a
 * general-purpose unzip: archives with any other shape are rejected instead
 * of being repaired. Inflating uses fflate; the DEFLATE algorithm itself is
 * not reimplemented here.
 */
export interface ExpectedZipEntry {
  readonly path: string;
  readonly method: 'store' | 'deflate';
  readonly bytes: number;
  readonly sha256: string;
}
export interface ExpectedZipArchive {
  readonly formatVersion: number;
  readonly archive: {
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly entries: readonly ExpectedZipEntry[];
}
/** Independent resource bounds for one decode job. Output limits are enforced
 * against bytes actually produced while inflating, never against declared
 * ZIP metadata alone; they bound observable output, not total process memory. */
export type ZipDecodeLimits = ArchiveWorkerLimits;
export interface ZipDecodeEntry {
  readonly path: string;
  readonly method: 'store' | 'deflate';
  readonly bytes: Uint8Array;
}
export interface ZipDecodeControl {
  /** Monotonic clock in milliseconds; defaults to performance.now. */
  readonly now?: () => number;
  /** Polled between inflate chunks and entries; stops the job when true. */
  readonly shouldStop?: () => boolean;
}

// Fixed metadata of the deterministic writer this decoder mirrors.
const VERSION_MADE_BY = 0x0300;
const VERSION_NEEDED = 20;
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const ENCRYPTED_FLAG = 0x0001;
const DECODE_CHUNK_BYTES = 64 * 1024;
const digestOf = async (data: Uint8Array): Promise<string> => {
  const copy = data.slice();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer));
  return [...digest].map((n) => n.toString(16).padStart(2, '0')).join('');
};
const crcTable: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
const crc32Of = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const reader = (data: Uint8Array): {
  readonly u16: (offset: number) => number;
  readonly u32: (offset: number) => number;
} => ({
  u16: (offset) => data[offset]! | (data[offset + 1]! << 8),
  u32: (offset) => (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0,
});
const utf8 = (data: Uint8Array, start: number, end: number): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end));
  } catch {
    throw new ZipDecodeError('invalid-structure', 'ZIP entry name is not valid UTF-8');
  }
};
const assertControl = (control: Required<Pick<ZipDecodeControl, 'shouldStop'>>, clock: () => number, deadlineAt: number): void => {
  if (control.shouldStop()) {
    throw new ZipDecodeError('cancelled', 'ZIP decode cancelled');
  }
  if (clock() > deadlineAt) {
    throw new ZipDecodeError('deadline', 'ZIP decode exceeded its deadline');
  }
};

interface PlannedEntry {
  readonly path: string;
  readonly method: 'store' | 'deflate';
  readonly declaredBytes: number;
  readonly declaredCrc: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

/** Parse and cross-check the archive structure without inflating anything. */
function parseZipV1Structure(archive: Uint8Array, expected: ExpectedZipArchive, limits: ZipDecodeLimits): PlannedEntry[] {
  const zip = reader(archive);
  const fail = (code: ZipDecodeFailureCode, message: string): never => {
    throw new ZipDecodeError(code, message);
  };
  if (archive.length < 22) {
    fail('invalid-structure', 'ZIP archive is truncated');
  }
  const endOffset = archive.length - 22;
  if (zip.u32(endOffset) !== 0x06054b50) {
    fail('invalid-structure', 'ZIP end record missing or has a comment');
  }
  const totalEntries = zip.u16(endOffset + 10);
  if (
    zip.u16(endOffset + 4) !== 0
    || zip.u16(endOffset + 6) !== 0
    || zip.u16(endOffset + 8) !== totalEntries
    || totalEntries === 0xffff
    || zip.u32(endOffset + 12) === 0xffffffff
    || zip.u32(endOffset + 16) === 0xffffffff
  ) {
    fail('unsupported-zip', 'ZIP end record uses split or ZIP64 layout');
  }
  if (totalEntries !== expected.entries.length) {
    fail(
      'entry-mismatch',
      `ZIP entry count ${totalEntries} does not match ${expected.entries.length} expected entries`,
    );
  }
  if (totalEntries > limits.entryCount) {
    fail('limit', `ZIP entry count ${totalEntries} exceeds the entry limit ${limits.entryCount}`);
  }
  const centralDirectoryOffset = zip.u32(endOffset + 16);
  const centralDirectorySize = zip.u32(endOffset + 12);
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    fail('invalid-structure', 'ZIP central directory layout is inconsistent');
  }
  let cursor = centralDirectoryOffset;
  const planned: PlannedEntry[] = [];
  const seenNames = new Set<string>();
  const foldedNames = new Set<string>();
  let dataLimit = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > endOffset || zip.u32(cursor) !== 0x02014b50) {
      fail('invalid-structure', 'ZIP central directory is truncated or invalid');
    }
    const versionMadeBy = zip.u16(cursor + 4);
    const versionNeeded = zip.u16(cursor + 6);
    const flags = zip.u16(cursor + 8);
    const methodCode = zip.u16(cursor + 10);
    const time = zip.u16(cursor + 12);
    const date = zip.u16(cursor + 14);
    const crc = zip.u32(cursor + 16);
    const compressedSize = zip.u32(cursor + 20);
    const uncompressedSize = zip.u32(cursor + 24);
    const nameLength = zip.u16(cursor + 28);
    const extraLength = zip.u16(cursor + 30);
    const commentLength = zip.u16(cursor + 32);
    const diskStart = zip.u16(cursor + 34);
    const externalAttributes = zip.u32(cursor + 38);
    const localOffset = zip.u32(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (versionNeeded > VERSION_NEEDED || versionNeeded === 0xffff || diskStart !== 0) {
      fail(
        'unsupported-zip',
        `ZIP entry needs an unsupported reader (version ${versionNeeded}, disk ${diskStart})`,
      );
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) {
      fail('unsupported-zip', 'ZIP entry is encrypted');
    }
    if (flags !== UTF8_FLAG || versionMadeBy !== VERSION_MADE_BY) {
      fail('unsupported-zip', 'ZIP entry flags or maker are outside the supported profile');
    }
    if (methodCode !== 0 && methodCode !== 8) {
      fail('unsupported-zip', `ZIP entry uses unsupported compression method ${methodCode}`);
    }
    if (time !== DOS_TIME || date !== DOS_DATE || externalAttributes !== EXTERNAL_ATTRIBUTES) {
      fail('invalid-structure', 'ZIP entry metadata does not match the deterministic profile');
    }
    if (extraLength !== 0 || commentLength !== 0) {
      fail('invalid-structure', 'ZIP entry carries extra fields or comments');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail('unsupported-zip', 'ZIP entry uses ZIP64 sizes');
    }
    if (cursor + entryLength > endOffset) {
      fail('invalid-structure', 'ZIP central directory entry is truncated');
    }
    const name = utf8(archive, cursor + 46, cursor + 46 + nameLength);
    try {
      parsePhaserPackEntryPath(name);
    } catch (error) {
      throw new ZipDecodeError(
        'invalid-structure',
        `ZIP entry path is unsafe: ${name} (${String(error)})`,
      );
    }
    if (name.length > limits.maxPathLength) {
      fail('limit', `ZIP entry path exceeds the length limit: ${name}`);
    }
    if (seenNames.has(name)) {
      fail('invalid-structure', `ZIP contains a duplicate entry name: ${name}`);
    }
    const foldedName = name.toLowerCase();
    if (foldedNames.has(foldedName)) {
      fail('invalid-structure', `ZIP contains a case-colliding entry name: ${name}`);
    }
    seenNames.add(name);
    foldedNames.add(foldedName);
    const symlinkMode = (externalAttributes >>> 16) & 0o170000;
    if (symlinkMode === 0o120000) {
      fail('invalid-structure', `ZIP entry is a symbolic link: ${name}`);
    }
    if (localOffset < dataLimit || localOffset + 30 > centralDirectoryOffset) {
      fail('invalid-structure', `ZIP local header offset is out of order: ${name}`);
    }
    if (zip.u32(localOffset) !== 0x04034b50) {
      fail('invalid-structure', `ZIP local header missing for entry: ${name}`);
    }
    const localFlags = zip.u16(localOffset + 6);
    const localMethod = zip.u16(localOffset + 8);
    const localTime = zip.u16(localOffset + 10);
    const localDate = zip.u16(localOffset + 12);
    const localCrc = zip.u32(localOffset + 14);
    const localCompressed = zip.u32(localOffset + 18);
    const localUncompressed = zip.u32(localOffset + 22);
    const localNameLength = zip.u16(localOffset + 26);
    const localExtraLength = zip.u16(localOffset + 28);
    if (
      localFlags !== flags
      || localMethod !== methodCode
      || localTime !== time
      || localDate !== date
      || localCrc !== crc
      || localCompressed !== compressedSize
      || localUncompressed !== uncompressedSize
      || localExtraLength !== 0
      || localNameLength !== nameLength
      || !archive
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .every((byte, index) => byte === archive[cursor + 46 + index]!)
    ) {
      fail('invalid-structure', `ZIP local header contradicts the central directory: ${name}`);
    }
    const dataStart = localOffset + 30 + localNameLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralDirectoryOffset || dataEnd < dataStart) {
      fail('invalid-structure', `ZIP entry data is out of bounds: ${name}`);
    }
    dataLimit = dataEnd;
    planned.push({
      path: name,
      method: methodCode === 8 ? 'deflate' : 'store',
      declaredBytes: uncompressedSize,
      declaredCrc: crc,
      dataStart,
      dataEnd,
    });
    cursor += entryLength;
  }
  if (cursor !== endOffset) {
    fail('invalid-structure', 'ZIP central directory has trailing data');
  }
  for (let index = 0; index < planned.length; index++) {
    const entry = planned[index]!;
    const expectedEntry = expected.entries[index]!;
    if (
      entry.path !== expectedEntry.path
      || entry.method !== expectedEntry.method
      || entry.declaredBytes !== expectedEntry.bytes
    ) {
      fail(
        'entry-mismatch',
        `ZIP entry ${index} does not match the expected manifest entry ${expectedEntry.path}`,
      );
    }
    if (entry.declaredBytes > limits.entryBytes) {
      fail('limit', `ZIP entry ${entry.path} exceeds the per-entry byte limit`);
    }
  }
  return planned;
}

/** Inflate one entry while counting actually produced output bytes. */
function inflateBounded(
  archive: Uint8Array,
  entry: PlannedEntry,
  declaredBytes: number,
  clock: () => number,
  deadlineAt: number,
  control: Required<Pick<ZipDecodeControl, 'shouldStop'>>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let overshot = false;
  const inflate = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > declaredBytes) {
      overshot = true;
      return;
    }
    chunks.push(chunk);
  });
  const compressed = archive.subarray(entry.dataStart, entry.dataEnd);
  for (let offset = 0; offset < compressed.length; offset += DECODE_CHUNK_BYTES) {
    assertControl(control, clock, deadlineAt);
    if (overshot) {
      break;
    }
    const final = offset + DECODE_CHUNK_BYTES >= compressed.length;
    try {
      inflate.push(compressed.subarray(offset, offset + DECODE_CHUNK_BYTES), final);
    } catch (error) {
      throw new ZipDecodeError(
        'decode',
        `ZIP entry ${entry.path} failed to inflate: ${String(error)}`,
      );
    }
    if (overshot) {
      break;
    }
  }
  if (overshot) {
    throw new ZipDecodeError(
      'integrity',
      `ZIP entry ${entry.path} expanded past its declared size`,
    );
  }
  if (produced !== declaredBytes) {
    throw new ZipDecodeError(
      'integrity',
      `ZIP entry ${entry.path} size ${produced} differs from declared ${declaredBytes}`,
    );
  }
  return chunks.length === 1 ? chunks[0]! : (() => {
    const joined = new Uint8Array(produced);
    let position = 0;
    for (const chunk of chunks) {
      joined.set(chunk, position);
      position += chunk.length;
    }
    return joined;
  })();
}

/**
 * Verify an archive against its expected manifest description and yield the
 * original files one at a time. Structure and digests are checked before any
 * entry is yielded; each yielded entry is decoded freshly, counted against
 * the limits while inflating, verified (CRC-32 and SHA-256) and handed to
 * the caller, which decides when to pull the next one.
 */
export async function* decodeZipV1Entries(
  archive: Uint8Array,
  expected: ExpectedZipArchive,
  limits: ZipDecodeLimits,
  control: ZipDecodeControl = {},
): AsyncGenerator<ZipDecodeEntry> {
  const clock = control.now ?? ((): number => performance.now());
  const shouldStop = control.shouldStop ?? ((): boolean => false);
  const wrappedControl: Required<Pick<ZipDecodeControl, 'shouldStop'>> = { shouldStop };
  if (globalThis.crypto?.subtle === undefined) {
    throw new ZipDecodeError('unsupported', 'ZIP decode requires SHA-256 (HTTPS or localhost)');
  }
  if (expected.formatVersion !== PHASER_PACK_DELIVERY_VERSION) {
    throw new ZipDecodeError(
      'unsupported-zip',
      `Unsupported archive format version ${JSON.stringify(expected.formatVersion)}`,
    );
  }
  if (archive.length !== expected.archive.bytes) {
    throw new ZipDecodeError(
      'archive-mismatch',
      `ZIP archive is ${archive.length} bytes, expected ${expected.archive.bytes}`,
    );
  }
  if (archive.length > limits.archiveBytes) {
    throw new ZipDecodeError('limit', 'ZIP archive exceeds the archive byte limit');
  }
  const archiveDigest = await digestOf(archive);
  if (archiveDigest !== expected.archive.sha256) {
    throw new ZipDecodeError('archive-mismatch', 'ZIP archive digest does not match the manifest');
  }
  const planned = parseZipV1Structure(archive, expected, limits);
  const deadlineAt = clock() + limits.decodeDeadlineMs;
  let expandedTotal = 0;
  let delivered = 0;
  for (const entry of planned) {
    assertControl(wrappedControl, clock, deadlineAt);
    const bytes = entry.method === 'store'
      ? archive.slice(entry.dataStart, entry.dataEnd)
      : inflateBounded(archive, entry, entry.declaredBytes, clock, deadlineAt, wrappedControl);
    expandedTotal += bytes.length;
    delivered++;
    if (expandedTotal > limits.totalExpandedBytes) {
      throw new ZipDecodeError(
        'limit',
        `ZIP decode produced ${expandedTotal} bytes, exceeding the total expanded byte limit ${limits.totalExpandedBytes}`,
      );
    }
    if (crc32Of(bytes) !== entry.declaredCrc) {
      throw new ZipDecodeError('integrity', `ZIP entry ${entry.path} CRC-32 mismatch`);
    }
    const entryDigest = await digestOf(bytes);
    const expectedEntry = expected.entries[delivered - 1]!;
    if (entryDigest !== expectedEntry.sha256) {
      throw new ZipDecodeError(
        'integrity',
        `ZIP entry ${entry.path} digest does not match the manifest`,
      );
    }
    yield {
      path: entry.path,
      method: entry.method,
      bytes,
    };
  }
}

import { Inflate } from 'fflate';

import { digestOf } from './archive-digest.js';
import { ZipDecodeError, type ZipDecodeFailureCode } from './archive-errors.js';
import { invalidArchiveLimit, type ArchiveWorkerLimits } from './archive-protocol.js';
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
const MIN_DECODE_STEP_BYTES = 64;
const BREATHE_INPUT_BYTES = 256 * 1024;
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
  // The budget is exhausted at the deadline instant itself, matching the
  // client's absolute-deadline semantics.
  if (clock() >= deadlineAt) {
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
  if (zip.u32(endOffset) !== 0x06054b50 || zip.u16(endOffset + 20) !== 0) {
    fail('invalid-structure', 'ZIP end record missing or has a comment');
  }
  const totalEntries = zip.u16(endOffset + 10);
  if (
    zip.u16(endOffset + 4) !== 0
    || zip.u16(endOffset + 6) !== 0
    || zip.u16(endOffset + 8) !== totalEntries
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
    const internalAttributes = zip.u16(cursor + 36);
    const externalAttributes = zip.u32(cursor + 38);
    const localOffset = zip.u32(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (versionNeeded !== VERSION_NEEDED || diskStart !== 0) {
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
    if (
      time !== DOS_TIME
      || date !== DOS_DATE
      || internalAttributes !== 0
      || externalAttributes !== EXTERNAL_ATTRIBUTES
    ) {
      fail(
        'invalid-structure',
        'ZIP entry metadata does not match the deterministic profile (symlinks and unexpected file modes are rejected)',
      );
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
    if (localOffset !== dataLimit) {
      fail(
        'invalid-structure',
        `ZIP local header offset is not contiguous with the previous record: ${name}`,
      );
    }
    if (localOffset + 30 > centralDirectoryOffset) {
      fail('invalid-structure', `ZIP local header offset is out of bounds: ${name}`);
    }
    if (zip.u32(localOffset) !== 0x04034b50) {
      fail('invalid-structure', `ZIP local header missing for entry: ${name}`);
    }
    const localVersionNeeded = zip.u16(localOffset + 4);
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
      localVersionNeeded !== versionNeeded
      || localFlags !== flags
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
    if (methodCode === 0 && compressedSize !== uncompressedSize) {
      fail(
        'invalid-structure',
        `ZIP STORE entry ${name} compressed size differs from its declared size`,
      );
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
  if (dataLimit !== centralDirectoryOffset) {
    fail('invalid-structure', 'ZIP entries leave unreferenced bytes before the central directory');
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
async function inflateBounded(
  archive: Uint8Array,
  entry: PlannedEntry,
  declaredBytes: number,
  clock: () => number,
  deadlineAt: number,
  control: Required<Pick<ZipDecodeControl, 'shouldStop'>>,
  remainingTotalBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let overshot: 'declared' | 'total' | undefined;
  const inflate = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > declaredBytes) {
      overshot = 'declared';
      return;
    }
    if (produced > remainingTotalBytes) {
      overshot = 'total';
      return;
    }
    chunks.push(chunk);
  });
  const compressed = archive.subarray(entry.dataStart, entry.dataEnd);
  // A whole push decodes before the callback can reject, so each input slice
  // is capped so even maximal expansion cannot exceed the smaller of the
  // declared entry size or the remaining total allowance.
  const ceiling = Math.min(declaredBytes, remainingTotalBytes);
  let allowance = ceiling;
  let offset = 0;
  let sinceBreathe = 0;
  while (offset < compressed.length) {
    // Each push decodes and allocates before the counting callback can
    // reject it, so the input slice is sized against the remaining output
    // allowance at DEFLATE's worst-case 1032x expansion; a small floor keeps
    // low-compression streams progressing without per-byte pushes.
    const step = Math.min(
      Math.max(MIN_DECODE_STEP_BYTES, Math.floor(allowance / 1032)),
      DECODE_CHUNK_BYTES,
      compressed.length - offset,
    );
    sinceBreathe += step;
    if (sinceBreathe >= BREATHE_INPUT_BYTES) {
      sinceBreathe = 0;
      // Let the worker's message loop run so cancellation is observable
      // during long inflates.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    assertControl(control, clock, deadlineAt);
    if (overshot) {
      break;
    }
    const final = offset + step >= compressed.length;
    const before = produced;
    try {
      inflate.push(compressed.subarray(offset, offset + step), final);
    } catch (error) {
      throw new ZipDecodeError(
        'decode',
        `ZIP entry ${entry.path} failed to inflate: ${String(error)}`,
      );
    }
    allowance -= produced - before;
    offset += step;
    if (overshot) {
      break;
    }
  }
  if (overshot === 'declared') {
    throw new ZipDecodeError(
      'integrity',
      `ZIP entry ${entry.path} expanded past its declared size`,
    );
  }
  if (overshot === 'total') {
    throw new ZipDecodeError(
      'limit',
      `ZIP entry ${entry.path} exhausted the total expanded byte limit while inflating`,
    );
  }
  if (produced !== declaredBytes) {
    throw new ZipDecodeError(
      'integrity',
      `ZIP entry ${entry.path} size ${produced} differs from declared ${declaredBytes}`,
    );
  }
  // fflate stops at the final DEFLATE block and silently ignores whatever
  // follows, leaving the unconsumed tail in its pending buffer (the final
  // byte's bit padding aside). The writer profile streams exactly the
  // declared bytes, so leftover input is corruption, not payload. The
  // internals are pinned with the exact fflate version; an unexpected
  // layout fails closed instead of throwing a raw TypeError.
  const tail = inflate as unknown as { p?: Uint8Array; s?: { p?: number } };
  const pending = tail.p instanceof Uint8Array ? tail.p : undefined;
  const state = typeof tail.s === 'object' && tail.s !== null ? tail.s : undefined;
  const pendingBits = state !== undefined && typeof state.p === 'number' ? state.p : undefined;
  if (pending === undefined || pendingBits === undefined) {
    throw new ZipDecodeError(
      'decode',
      `ZIP entry ${entry.path} DEFLATE stream tail could not be inspected`,
    );
  }
  const trailing = pending.length - (pendingBits !== 0 ? 1 : 0);
  if (trailing !== 0) {
    throw new ZipDecodeError(
      'invalid-structure',
      `ZIP entry ${entry.path} carries ${trailing} bytes after its DEFLATE stream`,
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
  // Values beyond the platform timer range would wrap the client's guard
  // timer into firing early.
  if (limits.decodeDeadlineMs > 2 ** 31 - 1) {
    throw new ZipDecodeError('limit', 'ZIP decode deadline exceeds the timer range');
  }
  const invalidLimit = invalidArchiveLimit(limits);
  if (invalidLimit !== undefined) {
    throw new ZipDecodeError(
      'limit',
      `ZIP decode limit ${invalidLimit.name} must be an integer of at least ${invalidLimit.minimum}`,
    );
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
  const deadlineAt = clock() + limits.decodeDeadlineMs;
  assertControl(wrappedControl, clock, deadlineAt);
  const archiveDigest = await digestOf(archive);
  if (archiveDigest !== expected.archive.sha256) {
    throw new ZipDecodeError('archive-mismatch', 'ZIP archive digest does not match the manifest');
  }
  assertControl(wrappedControl, clock, deadlineAt);
  const planned = parseZipV1Structure(archive, expected, limits);
  let expandedTotal = 0;
  let delivered = 0;
  for (const entry of planned) {
    assertControl(wrappedControl, clock, deadlineAt);
    const remainingTotal = limits.totalExpandedBytes - expandedTotal;
    // A remaining allowance of zero still admits empty entries, which the
    // deterministic writer permits; nonempty output is rejected by the
    // per-entry bounds below.
    if (entry.method === 'store' && entry.declaredBytes > remainingTotal) {
      // A STORE copy would allocate its full size up front, so the aggregate
      // bound must reject before the slice instead of after it.
      throw new ZipDecodeError(
        'limit',
        `ZIP entry ${entry.path} of ${entry.declaredBytes} bytes exceeds the remaining total expanded byte allowance ${remainingTotal}`,
      );
    }
    const bytes = entry.method === 'store'
      ? archive.slice(entry.dataStart, entry.dataEnd)
      : await inflateBounded(
          archive,
          entry,
          entry.declaredBytes,
          clock,
          deadlineAt,
          wrappedControl,
          remainingTotal,
        );
    assertControl(wrappedControl, clock, deadlineAt);
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
    assertControl(wrappedControl, clock, deadlineAt);
    const entryDigest = await digestOf(bytes);
    assertControl(wrappedControl, clock, deadlineAt);
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
    // A consumer holding the final entry past the deadline must not let the
    // generator report completion when it resumes.
    assertControl(wrappedControl, clock, deadlineAt);
  }
}

import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Deterministic ZIP writer for pack delivery archives. The builder targets
 * this limited format only: STORE and DEFLATE entries, no ZIP64, no split
 * archives, no encryption, no directory or symlink entries, no comments.
 * Fixed metadata: DOS timestamp 1980-01-01 00:00:00, UNIX permissions 0644,
 * UTF-8 name flag, no extra fields. Given the same entries in the same order
 * and the same Node/zlib build, the produced bytes are identical.
 */
export interface DeterministicZipEntry {
  /** Normalized relative entry path; validated by the pack format module. */
  readonly path: string;
  /** Uncompressed entry bytes. */
  readonly data: Buffer;
  readonly method: 'store' | 'deflate';
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0300;
const UTF8_FLAG = 0x0800;
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const MAX_ENTRIES = 0xffff;
const MAX_ENTRY_BYTES = 0xffffffff;

export function createDeterministicZip(entries: readonly DeterministicZipEntry[]): Buffer {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error(`Deterministic ZIP requires 1..${MAX_ENTRIES} entries`);
  }
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    if (entry.data.length > MAX_ENTRY_BYTES) {
      throw new Error(`Deterministic ZIP entry exceeds 4 GiB: ${entry.path}`);
    }
    const compressed = entry.method === 'deflate'
      ? deflateRawSync(entry.data, { level: 9 })
      : entry.data;
    if (compressed.length > MAX_ENTRY_BYTES) {
      throw new Error(`Deterministic ZIP entry exceeds 4 GiB: ${entry.path}`);
    }
    const methodCode = entry.method === 'deflate' ? 8 : 0;
    const digest = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(digest, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(digest, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  if (offset > MAX_ENTRY_BYTES || centralDirectory.length > MAX_ENTRY_BYTES) {
    throw new Error('Deterministic ZIP archive exceeds 4 GiB');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}
